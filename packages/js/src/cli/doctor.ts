// SPDX-License-Identifier: Apache-2.0
// walletcap doctor: check a budget file before relying on it. It opens the file read-only and
// changes nothing: no upgrade, no journal switch, no write. The Python package's
// walletcap/_doctor.py runs the same checks, in the same order, with the same words.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSqlite } from '../core/_sqlite.js';
import { loadSpec, MIN_SQLITE_VERSION, SCHEMA_VERSION, versionAtLeast } from '../core/ledger.js';
import { normalizeWallet, shortWallet } from '../core/money.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
  /** The budget a per-wallet check is about, or null. */
  wallet: string | null;
}

export interface DoctorReport {
  path: string;
  /** No check failed. Warnings don't count. */
  ok: boolean;
  /** The SQLite this runtime carries, or null if it can't be loaded. */
  sqliteVersion: string | null;
  checks: DoctorCheck[];
}

// Filesystems another host serves, or a hypervisor shares: SQLite's locks aren't reliable there.
const REMOTE_FILESYSTEMS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  '9p',
  'virtiofs',
  'ceph',
  'glusterfs',
  'lustre',
  'afs',
  'ncpfs',
  'beegfs',
  'davfs',
  'vboxsf',
  'vmhgfs',
  'prl_fs',
]);
const OPEN_HOLD = '9223372036854775807';
// How many payments' current rows disagree with their entries: another latest entry, another
// state, a count that doesn't follow from the state, or a row with no hold behind it.
const PROJECTION_SQL = `
SELECT (SELECT count(*) FROM wc_current c
         WHERE c.seq IS NOT (SELECT max(e.seq) FROM wc_entry e WHERE e.payment = c.payment)
            OR c.state IS NOT (SELECT CASE e.kind WHEN 'held' THEN 'held' ELSE e.kind END
                                 FROM wc_entry e
                                WHERE e.payment = c.payment AND e.kind IN ('held', 'settled', 'void')
                                ORDER BY e.seq DESC LIMIT 1)
            OR (c.counts_from IS NULL) IS NOT (c.state = 'void'))
     + abs((SELECT count(*) FROM wc_entry WHERE kind = 'held') - (SELECT count(*) FROM wc_current)) AS odd
`;

const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(4, '0');
const plural = (count: number): string => (count === 1 ? '' : 's');
const squeeze = (sql: string | null): string => (sql ?? '').split(/\s+/).filter(Boolean).join(' ');

// A mount point as /proc/self/mountinfo writes it: space, tab, newline and backslash are octal escapes.
const unescapeMount = (text: string): string => text.replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(Number.parseInt(digits, 8)));

/**
 * The type of the filesystem `path` is on, from the text of /proc/self/mountinfo: the mount whose
 * mount point is the longest prefix of the path, the last one listed if two share it. Null if no
 * line covers it.
 */
export function filesystemOf(mountinfo: string, path: string): string | null {
  let best: { point: string; type: string } | null = null;
  for (const line of mountinfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (before === undefined || after === undefined) continue;
    const point = unescapeMount(before.split(' ')[4] ?? '');
    const type = after.split(' ')[0] ?? '';
    if (point === '' || type === '') continue;
    const covers = point === '/' || path === point || path.startsWith(`${point}/`);
    if (covers && (best === null || point.length >= best.point.length)) best = { point, type };
  }
  return best === null ? null : best.type;
}

type Db = InstanceType<ReturnType<typeof loadSqlite>['DatabaseSync']>;
type SchemaRow = { type: string; name: string; sql: string | null };

const objects = (db: Db): Map<string, string> =>
  new Map(
    (db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as unknown as SchemaRow[]).map(row => [
      `${row.type} ${row.name}`,
      squeeze(row.sql),
    ]),
  );

// The names of the rule's tables, indexes, views and triggers that the file lacks or holds changed.
const ruleDifferences = (db: Db): string[] => {
  const { DatabaseSync } = loadSqlite();
  const reference = new DatabaseSync(':memory:');
  try {
    const { schema } = loadSpec();
    for (const name of ['tables', 'projection', 'guards']) reference.exec(schema.sections[name] ?? '');
    const found = objects(db);
    return [...objects(reference)]
      .filter(([key, sql]) => found.get(key) !== sql)
      .map(([key]) => key.split(' ')[1] ?? key)
      .sort();
  } finally {
    reference.close();
  }
};

/**
 * Check the budget file at `path`, and `wallet`'s budget in it, or every budget's. Reads only.
 */
export function doctor(path: string, { wallet }: { wallet?: string | undefined } = {}): DoctorReport {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: DoctorStatus, message: string, about: string | null = null): void => {
    checks.push({ id, status, message, wallet: about });
  };
  const report = (sqliteVersion: string | null): DoctorReport => ({
    path,
    ok: checks.every(check => check.status !== 'fail'),
    sqliteVersion,
    checks,
  });
  const only = wallet === undefined ? null : normalizeWallet(wallet);

  if (!existsSync(path)) {
    add('file', 'fail', `no budget file at ${path}: its owner creates one with walletcap set --wallet <address> --per-day <dollars>`);
    return report(null);
  }
  add('file', 'ok', 'the budget file exists');

  if (process.platform !== 'win32') {
    const file = statSync(path);
    const folder = statSync(dirname(path));
    if ((file.mode & 0o022) !== 0) {
      add('file_mode', 'fail', `the file is mode ${octal(file.mode)}: other users on this host can write it, and so change the budget; chmod 600 it`);
    } else if ((file.mode & 0o077) !== 0) {
      add('file_mode', 'warn', `the file is mode ${octal(file.mode)}: other users on this host can read it, each hold's token included; chmod 600 it`);
    } else {
      add('file_mode', 'ok', 'only its owner can read or write the file');
    }
    // A sticky folder (/tmp) lets only a file's owner replace it.
    if ((folder.mode & 0o022) !== 0 && (folder.mode & 0o1000) === 0) {
      add('folder_mode', 'warn', `the folder is mode ${octal(folder.mode)}: another user who can write it can replace the budget file; chmod 700 it`);
    } else {
      add('folder_mode', 'ok', 'only its owner can replace the file in its folder');
    }
    const me = process.getuid?.();
    if (me !== undefined && file.uid !== me) {
      add('file_owner', 'warn', `the file belongs to uid ${file.uid}, and this process runs as uid ${me}`);
    } else {
      add('file_owner', 'ok', 'the file belongs to this user');
    }
  }

  let type: string | null = null;
  if (process.platform === 'linux') {
    try {
      type = filesystemOf(readFileSync('/proc/self/mountinfo', 'utf8'), realpathSync(path));
    } catch {
      type = null;
    }
  }
  if (type === null) {
    add('filesystem', 'skipped', 'not checked on this platform: keep the file on a local disk, not NFS, SMB or a Docker Desktop bind mount');
  } else if (REMOTE_FILESYSTEMS.has(type)) {
    add(
      'filesystem',
      'fail',
      `the file is on ${type}, where SQLite's locks aren't reliable: two processes can both take the last dollar. Keep it on this host's local disk`,
    );
  } else if (type === 'fuse' || type.startsWith('fuse.')) {
    add('filesystem', 'warn', `the file is on ${type}: if another host or a hypervisor serves it, SQLite's locks aren't reliable there`);
  } else {
    add('filesystem', 'ok', `the file is on a local filesystem (${type})`);
  }

  let db: Db;
  let sqliteVersion: string | null = null;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    add('sqlite', 'fail', `SQLite can't open the file: ${(error as Error).message}`);
    return report(null);
  }
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = ON');
    sqliteVersion = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    if (versionAtLeast(sqliteVersion, MIN_SQLITE_VERSION)) add('sqlite', 'ok', `this runtime's SQLite is ${MIN_SQLITE_VERSION} or later`);
    else add('sqlite', 'fail', `this runtime's SQLite is ${sqliteVersion}; walletcap needs ${MIN_SQLITE_VERSION} or later`);

    let tables: string[];
    try {
      tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
    } catch (error) {
      add('schema', 'fail', `the file is not a SQLite database walletcap can read: ${(error as Error).message}`);
      return report(sqliteVersion);
    }
    let schema: string | null = null;
    if (tables.length === 0) {
      add('schema', 'warn', 'the file is empty: walletcap set --wallet <address> --per-day <dollars> creates the budget');
      return report(sqliteVersion);
    }
    if (tables.includes('budget_meta')) {
      schema = (db.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value ?? null;
    }
    if (schema === null) {
      add('schema', 'fail', 'the file is a SQLite file, not a walletcap budget');
      return report(sqliteVersion);
    }
    if (schema === '1' || schema === '2') {
      add(
        'schema',
        'warn',
        `the file is at schema ${schema}, which an older walletcap wrote: this version upgrades it the first time it opens it, so stop every older walletcap process first`,
      );
      return report(sqliteVersion);
    }
    if (schema !== SCHEMA_VERSION) {
      add('schema', 'fail', `the file is at schema ${schema}, which a newer walletcap wrote; this one reads ${SCHEMA_VERSION}`);
      return report(sqliteVersion);
    }
    add('schema', 'ok', `the file is at schema ${SCHEMA_VERSION}`);

    const damage = (db.prepare('PRAGMA quick_check').all() as { quick_check: string }[]).map(row => row.quick_check);
    if (damage.length === 1 && damage[0] === 'ok') add('integrity', 'ok', 'SQLite finds the file intact');
    else add('integrity', 'fail', `SQLite reports damage in the file: ${damage[0] ?? 'no answer'}`);

    const { journal_mode: journal } = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    if (journal === 'wal') add('journal', 'ok', 'write-ahead logging is on');
    else
      add('journal', 'warn', `the journal mode is ${journal}, not wal: walletcap switches it the next time it opens the file while no other process holds it`);

    const changed = ruleDifferences(db);
    if (changed.length === 0) {
      add('rules', 'ok', 'every table, index, view and trigger of the rule is in place, as walletcap ships it');
    } else {
      add(
        'rules',
        'fail',
        `the file's rule differs from the one walletcap ships: ${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} missing or changed. ` +
          'Its triggers enforce the budget for every writer, so payments from this file are not held to it; restore the file from a backup',
      );
      return report(sqliteVersion);
    }

    // Each payment's latest state is kept beside the ledger's entries, by trigger. A row put there
    // any other way (INSERT OR REPLACE passes the guards) un-counts a payment with no entry.
    const odd = Number((db.prepare(PROJECTION_SQL).get() as { odd: number | bigint }).odd);
    if (odd === 0) {
      add('projection', 'ok', "every payment's state matches the ledger's entries");
    } else {
      add(
        'projection',
        'fail',
        `${odd} payment${plural(odd)} ${odd === 1 ? 'has' : 'have'} a state the ledger's entries don't give ${odd === 1 ? 'it' : 'them'}: ` +
          "the file was written outside walletcap's statements, so its count can't be trusted; restore the file from a backup",
      );
      return report(sqliteVersion);
    }

    const budgets = (
      db.prepare('SELECT wallet, unit, frozen_at FROM wc_budget ORDER BY wallet').all() as { wallet: string; unit: string; frozen_at: unknown }[]
    ).filter(row => only === null || row.wallet === only);
    if (budgets.length === 0) {
      if (only === null) add('budgets', 'warn', 'the file holds no budget yet: walletcap set --wallet <address> --per-day <dollars>');
      else add('budgets', 'fail', `${shortWallet(only)} has no budget in the file: walletcap set --wallet ${only} --per-day <dollars>`, only);
      return report(sqliteVersion);
    }
    add(
      'budgets',
      'ok',
      only === null ? `the file holds ${budgets.length} budget${plural(budgets.length)}` : `${shortWallet(only)} has a budget in the file`,
      only,
    );
    const open = db.prepare(`SELECT count(*) AS held FROM wc_current WHERE wallet = ? AND state = 'held' AND counts_from = ${OPEN_HOLD}`);
    for (const budget of budgets) {
      const name = shortWallet(budget.wallet);
      if (budget.frozen_at !== null) add('frozen', 'warn', `${name} is frozen: every payment is refused until walletcap unfreeze`, budget.wallet);
      const held = Number((open.get(budget.wallet) as { held: number | bigint }).held);
      if (held > 0) {
        add(
          'open_holds',
          'warn',
          `${name} has ${held} held payment${plural(held)} with no settle-by time: ${held === 1 ? 'it counts' : 'they count'} until voided or settled (walletcap holds)`,
          budget.wallet,
        );
      }
    }
    return report(sqliteVersion);
  } catch (error) {
    add('sqlite', 'fail', `SQLite can't read the file: ${(error as Error).message}`);
    return report(sqliteVersion);
  } finally {
    db.close();
  }
}

const LABEL: Readonly<Record<DoctorStatus, string>> = { ok: 'ok', warn: 'warn', fail: 'FAIL', skipped: 'skip' };

const checkLines = (checks: DoctorCheck[]): string[] => {
  const width = Math.max(0, ...checks.map(check => check.id.length));
  return checks.map(check => `  ${LABEL[check.status].padEnd(4)}  ${check.id.padEnd(width)}  ${check.message}`);
};

const verdictOf = (report: DoctorReport): string => {
  const failed = report.checks.filter(check => check.status === 'fail').length;
  const warned = report.checks.filter(check => check.status === 'warn').length;
  const counts = [failed > 0 ? `${failed} problem${plural(failed)}` : '', warned > 0 ? `${warned} warning${plural(warned)}` : ''].filter(Boolean);
  return counts.length === 0 ? 'Everything checks out.' : `${counts.join(', ')}.`;
};

/** The report as the command prints it. */
export function doctorText(report: DoctorReport): string {
  return [`Budget file ${report.path}`, '', ...checkLines(report.checks), '', verdictOf(report)].join('\n');
}

/** The report as init prints it: each warning and failure, then the verdict; the verdict alone when there are none. */
export function doctorFindings(report: DoctorReport): string {
  return [...checkLines(report.checks.filter(check => check.status === 'warn' || check.status === 'fail')), verdictOf(report)].join('\n');
}
