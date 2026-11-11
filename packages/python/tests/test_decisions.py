"""The decision log.

The ledger records the payments a budget admitted; a refusal used to leave nothing behind but
the exception. Every decision a payer's handle makes (a hold admitted or refused, and each move
of a hold it took) reaches its ``on_decision`` callback and, when ``WALLETCAP_LOG`` names a file,
one JSON line there. The log comes after the ledger and can't change what it answered. The
JavaScript package writes the same line for the same decision.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import warnings
from collections.abc import Callable
from dataclasses import FrozenInstanceError, fields
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / "src"
JS_INDEX = REPO / "packages" / "js" / "dist" / "index.js"
sys.path.insert(0, str(SOURCE))

from walletcap import (  # noqa: E402
    Budget,
    BudgetRefused,
    BudgetWarning,
    Decision,
    Micros,
    NotSent,
    UsageError,
    _clock,
    open_budget,
    open_owner,
)
from walletcap._decisions import decision_log_file  # noqa: E402

NODE = shutil.which("node")
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
TX = "0x" + "ab" * 32
T0 = datetime(2027, 1, 15, 8, 0, tzinfo=UTC)
FIELDS = [
    "decision",
    "at",
    "wallet",
    "amount",
    "id",
    "rail",
    "to",
    "code",
    "source",
    "brief",
    "outcome",
    "settles_by",
    "tx",
]
# A payee's name that tries to end the line, forge the next one and clear the terminal, with the
# characters JSON writers treat differently: controls, DEL, NEL, a line separator, an emoji and a
# lone surrogate. Built from code points, so none of them is in this file.
HOSTILE = (
    "caf"
    + "".join(map(chr, (0xE9, 0x22, 0x5C, 0x0D, 0x0A, 0x09, 0x07, 0x1B, 0x00)))
    + '{"decision":"settled","amount":"1"}'
    + "".join(map(chr, (0x7F, 0x85, 0x2028, 0x1F600, 0xD83D)))
)


class Clock:
    def __init__(self) -> None:
        self.at = T0.timestamp()

    def __call__(self) -> float:
        return self.at


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """The ledger's own clock, replaced through the private hook for one test."""

    fake = Clock()
    monkeypatch.setattr(_clock, "source", fake)
    return fake


@pytest.fixture(autouse=True)
def _no_log_of_the_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    """A log the developer's own shell names must not take these tests' decisions."""

    monkeypatch.delenv("WALLETCAP_LOG", raising=False)


def _budget(
    path: Path, on_decision: Callable[[Decision], object] | None = None, **limits: Any
) -> Budget:
    limits = limits or {"per_payment": "$50", "per_day": "$150"}
    return open_budget(WALLET, path=path, create=True, on_decision=on_decision, **limits)


def _kinds(decisions: list[Decision]) -> list[str]:
    return [decision.decision for decision in decisions]


def _lines(log: Path) -> list[str]:
    # The log is ASCII, so this decodes.
    text = log.read_bytes().decode("ascii")
    assert text.endswith("\n"), "the last line is whole"
    return text[:-1].split("\n")


def _caught(run: Callable[[], None]) -> list[warnings.WarningMessage]:
    """The BudgetWarnings ``run`` gave, every one of them."""

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        run()
    return [warning for warning in caught if issubclass(warning.category, BudgetWarning)]


def test_each_of_the_six_decisions_reaches_the_callback_once_with_every_field(
    tmp_path: Path, clock: Clock
) -> None:
    decisions: list[Decision] = []
    budget = _budget(tmp_path / "b.sqlite", decisions.append)
    hold = budget.hold("$5", id="order-1", to="shop.example", rail="card")
    clock.at += 1
    until = T0 + timedelta(minutes=10)
    hold.settles_by(until)
    clock.at += 1
    hold.note("refused", "the payee answered 402")
    clock.at += 1
    hold.settle(tx=TX)
    clock.at += 1
    other = budget.hold("$7", settles_within=timedelta(minutes=1))
    other.void()
    with pytest.raises(BudgetRefused):
        budget.hold("$51", details={"payTo": "0xpayee"})

    assert _kinds(decisions) == ["held", "bound", "noted", "settled", "held", "void", "refused"]
    assert all([field.name for field in fields(decision)] == FIELDS for decision in decisions)
    order = (WALLET, Micros(5_000_000), "order-1", "card", "shop.example")
    assert decisions[:4] == [
        Decision("held", T0, *order),
        Decision("bound", T0 + timedelta(seconds=1), *order, settles_by=until),
        Decision("noted", T0 + timedelta(seconds=2), *order, outcome="refused", settles_by=until),
        Decision("settled", T0 + timedelta(seconds=3), *order, settles_by=until, tx=TX),
    ]
    at = T0 + timedelta(seconds=4)
    second = (WALLET, Micros(7_000_000), other.id, "python", None)
    assert decisions[4:6] == [
        Decision("held", at, *second, settles_by=at + timedelta(minutes=1)),
        Decision("void", at, *second, settles_by=at + timedelta(minutes=1)),
    ]
    assert decisions[6] == Decision(
        "refused",
        at,
        WALLET,
        Micros(51_000_000),
        None,
        "python",
        "0xpayee",
        "per_payment",
        "budget",
        "$51.00 is over 0xd797…ca02's $50.00 limit per payment",
    )
    # A decision is a record of what happened: it can't be changed.
    with pytest.raises(FrozenInstanceError):
        decisions[0].amount = Micros(1)  # type: ignore[misc]


def test_a_refusal_carries_its_code_its_source_and_its_brief_the_amount_asked_and_no_id(
    tmp_path: Path,
) -> None:
    path = tmp_path / "b.sqlite"
    decisions: list[Decision] = []
    budget = _budget(path, decisions.append, per_day="$10", max_payments=2)
    held = budget.hold("$6")
    # Over the cap while a payment is open: the exception's message names that payment for its
    # owner, the brief doesn't.
    with pytest.raises(BudgetRefused) as over:
        budget.hold("$5")
    assert held.id in str(over.value)
    # This process's own, tighter limit.
    tighter: list[Decision] = []
    careful = open_budget(WALLET, path=path, per_payment="$2", on_decision=tighter.append)
    with pytest.raises(BudgetRefused):
        careful.hold("$3")
    budget.hold("$1")
    with pytest.raises(BudgetRefused):
        budget.hold("$1")
    open_owner(path=path).freeze(WALLET)
    with pytest.raises(BudgetRefused):
        budget.hold("$1")

    refusals = [d for d in [*decisions, *tighter] if d.decision == "refused"]
    assert [(d.code, d.source, d.amount, d.id) for d in refusals] == [
        ("budget", "budget", Micros(5_000_000), None),
        ("max_payments", "budget", Micros(1_000_000), None),
        ("frozen", "budget", Micros(1_000_000), None),
        ("per_payment", "process", Micros(3_000_000), None),
    ]
    assert refusals[0].brief == over.value.brief
    assert refusals[0].brief != str(over.value)
    assert all(d.brief is not None and held.id not in d.brief for d in refusals)
    assert refusals[3].brief == "$3.00 is over the $2.00 limit per payment this process set"


def test_pay_is_held_then_settled_and_an_exception_is_held_then_noted_unknown_or_void_for_not_sent(
    tmp_path: Path,
) -> None:
    decisions: list[Decision] = []
    budget = _budget(tmp_path / "b.sqlite", decisions.append)
    with budget.pay("$5", to="shop.example") as hold:
        hold.tx = TX
    with pytest.raises(RuntimeError), budget.pay("$6"):
        raise RuntimeError("socket hang up")
    with pytest.raises(NotSent), budget.pay("$7"):
        raise NotSent("card declined")
    with pytest.raises(BudgetRefused), budget.pay("$500"):
        pass
    assert [(d.decision, d.amount, d.outcome, d.tx) for d in decisions] == [
        ("held", Micros(5_000_000), None, None),
        ("settled", Micros(5_000_000), None, TX),
        ("held", Micros(6_000_000), None, None),
        ("noted", Micros(6_000_000), "unknown", None),
        ("held", Micros(7_000_000), None, None),
        ("void", Micros(7_000_000), None, None),
        ("refused", Micros(500_000_000), None, None),
    ]
    # Each payment's decisions are about one id.
    assert decisions[0].id == decisions[1].id
    assert decisions[2].id == decisions[3].id
    assert decisions[0].id != decisions[2].id


def test_async_with_pay_and_the_async_moves_report_the_same_from_the_thread_that_asked_the_ledger(
    tmp_path: Path,
) -> None:
    decisions: list[Decision] = []
    threads: set[int] = set()

    def on_decision(decision: Decision) -> None:
        decisions.append(decision)
        threads.add(threading.get_ident())

    budget = _budget(tmp_path / "b.sqlite", on_decision)

    async def pay() -> None:
        async with budget.pay("$5", to="shop.example") as hold:
            hold.tx = TX
        with pytest.raises(RuntimeError):
            async with budget.pay("$6"):
                raise RuntimeError("socket hang up")
        with pytest.raises(NotSent):
            async with budget.pay("$7"):
                raise NotSent("card declined")
        with pytest.raises(BudgetRefused):
            async with budget.pay("$500"):
                pass
        hold = await budget.ahold("$8")
        await hold.asettles_within(timedelta(minutes=5))
        await hold.anote("refused")
        await hold.asettle(tx=TX)
        other = await budget.ahold("$9")
        await other.avoid()

    asyncio.run(pay())
    assert [(d.decision, d.amount, d.outcome, d.tx) for d in decisions] == [
        ("held", Micros(5_000_000), None, None),
        ("settled", Micros(5_000_000), None, TX),
        ("held", Micros(6_000_000), None, None),
        ("noted", Micros(6_000_000), "unknown", None),
        ("held", Micros(7_000_000), None, None),
        ("void", Micros(7_000_000), None, None),
        ("refused", Micros(500_000_000), None, None),
        ("held", Micros(8_000_000), None, None),
        ("bound", Micros(8_000_000), None, None),
        ("noted", Micros(8_000_000), "refused", None),
        ("settled", Micros(8_000_000), None, TX),
        ("held", Micros(9_000_000), None, None),
        ("void", Micros(9_000_000), None, None),
    ]
    # The async forms ask the ledger in a worker thread, and the callback is called there.
    assert threading.get_ident() not in threads


def test_a_move_already_made_is_not_decided_again(tmp_path: Path) -> None:
    decisions: list[Decision] = []
    budget = _budget(tmp_path / "b.sqlite", decisions.append)
    hold = budget.hold("$5")
    hold.settles_within(timedelta(minutes=1))
    hold.settles_within(timedelta(minutes=2))
    hold.settle(tx=TX)
    hold.settle(tx=TX)
    other = budget.hold("$5")
    other.void()
    other.void()
    assert _kinds(decisions) == ["held", "bound", "settled", "held", "void"]


def test_check_reports_nothing_and_neither_do_reads_or_the_owners_handle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, log = tmp_path / "b.sqlite", tmp_path / "quiet.jsonl"
    monkeypatch.setenv("WALLETCAP_LOG", str(log))
    decisions: list[Decision] = []
    budget = _budget(path, decisions.append)
    hold = budget.hold("$5")
    assert budget.check("$1").ok
    assert not budget.check("$500").ok
    budget.status()
    budget.history()
    budget.holds()
    budget.payment(hold.id)
    # The owner's handle moves the payment; it is the payer's handle that has a decision log.
    owner = open_owner(path=path)
    owner.settle(hold.id, evidence="seen on chain")
    owner.status(WALLET)
    assert _kinds(decisions) == ["held"]
    assert len(_lines(log)) == 1


def test_a_callback_that_raises_changes_nothing_and_the_handle_warns_once(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    plain = _budget(path)
    calls: list[Decision] = []

    def on_decision(decision: Decision) -> None:
        calls.append(decision)
        # What a payee sent is in the exception's message, as a careless callback would put it.
        raise TypeError(f"cannot log {decision.to}")

    budget = open_budget(WALLET, path=path, on_decision=on_decision)

    def run() -> None:
        with budget.pay("$5", to="shop" + chr(0x1B) + "[2J.example") as hold:
            hold.tx = TX
        assert hold.state == "settled"
        with pytest.raises(BudgetRefused) as refused, budget.pay("$500"):
            pass
        with pytest.raises(BudgetRefused) as expected:
            plain.hold("$500")
        got, same = refused.value, expected.value
        assert (str(got), got.code, got.source, got.brief) == (
            str(same),
            same.code,
            same.source,
            same.brief,
        )
        other = budget.hold("$6")
        other.void()
        assert other.state == "void"

    caught = _caught(run)
    assert len(calls) == 5, "the callback is still called for every decision"
    status = budget.status()
    assert (status.spent, status.in_flight, status.payments) == (Micros(5_000_000), Micros(0), 1)
    assert len(caught) == 1
    message = str(caught[0].message)
    assert "the on_decision callback failed (TypeError)" in message
    # The warning names the exception's class, never its message.
    assert "shop" not in message


def test_a_coroutine_function_is_not_awaited_and_the_handle_says_so_once(tmp_path: Path) -> None:
    ran: list[Decision] = []

    async def on_decision(decision: Decision) -> None:
        ran.append(decision)

    budget = _budget(tmp_path / "b.sqlite", on_decision)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for _ in range(3):
            with budget.pay("$5") as hold:
                hold.tx = TX
    assert ran == []
    assert budget.status().spent == Micros(15_000_000)
    ours = [warning for warning in caught if issubclass(warning.category, BudgetWarning)]
    assert len(ours) == 1
    assert "on_decision is a coroutine function" in str(ours[0].message)
    # The coroutines were closed: none is left to warn that it was never awaited.
    assert not [warning for warning in caught if issubclass(warning.category, RuntimeWarning)]


def test_a_log_file_that_cant_be_written_changes_nothing_and_each_handle_warns_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A file where the log's folder should be: the log can be neither created nor appended to.
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("", encoding="utf-8")
    log = blocker / "decisions.jsonl"
    monkeypatch.setenv("WALLETCAP_LOG", str(log))
    path = tmp_path / "b.sqlite"
    decisions: list[Decision] = []
    first = _budget(path, decisions.append)
    second = open_budget(WALLET, path=path)

    def run() -> None:
        for budget in (first, second):
            with budget.pay("$5") as hold:
                hold.tx = TX
            with pytest.raises(BudgetRefused):
                budget.hold("$500")
            with budget.pay("$5") as hold:
                hold.tx = TX

    caught = _caught(run)
    # The callback is told all the same.
    assert _kinds(decisions) == ["held", "settled", "refused", "held", "settled"]
    assert first.status().spent == Micros(20_000_000)
    assert len(caught) == 2, "one for each handle, not one for each payment"
    assert all(f"the decision log {log} can't be written" in str(w.message) for w in caught)


def test_a_handle_whose_callback_and_whose_file_both_fail_warns_once_for_each(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setenv("WALLETCAP_LOG", str(blocker / "decisions.jsonl"))

    def on_decision(_decision: Decision) -> None:
        raise RuntimeError("broken")

    budget = _budget(tmp_path / "b.sqlite", on_decision)

    def run() -> None:
        for _ in range(3):
            with budget.pay("$5") as hold:
                hold.tx = TX

    messages = sorted(str(warning.message) for warning in _caught(run))
    assert budget.status().spent == Micros(15_000_000)
    assert len(messages) == 2
    assert "the decision log" in messages[0]
    assert "the on_decision callback failed (RuntimeError)" in messages[1]


def test_warnings_turned_into_errors_change_nothing_either(tmp_path: Path) -> None:
    def on_decision(_decision: Decision) -> None:
        raise RuntimeError("broken")

    budget = _budget(tmp_path / "b.sqlite", on_decision)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        with budget.pay("$5") as hold:
            hold.tx = TX
        with pytest.raises(BudgetRefused):
            budget.hold("$500")
    assert budget.status().spent == Micros(5_000_000)


def test_the_log_gets_one_json_line_per_decision_in_the_shared_key_order_in_a_file_created_0600(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    log = tmp_path / "logs" / "agent" / "decisions.jsonl"
    path = tmp_path / "b.sqlite"
    monkeypatch.setenv("WALLETCAP_LOG", str(log))
    decisions: list[Decision] = []
    budget = _budget(path, decisions.append)
    # The log file is the one named when the budget was opened: the variable can go.
    monkeypatch.delenv("WALLETCAP_LOG")
    with budget.pay(
        "$5", id="order-1", to="shop.example", settles_by=T0 + timedelta(minutes=10)
    ) as hold:
        hold.tx = TX
    clock.at += 1.5
    with pytest.raises(BudgetRefused):
        budget.hold("$51", to="shop.example", rail="card")
    budget.hold("$2").note("unknown")
    # A handle opened with no WALLETCAP_LOG writes nowhere.
    with open_budget(WALLET, path=path).pay("$1") as hold:
        hold.tx = TX

    lines = _lines(log)
    assert len(lines) == len(decisions) == 5
    assert all(list(json.loads(line)) == FIELDS for line in lines)
    # No spaces, as JSON.stringify writes it.
    assert lines[0].startswith('{"decision":"held","at":"2027-01-15T08:00:00.000Z","wallet":"0x')
    assert json.loads(lines[1]) == {
        "decision": "settled",
        "at": "2027-01-15T08:00:00.000Z",
        "wallet": WALLET,
        "amount": "5000000",
        "id": "order-1",
        "rail": "python",
        "to": "shop.example",
        "code": None,
        "source": None,
        "brief": None,
        "outcome": None,
        "settles_by": "2027-01-15T08:10:00.000Z",
        "tx": TX,
    }
    assert json.loads(lines[2]) == {
        "decision": "refused",
        "at": "2027-01-15T08:00:01.500Z",
        "wallet": WALLET,
        "amount": "51000000",
        "id": None,
        "rail": "card",
        "to": "shop.example",
        "code": "per_payment",
        "source": "budget",
        "brief": "$51.00 is over 0xd797…ca02's $50.00 limit per payment",
        "outcome": None,
        "settles_by": None,
        "tx": None,
    }
    if os.name != "nt":
        assert stat.S_IMODE(log.stat().st_mode) == 0o600
        # walletcap made both folders, so both are the owner's alone.
        assert stat.S_IMODE(log.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(log.parent.parent.stat().st_mode) == 0o700


def test_a_payees_text_reaches_the_log_as_one_line_of_ascii_json_with_no_control_byte(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = tmp_path / "hostile.jsonl"
    monkeypatch.setenv("WALLETCAP_LOG", str(log))
    budget = _budget(tmp_path / "b.sqlite")
    budget.hold("$5", to=HOSTILE).settle(tx="receipt" + chr(0x09) + chr(0x07))
    with pytest.raises(BudgetRefused):
        budget.hold("$500", to=HOSTILE)
    raw = log.read_bytes()
    # Line feeds end the three lines, and nothing else in the file is outside printable ASCII: no
    # control code for a terminal, and no other character a reader could take for a line's end.
    assert raw.count(b"\n") == 3
    assert not [byte for byte in raw if (byte < 0x20 or byte > 0x7E) and byte != 0x0A]
    lines = [json.loads(line) for line in raw.decode("ascii").splitlines()]
    assert [line["decision"] for line in lines] == ["held", "settled", "refused"]
    assert all(line["to"] == HOSTILE for line in lines)
    assert lines[1]["tx"] == "receipt" + chr(0x09) + chr(0x07)


def test_walletcap_log_is_read_like_walletcap_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WALLETCAP_LOG", "~/walletcap/decisions.jsonl")
    assert decision_log_file() == Path.home() / "walletcap" / "decisions.jsonl"
    monkeypatch.setenv("WALLETCAP_LOG", "decisions.jsonl")
    assert decision_log_file() == Path("decisions.jsonl").absolute()
    monkeypatch.setenv("WALLETCAP_LOG", "")
    assert decision_log_file() is None
    monkeypatch.delenv("WALLETCAP_LOG")
    assert decision_log_file() is None


def test_on_decision_must_be_a_function(tmp_path: Path) -> None:
    with pytest.raises(UsageError, match="on_decision must be a function"):
        open_budget(
            WALLET,
            path=tmp_path / "b.sqlite",
            create=True,
            per_day="$1",
            on_decision="print",  # type: ignore[arg-type]
        )


def test_handles_in_several_threads_append_whole_lines_to_one_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log, path = tmp_path / "shared.jsonl", tmp_path / "b.sqlite"
    monkeypatch.setenv("WALLETCAP_LOG", str(log))
    # Four handles, fifteen payments of a cent each against forty cents: the rest are refused.
    _budget(path, per_payment="$1", per_day="$0.40")
    outcomes: list[str] = []

    def pay() -> None:
        budget = open_budget(WALLET, path=path)
        for _ in range(15):
            try:
                with budget.pay("$0.01") as hold:
                    hold.tx = TX
                outcomes.append("paid")
            except BudgetRefused as refused:
                outcomes.append(refused.code)

    threads = [threading.Thread(target=pay) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    paid = outcomes.count("paid")
    assert (paid, len(outcomes)) == (40, 60)
    lines = [json.loads(line) for line in _lines(log)]
    assert all(list(line) == FIELDS for line in lines)
    # A payment is two lines, held and settled; a refusal is one.
    kinds = [line["decision"] for line in lines]
    assert (kinds.count("held"), kinds.count("settled"), kinds.count("refused")) == (40, 40, 20)
    assert len(lines) == 100


# --- Both languages ----------------------------------------------------------------------------

# One sequence of decisions, made through each library on its own budget file: each kind of
# decision, refusals by the owner's limits and by the process's own, and a payee's name with
# every character the two JSON writers could write differently.
UNTIL_MS = 4_102_444_800_250  # 2100-01-01T00:00:00.250Z
SEQUENCE: list[dict[str, Any]] = [
    {"op": "open", "handle": "main", "create": True, "perPayment": "$50", "perDay": "$60"},
    {"op": "open", "handle": "careful", "perPayment": "$2"},
    {"op": "hold", "handle": "main", "amount": "$5", "id": "order-1", "to": HOSTILE, "until": True},
    {"op": "note", "id": "order-1", "outcome": "refused", "detail": "the payee answered 402"},
    {"op": "settle", "id": "order-1", "tx": TX},
    {"op": "settle", "id": "order-1", "tx": TX},
    {"op": "hold", "handle": "main", "amount": "$7", "id": "order-2"},
    {"op": "bound", "id": "order-2"},
    {"op": "hold", "handle": "main", "amount": "$3.25", "id": "order-3", "to": "shop.example"},
    {"op": "void", "id": "order-3"},
    {"op": "hold", "handle": "main", "amount": "$51", "id": "order-4", "to": HOSTILE},
    {"op": "hold", "handle": "careful", "amount": "$2.000001", "id": "order-5"},
    {"op": "hold", "handle": "main", "amount": "$40", "id": "order-6"},
    {"op": "note", "id": "order-6", "outcome": "unknown"},
    {"op": "hold", "handle": "main", "amount": "$20", "id": "order-7", "to": "shop.example"},
    {"op": "freeze"},
    {"op": "hold", "handle": "careful", "amount": "$1", "id": "order-8"},
]
KINDS = [
    "held",
    "noted",
    "settled",
    "held",
    "bound",
    "held",
    "void",
    "refused",
    "refused",
    "held",
    "noted",
    "refused",
    "refused",
]
# The same sequence in JavaScript: every hold names its rail, since each library has its own
# default ('js' and 'python').
JS_DECIDER = """
const [index, wallet, path, steps, until] = process.argv.slice(1);
const { BudgetRefused, openBudget, openOwner } = await import(index);
const handles = {};
const holds = {};
for (const { op, handle, id, ...step } of JSON.parse(steps)) {
  if (op === 'open') handles[handle] = await openBudget({ wallet, path, ...step });
  else if (op === 'freeze') await (await openOwner({ path })).freeze(wallet);
  else if (op === 'hold') {
    const { amount, to, until: bounded } = step;
    const options = { id, rail: 'card', ...(to === undefined ? {} : { to }) };
    if (bounded) options.settlesBy = Number(until);
    try {
      holds[id] = await handles[handle].hold(amount, options);
    } catch (error) {
      if (!(error instanceof BudgetRefused)) throw error;
    }
  } else if (op === 'note') await holds[id].note(step.outcome, step.detail);
  else if (op === 'settle') await holds[id].settle({ tx: step.tx });
  else if (op === 'bound') await holds[id].settlesBy(Number(until));
  else if (op === 'void') await holds[id].void();
  else throw new Error(`unknown step ${op}`);
}
"""


def _decide_in_python(path: Path) -> None:
    until = datetime.fromtimestamp(0, tz=UTC) + timedelta(milliseconds=UNTIL_MS)
    handles: dict[str, Budget] = {}
    holds: dict[str, Any] = {}
    for step in SEQUENCE:
        op, key = step["op"], step.get("id", "")
        if op == "open":
            limits = {
                name: step[option]
                for name, option in (("per_payment", "perPayment"), ("per_day", "perDay"))
                if option in step
            }
            create = step.get("create", False)
            handles[step["handle"]] = open_budget(WALLET, path=path, create=create, **limits)
        elif op == "freeze":
            open_owner(path=path).freeze(WALLET)
        elif op == "hold":
            with contextlib.suppress(BudgetRefused):
                holds[key] = handles[step["handle"]].hold(
                    step["amount"],
                    id=key,
                    rail="card",
                    to=step.get("to"),
                    settles_by=until if step.get("until") else None,
                )
        elif op == "note":
            holds[key].note(step["outcome"], step.get("detail"))
        elif op == "settle":
            holds[key].settle(tx=step["tx"])
        elif op == "bound":
            holds[key].settles_by(until)
        elif op == "void":
            holds[key].void()
        else:
            raise AssertionError(f"unknown step {op}")


@pytest.mark.skipif(
    NODE is None or not JS_INDEX.exists(), reason="requires node and packages/js/dist"
)
def test_both_languages_write_the_same_lines_for_the_same_decisions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert NODE is not None
    logs = {name: tmp_path / f"{name}.jsonl" for name in ("js", "python")}
    done = subprocess.run(
        [
            NODE,
            "--input-type=module",
            "-e",
            JS_DECIDER,
            JS_INDEX.as_uri(),
            WALLET,
            str(tmp_path / "js.sqlite"),
            json.dumps(SEQUENCE),
            str(UNTIL_MS),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        env={**os.environ, "WALLETCAP_LOG": str(logs["js"])},
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    monkeypatch.setenv("WALLETCAP_LOG", str(logs["python"]))
    _decide_in_python(tmp_path / "python.sqlite")

    js, python = (_lines(logs[name]) for name in ("js", "python"))
    assert [json.loads(line)["decision"] for line in js] == KINDS
    assert len(python) == len(js)
    moment = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
    for index, (ours, theirs) in enumerate(zip(python, js, strict=True)):
        mine, yours = json.loads(ours), json.loads(theirs)
        # Key for key, in the same order, and value for value: only the time differs.
        assert list(mine) == list(yours) == FIELDS, index
        assert moment.fullmatch(mine.pop("at")), ours
        assert moment.fullmatch(yours.pop("at")), theirs
        assert mine == yours, index
        # And byte for byte, the time aside.
        at = re.compile(r'(?<="at":")[^"]+')
        assert at.sub("", ours, count=1) == at.sub("", theirs, count=1), index
    # Every kind of decision was compared, and refusals from the owner's limits and the process's.
    compared = [json.loads(line) for line in python]
    assert {line["decision"] for line in compared} == {
        "held",
        "refused",
        "bound",
        "noted",
        "settled",
        "void",
    }
    assert {(line["code"], line["source"]) for line in compared if line["code"]} == {
        ("per_payment", "budget"),
        ("per_payment", "process"),
        ("budget", "budget"),
        ("frozen", "budget"),
    }
    assert compared[4]["settles_by"] == "2100-01-01T00:00:00.250Z"
