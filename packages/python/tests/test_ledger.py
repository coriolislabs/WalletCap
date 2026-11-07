"""The ledger client: the rule in spec/schema.sql, run from Python against one shared file."""

from __future__ import annotations

import os
import sqlite3
import stat
import subprocess
import sys
import time
from contextlib import closing
from functools import cached_property
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / "src"
sys.path.insert(0, str(SOURCE))

from walletcap import MAX_AMOUNT, BudgetRefused, BudgetUnavailable, UsageError, _clock  # noqa: E402
from walletcap._ledger import Ledger as _Base  # noqa: E402
from walletcap._ledger import Row  # noqa: E402


class Ledger(_Base):
    """The ledger as one process that keeps the token of every payment it holds.

    A payer's moves need the token its hold returned (spec/ledger.md, Identity); these tests act
    as that one process unless they pass a token of their own.
    """

    @cached_property
    def tokens(self) -> dict[str, str]:
        return {}

    def hold(self, name: str, amount: int, **kwargs: Any) -> Row:
        row = super().hold(name, amount, **kwargs)
        if row["holder"] is not None:
            self.tokens[str(row["payment"])] = str(row["holder"])
        return row

    def settle(
        self, payment: str, *, holder: str | None = None, evidence: str | None = None
    ) -> Row:
        return super().settle(payment, holder=holder or self.tokens.get(payment), evidence=evidence)

    def void(self, payment: str, *, holder: str | None = None, evidence: str | None = None) -> Row:
        return super().void(payment, holder=holder or self.tokens.get(payment), evidence=evidence)

    def bound(
        self,
        payment: str,
        *,
        holder: str | None = None,
        until: int | None = None,
        within_ms: int | None = None,
    ) -> Row:
        token = holder or self.tokens.get(payment)
        return super().bound(payment, holder=token, until=until, within_ms=within_ms)

    def note(
        self, payment: str, outcome: str, *, holder: str | None = None, evidence: str | None = None
    ) -> Row:
        token = holder or self.tokens.get(payment)
        return super().note(payment, outcome, holder=token, evidence=evidence)


DAY = 86_400_000
CURRENT = (
    "SELECT payment, wallet, amount, state, held_at, until, outcome, counts_from "
    "FROM wc_current ORDER BY payment"
)


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


def _ledger(path: Path) -> Ledger:
    ledger = Ledger(path, create=True)
    ledger.create_budget("agent", unit="usdc", cap=150, window_ms=DAY, per_payment=50)
    return ledger


def _pay(ledger: Ledger, amount: int = 50) -> str:
    payment = str(ledger.hold("agent", amount, rail="python")["payment"])
    ledger.settle(payment)
    return payment


def test_a_restart_reads_the_same_count(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    for _ in range(3):
        _pay(ledger)
    restarted = Ledger(tmp_path / "budget.sqlite")
    with pytest.raises(BudgetRefused) as refused:
        restarted.hold("agent", 1, rail="python")
    assert refused.value.code == "budget"
    assert restarted.status("agent")["spent"] == 150


def test_racing_processes_cannot_both_take_the_last_of_the_budget(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    _ledger(path)
    go = tmp_path / "go"
    script = """
import pathlib, sys, time
sys.path.insert(0, sys.argv[1])
from walletcap import BudgetRefused
from walletcap._ledger import Ledger
ledger = Ledger(sys.argv[2])
pathlib.Path(sys.argv[3]).touch()
while not pathlib.Path(sys.argv[4]).exists():
    time.sleep(0.002)
won = 0
for _ in range(3):
    try:
        held = ledger.hold("agent", 50, rail="python")
    except BudgetRefused:
        continue
    ledger.settle(held["payment"], holder=held["holder"])
    won += 1
print(won)
"""
    workers = []
    for index in range(4):
        ready = tmp_path / f"ready-{index}"
        workers.append(
            (
                ready,
                subprocess.Popen(
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
    assert Ledger(path).status("agent")["spent"] == 150


def test_spend_counts_for_the_whole_window_then_ages_out(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    for _ in range(3):
        _pay(ledger)
    clock.at += DAY / 1000  # a payment counts while counts_from >= now - window
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    clock.at += 0.001
    assert ledger.status("agent")["spent"] == 0
    _pay(ledger)
    assert ledger.status("agent")["spent"] == 50


def test_the_limits_refuse_in_order(tmp_path: Path, clock: Clock) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite", create=True)
    ledger.create_budget(
        "agent", unit="usdc", cap=150, window_ms=DAY, per_payment=50, max_payments=2
    )
    with pytest.raises(BudgetRefused) as over:
        ledger.hold("agent", 51, rail="python")
    assert over.value.code == "per_payment"
    _pay(ledger, 10)
    _pay(ledger, 10)
    with pytest.raises(BudgetRefused) as many:
        ledger.hold("agent", 10, rail="python")
    assert many.value.code == "max_payments"
    clock.at += DAY / 1000 + 1
    _pay(ledger, 10)


def test_a_freeze_refuses_new_holds_but_lets_held_payments_settle(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = str(ledger.hold("agent", 50, rail="python")["payment"])
    ledger.freeze("agent")
    with pytest.raises(BudgetRefused) as refused:
        ledger.hold("agent", 1, rail="python")
    assert refused.value.code == "frozen"
    ledger.settle(held)
    status = ledger.status("agent")
    assert (status["frozen_at"] is not None, status["spent"], status["remaining"]) == (True, 50, 0)


def test_a_void_gives_the_budget_back_and_states_only_move_forward(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [str(ledger.hold("agent", 50, rail="python")["payment"]) for _ in range(3)]
    assert ledger.status("agent")["in_flight"] == 150
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    assert ledger.void(held[0])["state"] == "void"
    assert ledger.void(held[0])["state"] == "void"  # idempotent
    settled = _pay(ledger)
    assert ledger.settle(settled)["state"] == "settled"  # idempotent
    with pytest.raises(UsageError, match="can't be voided"):
        ledger.void(settled)
    with pytest.raises(UsageError, match="no payment"):
        ledger.settle("wc-missing")
    status = ledger.status("agent")
    assert (status["spent"], status["in_flight"], status["payments"]) == (50, 100, 3)
    # Later evidence that a voided payment paid after all counts it again.
    assert ledger.settle(held[0])["state"] == "settled"
    assert ledger.status("agent")["spent"] == 100


def test_an_open_hold_counts_past_the_window_and_settles_into_a_new_one(
    tmp_path: Path, clock: Clock
) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [str(ledger.hold("agent", 50, rail="python")["payment"]) for _ in range(3)]
    clock.at += DAY / 1000 + 1  # still open a window later: an unknown outcome keeps counting
    assert ledger.status("agent")["in_flight"] == 150
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    for payment in held:
        ledger.settle(payment)
    # Settled late, the payments count for a whole window from their settlement.
    clock.at += DAY / 1000
    assert ledger.status("agent")["spent"] == 150
    clock.at += 0.001
    assert ledger.status("agent")["spent"] == 0


def test_a_hold_never_lapses_while_its_payment_can_still_settle(
    tmp_path: Path, clock: Clock
) -> None:
    # 0.2.x had reservation_ttl_seconds: a hold lapsed after it although its payment could
    # still settle, so a second full cap was reserved and both settled, $300 on a $150 cap.
    with pytest.raises(TypeError):
        Ledger(tmp_path / "ttl.sqlite", reservation_ttl_seconds=60)  # type: ignore[call-arg]
    ledger = _ledger(tmp_path / "budget.sqlite")
    held = [str(ledger.hold("agent", 50, rail="python")["payment"]) for _ in range(3)]
    clock.at += 61
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    clock.at += 30 * DAY / 1000
    assert ledger.status("agent")["in_flight"] == 150
    for payment in held:
        ledger.settle(payment)
    assert ledger.status("agent")["spent"] == 150


def test_a_settle_by_time_that_isnt_after_now_is_refused(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    now = int(clock.at * 1000)
    # 0.2.x stored a past moment as given: the holds never counted, and more was reserved.
    for until in (0, now - 1, now):
        with pytest.raises(UsageError, match="is not after now"):
            ledger.hold("agent", 50, rail="python", until=until)
    assert ledger.status("agent")["payments"] == 0
    held = [
        str(ledger.hold("agent", 50, rail="python", until=now + 1)["payment"]) for _ in range(3)
    ]
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    clock.at += DAY / 1000 + 0.002
    assert ledger.status("agent")["in_flight"] == 0
    for payment in held:
        ledger.settle(payment)  # settled late after all: they count again, from now
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")


def test_amounts_and_caps_stop_at_a_billion_dollars_so_no_sum_overflows(
    tmp_path: Path, clock: Clock
) -> None:
    assert MAX_AMOUNT == 10**15
    ledger = Ledger(tmp_path / "budget.sqlite", create=True)
    for too_much in (MAX_AMOUNT + 1, 2**63 - 1):
        with pytest.raises(UsageError, match="from 0 to 1000000000000000"):
            ledger.create_budget("big", unit="usd", cap=too_much, window_ms=DAY)
    ledger.create_budget("agent", unit="usd", cap=MAX_AMOUNT, window_ms=DAY)
    with pytest.raises(UsageError, match="from 1 to 1000000000000000"):
        ledger.hold("agent", MAX_AMOUNT + 1, rail="python")
    # Two holds of the most a budget can hold count at once: one lapsed, then settled late.
    first = str(
        ledger.hold("agent", MAX_AMOUNT, rail="python", until=int(clock.at * 1000) + 1)["payment"]
    )
    clock.at += DAY / 1000 + 1
    ledger.hold("agent", MAX_AMOUNT, rail="python")
    ledger.settle(first)
    status = ledger.status("agent")
    assert (status["spent"], status["in_flight"], status["remaining"]) == (
        MAX_AMOUNT,
        MAX_AMOUNT,
        0,
    )
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 1, rail="python")


def test_a_settlement_never_shortens_a_hold(tmp_path: Path, clock: Clock) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    # A payee can say a payment settled at once and keep an authorization valid two days.
    until = int(clock.at * 1000) + 2 * DAY
    for payment in [
        ledger.hold("agent", 50, rail="python", until=until)["payment"] for _ in range(3)
    ]:
        ledger.settle(str(payment))
    clock.at += DAY / 1000 + 1
    assert ledger.status("agent")["spent"] == 150
    with pytest.raises(BudgetRefused):
        ledger.hold("agent", 50, rail="python")
    clock.at += 2 * DAY / 1000 - 1  # the settle-by time plus one window
    assert ledger.status("agent")["spent"] == 150
    assert [bool(row["counting"]) for row in ledger.history("agent")] == [True, True, True]
    clock.at += 0.001
    assert ledger.status("agent")["spent"] == 0
    _pay(ledger)


def test_the_time_is_read_once_the_write_lock_is_held(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    ledger = _ledger(path)
    script = (
        "import sqlite3, sys, time\n"
        "connection = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
        "connection.execute('BEGIN IMMEDIATE')\n"
        "print('locked', flush=True)\n"
        "time.sleep(0.4)\n"
        "connection.execute('COMMIT')\n"
    )
    # Another process takes the write lock and holds it for 400 ms.
    holder = subprocess.Popen(
        [sys.executable, "-c", script, str(path)], stdout=subprocess.PIPE, text=True
    )
    assert holder.stdout is not None
    assert holder.stdout.readline().strip() == "locked"
    asked = time.time()
    held = ledger.hold("agent", 1, rail="python")
    # 0.3.0 read the time before it waited for the lock, so the payment was dated, and stopped
    # counting, as much as the wait earlier than it was taken. The ledger dates it in SQL now.
    assert held["at"] / 1000 - asked >= 0.25
    assert holder.wait(timeout=30) == 0


def test_a_checksummed_address_names_the_one_lowercase_budget(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite", create=True)
    lower = "0xd797ead28c38575fdf4fc523866287372340ca02"
    checksummed = "0xd797ead28C38575FDf4fC523866287372340Ca02"
    # 0.2.x kept Ledger.declare's name as given: a checksummed address opened a second budget.
    ledger.create_budget(checksummed, unit="usd", cap=150, window_ms=DAY)
    ledger.hold(lower, 150, rail="python")
    for name in (checksummed, f"eip155:8453:{checksummed}", "0x" + lower[2:].upper()):
        with pytest.raises(BudgetRefused):
            ledger.hold(name, 1, rail="python")
    with pytest.raises(UsageError, match="already has a budget"):
        ledger.create_budget(lower, unit="usd", cap=300, window_ms=DAY)
    assert [budget["wallet"] for budget in ledger.budgets()] == [lower]
    assert ledger.status(checksummed)["wallet"] == lower
    # A mistyped checksum is refused rather than opening a budget of its own.
    with pytest.raises(UsageError, match="EIP-55"):
        ledger.create_budget(
            "0xD797ead28C38575FDf4fC523866287372340Ca02", unit="usd", cap=1, window_ms=1
        )


def test_one_identity_is_one_payment(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    nonce = "0x" + "11" * 32
    payment = f"eip3009:0xd797ead28c38575fdf4fc523866287372340ca02:{nonce}"
    assert ledger.hold("agent", 50, rail="x402", payment=payment)["created"] is True
    # The same signed authorization seen twice is one payment, counted once.
    assert ledger.hold("agent", 50, rail="x402", payment=payment)["created"] is False
    with pytest.raises(UsageError, match="already in the ledger"):
        ledger.hold("agent", 40, rail="x402", payment=payment)
    assert ledger.status("agent")["payments"] == 1


@pytest.mark.parametrize("amount", [0, -1, True, 2**63, 1.5, "50"])
def test_a_malformed_amount_is_refused(tmp_path: Path, amount: object) -> None:
    ledger = _ledger(tmp_path / "budget.sqlite")
    with pytest.raises(UsageError, match="integer"):
        ledger.hold("agent", amount, rail="python")  # type: ignore[arg-type]


@pytest.mark.parametrize("wallet", ["", "has space", "x" * 129, "semi;colon"])
def test_a_malformed_wallet_is_refused(tmp_path: Path, wallet: str) -> None:
    ledger = Ledger(tmp_path / "budget.sqlite", create=True)
    with pytest.raises(UsageError, match="wallet"):
        ledger.create_budget(wallet, unit="usdc", cap=1, window_ms=1)


def test_files_walletcap_did_not_write_or_cannot_read_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    Ledger(path, create=True)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("UPDATE budget_meta SET value = '4' WHERE key = 'schema'")
    with pytest.raises(BudgetUnavailable, match="schema 4, which a newer walletcap wrote"):
        Ledger(path)
    other = tmp_path / "other.sqlite"
    with closing(sqlite3.connect(other)) as connection, connection:
        connection.execute("CREATE TABLE notes (body TEXT)")
    with pytest.raises(BudgetUnavailable, match="not a walletcap budget"):
        Ledger(other)
    with pytest.raises(BudgetUnavailable, match="no budget file"):
        Ledger(tmp_path / "missing.sqlite")


def test_the_file_is_private_and_written_ahead(tmp_path: Path) -> None:
    path = tmp_path / "state" / "walletcap" / "budget.sqlite"
    _ledger(path)
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone() == ("wal",)


def test_the_clock_is_not_an_option(tmp_path: Path) -> None:
    # 0.2.x took a clock per Ledger; a process running a day ahead saw an empty budget.
    with pytest.raises(TypeError):
        Ledger(tmp_path / "budget.sqlite", clock=lambda: 2_000_000_000.0)  # type: ignore[call-arg]


def test_the_rule_binds_every_writer_the_sqlite3_shell_included(tmp_path: Path) -> None:
    path = tmp_path / "budget.sqlite"
    ledger = _ledger(path)
    _pay(ledger)
    _pay(ledger)
    _pay(ledger)
    ledger.create_budget("spare", unit="usdc", cap=150, window_ms=DAY)
    now = "CAST(round((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)"  # a constant
    with closing(sqlite3.connect(path, isolation_level=None)) as shell:
        refusals = {
            "the budget refuses this payment": "INSERT INTO wc_entry (payment, kind, at, wallet, "  # noqa: S608 - constants
            f"amount, rail) VALUES ('by-hand', 'held', {now}, 'agent', 1, 'shell')",
            "dated by the ledger's clock": "INSERT INTO wc_entry (payment, kind, at, wallet, "
            "amount, rail) VALUES ('backdated', 'held', 0, 'spare', 1, 'shell')",
            "append-only": "UPDATE wc_entry SET amount = 1",
            "written only from wc_entry": "UPDATE wc_current SET counts_from = 0",
            "frozen, not deleted": "DELETE FROM wc_budget",
        }
        for message, sql in refusals.items():
            with pytest.raises(sqlite3.IntegrityError, match=message):
                shell.execute(sql)
    assert ledger.status("agent")["spent"] == 150


def test_replaying_the_ledger_rebuilds_each_payments_state(tmp_path: Path, clock: Clock) -> None:
    path = tmp_path / "budget.sqlite"
    ledger = _ledger(path)
    _pay(ledger)
    open_hold = str(ledger.hold("agent", 20, rail="python")["payment"])
    ledger.note(open_hold, "unknown", evidence="rpc timeout")
    bounded = str(ledger.hold("agent", 30, rail="python")["payment"])
    ledger.bound(bounded, within_ms=300_000)
    voided = str(ledger.hold("agent", 10, rail="python")["payment"])
    ledger.void(voided)
    ledger.settle(voided)
    with closing(sqlite3.connect(path)) as connection:
        entries = connection.execute("SELECT * FROM wc_entry ORDER BY seq").fetchall()
        current = connection.execute(CURRENT).fetchall()
        budget = connection.execute("SELECT * FROM wc_budget").fetchone()
    # A fresh file with the same budget, the entries appended again in order through the
    # projection triggers, holds the same states.
    replay = tmp_path / "replay.sqlite"
    with closing(sqlite3.connect(replay)) as connection, connection:
        from walletcap._ledger import parse_spec

        spec = parse_spec((REPO / "spec" / "schema.sql").read_text(encoding="utf-8"))
        connection.executescript(spec.sections["tables"] + spec.sections["projection"])
        connection.execute("INSERT INTO wc_budget VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", budget)
        connection.executemany(
            "INSERT INTO wc_entry VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", entries
        )
        rebuilt = connection.execute(CURRENT).fetchall()
    assert rebuilt == current
