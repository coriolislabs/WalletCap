// SPDX-License-Identifier: Apache-2.0
// walletcap watch and walletcap init, through the command line. The Python suite runs the same
// cases (tests/test_watch_init.py), and tests/test_cli_json.py compares the two command lines' JSON.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBudget, openOwner } from 'walletcap';
import { resetClock, setClock } from '../dist/core/_clock.js';

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const SPEC = new URL('../../../spec/', import.meta.url);
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-watch-'));
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
afterEach(resetClock);
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const OTHER = '0x4165cb72de51a67aac32dc33197d779552205efd';
const PAYEE = '0x4165cb72De51A67aac32DC33197d779552205efD';
const TX = `0x${'ab'.repeat(32)}`;
const POSIX = process.platform !== 'win32';
const RAILS = ['pay', 'x402', 'cdp', 'agentkit', 'awal', 'mcp', 'python'];
const KEYS = ['seq', 'at', 'kind', 'payment', 'wallet', 'amount', 'until', 'outcome', 'rail', 'to', 'note', 'evidence', 'remaining'];
const MOMENT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

const cli = (path, ...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, WALLETCAP_PATH: path }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const fresh = name => {
  const path = join(DIR, name);
  assert.equal(cli(path, 'set', '--wallet', WALLET, '--per-day', '150', '--per-payment', '50').code, 0);
  return path;
};
const sql = (path, statement) => {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(statement).all();
  } finally {
    db.close();
  }
};

// walletcap watch, running: the lines it has printed so far, and how it ended.
const watching = (path, ...args) => {
  const child = spawn(process.execPath, [CLI, 'watch', ...args], { env: { ...process.env, WALLETCAP_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let closed = false;
  const waiting = new Set();
  const printed = () => out.split('\n').slice(0, -1);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    out += chunk;
    for (const check of waiting) check();
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    err += chunk;
  });
  const done = new Promise(resolve => {
    child.on('close', code => {
      closed = true;
      for (const check of waiting) check();
      resolve({ code, out, err });
    });
  });
  return {
    child,
    done,
    // Its first `count` lines, once it has printed them.
    lines: count =>
      new Promise((resolve, reject) => {
        const fail = why => reject(new Error(`watch ${why} with ${printed().length} of ${count} lines:\n${out}${err}`));
        const timer = setTimeout(() => fail('was still running after 20 s'), 20_000);
        const check = () => {
          if (printed().length < count && !closed) return;
          clearTimeout(timer);
          waiting.delete(check);
          if (printed().length >= count) resolve(printed().slice(0, count));
          else fail('ended');
        };
        waiting.add(check);
        check();
      }),
    // An interrupt ends it at once; Windows has none to send, so there it runs out its --for.
    stop: () => {
      if (POSIX) child.kill('SIGINT');
      return done;
    },
  };
};

const isControl = character => {
  const code = character.codePointAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e);
};

test('watch --json prints one line an entry as the ledger takes it, with what the budget has left', async () => {
  const path = fresh('live.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  // --since reaches back for a payment made before the watch: its lines say the watcher is reading.
  await (await budget.hold('$1', { id: 'before-1' })).settle({ tx: TX });
  const watcher = watching(path, '--json', '--since', '1h', '--for', '10s');
  await watcher.lines(2);

  const paid = await budget.hold('$5', { id: 'order-17', to: PAYEE, note: 'weather API', settlesWithin: 300_000 });
  await paid.settle({ tx: TX });
  await watcher.lines(4);
  // A hold whose payee is under payTo, as x402 names it, and whose note is no string.
  const lost = await budget.hold('$7', { id: 'lost-1', rail: 'x402', details: { payTo: PAYEE, note: 7 } });
  await lost.settlesWithin(60_000);
  await lost.note('unknown', 'rpc timeout');
  await watcher.lines(7);
  await lost.void({ evidence: 'never broadcast' });
  // A refusal is no entry: the ledger took nothing, so watch prints nothing.
  await assert.rejects(
    budget.pay('$60', async () => TX),
    { code: 'per_payment' },
  );
  await watcher.lines(8);
  budget.close();

  const { code, out, err } = await watcher.stop();
  assert.equal(code, 0, err);
  assert.equal(err, '');
  const lines = out.split('\n').slice(0, -1);
  assert.equal(lines.length, 8, 'a line an entry, and no line of its own');
  const entries = lines.map(line => JSON.parse(line));
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(Object.keys(entry), KEYS);
    assert.equal(JSON.stringify(entry), lines[index], 'one object, on one line');
    for (const [key, value] of Object.entries(entry)) assert.ok(value === null || typeof value === 'string', `${key} is a string or null`);
    assert.equal(entry.seq, String(index + 1));
    assert.match(entry.at, MOMENT);
    assert.equal(entry.wallet, WALLET);
  }
  assert.deepEqual(
    entries.map(entry => [entry.kind, entry.payment, entry.amount, entry.outcome, entry.rail, entry.to, entry.note, entry.evidence, entry.remaining]),
    [
      ['held', 'before-1', '1000000', null, 'js', null, null, null, '149000000'],
      ['settled', 'before-1', '1000000', null, 'js', null, null, TX, '149000000'],
      ['held', 'order-17', '5000000', null, 'js', PAYEE, 'weather API', null, '144000000'],
      ['settled', 'order-17', '5000000', null, 'js', PAYEE, 'weather API', TX, '144000000'],
      ['held', 'lost-1', '7000000', null, 'x402', PAYEE, null, null, '137000000'],
      ['bound', 'lost-1', '7000000', null, 'x402', PAYEE, null, null, '137000000'],
      ['noted', 'lost-1', '7000000', 'unknown', 'x402', PAYEE, null, 'rpc timeout', '137000000'],
      ['void', 'lost-1', '7000000', null, 'x402', PAYEE, null, 'never broadcast', '144000000'],
    ],
  );
  // A hold's settle-by time, and the one a bound gives it; no other entry has one.
  assert.deepEqual(
    entries.map(entry => (entry.until === null ? null : Date.parse(entry.until) - Date.parse(entry.at))),
    [null, null, 300_000, null, null, 60_000, null, null],
  );
  assert.match(entries[2].until, MOMENT);
});

test('watch prints a line of text an entry, from the end of the ledger, with control characters filtered', async () => {
  const path = fresh('text.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  await (await budget.hold('$1', { id: 'before-1' })).settle({ tx: TX });
  const watcher = watching(path, '--for', '10s');
  assert.deepEqual(await watcher.lines(3), [`Watching ${path}`, cli(path, 'status').out.split('\n')[2], '']);

  const paid = await budget.hold('$5', { id: 'order-17', to: PAYEE, note: 'weather API', settlesWithin: 300_000 });
  await paid.settle({ tx: TX });
  await watcher.lines(5);
  // What a payee or a payer wrote can carry what a terminal acts on: an escape sequence, a line
  // break, a bell, a bidi override.
  const evil = await budget.hold('$7', { id: 'evil-1', rail: 'x402', to: 'pay\u202eee', note: 'clear\u001b[2J\nscreen' });
  await evil.note('refused', 'said no\r\n\u0007');
  await watcher.lines(7);
  await evil.void({ evidence: 'never\u009bsent' });
  await watcher.lines(8);
  budget.close();

  const { code, out, err } = await watcher.stop();
  assert.equal(code, 0, err);
  assert.equal(err, '');
  const lines = out.split('\n').slice(3, -1);
  assert.equal(lines.length, 5, 'a line an entry, and none for the payment made before the watch');
  assert.ok(![...lines.join('')].some(isControl), 'no control character reaches the terminal');
  for (const line of lines) assert.match(line, /^\d\d:\d\d:\d\dZ {2}/, 'the time of day, UTC');
  assert.match(
    lines[0].slice(11),
    /^held {10}\$5\.00 {2}js {6}to 0x4165…5efd {2}weather API {2}settles by \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ {2}order-17 {2}\(\$144\.00 left\)$/,
  );
  assert.deepEqual(
    lines.slice(1).map(line => line.slice(11)),
    [
      `settled       $5.00  js      to 0x4165…5efd  weather API  tx ${TX}  order-17  ($144.00 left)`,
      'held          $7.00  x402    to pay\ufffdee  clear\ufffd[2J\ufffdscreen  evil-1  ($137.00 left)',
      'noted         $7.00  x402    to pay\ufffdee  clear\ufffd[2J\ufffdscreen  refused: said no\ufffd\ufffd\ufffd  evil-1  ($137.00 left)',
      'void          $7.00  x402    to pay\ufffdee  clear\ufffd[2J\ufffdscreen  never\ufffdsent  evil-1  ($144.00 left)',
    ],
  );
});

test('watch --since first prints the entries of that long ago, for every wallet in the file or for one', async () => {
  const path = fresh('since.sqlite');
  assert.equal(cli(path, 'set', '--wallet', OTHER, '--per-day', '20').code, 0);
  const budget = await openBudget({ wallet: WALLET, path });
  const other = await openBudget({ wallet: OTHER, path });
  setClock(() => Date.now() - 2 * 3_600_000); // this payment was made two hours ago
  await (await budget.hold('$4', { id: 'old-1' })).settle({ tx: TX });
  resetClock();
  await budget.hold('$5', { id: 'new-1' });
  await other.hold('$2', { id: 'new-2', settlesWithin: 300_000 });
  budget.close();
  other.close();

  const entries = (...args) => {
    const result = cli(path, 'watch', '--json', '--for', '200ms', ...args);
    assert.equal(result.code, 0, result.err);
    return result.out
      .split('\n')
      .slice(0, -1)
      .map(line => JSON.parse(line))
      .map(entry => `${entry.kind} ${entry.payment} ${entry.remaining}`);
  };
  assert.deepEqual(entries(), [], 'without --since, only what the ledger takes from now on');
  assert.deepEqual(entries('--since', '1h'), ['held new-1 141000000', 'held new-2 18000000']);
  assert.deepEqual(entries('--since', '3h'), ['held old-1 141000000', 'settled old-1 141000000', 'held new-1 141000000', 'held new-2 18000000']);
  assert.deepEqual(entries('--since', '3h', '--wallet', OTHER), ['held new-2 18000000']);
  assert.deepEqual(entries('--since', '3h', '--wallet', `eip155:8453:${PAYEE}`), ['held new-2 18000000'], 'the wallet under any name normalizeWallet reads');

  // With two budgets watched, each has its line at the top and its name on its entries.
  const every = cli(path, 'watch', '--since', '1h', '--for', '200ms').out.split('\n');
  assert.deepEqual(every.slice(0, 4), [`Watching ${path}`, ...cli(path, 'status').out.split('\n').slice(2, 4), '']);
  assert.match(every[1], /^0x4165…5efd: /);
  assert.equal(every[4].slice(11), 'held          $5.00  0xd797…ca02  js      new-1  ($141.00 left)');
  assert.match(every[5].slice(11), /^held {10}\$2\.00 {2}0x4165…5efd {2}js {6}settles by \S+ {2}new-2 {2}\(\$18\.00 left\)$/);
  assert.deepEqual(every.slice(6), ['']);
  const one = cli(path, 'watch', '--since', '1h', '--for', '200ms', '--wallet', WALLET).out.split('\n');
  assert.deepEqual(
    one.map(line => line.replace(/^\d\d:\d\d:\d\dZ {2}/, '')),
    [`Watching ${path}`, every[2], '', 'held          $5.00  js      new-1  ($141.00 left)', ''],
  );
});

test('watch prints a time past the year 9999, and half a surrogate pair, as the Python command line does', async () => {
  const path = fresh('odd.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  // The ledger keeps times Python's datetime can't hold, and a note cut through an emoji is no UTF-8.
  await budget.hold('$1', { id: 'odd-1', note: 'cut \ud83d here', settlesBy: 10n ** 15n });
  budget.close();
  const json = cli(path, 'watch', '--since', '1h', '--for', '200ms', '--json');
  assert.equal(json.code, 0, json.err);
  assert.match(json.out, /"until":"9999-12-31T23:59:59\.999Z",.*"note":"cut \\ud83d here"/);
  assert.equal(JSON.parse(json.out).note, 'cut \ud83d here');
  const text = cli(path, 'watch', '--since', '1h', '--for', '200ms');
  assert.equal(text.code, 0, text.err);
  assert.equal(text.out.split('\n')[3].slice(11), 'held          $1.00  js      cut \ufffd here  settles by 9999-12-31T23:59:59Z  odd-1  ($149.00 left)');
});

test('watch exits 1 for a missing file, an older file, a file that is no budget and a wallet with no budget', async () => {
  const missing = join(DIR, 'nowhere', 'budget.sqlite');
  const none = cli(missing, 'watch', '--for', '1s');
  assert.equal(none.code, 1);
  assert.equal(none.out, '');
  assert.equal(none.err, `no budget file at ${missing}: its owner creates one with walletcap set --wallet <address> --per-day <dollars>\n`);
  assert.equal(existsSync(dirname(missing)), false, 'watch never creates the file, or its folder');

  // An older file needs an upgrade, which is a write: watch says how, and leaves the file as it is.
  const old = join(DIR, 'schema-2.sqlite');
  copyFileSync(new URL('fixtures/schema-2.sqlite', SPEC), old);
  const before = readFileSync(old);
  for (const mode of [[], ['--json']]) {
    const older = cli(old, 'watch', '--since', '1h', '--for', '1s', ...mode);
    assert.equal(older.code, 1);
    assert.equal(older.out, '');
    assert.match(
      older.err,
      /is at schema 2, which an older walletcap wrote, and watch only reads\. .*open the file once with this version to upgrade it \(walletcap status\)/,
    );
  }
  assert.deepEqual(readFileSync(old), before, 'the file is byte for byte what it was');
  assert.deepEqual(readFileSync(new URL('fixtures/schema-2.sqlite', SPEC)), before, 'and so is the fixture it was copied from');
  assert.deepEqual(
    sql(old, "SELECT value FROM budget_meta WHERE key = 'schema'").map(row => row.value),
    ['2'],
  );

  const stranger = join(DIR, 'stranger.sqlite');
  sql(stranger, 'CREATE TABLE notes (body TEXT)');
  const not = cli(stranger, 'watch', '--for', '1s');
  assert.equal(not.code, 1);
  assert.match(not.err, /is a SQLite file, not a walletcap budget/);
  const empty = join(DIR, 'empty.sqlite');
  writeFileSync(empty, '');
  const nothing = cli(empty, 'watch', '--for', '1s');
  assert.equal(nothing.code, 1);
  assert.equal(nothing.err, `${empty} is empty: walletcap set --wallet <address> --per-day <dollars> creates the budget\n`);
  assert.equal(statSync(empty).size, 0);
  const bare = join(DIR, 'bare.sqlite');
  (await openOwner({ path: bare, create: true })).close();
  const unset = cli(bare, 'watch', '--for', '1s');
  assert.equal(unset.code, 1);
  assert.equal(unset.err, `no budget in ${bare} yet: walletcap set --wallet <address> --per-day <dollars>\n`);
  sql(bare, "UPDATE budget_meta SET value = '4' WHERE key = 'schema'");
  const newer = cli(bare, 'watch', '--for', '1s');
  assert.equal(newer.code, 1);
  assert.equal(newer.err, `${bare} is at schema 4, which a newer walletcap wrote; this one reads 3\n`);

  const path = fresh('one-wallet.sqlite');
  const absent = cli(path, 'watch', '--wallet', OTHER, '--for', '1s');
  assert.equal(absent.code, 1);
  assert.equal(absent.out, '');
  assert.match(absent.err, /^0x4165…5efd has no budget in .*: its owner creates one with walletcap set --wallet 0x4165cb72de51a67aac32dc33197d779552205efd /);

  const when = cli(path, 'watch', '--since', 'soon');
  assert.equal(when.code, 1);
  assert.match(when.err, /^--since must be a duration like "24h"/);
  const long = cli(path, 'watch', '--for', '0s');
  assert.equal(long.code, 1);
  assert.match(long.err, /^--for must be a duration like "24h"/);
  assert.equal(cli(path, 'watch', '--until', '3s').code, 2, 'an option watch does not have');
});

test('watch writes nothing to the budget file', async () => {
  const path = fresh('quiet.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  await budget.pay('$6', async () => TX);
  await budget.hold('$3');
  budget.close();
  const before = readFileSync(path);
  const versions = sql(path, 'SELECT count(*) AS versions FROM wc_budget_log');
  assert.equal(cli(path, 'watch', '--since', '1h', '--for', '200ms').out.split('\n').length, 7);
  assert.equal(cli(path, 'watch', '--json', '--for', '700ms').out, '');
  assert.deepEqual(readFileSync(path), before, 'the file is byte for byte what it was');
  // SQLite keeps its own write-ahead log beside a file a reader has open: it holds nothing.
  assert.equal(statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0, 0);
  assert.deepEqual(sql(path, 'SELECT count(*) AS versions FROM wc_budget_log'), versions);
});

test('watch ends with exit 0 when interrupted or when its reader goes away, and with exit 1 when the file does', { skip: !POSIX }, async () => {
  const path = fresh('ends.sqlite');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const watcher = watching(path);
    await watcher.lines(3);
    watcher.child.kill(signal);
    assert.deepEqual(await watcher.done, { code: 0, out: `Watching ${path}\n${cli(path, 'status').out.split('\n')[2]}\n\n`, err: '' }, signal);
  }

  // walletcap watch | head: the pipe closes, and the next line has nowhere to go.
  const budget = await openBudget({ wallet: WALLET, path });
  await budget.hold('$1', { id: 'first-1' });
  const piped = watching(path, '--json', '--since', '1h', '--for', '10s');
  await piped.lines(1);
  piped.child.stdout.destroy();
  await budget.hold('$1', { id: 'second-1' });
  assert.deepEqual(await piped.done.then(({ code, err }) => ({ code, err })), { code: 0, err: '' });
  budget.close();

  // The path names another file, then none: the watcher's connection still has the first.
  const replaced = watching(path, '--for', '10s');
  await replaced.lines(3);
  renameSync(fresh('replacement.sqlite'), path);
  const other = await replaced.done;
  assert.equal(other.code, 1);
  assert.equal(other.err, `the budget file ${path} was replaced while walletcap watched it: run walletcap watch again to watch the file now there\n`);
  const removed = watching(path, '--for', '10s');
  await removed.lines(3);
  unlinkSync(path);
  const gone = await removed.done;
  assert.equal(gone.code, 1);
  assert.equal(gone.err, `the budget file ${path} was removed while walletcap watched it\n`);
});

test('init on a fresh machine creates the file and the budget, checks them, and prints the code with the address in it', () => {
  const path = join(DIR, 'fresh', 'state', 'walletcap', 'budget.sqlite');
  const created = cli(path, 'init', '--wallet', '0xd797ead28C38575FDf4fC523866287372340Ca02', '--per-day', '150', '--per-payment', '50');
  assert.equal(created.code, 0, created.err);
  assert.equal(
    created.out,
    [
      '0xd797…ca02: $0.00 spent of $150.00 per 24h, $150.00 left · at most $50.00 a payment',
      'Everything checks out.',
      '',
      'Next:',
      '// npm install walletcap',
      "import { openBudget } from 'walletcap';",
      '',
      `const budget = await openBudget({ wallet: '${WALLET}' });`,
      '',
      "await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));",
      '',
    ].join('\n'),
  );
  if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600, 'as set creates it');

  // --json: what set --json prints, what doctor --json prints, and the snippet.
  const again = JSON.parse(cli(path, 'init', '--wallet', WALLET, '--per-day', '150', '--json').out);
  assert.deepEqual(Object.keys(again), ['status', 'doctor', 'rail', 'snippet']);
  assert.deepEqual(again.status, JSON.parse(cli(path, 'set', '--per-day', '150', '--json').out));
  assert.deepEqual(again.doctor, JSON.parse(cli(path, 'doctor', '--wallet', WALLET, '--json').out));
  assert.equal(again.rail, 'pay');
  assert.equal(again.snippet, created.out.split('Next:\n')[1].trimEnd());

  // A budget outside the default file: the snippet's code would look in the default one.
  const elsewhere = spawnSync(process.execPath, [CLI, 'init', '--path', path], {
    env: { ...process.env, WALLETCAP_PATH: join(DIR, 'default.sqlite') },
    encoding: 'utf8',
  });
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.ok(elsewhere.stdout.endsWith(`\n\nThe budget is in ${path}, not the default file: set WALLETCAP_PATH to it where the agent runs.\n`));
});

test('init prints the code for every rail, and refuses a rail it does not know before it creates anything', () => {
  const path = fresh('rails.sqlite');
  const code = {
    pay: `const budget = await openBudget({ wallet: '${WALLET}' });\n\nawait budget.pay('$12.50', () => sendUsdc(payee, '12.50'));`,
    x402: `const budget = await openBudget({ wallet: '${WALLET}' });\nconst client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);`,
    cdp: `const budget = await openBudget({ wallet: '${WALLET}' });\n\napplySpendControls(client, {`,
    agentkit: `const budget = await openBudget({ wallet: '${WALLET}' });\nconst x402 = guardAgentKit(new X402ActionProvider(), budget);`,
    awal: `which must be ${WALLET}\nnpx walletcap awal x402 pay https://api.example.com/data `,
    mcp: `{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap-mcp", "--wallet", "${WALLET}"] } } }`,
    python: `budget = open_budget("${WALLET}")\n\nwith budget.pay("$12.50") as payment:`,
  };
  const install = {
    pay: '// npm install walletcap\n',
    x402: '// npm install walletcap @x402/core @x402/evm @x402/fetch\n',
    cdp: '// npm install walletcap @coinbase/cdp-sdk\n',
    agentkit: '// npm install walletcap @coinbase/agentkit\n',
    awal: '# npm install walletcap awal\n',
    mcp: '# npx @coinbase/payments-mcp install --client other --no-auto-config\n',
    python: '# pip install walletcap\n',
  };
  assert.deepEqual(Object.keys(code), RAILS);
  for (const rail of RAILS) {
    const printed = cli(path, 'init', '--rail', rail);
    assert.equal(printed.code, 0, printed.err);
    const [, snippet] = printed.out.split('\n\nNext:\n');
    assert.ok(snippet.startsWith(install[rail]), `${rail}: the install line comes first, as a comment`);
    assert.ok(snippet.includes(code[rail]), `${rail}:\n${snippet}`);
    assert.ok(!snippet.includes('<wallet>'), rail);
    const answer = JSON.parse(cli(path, 'init', '--rail', rail, '--json').out);
    assert.equal(answer.rail, rail);
    assert.equal(`${answer.snippet}\n`, snippet);
  }
  assert.ok(cli(path, 'init', '--rail', 'cdp').out.includes('store: cdpStore(budget, { asset: USDC }),'));
  assert.ok(cli(path, 'init', '--rail', 'awal').out.includes('npx walletcap awal send 0.05 0xRecipient --chain base'));

  const missing = join(DIR, 'no-rail', 'budget.sqlite');
  const unknown = cli(missing, 'init', '--wallet', WALLET, '--per-day', '150', '--rail', 'stripe');
  assert.equal(unknown.code, 2);
  assert.equal(unknown.out, '');
  assert.equal(unknown.err, `unknown rail stripe: init prints the code for one of ${RAILS.join(', ')}\n`);
  assert.equal(existsSync(dirname(missing)), false, 'nothing was created');
});

test('init leaves a budget as it was when no limit is named, and changes one as set does', async () => {
  const path = fresh('existing.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  await budget.pay('$40', async () => TX);
  const status = cli(path, 'status', '--wallet', WALLET, '--json').out;
  const versions = sql(path, 'SELECT count(*) AS versions FROM wc_budget_log');
  // The file holds one budget, so its wallet needn't be named.
  const kept = cli(path, 'init');
  assert.equal(kept.code, 0, kept.err);
  assert.match(kept.out, /^0xd797…ca02: \$40\.00 spent of \$150\.00 per 24h, \$110\.00 left · at most \$50\.00 a payment\nEverything checks out\.\n\nNext:\n/);
  assert.equal(cli(path, 'status', '--wallet', WALLET, '--json').out, status);
  assert.deepEqual(sql(path, 'SELECT count(*) AS versions FROM wc_budget_log'), versions, 'the budget was not written again');

  // What doctor warns about is printed as doctor prints it, and is no failure.
  await budget.hold('$5'); // no settle-by time
  budget.close();
  const warned = cli(path, 'init');
  assert.equal(warned.code, 0);
  assert.match(
    warned.out,
    /in flight · at most \$50\.00 a payment\n {2}warn {2}open_holds {2}0xd797…ca02 has 1 held payment with no settle-by time: .*\n1 warning\.\n\nNext:\n/,
  );

  // A limit changes the budget as set does: what was spent keeps counting.
  const raised = cli(path, 'init', '--per-day', '200', '--per-payment', 'none');
  assert.equal(raised.code, 0, raised.err);
  assert.match(raised.out, /^0xd797…ca02: \$40\.00 spent of \$200\.00 per 24h, \$155\.00 left · \$5\.00 in flight\n/);

  // A wallet with no budget needs a rolling limit, and a file with two budgets a wallet.
  const third = '0x1111111111111111111111111111111111111111';
  const bare = cli(path, 'init', '--wallet', third);
  assert.equal(bare.code, 2);
  assert.equal(bare.err, '0x1111…1111 has no budget yet: init needs a rolling limit to create it, like --per-day 150\n');
  const partial = cli(path, 'init', '--wallet', third, '--per-payment', '5');
  assert.equal(partial.code, 1, 'as set refuses it');
  assert.match(partial.err, /has no budget yet: give it a rolling limit too/);
  assert.equal(cli(path, 'init', '--wallet', third, '--cap', '20', '--window', '7d', '--max-payments', '3').code, 0);
  const which = cli(path, 'init');
  assert.equal(which.code, 2);
  assert.equal(which.err, 'init needs --wallet <address>\n');

  const missing = join(DIR, 'no-limit', 'budget.sqlite');
  assert.equal(cli(missing, 'init', '--wallet', WALLET).code, 2);
  assert.equal(cli(missing, 'init').code, 2);
  assert.equal(existsSync(dirname(missing)), false, 'init with no limit creates nothing');
});

test('init exits 1 on a file whose guard trigger was dropped, and still prints everything', () => {
  const path = fresh('tampered.sqlite');
  sql(path, 'DROP TRIGGER wc_entry_admitted');
  const result = cli(path, 'init', '--rail', 'python');
  assert.equal(result.code, 1);
  assert.match(
    result.out,
    /^0xd797…ca02: \$0\.00 spent of \$150\.00 per 24h, \$150\.00 left · at most \$50\.00 a payment\n {2}FAIL {2}rules {2}the file's rule differs from the one walletcap ships: wc_entry_admitted is missing or changed\. .*\n1 problem\.\n\nNext:\n# pip install walletcap\n/,
  );
  assert.ok(result.out.includes(`budget = open_budget("${WALLET}")`));
  const answer = cli(path, 'init', '--json');
  assert.equal(answer.code, 1);
  const report = JSON.parse(answer.out);
  assert.equal(report.doctor.ok, false);
  assert.equal(report.status.cap, '150000000');
  assert.ok(report.snippet.includes(WALLET));
});
