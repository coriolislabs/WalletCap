# SPDX-License-Identifier: Apache-2.0
"""The budget file's client.

The rule is not in this module: spec/schema.sql holds the tables, the counting rule and
admission, and this module runs its statements by name, as the JavaScript package does. What
it adds is reading input, opening and upgrading the file, and wording refusals. The file serves
one host: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any, Final

from walletcap import _clock
from walletcap.errors import BudgetError, BudgetRefused
from walletcap.money import MAX_AMOUNT, format_amount, format_window, normalize_wallet, short_wallet

__all__ = [
    "MAX_TIME",
    "MIN_SQLITE_VERSION",
    "SCHEMA_VERSION",
    "UNBOUNDED_HOLD_MS",
    "Ledger",
    "ProcessLimits",
    "parse_spec",
    "refusal",
]

SCHEMA_VERSION: Final = "3"
"""The file's format. 0.4 upgrades a 0.2 (1) or 0.3 (2) file when it opens it; they refuse 3."""

MIN_SQLITE_VERSION: Final = "3.37.0"
"""The oldest SQLite the ledger runs on: STRICT tables arrived in 3.37.0."""

UNBOUNDED_HOLD_MS: Final = 3_660_000
"""How old a held payment with no settle-by time must be before a bulk release voids it.

An hour, the longest an x402 authorization walletcap signs can be redeemed, and a minute. The
rule is in spec/schema.sql (void_unknown); this is its value, for messages.
"""

MAX_TIME: Final = 10**15
"""The most a time or a duration can be, in milliseconds: about 31,700 years."""

_ID = re.compile(r"[A-Za-z0-9_.:@/+-]{1,160}")
_RAIL = re.compile(r"[A-Za-z0-9_.:@/-]{1,64}")
_MARKER = re.compile(r"-- @(section|fragment|statement) ([a-z_]+)\s*")
_SPLICE = re.compile(r"\{\{([a-z_]+)\}\}")
_STRING = re.compile(r"'(?:[^']|'')*'")
_PARAMETER = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")
_INFO_LIMIT = 4096
_EVIDENCE_LIMIT = 1024
_SHOWN_HOLDS = 3


@dataclass(frozen=True)
class Spec:
    sections: dict[str, str]
    fragments: dict[str, str]
    statements: dict[str, str]


def parse_spec(text: str) -> Spec:
    """spec/schema.sql or spec/upgrade.sql, split on their '-- @' lines.

    Sections run whole, fragments are spliced into statements as ``{{name}}``, and statements
    run by name. Comment lines inside fragments and statements are dropped.
    """

    parts: dict[str, dict[str, str]] = {"section": {}, "fragment": {}, "statement": {}}
    kind: str | None = None
    name = ""
    lines: list[str] = []

    def flush() -> None:
        if kind is not None:
            parts[kind][name] = "\n".join(lines).strip()

    for line in text.split("\n"):
        marker = _MARKER.fullmatch(line)
        if marker is not None:
            flush()
            kind, name, lines = marker.group(1), marker.group(2), []
        elif kind is not None and not (kind != "section" and line.strip().startswith("--")):
            lines.append(line)
    flush()

    def splice(match: re.Match[str]) -> str:
        return parts["fragment"][match.group(1)]

    statements = {key: _SPLICE.sub(splice, sql) for key, sql in parts["statement"].items()}
    return Spec(parts["section"], parts["fragment"], statements)


_SPEC: dict[str, Spec] = {}


def _spec(name: str) -> Spec:
    """The package's copy of a spec file, read once."""

    if name not in _SPEC:
        try:
            text = (resources.files("walletcap") / "spec" / name).read_text(encoding="utf-8")
        except OSError as error:
            raise BudgetError(f"walletcap's package is missing spec/{name}; reinstall it") from error
        _SPEC[name] = parse_spec(text)
    return _SPEC[name]


def _parameters(sql: str) -> list[str]:
    return list(dict.fromkeys(_PARAMETER.findall(_STRING.sub("''", sql))))


def _version(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split(".")[:3])


# --- Reading input -------------------------------------------------------------------------


def _whole(value: object, label: str, low: int, high: int) -> int:
    if type(value) is not int:
        raise BudgetError(f"{label} must be an integer")
    if not low <= value <= high:
        raise BudgetError(f"{label} must be an integer from {low} to {high}")
    return value


def units(value: object, label: str, *, allow_zero: bool = False) -> int:
    """An amount in the budget's own unit, from 1 (or 0) to MAX_AMOUNT."""

    return _whole(value, label, 0 if allow_zero else 1, MAX_AMOUNT)


def millis(value: object, label: str, *, low: int = 0) -> int:
    """A time or a duration in milliseconds."""

    return _whole(value, label, low, MAX_TIME)


def payment_id(value: object) -> str:
    """A payment's identity: the rail's own (eip3009:<from>:<nonce>, tx:<hash>) or the caller's."""

    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise BudgetError("a payment id is 1 to 160 of letters, digits and _ . : @ / + -")
    return value


def _rail(value: object) -> str:
    if not isinstance(value, str) or _RAIL.fullmatch(value) is None:
        raise BudgetError("rail must be a plain identifier")
    return value


def _text(value: object, label: str, limit: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise BudgetError(f"{label} must be a string of at most {limit} characters")
    return value


@dataclass(frozen=True)
class ProcessLimits:
    """The paying process's own limits, which only tighten the budget's, for that process."""

    per_payment: int | None = None
    cap: int | None = None
    window_ms: int | None = None
    max_payments: int | None = None


# --- Wording -------------------------------------------------------------------------------


def _plural(count: int) -> str:
    return "" if count == 1 else "s"


def _merged_note(names: list[str]) -> str:
    return (
        f"The 0.3.0 upgrade merged the budget{_plural(len(names))} 0.2.x kept under "
        f"{', '.join(names)} into this one, with the tighter of each limit; its owner can "
        "change them with 'walletcap set'"
    )


def _frozen_note(note: dict[str, Any]) -> str:
    aside = note["aside"]
    budgets = " and ".join(f"a budget in {item['unit']} under {item['name']}" for item in aside)
    which = "that budget no longer counts" if len(aside) == 1 else "those budgets no longer count"
    return (
        f"The 0.3.0 upgrade froze it: 0.2.x also kept {budgets} for this wallet, which can't be "
        f"merged with this one in {note['kept']}, so {which}"
    )


def _note(text: str | None, word: Callable[[Any], str]) -> str | None:
    if text is None:
        return None
    try:
        return word(json.loads(text))
    except (ValueError, KeyError, TypeError):
        return None


def merged_note_of(text: str | None) -> str | None:
    """What an upgrade merged into this budget, or None."""

    return _note(text, _merged_note)


def _held_note(held_payments: int, ids: list[str]) -> str:
    more = f" and {held_payments - len(ids)} more" if held_payments > len(ids) else ""
    return (
        f"{', '.join(ids)}{more}; walletcap holds lists them, "
        "and if one never left the wallet its owner can release it"
    )


def refusal(
    why: Mapping[str, Any], amount: int, limits: ProcessLimits, open_ids: Callable[[], list[str]]
) -> BudgetRefused:
    """The refusal for ``why``, a row of the refusal statement, worded as JavaScript words it."""

    name = short_wallet(why["wallet"])
    unit = why["unit"]
    window = format_window(why["window_ms"])

    def money(value: int) -> str:
        return format_amount(value, unit)

    code = why["code"]
    source = why["source"]

    def refused(code: str, message: str, brief: str | None = None) -> BudgetRefused:
        return BudgetRefused(code, message, brief=brief, source=source)

    if code == "frozen":
        note = _note(why["frozen_by"], _frozen_note)
        return refused(
            "frozen",
            f"{name}'s budget is frozen: nothing can be paid until its owner unfreezes it"
            + ("" if note is None else f". {note}"),
        )
    if why["source"] == "process":
        own = window if limits.window_ms is None else format_window(limits.window_ms)
        if code == "per_payment":
            assert limits.per_payment is not None
            return refused(
                "per_payment",
                f"{money(amount)} is over the {money(limits.per_payment)} limit per payment "
                "this process set",
            )
        if code == "budget":
            assert limits.cap is not None
            left = max(limits.cap - why["p_counted"], 0)
            return refused(
                "budget",
                f"{money(amount)} would bring {name} to {money(why['p_counted'] + amount)} in the "
                f"last {own}, over the {money(limits.cap)} limit this process set "
                f"({money(left)} left)",
            )
        payments = why["p_payments"]
        return refused(
            "max_payments",
            f"{name} already made {payments} payment{_plural(payments)} in the last {own}, "
            "the most this process allows",
        )
    if code == "per_payment":
        return refused(
            "per_payment",
            f"{money(amount)} is over {name}'s {money(why['per_payment'])} limit per payment",
        )
    held = why["held_payments"]
    if code == "budget":
        left = max(why["cap"] - why["counted"], 0)
        over = (
            f"{money(amount)} would bring {name} to {money(why['counted'] + amount)} in the last "
            f"{window}, over its {money(why['cap'])} limit ({money(left)} left)"
        )
        if not held:
            return refused("budget", over)
        brief = f"{over}; {money(why['held'])} of it is {held} open payment{_plural(held)}"
        return refused("budget", f"{brief} ({_held_note(held, open_ids())})", brief)
    payments = why["payments"]
    if not held:
        return refused(
            "max_payments",
            f"{name} already made {payments} payment{_plural(payments)} in the last {window}, "
            "the most its budget allows",
        )
    brief = (
        f"{name} has {payments} payment{_plural(payments)} counting in the last {window}, "
        f"the most its budget allows, and {held} of them {'is' if held == 1 else 'are'} still open"
    )
    return refused("max_payments", f"{brief} ({_held_note(held, open_ids())})", brief)


# --- The ledger ----------------------------------------------------------------------------

Row = dict[str, Any]


def _iso(ms: int) -> str:
    moment = datetime.fromtimestamp(ms / 1000, tz=UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Ledger:
    """One budget file. Every method runs statements from spec/schema.sql.

    Each operation opens its own connection, and each write runs in one ``BEGIN IMMEDIATE``
    transaction, so the file has one writer at a time.
    """

    def __init__(
        self, path: str | Path, *, busy_timeout_seconds: float = 30.0, create: bool = False
    ) -> None:
        if not busy_timeout_seconds > 0:
            raise BudgetError("busy_timeout_seconds must be positive")
        self._path = Path(path)
        self._busy_timeout = float(busy_timeout_seconds)
        self._names: dict[str, list[str]] = {}
        if not self._path.exists():
            if not create:
                raise BudgetError(f"no budget file at {self._path}")
            self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                os.close(os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
            except FileExistsError:
                pass
            except OSError as error:
                raise BudgetError(f"the budget file {self._path} cannot be used: {error}") from error
        version = sqlite3.sqlite_version
        if _version(version) < _version(MIN_SQLITE_VERSION):
            raise BudgetError(
                f"walletcap needs SQLite {MIN_SQLITE_VERSION} or later; this Python has {version}"
            )
        self._prepare_file()

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        try:
            connection = sqlite3.connect(
                self._path, timeout=self._busy_timeout, isolation_level=None
            )
        except sqlite3.Error as error:
            raise BudgetError(f"the budget file {self._path} cannot be used: {error}") from error
        connection.row_factory = sqlite3.Row
        _clock.install(connection)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA synchronous = FULL")
        except sqlite3.Error as error:
            connection.close()
            raise self._failure(error) from error
        return connection

    def _failure(self, error: sqlite3.Error) -> BudgetError:
        message = str(error)
        if "walletcap: " in message:
            return BudgetError(message[message.index("walletcap: ") + len("walletcap: ") :])
        if getattr(error, "sqlite_errorcode", 0) & 0xFF == sqlite3.SQLITE_BUSY or "locked" in message:
            return BudgetError(
                f"the budget file {self._path} is busy: another process held its write lock "
                "past the busy timeout"
            )
        return BudgetError(f"the budget file {self._path} cannot be used: {error}")

    @contextmanager
    def _transaction(self, begin: str = "BEGIN IMMEDIATE") -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            try:
                connection.execute(begin)
            except sqlite3.Error as error:
                raise self._failure(error) from error
            try:
                yield connection
                connection.execute("COMMIT")
            except sqlite3.Error as error:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise self._failure(error) from error
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
        finally:
            connection.close()

    def _read(self) -> Any:
        return self._transaction("BEGIN")

    def _schema(self, connection: sqlite3.Connection) -> str | None:
        tables = [
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
        ]
        if not tables:
            return None
        if "budget_meta" not in tables:
            raise BudgetError(f"{self._path} is a SQLite file, not a walletcap budget")
        row = connection.execute("SELECT value FROM budget_meta WHERE key = 'schema'").fetchone()
        if row is None:
            raise BudgetError(
                f"{self._path} has no schema version; it is not a walletcap budget walletcap can read"
            )
        return str(row[0])

    def _prepare_file(self) -> None:
        """Create the schema, or upgrade an older one, in one write transaction."""

        with self._read() as connection:
            if self._schema(connection) == SCHEMA_VERSION:
                return
        schema, upgrade = _spec("schema.sql"), _spec("upgrade.sql")
        with self._transaction() as connection:
            found = self._schema(connection)
            if found == SCHEMA_VERSION:
                return
            if found is None:
                for section in ("tables", "projection", "guards"):
                    _script(connection, schema.sections[section])
            elif found in ("1", "2"):
                _script(connection, upgrade.sections["rename"])
                _script(connection, schema.sections["tables"])
                _script(connection, schema.sections["projection"])
                if found == "1":
                    _script(connection, upgrade.sections["names"])
                _script(connection, upgrade.sections["migrate"])
                _script(connection, schema.sections["guards"])
            else:
                raise BudgetError(
                    f"{self._path} is at schema {found}, which a newer walletcap wrote; "
                    f"this one reads {SCHEMA_VERSION}"
                )
            connection.execute(
                "INSERT INTO budget_meta (key, value) VALUES ('schema', ?)", (SCHEMA_VERSION,)
            )
        # WAL lets readers through while one process writes. A file another process holds open
        # stays in its journal mode until it can switch; either mode is correct.
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode = WAL")
        except sqlite3.Error:
            pass
        finally:
            connection.close()

    def _run(self, connection: sqlite3.Connection, name: str, args: Mapping[str, object]) -> list[Row]:
        sql = _spec("schema.sql").statements[name]
        names = self._names.get(name)
        if names is None:
            names = self._names[name] = _parameters(sql)
        bound = {
            key: (int(value) if isinstance(value, bool) else value)
            for key, value in ((key, args.get(key)) for key in names)
        }
        return [dict(row) for row in connection.execute(sql, bound).fetchall()]

    def _one(self, connection: sqlite3.Connection, name: str, args: Mapping[str, object]) -> Row | None:
        rows = self._run(connection, name, args)
        return rows[0] if rows else None

    def _require(self, connection: sqlite3.Connection, wallet: str) -> Row:
        row = self._one(connection, "budget", {"wallet": wallet})
        if row is None:
            raise BudgetError(f"{short_wallet(wallet)} has no budget in {self._path}")
        return row

    def now(self) -> int:
        """The ledger's time, in milliseconds."""

        with self._read() as connection:
            row = self._one(connection, "now", {})
        assert row is not None
        return int(row["now"])

    def budget(self, name: str) -> Row | None:
        wallet = normalize_wallet(name)
        with self._read() as connection:
            return self._one(connection, "budget", {"wallet": wallet})

    def budgets(self) -> list[Row]:
        with self._read() as connection:
            return self._run(connection, "budgets", {})

    def create_budget(
        self,
        name: str,
        *,
        unit: str = "usd",
        cap: int,
        window_ms: int,
        per_payment: int | None = None,
        max_payments: int | None = None,
    ) -> Row:
        wallet = normalize_wallet(name)
        values = {
            "wallet": wallet,
            "unit": _rail(unit),
            "cap": units(cap, "cap", allow_zero=True),
            "window_ms": millis(window_ms, "window_ms", low=1),
            "per_payment": None if per_payment is None else units(per_payment, "per_payment"),
            "max_payments": None
            if max_payments is None
            else _whole(max_payments, "max_payments", 0, 2**62),
        }
        with self._transaction() as connection:
            if self._one(connection, "budget", {"wallet": wallet}) is not None:
                raise BudgetError(f"{short_wallet(wallet)} already has a budget in {self._path}")
            self._run(connection, "create_budget", values)
            return self._require(connection, wallet)

    def set_limits(self, name: str, **limits: int | None) -> Row:
        """The owner's change, up or down: a limit left out stays. What was spent keeps counting."""

        wallet = normalize_wallet(name)
        unknown = set(limits) - {"cap", "window_ms", "per_payment", "max_payments"}
        if unknown:
            raise BudgetError(f"set_limits takes cap, window_ms, per_payment and max_payments, not {sorted(unknown)}")
        cap, window_ms = limits.get("cap"), limits.get("window_ms")
        per_payment, max_payments = limits.get("per_payment"), limits.get("max_payments")
        values = {
            "wallet": wallet,
            "cap": None if cap is None else units(cap, "cap", allow_zero=True),
            "window_ms": None if window_ms is None else millis(window_ms, "window_ms", low=1),
            "keep_per_payment": "per_payment" not in limits,
            "per_payment": None if per_payment is None else units(per_payment, "per_payment"),
            "keep_max_payments": "max_payments" not in limits,
            "max_payments": None
            if max_payments is None
            else _whole(max_payments, "max_payments", 0, 2**62),
        }
        with self._transaction() as connection:
            self._require(connection, wallet)
            self._run(connection, "set_limits", values)
            return self._require(connection, wallet)

    def freeze(self, name: str) -> None:
        wallet = normalize_wallet(name)
        with self._transaction() as connection:
            self._require(connection, wallet)
            self._run(connection, "freeze", {"wallet": wallet})

    def unfreeze(self, name: str) -> None:
        wallet = normalize_wallet(name)
        with self._transaction() as connection:
            self._require(connection, wallet)
            self._run(connection, "unfreeze", {"wallet": wallet})

    def check(
        self, name: str, amount: int, *, limits: ProcessLimits | None = None
    ) -> tuple[BudgetRefused | None, int]:
        """Whether a hold of ``amount`` would be refused now, without holding it, and what is left."""

        wallet = normalize_wallet(name)
        own = limits or ProcessLimits()
        args = {
            "wallet": wallet,
            "amount": units(amount, "amount"),
            "p_per_payment": own.per_payment,
            "p_cap": own.cap,
            "p_window_ms": own.window_ms,
            "p_max_payments": own.max_payments,
        }
        with self._read() as connection:
            why = self._one(connection, "refusal", args)
            if why is None:
                raise BudgetError(f"{short_wallet(wallet)} has no budget in {self._path}")
            remaining = 0 if why["frozen_at"] is not None else max(why["cap"] - why["counted"], 0)
            if why["code"] is None:
                return None, remaining

            def open_ids() -> list[str]:
                rows = self._run(connection, "open_ids", {"wallet": wallet})
                return [str(row["payment"]) for row in rows]

            return refusal(why, units(amount, "amount"), own, open_ids), remaining

    def hold(
        self,
        name: str,
        amount: int,
        *,
        rail: str,
        payment: str | None = None,
        until: int | None = None,
        within_ms: int | None = None,
        info: str | None = None,
        limits: ProcessLimits | None = None,
    ) -> Row:
        """Admission: hold ``amount`` for a payment, or raise the BudgetRefused that says why.

        ``until`` (ms) or ``within_ms`` (from the ledger's now) bounds when it could settle.
        ``limits`` are the paying process's own, tighter ones. Holding an identity already in
        the ledger returns that payment if the wallet and amount match.
        """

        wallet = normalize_wallet(name)
        own = limits or ProcessLimits()
        args: dict[str, object] = {
            "wallet": wallet,
            "amount": units(amount, "amount"),
            "payment": None if payment is None else payment_id(payment),
            "until": None if until is None else millis(until, "until"),
            "within_ms": None if within_ms is None else millis(within_ms, "within_ms", low=1),
            "rail": _rail(rail),
            "info": _text(info, "info", _INFO_LIMIT),
            "p_per_payment": own.per_payment,
            "p_cap": own.cap,
            "p_window_ms": own.window_ms,
            "p_max_payments": own.max_payments,
        }
        with self._transaction() as connection:
            held = self._one(connection, "hold", args)
            if held is not None:
                return {**held, "state": "held", "created": True}
            why = self._one(connection, "refusal", args)
            if why is None:
                raise BudgetError(f"{short_wallet(wallet)} has no budget in {self._path}")
            if why["existing"] is not None:
                existing = json.loads(why["existing"])
                if existing["wallet"] == wallet and existing["amount"] == args["amount"]:
                    return {
                        "payment": args["payment"],
                        "at": None,
                        "until": None,
                        "state": existing["state"],
                        "created": False,
                    }
                raise BudgetError(
                    f"payment {args['payment']} is already in the ledger, for "
                    f"{format_amount(existing['amount'], why['unit'])} from "
                    f"{short_wallet(existing['wallet'])}"
                )
            if why["settles_too_soon"]:
                assert isinstance(args["until"], int)
                raise BudgetError(
                    f"settles_by {_iso(args['until'])} is not after now ({_iso(why['now'])}): "
                    "a payment can't settle before it is made"
                )
            if why["code"] is None:
                raise BudgetError("walletcap could not hold the payment, and the ledger gives no reason")

            def open_ids() -> list[str]:
                rows = self._run(connection, "open_ids", {"wallet": wallet})
                return [str(row["payment"]) for row in rows]

            assert isinstance(args["amount"], int)
            raise refusal(why, args["amount"], own, open_ids)

    def _move(
        self, statement: str, payment: str, args: Mapping[str, object], why: Callable[[Row], str | None]
    ) -> Row:
        key = payment_id(payment)
        with self._transaction() as connection:
            moved = self._one(connection, statement, {"payment": key, **args})
            current = self._one(connection, "payment", {"payment": key})
            if current is None:
                raise BudgetError(f"no payment {key} in {self._path}")
            if moved is None:
                reason = why(current)
                if reason is not None:
                    raise BudgetError(reason)
            return current

    def settle(self, payment: str, *, evidence: str | None = None) -> Row:
        """held or void -> settled, with the evidence. Idempotent."""

        return self._move(
            "settle", payment, {"evidence": _text(evidence, "evidence", _EVIDENCE_LIMIT)}, lambda _: None
        )

    def void(self, payment: str, *, evidence: str | None = None) -> Row:
        """held -> void: evidence that the payment never moved money. Settled stays settled."""

        def why(current: Row) -> str | None:
            if current["state"] == "settled":
                return f"payment {current['payment']} is settled; a settled payment can't be voided"
            return None

        return self._move(
            "void", payment, {"evidence": _text(evidence, "evidence", _EVIDENCE_LIMIT)}, why
        )

    def bound(self, payment: str, *, until: int | None = None, within_ms: int | None = None) -> Row:
        """held with no until -> held until ``until``, or ``within_ms`` from now. Kept once set."""

        if (until is None) == (within_ms is None):
            raise BudgetError("bound takes until or within_ms")
        args = {
            "until": None if until is None else millis(until, "until"),
            "within_ms": None if within_ms is None else millis(within_ms, "within_ms", low=1),
        }

        def why(current: Row) -> str | None:
            if current["state"] == "held" and current["until"] is None and until is not None:
                return f"settles_by {_iso(until)} is not after now: a payment can't settle before it is made"
            return None

        return self._move("bound", payment, args, why)

    def note(self, payment: str, outcome: str, *, evidence: str | None = None) -> Row:
        """Note a held payment's outcome: 'unknown' or 'refused'. It counts the same."""

        if outcome not in ("unknown", "refused"):
            raise BudgetError("outcome is 'unknown' or 'refused'")
        args = {"outcome": outcome, "evidence": _text(evidence, "evidence", _EVIDENCE_LIMIT)}
        return self._move("note", payment, args, lambda _: None)

    def payment(self, payment: str) -> Row | None:
        key = payment_id(payment)
        with self._read() as connection:
            return self._one(connection, "payment", {"payment": key})

    def status(self, name: str) -> Row:
        wallet = normalize_wallet(name)
        with self._read() as connection:
            row = self._one(connection, "status", {"wallet": wallet})
        if row is None:
            raise BudgetError(f"{short_wallet(wallet)} has no budget in {self._path}")
        return row

    def history(self, name: str, *, limit: int = 20) -> list[Row]:
        wallet = normalize_wallet(name)
        rows = _whole(limit, "limit", 1, 1_000_000)
        with self._read() as connection:
            return self._run(connection, "history", {"wallet": wallet, "limit": rows})

    def counting(self, name: str, *, held_only: bool = False) -> list[Row]:
        wallet = normalize_wallet(name)
        with self._read() as connection:
            return self._run(connection, "counting", {"wallet": wallet, "held_only": held_only})

    def void_unknown(
        self,
        name: str,
        older_than_ms: int,
        *,
        evidence: str = "released by its owner: unknown or refused outcome",
    ) -> list[Row]:
        """The owner's bulk release: void every held payment of unknown or refused outcome.

        Only those held at least ``older_than_ms`` ago that can no longer settle: their until
        has passed, or, with none, they are ``UNBOUNDED_HOLD_MS`` old.
        """

        wallet = normalize_wallet(name)
        age = millis(older_than_ms, "older_than_ms")
        with self._transaction() as connection:
            self._require(connection, wallet)
            return self._run(
                connection,
                "void_unknown",
                {"wallet": wallet, "older_than_ms": age, "evidence": _text(evidence, "evidence", _EVIDENCE_LIMIT)},
            )


def _script(connection: sqlite3.Connection, sql: str) -> None:
    """Run a section statement by statement, inside the caller's transaction.

    executescript() would commit first; sqlite3.complete_statement() finds each end, triggers
    included.
    """

    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement and not all(
                part.strip().startswith("--") or not part.strip() for part in statement.splitlines()
            ):
                connection.execute(statement)
            buffer = ""
    if buffer.strip() and not all(
        part.strip().startswith("--") or not part.strip() for part in buffer.splitlines()
    ):
        raise BudgetError("spec: a section ends inside a statement")
