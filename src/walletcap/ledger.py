# SPDX-License-Identifier: Apache-2.0
"""One spend budget shared by every process, replica and rail that opens the same file.

A spending limit only holds when every payment counts against one ledger. A
count kept in process memory resets on restart and is not shared by replicas,
and allowances granted per permission or per period add up. This ledger is a
SQLite file: each budget belongs to one funding instrument, and a payment
reserves its amount inside one ``BEGIN IMMEDIATE`` transaction, so two
processes racing for the last of a budget cannot both win and a restart reads
the same count.

Amounts are integers in the budget's own unit (USDC base units, say). A
reservation counts until it is committed (the payment settled) or released
(the payment was not made), however long that takes, and a settled payment
counts for one rolling window from when it settled. A reservation never lapses
on its own. One given the last moment its payment could settle counts for one
window past that moment, as if it settled then. An unknown outcome keeps
counting, because over-counting refuses a payment while under-counting lets
one through.

The JavaScript package reads and writes the same tables, so a Coinbase CDP x402
client, an x402 guard and a Python agent can spend from one budget.
"""

from __future__ import annotations

import enum
import re
import sqlite3
from collections.abc import Iterator
from contextlib import AbstractContextManager, closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from uuid import uuid4

from walletcap import _clock
from walletcap.errors import (
    BudgetError,
    BudgetRefused,
    BudgetRevoked,
    OverBudget,
    OverPerPayment,
    OverUses,
)
from walletcap.money import (
    DOLLAR_UNITS,
    MAX_AMOUNT,
    MAX_INTEGER,
    format_amount,
    format_window,
    normalize_wallet,
    short_wallet,
)

__all__ = [
    "MAX_AMOUNT",
    "SCHEMA_VERSION",
    "UNSET",
    "BudgetError",
    "BudgetLimits",
    "BudgetRefused",
    "BudgetRevoked",
    "BudgetStatus",
    "Checked",
    "Ensured",
    "Ledger",
    "OverBudget",
    "OverPerPayment",
    "OverUses",
    "Spend",
]

SCHEMA_VERSION = "1"

_ID = re.compile(r"^[A-Za-z0-9_.:@/-]{1,128}$")
_REFERENCE_LIMIT = 4096
_SCHEMA = """
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
"""
# A settled payment counts while its settlement is inside the budget's rolling
# window; a reservation counts until it is committed or released, or its expiry
# passes, whatever the window. The JavaScript ledger uses the same rule.
_COUNTED = (
    "FROM spend JOIN budgets ON budgets.instrument = spend.instrument "
    "WHERE spend.instrument = ? AND ("
    "(spend.status = 'committed' AND spend.at_ms + budgets.window_ms >= ?) "
    "OR (spend.status = 'reserved' "
    "AND (spend.expires_at_ms IS NULL OR spend.expires_at_ms > ?)))"
)


class _Unset(enum.Enum):
    UNSET = enum.auto()


UNSET: Final = _Unset.UNSET
"""A limit left out: no opinion, as opposed to None (no limit)."""


@dataclass(frozen=True)
class BudgetLimits:
    instrument: str
    unit: str
    cap: int
    window_ms: int
    per_payment: int | None
    max_uses: int | None


@dataclass(frozen=True)
class BudgetStatus:
    instrument: str
    unit: str
    cap: int
    spent: int
    reserved: int
    uses: int
    revoked: bool
    window_ms: int = 0
    per_payment: int | None = None
    max_uses: int | None = None

    @property
    def remaining(self) -> int:
        if self.revoked:
            return 0
        return max(self.cap - self.spent - self.reserved, 0)


@dataclass(frozen=True)
class Spend:
    spend_id: str
    instrument: str
    amount: int
    status: str
    rail: str
    reference: str | None
    at_ms: int
    expires_at_ms: int | None
    counting: bool


@dataclass(frozen=True)
class Ensured:
    created: bool
    budget: BudgetLimits
    lowered: tuple[str, ...]
    looser: tuple[str, ...]


@dataclass(frozen=True)
class Checked:
    refusal: BudgetRefused | None
    remaining: int


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise BudgetError(f"{label} must be a plain identifier")
    return value


def _instrument(value: object) -> str:
    """The name a budget is kept under, whoever opens it.

    An EVM address, bare or CAIP-10, is lowercased after its EIP-55 check, and a
    Solana CAIP-10 is reduced to its address, as ``open_budget`` does. A
    checksummed address can't open a second budget beside the lowercase one.
    """

    return normalize_wallet(_identifier(value, "instrument"))


def _amount(value: object, label: str, *, allow_zero: bool = False) -> int:
    """An amount in the budget's own unit, at most MAX_AMOUNT, so no sum of them overflows."""

    if type(value) is not int or value > MAX_AMOUNT or value < (0 if allow_zero else 1):
        floor = "nonnegative" if allow_zero else "positive"
        raise BudgetError(f"{label} must be a {floor} integer of at most {MAX_AMOUNT}")
    return value


def _integer(value: object, label: str, *, allow_zero: bool = False) -> int:
    """A time in milliseconds, or a count, that fits in 64 bits."""

    if type(value) is not int or value > MAX_INTEGER or value < (0 if allow_zero else 1):
        floor = "nonnegative" if allow_zero else "positive"
        raise BudgetError(f"{label} must be a {floor} integer that fits in 64 bits")
    return value


def _expiry(settles_by_ms: int, now: int, window_ms: int) -> int:
    """Counted as a payment settled at the later of settles_by_ms and now would be.

    That is, through that moment plus one window.
    """

    return min(max(settles_by_ms, now) + window_ms + 1, MAX_INTEGER)


def _reference(reference: object) -> str | None:
    if reference is not None and (
        not isinstance(reference, str) or len(reference) > _REFERENCE_LIMIT
    ):
        raise BudgetError(f"reference must be a string of at most {_REFERENCE_LIMIT}")
    return reference


def _limits(row: sqlite3.Row) -> BudgetLimits:
    return BudgetLimits(
        row["instrument"],
        row["unit"],
        row["cap"],
        row["window_ms"],
        row["per_payment"],
        row["max_uses"],
    )


def _units_match(stored: str, wanted: str) -> bool:
    return stored in DOLLAR_UNITS if wanted in DOLLAR_UNITS else stored == wanted


def _refusal(row: sqlite3.Row, total: int, uses: int, amount: int) -> BudgetRefused | None:
    """Why the budget in ``row`` refuses ``amount`` on top of what already counts, or None."""

    name = short_wallet(row["instrument"])
    unit = row["unit"]
    window = format_window(row["window_ms"])
    if row["revoked_at_ms"] is not None:
        return BudgetRevoked(
            f"{name}'s budget is frozen: nothing can be paid until its owner unfreezes it"
        )
    if row["per_payment"] is not None and amount > row["per_payment"]:
        return OverPerPayment(
            f"{format_amount(amount, unit)} is over {name}'s "
            f"{format_amount(row['per_payment'], unit)} limit per payment"
        )
    if total + amount > row["cap"]:
        left = max(row["cap"] - total, 0)
        return OverBudget(
            f"{format_amount(amount, unit)} would bring {name} to "
            f"{format_amount(total + amount, unit)} in the last {window}, over its "
            f"{format_amount(row['cap'], unit)} limit ({format_amount(left, unit)} left)"
        )
    if row["max_uses"] is not None and uses + 1 > row["max_uses"]:
        plural = "" if uses == 1 else "s"
        return OverUses(
            f"{name} already made {uses} payment{plural} in the last {window}, "
            "the most its budget allows"
        )
    return None


class Ledger:
    """A restart-safe spend budget shared by every process that opens the same file."""

    def __init__(
        self,
        path: str | Path,
        *,
        busy_timeout_seconds: float = 30.0,
    ) -> None:
        if not busy_timeout_seconds > 0:
            raise BudgetError("busy_timeout_seconds must be positive")
        self._path = Path(path)
        self._busy_timeout = float(busy_timeout_seconds)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with closing(self._connect()) as connection:
                connection.executescript(_SCHEMA)
        except sqlite3.Error as error:
            raise BudgetError(f"the budget file {self._path} cannot be used: {error}") from error
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO budget_meta VALUES ('schema', ?)", (SCHEMA_VERSION,)
            )
            (version,) = connection.execute(
                "SELECT value FROM budget_meta WHERE key = 'schema'"
            ).fetchone()
            if version != SCHEMA_VERSION:
                raise BudgetError(f"ledger schema {version} is not {SCHEMA_VERSION}")

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self._path, timeout=self._busy_timeout, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _transaction(self, begin: str = "BEGIN IMMEDIATE") -> Iterator[sqlite3.Connection]:
        try:
            connection = self._connect()
        except sqlite3.Error as error:
            raise BudgetError(f"the budget file {self._path} cannot be used: {error}") from error
        try:
            connection.execute(begin)
            yield connection
            connection.execute("COMMIT")
        except sqlite3.Error as error:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise BudgetError(f"the budget file {self._path} cannot be used: {error}") from error
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def _read(self) -> AbstractContextManager[sqlite3.Connection]:
        """One consistent snapshot of the file, without taking the write lock."""

        return self._transaction("BEGIN")

    @staticmethod
    def _now_ms() -> int:
        """The ledger's own time: the system clock. Callers can't set it."""

        return _clock.now_ms()

    def _budget_row(self, connection: sqlite3.Connection, instrument: str) -> sqlite3.Row:
        row: sqlite3.Row | None = connection.execute(
            "SELECT * FROM budgets WHERE instrument = ?", (instrument,)
        ).fetchone()
        if row is None:
            raise BudgetError(f"{short_wallet(instrument)} has no declared budget in {self._path}")
        return row

    @staticmethod
    def _counted(connection: sqlite3.Connection, instrument: str, now: int) -> tuple[int, int]:
        total, uses = connection.execute(
            f"SELECT COALESCE(SUM(spend.amount), 0), COUNT(spend.spend_id) {_COUNTED}",  # noqa: S608
            (instrument, now, now),
        ).fetchone()
        return int(total), int(uses)

    def declare(
        self,
        instrument: str,
        *,
        unit: str,
        cap: int,
        window_seconds: int,
        per_payment: int | None = None,
        max_uses: int | None = None,
    ) -> BudgetLimits:
        """Record an instrument's budget once; declaring it again with other limits is refused.

        ``cap`` is the most the instrument may spend in any rolling ``window_seconds``,
        counted across every process, replica, permission and rail that uses this file.
        """

        instrument = _instrument(instrument)
        _identifier(unit, "unit")
        _amount(cap, "cap", allow_zero=True)
        _integer(window_seconds, "window_seconds")
        if window_seconds * 1000 > MAX_INTEGER:
            raise BudgetError("window_seconds is too large")
        if per_payment is not None:
            _amount(per_payment, "per_payment")
        if max_uses is not None:
            _integer(max_uses, "max_uses", allow_zero=True)
        budget = BudgetLimits(instrument, unit, cap, window_seconds * 1000, per_payment, max_uses)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM budgets WHERE instrument = ?", (instrument,)
            ).fetchone()
            if row is None:
                connection.execute(
                    "INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)",
                    (instrument, unit, cap, budget.window_ms, per_payment, max_uses),
                )
            elif _limits(row) != budget:
                raise BudgetError("instrument budget is already declared with other limits")
        return budget

    def budget(self, instrument: str) -> BudgetLimits | None:
        """The instrument's limits, or None if it has no budget."""

        instrument = _instrument(instrument)
        with self._read() as connection:
            row = connection.execute(
                "SELECT * FROM budgets WHERE instrument = ?", (instrument,)
            ).fetchone()
        return None if row is None else _limits(row)

    def budgets(self) -> list[BudgetLimits]:
        with self._read() as connection:
            rows = connection.execute("SELECT * FROM budgets ORDER BY instrument").fetchall()
        return [_limits(row) for row in rows]

    def ensure(
        self,
        instrument: str,
        *,
        unit: str = "usd",
        cap: int | None = None,
        window_ms: int | None = None,
        per_payment: int | None | _Unset = UNSET,
        max_uses: int | None | _Unset = UNSET,
        create: bool = True,
    ) -> Ensured:
        """Create the budget with these limits, or move its stored limits toward them.

        A tighter limit is stored; a looser one is reported and left alone. A
        restart can lower a limit, and only ``set_limits`` raises one. ``cap``
        and ``window_ms`` go together; for ``per_payment`` and ``max_uses``,
        ``UNSET`` means no opinion and None means no limit.
        """

        instrument = _instrument(instrument)
        self._check_limits(cap, window_ms, per_payment, max_uses)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM budgets WHERE instrument = ?", (instrument,)
            ).fetchone()
            if row is None:
                name = short_wallet(instrument)
                if not create:
                    raise BudgetError(f"{name} has no declared budget in {self._path}")
                if cap is None or window_ms is None:
                    raise BudgetError(
                        f"{name} has no budget yet: give it a rolling limit, like per_day='$150'"
                    )
                connection.execute(
                    "INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)",
                    (
                        instrument,
                        unit,
                        cap,
                        window_ms,
                        None if per_payment is UNSET else per_payment,
                        None if max_uses is UNSET else max_uses,
                    ),
                )
                created = self._budget_row(connection, instrument)
                return Ensured(True, _limits(created), (), ())
            if not _units_match(row["unit"], unit):
                raise BudgetError(
                    f"{short_wallet(instrument)}'s budget counts in {row['unit']}, not {unit}"
                )
            lowered: list[str] = []
            looser: list[str] = []
            same_window = window_ms is None or window_ms == row["window_ms"]
            new_cap, new_per_payment, new_max_uses = row["cap"], row["per_payment"], row["max_uses"]
            if cap is not None:
                if not same_window:
                    looser.append("window")
                elif cap < new_cap:
                    new_cap = cap
                    lowered.append("cap")
                elif cap > new_cap:
                    looser.append("cap")
            if per_payment is not UNSET:
                if per_payment is not None and (
                    new_per_payment is None or per_payment < new_per_payment
                ):
                    new_per_payment = per_payment
                    lowered.append("per_payment")
                elif new_per_payment is not None and (
                    per_payment is None or per_payment > new_per_payment
                ):
                    looser.append("per_payment")
            if max_uses is not UNSET and max_uses != new_max_uses:
                if (
                    same_window
                    and max_uses is not None
                    and (new_max_uses is None or max_uses < new_max_uses)
                ):
                    new_max_uses = max_uses
                    lowered.append("max_uses")
                else:
                    looser.append("max_uses")
            if lowered:
                connection.execute(
                    "UPDATE budgets SET cap = ?, per_payment = ?, max_uses = ? "
                    "WHERE instrument = ?",
                    (new_cap, new_per_payment, new_max_uses, instrument),
                )
            current = self._budget_row(connection, instrument)
        return Ensured(False, _limits(current), tuple(lowered), tuple(looser))

    def set_limits(
        self,
        instrument: str,
        *,
        unit: str = "usd",
        cap: int | None = None,
        window_ms: int | None = None,
        per_payment: int | None | _Unset = UNSET,
        max_uses: int | None | _Unset = UNSET,
        create: bool = True,
    ) -> BudgetLimits:
        """Change limits in either direction. What was spent keeps counting: nothing resets."""

        instrument = _instrument(instrument)
        self._check_limits(cap, window_ms, per_payment, max_uses)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM budgets WHERE instrument = ?", (instrument,)
            ).fetchone()
            if row is None:
                name = short_wallet(instrument)
                if not create:
                    raise BudgetError(f"{name} has no declared budget in {self._path}")
                if cap is None or window_ms is None:
                    raise BudgetError(
                        f"{name} has no budget yet: give it a rolling limit too, like --per-day 150"
                    )
                connection.execute(
                    "INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)",
                    (
                        instrument,
                        unit,
                        cap,
                        window_ms,
                        None if per_payment is UNSET else per_payment,
                        None if max_uses is UNSET else max_uses,
                    ),
                )
            else:
                if not _units_match(row["unit"], unit):
                    raise BudgetError(
                        f"{short_wallet(instrument)}'s budget counts in {row['unit']}, not {unit}"
                    )
                if window_ms is not None and window_ms != row["window_ms"]:
                    used = connection.execute(
                        "SELECT 1 FROM spend WHERE instrument = ? LIMIT 1", (instrument,)
                    ).fetchone()
                    if used is not None:
                        raise BudgetError(
                            f"{short_wallet(instrument)} has spend in this budget; the window "
                            "cannot change. Create a new budget instead."
                        )
                connection.execute(
                    "UPDATE budgets SET cap = ?, window_ms = ?, per_payment = ?, max_uses = ? "
                    "WHERE instrument = ?",
                    (
                        row["cap"] if cap is None else cap,
                        row["window_ms"] if window_ms is None else window_ms,
                        row["per_payment"] if per_payment is UNSET else per_payment,
                        row["max_uses"] if max_uses is UNSET else max_uses,
                        instrument,
                    ),
                )
            current = self._budget_row(connection, instrument)
        return _limits(current)

    @staticmethod
    def _check_limits(
        cap: int | None,
        window_ms: int | None,
        per_payment: int | None | _Unset,
        max_uses: int | None | _Unset,
    ) -> None:
        if (cap is None) != (window_ms is None):
            raise BudgetError("cap and window go together")
        if cap is not None:
            _amount(cap, "cap", allow_zero=True)
        if window_ms is not None:
            _integer(window_ms, "window_ms")
        if per_payment is not UNSET and per_payment is not None:
            _amount(per_payment, "per_payment")
        if max_uses is not UNSET and max_uses is not None:
            _integer(max_uses, "max_uses", allow_zero=True)

    def check(self, instrument: str, amount: int) -> Checked:
        """Whether ``amount`` would be refused right now, without reserving it."""

        instrument = _instrument(instrument)
        _amount(amount, "amount")
        now = self._now_ms()
        with self._read() as connection:
            row = self._budget_row(connection, instrument)
            total, uses = self._counted(connection, instrument, now)
        left = 0 if row["revoked_at_ms"] is not None else max(row["cap"] - total, 0)
        return Checked(_refusal(row, total, uses, amount), left)

    def reserve(
        self,
        instrument: str,
        amount: int,
        *,
        rail: str = "python",
        reference: str | None = None,
        settles_by_ms: int | None = None,
    ) -> str:
        """Take ``amount`` from the instrument's budget, or raise a ``BudgetRefused``.

        Call it before the payment is made; commit the returned id once the
        payment settles, or release it if the payment was never sent. With
        ``settles_by_ms`` (the last moment the payment could still settle), an
        open reservation stops counting one window after that moment; a moment
        already past counts as now.
        """

        instrument = _instrument(instrument)
        _amount(amount, "amount")
        _identifier(rail, "rail")
        _reference(reference)
        if settles_by_ms is not None:
            _integer(settles_by_ms, "settles_by_ms", allow_zero=True)
        now = self._now_ms()
        with self._transaction() as connection:
            budget = self._budget_row(connection, instrument)
            total, uses = self._counted(connection, instrument, now)
            refusal = _refusal(budget, total, uses, amount)
            if refusal is not None:
                raise refusal
            spend_id = f"spend-{uuid4().hex}"
            expires: int | None = None
            if settles_by_ms is not None:
                expires = _expiry(settles_by_ms, now, budget["window_ms"])
            connection.execute(
                "INSERT INTO spend VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)",
                (spend_id, instrument, amount, rail, reference, now, expires),
            )
        return spend_id

    def commit(self, spend_id: str, *, reference: str | None = None) -> None:
        """Record a reservation's payment as settled, now.

        It counts for one rolling window from now, however long the payment
        took. A reservation whose settle-by time has passed is still recorded:
        the money moved, and leaving it out would under-count.
        """

        _identifier(spend_id, "spend_id")
        _reference(reference)
        now = self._now_ms()
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT status FROM spend WHERE spend_id = ?", (spend_id,)
            ).fetchone()
            if row is None:
                raise BudgetError("unknown reservation")
            if row["status"] == "committed":
                raise BudgetError("reservation is already committed")
            connection.execute(
                "UPDATE spend SET status = 'committed', at_ms = MAX(at_ms, ?), "
                "expires_at_ms = NULL, reference = COALESCE(?, reference) WHERE spend_id = ?",
                (now, reference, spend_id),
            )

    def annotate(self, spend_id: str, reference: str | None) -> None:
        """Replace an open reservation's reference; it keeps counting."""

        _identifier(spend_id, "spend_id")
        _reference(reference)
        with self._transaction() as connection:
            connection.execute(
                "UPDATE spend SET reference = ? WHERE spend_id = ? AND status = 'reserved'",
                (reference, spend_id),
            )

    def release(self, spend_id: str) -> None:
        """Give back a reservation whose payment was never sent."""

        _identifier(spend_id, "spend_id")
        with self._transaction() as connection:
            deleted = connection.execute(
                "DELETE FROM spend WHERE spend_id = ? AND status = 'reserved'", (spend_id,)
            ).rowcount
            if deleted != 1:
                raise BudgetError("only an uncommitted reservation can be released")

    def revoke(self, instrument: str) -> None:
        """Refuse every later reservation for the instrument.

        Reservations already taken keep counting and can still be committed: a
        payment that was in flight may settle.
        """

        instrument = _instrument(instrument)
        with self._transaction() as connection:
            self._budget_row(connection, instrument)
            connection.execute(
                "UPDATE budgets SET revoked_at_ms = ? "
                "WHERE instrument = ? AND revoked_at_ms IS NULL",
                (self._now_ms(), instrument),
            )

    def unrevoke(self, instrument: str) -> None:
        """Allow reservations again after ``revoke``."""

        instrument = _instrument(instrument)
        with self._transaction() as connection:
            self._budget_row(connection, instrument)
            connection.execute(
                "UPDATE budgets SET revoked_at_ms = NULL WHERE instrument = ?", (instrument,)
            )

    def status(self, instrument: str) -> BudgetStatus:
        """What counts against the instrument's budget right now."""

        instrument = _instrument(instrument)
        now = self._now_ms()
        with self._read() as connection:
            budget = self._budget_row(connection, instrument)
            sums = {
                row[0]: (row[1], row[2])
                for row in connection.execute(
                    "SELECT spend.status, COALESCE(SUM(spend.amount), 0), "  # noqa: S608
                    f"COUNT(spend.spend_id) {_COUNTED} GROUP BY spend.status",
                    (instrument, now, now),
                )
            }
        spent, committed_uses = sums.get("committed", (0, 0))
        reserved, reserved_uses = sums.get("reserved", (0, 0))
        return BudgetStatus(
            instrument,
            budget["unit"],
            budget["cap"],
            spent,
            reserved,
            committed_uses + reserved_uses,
            budget["revoked_at_ms"] is not None,
            budget["window_ms"],
            budget["per_payment"],
            budget["max_uses"],
        )

    def history(self, instrument: str, *, limit: int = 20) -> list[Spend]:
        """The instrument's newest payments first, with whether each still counts."""

        instrument = _instrument(instrument)
        _integer(limit, "limit")
        now = self._now_ms()
        with self._read() as connection:
            window = self._budget_row(connection, instrument)["window_ms"]
            rows = connection.execute(
                "SELECT * FROM spend WHERE instrument = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?",
                (instrument, limit),
            ).fetchall()
        return [self._spend(row, window, now) for row in rows]

    def payment(self, spend_id: str) -> Spend | None:
        """One payment by id, or None."""

        _identifier(spend_id, "spend_id")
        now = self._now_ms()
        with self._read() as connection:
            row = connection.execute(
                "SELECT spend.*, budgets.window_ms AS window_ms FROM spend "
                "JOIN budgets ON budgets.instrument = spend.instrument WHERE spend_id = ?",
                (spend_id,),
            ).fetchone()
        return None if row is None else self._spend(row, row["window_ms"], now)

    @staticmethod
    def _spend(row: sqlite3.Row, window_ms: int, now: int) -> Spend:
        if row["status"] == "committed":
            counting = row["at_ms"] + window_ms >= now
        else:
            counting = row["expires_at_ms"] is None or row["expires_at_ms"] > now
        return Spend(
            row["spend_id"],
            row["instrument"],
            row["amount"],
            row["status"],
            row["rail"],
            row["reference"],
            row["at_ms"],
            row["expires_at_ms"],
            counting,
        )

    def compact(self, instrument: str) -> int:
        """Delete the instrument's settled payments that aged out; return how many went.

        Reservations stay until they are committed or released: one past its
        settle-by time no longer counts, but a late commit still records it.
        """

        instrument = _instrument(instrument)
        now = self._now_ms()
        with self._transaction() as connection:
            window = self._budget_row(connection, instrument)["window_ms"]
            deleted: int = connection.execute(
                "DELETE FROM spend WHERE instrument = ? AND status = 'committed' "
                "AND at_ms + ? < ?",
                (instrument, window, now),
            ).rowcount
        return deleted
