"""The wallet budget API: one budget per wallet that restarts, limit changes and rails all keep.

The Python half is driven directly; the JavaScript half runs in Node on the same
file, so one budget is shared across languages, and both compute the same
default file.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import warnings
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
    NotSent,
    default_budget_path,
    format_usd,
    open_budget,
    to_micros,
)

WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
CHECKSUMMED = "0xD797ead28C38575FDf4fC523866287372340Ca02"
DAY = 86_400
TX = "0x" + "ab" * 32
NODE = shutil.which("node")


class Clock:
    def __init__(self, at: float = 1_800_000_000.0) -> None:
        self.at = at

    def __call__(self) -> float:
        return self.at


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


def test_code_can_lower_a_limit_for_everyone_and_the_window_rolls(tmp_path: Path) -> None:
    clock = Clock()
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", clock=clock, create=True)
    open_budget(WALLET, path=path, per_day="$100", clock=clock)
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
    assert (status.spent, status.in_flight) == (50_000_000, 0)
    assert [payment.status for payment in budget.history()] == ["unknown"]


def test_async_payments_and_history_keep_what_happened(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", create=True)

    async def pay() -> str:
        async with budget.pay("$5", to="0x4165cb72De51A67aac32DC33197d779552205efD") as payment:
            payment.tx = TX
            return payment.id

    spend_id = asyncio.run(pay())
    [entry] = budget.history()
    assert (entry.id, entry.status, entry.amount, entry.tx, entry.rail) == (
        spend_id,
        "settled",
        5_000_000,
        TX,
        "python",
    )
    assert entry.to == "0x4165cb72De51A67aac32DC33197d779552205efD"


def test_a_reservation_with_a_settle_by_time_counts_one_window_past_it(tmp_path: Path) -> None:
    clock = Clock()
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", per_day="$150", clock=clock, create=True)
    settles_by = datetime.fromtimestamp(clock.at, tz=UTC) + timedelta(minutes=5)
    budget.reserve("$100", settles_by=settles_by)
    clock.at += 300 + DAY
    assert budget.status().in_flight == 100_000_000
    clock.at += 0.002
    assert budget.status().in_flight == 0
    assert budget.history()[0].status == "expired"


def test_freeze_check_and_mistakes(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, per_day="$150", max_payments=1, create=True)
    assert budget.check("$150").ok
    budget.freeze()
    check = budget.check("$1")
    assert (check.ok, check.reason) == (False, "revoked")
    budget.unfreeze()
    _pay(budget, "$1")
    assert budget.check("$1").reason == "uses"
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


@needs_node
def test_python_and_javascript_spend_from_one_budget(tmp_path: Path) -> None:
    assert NODE is not None
    path = tmp_path / "shared.sqlite"
    budget = open_budget(CHECKSUMMED, path=path, per_payment="$50", per_day="$150", create=True)
    _pay(budget, "$50")
    _pay(budget, "$50")
    script = (
        "const { openBudget } = await import(process.argv[1]);"
        "const budget = openBudget({ wallet: process.argv[2], path: process.argv[3] });"
        "const results = [];"
        "for (const amount of ['$50', '$50']) {"
        "  try { await budget.pay(amount, async () => 'ok'); results.push('paid'); }"
        "  catch (error) { results.push(error.reason); } }"
        "console.log(JSON.stringify({ results, spent: String(budget.status().spent) }));"
    )
    result = subprocess.run(  # noqa: S603 - fixed local Node script, owned test file in argv
        [NODE, "--input-type=module", "-e", script, str(JS / "index.mjs"), WALLET, str(path)],
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
        [NODE, "--input-type=module", "-e", script, str(JS / "money.mjs"), json.dumps(env)]
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
