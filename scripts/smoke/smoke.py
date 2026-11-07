# SPDX-License-Identifier: Apache-2.0
"""Run in a fresh virtual environment where a built walletcap wheel is installed."""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import walletcap
from walletcap import BudgetRefused, open_budget, open_owner

wallet = "0xd797ead28c38575fdf4fc523866287372340ca02"
folder = Path(tempfile.mkdtemp(prefix="walletcap-smoke-"))
try:
    path = folder / "budget.sqlite"
    budget = open_budget(wallet, path=path, per_payment="$0.75", per_day="$1", create=True)
    with budget.pay("$0.60") as payment:
        payment.tx = "0x" + "ab" * 32
    try:
        with budget.pay("$0.50"):
            pass
    except BudgetRefused as refused:
        assert refused.code == "budget", refused.code
    else:
        raise AssertionError("the second payment was not refused")
    assert open_owner(path=path).status(wallet).spent == 600_000
    walletcap_cli = shutil.which("walletcap", path=str(Path(sys.executable).parent))
    assert walletcap_cli is not None, "the walletcap command is not installed"
    version = subprocess.run(  # noqa: S603 - the command this wheel installed
        [walletcap_cli, "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert version == walletcap.__version__, version
    print(f"walletcap {version} from its wheel: pays, refuses, and the CLI runs")  # noqa: T201
finally:
    shutil.rmtree(folder, ignore_errors=True)
