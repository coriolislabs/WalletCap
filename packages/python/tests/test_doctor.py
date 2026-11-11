"""``walletcap check`` and ``walletcap doctor``.

The npm suite runs the same cases (packages/js/test/doctor.test.mjs), and test_cli_json.py
compares the two command lines' JSON.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

from walletcap import open_budget, open_owner
from walletcap.__main__ import main
from walletcap._doctor import filesystem_of

REPO = Path(__file__).resolve().parents[3]
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
POSIX = sys.platform != "win32"


@pytest.fixture
def budget_file(tmp_path: Path) -> Path:
    path = tmp_path / "budget.sqlite"
    open_owner(path, create=True).set_limits(WALLET, per_day="$150", per_payment="$50")
    return path


def _cli(capsys: pytest.CaptureFixture[str], path: Path, *args: str) -> tuple[int, str, str]:
    code = main(["--path", str(path), *args])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _report(capsys: pytest.CaptureFixture[str], path: Path, *args: str) -> tuple[int, Any]:
    code, out, _ = _cli(capsys, path, "doctor", *args, "--json")
    return code, json.loads(out)


def _statuses(report: Any, name: str) -> list[str]:
    return [check["status"] for check in report["checks"] if check["id"] == name]


def _sql(path: Path, statement: str) -> list[Any]:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        return connection.execute(statement).fetchall()
    finally:
        connection.close()


def test_check_says_whether_a_payment_would_be_paid_now_and_holds_nothing(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = _cli(capsys, budget_file, "check", "12.50")
    assert code == 0
    assert out.startswith(
        "Yes: $12.50 from 0xd797…ca02 would be paid now. $150.00 is left in its window."
    )

    code, out, _ = _cli(capsys, budget_file, "check", "60")
    assert code == 1, "a payment the budget would refuse exits 1"
    assert out.startswith("No: $60.00 is over 0xd797…ca02's $50.00 limit per payment")

    code, out, _ = _cli(capsys, budget_file, "check", "60", "--json")
    assert code == 1
    assert json.loads(out) == {
        "ok": False,
        "remaining": "150000000",
        "code": "per_payment",
        "source": "budget",
        "message": "$60.00 is over 0xd797…ca02's $50.00 limit per payment",
        "brief": "$60.00 is over 0xd797…ca02's $50.00 limit per payment",
    }
    code, out, _ = _cli(capsys, budget_file, "check", "5", "--json")
    assert (code, json.loads(out)["ok"]) == (0, True)
    assert open_owner(budget_file).status(WALLET).payments == 0, "a check holds nothing"

    open_owner(budget_file).freeze(WALLET)
    code, out, _ = _cli(capsys, budget_file, "check", "5")
    assert code == 1
    assert out.startswith("No: ")
    assert "frozen" in out


def test_check_needs_an_amount_a_budget_file_and_a_budget(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, _, err = _cli(capsys, budget_file, "check")
    assert code == 2
    assert "check needs an amount in dollars" in err
    code, _, err = _cli(capsys, budget_file, "check", "lots")
    assert code == 1
    assert "must be dollars" in err
    missing = tmp_path / "no-such.sqlite"
    code, _, err = _cli(capsys, missing, "check", "5", "--wallet", WALLET)
    assert code == 1, "a missing file is not a new budget"
    assert "no budget file at" in err
    assert not missing.exists(), "check never creates the file"


def test_doctor_passes_a_budget_walletcap_set_created(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out, _ = _cli(capsys, budget_file, "doctor")
    assert code == 0, out
    assert out.rstrip().endswith("Everything checks out.")
    code, report = _report(capsys, budget_file)
    assert (code, report["ok"], report["path"]) == (0, True, str(budget_file))
    assert report["sqlite_version"] == sqlite3.sqlite_version
    ids = [check["id"] for check in report["checks"]]
    modes = ["file_mode", "folder_mode", "file_owner"] if POSIX else []
    rest = ["filesystem", "sqlite", "schema", "integrity", "journal", "rules"]
    rest += ["projection", "budgets"]
    assert ids == ["file", *modes, *rest]
    for check in report["checks"]:
        assert list(check) == ["id", "status", "message", "wallet"]
        skipped = check["id"] == "filesystem" and sys.platform != "linux"
        assert check["status"] == ("skipped" if skipped else "ok"), check


def test_doctor_fails_a_file_whose_guard_trigger_was_dropped(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _sql(budget_file, "DROP TRIGGER wc_entry_admitted")
    code, report = _report(capsys, budget_file)
    assert (code, report["ok"]) == (1, False)
    assert _statuses(report, "rules") == ["fail"]
    assert "wc_entry_admitted is missing or changed" in report["checks"][-1]["message"]
    assert "FAIL  rules" in _cli(capsys, budget_file, "doctor")[1]

    # A trigger put back with another body is caught too.
    edited = tmp_path / "edited.sqlite"
    open_owner(edited, create=True).set_limits(WALLET, per_day="$150")
    _sql(edited, "DROP TRIGGER wc_entry_never_deleted")
    _sql(
        edited,
        "CREATE TRIGGER wc_entry_never_deleted BEFORE DELETE ON wc_entry WHEN 0 "
        "BEGIN SELECT 1; END",
    )
    _, report = _report(capsys, edited)
    assert "wc_entry_never_deleted is missing or changed" in report["checks"][-1]["message"]


def test_doctor_reads_only(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    old = tmp_path / "schema-2.sqlite"
    shutil.copyfile(REPO / "spec" / "fixtures" / "schema-2.sqlite", old)
    before = old.read_bytes()
    code, report = _report(capsys, old)
    assert code == 0, "an older file is a warning: walletcap upgrades it when it opens it"
    assert _statuses(report, "schema") == ["warn"]
    assert "schema 2, which an older walletcap wrote" in report["checks"][-1]["message"]
    assert old.read_bytes() == before, "the file is byte for byte what it was"
    assert _sql(old, "SELECT value FROM budget_meta WHERE key = 'schema'") == [("2",)]

    missing = tmp_path / "missing" / "budget.sqlite"
    code, report = _report(capsys, missing)
    assert code == 1
    assert [(check["id"], check["status"]) for check in report["checks"]] == [("file", "fail")]
    assert not missing.exists()

    # Once upgraded, the file's rule is the one walletcap ships.
    assert _cli(capsys, old, "status")[0] == 0
    _, upgraded = _report(capsys, old)
    assert _statuses(upgraded, "rules") == ["ok"]
    assert _statuses(upgraded, "frozen"), "a frozen budget is a warning, by wallet"
    assert all(
        check["wallet"] is not None and "with no settle-by time" in check["message"]
        for check in upgraded["checks"]
        if check["id"] == "open_holds"
    )


@pytest.mark.skipif(not POSIX, reason="file modes are POSIX")
def test_doctor_warns_about_a_file_others_can_read_and_fails_one_they_can_write(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    budget_file.chmod(0o644)
    code, report = _report(capsys, budget_file)
    assert (code, _statuses(report, "file_mode"), report["ok"]) == (0, ["warn"], True)
    budget_file.chmod(0o666)
    code, report = _report(capsys, budget_file)
    assert (code, _statuses(report, "file_mode")) == (1, ["fail"])


def test_doctor_names_a_wallet_with_no_budget_an_open_hold_and_a_stranger(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    other = "0x4165cb72de51a67aac32dc33197d779552205efd"
    code, report = _report(capsys, budget_file, "--wallet", other)
    assert (code, _statuses(report, "budgets")) == (1, ["fail"])

    open_budget(WALLET, path=budget_file).hold("$5")  # no settle-by time
    _, report = _report(capsys, budget_file, "--wallet", WALLET)
    (held,) = [check for check in report["checks"] if check["id"] == "open_holds"]
    assert (held["status"], held["wallet"]) == ("warn", WALLET)
    assert (
        "has 1 held payment with no settle-by time: it counts until voided or settled"
        in held["message"]
    )

    stranger = tmp_path / "stranger.sqlite"
    _sql(stranger, "CREATE TABLE notes (body TEXT)")
    code, report = _report(capsys, stranger)
    assert code == 1
    assert "not a walletcap budget" in report["checks"][-1]["message"]


def test_the_filesystem_check_reads_mountinfo_as_the_shared_vectors_say() -> None:
    vectors = json.loads((REPO / "spec" / "vectors" / "mounts.json").read_text(encoding="utf-8"))
    mountinfo = "\n".join(vectors["mountinfo"])
    for case in vectors["cases"]:
        assert filesystem_of(mountinfo, case["path"]) == case["type"], case["path"]
    assert filesystem_of("", "/anywhere") is None


def test_doctor_fails_a_file_whose_payment_was_uncounted_behind_the_ledgers_back(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with open_budget(WALLET, path=budget_file).pay("$6"):
        pass
    assert open_owner(budget_file).status(WALLET).spent == 6_000_000
    # INSERT OR REPLACE deletes the row it replaces without firing the triggers that refuse a
    # DELETE, so a settled payment can be put back as void with no entry saying so.
    _sql(
        budget_file,
        "INSERT OR REPLACE INTO wc_current (payment, wallet, amount, state, held_seq, held_at, "
        "until, outcome, counts_from, seq) SELECT payment, wallet, amount, 'void', held_seq, "
        "held_at, until, outcome, NULL, held_seq FROM wc_current",
    )
    assert open_owner(budget_file).status(WALLET).spent == 0, "the payment no longer counts"
    code, report = _report(capsys, budget_file)
    assert (code, _statuses(report, "projection")) == (1, ["fail"])
    assert (
        "1 payment has a state the ledger's entries don't give it"
        in report["checks"][-1]["message"]
    )
