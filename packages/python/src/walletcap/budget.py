# SPDX-License-Identifier: Apache-2.0
"""The payer's handle: one wallet's budget, counted across every process, key, permission and rail.

Agent payment kits count "spent so far" per process, per key, per permission or per period, so
a restart, a second replica, one more key or the next period starts the count again. This
budget is counted per wallet, in a file every process on the host shares, over a rolling
window. Changing a limit never resets what has been spent, the limits a payer passes only
tighten things for its own process, and if the count cannot be read, nothing is paid::

    from walletcap import open_budget

    # The owner creates the budget once: walletcap set --wallet <address> --per-day 150
    budget = open_budget(agent_address)
    with budget.pay("$12.50", to=payee) as payment:
        payment.tx = send_usdc(payee, "12.50")

Changing limits, freezing and voiding or settling by id are the owner's (``walletcap.owner``).
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import enum
import functools
import json
import os
import shlex
import subprocess
import threading
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import Any, Final, Literal, TypeVar, cast

from walletcap._decisions import DecisionLog, decision_log_file
from walletcap._ledger import Ledger, ProcessLimits, Row, held_elsewhere, merged_note_of
from walletcap.errors import (
    BudgetRefused,
    BudgetUnavailable,
    BudgetWarning,
    NotSent,
    PaymentNotRecorded,
    RefusalCode,
    RefusalSource,
    UsageError,
)
from walletcap.money import (
    DAY_MS,
    HOUR_MS,
    WEEK_MS,
    Dollars,
    Micros,
    Window,
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
    "Budget",
    "Check",
    "Decision",
    "HeldPayment",
    "Hold",
    "Paying",
    "Payment",
    "PaymentRecord",
    "Status",
    "open_budget",
]


class _Unset(enum.Enum):
    UNSET = enum.auto()


UNSET: Final = _Unset.UNSET
"""A limit left out: no opinion, as opposed to None (no limit)."""

_OPEN: Final = 2**63 - 1
_EVIDENCE_LIMIT: Final = 1024
_MAX_COUNT: Final = 2**63 - 1  # what fits in SQLite's 64-bit integers

PaymentState = Literal["held", "settled", "void"]
"""A payment's state in the ledger: ``held``, ``settled`` or ``void``."""

Outcome = Literal["unknown", "refused"]
"""What is known about a held payment: the call failed (``unknown``) or the payee said it failed."""

PaymentStatus = Literal["settled", "in flight", "refused", "unknown", "expired", "void"]
"""How the history shows a payment."""

HoldReason = Literal["in flight", "unknown", "refused"]
"""Why a held payment is still open."""
_TO_LIMIT = 256
_NOTE_LIMIT = 1024


@dataclass(frozen=True)
class Check:
    """Whether an amount would be paid right now."""

    ok: bool
    remaining: Micros
    code: RefusalCode | None = None
    source: RefusalSource | None = None
    message: str | None = None
    brief: str | None = None


@dataclass(frozen=True)
class Status:
    """What a wallet has spent, has in flight and has left."""

    wallet: str
    path: Path
    cap: Micros
    window_ms: int
    per_payment: Micros | None
    max_payments: int | None
    spent: Micros
    in_flight: Micros
    remaining: Micros
    payments: int
    frozen: bool

    @property
    def summary(self) -> str:
        window = format_window(self.window_ms)
        parts = [
            (
                f"{short_wallet(self.wallet)}: {format_usd(self.spent)} spent of "
                f"{format_usd(self.cap)} per {window}, {format_usd(self.remaining)} left"
            )
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
    """One entry of a wallet's history."""

    id: str
    amount: Micros
    status: PaymentStatus
    counting: bool
    at: datetime
    rail: str
    to: str | None
    note: str | None
    tx: str | None


@dataclass(frozen=True)
class PaymentRecord(Payment):
    """One payment as its owner sees it: also its wallet, state and how long it counts."""

    wallet: str = ""
    state: PaymentState = "held"
    settles_by: datetime | None = None
    counts_until: datetime | None = None


@dataclass(frozen=True)
class HeldPayment:
    """A held payment that still counts against the budget.

    ``reason`` is ``"in flight"`` (no outcome yet), ``"refused"`` (the payee said it failed,
    but may still hold the authorization) or ``"unknown"`` (the payment call failed after the
    money may have left). ``counts_until`` is when it stops counting, or None if only
    evidence ends it.
    """

    id: str
    amount: Micros
    reason: HoldReason
    at: datetime
    age_ms: int
    settles_by: datetime | None
    counts_until: datetime | None
    rail: str
    to: str | None
    note: str | None
    error: str | None


@dataclass(frozen=True)
class Decision:
    """One decision made through a payer's handle.

    What ``on_decision`` is called with, and one line of the ``WALLETCAP_LOG`` file. Every field
    is always there, None where it doesn't apply.

    ``decision`` is ``"held"`` (a hold was admitted), ``"refused"`` (the budget refused a
    payment) or ``"bound"``, ``"noted"``, ``"settled"`` or ``"void"`` (a hold this handle took
    moved). ``at`` is the ledger's time for it. ``amount`` is micro-dollars: for a refusal, what
    was asked. ``id`` is the payment's, and None for a refusal, which made no payment. ``code``,
    ``source`` and ``brief`` are a refusal's: ``brief`` says why, without the ids of other
    payments. ``outcome`` is what a ``"noted"`` decision noted, ``settles_by`` the last moment
    the payment could settle, when it has one, and ``tx`` the evidence a ``"settled"`` decision
    was recorded with, when it has any.
    """

    decision: Literal["held", "refused", "bound", "noted", "settled", "void"]
    at: datetime
    wallet: str
    amount: Micros | None
    id: str | None
    rail: str
    to: str | None = None
    code: RefusalCode | None = None
    source: RefusalSource | None = None
    brief: str | None = None
    outcome: Outcome | None = None
    settles_by: datetime | None = None
    tx: str | None = None


# --- Reading input ---------------------------------------------------------------------------


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
        raise UsageError("give one rolling limit: per_hour, per_day, per_week, or cap with window")
    if named:
        ((key, value),) = named.items()
        limits["cap"] = to_micros(value, key)
        limits["window_ms"] = {"per_hour": HOUR_MS, "per_day": DAY_MS, "per_week": WEEK_MS}[key]
    elif explicit:
        if cap is None or window is None:
            raise UsageError("cap and window go together, like cap='$150', window='24h'")
        limits["cap"] = to_micros(cap, "cap")
        limits["window_ms"] = to_window_ms(window)
    if per_payment is not UNSET:
        limits["per_payment"] = (
            None if per_payment is None else to_micros(per_payment, "per_payment")
        )
        if limits["per_payment"] == 0:
            raise UsageError("per_payment must be more than $0; to stop every payment, freeze")
    if max_payments is not UNSET:
        if max_payments is None:
            limits["max_payments"] = None
        elif type(max_payments) is int and 0 <= max_payments <= _MAX_COUNT:
            limits["max_payments"] = max_payments
        else:
            raise UsageError("max_payments must be a whole number of payments")
    return limits


def _describe(to: str | None, note: str | None, details: dict[str, Any] | None) -> dict[str, Any]:
    if to is not None and (not isinstance(to, str) or len(to) > _TO_LIMIT):
        raise UsageError(f"to must be a string of at most {_TO_LIMIT} characters")
    if note is not None and (not isinstance(note, str) or len(note) > _NOTE_LIMIT):
        raise UsageError(f"note must be a string of at most {_NOTE_LIMIT} characters")
    if details is not None and not isinstance(details, dict):
        raise UsageError("details must be a dict")
    info = {**(details or {}), "to": to, "note": note}
    return {key: value for key, value in info.items() if value is not None}


def _positive(micros: Micros) -> Micros:
    if micros == 0:
        raise UsageError("the amount must be more than $0")
    return micros


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MILLISECOND = timedelta(milliseconds=1)


def _moment_ms(moment: object, label: str) -> int:
    """A timezone-aware datetime as milliseconds since the epoch, rounded up.

    A naive datetime would be read as this machine's local time, hours from what the caller
    meant, so it is refused.
    """

    if not isinstance(moment, datetime) or moment.utcoffset() is None:
        raise UsageError(
            f"{label} must be a timezone-aware datetime, "
            "like datetime.now(UTC) + timedelta(minutes=5)"
        )
    return -((_EPOCH - moment) // _MILLISECOND)


def _duration_ms(duration: object, label: str) -> int:
    if not isinstance(duration, timedelta):
        raise UsageError(f"{label} must be a timedelta, like timedelta(minutes=5)")
    return -(-duration // _MILLISECOND)


def _error_text(error: BaseException) -> str:
    # A lone surrogate, from a payee's JSON say, can't be stored: it is replaced, not raised on.
    return str(error)[:200].encode("utf-8", "replace").decode("utf-8")


def _evidence(tx: object) -> str | None:
    """A transaction hash as the ledger keeps it, or None for anything that isn't one.

    web3.py returns a hash as bytes (HexBytes). Evidence that can't be kept is dropped, never a
    reason to leave a payment that paid unrecorded.
    """

    if isinstance(tx, bytes | bytearray):
        return "0x" + bytes(tx).hex()
    if isinstance(tx, str) and tx:
        return tx[:_EVIDENCE_LIMIT].encode("utf-8", "replace").decode("utf-8")
    return None


def _text_of(value: object) -> str | None:
    """A field of a payment's info, if it is the string it should be."""

    return value if isinstance(value, str) else None


# --- Views of the ledger's rows, shared with the owner's handle -------------------------------


# The ledger keeps times up to 10^15 ms, about the year 33,658; a datetime stops at 9999.
_LAST_MOMENT = datetime.max.replace(tzinfo=UTC)


def _moment(ms: int) -> datetime:
    try:
        return datetime.fromtimestamp(ms / 1000, tz=UTC)
    except (OverflowError, ValueError, OSError):
        return _LAST_MOMENT


def _info(text: str | None) -> dict[str, Any]:
    try:
        info = json.loads(text) if text else {}
    except (ValueError, RecursionError):
        return {}
    return info if isinstance(info, dict) else {}


def _settles_by(row: Row) -> datetime | None:
    return None if row["until"] is None else _moment(row["until"])


def _counts_until(row: Row) -> datetime | None:
    """When a payment stops counting: its window's end, or None if only evidence ends it."""

    counts_from = row["counts_from"]
    if counts_from is None or counts_from == _OPEN:
        return None
    return _moment(counts_from + row["window_ms"])


def _label(row: Row, info: dict[str, Any]) -> PaymentStatus:
    if row["state"] == "settled":
        return "unknown" if info.get("outcome") == "unknown" else "settled"
    if row["state"] == "void":
        return "void"
    if not row["counting"]:
        return "expired"
    outcome = row["outcome"]
    return cast("Outcome", outcome) if outcome in ("refused", "unknown") else "in flight"


def _payee(info: dict[str, Any]) -> str | None:
    """Who a payment's info says is paid, as JavaScript reads it: ``to``, else ``payTo``."""

    to = _text_of(info.get("to"))
    return _text_of(info.get("payTo")) if to is None else to


_BRIEF_LIMIT: Final = 1024
"""As much of a refusal's brief as a log line keeps, in both languages."""


def _refused(wallet: str, refusal: BudgetRefused, amount: Micros, request: _Request) -> Decision:
    """A refusal the ledger made, as a decision: dated with the ledger's time for it."""

    return Decision(
        "refused",
        datetime.now(UTC) if refusal._ledger_ms is None else _moment(refusal._ledger_ms),
        wallet,
        amount,
        None,
        request.rail,
        _payee(request.info),
        refusal.code,
        refusal.source,
        # The brief, never the message: the message names other payments, for their owner.
        refusal.brief[:_BRIEF_LIMIT],
    )


def _moved(
    decision: Literal["bound", "noted", "settled", "void"], row: Row, outcome: Outcome | None = None
) -> Decision:
    """A move the ledger appended, as a decision."""

    return Decision(
        decision,
        _moment(row["now"]),
        row["wallet"],
        Micros(row["amount"]),
        row["payment"],
        row["rail"],
        _payee(_info(row["info"])),
        outcome=outcome,
        settles_by=_settles_by(row),
        tx=row["settled_by"] if decision == "settled" else None,
    )


def payment_of(row: Row) -> Payment:
    """Internal: a history row as a Payment."""

    info = _info(row["info"])
    return Payment(
        row["payment"],
        Micros(row["amount"]),
        _label(row, info),
        bool(row["counting"]),
        _moment(row["held_at"]),
        row["rail"],
        _text_of(info.get("to")) or _text_of(info.get("payTo")),
        _text_of(info.get("note")) or _text_of(info.get("network")),
        row["settled_by"] or _text_of(info.get("tx")),
    )


def record_of(row: Row) -> PaymentRecord:
    """Internal: a payment row as its owner sees it."""

    payment = payment_of(row)
    return PaymentRecord(
        payment.id,
        payment.amount,
        payment.status,
        payment.counting,
        payment.at,
        payment.rail,
        payment.to,
        payment.note,
        payment.tx,
        row["wallet"],
        row["state"],
        _settles_by(row),
        _counts_until(row),
    )


def held_payment_of(row: Row) -> HeldPayment:
    """Internal: a counting row of a held payment."""

    info = _info(row["info"])
    outcome = row["outcome"]
    return HeldPayment(
        row["payment"],
        Micros(row["amount"]),
        outcome if outcome in ("refused", "unknown") else "in flight",
        _moment(row["held_at"]),
        max(row["now"] - row["held_at"], 0),
        _settles_by(row),
        _counts_until(row),
        row["rail"],
        _text_of(info.get("to")) or _text_of(info.get("payTo")),
        _text_of(info.get("note")) or _text_of(info.get("network")),
        row["noted"] or _text_of(info.get("error")),
    )


def status_of(row: Row, path: Path) -> Status:
    """Internal: a status row as a Status."""

    return Status(
        row["wallet"],
        path,
        Micros(row["cap"]),
        row["window_ms"],
        None if row["per_payment"] is None else Micros(row["per_payment"]),
        row["max_payments"],
        Micros(row["spent"]),
        Micros(row["in_flight"]),
        Micros(row["remaining"]),
        row["payments"],
        row["frozen_at"] is not None,
    )


def path_flag(path: Path) -> str:
    """Internal: `` --path <file>`` unless it is the default file, for commands a message names."""

    default = expand_home(default_budget_path()).absolute()
    if path == default:
        return ""
    quoted = subprocess.list2cmdline([str(path)]) if os.name == "nt" else shlex.quote(str(path))
    return f" --path {quoted}"


# --- The paying process's own limits ---------------------------------------------------------


def _process_limits(row: Row, asked: dict[str, Any]) -> tuple[ProcessLimits, bool]:
    """This process's limits that are tighter than the budget's, and whether any was looser.

    A looser limit does nothing. A limit in another window than the budget's binds as its own.
    """

    per_payment = cap = window_ms = max_payments = None
    looser = False
    if "per_payment" in asked:
        mine, stored = asked["per_payment"], row["per_payment"]
        if mine is None:
            looser = looser or stored is not None
        elif stored is None or int(mine) < stored:
            per_payment = mine
        elif int(mine) > stored:
            looser = True
    if "cap" in asked:
        if asked["window_ms"] != row["window_ms"] or int(asked["cap"]) < row["cap"]:
            cap, window_ms = asked["cap"], asked["window_ms"]
        elif int(asked["cap"]) > row["cap"]:
            looser = True
    if "max_payments" in asked:
        mine, stored = asked["max_payments"], row["max_payments"]
        window = asked.get("window_ms", row["window_ms"])
        if mine is None:
            looser = looser or stored is not None
        elif window != row["window_ms"] or stored is None or mine < stored:
            max_payments, window_ms = mine, window
        elif mine > stored:
            looser = True
    return ProcessLimits(per_payment, cap, window_ms, max_payments), looser


# --- The handles -----------------------------------------------------------------------------


class Hold:
    """One payment, held in the budget.

    Settle it when it settles, void it if it never left the wallet, and tell it how long it can
    still settle once you know. Every move is idempotent and only moves forward: held, then void
    or settled; void, then settled. Set ``tx`` inside ``with budget.pay(...)`` to keep the
    transaction hash with the settlement.
    """

    def __init__(
        self,
        ledger: Ledger,
        payment_id: str,
        amount: Micros,
        state: PaymentState,
        *,
        holder: str | None = None,
        decisions: DecisionLog | None = None,
    ) -> None:
        self._ledger = ledger
        self._id = payment_id
        self._amount = amount
        self._state = state
        self._holder = holder
        self._decisions = decisions
        self.tx: str | None = None

    def _moved(
        self,
        decision: Literal["bound", "noted", "settled", "void"],
        row: Row,
        outcome: Outcome | None = None,
    ) -> None:
        """What the ledger answered to a move: this handle's state, and a decision if it moved.

        A move already made is no decision.
        """

        self._state = row["state"]
        if row["moved"] and self._decisions is not None:
            self._decisions.record(_moved(decision, row, outcome))

    def _token(self, verb: str) -> str:
        """The token this hold's moves need; a hold for a payment another process took has none."""

        if self._holder is None:
            raise UsageError(held_elsewhere(self._id, verb))
        return self._holder

    @property
    def id(self) -> str:
        """The payment's identity in the ledger: a good idempotency key for its rail."""

        return self._id

    @property
    def amount(self) -> Micros:
        return self._amount

    @property
    def state(self) -> PaymentState:
        """The state this handle last saw: ``"held"``, ``"settled"`` or ``"void"``."""

        return self._state

    def settle(self, *, tx: str | None = None) -> None:
        """The payment settled. It counts through one window from now, or from its settle-by time.

        A settlement never shortens a hold. ``tx`` is the evidence, a transaction hash.
        """

        # Settling a payment this hold already settled is a no-op.
        row = self._ledger.settle(
            self._id, holder=self._token("settle"), evidence=_evidence(tx) or _evidence(self.tx)
        )
        self._moved("settled", row)

    def void(self, *, evidence: str | None = None) -> None:
        """The payment never left the wallet, and never will: it stops counting.

        ``evidence`` says how you know. A settled payment can't be voided.
        """

        row = self._ledger.void(
            self._id, holder=self._token("void"), evidence=evidence or "not sent"
        )
        self._moved("void", row)

    def settles_by(self, moment: datetime) -> None:
        """The last moment the payment could still settle, after now. A hold learns it once."""

        until = _moment_ms(moment, "settles_by")
        holder = self._token("bound")
        self._moved("bound", self._ledger.bound(self._id, holder=holder, until=until))

    def settles_within(self, duration: timedelta) -> None:
        """The same, as a time from now by the ledger's clock."""

        within = _duration_ms(duration, "settles_within")
        holder = self._token("bound")
        self._moved("bound", self._ledger.bound(self._id, holder=holder, within_ms=within))

    def note(self, outcome: Outcome, detail: str | None = None) -> None:
        """What is known about a held payment's outcome: ``"unknown"`` or ``"refused"``.

        It counts the same.
        """

        evidence = None if detail is None else detail[:1024]
        holder = self._token("note")
        row = self._ledger.note(self._id, outcome, holder=holder, evidence=evidence)
        self._moved("noted", row, outcome)

    async def asettle(self, *, tx: str | None = None) -> None:
        await asyncio.to_thread(lambda: self.settle(tx=tx))

    async def avoid(self, *, evidence: str | None = None) -> None:
        await asyncio.to_thread(lambda: self.void(evidence=evidence))

    async def asettles_by(self, moment: datetime) -> None:
        await asyncio.to_thread(self.settles_by, moment)

    async def asettles_within(self, duration: timedelta) -> None:
        await asyncio.to_thread(self.settles_within, duration)

    async def anote(self, outcome: Outcome, detail: str | None = None) -> None:
        await asyncio.to_thread(self.note, outcome, detail)


_CANCELLED = "cancelled before paying"


class _Taken:
    """What a worker thread held, and whether its caller stopped waiting for it."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cancelled = False
        self.hold: Hold | None = None


def _void_cancelled(hold: Hold) -> None:
    if hold.state == "held":
        with contextlib.suppress(BudgetUnavailable, UsageError):
            hold.void(evidence=_CANCELLED)


_T = TypeVar("_T")


def _in_thread(function: Callable[..., _T], *args: object) -> asyncio.Future[_T]:
    """Start ``function(*args)`` in the loop's default executor now, as asyncio.to_thread would.

    ``ensure_future(to_thread(...))`` hands the call to a thread only once its task first runs:
    a loop that stops before then never makes the call. This hands it over before it returns.
    """

    loop = asyncio.get_running_loop()
    call = functools.partial(contextvars.copy_context().run, function, *args)
    return loop.run_in_executor(None, call)


async def _hold_in_thread(take: Callable[[], Hold]) -> Hold:
    """Hold in a worker thread, so a wait for the write lock never blocks the event loop.

    A thread can't be stopped. If the caller is cancelled first, the hold the worker takes is
    voided ("cancelled before paying": nothing was paid), by whichever of the two sees the
    other done, and the cancellation waits for that before it goes on. Without this, a
    cancelled ``async with budget.pay()`` left a held payment, with no outcome, that counted
    for good and that no bulk release could reach.
    """

    taken = _Taken()

    def worker() -> Hold:
        hold = take()
        with taken.lock:
            taken.hold = hold
            cancelled = taken.cancelled
        if cancelled:
            _void_cancelled(hold)
        return hold

    task = _in_thread(worker)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with taken.lock:
            taken.cancelled = True
            finished = taken.hold
        # The void is in a thread before this returns: a loop that stops next still sends it.
        cleanup: asyncio.Future[Any] = (
            task if finished is None else _in_thread(_void_cancelled, finished)
        )
        with contextlib.suppress(BaseException):
            await asyncio.shield(cleanup)
        raise


@dataclass
class _Request:
    amount: object
    info: dict[str, Any]
    rail: str
    settles_by: datetime | None
    settles_within: timedelta | None
    payment_id: str | None = field(default=None)


class Paying:
    """``with budget.pay(amount) as hold:`` holds on entry and records the payment on exit.

    A clean exit settles it, with ``hold.tx`` as evidence; if that fails, it raises
    ``PaymentNotRecorded``: don't pay again. An exception never settles it: the payment may have
    left the wallet, so it stays held, noted unknown, and counts until one window past its
    settle-by time, or, without one, until its owner voids it. ``NotSent`` voids it. Works with
    ``async with`` too, which waits for the ledger in a worker thread.
    """

    def __init__(self, budget: Budget, request: _Request) -> None:
        self._budget = budget
        self._request = request
        self._hold: Hold | None = None

    def __enter__(self) -> Hold:
        hold = self._budget._hold(self._request)
        self._hold = hold
        return hold

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        hold = self._hold
        if hold is None or hold.state == "settled":
            return
        # A block that voided its hold, then paid after all and says so with a transaction, is
        # settled, so the payment counts. A void hold with nothing to show stays void.
        if hold.state == "void" and (exc is not None or _evidence(hold.tx) is None):
            return
        if exc is None:
            try:
                hold.settle()
            except Exception as error:
                raise PaymentNotRecorded(hold.id, error) from error
            return
        # If recording fails too, whatever the reason, the payment stays held and keeps counting,
        # and the block's own exception is the one that leaves.
        with contextlib.suppress(Exception):
            # Only the NotSent class says so. An attribute named not_sent doesn't: an exception
            # built from a payee's error body could carry one. And it says so once, about the
            # innermost block it leaves: a block around that one may already have paid.
            if isinstance(exc, NotSent) and not exc._spent:
                exc._spent = True
                hold.void(evidence=f"not sent: {_error_text(exc)}")
            else:
                hold.note("unknown", _error_text(exc))

    async def __aenter__(self) -> Hold:
        # The ledger waits for another process's write lock in a worker thread, never on the
        # event loop. Cancelled before the body runs, the hold it took is voided.
        return await _hold_in_thread(self.__enter__)

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        # The record is in a thread before the first await, and can't be stopped once there: a
        # cancellation waits for it.
        task = _in_thread(self.__exit__, exc_type, exc, traceback)
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            with contextlib.suppress(BaseException):
                await asyncio.shield(task)
            raise


class Budget:
    """The payer's handle on a wallet's budget. Open it with ``open_budget``."""

    def __init__(
        self,
        wallet: str,
        *,
        path: str | Path | None = None,
        create: bool = False,
        per_payment: Dollars | _Unset | None = UNSET,
        per_hour: Dollars | None = None,
        per_day: Dollars | None = None,
        per_week: Dollars | None = None,
        cap: Dollars | None = None,
        window: Window | None = None,
        max_payments: int | _Unset | None = UNSET,
        busy_timeout_ms: int = 30_000,
        on_warning: Callable[[str], None] | None = None,
        on_decision: Callable[[Decision], object] | None = None,
    ) -> None:
        if on_decision is not None and not callable(on_decision):
            raise UsageError("on_decision must be a function")
        self._wallet = normalize_wallet(wallet)
        self._path = expand_home(path if path is not None else default_budget_path()).absolute()
        asked = _limits(
            per_payment=per_payment,
            per_hour=per_hour,
            per_day=per_day,
            per_week=per_week,
            cap=cap,
            window=window,
            max_payments=max_payments,
        )
        # Fail closed: a missing budget file refuses every payment until its owner creates it.
        if not create and not self._path.exists():
            raise BudgetUnavailable(
                f"no budget file at {self._path}; its owner creates one with: "
                f"walletcap set --wallet {self._wallet}{path_flag(self._path)} --per-day <dollars>"
            )
        self._ledger = Ledger(self._path, busy_timeout_ms=busy_timeout_ms, create=create)
        row = self._ledger.budget(self._wallet)
        if row is None:
            if not create:
                raise BudgetUnavailable(
                    f"{short_wallet(self._wallet)} has no budget in {self._path}; its owner "
                    f"creates one with: walletcap set --wallet {self._wallet}"
                    f"{path_flag(self._path)} --per-day <dollars>"
                )
            if "cap" not in asked:
                raise UsageError(
                    f"{short_wallet(self._wallet)} has no budget yet: "
                    "give it a rolling limit, like per_day='$150'"
                )
            row = self._ledger.create_budget(self._wallet, **asked)
        if row["unit"] not in ("usd", "usdc"):
            raise UsageError(
                f"{short_wallet(self._wallet)}'s budget counts in {row['unit']}, not usd"
            )
        self._limits, looser = _process_limits(row, asked)
        if looser:
            self._warn_looser(on_warning, row, asked)
        # The log file is the one WALLETCAP_LOG names now, as the budget file is the one the path
        # names now.
        self._decisions = DecisionLog(on_decision, decision_log_file())

    @property
    def wallet(self) -> str:
        """The name the budget is kept under: an EVM address, lowercased."""

        return self._wallet

    @property
    def path(self) -> Path:
        return self._path

    def _warn_looser(
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
            f"your code asks for {wanted_text}. A process can tighten the limits for itself, "
            f"never loosen them. To raise them, its owner runs: walletcap set --wallet "
            f"{self._wallet}{path_flag(self._path)} {limit_flags(**wanted)}"
        ).rstrip() + ("" if merged is None else f". {merged}")
        if on_warning is not None:
            on_warning(message)
        else:
            warnings.warn(message, BudgetWarning, stacklevel=4)

    def check(self, amount: object) -> Check:
        """Whether ``amount`` would be paid right now, without holding it."""

        refusal, remaining = self._ledger.check(
            self._wallet, _positive(to_micros(amount)), limits=self._limits
        )
        if refusal is None:
            return Check(ok=True, remaining=Micros(remaining))
        return Check(
            ok=False,
            remaining=Micros(remaining),
            code=refusal.code,
            source=refusal.source,
            message=str(refusal),
            brief=refusal.brief,
        )

    def hold(
        self,
        amount: object,
        *,
        id: str | None = None,  # noqa: A002 - the same name as in JavaScript
        to: str | None = None,
        note: str | None = None,
        details: dict[str, Any] | None = None,
        rail: str = "python",
        settles_by: datetime | None = None,
        settles_within: timedelta | None = None,
    ) -> Hold:
        """Hold ``amount`` before paying, or raise ``BudgetRefused``.

        Settle the hold when the payment settles; void it only if the payment never left. An id
        is one payment, held once: an id already in the ledger raises ``UsageError``, whose
        ``payment_state`` says where it stands, and a process that restarts looks its payment up
        with ``payment(id)``. ``settles_by`` (a timezone-aware datetime after now) or
        ``settles_within`` (a timedelta) bounds how long it can still settle.
        """

        return self._hold(
            _Request(amount, _describe(to, note, details), rail, settles_by, settles_within, id)
        )

    def _hold(self, request: _Request) -> Hold:
        micros = _positive(to_micros(request.amount))
        try:
            held = self._ledger.hold(
                self._wallet,
                micros,
                rail=request.rail,
                payment=request.payment_id,
                info=json.dumps(request.info) if request.info else None,
                until=None
                if request.settles_by is None
                else _moment_ms(request.settles_by, "settles_by"),
                within_ms=None
                if request.settles_within is None
                else _duration_ms(request.settles_within, "settles_within"),
                limits=self._limits,
            )
        except BudgetRefused as refusal:
            # Only a refusal is a decision: a call that was wrong, or a file that can't be read,
            # decided nothing.
            self._decisions.record(_refused(self._wallet, refusal, micros, request))
            raise
        payment_id = str(held["payment"])
        self._decisions.record(
            Decision(
                "held",
                _moment(held["at"]),
                self._wallet,
                micros,
                payment_id,
                request.rail,
                _payee(request.info),
                settles_by=None if held["until"] is None else _moment(held["until"]),
            )
        )
        return Hold(
            self._ledger,
            payment_id,
            micros,
            cast("PaymentState", held["state"]),
            holder=held["holder"],
            decisions=self._decisions,
        )

    def payment(self, payment_id: str) -> PaymentRecord | None:
        """One of this wallet's payments, by its id, or None.

        How a process that restarts finds out what happened to a payment it held, instead of
        holding the id again.
        """

        row = self._ledger.payment(payment_id)
        return None if row is None or row["wallet"] != self._wallet else record_of(row)

    async def apayment(self, payment_id: str) -> PaymentRecord | None:
        return await asyncio.to_thread(self.payment, payment_id)

    def pay(
        self,
        amount: object,
        *,
        id: str | None = None,  # noqa: A002 - the same name as in JavaScript
        to: str | None = None,
        note: str | None = None,
        details: dict[str, Any] | None = None,
        rail: str = "python",
        settles_by: datetime | None = None,
        settles_within: timedelta | None = None,
    ) -> Paying:
        """``with budget.pay("$12.50") as hold:`` hold, pay inside the block, and record it.

        Raises ``BudgetRefused`` on entry if the budget would be passed, and ``UsageError`` if
        ``id`` names a payment already in the ledger, so nothing is paid twice. If the block
        raises, the payment stays held, noted unknown: it counts until one window past its
        settle-by time, or, without one, until its owner voids it. ``NotSent`` voids it.
        """

        return Paying(
            self,
            _Request(amount, _describe(to, note, details), rail, settles_by, settles_within, id),
        )

    def status(self) -> Status:
        """What has been spent, what is in flight and what is left."""

        return status_of(self._ledger.status(self._wallet), self._path)

    def history(self, limit: int = 20) -> list[Payment]:
        """The newest payments first."""

        return [payment_of(row) for row in self._ledger.history(self._wallet, limit=limit)]

    def holds(self) -> list[HeldPayment]:
        """The held payments that still count, oldest first, and why each is open.

        Its owner voids one that never left the wallet: ``walletcap void <id>``.
        """

        return [held_payment_of(row) for row in self._ledger.counting(self._wallet, held_only=True)]

    # The same, for async code: each runs in a worker thread (asyncio.to_thread), so a wait for
    # another process's write lock never blocks the event loop. `async with budget.pay(...)`
    # does the same for a payment.

    async def acheck(self, amount: object) -> Check:
        return await asyncio.to_thread(self.check, amount)

    async def ahold(
        self,
        amount: object,
        *,
        id: str | None = None,  # noqa: A002 - the same name as in JavaScript
        to: str | None = None,
        note: str | None = None,
        details: dict[str, Any] | None = None,
        rail: str = "python",
        settles_by: datetime | None = None,
        settles_within: timedelta | None = None,
    ) -> Hold:
        request = _Request(
            amount, _describe(to, note, details), rail, settles_by, settles_within, id
        )
        return await _hold_in_thread(lambda: self._hold(request))

    async def astatus(self) -> Status:
        return await asyncio.to_thread(self.status)

    async def aholds(self) -> list[HeldPayment]:
        return await asyncio.to_thread(self.holds)

    async def ahistory(self, limit: int = 20) -> list[Payment]:
        return await asyncio.to_thread(self.history, limit)

    def close(self) -> None:
        """Nothing to close: the ledger opens a connection per operation."""

    def __enter__(self) -> Budget:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def open_budget(
    wallet: str,
    *,
    path: str | Path | None = None,
    create: bool = False,
    per_payment: Dollars | _Unset | None = UNSET,
    per_hour: Dollars | None = None,
    per_day: Dollars | None = None,
    per_week: Dollars | None = None,
    cap: Dollars | None = None,
    window: Window | None = None,
    max_payments: int | _Unset | None = UNSET,
    busy_timeout_ms: int = 30_000,
    on_warning: Callable[[str], None] | None = None,
    on_decision: Callable[[Decision], object] | None = None,
) -> Budget:
    """Open the wallet's budget, to pay from it. Its owner creates it first with ``walletcap set``.

    Pass ``create=True`` only to create it on first use (a demo or a first-run setup); by
    default a missing file refuses every payment. Limits are dollars: strings (``"$150"``,
    ``"12.50 USDC"``), ints, floats, Decimals or ``Micros``. Limits given here only tighten the
    budget's, for this process: ``per_hour``, ``per_day``, ``per_week``, or ``cap`` with
    ``window``, and ``per_payment`` and ``max_payments``.

    ``on_decision`` is called with a ``Decision`` once for every decision made through this
    handle: a hold admitted (``"held"``), a payment the budget refused (``"refused"``), and each
    move of a hold this handle took (``"bound"``, ``"noted"``, ``"settled"``, ``"void"``). It is
    called after the ledger has answered, in the thread that asked it, so nothing it does changes
    a decision: what it raises is swallowed, with one ``BudgetWarning`` for the handle.
    ``check()`` and reads report nothing. If the environment variable ``WALLETCAP_LOG`` names a
    file when the budget is opened, each decision is also appended to it, as one line of JSON.
    """

    return Budget(
        wallet,
        path=path,
        create=create,
        per_payment=per_payment,
        per_hour=per_hour,
        per_day=per_day,
        per_week=per_week,
        cap=cap,
        window=window,
        max_payments=max_payments,
        busy_timeout_ms=busy_timeout_ms,
        on_warning=on_warning,
        on_decision=on_decision,
    )
