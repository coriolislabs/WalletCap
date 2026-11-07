// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { budgetPathFor, formatUsd, formatWindow, normalizeWallet, parseLimits, toMicros, toWindowMs } from '../dist/core/money.js';

// The cases the Python suite checks too (tests/test_money.py).
const VECTORS = JSON.parse(readFileSync(new URL('../../../spec/vectors/money.json', import.meta.url), 'utf8'));

test('dollars convert as the shared vectors say, the same as in Python', async () => {
  assert.ok(VECTORS.cases.length > 50);
  for (const { input, micros, error } of VECTORS.cases) {
    const shown = JSON.stringify(input);
    if (error) assert.throws(() => toMicros(input), { name: 'UsageError' }, shown);
    else assert.equal(toMicros(input), BigInt(micros), shown);
  }
});

test('trimming takes linear time: a long run of spaces inside an amount is refused at once', async () => {
  // A regex like /[ \t]+$/ backtracks quadratically here: about 20 s for these 200,000 spaces.
  const text = `1${' '.repeat(200_000)}x`;
  const started = performance.now();
  for (const parse of [toMicros, toWindowMs, normalizeWallet]) assert.throws(() => parse(text), { name: 'UsageError' });
  assert.ok(performance.now() - started < 1_000, `took ${performance.now() - started} ms`);
});

test('windows, wallet names and counts read only ASCII digits and trim only ASCII whitespace', async () => {
  assert.equal(toWindowMs(' 24h\t'), 86_400_000n);
  assert.equal(normalizeWallet(' 0xd797ead28c38575fdf4fc523866287372340ca02\n'), '0xd797ead28c38575fdf4fc523866287372340ca02');
  assert.deepEqual(parseLimits({ maxPayments: ' 3 ' }), { maxPayments: 3n });
  for (const bad of ['\u0661\u0662h', '24h\u0085', '\u00a024h']) assert.throws(() => toWindowMs(bad), { name: 'UsageError' }, bad);
  for (const bad of ['0xd797ead28c38575fdf4fc523866287372340ca02\u0085', 'eip155:\u0661:0xd797ead28c38575fdf4fc523866287372340ca02']) {
    assert.throws(() => normalizeWallet(bad), { name: 'UsageError' }, bad);
  }
  for (const bad of ['\u0661\u0662', '3\u0085']) assert.throws(() => parseLimits({ maxPayments: bad }), { name: 'UsageError' }, bad);
});

test('dollars read exactly from strings, rounded from numbers, as-is from bigints', async () => {
  assert.equal(toMicros('$12.50'), 12_500_000n);
  assert.equal(toMicros('12.50 USDC'), 12_500_000n);
  assert.equal(toMicros('$1,000'), 1_000_000_000n);
  assert.equal(toMicros('0.000001'), 1n);
  assert.equal(toMicros('5.1000000'), 5_100_000n);
  assert.equal(toMicros(0.1 + 0.2), 300_000n);
  assert.equal(toMicros(150), 150_000_000n);
  assert.equal(toMicros(150n), 150n);
  for (const bad of ['-5', '$', '1,5', '12.5 EUR', '0.0000001', '', NaN, -1, Infinity, '1e3', null, {}]) {
    assert.throws(() => toMicros(bad), { name: 'UsageError' }, String(bad));
  }
});

test('amounts and windows read back the way people write them', async () => {
  assert.equal(formatUsd(150_000_000n), '$150.00');
  assert.equal(formatUsd(50_000n), '$0.05');
  assert.equal(formatUsd(1n), '$0.000001');
  assert.equal(formatUsd(1_234_500_000n), '$1,234.50');
  assert.equal(toWindowMs('24h'), 86_400_000n);
  assert.equal(toWindowMs('7d'), 604_800_000n);
  assert.equal(toWindowMs('day'), 86_400_000n);
  assert.equal(toWindowMs(90_000), 90_000n);
  assert.equal(formatWindow(86_400_000n), '24h');
  assert.equal(formatWindow(604_800_000n), '7d');
  assert.equal(formatWindow(1_800_000n), '30m');
  assert.equal(formatWindow(1_500n), '1500ms');
  for (const bad of ['0h', '1y', -5, 0, 'soon']) assert.throws(() => toWindowMs(bad), { name: 'UsageError' });
});

test('one wallet is one budget, however its address is written', async () => {
  const lower = '0xd797ead28c38575fdf4fc523866287372340ca02';
  assert.equal(normalizeWallet('0xd797ead28C38575FDf4fC523866287372340Ca02'), lower);
  assert.equal(normalizeWallet(`eip155:8453:${lower.toUpperCase().replace('0X', '0x')}`), lower);
  assert.equal(normalizeWallet(' card-visa-4242 '), 'card-visa-4242');
  // A truncated address must not quietly open a second budget.
  assert.throws(() => normalizeWallet('0xd797ead28c38575fdf4fc523866287372340ca0'), /not 40 hex digits/);
  assert.throws(() => normalizeWallet('has space'), { name: 'UsageError' });
  assert.throws(() => normalizeWallet(''), { name: 'UsageError' });
});

test('mixed-case EVM addresses are checked against EIP-55, and Solana CAIP-10 is one wallet', async () => {
  const sol = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.equal(normalizeWallet(sol), sol);
  assert.equal(normalizeWallet(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${sol}`), sol);
  assert.throws(() => normalizeWallet('0xD797ead28C38575FDf4fC523866287372340Ca02'), /EIP-55/);
  assert.equal(toWindowMs(86_400_000), 86_400_000n);
});

test('one rolling limit at a time, and nothing left out silently', async () => {
  assert.deepEqual(parseLimits({ perDay: '$150', perPayment: '$50' }), { cap: 150_000_000n, windowMs: 86_400_000n, perPayment: 50_000_000n });
  assert.deepEqual(parseLimits({ cap: 10, window: '1h', maxPayments: 3 }), { cap: 10_000_000n, windowMs: 3_600_000n, maxPayments: 3n });
  assert.deepEqual(parseLimits({ perPayment: null }), { perPayment: null });
  assert.throws(() => parseLimits({ perDay: 1, perHour: 1 }), /one rolling limit/);
  assert.throws(() => parseLimits({ cap: 1 }), /go together/);
  assert.throws(() => parseLimits({ perPayment: 0 }), /freeze/);
});

test('the default file is per user and the same for every process', async () => {
  const home = '/home/agent';
  assert.equal(budgetPathFor({}, 'linux', home), '/home/agent/.local/state/walletcap/budget.sqlite');
  assert.equal(budgetPathFor({ XDG_STATE_HOME: '/var/state' }, 'linux', home), '/var/state/walletcap/budget.sqlite');
  assert.equal(budgetPathFor({ XDG_STATE_HOME: 'relative' }, 'linux', home), '/home/agent/.local/state/walletcap/budget.sqlite');
  assert.equal(budgetPathFor({}, 'darwin', home), '/home/agent/Library/Application Support/walletcap/budget.sqlite');
  assert.equal(budgetPathFor({ WALLETCAP_PATH: '~/b.sqlite' }, 'linux', home), '/home/agent/b.sqlite');
  assert.equal(budgetPathFor({ WALLETCAP_PATH: '/data/budget.sqlite' }, 'darwin', home), '/data/budget.sqlite');
});
