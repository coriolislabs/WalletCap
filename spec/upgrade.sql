-- SPDX-License-Identifier: Apache-2.0
-- Upgrading a budget file that walletcap 0.2 (schema 1) or 0.3 (schema 2) wrote to schema 3.
-- Both packages run it the same way, in one write transaction, so a crash at any point leaves
-- the file as it was, and two processes that open it at once upgrade it once:
--
--   BEGIN IMMEDIATE; read budget_meta's schema again (another process may have upgraded it)
--   @section rename          here
--   schema.sql's tables, then its projection
--   @section names           here, for a schema 1 file only
--   @section migrate         here
--   schema.sql's guards; budget_meta's schema = '3'; COMMIT
--
-- Every payment that counts in the old file counts in the new one at least as long: ledger.md
-- (Upgrades) gives the mapping. The JSON functions are needed here and nowhere else.

-- @section rename
ALTER TABLE spend RENAME TO legacy_spend;
ALTER TABLE budgets RENAME TO legacy_budgets;
ALTER TABLE budget_meta RENAME TO legacy_meta;

-- @section names
-- What 0.3.0 did to a schema 1 file. 0.2 kept a budget under whatever name it was given, so a
-- checksummed or CAIP-10 address could hold a budget beside the lowercase one. Each moves to the
-- wallet's canonical name: a bare or CAIP-10 EVM address lowercased, a Solana CAIP-10 reduced to
-- its address. One already there takes it in with the tighter of every limit and every payment.
-- One in another unit can't merge: it stays where it is, and the wallet is frozen until its owner
-- has looked. The upgrade notes both, so refusals and warnings can say what happened.
CREATE TEMP TABLE wc_up AS
WITH parts AS (
  SELECT instrument AS name, unit, cap, window_ms, per_payment, max_uses, revoked_at_ms,
         substr(instrument, 8) AS rest, substr(instrument, -42) AS tail
  FROM legacy_budgets
)
SELECT name, unit, cap, window_ms, per_payment, max_uses, revoked_at_ms,
  CASE
    WHEN name GLOB 'solana:*' AND instr(rest, ':') > 1
         AND substr(rest, 1, instr(rest, ':') - 1) NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
         AND length(substr(rest, instr(rest, ':') + 1)) BETWEEN 32 AND 44
         AND substr(rest, instr(rest, ':') + 1) NOT GLOB '*[^1-9A-HJ-NP-Za-km-z]*'
      THEN substr(rest, instr(rest, ':') + 1)
    WHEN length(name) = 42 AND name GLOB '0x*' AND substr(name, 3) NOT GLOB '*[^0-9a-fA-F]*'
      THEN lower(name)
    WHEN name GLOB 'eip155:*' AND length(name) >= 51
         AND substr(name, 8, length(name) - 50) NOT GLOB '*[^0-9]*'
         AND substr(name, -43, 1) = ':'
         AND tail GLOB '0x*' AND substr(tail, 3) NOT GLOB '*[^0-9a-fA-F]*'
      THEN lower(tail)
    ELSE name
  END AS canon
FROM parts;

-- Per canonical name that another spelling maps to: whether a budget was already there, the
-- first other spelling (0.3.0 moved that one there when none was), and the unit kept.
CREATE TEMP TABLE wc_up_kept AS
SELECT g.canon,
       EXISTS (SELECT 1 FROM wc_up k WHERE k.name = g.canon) AS existed,
       (SELECT min(k.name) FROM wc_up k WHERE k.canon = g.canon AND k.name <> g.canon) AS first,
       coalesce((SELECT k.unit FROM wc_up k WHERE k.name = g.canon),
                (SELECT k.unit FROM wc_up k WHERE k.canon = g.canon AND k.name <> g.canon
                  ORDER BY k.name LIMIT 1)) AS unit
FROM (SELECT DISTINCT canon FROM wc_up WHERE canon <> name) g;

CREATE TEMP TABLE wc_up_moved AS
SELECT u.* FROM wc_up u JOIN wc_up_kept k ON k.canon = u.canon
WHERE u.name <> u.canon AND (u.unit = k.unit OR (u.unit IN ('usd', 'usdc') AND k.unit IN ('usd', 'usdc')));

CREATE TEMP TABLE wc_up_aside AS
SELECT u.* FROM wc_up u JOIN wc_up_kept k ON k.canon = u.canon
WHERE u.name <> u.canon AND NOT (u.unit = k.unit OR (u.unit IN ('usd', 'usdc') AND k.unit IN ('usd', 'usdc')));

-- The tighter of every limit: the smallest cap, per-payment limit and count, the longest window
-- (a longer window with a smaller cap is tighter than either), and the earliest freeze.
INSERT INTO legacy_budgets (instrument, unit, cap, window_ms, per_payment, max_uses, revoked_at_ms)
SELECT k.canon, k.unit, min(u.cap), max(u.window_ms), min(u.per_payment), min(u.max_uses),
  CASE WHEN EXISTS (SELECT 1 FROM wc_up_aside a WHERE a.canon = k.canon)
       THEN coalesce(min(u.revoked_at_ms), (SELECT now FROM wc_clock))
       ELSE min(u.revoked_at_ms) END
FROM wc_up_kept k JOIN wc_up u ON u.canon = k.canon
 AND (u.name = k.canon OR u.name IN (SELECT name FROM wc_up_moved))
WHERE true
GROUP BY k.canon
ON CONFLICT (instrument) DO UPDATE SET
  unit = excluded.unit, cap = excluded.cap, window_ms = excluded.window_ms,
  per_payment = excluded.per_payment, max_uses = excluded.max_uses, revoked_at_ms = excluded.revoked_at_ms;

UPDATE legacy_spend SET instrument = (SELECT m.canon FROM wc_up_moved m WHERE m.name = legacy_spend.instrument)
WHERE instrument IN (SELECT name FROM wc_up_moved);

DELETE FROM legacy_budgets WHERE instrument IN (SELECT name FROM wc_up_moved);

-- 0.3.0's notes: a spelling moved where no budget was is not a merge.
INSERT OR REPLACE INTO legacy_meta (key, value)
SELECT 'merged ' || m.canon, json_group_array(m.name)
FROM (SELECT m.canon, m.name FROM wc_up_moved m JOIN wc_up_kept k ON k.canon = m.canon
      WHERE k.existed OR m.name <> k.first ORDER BY m.canon, m.name) m
GROUP BY m.canon;

INSERT OR REPLACE INTO legacy_meta (key, value)
SELECT 'unmerged ' || a.canon,
       json_object('kept', k.unit, 'aside', json_group_array(json_object('name', a.name, 'unit', a.unit)))
FROM (SELECT * FROM wc_up_aside ORDER BY canon, name) a JOIN wc_up_kept k ON k.canon = a.canon
GROUP BY a.canon;

DROP TABLE temp.wc_up_aside;
DROP TABLE temp.wc_up_moved;
DROP TABLE temp.wc_up_kept;
DROP TABLE temp.wc_up;

-- @section migrate
-- Schema 2 into schema 3. Limits past what schema 3 holds (0.2 took amounts up to 2^63 - 1) are
-- cut to it: a cap or a payment of a billion dollars fills any budget either way.
INSERT INTO wc_budget (wallet, unit, cap, window_ms, per_payment, max_payments, frozen_at, merged_from, frozen_by)
SELECT b.instrument, b.unit, min(max(b.cap, 0), 1000000000000000), min(max(b.window_ms, 1), 1000000000000000),
       min(max(b.per_payment, 1), 1000000000000000), max(b.max_uses, 0), b.revoked_at_ms,
       (SELECT value FROM legacy_meta WHERE key = 'merged ' || b.instrument),
       (SELECT value FROM legacy_meta WHERE key = 'unmerged ' || b.instrument)
FROM legacy_budgets b
ORDER BY b.instrument;

-- Every payment, in the order it was written. A reservation is held. Its expiry was its settle-by
-- time plus one window plus a millisecond, so until is that time back. A committed payment was
-- held and settled at its at_ms, which 0.3 moved to the commit.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, until, rail, info)
SELECT s.spend_id, 'held', s.at_ms, s.instrument, min(max(s.amount, 1), 1000000000000000),
       CASE WHEN s.expires_at_ms IS NOT NULL
            THEN min(max(s.expires_at_ms - b.window_ms - 1, 0), 1000000000000000) END,
       substr(s.rail, 1, 64),
       CASE WHEN length(s.reference) <= 4096 THEN s.reference END
FROM legacy_spend s JOIN wc_budget b ON b.wallet = s.instrument
ORDER BY s.rowid;

INSERT INTO wc_entry (payment, kind, at, wallet, amount, outcome, evidence)
SELECT s.spend_id, 'noted', s.at_ms, s.instrument, min(max(s.amount, 1), 1000000000000000),
       CASE WHEN json_valid(s.reference) THEN json_extract(s.reference, '$.outcome') END,
       substr(CASE WHEN json_valid(s.reference) THEN json_extract(s.reference, '$.error') END, 1, 1024)
FROM legacy_spend s
WHERE s.status = 'reserved'
  AND (CASE WHEN json_valid(s.reference) THEN json_extract(s.reference, '$.outcome') END) IN ('unknown', 'refused')
ORDER BY s.rowid;

INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT s.spend_id, 'settled', s.at_ms, s.instrument, min(max(s.amount, 1), 1000000000000000),
       substr(CASE WHEN json_valid(s.reference) THEN json_extract(s.reference, '$.tx') END, 1, 1024)
FROM legacy_spend s
WHERE s.status = 'committed'
ORDER BY s.rowid;

DROP TABLE legacy_spend;
DROP TABLE legacy_budgets;
DROP TABLE legacy_meta;
