"""Random histories against the ledger and against a model of spec/ledger.md.

Holds, settlements, voids, bounds, notes, owner changes and clock moves run against the ledger
(spec/schema.sql through this package's client) and against a small model written here from the
spec, not from the SQL. After every step they must agree on what was admitted or refused, and
why, on the budget's status, and on every payment's state. The JavaScript suite runs the same
kind of test with fast-check (packages/js/test/property.test.mjs).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from walletcap import _clock
from walletcap._ledger import Ledger, ProcessLimits
from walletcap.errors import BudgetRefused, UsageError

if TYPE_CHECKING:
    import pytest

WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
START = 1_800_000_000_000
UNBOUNDED_HOLD_MS = 3_660_000


@dataclass
class Payment:
    amount: int
    held_at: int
    until: int | None
    order: int
    state: str = "held"
    settled_at: int | None = None
    outcome: str | None = None
    rail: str = "property"
    holder: str | None = None

    def counts_from(self) -> float | None:
        if self.state == "void":
            return None
        if self.state == "held":
            return math.inf if self.until is None else max(self.until, self.held_at)
        assert self.settled_at is not None
        until = self.settled_at if self.until is None else self.until
        return max(self.settled_at, until, self.held_at)


@dataclass
class Model:
    """spec/ledger.md, in plain Python."""

    cap: int
    window: int
    per_payment: int | None
    max_payments: int | None
    now: int = START
    frozen: bool = False
    payments: dict[str, Payment] = field(default_factory=dict)
    order: Iterator[int] = field(default_factory=itertools.count)

    def counting(self, window: int | None = None) -> list[Payment]:
        span = self.window if window is None else window
        return [
            p
            for p in self.payments.values()
            if (start := p.counts_from()) is not None and start >= self.now - span
        ]

    def verdict(self, amount: int, limits: dict[str, Any]) -> tuple[str, str] | None:
        counting = self.counting()
        counted = sum(p.amount for p in counting)
        full = self.max_payments is not None and len(counting) >= self.max_payments
        if self.frozen or full:
            room = 0
        else:
            room = max(0, min(self.cap - counted, self.per_payment or self.cap - counted))
        if amount > room:
            if self.frozen:
                return ("frozen", "budget")
            if self.per_payment is not None and amount > self.per_payment:
                return ("per_payment", "budget")
            if counted + amount > self.cap:
                return ("budget", "budget")
            return ("max_payments", "budget")
        own = self.counting(limits.get("window_ms") or self.window)
        if limits.get("per_payment") is not None and amount > limits["per_payment"]:
            return ("per_payment", "process")
        if limits.get("cap") is not None and sum(p.amount for p in own) + amount > limits["cap"]:
            return ("budget", "process")
        if limits.get("max_payments") is not None and len(own) >= limits["max_payments"]:
            return ("max_payments", "process")
        return None

    def status(self) -> dict[str, int]:
        counting = self.counting()
        counted = sum(p.amount for p in counting)
        return {
            "spent": sum(p.amount for p in counting if p.state == "settled"),
            "in_flight": sum(p.amount for p in counting if p.state == "held"),
            "payments": len(counting),
            "remaining": 0 if self.frozen else max(self.cap - counted, 0),
        }


def _outcome(work: Any) -> Any:
    try:
        return ("ok", work())
    except BudgetRefused as error:
        return ("refused", (error.code, error.source))
    except UsageError:
        return ("usage", None)


amounts = st.sampled_from([1, 10, 25, 40, 41, 50, 60, 100, 101])
picks = st.integers(0, 7)
process_limits = st.fixed_dictionaries(
    {
        "per_payment": st.none() | st.sampled_from([10, 30, 50]),
        "cap": st.none() | st.sampled_from([20, 60, 100]),
        "window_ms": st.none() | st.sampled_from([300, 1000, 5000]),
        "max_payments": st.none() | st.sampled_from([1, 2, 3]),
    }
)
hold = st.fixed_dictionaries(
    {
        "op": st.just("hold"),
        "id": st.none() | st.sampled_from(["a", "b", "c", "d"]),
        "amount": amounts,
        "until": st.none() | st.integers(-2, 3000),
        "within": st.none() | st.sampled_from([1, 400, 2000]),
        "limits": st.none() | process_limits,
        "rail": st.sampled_from(["x402", "python"]),
    }
)
moves = st.fixed_dictionaries({"op": st.sampled_from(["settle", "void"]), "pick": picks})
bound = st.fixed_dictionaries(
    {
        "op": st.just("bound"),
        "pick": picks,
        "until": st.none() | st.integers(-2, 3000),
        "within": st.sampled_from([1, 700, 4000]),
    }
)
note = st.fixed_dictionaries(
    {"op": st.just("note"), "pick": picks, "outcome": st.sampled_from(["unknown", "refused"])}
)
advance = st.fixed_dictionaries(
    {
        "op": st.just("advance"),
        "ms": st.sampled_from(
            [1, 299, 300, 301, 500, 999, 1000, 1001, 2000, 2001, 2500, UNBOUNDED_HOLD_MS]
        ),
    }
)
owner = st.one_of(
    st.fixed_dictionaries({"op": st.just("limits"), "cap": st.sampled_from([0, 50, 100, 200])}),
    st.fixed_dictionaries({"op": st.just("limits"), "window": st.sampled_from([500, 1000, 2000])}),
    st.fixed_dictionaries({"op": st.sampled_from(["freeze", "unfreeze"])}),
    st.fixed_dictionaries(
        {"op": st.just("void_unknown"), "older": st.sampled_from([0, 500, 5000])}
    ),
)
operations = st.one_of(hold, hold, hold, moves, moves, bound, note, note, advance, advance, owner)
budgets = st.fixed_dictionaries(
    {
        "cap": st.sampled_from([100, 150]),
        "window": st.sampled_from([1000, 2000]),
        "per_payment": st.none() | st.sampled_from([40, 100]),
        "max_payments": st.none() | st.sampled_from([3, 5]),
    }
)
_runs = itertools.count()


@contextmanager
def _clock_of(model: Model) -> Iterator[None]:
    saved = _clock.source
    _clock.source = lambda: model.now / 1000
    try:
        yield
    finally:
        _clock.source = saved


def _step(ledger: Ledger, model: Model, known: list[str], step: dict[str, Any]) -> tuple[Any, Any]:
    op = step["op"]
    if op == "hold":
        until = None if step["until"] is None else model.now + step["until"]
        within = step["within"] if until is None else None
        limits = step["limits"] or {}
        existing = None if step["id"] is None else model.payments.get(step["id"])
        expected: Any
        if existing is not None:
            # A voided id is spent; any other existing id, same amount, is that payment.
            expected = ("ok", False)
            if existing.state == "void" or existing.amount != step["amount"]:
                expected = ("usage", None)
        elif until is not None and until <= model.now:
            expected = ("usage", None)
        elif (refused := model.verdict(step["amount"], limits)) is not None:
            expected = ("refused", refused)
        else:
            expected = ("ok", True)
        actual = _outcome(
            lambda: ledger.hold(
                WALLET,
                step["amount"],
                rail=step["rail"],
                payment=step["id"],
                until=until,
                within_ms=within,
                limits=ProcessLimits(**limits),
            )
        )
        if actual[0] == "ok":
            row = actual[1]
            if row["created"]:
                stop = None if within is None else model.now + within
                bound = until if until is not None else stop
                model.payments[row["payment"]] = Payment(
                    step["amount"],
                    model.now,
                    bound,
                    next(model.order),
                    rail=step["rail"],
                    holder=row["holder"],
                )
                known.append(row["payment"])
            actual = ("ok", expected[1] if not row["created"] else True)
        return expected, actual
    if op in ("settle", "void", "note", "bound"):
        pid = "missing" if not known or step["pick"] == 7 else known[step["pick"] % len(known)]
        p = model.payments.get(pid)
        bound_until: int | None = None
        if op == "bound":
            offset = step["within"] if step["until"] is None else step["until"]
            bound_until = model.now + offset
        if p is None or (op == "void" and p.state == "settled"):
            expected = ("usage", None)
        elif op == "settle":
            if p.state != "settled":
                p.state, p.settled_at = "settled", model.now
            expected = ("ok", None)
        elif op == "void":
            p.state = "void"
            expected = ("ok", None)
        elif op == "note":
            if p.state == "held":
                p.outcome = step["outcome"]
            expected = ("ok", None)
        elif p.state == "held" and p.until is None and bound_until is not None:
            if bound_until <= model.now:
                expected = ("usage", None)
            else:
                p.until = bound_until
                expected = ("ok", None)
        else:
            expected = ("ok", None)

        holder = None if p is None else p.holder

        def move() -> Any:
            if op == "settle":
                return ledger.settle(pid, holder=holder)
            if op == "void":
                return ledger.void(pid, holder=holder)
            if op == "note":
                return ledger.note(pid, step["outcome"], holder=holder)
            if step["until"] is None:
                return ledger.bound(pid, holder=holder, within_ms=step["within"])
            return ledger.bound(pid, holder=holder, until=bound_until)

        actual = _outcome(move)
        return expected, (actual[0], None) if actual[0] == "ok" else actual
    if op == "advance":
        model.now += step["ms"]
        return ("ok", None), ("ok", None)
    if op == "limits":
        change = {"cap": step["cap"]} if "cap" in step else {"window_ms": step["window"]}
        moving = "window_ms" in change and change["window_ms"] != model.window
        if moving and model.counting():
            expected = ("usage", None)
        else:
            model.cap = change.get("cap", model.cap)
            model.window = change.get("window_ms", model.window)
            expected = ("ok", None)
        actual = _outcome(lambda: ledger.set_limits(WALLET, **change))
        return expected, (actual[0], None) if actual[0] == "ok" else actual
    if op in ("freeze", "unfreeze"):
        model.frozen = op == "freeze"
        getattr(ledger, op)(WALLET)
        return ("ok", None), ("ok", None)
    voided = sorted(
        (
            (pid, p)
            for pid, p in model.payments.items()
            if p.state == "held"
            and p.outcome in ("unknown", "refused")
            and p.held_at <= model.now - step["older"]
            and (
                p.until <= model.now
                if p.until is not None
                # With no until, only an x402 hold has a bound: an hour at most once signed.
                else p.rail == "x402" and p.held_at <= model.now - UNBOUNDED_HOLD_MS
            )
        ),
        key=lambda item: item[1].order,
    )
    for _, p in voided:
        p.state = "void"
    got = [row["payment"] for row in ledger.void_unknown(WALLET, step["older"])]
    return ("voided", [pid for pid, _ in voided]), ("voided", got)


@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)
@given(start=budgets, steps=st.lists(operations, min_size=20, max_size=60))
def test_the_ledger_and_the_model_agree_on_every_step(
    tmp_path_factory: pytest.TempPathFactory, start: dict[str, Any], steps: list[dict[str, Any]]
) -> None:
    model = Model(start["cap"], start["window"], start["per_payment"], start["max_payments"])
    path: Path = tmp_path_factory.mktemp("property") / f"run-{next(_runs)}.sqlite"
    with _clock_of(model):
        ledger = Ledger(path, create=True)
        ledger.create_budget(
            WALLET,
            unit="usd",
            cap=start["cap"],
            window_ms=start["window"],
            per_payment=start["per_payment"],
            max_payments=start["max_payments"],
        )
        known: list[str] = []
        for index, step in enumerate(steps):
            expected, actual = _step(ledger, model, known, step)
            where = f"step {index}: {step}"
            assert actual == expected, where
            status = ledger.status(WALLET)
            got = {key: status[key] for key in ("spent", "in_flight", "payments", "remaining")}
            assert got == model.status(), where
            states = {row["payment"]: row["state"] for row in ledger.history(WALLET, limit=1000)}
            assert states == {pid: model.payments[pid].state for pid in known}, where
            held = [row["payment"] for row in ledger.counting(WALLET, held_only=True)]
            counting = [p for p in model.counting() if p.state == "held"]
            order = sorted(counting, key=lambda p: p.order)
            by_payment = {id(p): pid for pid, p in model.payments.items()}
            assert held == [by_payment[id(p)] for p in order], where
