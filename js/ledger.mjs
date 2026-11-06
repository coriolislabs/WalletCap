// SPDX-License-Identifier: Apache-2.0
// The budget file: one SQLite database that every process on one host opens,
// for every rail. A payment reserves its amount inside one BEGIN IMMEDIATE
// transaction, so two processes racing for the last of a budget cannot both
// win, and a restart reads the same count. The file must be on that host's
// local disk: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop
// bind mounts. The Python ledger in this package uses the same tables and the
// same counting rule, so both languages spend from one budget.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { now as clockNow } from './_clock.mjs';
import { BudgetError, BudgetRefused } from './errors.mjs';
import {
  DOLLAR_UNITS, formatAmount, formatWindow, MAX_AMOUNT, MAX_INTEGER, normalizeWallet, shortWallet, storedWalletName,
} from './money.mjs';

/**
 * The file's format. Schema 2 is 0.2.x's schema 1 with every budget under its
 * canonical name and settled payments that keep their reservation's expiry;
 * 0.3 upgrades a schema 1 file when it opens it, and 0.2.x refuses a schema 2
 * file rather than misread it.
 */
export const SCHEMA_VERSION = '2';
export const REFERENCE_LIMIT = 4096;

/**
 * Internal: the key of Reservation's method that gives an open payment, once, the
 * last moment it could still settle. The package does not export it.
 */
export const SETTLES_BY = Symbol('walletcap/settles-by');

const ID = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (
    instrument TEXT PRIMARY KEY,
    unit TEXT NOT NULL,
    cap INTEGER NOT NULL CHECK (cap >= 0),
    window_ms INTEGER NOT NULL CHECK (window_ms > 0),
    per_payment INTEGER CHECK (per_payment IS NULL OR per_payment > 0),
    max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 0),
    revoked_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS spend (
    spend_id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL REFERENCES budgets(instrument),
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed')),
    rail TEXT NOT NULL,
    reference TEXT,
    at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS spend_by_instrument ON spend (instrument, at_ms);
`;
// The counting rule, the same in Python. A settled payment counts while its
// settlement is inside the budget's rolling window, and also until its expiry,
// if the reservation it settled had one: a commit never shortens a hold, so a
// payee's word that a payment settled can't free the budget while its signed
// authorization can still be redeemed. A reservation counts until it is
// committed or released, or its expiry passes, whatever the window.
const COUNTED = 'FROM spend JOIN budgets ON budgets.instrument = spend.instrument '
  + "WHERE spend.instrument = ? AND ((spend.status = 'committed' AND (spend.at_ms + budgets.window_ms >= ? OR spend.expires_at_ms > ?)) "
  + "OR (spend.status = 'reserved' AND (spend.expires_at_ms IS NULL OR spend.expires_at_ms > ?)))";

// node:sqlite prints an ExperimentalWarning when it loads (Node 22 and 24).
// Load it once with that one warning held back, so an agent's logs stay clean.
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

export const identifier = (value, label) => {
  if (typeof value !== 'string' || !ID.test(value)) throw new BudgetError(`${label} must be a plain identifier`);
  return value;
};

/**
 * The name a budget is kept under, whoever opens it: an EVM address, bare or
 * CAIP-10, is lowercased after its EIP-55 check, and a Solana CAIP-10 is reduced
 * to its address, as openBudget() does. A checksummed address can't open a
 * second budget beside the lowercase one.
 */
export const instrumentName = value => normalizeWallet(identifier(value, 'instrument'));

/** Refuse an option `what` doesn't take, naming the one that was probably meant. */
export const checkKeys = (source, known, what) => {
  if (source === null || typeof source !== 'object') throw new BudgetError(`${what} takes an options object`);
  for (const key of Object.keys(source)) {
    if (known.has(key)) continue;
    const plain = key.toLowerCase().replaceAll(/[-_]/g, '');
    const match = [...known].find(candidate => candidate.toLowerCase() === plain);
    throw new BudgetError(`unknown option ${key}${match ? `; did you mean ${match}?` : ''}`);
  }
};

// A bigint, a safe integer, or a string of ASCII digits: nothing else, so '0x10', ' 7 ' and true are refused.
const wholeNumber = (value, label, { allowZero, max, most }) => {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[0-9]+$/.test(value)) parsed = BigInt(value);
  else throw new BudgetError(`${label} must be an integer`);
  if (parsed > max || parsed < (allowZero ? 0n : 1n)) {
    throw new BudgetError(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} integer ${most}`);
  }
  return parsed;
};

/** An amount in the budget's own unit, at most MAX_AMOUNT, so no sum of them overflows 64 bits. */
export const units = (value, label, { allowZero = false } = {}) => wholeNumber(value, label, { allowZero, max: MAX_AMOUNT, most: `of at most ${MAX_AMOUNT}` });

/** A time in milliseconds, or a count, that fits in 64 bits. */
export const integer = (value, label, { allowZero = false } = {}) => wholeNumber(value, label, { allowZero, max: MAX_INTEGER, most: 'that fits in 64 bits' });

// Counted as a payment settled at `settlesBy` would be: through settlesBy + window. A payment is
// made after it is reserved, so a settle-by time that isn't after now is a mistake, and refused.
const expiry = (settlesBy, now, windowMs) => {
  if (settlesBy <= now) {
    const iso = ms => new Date(Number(ms)).toISOString();
    throw new BudgetError(`settlesBy ${iso(settlesBy)} is not after now (${iso(now)}): a payment can't settle before it is made`);
  }
  return settlesBy + windowMs >= MAX_INTEGER ? MAX_INTEGER : settlesBy + windowMs + 1n;
};

const referenceText = reference => {
  if (reference === null || reference === undefined) return null;
  if (typeof reference !== 'string' || reference.length > REFERENCE_LIMIT) {
    throw new BudgetError(`reference must be a string of at most ${REFERENCE_LIMIT} characters`);
  }
  return reference;
};

const unreadable = (path, error) => new BudgetError(`the budget file ${path} cannot be used: ${error.message}`, { cause: error });

/** Why `row`'s budget refuses `spend` on top of what already counts, or null. */
// Open payments named in a refusal, so its owner can see which holds take the room: the oldest few.
const SHOWN_HOLDS = 3;
const heldNote = (heldUses, openIds) => {
  const ids = openIds();
  const more = heldUses > BigInt(ids.length) ? ` and ${heldUses - BigInt(ids.length)} more` : '';
  return `${ids.join(', ')}${more}; walletcap holds lists them, and if one never left the wallet its owner can release it`;
};

/**
 * Why `row`'s budget refuses `spend` on top of what already counts, or null.
 * `heldTotal` and `heldUses` are the part of the count that is open payments,
 * and `openIds()` gives the oldest of their ids, so the refusal can name them.
 */
export function refusal(row, { total, uses, heldTotal = 0n, heldUses = 0n }, spend, openIds = () => []) {
  const name = shortWallet(row.instrument);
  const money = value => formatAmount(value, row.unit);
  const window = formatWindow(row.window_ms);
  const plural = count => (count === 1n ? '' : 's');
  if (row.revoked_at_ms !== null) {
    return new BudgetRefused('revoked', `${name}'s budget is frozen: nothing can be paid until its owner unfreezes it`);
  }
  if (row.per_payment !== null && spend > row.per_payment) {
    return new BudgetRefused('per_payment', `${money(spend)} is over ${name}'s ${money(row.per_payment)} limit per payment`);
  }
  if (total + spend > row.cap) {
    const left = row.cap > total ? row.cap - total : 0n;
    const held = heldUses > 0n ? `; ${money(heldTotal)} of it is ${heldUses} open payment${plural(heldUses)} (${heldNote(heldUses, openIds)})` : '';
    return new BudgetRefused('budget', `${money(spend)} would bring ${name} to ${money(total + spend)} in the last ${window}, over its ${money(row.cap)} limit (${money(left)} left)${held}`);
  }
  if (row.max_uses !== null && uses + 1n > row.max_uses) {
    if (heldUses === 0n) {
      return new BudgetRefused('uses', `${name} already made ${uses} payment${plural(uses)} in the last ${window}, the most its budget allows`);
    }
    return new BudgetRefused('uses', `${name} has ${uses} payment${plural(uses)} counting in the last ${window}, the most its budget allows, `
      + `and ${heldUses} of them ${heldUses === 1n ? 'is' : 'are'} still open (${heldNote(heldUses, openIds)})`);
  }
  return null;
}

const unitsMatch = (stored, wanted) => (DOLLAR_UNITS.has(wanted) ? DOLLAR_UNITS.has(stored) : stored === wanted);

export class Ledger {
  #db;
  #path;
  #closed = false;
  #statements = new Map();

  constructor(path, { busyTimeoutMs = 30_000 } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) throw new BudgetError('busyTimeoutMs must be a positive integer');
    const { DatabaseSync } = loadSqlite();
    this.#path = path;
    try {
      this.#db = new DatabaseSync(path);
    } catch (error) {
      throw unreadable(path, error);
    }
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#db.exec('PRAGMA foreign_keys = ON');
      this.#db.exec(SCHEMA);
      this.transaction(() => {
        this.statement("INSERT OR IGNORE INTO budget_meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
        const { value } = this.statement("SELECT value FROM budget_meta WHERE key = 'schema'").get();
        if (value === '1') this.#upgradeFromSchema1();
        else if (value !== SCHEMA_VERSION) throw new BudgetError(`ledger schema ${value} is not ${SCHEMA_VERSION}`);
      });
    } catch (error) {
      this.#db.close();
      throw error instanceof BudgetError ? error : unreadable(path, error);
    }
  }

  get path() { return this.#path; }

  // 0.2.x kept a budget under the name SharedBudgetStore or Python's Ledger was given, so a
  // checksummed or CAIP-10 address could hold a budget beside the lowercase one. Each moves to its
  // canonical name, merged with any budget already there: the tighter of every limit, and every
  // payment, so nothing stops counting. The Python ledger upgrades a file the same way.
  #upgradeFromSchema1() {
    const sameUnit = (a, b) => a === b || (DOLLAR_UNITS.has(a) && DOLLAR_UNITS.has(b));
    const least = (a, b) => (a === null ? b : b === null || a < b ? a : b);
    for (const row of this.statement('SELECT * FROM budgets ORDER BY instrument').all()) {
      const name = storedWalletName(row.instrument);
      if (name === row.instrument) continue;
      const kept = this.#row(name);
      if (kept === null) {
        this.statement('INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(name, row.unit, row.cap, row.window_ms, row.per_payment, row.max_uses, row.revoked_at_ms);
      } else {
        if (!sameUnit(kept.unit, row.unit)) {
          throw new BudgetError(`${this.#path} holds two budgets for ${shortWallet(name)}, counted in ${kept.unit} and ${row.unit}; they can't be merged into one`);
        }
        // A longer window with a smaller cap is tighter than either budget was.
        this.statement('UPDATE budgets SET cap = ?, window_ms = ?, per_payment = ?, max_uses = ?, revoked_at_ms = ? WHERE instrument = ?').run(
          least(kept.cap, row.cap), kept.window_ms > row.window_ms ? kept.window_ms : row.window_ms,
          least(kept.per_payment, row.per_payment), least(kept.max_uses, row.max_uses), least(kept.revoked_at_ms, row.revoked_at_ms), name,
        );
      }
      this.statement('UPDATE spend SET instrument = ? WHERE instrument = ?').run(name, row.instrument);
      this.statement('DELETE FROM budgets WHERE instrument = ?').run(row.instrument);
    }
    this.statement("UPDATE budget_meta SET value = ? WHERE key = 'schema'").run(SCHEMA_VERSION);
  }

  /** The ledger's own time: the system clock, in milliseconds. Callers can't set it. */
  now() { return integer(clockNow(), 'clock', { allowZero: true }); }

  statement(sql) {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      statement.setReadBigInts(true);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Run `work` in one write transaction; another process waits for the busy timeout. */
  transaction(work) { return this.#run('BEGIN IMMEDIATE', work); }

  /** Run `work` against one consistent snapshot of the file. */
  read(work) { return this.#run('BEGIN', work); }

  #run(begin, work) {
    try {
      this.#db.exec(begin);
    } catch (error) {
      throw unreadable(this.#path, error); // a busy timeout throws here, before anything to roll back
    }
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error instanceof BudgetError ? error : unreadable(this.#path, error);
    }
  }

  #row(instrument) {
    return this.statement('SELECT * FROM budgets WHERE instrument = ?').get(instrument) ?? null;
  }

  #required(instrument) {
    const row = this.#row(instrument);
    if (row === null) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
    return row;
  }

  #counted(instrument, now) {
    return this.statement('SELECT COALESCE(SUM(spend.amount), 0) AS total, COUNT(spend.spend_id) AS uses, '
      + "COALESCE(SUM(CASE WHEN spend.status = 'reserved' THEN spend.amount END), 0) AS heldTotal, "
      + `COUNT(CASE WHEN spend.status = 'reserved' THEN 1 END) AS heldUses ${COUNTED}`)
      .get(instrument, now, now, now);
  }

  // The ids of the oldest open payments that count, for a refusal to name.
  #openIds(instrument, now) {
    return () => this.statement(`SELECT spend.spend_id ${COUNTED} AND spend.status = 'reserved' ORDER BY spend.at_ms, spend.rowid LIMIT ?`)
      .all(instrument, now, now, now, SHOWN_HOLDS).map(row => row.spend_id);
  }

  #insert(instrument, unit, { cap, windowMs, perPayment = null, maxUses = null }) {
    this.statement('INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(instrument, unit, cap, windowMs, perPayment, maxUses);
  }

  // Limits from ensure() and setLimits(), checked here too: every stored cap is bounded.
  static #limits({ cap, windowMs, perPayment, maxUses }) {
    const limits = {};
    if (cap !== undefined) limits.cap = units(cap, 'cap', { allowZero: true });
    if (windowMs !== undefined) limits.windowMs = integer(windowMs, 'windowMs');
    if (perPayment !== undefined) limits.perPayment = perPayment === null ? null : units(perPayment, 'perPayment');
    if (maxUses !== undefined) limits.maxUses = maxUses === null ? null : integer(maxUses, 'maxUses', { allowZero: true });
    return limits;
  }

  budget(instrument) {
    const name = instrumentName(instrument);
    return this.read(() => this.#row(name));
  }

  budgets() { return this.read(() => this.statement('SELECT * FROM budgets ORDER BY instrument').all()); }

  /** Record a budget once; declaring it again with other limits is refused. */
  declare(name, { unit, cap, windowMs, perPayment = null, maxUses = null }) {
    const instrument = instrumentName(name);
    identifier(unit, 'unit');
    const budget = {
      unit,
      cap: units(cap, 'cap', { allowZero: true }),
      window_ms: integer(windowMs, 'windowMs'),
      per_payment: perPayment === null ? null : units(perPayment, 'perPayment'),
      max_uses: maxUses === null ? null : integer(maxUses, 'maxUses', { allowZero: true }),
    };
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        this.#insert(instrument, unit, { cap: budget.cap, windowMs: budget.window_ms, perPayment: budget.per_payment, maxUses: budget.max_uses });
        return this.#row(instrument);
      }
      if (Object.keys(budget).some(key => row[key] !== budget[key])) {
        throw new BudgetError('instrument budget is already declared with other limits');
      }
      return row;
    });
  }

  /**
   * Create the budget with `limits`, or move its stored limits toward them:
   * a tighter limit is stored, a looser one is reported and left alone. A
   * restart can lower a limit; only setLimits() raises one.
   */
  ensure(name, asked, { unit = 'usd', create = true } = {}) {
    const instrument = instrumentName(name);
    const limits = Ledger.#limits(asked);
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        if (!create) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
        if (limits.cap === undefined) {
          throw new BudgetError(`${shortWallet(instrument)} has no budget yet: give it a rolling limit, like perDay: '$150'`);
        }
        this.#insert(instrument, unit, limits);
        return { created: true, lowered: [], looser: [], row: this.#row(instrument) };
      }
      if (!unitsMatch(row.unit, unit)) throw new BudgetError(`${shortWallet(instrument)}'s budget counts in ${row.unit}, not ${unit}`);
      const lowered = [];
      const looser = [];
      const sameWindow = limits.windowMs === undefined || limits.windowMs === row.window_ms;
      let { cap, per_payment: perPayment, max_uses: maxUses } = row;
      if (limits.cap !== undefined) {
        if (!sameWindow) looser.push({ field: 'window', stored: row.window_ms, asked: limits.windowMs });
        else if (limits.cap < cap) { cap = limits.cap; lowered.push('cap'); }
        else if (limits.cap > cap) looser.push({ field: 'cap', stored: cap, asked: limits.cap });
      }
      if (limits.perPayment !== undefined) {
        const asked = limits.perPayment;
        if (asked !== null && (perPayment === null || asked < perPayment)) { perPayment = asked; lowered.push('perPayment'); }
        else if (perPayment !== null && (asked === null || asked > perPayment)) looser.push({ field: 'perPayment', stored: perPayment, asked });
      }
      if (limits.maxUses !== undefined && limits.maxUses !== maxUses) {
        const asked = limits.maxUses;
        if (sameWindow && asked !== null && (maxUses === null || asked < maxUses)) { maxUses = asked; lowered.push('maxUses'); }
        else looser.push({ field: 'maxUses', stored: maxUses, asked });
      }
      if (lowered.length > 0) {
        this.statement('UPDATE budgets SET cap = ?, per_payment = ?, max_uses = ? WHERE instrument = ?')
          .run(cap, perPayment, maxUses, instrument);
      }
      return { created: false, lowered, looser, row: this.#row(instrument) };
    });
  }

  /** Change limits in either direction. What was spent keeps counting: nothing resets. */
  setLimits(name, asked, { unit = 'usd', create = true } = {}) {
    const instrument = instrumentName(name);
    const limits = Ledger.#limits(asked);
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        if (!create) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
        if (limits.cap === undefined) {
          throw new BudgetError(`${shortWallet(instrument)} has no budget yet: give it a rolling limit too, like --per-day 150`);
        }
        this.#insert(instrument, unit, limits);
        return this.#row(instrument);
      }
      if (!unitsMatch(row.unit, unit)) throw new BudgetError(`${shortWallet(instrument)}'s budget counts in ${row.unit}, not ${unit}`);
      if (limits.windowMs !== undefined && limits.windowMs !== row.window_ms) {
        const used = this.statement('SELECT 1 FROM spend WHERE instrument = ? LIMIT 1').get(instrument);
        if (used) {
          throw new BudgetError(`${shortWallet(instrument)} has spend in this budget; the window cannot change. Create a new budget instead.`);
        }
      }
      this.statement('UPDATE budgets SET cap = ?, window_ms = ?, per_payment = ?, max_uses = ? WHERE instrument = ?').run(
        limits.cap ?? row.cap,
        limits.windowMs ?? row.window_ms,
        limits.perPayment === undefined ? row.per_payment : limits.perPayment,
        limits.maxUses === undefined ? row.max_uses : limits.maxUses,
        instrument,
      );
      return this.#row(instrument);
    });
  }

  /** What counts against the budget right now: total and number of payments. */
  counted(name) {
    const instrument = instrumentName(name);
    return this.read(() => this.#counted(instrument, this.now()));
  }

  /** The payments that count right now, and the ledger's time they were read at. */
  countedRows(name) {
    const instrument = instrumentName(name);
    return this.read(() => {
      const now = this.now();
      const rows = this.statement(
        `SELECT spend.spend_id, spend.status, spend.amount, spend.rail, spend.reference, spend.at_ms, spend.expires_at_ms ${COUNTED}`,
      ).all(instrument, now, now, now);
      return { now, rows };
    });
  }

  /** Whether `amount` would be refused right now, without reserving it. */
  check(name, amount) {
    const instrument = instrumentName(name);
    const spend = units(amount, 'amount');
    return this.read(() => {
      const now = this.now();
      const row = this.#required(instrument);
      const counted = this.#counted(instrument, now);
      const refused = refusal(row, counted, spend, this.#openIds(instrument, now));
      const left = row.cap - counted.total;
      return { refusal: refused, total: counted.total, uses: counted.uses, remaining: row.revoked_at_ms !== null || left < 0n ? 0n : left };
    });
  }

  /**
   * Take `amount` from the budget, or throw the BudgetRefused that says why
   * not. A reservation counts until committed or released. With settlesByMs
   * (the last moment the payment could still settle, after now) it stops
   * counting one window after that moment, as if it had settled then.
   */
  reserve(name, amount, { rail = 'js', reference = null, settlesByMs = null } = {}) {
    const instrument = instrumentName(name);
    const spend = units(amount, 'amount');
    identifier(rail, 'rail');
    const text = referenceText(reference);
    const settlesBy = settlesByMs === null ? null : integer(settlesByMs, 'settlesByMs', { allowZero: true });
    return this.transaction(() => {
      // Read once the write lock is held: a wait for another process can't leave it stale.
      const now = this.now();
      const row = this.#required(instrument);
      const refused = refusal(row, this.#counted(instrument, now), spend, this.#openIds(instrument, now));
      if (refused !== null) throw refused;
      const spendId = `spend-${randomUUID().replaceAll('-', '')}`;
      const expires = settlesBy === null ? null : expiry(settlesBy, now, row.window_ms);
      this.statement("INSERT INTO spend VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)")
        .run(spendId, instrument, spend, rail, text, now, expires);
      return spendId;
    });
  }

  /**
   * Record a payment as settled now, after the same checks. Coinbase's SDK
   * records a payment when it creates it; the time is always the ledger's own.
   * With settlesWithinMs, the payment can still settle up to that long after it
   * is recorded, so it counts until one window past that moment too.
   */
  record(name, amount, { rail, reference = null, settlesWithinMs = null }) {
    const instrument = instrumentName(name);
    const spend = units(amount, 'amount');
    identifier(rail, 'rail');
    const text = referenceText(reference);
    const within = settlesWithinMs === null ? null : integer(settlesWithinMs, 'settlesWithinMs');
    return this.transaction(() => {
      const now = this.now();
      const row = this.#required(instrument);
      const refused = refusal(row, this.#counted(instrument, now), spend, this.#openIds(instrument, now));
      if (refused !== null) throw refused;
      const spendId = `${rail}-${randomUUID()}`;
      const expires = within === null ? null : expiry(now + within, now, row.window_ms);
      this.statement("INSERT INTO spend VALUES (?, ?, ?, 'committed', ?, ?, ?, ?)")
        .run(spendId, instrument, spend, rail, text, now, expires);
      return spendId;
    });
  }

  /**
   * The payment settled: it counts for one rolling window from now, and, if the
   * reservation had a settle-by time, at least until one window past that time.
   * A commit never shortens a hold: the word that a payment settled may come
   * from the payee, who could still redeem the authorization later.
   */
  commit(spendId, { reference } = {}) {
    identifier(spendId, 'spend_id');
    const text = referenceText(reference);
    this.transaction(() => {
      const now = this.now();
      const row = this.statement('SELECT status FROM spend WHERE spend_id = ?').get(spendId);
      if (row === undefined) throw new BudgetError('unknown reservation');
      if (row.status === 'committed') throw new BudgetError('reservation is already committed');
      this.statement("UPDATE spend SET status = 'committed', at_ms = MAX(at_ms, ?), "
        + 'reference = COALESCE(?, reference) WHERE spend_id = ?').run(now, text, spendId);
    });
  }

  /**
   * Give an open reservation that has no settle-by time the last moment its
   * payment could settle: it then counts until one window after that moment,
   * as reserve() with settlesByMs does. A reservation that already has one
   * keeps it.
   */
  settlesBy(spendId, settlesByMs) {
    identifier(spendId, 'spend_id');
    const settlesBy = integer(settlesByMs, 'settlesByMs', { allowZero: true });
    this.transaction(() => {
      const now = this.now();
      const row = this.statement('SELECT spend.status, spend.expires_at_ms, budgets.window_ms FROM spend '
        + 'JOIN budgets ON budgets.instrument = spend.instrument WHERE spend.spend_id = ?').get(spendId);
      if (row === undefined || row.status !== 'reserved' || row.expires_at_ms !== null) return;
      this.statement("UPDATE spend SET expires_at_ms = ? WHERE spend_id = ? AND status = 'reserved' AND expires_at_ms IS NULL")
        .run(expiry(settlesBy, now, row.window_ms), spendId);
    });
  }

  /** Replace an open reservation's reference; it keeps counting. */
  annotate(spendId, reference) {
    identifier(spendId, 'spend_id');
    const text = referenceText(reference);
    this.transaction(() => {
      this.statement("UPDATE spend SET reference = ? WHERE spend_id = ? AND status = 'reserved'").run(text, spendId);
    });
  }

  /** Give back a reservation whose payment never left. */
  release(spendId) {
    identifier(spendId, 'spend_id');
    this.transaction(() => {
      const { changes } = this.statement("DELETE FROM spend WHERE spend_id = ? AND status = 'reserved'").run(spendId);
      if (Number(changes) !== 1) throw new BudgetError('only an uncommitted reservation can be released');
    });
  }

  /**
   * Turn a recorded payment back into an open reservation, noting why: it counts
   * until someone releases it, whatever the window.
   */
  reopenByReference(name, rail, reference, { outcome } = {}) {
    const instrument = instrumentName(name);
    this.transaction(() => {
      const row = this.statement("SELECT spend_id, reference FROM spend WHERE instrument = ? AND rail = ? AND reference = ? AND status = 'committed' LIMIT 1")
        .get(instrument, rail, reference);
      if (row === undefined) return;
      let text = row.reference;
      if (outcome !== undefined) {
        try { text = referenceText(JSON.stringify({ ...JSON.parse(row.reference), outcome })); } catch { /* keep the reference as it was */ }
      }
      this.statement("UPDATE spend SET status = 'reserved', expires_at_ms = NULL, reference = ? WHERE spend_id = ?").run(text, row.spend_id);
    });
  }

  /** Refuse every later payment from the instrument, on every rail. */
  revoke(name) {
    const instrument = instrumentName(name);
    this.transaction(() => {
      const now = this.now();
      this.#required(instrument);
      this.statement('UPDATE budgets SET revoked_at_ms = ? WHERE instrument = ? AND revoked_at_ms IS NULL').run(now, instrument);
    });
  }

  /** Allow payments again after revoke(). */
  unrevoke(name) {
    const instrument = instrumentName(name);
    this.transaction(() => {
      this.#required(instrument);
      this.statement('UPDATE budgets SET revoked_at_ms = NULL WHERE instrument = ?').run(instrument);
    });
  }

  /** What counts against the budget right now, in its own unit. */
  status(name) {
    const instrument = instrumentName(name);
    return this.read(() => {
      const now = this.now();
      const row = this.#required(instrument);
      const sums = Object.fromEntries(this.statement(
        `SELECT spend.status AS status, COALESCE(SUM(spend.amount), 0) AS total, COUNT(spend.spend_id) AS uses ${COUNTED} GROUP BY spend.status`,
      ).all(instrument, now, now, now).map(sum => [sum.status, sum]));
      const spent = sums.committed?.total ?? 0n;
      const reserved = sums.reserved?.total ?? 0n;
      const revoked = row.revoked_at_ms !== null;
      const left = row.cap - spent - reserved;
      return {
        instrument,
        unit: row.unit,
        cap: row.cap,
        windowMs: row.window_ms,
        perPayment: row.per_payment,
        maxUses: row.max_uses,
        spent,
        reserved,
        uses: (sums.committed?.uses ?? 0n) + (sums.reserved?.uses ?? 0n),
        revoked,
        remaining: revoked || left < 0n ? 0n : left,
      };
    });
  }

  /** The newest payments first, with whether each still counts. */
  history(name, { limit = 20 } = {}) {
    const instrument = instrumentName(name);
    const rows = integer(limit, 'limit');
    return this.read(() => {
      const now = this.now();
      const row = this.#required(instrument);
      return this.statement('SELECT * FROM spend WHERE instrument = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?')
        .all(instrument, rows)
        .map(spend => ({
          ...spend,
          counting: spend.status === 'committed'
            ? spend.at_ms + row.window_ms >= now || (spend.expires_at_ms !== null && spend.expires_at_ms > now)
            : spend.expires_at_ms === null || spend.expires_at_ms > now,
        }));
    });
  }

  /**
   * The open payments that still count, oldest first: in flight, refused by the
   * payee, or of unknown outcome. Each row carries the ledger's time as `now`.
   */
  holds(name) {
    const instrument = instrumentName(name);
    return this.read(() => {
      const now = this.now();
      this.#required(instrument);
      return this.statement("SELECT * FROM spend WHERE instrument = ? AND status = 'reserved' "
        + 'AND (expires_at_ms IS NULL OR expires_at_ms > ?) ORDER BY at_ms, rowid').all(instrument, now)
        .map(row => ({ ...row, now }));
    });
  }

  /**
   * Give back every open payment whose outcome is unknown and that was taken at
   * least `olderThanMs` ago, for an owner who has checked they never left the
   * wallet. Returns the payments released.
   */
  releaseUnknown(name, olderThanMs) {
    const instrument = instrumentName(name);
    const age = integer(olderThanMs, 'olderThanMs', { allowZero: true });
    const outcomeOf = text => { try { return JSON.parse(text)?.outcome; } catch { return undefined; } };
    return this.transaction(() => {
      const now = this.now();
      this.#required(instrument);
      const released = this.statement("SELECT * FROM spend WHERE instrument = ? AND status = 'reserved' AND at_ms <= ? ORDER BY at_ms, rowid")
        .all(instrument, now - age).filter(row => outcomeOf(row.reference) === 'unknown');
      const remove = this.statement("DELETE FROM spend WHERE spend_id = ? AND status = 'reserved'");
      for (const row of released) remove.run(row.spend_id);
      return released;
    });
  }

  /** One payment by id, or null. */
  payment(spendId) {
    identifier(spendId, 'spend_id');
    return this.read(() => this.statement('SELECT * FROM spend WHERE spend_id = ?').get(spendId) ?? null);
  }

  /** Delete settled payments older than `cutoffMs` that no longer count. */
  prune(name, cutoffMs) {
    const instrument = instrumentName(name);
    const cutoff = integer(cutoffMs, 'olderThanMs', { allowZero: true });
    this.transaction(() => {
      const now = this.now();
      const { window_ms: window } = this.#required(instrument);
      // Reservations stay until committed or released: a lapsed one may still settle.
      this.statement("DELETE FROM spend WHERE instrument = ? AND status = 'committed' AND at_ms < ? AND at_ms + ? < ? "
        + 'AND (expires_at_ms IS NULL OR expires_at_ms <= ?)')
        .run(instrument, cutoff, window, now, now);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }
}
