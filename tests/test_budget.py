"""The wallet budget API: one budget per wallet that restarts, limit changes and rails all keep.

The Python half is driven directly; the JavaScript half runs in Node on the same
file, so one budget is shared across languages, and both compute the same
default file.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import warnings
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src"
JS = ROOT / "js"
sys.path.insert(0, str(SOURCE))

from walletcap import (  # noqa: E402
    BudgetError,
    BudgetRefused,
    BudgetWarning,
    Ledger,
    NotSent,
    PaymentNotRecorded,
    _clock,
    default_budget_path,
    format_usd,
    open_budget,
    to_micros,
)

WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
CHECKSUMMED = "0xd797ead28C38575FDf4fC523866287372340Ca02"
DAY = 86_400
TX = "0x" + "ab" * 32
NODE = shutil.which("node")


class Clock:
    def __init__(self, at: float = 1_800_000_000.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """The ledger's own clock, replaced through the private hook for one test."""

    fake = Clock()
    monkeypatch.setattr(_clock, "source", fake)
    return fake


def _node_has_sqlite() -> bool:
    if NODE is None:
        return False
    probe = subprocess.run(  # noqa: S603 - fixed probe of the local Node
        [NODE, "-e", "require('node:sqlite')"], capture_output=True, check=False
    )
    return probe.returncode == 0


needs_node = pytest.mark.skipif(
    not _node_has_sqlite(), reason="requires_node: Node 22.13 or later, for node:sqlite"
)


def _pay(budget: object, amount: str) -> None:
    with budget.pay(amount) as payment:  # type: ignore[attr-defined]
        payment.tx = TX


def test_the_cap_holds_and_a_restart_cannot_raise_the_limits_it_finds(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    budget = open_budget(CHECKSUMMED, path=path, per_payment="$0.05", per_day="$0.15", create=True)
    for _ in range(3):
        _pay(budget, "$0.05")
    with pytest.raises(BudgetRefused) as refused:
        _pay(budget, "$0.05")
    assert refused.value.reason == "budget"
    assert "$0.15 limit ($0.00 left)" in str(refused.value)
    # The code comes back with a kit's looser defaults: the stored limits stay.
    with pytest.warns(BudgetWarning, match=r"keeps its stored limits \(\$0\.15 per 24h"):
        restarted = open_budget(WALLET, path=path, per_payment="$2.50", per_day="$5")
    with pytest.raises(BudgetRefused) as over:
        _pay(restarted, "$1.00")
    assert over.value.reason == "per_payment"
    status = restarted.status()
    assert (status.cap, status.per_payment, status.spent) == (150_000, 50_000, 150_000)


def test_raising_a_limit_keeps_what_was_spent(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_payment="$0.05", per_day="$0.15", create=True)
    for _ in range(3):
        _pay(budget, "0.05")
    status = budget.set_limits(per_day="$0.20")
    assert (status.spent, status.remaining) == (150_000, 50_000)
    _pay(budget, "0.05")
    with pytest.raises(BudgetRefused):
        _pay(budget, "0.05")


def test_the_window_cannot_change_after_spend(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "window.sqlite", per_day="$150", create=True)
    _pay(budget, "$1")
    with pytest.raises(BudgetError, match="window can't change while payments count"):
        budget.set_limits(cap="$150", window="1ms")
    assert budget.status().spent == 1_000_000

    fresh = open_budget(WALLET, path=tmp_path / "fresh.sqlite", per_day="$150", create=True)
    assert fresh.set_limits(cap="$150", window="1h").window_ms == 3_600_000


def test_code_can_lower_a_limit_for_everyone_and_the_window_rolls(
    tmp_path: Path, clock: Clock
) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", create=True)
    open_budget(WALLET, path=path, per_day="$100")
    assert budget.status().cap == 100_000_000
    _pay(budget, "$100")
    clock.at += DAY
    with pytest.raises(BudgetRefused):
        _pay(budget, "$1")
    clock.at += 0.001
    _pay(budget, "$100")


def test_a_failed_payment_keeps_counting_unless_it_never_left(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)
    with pytest.raises(TimeoutError), budget.pay("$50"):
        raise TimeoutError("rpc timeout")
    with pytest.raises(NotSent), budget.pay("$50"):
        raise NotSent("card declined")
    status = budget.status()
    assert (status.spent, status.in_flight) == (0, 50_000_000)
    # The ledger keeps every payment: the one that never left is void, and counts nothing.
    assert [payment.status for payment in budget.history()] == ["void", "unknown"]


def test_an_error_never_settles_a_payment(tmp_path: Path, clock: Clock) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)
    # A transfer whose receipt wait timed out can still be mined hours later.
    with pytest.raises(TimeoutError), budget.pay("$150"):
        raise TimeoutError("receipt timeout")
    clock.at += 30 * DAY
    status = budget.status()
    assert (status.spent, status.in_flight, status.remaining) == (0, 150_000_000, 0)
    with pytest.raises(BudgetRefused):
        _pay(budget, "$1")
    [unknown] = budget.history()
    assert (unknown.status, unknown.counting) == ("unknown", True)


def test_an_unknown_outcome_with_a_settle_by_time_counts_one_window_past_it(
    tmp_path: Path, clock: Clock
) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)
    settles_by = datetime.fromtimestamp(clock.at, tz=UTC) + timedelta(minutes=5)
    with pytest.raises(TimeoutError), budget.pay("$150", settles_by=settles_by):
        raise TimeoutError("rpc timeout")
    clock.at += 300 + DAY
    assert budget.status().in_flight == 150_000_000
    with pytest.raises(BudgetRefused):
        _pay(budget, "$1")
    clock.at += 0.002
    assert budget.status().in_flight == 0
    assert budget.history()[0].status == "expired"
    _pay(budget, "$150")


def test_a_payment_that_went_through_but_was_not_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)

    def locked(payment: str, *, evidence: str | None = None) -> None:
        raise BudgetError("the budget file is locked")

    monkeypatch.setattr(budget._ledger, "settle", locked)
    with pytest.raises(PaymentNotRecorded) as raised, budget.pay("$5") as payment:
        payment.tx = TX
    # Code that retries on BudgetError must not pay twice.
    assert not isinstance(raised.value, BudgetError)
    assert raised.value.reservation_id == payment.id
    assert isinstance(raised.value.cause, BudgetError)
    assert raised.value.__cause__ is raised.value.cause
    assert str(raised.value).endswith(f"still counts as in flight ({payment.id})")
    assert budget.status().in_flight == 5_000_000


def test_a_refusal_names_the_open_payments_and_holds_lists_them(
    tmp_path: Path, clock: Clock
) -> None:
    budget = open_budget(
        WALLET, path=tmp_path / "b.sqlite", per_day="$150", max_payments=3, create=True
    )
    for amount in ("$10", "$20"):
        with pytest.raises(TimeoutError), budget.pay(amount):
            raise TimeoutError("rpc timeout")
    clock.at += 3_600
    budget.reserve("$5", settles_by=datetime.fromtimestamp(clock.at + 300, tz=UTC))
    holds = budget.holds()
    assert [(hold.reason, hold.amount, hold.age_ms, hold.until is None) for hold in holds] == [
        ("unknown", 10_000_000, 3_600_000, True),
        ("unknown", 20_000_000, 3_600_000, True),
        ("in flight", 5_000_000, 0, False),
    ]
    assert holds[0].error == "rpc timeout"
    # 0.3.0 said "already made 3 payments in the last 24h", naming none of them.
    used = budget.check("$1")
    assert used.reason == "max_payments"
    assert used.message is not None
    assert re.search(
        r"has 3 payments counting in the last 24h, the most its budget allows, and 3 of them "
        r"are still open \(wc-\w+, wc-\w+, wc-\w+; walletcap holds lists them",
        used.message,
    )
    other = open_budget(WALLET, path=tmp_path / "other.sqlite", per_day="$150", create=True)
    with pytest.raises(TimeoutError), other.pay("$100"):
        raise TimeoutError("rpc timeout")
    over = other.check("$60").message
    assert over is not None
    assert re.search(
        r"over its \$150\.00 limit \(\$50\.00 left\); \$100\.00 of it is 1 open payment "
        r"\(wc-\w+; walletcap holds lists them",
        over,
    )


def test_an_owner_lists_holds_and_releases_the_unknown_ones_in_bulk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "holds.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$10", create=True)
    monkeypatch.setattr(_clock, "source", lambda: time.time() - 7_200)  # two hours ago
    for amount in ("$1", "$2"):
        with pytest.raises(TimeoutError), budget.pay(amount):
            raise TimeoutError("rpc timeout")
    monkeypatch.undo()
    recent = budget.reserve("$3")
    listed = _cli(path, "holds")
    assert listed.returncode == 0, listed.stderr
    assert re.search(
        r"wc-\w+ +\$1\.00 +unknown +2h 0m old +python +counts until released", listed.stdout
    )
    assert re.search(rf"{recent.id} +\$3\.00 +in flight +\d+s old", listed.stdout)
    assert len(json.loads(_cli(path, "holds", "--json").stdout)) == 3
    assert _cli(path, "release", "--all-unknown").returncode == 2
    released = _cli(path, "release", "--all-unknown", "--older-than", "1h")
    assert released.returncode == 0, released.stderr
    assert (
        "Released 2 payments of unknown or refused outcome older than 1h ($3.00 from 0xd797…ca02)"
        in released.stdout
    )
    assert [hold.id for hold in budget.holds()] == [recent.id]
    nothing = _cli(path, "release", "--all-unknown", "--older-than", "1h")
    assert "No payment of unknown or refused outcome" in nothing.stdout


def test_a_bulk_release_keeps_what_the_payee_could_still_settle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settle-by.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", create=True)
    now = time.time()
    monkeypatch.setattr(_clock, "source", lambda: now - 7_200)  # all three taken two hours ago
    live = budget.reserve(
        "$100", rail="x402", settles_by=datetime.fromtimestamp(now + 3_600, UTC)
    )
    lapsed = budget.reserve(
        "$20", rail="x402", settles_by=datetime.fromtimestamp(now - 3_600, UTC)
    )
    refused = budget.reserve("$10", rail="x402")  # as the CDP store reopens a rolled-back one
    monkeypatch.undo()
    live.annotate(outcome="unknown")
    lapsed.annotate(outcome="unknown")
    refused.annotate(outcome="refused")
    # 0.3.0 gave back the first too, with its authorization redeemable for another hour, and
    # kept the refused one counting until released one by one.
    released = _cli(path, "release", "--all-unknown", "--older-than", "1h")
    assert released.returncode == 0, released.stderr
    assert (
        "Released 2 payments of unknown or refused outcome older than 1h ($30.00 from 0xd797…ca02)"
        in released.stdout
    )
    assert [hold.id for hold in budget.holds()] == [live.id]
    assert not budget.check("$100").ok


def test_a_bulk_release_keeps_a_hold_without_a_settle_by_time_for_61_minutes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "unbounded.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$10", create=True)
    now = time.time()
    monkeypatch.setattr(_clock, "source", lambda: now - 62 * 60)  # taken 62 minutes ago
    old = budget.reserve("$1")
    monkeypatch.undo()
    fresh = budget.reserve("$2")
    for hold in (old, fresh):
        hold.annotate(outcome="unknown")  # the payment may have been signed as it failed
    time.sleep(0.02)
    # 0.3.0 gave back both 20 ms later, though the fresh one may still be settled.
    released = _cli(path, "release", "--all-unknown", "--older-than", "10ms")
    assert released.returncode == 0, released.stderr
    assert (
        "Released 1 payment of unknown or refused outcome older than 10ms ($1.00 from 0xd797…ca02)"
        in released.stdout
    )
    assert [hold.id for hold in budget.holds()] == [fresh.id]
    nothing = _cli(path, "release", "--all-unknown", "--older-than", "10ms")
    assert "can be released yet" in nothing.stdout
    assert "one with no settle-by time, once it is also an hour and a minute old" in nothing.stdout


def test_async_paths_wait_for_the_lock_in_a_thread_not_on_the_event_loop(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", create=True)
    script = (
        "import sqlite3, sys, time\n"
        "connection = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
        "connection.execute('BEGIN IMMEDIATE')\n"
        "print('locked', flush=True)\n"
        "time.sleep(0.5)\n"
        "connection.execute('COMMIT')\n"
    )
    holder = subprocess.Popen(  # noqa: S603 - this interpreter running a fixed script
        [sys.executable, "-c", script, str(path)], stdout=subprocess.PIPE, text=True
    )
    assert holder.stdout is not None
    assert holder.stdout.readline().strip() == "locked"

    async def run() -> int:
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        ticker = asyncio.create_task(tick())
        async with budget.pay("$5") as payment:
            payment.tx = TX
        status = await budget.astatus()
        ticker.cancel()
        assert status.spent == 5_000_000
        return ticks

    # While the payment waited half a second for the other process's lock, the loop kept running.
    assert asyncio.run(run()) >= 20
    assert holder.wait(timeout=30) == 0


def test_async_payments_and_history_keep_what_happened(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)

    async def pay() -> str:
        async with budget.pay("$5", to="0x4165cb72De51A67aac32DC33197d779552205efD") as payment:
            payment.tx = TX
            return payment.id

    spend_id = asyncio.run(pay())
    [entry] = asyncio.run(budget.ahistory())
    assert (entry.id, entry.status, entry.amount, entry.tx, entry.rail) == (
        spend_id,
        "settled",
        5_000_000,
        TX,
        "python",
    )
    assert entry.to == "0x4165cb72De51A67aac32DC33197d779552205efD"


def test_a_reservation_with_a_settle_by_time_counts_one_window_past_it(
    tmp_path: Path, clock: Clock
) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)
    settles_by = datetime.fromtimestamp(clock.at, tz=UTC) + timedelta(minutes=5)
    budget.reserve("$100", settles_by=settles_by)
    clock.at += 300 + DAY
    assert budget.status().in_flight == 100_000_000
    clock.at += 0.002
    assert budget.status().in_flight == 0
    assert budget.history()[0].status == "expired"


def test_a_naive_settle_by_time_is_refused(tmp_path: Path, clock: Clock) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)
    # 0.2.x read a naive datetime as this machine's local time: 9 hours early in Tokyo.
    naive = datetime(2027, 1, 15, 8, 0)
    with pytest.raises(BudgetError, match="timezone-aware"):
        budget.reserve("$1", settles_by=naive)
    with pytest.raises(BudgetError, match="timezone-aware"), budget.pay("$1", settles_by=naive):
        pass
    assert budget.status().in_flight == 0
    # An aware time that isn't after now is refused too: the payment is made after it is reserved.
    with pytest.raises(BudgetError, match="is not after now"):
        budget.reserve("$150", settles_by=datetime(2000, 1, 1, tzinfo=UTC))
    assert budget.status().in_flight == 0


def test_freeze_check_and_mistakes(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", max_payments=1, create=True)
    assert budget.check("$150").ok
    budget.freeze()
    check = budget.check("$1")
    assert (check.ok, check.reason) == (False, "frozen")
    budget.unfreeze()
    _pay(budget, "$1")
    assert budget.check("$1").reason == "max_payments"
    with pytest.raises(BudgetError, match="not 40 hex digits"):
        open_budget(WALLET[:-1], path=path, per_day="$1")
    with pytest.raises(BudgetError, match="has no declared budget"):
        open_budget("0x" + "0" * 39 + "1", path=path)
    with pytest.raises(BudgetError, match="no budget file"):
        open_budget(WALLET, path=tmp_path / "missing.sqlite", create=False)


def test_the_default_is_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / "default-missing.sqlite"
    with pytest.raises(BudgetError, match="no budget file"):
        open_budget(WALLET, path=path, per_day="$5")
    budget = open_budget(WALLET, path=path, per_day="$5", create=True)
    assert budget.status().cap == 5_000_000
    budget.close()
    corrupt = tmp_path / "corrupt.sqlite"
    corrupt.write_text("not a database " * 100)
    with pytest.raises(BudgetError, match="cannot be used"):
        open_budget(WALLET, path=corrupt, per_day="$1")


@pytest.mark.parametrize(
    ("value", "micros"),
    [
        ("$12.50", 12_500_000),
        ("12.50 USDC", 12_500_000),
        ("$1,000", 1_000_000_000),
        (0.1 + 0.2, 300_000),
        (150, 150_000_000),
    ],
)
def test_dollars_are_read_the_way_people_write_them(value: object, micros: int) -> None:
    assert to_micros(value) == micros


@pytest.mark.parametrize("value", ["-5", "1,5", "0.0000001", True, float("nan"), "12 EUR", None])
def test_amounts_that_are_not_dollars_are_refused(value: object) -> None:
    with pytest.raises(BudgetError):
        to_micros(value)


def test_amounts_stop_at_a_billion_dollars() -> None:
    assert to_micros("$1,000,000,000") == 10**15
    for value in ("$1,000,000,000.000001", 1_000_000_001, 9_223_372_036_854):
        with pytest.raises(BudgetError, match=r"more than \$1,000,000,000\.00"):
            to_micros(value)


def test_amounts_format_the_same_as_javascript() -> None:
    assert [format_usd(value) for value in (150_000_000, 50_000, 1, 1_234_500_000)] == [
        "$150.00",
        "$0.05",
        "$0.000001",
        "$1,234.50",
    ]


def _cli(path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - this interpreter running the package's own CLI
        [sys.executable, "-m", "walletcap", "--path", str(path), *args],
        capture_output=True,
        text=True,
        check=False,
        env={"PYTHONPATH": str(SOURCE), "PATH": "/usr/bin:/bin"},
    )


def test_the_python_cli_sets_reads_and_freezes(tmp_path: Path) -> None:
    path = tmp_path / "cli.sqlite"
    assert "No budget in" in _cli(path).stdout
    created = _cli(path, "set", "--wallet", CHECKSUMMED, "--per-day", "150", "--per-payment", "50")
    assert created.returncode == 0, created.stderr
    assert "$150.00 per 24h, at most $50.00 a payment" in created.stdout
    budget = open_budget(WALLET, path=path)
    _pay(budget, "$40")
    raised = _cli(path, "set", "--per-day", "300")
    assert "$40.00 spent, $0.00 in flight, $260.00 left" in raised.stdout
    assert _cli(path, "freeze").returncode == 0
    frozen = json.loads(_cli(path, "status", "--json").stdout)
    assert frozen["budgets"][0]["frozen"] is True
    assert frozen["budgets"][0]["spent"] == "40000000"
    with pytest.raises(BudgetRefused):
        _pay(budget, "$1")
    assert _cli(path, "unfreeze").returncode == 0
    held = budget.reserve("$1")
    assert held.id in _cli(path, "history").stdout
    assert _cli(path, "release", held.id).returncode == 0
    assert budget.status().in_flight == 0
    assert _cli(path, "release", held.id).returncode == 1


def test_an_owner_can_release_a_payment_whose_outcome_is_unknown(tmp_path: Path) -> None:
    path = tmp_path / "unknown.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$10", create=True)
    with pytest.raises(TimeoutError), budget.pay("$4"):
        raise TimeoutError("rpc timeout")
    [payment] = budget.history()
    assert f"({payment.id})" in _cli(path, "history").stdout
    released = _cli(path, "release", payment.id)
    assert released.returncode == 0, released.stderr
    assert budget.status().in_flight == 0


def test_the_python_cli_reads_counts_in_ascii_digits_only(tmp_path: Path) -> None:
    path = tmp_path / "counts.sqlite"
    # 0.2.x read Arabic-Indic digits as a number: --max-payments ١٢ was 12.
    refused = _cli(path, "set", "--wallet", WALLET, "--per-day", "150", "--max-payments", "١٢")
    assert refused.returncode == 1
    assert "whole number" in refused.stderr
    created = _cli(path, "set", "--wallet", WALLET, "--per-day", "150", "--max-payments", " 12 ")
    assert created.returncode == 0, created.stderr
    assert _cli(path, "history", "--limit", "١٢").returncode == 2
    assert _cli(path, "history", "--limit", "12").returncode == 0
    # Thousands of digits are refused as such, not with a ValueError's traceback.
    long = _cli(path, "set", "--wallet", WALLET, "--per-day", "150", "--max-payments", "9" * 5000)
    assert (long.returncode, "Traceback" in long.stderr) == (1, False)
    assert _cli(path, "history", "--limit", "9" * 5000).returncode == 2


@needs_node
def test_python_and_javascript_spend_from_one_budget(tmp_path: Path) -> None:
    assert NODE is not None
    path = tmp_path / "shared.sqlite"
    budget = open_budget(CHECKSUMMED, path=path, per_payment="$50", per_day="$150", create=True)
    _pay(budget, "$50")
    _pay(budget, "$50")
    script = (
        "const { openBudget } = await import(process.argv[1]);"
        "const budget = await openBudget({ wallet: process.argv[2], path: process.argv[3] });"
        "const results = [];"
        "for (const amount of ['$50', '$50']) {"
        "  try { await budget.pay(amount, async () => 'ok'); results.push('paid'); }"
        "  catch (error) { results.push(error.reason); } }"
        "console.log(JSON.stringify({ results, spent: String((await budget.status()).spent) }));"
    )
    result = subprocess.run(  # noqa: S603 - fixed local Node script, owned test file in argv
        [NODE, "--input-type=module", "-e", script, str(JS / "dist" / "index.js"), WALLET, str(path)],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"results": ["paid", "budget"], "spent": "150000000"}
    with pytest.raises(BudgetRefused):
        _pay(budget, "$1")
    assert [payment.rail for payment in budget.history()] == ["js", "python", "python"]


@needs_node
@pytest.mark.parametrize(
    ("env", "platform"),
    [
        ({}, "linux"),
        ({"XDG_STATE_HOME": "/var/state"}, "linux"),
        ({"XDG_STATE_HOME": "relative"}, "linux"),
        ({}, "darwin"),
        ({"WALLETCAP_PATH": "/data/budget.sqlite"}, "linux"),
        ({"WALLETCAP_PATH": "~/b.sqlite"}, "darwin"),
    ],
)
def test_both_languages_find_the_same_default_file(env: dict[str, str], platform: str) -> None:
    assert NODE is not None
    home = "/home/agent"
    script = (
        "const { defaultBudgetPath } = await import(process.argv[1]);"
        "const [, , env, platform, home] = process.argv;"
        "console.log(defaultBudgetPath(JSON.parse(env), platform, home));"
    )
    result = subprocess.run(  # noqa: S603 - fixed local Node script
        [NODE, "--input-type=module", "-e", script, str(JS / "dist" / "money.js"), json.dumps(env)]
        + [platform, home],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    assert result.stdout.strip() == str(default_budget_path(env, platform, Path(home)))


def test_a_warning_names_the_command_that_raises_the_limit(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    open_budget(WALLET, path=path, per_day="$10", create=True)
    messages: list[str] = []
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        open_budget(WALLET, path=path, per_day="$20", on_warning=messages.append)
    assert len(messages) == 1
    assert f"walletcap set --wallet {WALLET} --path {path} --per-day 20" in messages[0]


def test_the_clock_is_not_an_option(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", create=True)
    _pay(budget, "$150")
    # 0.2.x took a clock per process; one running a day ahead saw an empty budget.
    with pytest.raises(TypeError):
        open_budget(WALLET, path=path, clock=lambda: 1e10)
    with pytest.raises(BudgetRefused):
        _pay(open_budget(WALLET, path=path), "$150")


FIXTURES = ROOT / "spec" / "fixtures"
T0 = 1_800_000_000_000
APP = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
MERGED = "0x4165cb72De51A67aac32DC33197d779552205efD"


def _fixture(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    shutil.copyfile(FIXTURES / name, path)
    return path


def test_a_0_2_file_is_upgraded_on_open(tmp_path: Path, clock: Clock) -> None:
    clock.at = T0 / 1000
    path = _fixture(tmp_path, "schema-1.sqlite")
    # 0.2.4 kept budgets under the names it was given: the checksummed address, its CAIP-10
    # form and the lowercase address each held one. They are one budget now.
    upgraded = open_budget(MERGED, path=path)
    status = upgraded.status()
    # The tighter of every limit: the smallest cap and per-payment limit, and the longest window.
    assert (status.cap, status.window_ms, status.per_payment, status.max_payments) == (
        150_000_000,
        86_400_000,
        50_000_000,
        10,
    )
    assert (status.spent, status.in_flight, status.remaining) == (
        110_000_000,
        20_000_000,
        20_000_000,
    )
    with pytest.raises(BudgetRefused):
        _pay(upgraded, "$20.01")
    _pay(upgraded, "$20")
    assert {"spend-a", "spend-b", "spend-c"} <= {payment.id for payment in upgraded.history()}
    with closing(sqlite3.connect(path)) as connection:
        schema = connection.execute("SELECT value FROM budget_meta WHERE key = 'schema'")
        assert schema.fetchone() == ("3",)


def test_the_upgrade_says_what_it_did(tmp_path: Path, clock: Clock) -> None:
    clock.at = T0 / 1000
    path = _fixture(tmp_path, "schema-1.sqlite")
    # 0.2.4 kept $150 a day under the app's checksummed address and $100 under the lowercase one:
    # the upgrade kept $100. Code that asks for $150 is told why the stored limit is lower.
    messages: list[str] = []
    open_budget(APP, path=path, per_day="$150", on_warning=messages.append)
    assert messages[0].endswith(
        "The 0.3.0 upgrade merged the budget 0.2.x kept under "
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed into this one, with the tighter of each "
        "limit; its owner can change them with 'walletcap set'"
    )
    # Another wallet kept a budget in wei beside its dollar one: that wallet alone is frozen,
    # and says why.
    frozen = open_budget(WALLET, path=path)
    with pytest.raises(BudgetRefused) as refused:
        _pay(frozen, "$1")
    assert refused.value.reason == "frozen"
    assert str(refused.value).endswith(
        f"The 0.3.0 upgrade froze it: 0.2.x also kept a budget in wei under {CHECKSUMMED} for "
        "this wallet, which can't be merged with this one in usd, so that budget no longer counts"
    )
    _pay(open_budget(APP, path=path), "$1")
    status = _cli(path, "status")
    assert status.returncode == 0, status.stderr
    assert status.stdout.count("0xd797") == 1
    frozen.unfreeze()
    _pay(frozen, "$1")
    frozen.freeze()
    with pytest.raises(BudgetRefused) as again:
        _pay(frozen, "$1")
    assert "0.3.0 upgrade" not in str(again.value)
