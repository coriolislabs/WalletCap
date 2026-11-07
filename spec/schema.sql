-- SPDX-License-Identifier: Apache-2.0
-- The walletcap ledger, schema 3: its tables, the counting rule, the admission rule, and the
-- statements the JavaScript and Python packages run, by name, as written here. ledger.md
-- explains the state machine and the invariant. Both packages ship this file.
--
-- SQLite 3.37.0 or later (STRICT tables). The 2-to-3 upgrade also needs the JSON functions.
-- Every time is the ledger's own clock (wc_clock), in milliseconds since the Unix epoch.
-- Nothing a client passes can set it.
--
-- The file has three sections and two kinds of named SQL, which the clients split on the
-- '-- @' lines:
--   @section tables       tables, indexes and views
--   @section projection   the triggers that keep wc_current, and so the counting rule
--   @section guards       the triggers that refuse writes outside the rules
--   @fragment <name>      SQL spliced into statements as {{name}}
--   @statement <name>     one statement, with :named parameters

-- @section tables

-- The file's format, under the table name every walletcap version has read: 0.2 and 0.3 refuse
-- a schema they don't know, so they refuse this file rather than count in tables they'd create.
CREATE TABLE budget_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- One budget per wallet, in the wallet's canonical name: its owner's limits.
CREATE TABLE wc_budget (
  wallet       TEXT    PRIMARY KEY CHECK (length(wallet) BETWEEN 1 AND 128),
  unit         TEXT    NOT NULL,
  cap          INTEGER NOT NULL CHECK (cap BETWEEN 0 AND 1000000000000000),
  window_ms    INTEGER NOT NULL CHECK (window_ms BETWEEN 1 AND 1000000000000000),
  per_payment  INTEGER CHECK (per_payment BETWEEN 1 AND 1000000000000000),
  max_payments INTEGER CHECK (max_payments >= 0),
  frozen_at    INTEGER,
  merged_from  TEXT,     -- JSON: the 0.2 names an upgrade merged into this budget
  frozen_by    TEXT      -- JSON: the 0.2 budgets in another unit that made an upgrade freeze it
) STRICT, WITHOUT ROWID;

-- Every version of every budget, appended by trigger: who could spend what, and when.
CREATE TABLE wc_budget_log (
  seq          INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  wallet       TEXT    NOT NULL,
  unit         TEXT    NOT NULL,
  cap          INTEGER NOT NULL,
  window_ms    INTEGER NOT NULL,
  per_payment  INTEGER,
  max_payments INTEGER,
  frozen_at    INTEGER
) STRICT;

-- The ledger: every state a payment enters, in the order the ledger took it. Rows are only
-- ever appended (the guards refuse UPDATE and DELETE). A payment is a 'held' entry, then at most
-- one 'bound', any number of 'noted', and the moves to 'void' or 'settled' that ledger.md allows.
CREATE TABLE wc_entry (
  seq      INTEGER PRIMARY KEY,
  payment  TEXT    NOT NULL CHECK (length(payment) BETWEEN 1 AND 160),
  kind     TEXT    NOT NULL CHECK (kind IN ('held', 'bound', 'noted', 'settled', 'void')),
  at       INTEGER NOT NULL,
  wallet   TEXT    NOT NULL REFERENCES wc_budget (wallet),
  amount   INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000000000000),
  until    INTEGER CHECK (until BETWEEN 0 AND 1000000000000000),  -- held, bound: the last moment it could settle
  outcome  TEXT    CHECK (outcome IN ('unknown', 'refused')),       -- noted
  rail     TEXT    CHECK (length(rail) BETWEEN 1 AND 64),          -- held
  info     TEXT    CHECK (length(info) <= 4096),                   -- held: the client's JSON (payee, note, …)
  holder   TEXT    CHECK (holder IS NULL OR (kind = 'held' AND length(holder) = 32 AND holder NOT GLOB '*[^0-9a-f]*')),
                                                                   -- held: the holding process's token
  evidence TEXT    CHECK (length(evidence) <= 1024)                -- noted, settled, void: what showed it
) STRICT;
CREATE UNIQUE INDEX wc_entry_hold ON wc_entry (payment) WHERE kind = 'held';
CREATE INDEX wc_entry_payment ON wc_entry (payment, seq);

-- Each payment's latest state, kept by the projection triggers in the same transaction as the
-- entry, and refused any other write. Replaying wc_entry rebuilds it. counts_from is the moment
-- the payment's window counts back to: it counts while counts_from >= now - window_ms.
CREATE TABLE wc_current (
  payment     TEXT    PRIMARY KEY,
  wallet      TEXT    NOT NULL,
  amount      INTEGER NOT NULL,
  state       TEXT    NOT NULL CHECK (state IN ('held', 'settled', 'void')),
  held_seq    INTEGER NOT NULL,
  held_at     INTEGER NOT NULL,
  until       INTEGER,
  outcome     TEXT,
  counts_from INTEGER,   -- NULL once void; 9223372036854775807 while held with no bound
  seq         INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
-- Admission reads this index, from now - window_ms up: only payments that still count. It
-- covers the amount, so the sum never touches the table.
CREATE INDEX wc_current_counting ON wc_current (wallet, counts_from, amount);
CREATE INDEX wc_current_recent ON wc_current (wallet, held_seq);
CREATE INDEX wc_current_held ON wc_current (wallet, held_seq) WHERE state = 'held';

-- The ledger's clock. julianday('now') is a millisecond clock on every SQLite that has the
-- date functions; unixepoch('subsec') would need 3.42.
CREATE VIEW wc_clock (now) AS
SELECT CAST(round((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER);

-- What each budget counts right now, and room: the largest payment it admits now.
CREATE VIEW wc_room (wallet, unit, now, cap, window_ms, per_payment, max_payments, frozen_at,
                     counted, payments, room) AS
SELECT wallet, unit, now, cap, window_ms, per_payment, max_payments, frozen_at, counted, payments,
  CASE
    WHEN frozen_at IS NOT NULL THEN 0
    WHEN max_payments IS NOT NULL AND payments >= max_payments THEN 0
    ELSE max(0, min(cap - counted, coalesce(per_payment, cap - counted)))
  END
FROM (
  SELECT b.wallet, b.unit, k.now, b.cap, b.window_ms, b.per_payment, b.max_payments, b.frozen_at,
    (SELECT coalesce(sum(c.amount), 0) FROM wc_current c
      WHERE c.wallet = b.wallet AND c.counts_from >= k.now - b.window_ms) AS counted,
    (SELECT count(*) FROM wc_current c
      WHERE c.wallet = b.wallet AND c.counts_from >= k.now - b.window_ms) AS payments
  FROM wc_budget b, wc_clock k
);

-- @section projection

-- The counting rule (ledger.md): a held payment counts through max(until, held_at) + window, or
-- for good while it has no until; a settled one through max(settled_at, until, held_at) + window;
-- a void one not at all.
CREATE TRIGGER wc_project_held AFTER INSERT ON wc_entry WHEN NEW.kind = 'held'
BEGIN
  INSERT INTO wc_current (payment, wallet, amount, state, held_seq, held_at, until, outcome, counts_from, seq)
  VALUES (NEW.payment, NEW.wallet, NEW.amount, 'held', NEW.seq, NEW.at, NEW.until, NULL,
          CASE WHEN NEW.until IS NULL THEN 9223372036854775807 ELSE max(NEW.until, NEW.at) END, NEW.seq);
END;

CREATE TRIGGER wc_project_bound AFTER INSERT ON wc_entry WHEN NEW.kind = 'bound'
BEGIN
  UPDATE wc_current SET until = NEW.until, counts_from = max(NEW.until, held_at), seq = NEW.seq
  WHERE payment = NEW.payment;
END;

CREATE TRIGGER wc_project_noted AFTER INSERT ON wc_entry WHEN NEW.kind = 'noted'
BEGIN
  UPDATE wc_current SET outcome = NEW.outcome, seq = NEW.seq WHERE payment = NEW.payment;
END;

CREATE TRIGGER wc_project_settled AFTER INSERT ON wc_entry WHEN NEW.kind = 'settled'
BEGIN
  UPDATE wc_current SET state = 'settled', counts_from = max(NEW.at, coalesce(until, NEW.at), held_at), seq = NEW.seq
  WHERE payment = NEW.payment;
END;

CREATE TRIGGER wc_project_void AFTER INSERT ON wc_entry WHEN NEW.kind = 'void'
BEGIN
  UPDATE wc_current SET state = 'void', counts_from = NULL, seq = NEW.seq WHERE payment = NEW.payment;
END;

CREATE TRIGGER wc_budget_logged AFTER INSERT ON wc_budget
BEGIN
  INSERT INTO wc_budget_log (at, wallet, unit, cap, window_ms, per_payment, max_payments, frozen_at)
  SELECT k.now, NEW.wallet, NEW.unit, NEW.cap, NEW.window_ms, NEW.per_payment, NEW.max_payments, NEW.frozen_at
  FROM wc_clock k;
END;

CREATE TRIGGER wc_budget_relogged AFTER UPDATE ON wc_budget
BEGIN
  INSERT INTO wc_budget_log (at, wallet, unit, cap, window_ms, per_payment, max_payments, frozen_at)
  SELECT k.now, NEW.wallet, NEW.unit, NEW.cap, NEW.window_ms, NEW.per_payment, NEW.max_payments, NEW.frozen_at
  FROM wc_clock k;
END;

-- @section guards

-- The safety net: the same rule for any writer, the sqlite3 shell included. The clients'
-- statements below never trip these; a trip is a bug, and aborts the statement.
CREATE TRIGGER wc_entry_dated BEFORE INSERT ON wc_entry
WHEN NEW.at IS NOT (SELECT now FROM wc_clock)
BEGIN
  SELECT RAISE(ABORT, 'walletcap: an entry is dated by the ledger''s clock');
END;

CREATE TRIGGER wc_entry_admitted BEFORE INSERT ON wc_entry WHEN NEW.kind = 'held'
BEGIN
  SELECT RAISE(ABORT, 'walletcap: that payment is already in the ledger')
  WHERE EXISTS (SELECT 1 FROM wc_current WHERE payment = NEW.payment);
  SELECT RAISE(ABORT, 'walletcap: a payment can''t settle before it is held')
  WHERE NEW.until <= NEW.at;
  SELECT RAISE(ABORT, 'walletcap: the budget refuses this payment')
  WHERE NOT EXISTS (SELECT 1 FROM wc_room r WHERE r.wallet = NEW.wallet AND NEW.amount <= r.room);
END;

CREATE TRIGGER wc_entry_forward BEFORE INSERT ON wc_entry WHEN NEW.kind <> 'held'
BEGIN
  SELECT RAISE(ABORT, 'walletcap: no such payment for this wallet and amount')
  WHERE NOT EXISTS (SELECT 1 FROM wc_current c
                    WHERE c.payment = NEW.payment AND c.wallet = NEW.wallet AND c.amount = NEW.amount);
  SELECT RAISE(ABORT, 'walletcap: a payment only moves forward: held to void or settled, void to settled')
  WHERE NOT EXISTS (SELECT 1 FROM wc_current c WHERE c.payment = NEW.payment AND (
          (NEW.kind = 'settled' AND c.state IN ('held', 'void'))
       OR (NEW.kind = 'void' AND c.state = 'held')
       OR (NEW.kind = 'bound' AND c.state = 'held' AND c.until IS NULL AND NEW.until > NEW.at)
       OR (NEW.kind = 'noted' AND c.state = 'held' AND NEW.outcome IS NOT NULL)));
END;

CREATE TRIGGER wc_entry_kept BEFORE UPDATE ON wc_entry
BEGIN
  SELECT RAISE(ABORT, 'walletcap: the ledger is append-only');
END;

CREATE TRIGGER wc_entry_never_deleted BEFORE DELETE ON wc_entry
BEGIN
  SELECT RAISE(ABORT, 'walletcap: the ledger is append-only');
END;

CREATE TRIGGER wc_current_inserted BEFORE INSERT ON wc_current
WHEN NEW.seq IS NOT NEW.held_seq
  OR NEW.held_seq IS NOT (SELECT seq FROM wc_entry WHERE payment = NEW.payment AND kind = 'held')
BEGIN
  SELECT RAISE(ABORT, 'walletcap: wc_current is written only from wc_entry');
END;

CREATE TRIGGER wc_current_updated BEFORE UPDATE ON wc_current
WHEN NEW.payment IS NOT OLD.payment OR NEW.wallet IS NOT OLD.wallet OR NEW.amount IS NOT OLD.amount
  OR NEW.held_seq IS NOT OLD.held_seq OR NEW.held_at IS NOT OLD.held_at OR NEW.seq <= OLD.seq
  OR NEW.seq IS NOT (SELECT max(seq) FROM wc_entry WHERE payment = NEW.payment)
BEGIN
  SELECT RAISE(ABORT, 'walletcap: wc_current is written only from wc_entry');
END;

CREATE TRIGGER wc_current_never_deleted BEFORE DELETE ON wc_current
BEGIN
  SELECT RAISE(ABORT, 'walletcap: wc_current is written only from wc_entry');
END;

CREATE TRIGGER wc_budget_never_deleted BEFORE DELETE ON wc_budget
BEGIN
  SELECT RAISE(ABORT, 'walletcap: a budget is frozen, not deleted');
END;

-- A shorter window would stop payments counting early, and a longer one isn't what the rows
-- that count were admitted under: the window changes only while nothing counts.
CREATE TRIGGER wc_budget_window BEFORE UPDATE OF window_ms ON wc_budget
WHEN NEW.window_ms <> OLD.window_ms
 AND EXISTS (SELECT 1 FROM wc_current c, wc_clock k
             WHERE c.wallet = OLD.wallet AND c.counts_from >= k.now - OLD.window_ms)
BEGIN
  SELECT RAISE(ABORT, 'walletcap: the window can''t change while payments count');
END;

-- @fragment verdict
-- Why a hold of :amount would be refused, or NULL. The budget's own limits come first, through
-- wc_room; then the tighter limits the paying process passed (:p_*), which bind it alone.
CASE
  WHEN :amount > r.room THEN CASE
    WHEN r.frozen_at IS NOT NULL THEN 'frozen'
    WHEN r.per_payment IS NOT NULL AND :amount > r.per_payment THEN 'per_payment'
    WHEN r.counted + :amount > r.cap THEN 'budget'
    ELSE 'max_payments' END
  WHEN :p_per_payment IS NOT NULL AND :amount > :p_per_payment THEN 'per_payment'
  WHEN :p_cap IS NOT NULL AND p.counted + :amount > :p_cap THEN 'budget'
  WHEN :p_max_payments IS NOT NULL AND p.payments >= :p_max_payments THEN 'max_payments'
END

-- @fragment process
-- What counts within the paying process's own window, which may be shorter or longer.
(SELECT coalesce(sum(c.amount), 0) AS counted, count(*) AS payments
   FROM wc_current c
  WHERE c.wallet = :wallet
    AND c.counts_from >= (SELECT now FROM wc_clock)
                         - coalesce(:p_window_ms, (SELECT window_ms FROM wc_budget WHERE wallet = :wallet)))

-- @statement hold
-- Admission: one atomic conditional insert. It appends the payment's 'held' entry only if the
-- verdict is NULL, the identity is new, and a settle-by time is after now; otherwise it appends
-- nothing and returns no row, and the client asks `refusal` why.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, until, rail, info, holder)
SELECT coalesce(:payment, 'wc-' || lower(hex(randomblob(16)))), 'held', r.now, r.wallet, :amount,
       coalesce(:until, r.now + :within_ms), :rail, :info, :holder
FROM wc_room r, {{process}} p
WHERE r.wallet = :wallet
  AND NOT EXISTS (SELECT 1 FROM wc_current WHERE payment = :payment)
  AND (:until IS NULL OR :until > r.now)
  AND ({{verdict}}) IS NULL
RETURNING payment, at, until

-- @statement refusal
-- Why `hold` appended nothing: the verdict, and the numbers a refusal message needs.
SELECT ({{verdict}}) AS code,
       CASE WHEN :amount > r.room THEN 'budget' ELSE 'process' END AS source,
       r.wallet, r.unit, r.now, r.cap, r.window_ms, r.per_payment, r.max_payments, r.frozen_at,
       r.counted, r.payments, p.counted AS p_counted, p.payments AS p_payments,
       (SELECT coalesce(sum(c.amount), 0) FROM wc_current c
         WHERE c.wallet = r.wallet AND c.state = 'held' AND c.counts_from >= r.now - r.window_ms) AS held,
       (SELECT count(*) FROM wc_current c
         WHERE c.wallet = r.wallet AND c.state = 'held' AND c.counts_from >= r.now - r.window_ms) AS held_payments,
       (SELECT frozen_by FROM wc_budget WHERE wallet = r.wallet) AS frozen_by,
       (SELECT json_object('wallet', c.wallet, 'amount', c.amount, 'state', c.state)
          FROM wc_current c WHERE c.payment = :payment) AS existing,
       (:until IS NOT NULL AND :until <= r.now) AS settles_too_soon
FROM wc_room r, {{process}} p
WHERE r.wallet = :wallet

-- @statement open_ids
-- The oldest open payments that count: a refusal names them for the owner.
SELECT c.payment
FROM wc_current c, wc_budget b, wc_clock k
WHERE c.wallet = :wallet AND b.wallet = c.wallet AND c.state = 'held'
  AND c.counts_from >= k.now - b.window_ms
ORDER BY c.held_seq
LIMIT 3

-- @statement settle
-- The paying process's moves (settle, void, bound, note) need :holder, the token its hold
-- returned (ledger.md, Identity): another process that knows the payment's id can't move it.
-- held or void -> settled. A settled payment is already settled: no row, nothing appended.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT c.payment, 'settled', k.now, c.wallet, c.amount, :evidence
FROM wc_current c JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.payment = :payment AND c.state IN ('held', 'void') AND h.holder = :holder
RETURNING seq

-- @statement void
-- held -> void: evidence that the payment never moved money.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT c.payment, 'void', k.now, c.wallet, c.amount, :evidence
FROM wc_current c JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.payment = :payment AND c.state = 'held' AND h.holder = :holder
RETURNING seq

-- @statement bound
-- held with no until -> held until :until, or :within_ms from now. One that has an until keeps it.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, until)
SELECT c.payment, 'bound', k.now, c.wallet, c.amount, coalesce(:until, k.now + :within_ms)
FROM wc_current c JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.payment = :payment AND c.state = 'held' AND c.until IS NULL AND h.holder = :holder
  AND coalesce(:until, k.now + :within_ms) > k.now
RETURNING seq, until

-- @statement note
-- What is known about a held payment's outcome: 'unknown' (the call failed) or 'refused' (the
-- payee said it failed). It keeps counting the same.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, outcome, evidence)
SELECT c.payment, 'noted', k.now, c.wallet, c.amount, :outcome, :evidence
FROM wc_current c JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.payment = :payment AND c.state = 'held' AND h.holder = :holder
RETURNING seq

-- @statement mine
-- Whether :holder is the token the payment's hold returned.
SELECT h.holder IS NOT NULL AND h.holder = :holder AS mine
FROM wc_current c JOIN wc_entry h ON h.seq = c.held_seq
WHERE c.payment = :payment

-- @statement owner_settle
-- The owner's reconciliation, with evidence: held or void -> settled, whoever held it.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT c.payment, 'settled', k.now, c.wallet, c.amount, :evidence
FROM wc_current c, wc_clock k
WHERE c.payment = :payment AND c.state IN ('held', 'void')
RETURNING seq

-- @statement owner_void
-- The owner's reconciliation, with evidence: held -> void, whoever held it.
INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT c.payment, 'void', k.now, c.wallet, c.amount, :evidence
FROM wc_current c, wc_clock k
WHERE c.payment = :payment AND c.state = 'held'
RETURNING seq

-- @statement void_unknown
-- The owner's bulk release: every held payment of unknown or refused outcome taken at least
-- :older_than_ms ago that can no longer settle: its until has passed, or, with no until, it is
-- an hour and a minute old (an x402 authorization lasts at most an hour once signed).
INSERT INTO wc_entry (payment, kind, at, wallet, amount, evidence)
SELECT c.payment, 'void', k.now, c.wallet, c.amount, :evidence
FROM wc_current c, wc_clock k
WHERE c.wallet = :wallet AND c.state = 'held' AND c.outcome IN ('unknown', 'refused')
  AND c.held_at <= k.now - :older_than_ms
  AND (c.until <= k.now OR (c.until IS NULL AND c.held_at <= k.now - 3660000))
ORDER BY c.held_seq
RETURNING payment, amount

-- @statement payment
SELECT c.payment, c.wallet, c.amount, c.state, c.outcome, c.held_at, c.until, c.counts_from,
       c.counts_from >= k.now - b.window_ms AS counting, b.window_ms, h.rail, h.info, k.now,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'settled'
         ORDER BY e.seq DESC LIMIT 1) AS settled_by,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'noted'
         ORDER BY e.seq DESC LIMIT 1) AS noted
FROM wc_current c
JOIN wc_budget b ON b.wallet = c.wallet
JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.payment = :payment

-- @statement history
-- The newest payments first, whatever their state.
SELECT c.payment, c.wallet, c.amount, c.state, c.outcome, c.held_at, c.until, c.counts_from,
       c.counts_from >= k.now - b.window_ms AS counting, b.window_ms, h.rail, h.info, k.now,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'settled'
         ORDER BY e.seq DESC LIMIT 1) AS settled_by,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'noted'
         ORDER BY e.seq DESC LIMIT 1) AS noted
FROM wc_current c
JOIN wc_budget b ON b.wallet = c.wallet
JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.wallet = :wallet
ORDER BY c.held_seq DESC
LIMIT :limit

-- @statement counting
-- The payments that count right now, oldest first: held ones are the open payments.
SELECT c.payment, c.wallet, c.amount, c.state, c.outcome, c.held_at, c.until, c.counts_from,
       1 AS counting, b.window_ms, h.rail, h.info, k.now,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'settled'
         ORDER BY e.seq DESC LIMIT 1) AS settled_by,
       (SELECT evidence FROM wc_entry e WHERE e.payment = c.payment AND e.kind = 'noted'
         ORDER BY e.seq DESC LIMIT 1) AS noted
FROM wc_current c
JOIN wc_budget b ON b.wallet = c.wallet
JOIN wc_entry h ON h.seq = c.held_seq, wc_clock k
WHERE c.wallet = :wallet AND c.counts_from >= k.now - b.window_ms
  AND (:held_only = 0 OR c.state = 'held')
ORDER BY c.held_seq

-- @statement status
SELECT r.wallet, r.unit, r.now, r.cap, r.window_ms, r.per_payment, r.max_payments, r.frozen_at,
       r.counted, r.payments, r.room,
       CASE WHEN r.frozen_at IS NOT NULL THEN 0 ELSE max(r.cap - r.counted, 0) END AS remaining,
       (SELECT coalesce(sum(c.amount), 0) FROM wc_current c
         WHERE c.wallet = r.wallet AND c.state = 'settled' AND c.counts_from >= r.now - r.window_ms) AS spent,
       (SELECT coalesce(sum(c.amount), 0) FROM wc_current c
         WHERE c.wallet = r.wallet AND c.state = 'held' AND c.counts_from >= r.now - r.window_ms) AS in_flight,
       b.merged_from, b.frozen_by
FROM wc_room r JOIN wc_budget b ON b.wallet = r.wallet
WHERE r.wallet = :wallet

-- @statement budget
SELECT wallet, unit, cap, window_ms, per_payment, max_payments, frozen_at, merged_from, frozen_by
FROM wc_budget WHERE wallet = :wallet

-- @statement budgets
SELECT wallet, unit, cap, window_ms, per_payment, max_payments, frozen_at, merged_from, frozen_by
FROM wc_budget ORDER BY wallet

-- @statement create_budget
INSERT INTO wc_budget (wallet, unit, cap, window_ms, per_payment, max_payments)
VALUES (:wallet, :unit, :cap, :window_ms, :per_payment, :max_payments)

-- @statement set_limits
-- The owner's change, up or down. What was spent keeps counting; the window changes only
-- while nothing counts (wc_budget_window). :keep_* = 1 leaves that limit as it is.
UPDATE wc_budget
SET cap = coalesce(:cap, cap),
    window_ms = coalesce(:window_ms, window_ms),
    per_payment = CASE WHEN :keep_per_payment THEN per_payment ELSE :per_payment END,
    max_payments = CASE WHEN :keep_max_payments THEN max_payments ELSE :max_payments END,
    merged_from = NULL
WHERE wallet = :wallet

-- @statement freeze
UPDATE wc_budget SET frozen_at = (SELECT now FROM wc_clock)
WHERE wallet = :wallet AND frozen_at IS NULL

-- @statement unfreeze
UPDATE wc_budget SET frozen_at = NULL, frozen_by = NULL
WHERE wallet = :wallet AND (frozen_at IS NOT NULL OR frozen_by IS NOT NULL)

-- @statement now
SELECT now FROM wc_clock
