# SPDX-License-Identifier: Apache-2.0
"""One spend budget per wallet, counted across every process, key, permission and rail.

Agent payment kits count "spent so far" per process, per key, per permission or
per period, so a restart, a second replica, one more key or the next period
starts the count again. This budget is counted per wallet, in a file every
process on the host shares, over a rolling window. Changing a limit never
resets what has been spent, a restart can lower a limit but never raise one,
and if the count cannot be read, nothing is paid::

    from walletcap import open_budget

    # The owner creates the budget once: walletcap set --wallet <address> --per-day 150
    budget = open_budget(agent_address, per_payment="$50", per_day="$150")
    with budget.pay("$12.50", to=payee) as payment:
        payment.tx = send_usdc(payee, "12.50")
"""

from __future__ import annotations

import enum
import json
import shlex
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import Any, Final

from walletcap.errors import BudgetError, BudgetWarning, NotSent, PaymentNotRecorded
from walletcap.ledger import Ledger, Row, merged_note_of
from walletcap.money import (
    DAY_MS,
    HOUR_MS,
    WEEK_MS,
    default_budget_path,
    describe_limits,
    expand_home,
    format_usd,
    format_window,
    limit_flags,
    normalize_wallet,
    short_wallet,
    to_micros,
    to_window_ms,
)

__all__ = [
    "UNSET",
    "Budget",
    "Check",
    "Hold",
    "Payment",
    "Paying",
    "Reservation",
    "Status",
    "open_budget",
]


class _Unset(enum.Enum):
    UNSET = enum.auto()


UNSET: Final = _Unset.UNSET
"""A limit left out: no opinion, as opposed to None (no limit)."""

_OPEN: Final = 2**63 - 1

_TO_LIMIT = 256
_NOTE_LIMIT = 1024


@dataclass(frozen=True)
class Check:
    """Whether an amount would be paid right now. Amounts are micro-dollars."""

    ok: bool
    remaining: int
    reason: str | None = None
    message: str | None = None
    brief: str | None = None


@dataclass(frozen=True)
class Status:
    """What a wallet has spent, has in flight and has left. Amounts are micro-dollars."""

    wallet: str
    path: Path
    cap: int
    window_ms: int
    per_payment: int | None
    max_payments: int | None
    spent: int
    in_flight: int
    remaining: int
    payments: int
    frozen: bool

    @property
    def summary(self) -> str:
        window = format_window(self.window_ms)
        parts = [
            f"{short_wallet(self.wallet)}: {format_usd(self.spent)} spent of "
            f"{format_usd(self.cap)} per {window}, {format_usd(self.remaining)} left"
        ]
        if self.in_flight > 0:
            parts.append(f"{format_usd(self.in_flight)} in flight")
        if self.per_payment is not None:
            parts.append(f"at most {format_usd(self.per_payment)} a payment")
        if self.max_payments is not None:
            parts.append(f"at most {self.max_payments} payments per {window}")
        if self.frozen:
            parts.append("FROZEN")
        return " · ".join(parts)


@dataclass(frozen=True)
class Payment:
    """One entry of a wallet's history. ``amount`` is micro-dollars."""

    id: str
    amount: int
    status: str
    counting: bool
    at: datetime
    rail: str
    to: str | None
    note: str | None
    tx: str | None


@dataclass(frozen=True)
class Hold:
    """An open payment that still counts against the budget. ``amount`` is micro-dollars.

    ``reason`` is ``"in flight"`` (no outcome yet), ``"refused"`` (the payee
    said it failed, but may still hold the authorization) or ``"unknown"``
    (the payment call failed after the money may have left). ``until`` is when
    it stops counting, or None if only a release ends it.
    """

    id: str
    amount: int
    reason: str
    at: datetime
    age_ms: int
    until: datetime | None
    rail: str
    to: str | None
    note: str | None
    error: str | None


def _limits(
    *,
    per_payment: object,
    per_hour: object,
    per_day: object,
    per_week: object,
    cap: object,
    window: object,
    max_payments: object,
) -> dict[str, Any]:
    """The limits named, in budget units: absent keys have no opinion."""

    limits: dict[str, Any] = {}
    named = {
        key: value
        for key, value in (("per_hour", per_hour), ("per_day", per_day), ("per_week", per_week))
        if value is not None
    }
    explicit = cap is not None or window is not None
    if len(named) + (1 if explicit else 0) > 1:
        raise BudgetError("give one rolling limit: per_hour, per_day, per_week, or cap with window")
    if named:
        ((key, value),) = named.items()
        limits["cap"] = to_micros(value, key)
        limits["window_ms"] = {"per_hour": HOUR_MS, "per_day": DAY_MS, "per_week": WEEK_MS}[key]
    elif explicit:
        if cap is None or window is None:
            raise BudgetError("cap and window go together, like cap='$150', window='24h'")
        limits["cap"] = to_micros(cap, "cap")
        limits["window_ms"] = to_window_ms(window)
    if per_payment is not UNSET:
        limits["per_payment"] = (
            None if per_payment is None else to_micros(per_payment, "per_payment")
        )
        if limits["per_payment"] == 0:
            raise BudgetError("per_payment must be more than $0; to stop every payment, freeze")
    if max_payments is not UNSET:
        if max_payments is None:
            limits["max_payments"] = None
        elif type(max_payments) is int and max_payments >= 0:
            limits["max_payments"] = max_payments
        else:
            raise BudgetError("max_payments must be a whole number of payments")
    return limits


def _describe(to: str | None, note: str | None, details: dict[str, Any] | None) -> dict[str, Any]:
    if to is not None and (not isinstance(to, str) or len(to) > _TO_LIMIT):
        raise BudgetError(f"to must be a string of at most {_TO_LIMIT} characters")
    if note is not None and (not isinstance(note, str) or len(note) > _NOTE_LIMIT):
        raise BudgetError(f"note must be a string of at most {_NOTE_LIMIT} characters")
    if details is not None and not isinstance(details, dict):
        raise BudgetError("details must be a dict")
    info = {**(details or {}), "to": to, "note": note}
    return {key: value for key, value in info.items() if value is not None}


def _positive(micros: int) -> int:
    if micros == 0:
        raise BudgetError("the amount must be more than $0")
    return micros


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MILLISECOND = timedelta(milliseconds=1)


def _settles_by_ms(settles_by: object) -> int:
    """A timezone-aware datetime as milliseconds since the epoch, rounded up.

    A naive datetime would be read as this machine's local time, hours from what
    the caller meant, so it is refused.
    """

    if not isinstance(settles_by, datetime) or settles_by.utcoffset() is None:
        raise BudgetError(
            "settles_by must be a timezone-aware datetime, "
            "like datetime.now(UTC) + timedelta(minutes=5)"
        )
    return -((_EPOCH - settles_by) // _MILLISECOND)


def _moment(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _counts_until(row: Row) -> datetime | None:
    """When a payment stops counting: its window's end, or None if only evidence ends it."""

    counts_from = row["counts_from"]
    if counts_from is None or counts_from == _OPEN:
        return None
    return _moment(counts_from + row["window_ms"])


def _label(row: Row, info: dict[str, Any]) -> str:
    if row["state"] == "settled":
        return "unknown" if info.get("outcome") == "unknown" else "settled"
    if row["state"] == "void":
        return "void"
    if not row["counting"]:
        return "expired"
    outcome = row["outcome"]
    return str(outcome) if outcome in ("refused", "unknown") else "in flight"


def _info(reference: str | None) -> dict[str, Any]:
    try:
        info = json.loads(reference) if reference else {}
    except ValueError:
        return {}
    return info if isinstance(info, dict) else {}


class Reservation:
    """An amount taken from the budget for one payment, until committed or released."""

    def __init__(self, ledger: Ledger, spend_id: str, amount: int, info: dict[str, Any]) -> None:
        self._ledger = ledger
        self._id = spend_id
        self._amount = amount
        self._info = info
        self._state = "open"
        self.tx: str | None = None
        """Set it inside ``with budget.pay(...)`` to keep the transaction hash in the history."""

    @property
    def id(self) -> str:
        """Unique per payment: a good idempotency key for the rail you pay through."""

        return self._id

    @property
    def amount(self) -> int:
        """In micro-dollars."""

        return self._amount

    @property
    def open(self) -> bool:
        return self._state == "open"

    def commit(
        self, *, tx: str | None = None, outcome: str | None = None, error: str | None = None
    ) -> None:
        """The payment settled. It counts for one rolling window from now.

        With a ``settles_by``, it counts at least until one window past it: a
        commit never shortens a hold.
        """

        if not self.open:
            raise BudgetError(f"reservation {self._id} is already {self._state}")
        tx = tx or self.tx
        info = {
            **self._info,
            **({"tx": tx} if tx else {}),
            **({"outcome": outcome} if outcome else {}),
            **({"error": error} if error else {}),
        }
        self._ledger.settle(self._id, evidence=tx)
        self._info = info
        self._state = "committed"

    def release(self) -> None:
        """The payment never left the wallet: give its amount back."""

        if not self.open:
            raise BudgetError(f"reservation {self._id} is already {self._state}")
        self._ledger.void(self._id, evidence="not sent")
        self._state = "released"

    def annotate(self, **fields: Any) -> None:
        """Note what is known about an open payment, like ``outcome="unknown"``.

        It keeps counting, as before.
        """

        if not self.open:
            return
        self._info = {**self._info, **fields}
        outcome = fields.get("outcome")
        if outcome is not None:
            error = fields.get("error")
            self._ledger.note(self._id, str(outcome), evidence=None if error is None else str(error))


class Paying:
    """``with budget.pay(amount):`` reserves on entry and records the payment on exit.

    A clean exit commits it; if that fails, it raises ``PaymentNotRecorded``,
    which is not a ``BudgetError``: don't pay again. An exception never settles
    it: the payment may have left the wallet, so it stays in flight, marked
    unknown, and counts until one window past ``settles_by``, or, without one,
    until its owner releases it. ``NotSent`` gives the amount back. Works with
    ``async with`` too.
    """

    def __init__(
        self,
        budget: Budget,
        amount: object,
        info: dict[str, Any],
        rail: str,
        settles_by: datetime | None,
    ) -> None:
        self._budget = budget
        self._amount = amount
        self._info = info
        self._rail = rail
        self._settles_by = settles_by
        self._reservation: Reservation | None = None

    def __enter__(self) -> Reservation:
        self._reservation = self._budget._reserve(
            self._amount, self._info, self._rail, self._settles_by
        )
        return self._reservation

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        reservation = self._reservation
        if reservation is None or not reservation.open:
            return
        if exc is None:
            try:
                reservation.commit()
            except BudgetError as error:
                raise PaymentNotRecorded(reservation.id, error) from error
            return
        try:
            if isinstance(exc, NotSent) or getattr(exc, "not_sent", False) is True:
                reservation.release()
            else:
                reservation.annotate(outcome="unknown", error=str(exc)[:200])
        except BudgetError:
            pass  # recording failed; the reservation stays open, and keeps counting

    async def __aenter__(self) -> Reservation:
        return self.__enter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.__exit__(exc_type, exc, traceback)


class Budget:
    """A wallet's budget in the shared file. Open it with ``open_budget``."""

    def __init__(
        self,
        wallet: str,
        *,
        path: str | Path | None = None,
        create: bool = False,
        per_payment: object = UNSET,
        per_hour: object = None,
        per_day: object = None,
        per_week: object = None,
        cap: object = None,
        window: object = None,
        max_payments: object = UNSET,
        busy_timeout_seconds: float = 30.0,
        on_warning: Callable[[str], None] | None = None,
    ) -> None:
        self._wallet = normalize_wallet(wallet)
        self._path = expand_home(path if path is not None else default_budget_path()).absolute()
        limits = _limits(
            per_payment=per_payment,
            per_hour=per_hour,
            per_day=per_day,
            per_week=per_week,
            cap=cap,
            window=window,
            max_payments=max_payments,
        )
        if not create and not self._path.exists():
            raise BudgetError(
                f"no budget file at {self._path}; its owner creates one with: "
                f"walletcap set --wallet {self._wallet}{self._path_flag()} "
                "--per-day <dollars>"
            )
        self._ledger = Ledger(self._path, busy_timeout_seconds=busy_timeout_seconds, create=create)
        self._ensure(limits, create=create, on_warning=on_warning)

    @property
    def wallet(self) -> str:
        """The name the budget is kept under: an EVM address, lowercased."""

        return self._wallet

    @property
    def path(self) -> Path:
        return self._path

    def _path_flag(self) -> str:
        default = expand_home(default_budget_path()).absolute()
        return "" if self._path == default else f" --path {shlex.quote(str(self._path))}"

    def _ensure(
        self, limits: dict[str, Any], *, create: bool, on_warning: Callable[[str], None] | None
    ) -> None:
        """Create the budget with ``limits``, or move its stored limits toward them.

        A tighter limit is stored; a looser one is reported and left alone. A restart can lower
        a limit, and only ``set_limits`` raises one.
        """

        row = self._ledger.budget(self._wallet)
        if row is None:
            name = short_wallet(self._wallet)
            if not create:
                raise BudgetError(f"{name} has no declared budget in {self._path}")
            if "cap" not in limits:
                raise BudgetError(
                    f"{name} has no budget yet: give it a rolling limit, like per_day='$150'"
                )
            self._ledger.create_budget(self._wallet, **limits)
            return
        if row["unit"] not in ("usd", "usdc"):
            raise BudgetError(f"{short_wallet(self._wallet)}'s budget counts in {row['unit']}, not usd")
        lowered: dict[str, int | None] = {}
        looser = False
        same_window = limits.get("window_ms", row["window_ms"]) == row["window_ms"]
        if "cap" in limits:
            if not same_window:
                looser = True
            elif limits["cap"] < row["cap"]:
                lowered["cap"] = limits["cap"]
            elif limits["cap"] > row["cap"]:
                looser = True
        if "per_payment" in limits:
            asked, stored = limits["per_payment"], row["per_payment"]
            if asked is not None and (stored is None or asked < stored):
                lowered["per_payment"] = asked
            elif stored is not None and (asked is None or asked > stored):
                looser = True
        if "max_payments" in limits and limits["max_payments"] != row["max_payments"]:
            asked, stored = limits["max_payments"], row["max_payments"]
            if same_window and asked is not None and (stored is None or asked < stored):
                lowered["max_payments"] = asked
            else:
                looser = True
        if lowered:
            row = self._ledger.set_limits(self._wallet, **lowered)
        if looser:
            self._warn_kept(on_warning, row, limits)

    def _warn_kept(
        self, on_warning: Callable[[str], None] | None, stored: Row, asked: dict[str, Any]
    ) -> None:
        kept = describe_limits(
            cap=stored["cap"],
            window_ms=stored["window_ms"],
            per_payment=stored["per_payment"],
            max_uses=stored["max_payments"],
        )
        wanted = {
            "cap": asked.get("cap"),
            "window_ms": asked.get("window_ms", stored["window_ms"]),
            "per_payment": asked.get("per_payment"),
            "max_uses": asked.get("max_payments"),
        }
        wanted_text = describe_limits(**wanted) or "no limit"
        merged = merged_note_of(stored["merged_from"])
        message = (
            f"walletcap: {short_wallet(self._wallet)} keeps its stored limits ({kept}); "
            f"your code asks for {wanted_text}. A restart can lower a limit but never raise one. "
            f"To raise it, its owner runs: walletcap set --wallet {self._wallet}"
            f"{self._path_flag()} {limit_flags(**wanted)}"
        ).rstrip() + ("" if merged is None else f". {merged}")
        if on_warning is not None:
            on_warning(message)
        else:
            warnings.warn(message, BudgetWarning, stacklevel=4)

    def check(self, amount: object) -> Check:
        """Whether ``amount`` would be paid right now, without taking it."""

        refusal, remaining = self._ledger.check(self._wallet, _positive(to_micros(amount)))
        if refusal is None:
            return Check(True, remaining)
        return Check(False, remaining, refusal.reason, str(refusal), refusal.brief)

    def reserve(
        self,
        amount: object,
        *,
        to: str | None = None,
        note: str | None = None,
        details: dict[str, Any] | None = None,
        rail: str = "python",
        settles_by: datetime | None = None,
    ) -> Reservation:
        """Take ``amount`` before paying, or raise ``BudgetRefused``.

        Commit the reservation when the payment settles; release it only if the
        payment never left the wallet. ``settles_by`` is the last moment the
        payment could still settle, if known, as a timezone-aware datetime after
        now: an open reservation stops counting one window after it.
        """

        return self._reserve(amount, _describe(to, note, details), rail, settles_by)

    def _reserve(
        self, amount: object, info: dict[str, Any], rail: str, settles_by: datetime | None
    ) -> Reservation:
        micros = _positive(to_micros(amount))
        settles_by_ms = None if settles_by is None else _settles_by_ms(settles_by)
        held = self._ledger.hold(
            self._wallet,
            micros,
            rail=rail,
            info=json.dumps(info) if info else None,
            until=settles_by_ms,
        )
        return Reservation(self._ledger, str(held["payment"]), micros, info)

    def pay(
        self,
        amount: object,
        *,
        to: str | None = None,
        note: str | None = None,
        details: dict[str, Any] | None = None,
        rail: str = "python",
        settles_by: datetime | None = None,
    ) -> Paying:
        """``with budget.pay("$12.50"):`` reserve, pay inside the block, and record it.

        Raises ``BudgetRefused`` on entry if the budget would be passed. If the
        block raises, the payment stays in flight, marked unknown: it counts
        until one window past ``settles_by``, or, without one, until its owner
        releases it. ``NotSent`` gives the amount back.
        """

        return Paying(self, amount, _describe(to, note, details), rail, settles_by)

    def status(self) -> Status:
        row = self._ledger.status(self._wallet)
        return Status(
            self._wallet,
            self._path,
            row["cap"],
            row["window_ms"],
            row["per_payment"],
            row["max_payments"],
            row["spent"],
            row["in_flight"],
            row["remaining"],
            row["payments"],
            row["frozen_at"] is not None,
        )

    def set_limits(
        self,
        *,
        per_payment: object = UNSET,
        per_hour: object = None,
        per_day: object = None,
        per_week: object = None,
        cap: object = None,
        window: object = None,
        max_payments: object = UNSET,
    ) -> Status:
        """Change the limits, up or down. What was spent keeps counting: nothing resets."""

        limits = _limits(
            per_payment=per_payment,
            per_hour=per_hour,
            per_day=per_day,
            per_week=per_week,
            cap=cap,
            window=window,
            max_payments=max_payments,
        )
        if not limits:
            raise BudgetError("set_limits needs a limit, like per_day='$150'")
        self._ledger.set_limits(self._wallet, **limits)
        return self.status()

    def freeze(self) -> None:
        """Refuse every payment from this wallet, on every rail and in every process."""

        self._ledger.freeze(self._wallet)

    def unfreeze(self) -> None:
        self._ledger.unfreeze(self._wallet)

    def holds(self) -> list[Hold]:
        """The open payments that still count, oldest first, and why each is open.

        Its owner releases one that never left the wallet: ``walletcap release <id>``.
        """

        holds = []
        for row in self._ledger.counting(self._wallet, held_only=True):
            info = _info(row["info"])
            outcome = row["outcome"]
            holds.append(
                Hold(
                    row["payment"],
                    row["amount"],
                    outcome if outcome in ("refused", "unknown") else "in flight",
                    _moment(row["held_at"]),
                    max(row["now"] - row["held_at"], 0),
                    _counts_until(row),
                    row["rail"],
                    info.get("to") or info.get("payTo"),
                    info.get("note") or info.get("network"),
                    row["noted"] or info.get("error"),
                )
            )
        return holds

    def history(self, limit: int = 20) -> list[Payment]:
        """The newest payments first."""

        payments = []
        for row in self._ledger.history(self._wallet, limit=limit):
            info = _info(row["info"])
            payments.append(
                Payment(
                    row["payment"],
                    row["amount"],
                    _label(row, info),
                    bool(row["counting"]),
                    _moment(row["held_at"]),
                    row["rail"],
                    info.get("to") or info.get("payTo"),
                    info.get("note") or info.get("network"),
                    row["settled_by"] or info.get("tx"),
                )
            )
        return payments

    def close(self) -> None:
        """Nothing to close: the ledger opens a connection per operation."""

    def __enter__(self) -> Budget:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def open_budget(wallet: str, **options: Any) -> Budget:
    """Open the wallet's budget. Its owner creates it first with ``walletcap set``.

    Pass ``create=True`` only to create it on first use (a demo or a first-run
    setup); by default a missing file refuses every payment. Limits are dollars:
    strings (``"$150"``, ``"12.50 USDC"``), ints, floats or Decimals. Give one
    rolling limit (``per_hour``, ``per_day``, ``per_week``, or ``cap`` with
    ``window``) and optionally ``per_payment`` and ``max_payments``.
    """

    return Budget(wallet, **options)

