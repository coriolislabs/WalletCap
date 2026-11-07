"""Opening a file walletcap 0.2 or 0.3 wrote: the upgrade to schema 3 keeps every payment counting.

spec/fixtures holds files 0.2.4 and 0.3.0 wrote, and what 0.3.0 counted in them at a series of
times. The JavaScript suite checks the same files (js/tests/upgrade.test.mjs).
"""

from __future__ import annotations

import json
import os
import random
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src"
JS = ROOT / "js"
FIXTURES = ROOT / "spec" / "fixtures"
sys.path.insert(0, str(SOURCE))

from walletcap import Ledger, _clock  # noqa: E402

NODE = shutil.which("node")


def _copy(tmp_path: Path, name: str) -> Path:
    path = tmp_path / name
    shutil.copyfile(FIXTURES / name, path)
    return path


def _schema(path: Path) -> str:
    with closing(sqlite3.connect(path)) as connection:
        row = connection.execute("SELECT value FROM budget_meta WHERE key = 'schema'").fetchone()
    return str(row[0])


@pytest.mark.parametrize("version", ["1", "2"])
def test_every_payment_counts_as_0_3_0_counted_it(
    version: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expect: dict[str, Any] = json.loads((FIXTURES / f"schema-{version}.expect.json").read_text())
    clock = {"ms": expect["T0"] - 3_600_000}
    monkeypatch.setattr(_clock, "source", lambda: clock["ms"] / 1000)
    path = _copy(tmp_path, f"schema-{version}.sqlite")
    ledger = Ledger(path)
    assert _schema(path) == "3"
    for probe in expect["probes"]:
        clock["ms"] = probe["at"]
        for wallet, counted in probe["budgets"].items():
            status = ledger.status(wallet)
            holds = [row["payment"] for row in ledger.counting(wallet, held_only=True)]
            got = {
                "cap": status["cap"],
                "window": status["window_ms"],
                "perPayment": status["per_payment"],
                "maxPayments": status["max_payments"],
                "spent": status["spent"],
                "inFlight": status["in_flight"],
                "remaining": status["remaining"],
                "payments": status["payments"],
                "frozen": status["frozen_at"] is not None,
                "holds": holds,
            }
            assert got == counted, f"{wallet} at T0{probe['at'] - expect['T0']:+}"
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema")}
    assert not tables & {"budgets", "spend", "legacy_spend", "legacy_budgets", "legacy_meta"}


def _big_schema_2(tmp_path: Path, rows: int) -> Path:
    """The schema-2 fixture with `rows` more payments, so the upgrade takes long enough to kill."""

    path = _copy(tmp_path, "schema-2.sqlite")
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) "
            "INSERT INTO spend SELECT 'bulk-' || i, '0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a', 1, "
            "CASE WHEN i % 3 = 0 THEN 'reserved' ELSE 'committed' END, 'js', "
            "CASE WHEN i % 5 = 0 THEN '{\"outcome\":\"unknown\"}' END, 1700000000000 + i, NULL FROM n",
            (rows,),
        )
    return path


@pytest.mark.skipif(not hasattr(signal, "SIGKILL"), reason="needs SIGKILL")
def test_a_crash_mid_upgrade_leaves_the_file_as_it_was(tmp_path: Path) -> None:
    source = _big_schema_2(tmp_path, 120_000)
    with closing(sqlite3.connect(source)) as connection:
        (payments,) = connection.execute("SELECT count(*) FROM spend").fetchone()
    script = (
        "import sys; sys.path.insert(0, sys.argv[1]); from walletcap import Ledger; "
        "Ledger(sys.argv[2]); print('done', flush=True)"
    )

    def upgrade(path: Path) -> subprocess.Popen[str]:
        return subprocess.Popen(  # noqa: S603 - this interpreter running a fixed script
            [sys.executable, "-c", script, str(SOURCE), str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    timed = tmp_path / "timed.sqlite"
    shutil.copyfile(source, timed)
    started = time.monotonic()
    assert upgrade(timed).wait(timeout=120) == 0
    took = time.monotonic() - started

    generator = random.Random(3)
    interrupted = 0
    for attempt in range(8):
        path = tmp_path / f"attempt-{attempt}.sqlite"
        shutil.copyfile(source, path)
        child = upgrade(path)
        time.sleep(generator.uniform(0.2, 0.9) * took)
        child.send_signal(signal.SIGKILL)
        child.wait(timeout=30)
        if Path(f"{path}-journal").exists():
            interrupted += 1
        # Whatever moment the kill came, the file is schema 2 as it was or schema 3 with every
        # payment: SQLite rolls a half-done upgrade back the next time the file is opened.
        if _schema(path) == "2":
            with closing(sqlite3.connect(path)) as connection:
                assert connection.execute("SELECT count(*) FROM spend").fetchone() == (payments,)
        ledger = Ledger(path)
        assert _schema(path) == "3"
        with closing(sqlite3.connect(path)) as connection:
            held = connection.execute("SELECT count(*) FROM wc_entry WHERE kind = 'held'").fetchone()
            assert held == (payments,)
            assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert ledger.status("0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a")["cap"] == 150_000_000
    assert interrupted > 0, "no kill landed inside the upgrade; the file upgrades too fast to test"


@pytest.mark.skipif(NODE is None, reason="requires_node")
def test_javascript_and_python_open_one_old_file_at_once(tmp_path: Path) -> None:
    assert NODE is not None
    path = _big_schema_2(tmp_path, 20_000)
    with closing(sqlite3.connect(path)) as connection:
        (payments,) = connection.execute("SELECT count(*) FROM spend").fetchone()
    go = tmp_path / "go"
    wallet = "0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a"
    python = (
        "import json, pathlib, sys, time; sys.path.insert(0, sys.argv[1]); "
        "from walletcap import Ledger\n"
        "while not pathlib.Path(sys.argv[3]).exists(): time.sleep(0.001)\n"
        "status = Ledger(sys.argv[2]).status(sys.argv[4])\n"
        "print(json.dumps({'payments': status['payments'], 'in_flight': status['in_flight']}))"
    )
    javascript = (
        "const { existsSync } = await import('node:fs');"
        "const { Ledger } = await import(process.argv[1]);"
        "while (!existsSync(process.argv[3])) await new Promise(done => setTimeout(done, 1));"
        "const status = await (await Ledger.open(process.argv[2])).status(process.argv[4]);"
        "console.log(JSON.stringify({ payments: Number(status.payments), in_flight: Number(status.in_flight) }));"
    )
    children = [
        subprocess.Popen(  # noqa: S603 - this interpreter running a fixed script
            [sys.executable, "-c", python, str(SOURCE), str(path), str(go), wallet],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ),
        subprocess.Popen(  # noqa: S603 - the local Node running a fixed script
            [NODE, "--input-type=module", "-e", javascript, str(JS / "dist" / "ledger.js"), str(path), str(go), wallet],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ),
    ]
    time.sleep(0.3)
    go.touch()
    answers = []
    for child in children:
        stdout, stderr = child.communicate(timeout=120)
        assert child.returncode == 0, stderr
        answers.append(json.loads(stdout))
    assert answers[0] == answers[1]
    assert _schema(path) == "3"
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT count(*) FROM wc_entry WHERE kind = 'held'").fetchone() == (
            payments,
        )
    if os.name == "posix":
        assert not Path(f"{path}-journal").exists()
