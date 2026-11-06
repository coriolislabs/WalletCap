"""The shared spend ledger: one budget that restarts, racing processes and rails all count in."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src"
sys.path.insert(0, str(SOURCE))

from walletcap import (  # noqa: E402
    MAX_AMOUNT,
    BudgetError,
    BudgetRevoked,
    Ledger,
    OverBudget,
    OverPerPayment,
    OverUses,
    _clock,
)

DAY = 86_400


class Clock:
    def __init__(self, at: float = 1_000_000.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    """The ledger's own clock, replaced through the private hook for one test."""

    fake = Clock()
    monkeypatch.setattr(_clock, "source", fake)
    return fake


def _ledger(path: Path, **options: int) -> Ledger:
    ledger = Ledger(path, **options)
    ledger.declare("agent", unit="usdc", cap=150, window_seconds=DAY, per_payment=50)
    return ledger


def _pay(ledger: Ledger, amount: int = 50) -> str:
    spend_id = ledger.reserve("agent", amount)
    ledger.commit(spend_id)
    return spend_id


def test_a_restart_reads_the_same_count(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    for _ in range(3):
        _pay(ledger)
    restarted = Ledger(tmp_path / "budget.sqlite")
    with pytest.raises(OverBudget) as refused:
        restarted.reserve("agent", 1)
    assert refused.value.reason == "budget"
    assert restarted.status("agent").spent == 150


def test_racing_processes_cannot_both_take_the_last_of_the_budget(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    _ledger(path)
    go = tmp_path / "go"
    script = """
import pathlib, sys, time
sys.path.insert(0, sys.argv[1])
from walletcap import BudgetRefused, Ledger
ledger = Ledger(sys.argv[2])
pathlib.Path(sys.argv[3]).touch()
while not pathlib.Path(sys.argv[4]).exists():
    time.sleep(0.002)
won = 0
for _ in range(3):
    try:
        spend_id = ledger.reserve("agent", 50)
    except BudgetRefused:
        continue
    ledger.commit(spend_id)
    won += 1
print(won)
"""
    workers = []
    for index in range(4):
        ready = tmp_path / f"ready-{index}"
        workers.append(
            (
                ready,
                subprocess.Popen(  # noqa: S603 - this interpreter running a fixed script
                    [sys.executable, "-c", script, str(SOURCE), str(path), str(ready), str(go)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                ),
            )
        )
    deadline = time.monotonic() + 60
    while not all(ready.exists() for ready, _ in workers):
        assert time.monotonic() < deadline, "workers did not start"
        time.sleep(0.01)
    go.touch()
    won = 0
    for _, worker in workers:
        stdout, stderr = worker.communicate(timeout=120)
        assert worker.returncode == 0, stderr
        won += int(stdout)
    # Twelve attempts at $50 from four processes; exactly $150 of them may win.
    assert won == 3
    assert Ledger(path).status("agent").spent == 150


def test_spend_counts_for_the_whole_window_then_ages_out(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    for _ in range(3):
        _pay(ledger)
    clock.at += DAY  # a payment counts while at + window >= now
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    clock.at += 0.001
    assert ledger.status("agent").spent == 0
    _pay(ledger)
    assert ledger.status("agent").spent == 50


def test_a_payment_over_the_per_payment_max_is_refused(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    with pytest.raises(OverPerPayment) as refused:
        ledger.reserve("agent", 51)
    assert refused.value.reason == "per_payment"
    assert ledger.status("agent").uses == 0


def test_the_use_count_is_per_window(tmp_path: Path, clock: Clock) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite")
    ledger.declare("agent", unit="usdc", cap=150, window_seconds=DAY, max_uses=2)
    _pay(ledger, 10)
    _pay(ledger, 10)
    with pytest.raises(OverUses):
        ledger.reserve("agent", 10)
    clock.at += DAY + 1
    _pay(ledger, 10)


def test_a_revoke_refuses_new_reservations_but_lets_in_flight_payments_commit(
    tmp_path: Path,
) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    in_flight = ledger.reserve("agent", 50)
    ledger.revoke("agent")
    with pytest.raises(BudgetRevoked) as refused:
        ledger.reserve("agent", 1)
    assert refused.value.reason == "revoked"
    ledger.commit(in_flight)
    status = ledger.status("agent")
    assert (status.revoked, status.spent, status.remaining) == (True, 50, 0)


def test_a_released_reservation_gives_the_budget_back(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [ledger.reserve("agent", 50) for _ in range(3)]
    assert ledger.status("agent").reserved == 150
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    ledger.release(held[0])
    _pay(ledger)
    with pytest.raises(BudgetError, match="uncommitted"):
        ledger.release(held[0])
    status = ledger.status("agent")
    assert (status.spent, status.reserved, status.uses) == (50, 100, 3)


def test_an_open_reservation_counts_past_the_window_and_settles_into_a_new_one(
    tmp_path: Path, clock: Clock
) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [ledger.reserve("agent", 50) for _ in range(3)]
    clock.at += DAY + 1  # still unsettled a window later: an unknown outcome keeps counting
    assert ledger.status("agent").reserved == 150
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    for spend_id in held:
        ledger.commit(spend_id)
    # Settled late, the payments count for a whole window from their settlement.
    clock.at += DAY
    assert ledger.status("agent").spent == 150
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    clock.at += 0.001
    assert ledger.status("agent").spent == 0


def test_a_hold_never_lapses_while_its_payment_can_still_settle(
    tmp_path: Path, clock: Clock
) -> None:
    # 0.2.x had reservation_ttl_seconds: a hold lapsed after it although its payment could
    # still settle, so a second full cap was reserved and both settled, $300 on a $150 cap.
    with pytest.raises(TypeError):
        Ledger(tmp_path / "ttl.sqlite", reservation_ttl_seconds=60)  # type: ignore[call-arg]
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [ledger.reserve("agent", 50) for _ in range(3)]
    clock.at += 61
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    clock.at += 30 * DAY
    assert ledger.status("agent").reserved == 150
    assert ledger.compact("agent") == 0
    for spend_id in held:
        ledger.commit(spend_id)
    assert ledger.status("agent").spent == 150


def test_a_settle_by_time_already_past_counts_as_now(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    # 0.2.x stored the past moment as given: the holds never counted, and more was reserved.
    held = [ledger.reserve("agent", 50, settles_by_ms=0) for _ in range(3)]
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)
    clock.at += DAY
    assert ledger.status("agent").reserved == 150
    clock.at += 0.001
    assert ledger.status("agent").reserved == 0
    for spend_id in held:
        ledger.commit(spend_id)  # settled late after all: they count again, from now
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 50)


def test_amounts_and_caps_stop_at_a_billion_dollars_so_no_sum_overflows(
    tmp_path: Path, clock: Clock
) -> None:
    assert MAX_AMOUNT == 10**15
    ledger = Ledger(tmp_path / "budget.sqlite")
    for too_much in (MAX_AMOUNT + 1, 2**63 - 1):
        with pytest.raises(BudgetError, match="at most 1000000000000000"):
            ledger.declare("big", unit="usd", cap=too_much, window_seconds=DAY)
    ledger.declare("agent", unit="usd", cap=MAX_AMOUNT, window_seconds=DAY)
    with pytest.raises(BudgetError, match="at most 1000000000000000"):
        ledger.reserve("agent", MAX_AMOUNT + 1)
    # Two holds of the most a budget can hold count at once: one lapsed, then settled late.
    # 0.2.x took near-2^63 amounts, and two of them overflowed SQLite's SUM for good.
    first = ledger.reserve("agent", MAX_AMOUNT, settles_by_ms=int(clock.at * 1000))
    clock.at += DAY + 1
    ledger.reserve("agent", MAX_AMOUNT)
    ledger.commit(first)
    status = ledger.status("agent")
    assert (status.spent, status.reserved, status.remaining) == (MAX_AMOUNT, MAX_AMOUNT, 0)
    with pytest.raises(OverBudget):
        ledger.reserve("agent", 1)


def test_a_checksummed_address_names_the_one_lowercase_budget(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite")
    lower = "0xd797ead28c38575fdf4fc523866287372340ca02"
    checksummed = "0xd797ead28C38575FDf4fC523866287372340Ca02"
    # 0.2.x kept Ledger.declare's name as given: a checksummed address opened a second budget.
    ledger.declare(checksummed, unit="usd", cap=150, window_seconds=DAY)
    ledger.reserve(lower, 150)
    for name in (checksummed, f"eip155:8453:{checksummed}", "0x" + lower[2:].upper()):
        with pytest.raises(OverBudget):
            ledger.reserve(name, 1)
    with pytest.raises(BudgetError, match="other limits"):
        ledger.declare(lower, unit="usd", cap=300, window_seconds=DAY)
    assert [budget.instrument for budget in ledger.budgets()] == [lower]
    assert ledger.status(checksummed).instrument == lower
    # A mistyped checksum is refused rather than opening a budget of its own.
    with pytest.raises(BudgetError, match="EIP-55"):
        ledger.declare(
            "0xD797ead28C38575FDf4fC523866287372340Ca02", unit="usd", cap=1, window_seconds=1
        )


def test_a_committed_reservation_cannot_be_committed_or_released_again(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    spend_id = _pay(ledger)
    with pytest.raises(BudgetError, match="already committed"):
        ledger.commit(spend_id)
    with pytest.raises(BudgetError, match="uncommitted"):
        ledger.release(spend_id)
    with pytest.raises(BudgetError, match="unknown reservation"):
        ledger.commit("spend-missing")


def test_declaring_again_with_other_limits_is_refused(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    ledger.declare("agent", unit="usdc", cap=150, window_seconds=DAY, per_payment=50)
    with pytest.raises(BudgetError, match="other limits"):
        ledger.declare("agent", unit="usdc", cap=300, window_seconds=DAY, per_payment=50)
    with pytest.raises(BudgetError, match="no declared budget"):
        ledger.reserve("someone-else", 1)


@pytest.mark.parametrize("amount", [0, -1, True, 2**63, 1.5, "50"])
def test_a_malformed_amount_is_refused(tmp_path: Path, amount: object) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    with pytest.raises(BudgetError, match="integer"):
        ledger.reserve("agent", amount)  # type: ignore[arg-type]


@pytest.mark.parametrize("instrument", ["", "has space", "x" * 129, "semi;colon"])
def test_a_malformed_identifier_is_refused(tmp_path: Path, instrument: str) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite")
    with pytest.raises(BudgetError, match="identifier"):
        ledger.declare(instrument, unit="usdc", cap=1, window_seconds=1)


def test_compact_deletes_only_rows_that_no_longer_count(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    _pay(ledger)
    still_open = ledger.reserve("agent", 50)
    clock.at += DAY + 1
    _pay(ledger)
    assert ledger.compact("agent") == 1
    status = ledger.status("agent")
    assert (status.spent, status.reserved) == (50, 50)
    ledger.commit(still_open)
    assert ledger.status("agent").spent == 100


def test_a_ledger_from_another_schema_version_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    Ledger(path)
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE budget_meta SET value = '2' WHERE key = 'schema'")
    with pytest.raises(BudgetError, match="schema 2"):
        Ledger(path)


def test_the_clock_is_not_an_option(tmp_path: Path) -> None:
    # 0.2.x took a clock per Ledger; a process running a day ahead saw an empty budget.
    with pytest.raises(TypeError):
        Ledger(tmp_path / "budget.sqlite", clock=lambda: 2_000_000_000.0)  # type: ignore[call-arg]
