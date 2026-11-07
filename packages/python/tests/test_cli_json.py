"""Both command lines print the same --json, field for field (STABILITY.md, Command lines).

Each command runs once through the npm CLI and once through the Python one, each on its own copy
of one budget file, so a command that changes the file starts from the same state in both.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / "src"
JS_CLI = REPO / "packages" / "js" / "dist" / "cli" / "main.js"
sys.path.insert(0, str(SOURCE))

from walletcap import NotSent, _clock, open_budget, open_owner  # noqa: E402

NODE = shutil.which("node")
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
TX = "0x" + "ab" * 32
# Fields that depend on when the command ran: compared within a minute, not exactly.
MOMENTS = {"age_ms", "counts_until"}

pytestmark = pytest.mark.skipif(
    NODE is None or not JS_CLI.exists(), reason="requires node and packages/js/dist"
)


def _run(command: list[str], path: Path, *args: str) -> Any:
    done = subprocess.run(
        [*command, "--path", str(path), *args, "--json"],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PYTHONPATH": str(SOURCE)},
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def _same(npm: Any, python: Any, at: str = "") -> None:
    assert type(npm) is type(python), f"{at}: {npm!r} != {python!r}"
    if isinstance(npm, dict):
        assert sorted(npm) == sorted(python), f"{at}: keys {sorted(npm)} != {sorted(python)}"
        for key in npm:
            _same(npm[key], python[key], f"{at}.{key}")
    elif isinstance(npm, list):
        assert len(npm) == len(python), f"{at}: {len(npm)} rows != {len(python)}"
        for index, (left, right) in enumerate(zip(npm, python, strict=True)):
            _same(left, right, f"{at}[{index}]")
    elif at.rsplit(".", 1)[-1] in MOMENTS and npm is not None:
        if at.endswith("age_ms"):
            assert abs(int(npm) - int(python)) < 60_000, at
        else:
            delta = datetime.fromisoformat(npm) - datetime.fromisoformat(python)
            assert abs(delta) < timedelta(minutes=1), at
    else:
        assert npm == python, f"{at}: {npm!r} != {python!r}"


def _shape(value: Any, at: str = "") -> None:
    """snake_case keys; amounts, counts and times as strings; no number is a JSON number."""

    if isinstance(value, dict):
        for key, entry in value.items():
            assert key == key.lower(), f"{at}.{key} is not snake_case"
            _shape(entry, f"{at}.{key}")
    elif isinstance(value, list):
        for entry in value:
            _shape(entry, at)
    else:
        assert not isinstance(value, int | float) or isinstance(value, bool), f"{at} is {value!r}"


@pytest.fixture
def budget_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "budget.sqlite"
    owner = open_owner(path, create=True)
    owner.set_limits(WALLET, per_day="$150", per_payment="$50", max_payments=20)
    # Two hours ago: an x402 payment that failed, whose authorization has since expired.
    now = time.time()
    monkeypatch.setattr(_clock, "source", lambda: now - 7_200)
    budget = open_budget(WALLET, path=path)
    stale = budget.hold(
        "$4",
        rail="x402",
        to="0x4165cb72De51A67aac32DC33197d779552205efD",
        settles_by=datetime.fromtimestamp(now - 3_600, UTC),
    )
    stale.note("unknown", "receipt timeout")
    monkeypatch.undo()
    with budget.pay("$5", to="0x4165cb72De51A67aac32DC33197d779552205efD", note="api") as paid:
        paid.tx = TX
    with pytest.raises(TimeoutError), budget.pay("$2"):
        raise TimeoutError("rpc timeout")
    with pytest.raises(NotSent), budget.pay("$1"):
        raise NotSent("declined")
    budget.hold("$3", id="order-17", settles_within=timedelta(minutes=10))
    return path


@pytest.mark.parametrize(
    "args",
    [
        ("status",),
        ("status", "--wallet", WALLET),
        ("set", "--wallet", WALLET, "--per-day", "200", "--per-payment", "none"),
        ("freeze",),
        ("unfreeze",),
        ("history",),
        ("holds",),
        ("void", "order-17", "--evidence", "checked: never broadcast"),
        ("void", "--all-unknown", "--older-than", "1h"),
        ("settle", "order-17", "--tx", TX),
    ],
    ids=" ".join,
)
def test_both_command_lines_print_the_same_json(
    args: tuple[str, ...], budget_file: Path, tmp_path: Path
) -> None:
    assert NODE is not None
    npm_file, python_file = tmp_path / "npm.sqlite", tmp_path / "python.sqlite"
    shutil.copyfile(budget_file, npm_file)
    shutil.copyfile(budget_file, python_file)
    npm = _run([NODE, str(JS_CLI)], npm_file, *args)
    python = _run([sys.executable, "-m", "walletcap"], python_file, *args)
    # Each copy names its own file; everything else is the same.
    text = json.dumps(npm).replace(str(npm_file), str(python_file))
    _same(json.loads(text), python)
    _shape(python)
