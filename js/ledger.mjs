// SPDX-License-Identifier: Apache-2.0
// The budget file's client. The rule is not in this module: spec/schema.sql holds the tables,
// the counting rule and admission, and this module runs its statements by name, as the Python
// package does. What it adds is reading input, opening and upgrading the file, and wording
// refusals. The file serves one host: SQLite's locks aren't reliable over NFS, SMB or Docker
// Desktop bind mounts.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { attachClock, clockTick, detachClock } from './_clock.mjs';
import { BudgetError, BudgetRefused } from './errors.mjs';
import { formatAmount, formatWindow, MAX_AMOUNT, normalizeWallet, shortWallet } from './money.mjs';

/** The file's format. 0.4 upgrades a 0.2 (1) or 0.3 (2) file when it opens it; they refuse 3. */
export const SCHEMA_VERSION = '3';
/** The oldest SQLite the ledger runs on: STRICT tables arrived in 3.37.0. */
export const MIN_SQLITE_VERSION = '3.37.0';
/**
 * How old a held payment with no settle-by time must be before the owner's bulk release voids
 * it: an hour, the longest an x402 authorization walletcap signs can be redeemed, and a minute.
 * The rule is in spec/schema.sql (void_unknown); this is its value, for messages.
 */
export const UNBOUNDED_HOLD_MS = 3_660_000n;
/**
 * Internal: the key of Reservation's method that gives an open payment, once, the last moment
 * it could still settle: { until } or { withinMs } from the ledger's now. Not exported.
 */
export const SETTLES_BY = Symbol('walletcap/settles-by');
/** The most a time or a duration can be, in milliseconds: about 31,700 years. */
export const MAX_TIME = 10n ** 15n;

const ID = /^[A-Za-z0-9_.:@/+-]{1,160}$/;
const RAIL = /^[A-Za-z0-9_.:@/-]{1,64}$/;
const INFO_LIMIT = 4096;
const EVIDENCE_LIMIT = 1024;
const BUSY = 5;

// node:sqlite prints an ExperimentalWarning when it loads (Node 22 and 24). Load it once with
// that one warning held back, so an agent's logs stay clean.
const require = createRequire(import.meta.url);
let sqlite;
const loadSqlite = () => {
  if (sqlite !== undefined) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function quietSqlite(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } catch (error) {
    throw new BudgetError(`walletcap needs Node 22.13 or later, for node:sqlite (${error.message})`, { cause: error });
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
};

/**
 * spec/schema.sql and spec/upgrade.sql split on their '-- @' lines: sections run whole,
 * fragments are spliced into statements as {{name}}, and statements run by name. Comment lines
 * inside fragments and statements are dropped.
 */
export function parseSpec(text) {
  const parsed = { sections: {}, fragments: {}, statements: {} };
  const kinds = { section: 'sections', fragment: 'fragments', statement: 'statements' };
  let into = null;
  let name = null;
  let lines = [];
  const flush = () => {
    if (into !== null) parsed[into][name] = lines.join('\n').trim();
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^-- @(section|fragment|statement) ([a-z_]+)\s*$/.exec(line);
    if (marker) {
      flush();
      into = kinds[marker[1]];
      [, , name] = marker;
    } else if (into !== null && !(into !== 'sections' && /^\s*--/.test(line))) {
      lines.push(line);
    }
  }
  flush();
  for (const [key, sql] of Object.entries(parsed.statements)) {
    parsed.statements[key] = sql.replace(/\{\{([a-z_]+)\}\}/g, (_, fragment) => {
      if (!(fragment in parsed.fragments)) throw new Error(`spec: no fragment ${fragment}`);
      return parsed.fragments[fragment];
    });
  }
  return parsed;
}

let spec;
/** The package's copy of spec/schema.sql and spec/upgrade.sql, read once. */
export function loadSpec() {
  if (spec !== undefined) return spec;
  const read = name => {
    try {
      return readFileSync(new URL(`./spec/${name}`, import.meta.url), 'utf8');
    } catch (error) {
      throw new BudgetError(`walletcap's package is missing spec/${name}; reinstall it`, { cause: error });
    }
  };
  spec = { schema: parseSpec(read('schema.sql')), upgrade: parseSpec(read('upgrade.sql')) };
  return spec;
}

// A statement's :named parameters, outside its string literals.
const parameterNames = sql => [...new Set([...sql.replace(/'(?:[^']|'')*'/g, "''").matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))];

const versionAtLeast = (version, least) => {
  const [a, b] = [version, least].map(text => text.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

// --- Reading input ------------------------------------------------------------------------

/** The name a wallet's budget is kept under (money.mjs's normalizeWallet). */
export const walletKey = value => normalizeWallet(value);

const whole = (value, label, { min, max }) => {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[0-9]+$/.test(value)) parsed = BigInt(value);
  else throw new BudgetError(`${label} must be an integer`);
  if (parsed < min || parsed > max) throw new BudgetError(`${label} must be an integer from ${min} to ${max}`);
  return parsed;
};

/** An amount in the budget's own unit, from 1 (or 0) to MAX_AMOUNT. */
export const units = (value, label, { allowZero = false } = {}) => whole(value, label, { min: allowZero ? 0n : 1n, max: MAX_AMOUNT });

/** A time or a duration in milliseconds. */
export const millis = (value, label, { min = 0n } = {}) => {
  if (value instanceof Date) value = value.getTime();
  return whole(value, label, { min, max: MAX_TIME });
};

/** A payment's identity: the rail's own (eip3009:<from>:<nonce>, tx:<hash>) or the caller's key. */
export const paymentId = value => {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new BudgetError('a payment id is 1 to 160 of letters, digits and _ . : @ / + -');
  }
  return value;
};

const railName = value => {
  if (typeof value !== 'string' || !RAIL.test(value)) throw new BudgetError('rail must be a plain identifier');
  return value;
};

const text = (value, label, limit) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > limit) throw new BudgetError(`${label} must be a string of at most ${limit} characters`);
  return value;
};

// --- Wording ------------------------------------------------------------------------------

const plural = count => (count === 1n ? '' : 's');
const mergedNote = names => `The 0.3.0 upgrade merged the budget${names.length === 1 ? '' : 's'} 0.2.x kept under ${names.join(', ')} `
  + "into this one, with the tighter of each limit; its owner can change them with 'walletcap set'";
const frozenNote = ({ kept, aside }) => `The 0.3.0 upgrade froze it: 0.2.x also kept ${aside.map(({ name, unit }) => `a budget in ${unit} under ${name}`).join(' and ')} `
  + `for this wallet, which can't be merged with this one in ${kept}, so ${aside.length === 1 ? 'that budget no longer counts' : 'those budgets no longer count'}`;
const parsedNote = (json, word) => {
  if (json === null || json === undefined) return null;
  try {
    return word(JSON.parse(json));
  } catch {
    return null;
  }
};
/** What an upgrade merged into this budget, or null. */
export const mergedNoteOf = json => parsedNote(json, mergedNote);

const SHOWN_HOLDS = 3n;
const heldNote = (heldPayments, ids) => {
  const more = heldPayments > BigInt(ids.length) ? ` and ${heldPayments - BigInt(ids.length)} more` : '';
  return `${ids.join(', ')}${more}; walletcap holds lists them, and if one never left the wallet its owner can release it`;
};

/**
 * The refusal for `why` (a row of the refusal statement): the code, a brief an agent is told,
 * and a message that also names, for the owner, the open payments that take up the room.
 */
export function refusal(why, amount, limits, openIds) {
  const source = why.source;
  const refused = (code, message, brief = message) => new BudgetRefused(code, message, { brief, source });
  const name = shortWallet(why.wallet);
  const money = value => formatAmount(value, why.unit);
  const window = formatWindow(why.window_ms);
  if (why.code === 'frozen') {
    const note = parsedNote(why.frozen_by, frozenNote);
    return refused('frozen', `${name}'s budget is frozen: nothing can be paid until its owner unfreezes it${note === null ? '' : `. ${note}`}`);
  }
  if (why.source === 'process') {
    const own = limits.windowMs === null ? window : formatWindow(limits.windowMs);
    if (why.code === 'per_payment') return refused('per_payment', `${money(amount)} is over the ${money(limits.perPayment)} limit per payment this process set`);
    if (why.code === 'budget') {
      const left = limits.cap > why.p_counted ? limits.cap - why.p_counted : 0n;
      return refused('budget', `${money(amount)} would bring ${name} to ${money(why.p_counted + amount)} in the last ${own}, `
        + `over the ${money(limits.cap)} limit this process set (${money(left)} left)`);
    }
    return refused('max_payments', `${name} already made ${why.p_payments} payment${plural(why.p_payments)} in the last ${own}, the most this process allows`);
  }
  if (why.code === 'per_payment') return refused('per_payment', `${money(amount)} is over ${name}'s ${money(why.per_payment)} limit per payment`);
  const held = why.held_payments;
  if (why.code === 'budget') {
    const left = why.cap > why.counted ? why.cap - why.counted : 0n;
    const over = `${money(amount)} would bring ${name} to ${money(why.counted + amount)} in the last ${window}, over its ${money(why.cap)} limit (${money(left)} left)`;
    if (held === 0n) return refused('budget', over);
    const brief = `${over}; ${money(why.held)} of it is ${held} open payment${plural(held)}`;
    return refused('budget', `${brief} (${heldNote(held, openIds())})`, brief);
  }
  if (held === 0n) {
    return refused('max_payments', `${name} already made ${why.payments} payment${plural(why.payments)} in the last ${window}, the most its budget allows`);
  }
  const brief = `${name} has ${why.payments} payment${plural(why.payments)} counting in the last ${window}, the most its budget allows, `
    + `and ${held} of them ${held === 1n ? 'is' : 'are'} still open`;
  return refused('max_payments', `${brief} (${heldNote(held, openIds())})`, brief);
}

// --- The ledger ---------------------------------------------------------------------------

const unusable = (path, error) => new BudgetError(`the budget file ${path} cannot be used: ${error.message}`, { cause: error });

/** A guard trigger's refusal ('walletcap: …'), or null. */
const guardMessage = error => {
  const message = String(error?.message ?? '');
  const at = message.indexOf('walletcap: ');
  return at < 0 ? null : message.slice(at + 'walletcap: '.length);
};

/**
 * One budget file. Every method runs statements from spec/schema.sql; each write runs in one
 * BEGIN IMMEDIATE transaction, so the file has one writer at a time.
 */
export class Ledger {
  #db;
  #path;
  #closed = false;
  #statements = new Map();

  /**
   * Open the budget file at `path`, creating it (mode 0600, its folder 0700) only with
   * `create`. A file another walletcap version wrote is upgraded; a newer one is refused.
   */
  constructor(path, { busyTimeoutMs = 30_000, create = false } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) throw new BudgetError('busyTimeoutMs must be a positive integer');
    const { DatabaseSync } = loadSqlite();
    loadSpec();
    this.#path = path;
    if (!existsSync(path)) {
      if (!create) throw new BudgetError(`no budget file at ${path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (error) {
        if (error?.code !== 'EEXIST') throw unusable(path, error);
      }
    }
    try {
      this.#db = new DatabaseSync(path);
    } catch (error) {
      throw unusable(path, error);
    }
    attachClock(this.#db);
    try {
      const { version } = this.#db.prepare('SELECT sqlite_version() AS version').get();
      if (!versionAtLeast(version, MIN_SQLITE_VERSION)) {
        throw new BudgetError(`walletcap needs SQLite ${MIN_SQLITE_VERSION} or later; this Node has ${version}`);
      }
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#db.exec('PRAGMA foreign_keys = ON');
      this.#db.exec('PRAGMA synchronous = FULL');
      this.#prepareFile();
    } catch (error) {
      this.close();
      throw error instanceof BudgetError ? error : unusable(path, error);
    }
  }

  get path() { return this.#path; }

  // The schema the file is at: null for an empty file.
  #schema() {
    const tables = this.#db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name);
    if (tables.length === 0) return null;
    if (!tables.includes('budget_meta')) throw new BudgetError(`${this.#path} is a SQLite file, not a walletcap budget`);
    const row = this.#db.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get();
    if (row === undefined) throw new BudgetError(`${this.#path} has no schema version; it is not a walletcap budget walletcap can read`);
    return row.value;
  }

  // Create the schema, or upgrade an older one, in one write transaction: a crash leaves the
  // file as it was, and two processes that open it at once upgrade it once.
  #prepareFile() {
    if (this.#schema() === SCHEMA_VERSION) return;
    const { schema, upgrade } = loadSpec();
    this.#write(() => {
      const found = this.#schema();
      if (found === SCHEMA_VERSION) return;
      if (found === null) {
        for (const section of ['tables', 'projection', 'guards']) this.#db.exec(schema.sections[section]);
      } else if (found === '1' || found === '2') {
        this.#db.exec(upgrade.sections.rename);
        this.#db.exec(schema.sections.tables);
        this.#db.exec(schema.sections.projection);
        if (found === '1') this.#db.exec(upgrade.sections.names);
        this.#db.exec(upgrade.sections.migrate);
        this.#db.exec(schema.sections.guards);
      } else {
        throw new BudgetError(`${this.#path} is at schema ${found}, which a newer walletcap wrote; this one reads ${SCHEMA_VERSION}`);
      }
      this.#db.prepare("INSERT INTO budget_meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    });
    // WAL lets readers through while one process writes. A file another process holds open
    // stays in its journal mode until it can switch; either mode is correct.
    try { this.#db.exec('PRAGMA journal_mode = WAL'); } catch { /* busy: keep the journal mode */ }
  }

  #statement(name) {
    let entry = this.#statements.get(name);
    if (entry === undefined) {
      const sql = loadSpec().schema.statements[name];
      if (sql === undefined) throw new Error(`spec: no statement ${name}`);
      const prepared = this.#db.prepare(sql);
      prepared.setReadBigInts(true);
      entry = { prepared, names: parameterNames(sql) };
      this.#statements.set(name, entry);
    }
    return entry;
  }

  #bind(names, args) {
    const bound = {};
    for (const name of names) {
      const value = args[name];
      bound[name] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    return bound;
  }

  #all(name, args = {}) {
    const { prepared, names } = this.#statement(name);
    return prepared.all(this.#bind(names, args));
  }

  #get(name, args = {}) { return this.#all(name, args)[0] ?? null; }

  #write(work) { return this.#run('BEGIN IMMEDIATE', work); }

  #read(work) { return this.#run('BEGIN', work); }

  #run(begin, work) {
    if (this.#closed) throw new BudgetError(`the budget file ${this.#path} is closed`);
    clockTick();
    try {
      this.#db.exec(begin);
    } catch (error) {
      throw this.#failure(error);
    }
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error instanceof BudgetError ? error : this.#failure(error);
    }
  }

  #failure(error) {
    const guard = guardMessage(error);
    if (guard !== null) return new BudgetError(guard, { cause: error });
    if ((Number(error?.errcode) & 0xff) === BUSY) {
      return new BudgetError(`the budget file ${this.#path} is busy: another process held its write lock past the busy timeout`, { cause: error });
    }
    return unusable(this.#path, error);
  }

  /** The ledger's time, in milliseconds. */
  now() { return this.#read(() => this.#get('now').now); }

  budget(name) { return this.#read(() => this.#get('budget', { wallet: walletKey(name) })); }

  budgets() { return this.#read(() => this.#all('budgets')); }

  /** Create a budget. Its limits are checked by the table's constraints too. */
  createBudget(name, { unit = 'usd', cap, windowMs, perPayment = null, maxPayments = null }) {
    const wallet = walletKey(name);
    const values = {
      wallet, unit: railName(unit), cap: units(cap, 'cap', { allowZero: true }), window_ms: millis(windowMs, 'windowMs', { min: 1n }),
      per_payment: perPayment === null ? null : units(perPayment, 'perPayment'),
      max_payments: maxPayments === null ? null : whole(maxPayments, 'maxPayments', { min: 0n, max: (1n << 62n) }),
    };
    return this.#write(() => {
      if (this.#get('budget', { wallet }) !== null) throw new BudgetError(`${shortWallet(wallet)} already has a budget in ${this.#path}`);
      this.#all('create_budget', values);
      return this.#get('budget', { wallet });
    });
  }

  /**
   * The owner's change, up or down; a field left undefined stays. What was spent keeps counting.
   * The window changes only while nothing counts.
   */
  setLimits(name, { cap, windowMs, perPayment, maxPayments }) {
    const wallet = walletKey(name);
    const values = {
      wallet,
      cap: cap === undefined ? null : units(cap, 'cap', { allowZero: true }),
      window_ms: windowMs === undefined ? null : millis(windowMs, 'windowMs', { min: 1n }),
      keep_per_payment: perPayment === undefined,
      per_payment: perPayment === undefined || perPayment === null ? null : units(perPayment, 'perPayment'),
      keep_max_payments: maxPayments === undefined,
      max_payments: maxPayments === undefined || maxPayments === null ? null : whole(maxPayments, 'maxPayments', { min: 0n, max: (1n << 62n) }),
    };
    return this.#write(() => {
      if (this.#get('budget', { wallet }) === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      this.#all('set_limits', values);
      return this.#get('budget', { wallet });
    });
  }

  freeze(name) {
    const wallet = walletKey(name);
    this.#write(() => {
      if (this.#get('budget', { wallet }) === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      this.#all('freeze', { wallet });
    });
  }

  unfreeze(name) {
    const wallet = walletKey(name);
    this.#write(() => {
      if (this.#get('budget', { wallet }) === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      this.#all('unfreeze', { wallet });
    });
  }

  /** Whether a hold of `amount` would be refused now, without holding it, and what is left. */
  check(name, amount, { limits = {} } = {}) {
    const wallet = walletKey(name);
    const own = {
      perPayment: limits.perPayment ?? null, cap: limits.cap ?? null, windowMs: limits.windowMs ?? null, maxPayments: limits.maxPayments ?? null,
    };
    const spend = units(amount, 'amount');
    return this.#read(() => {
      const why = this.#get('refusal', {
        wallet, amount: spend, p_per_payment: own.perPayment, p_cap: own.cap, p_window_ms: own.windowMs, p_max_payments: own.maxPayments,
      });
      if (why === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      const remaining = why.frozen_at !== null || why.counted > why.cap ? 0n : why.cap - why.counted;
      if (why.code === null) return { refusal: null, remaining };
      return { refusal: refusal(why, spend, own, () => this.#all('open_ids', { wallet }).map(row => row.payment)), remaining };
    });
  }

  /**
   * Admission: hold `amount` for a payment, or throw the BudgetRefused that says why not.
   * `until` (ms) or `withinMs` (from the ledger's now) bounds when it could settle. `limits`
   * are the paying process's own, tighter ones. Holding an identity already in the ledger
   * returns that payment if the wallet and amount match.
   */
  hold(name, amount, { payment = null, until = null, withinMs = null, rail, info = null, limits = {} } = {}) {
    const wallet = walletKey(name);
    const own = {
      perPayment: limits.perPayment ?? null, cap: limits.cap ?? null, windowMs: limits.windowMs ?? null, maxPayments: limits.maxPayments ?? null,
    };
    const args = {
      wallet,
      amount: units(amount, 'amount'),
      payment: payment === null ? null : paymentId(payment),
      until: until === null ? null : millis(until, 'until'),
      within_ms: withinMs === null ? null : millis(withinMs, 'withinMs', { min: 1n }),
      rail: railName(rail),
      info: text(info, 'info', INFO_LIMIT),
      p_per_payment: own.perPayment, p_cap: own.cap, p_window_ms: own.windowMs, p_max_payments: own.maxPayments,
    };
    return this.#write(() => {
      const held = this.#get('hold', args);
      if (held !== null) return { payment: held.payment, at: held.at, until: held.until, state: 'held', created: true };
      const why = this.#get('refusal', args);
      if (why === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      if (why.existing !== null) {
        const existing = JSON.parse(why.existing);
        if (existing.wallet === wallet && BigInt(existing.amount) === args.amount) {
          return { payment: args.payment, at: null, until: null, state: existing.state, created: false };
        }
        throw new BudgetError(`payment ${args.payment} is already in the ledger, for ${formatAmount(BigInt(existing.amount), why.unit)} from ${shortWallet(existing.wallet)}`);
      }
      if (why.settles_too_soon) {
        const iso = ms => new Date(Number(ms)).toISOString();
        throw new BudgetError(`settlesBy ${iso(args.until)} is not after now (${iso(why.now)}): a payment can't settle before it is made`);
      }
      if (why.code === null) throw new BudgetError('walletcap could not hold the payment, and the ledger gives no reason');
      throw refusal(why, args.amount, own, () => this.#all('open_ids', { wallet }).map(row => row.payment));
    });
  }

  // A transition: append it if allowed, else find out whether it was already done.
  #move(statement, payment, args, done) {
    const id = paymentId(payment);
    return this.#write(() => {
      if (this.#get(statement, { payment: id, ...args }) !== null) return this.#get('payment', { payment: id });
      const current = this.#get('payment', { payment: id });
      if (current === null) throw new BudgetError(`no payment ${id} in ${this.#path}`);
      const refusalOf = done(current);
      if (refusalOf !== null) throw new BudgetError(refusalOf);
      return current;
    });
  }

  /** held or void -> settled, with the evidence (a transaction hash, the payee's answer). Idempotent. */
  settle(payment, { evidence = null } = {}) {
    return this.#move('settle', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) }, () => null);
  }

  /** held -> void: evidence that the payment never moved money. A settled payment stays settled. */
  void(payment, { evidence = null } = {}) {
    return this.#move('void', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) },
      current => (current.state === 'settled' ? `payment ${current.payment} is settled; a settled payment can't be voided` : null));
  }

  /** held with no until -> held until `until`, or `withinMs` from now. One that has an until keeps it. */
  bound(payment, { until = null, withinMs = null }) {
    const args = {
      until: until === null ? null : millis(until, 'until'),
      within_ms: withinMs === null ? null : millis(withinMs, 'withinMs', { min: 1n }),
    };
    if ((args.until === null) === (args.within_ms === null)) throw new BudgetError('bound takes until or withinMs');
    return this.#move('bound', payment, args, current => (current.state === 'held' && current.until === null
      ? `settlesBy ${new Date(Number(args.until)).toISOString()} is not after now: a payment can't settle before it is made`
      : null));
  }

  /** Note a held payment's outcome: 'unknown' or 'refused'. It counts the same. */
  note(payment, outcome, { evidence = null } = {}) {
    if (outcome !== 'unknown' && outcome !== 'refused') throw new BudgetError("outcome is 'unknown' or 'refused'");
    return this.#move('note', payment, { outcome, evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) }, () => null);
  }

  /** One payment, or null. */
  payment(payment) { return this.#read(() => this.#get('payment', { payment: paymentId(payment) })); }

  /** What counts against the budget now. */
  status(name) {
    const wallet = walletKey(name);
    return this.#read(() => {
      const row = this.#get('status', { wallet });
      if (row === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      return row;
    });
  }

  /** The newest payments first. */
  history(name, { limit = 20 } = {}) {
    const wallet = walletKey(name);
    const rows = whole(limit, 'limit', { min: 1n, max: 1_000_000n });
    return this.#read(() => this.#all('history', { wallet, limit: rows }));
  }

  /** The payments that count now, oldest first; with heldOnly, the open ones. */
  counting(name, { heldOnly = false } = {}) {
    const wallet = walletKey(name);
    return this.#read(() => this.#all('counting', { wallet, held_only: heldOnly }));
  }

  /**
   * The owner's bulk release: void every held payment of unknown or refused outcome, held at
   * least `olderThanMs` ago, that can no longer settle. Returns { payment, amount } for each.
   */
  voidUnknown(name, olderThanMs, { evidence = 'released by its owner: unknown or refused outcome' } = {}) {
    const wallet = walletKey(name);
    const age = millis(olderThanMs, 'olderThanMs');
    return this.#write(() => {
      if (this.#get('budget', { wallet }) === null) throw new BudgetError(`${shortWallet(wallet)} has no budget in ${this.#path}`);
      return this.#all('void_unknown', { wallet, older_than_ms: age, evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) });
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    if (this.#db !== undefined) {
      detachClock(this.#db);
      try { this.#db.close(); } catch { /* already closed */ }
    }
  }
}

