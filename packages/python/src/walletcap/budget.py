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
import enum
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
from typing import Any, Final

from walletcap._ledger import Ledger, ProcessLimits, Row, held_elsewhere, merged_note_of
from walletcap.errors import (
    BudgetUnavailable,
    BudgetWarning,
    NotSent,
    PaymentNotRecorded,
    UsageError,
)
from walletcap.money import (
    DAY_MS,
    HOUR_MS,
    WEEK_MS,
    Micros,
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
_TO_LIMIT = 256
_NOTE_LIMIT = 1024


@dataclass(frozen=True)
class Check:
    """Whether an amount would be paid right now."""

    ok: bool
    remaining: Micros
    code: str | None = None
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
    status: str
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
    state: str = "held"
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
    reason: str
    at: datetime
    age_ms: int
    settles_by: datetime | None
    counts_until: datetime | None
    rail: str
    to: str | None
    note: str | None
    error: str | None


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
        elif type(max_payments) is int and max_payments >= 0:
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
    return str(error)[:200]


# --- Views of the ledger's rows, shared with the owner's handle -------------------------------


def _moment(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _info(text: str | None) -> dict[str, Any]:
    try:
        info = json.loads(text) if text else {}
    except ValueError:
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


def _label(row: Row, info: dict[str, Any]) -> str:
    if row["state"] == "settled":
        return "unknown" if info.get("outcome") == "unknown" else "settled"
    if row["state"] == "void":
        return "void"
    if not row["counting"]:
        return "expired"
    outcome = row["outcome"]
    return str(outcome) if outcome in ("refused", "unknown") else "in flight"


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
        info.get("to") or info.get("payTo"),
        info.get("note") or info.get("network"),
        row["settled_by"] or info.get("tx"),
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
        info.get("to") or info.get("payTo"),
        info.get("note") or info.get("network"),
        row["noted"] or info.get("error"),
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
        elif stored is None or mine < stored:
            per_payment = mine
        elif mine > stored:
            looser = True
    if "cap" in asked:
        if asked["window_ms"] != row["window_ms"] or asked["cap"] < row["cap"]:
            cap, window_ms = asked["cap"], asked["window_ms"]
        elif asked["cap"] > row["cap"]:
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
        state: str,
        *,
        created: bool,
        holder: str | None = None,
    ) -> None:
        self._ledger = ledger
        self._id = payment_id
        self._amount = amount
        self._state = state
        self._created = created
        self._holder = holder
        self.tx: str | None = None

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
    def state(self) -> str:
        """The state this handle last saw: ``"held"``, ``"settled"`` or ``"void"``."""

        return self._state

    @property
    def created(self) -> bool:
        """False when the id was already in the ledger, for this wallet and amount."""

        return self._created

    def settle(self, *, tx: str | None = None) -> None:
        """The payment settled. It counts through one window from now, or from its settle-by time.

        A settlement never shortens a hold. ``tx`` is the evidence, a transaction hash.
        """

        # Settling a payment that is already settled is a no-op, with or without the token.
        self._state = self._ledger.settle(self._id, holder=self._holder, evidence=tx or self.tx)[
            "state"
        ]

    def void(self, *, reason: str | None = None) -> None:
        """The payment never left the wallet, and never will: it stops counting.

        A settled payment can't be voided.
        """

        row = self._ledger.void(self._id, holder=self._token("void"), evidence=reason or "not sent")
        self._state = row["state"]

    def settles_by(self, moment: datetime) -> None:
        """The last moment the payment could still settle, after now. A hold learns it once."""

        until = _moment_ms(moment, "settles_by")
        holder = self._token("bound")
        self._state = self._ledger.bound(self._id, holder=holder, until=until)["state"]

    def settles_within(self, duration: timedelta) -> None:
        """The same, as a time from now by the ledger's clock."""

        within = _duration_ms(duration, "settles_within")
        holder = self._token("bound")
        self._state = self._ledger.bound(self._id, holder=holder, within_ms=within)["state"]

    def note(self, outcome: str, detail: str | None = None) -> None:
        """What is known about a held payment's outcome: ``"unknown"`` or ``"refused"``.

        It counts the same.
        """

        evidence = None if detail is None else detail[:1024]
        holder = self._token("note")
        self._state = self._ledger.note(self._id, outcome, holder=holder, evidence=evidence)[
            "state"
        ]

    async def asettle(self, *, tx: str | None = None) -> None:
        await asyncio.to_thread(lambda: self.settle(tx=tx))

    async def avoid(self, *, reason: str | None = None) -> None:
        await asyncio.to_thread(lambda: self.void(reason=reason))

    async def anote(self, outcome: str, detail: str | None = None) -> None:
        await asyncio.to_thread(self.note, outcome, detail)


_CANCELLED = "cancelled before paying"


class _Taken:
    """What a worker thread held, and whether its caller stopped waiting for it."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cancelled = False
        self.hold: Hold | None = None


def _void_cancelled(hold: Hold) -> None:
    if hold.created and hold.state == "held":
        with contextlib.suppress(BudgetUnavailable, UsageError):
            hold.void(reason=_CANCELLED)


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

    task = asyncio.ensure_future(asyncio.to_thread(worker))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with taken.lock:
            taken.cancelled = True
            finished = taken.hold
        cleanup: asyncio.Future[Any] = (
            task
            if finished is None
            else asyncio.ensure_future(asyncio.to_thread(_void_cancelled, finished))
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
        if not hold.created:
            raise UsageError(
                f"payment {hold.id} is already in the ledger ({hold.state}); "
                "pay() doesn't make it again"
            )
        self._hold = hold
        return hold

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        hold = self._hold
        if hold is None or hold.state != "held":
            return
        if exc is None:
            try:
                hold.settle()
            except Exception as error:
                raise PaymentNotRecorded(hold.id, error) from error
            return
        # If recording fails too, the payment stays held and keeps counting.
        with contextlib.suppress(BudgetUnavailable, UsageError):
            if isinstance(exc, NotSent) or getattr(exc, "not_sent", False) is True:
                hold.void(reason=f"not sent: {_error_text(exc)}")
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
        # The record can't be stopped once its thread runs: a cancellation waits for it.
        task = asyncio.ensure_future(asyncio.to_thread(self.__exit__, exc_type, exc, traceback))
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
        self._ledger = Ledger(self._path, busy_timeout_seconds=busy_timeout_seconds, create=create)
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
        already in the ledger, for this wallet and amount, returns that payment's hold
        (``created`` is False). ``settles_by`` (a timezone-aware datetime after now) or
        ``settles_within`` (a timedelta) bounds how long it can still settle.
        """

        return self._hold(
            _Request(amount, _describe(to, note, details), rail, settles_by, settles_within, id)
        )

    def _hold(self, request: _Request) -> Hold:
        micros = _positive(to_micros(request.amount))
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
        return Hold(
            self._ledger,
            str(held["payment"]),
            micros,
            str(held["state"]),
            created=bool(held["created"]),
            holder=held["holder"],
        )

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


def open_budget(wallet: str, **options: Any) -> Budget:
    """Open the wallet's budget, to pay from it. Its owner creates it first with ``walletcap set``.

    Pass ``create=True`` only to create it on first use (a demo or a first-run setup); by
    default a missing file refuses every payment. Limits are dollars: strings (``"$150"``,
    ``"12.50 USDC"``), ints, floats, Decimals or ``Micros``. Limits given here only tighten the
    budget's, for this process: ``per_hour``, ``per_day``, ``per_week``, or ``cap`` with
    ``window``, and ``per_payment`` and ``max_payments``.
    """

    return Budget(wallet, **options)
