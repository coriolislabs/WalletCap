"""What the November 2026 security review changed in the core, each with the case that got past
0.4.1. The npm suite runs the same cases (packages/js/test/hardening.test.mjs).
"""

from __future__ import annotations

import json
import re
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from walletcap import (
    BudgetRefused,
    BudgetUnavailable,
    NotSent,
    UsageError,
    open_budget,
    open_owner,
)
from walletcap.__main__ import main
from walletcap.money import normalize_wallet

REPO = Path(__file__).resolve().parents[3]
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
OTHER = "0x4165cb72de51a67aac32dc33197d779552205efd"
TX = "0x" + "ab" * 32
POSIX = sys.platform != "win32"


def _statuses(budget: object) -> list[str]:
    return [payment.status for payment in reversed(budget.history())]  # type: ignore[attr-defined]


def test_only_the_notsent_class_says_a_payment_never_left(tmp_path: Path) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", create=True, per_day="$10")

    class VendorError(Exception):
        """An SDK's error that copies the payee's JSON body onto itself."""

        not_sent = True

    # 0.4.1 read a plain ``not_sent`` attribute too, and voided for it.
    with pytest.raises(VendorError), budget.pay("$10"):
        raise VendorError("upstream said no")
    assert _statuses(budget) == ["unknown"]
    assert budget.status().remaining == 0, "it keeps counting"
    with pytest.raises(BudgetRefused), budget.pay("$1"):
        pass


def test_notsent_speaks_for_one_payment(tmp_path: Path) -> None:
    budget = open_budget(
        WALLET, path=tmp_path / "b.sqlite", create=True, per_day="$100", per_payment="$60"
    )
    # The outer block sends $60, then a helper's own $5 payment is not sent. 0.4.1 voided both,
    # and $160 went out against a $100 cap.
    sent = 0

    def helper() -> None:
        with budget.pay("$5"):
            raise NotSent("the helper never sent")

    def outer() -> None:
        nonlocal sent
        with budget.pay("$60"):
            sent += 60
            helper()

    with pytest.raises(NotSent):
        outer()
    assert sent == 60
    assert _statuses(budget) == ["unknown", "void"], "the $60 is noted unknown, the $5 void"
    assert budget.status().remaining == 40_000_000
    with pytest.raises(BudgetRefused), budget.pay("$60"):
        pass


def test_a_block_that_voids_its_hold_then_pays_is_settled_by_its_transaction(
    tmp_path: Path,
) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", create=True, per_day="$100")
    with budget.pay("$10") as hold:
        hold.void(evidence="first try never broadcast")
        hold.tx = TX  # the retry paid
    assert _statuses(budget) == ["settled"]
    with budget.pay("$10") as hold:
        hold.void()
    assert _statuses(budget) == ["settled", "void"], "with nothing to show, it stays void"


def test_a_transaction_hash_in_bytes_settles_and_bad_evidence_never_strands_a_payment(
    tmp_path: Path,
) -> None:
    budget = open_budget(WALLET, path=tmp_path / "b.sqlite", create=True, per_day="$100")

    class HexBytes(bytes):
        """What web3.py returns for a transaction hash."""

    # 0.4.1 refused evidence that wasn't a str after the payment was made: PaymentNotRecorded
    # on every payment, each left in flight for good.
    with budget.pay("$10") as hold:
        hold.tx = HexBytes(bytes.fromhex("ab" * 32))  # type: ignore[assignment]
    with budget.pay("$10") as hold:
        hold.tx = "0x" + "cd" * 2000
    with budget.pay("$10") as hold:
        hold.tx = 12345  # type: ignore[assignment]
    payments = budget.history()
    assert [payment.status for payment in payments] == ["settled"] * 3
    assert payments[2].tx == TX
    assert payments[1].tx is not None
    assert len(payments[1].tx) == 1024
    assert payments[0].tx is None
    assert budget.status().in_flight == 0


@pytest.mark.skipif(not POSIX, reason="an open file cannot be removed on Windows")
def test_a_deleted_budget_file_refuses_and_is_not_recreated(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, create=True, per_day="$10")
    with budget.pay("$4"):
        pass
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    ran = False
    with pytest.raises(BudgetUnavailable), budget.pay("$6"):
        ran = True
    assert not ran
    # 0.4.1's connect re-created the file, empty and readable by anyone, for the next open to
    # write a schema into.
    assert not path.exists()


@pytest.mark.skipif(not POSIX, reason="file modes and symbolic links are POSIX")
def test_a_budget_is_created_at_the_path_itself_in_private_folders(tmp_path: Path) -> None:
    link = tmp_path / "linked.sqlite"
    target = tmp_path / "elsewhere.sqlite"
    link.symlink_to(target)
    # 0.4.1 swallowed the failed exclusive create, and SQLite made the target, mode 0644.
    with pytest.raises(BudgetUnavailable, match="symbolic link"):
        open_budget(WALLET, path=link, create=True, per_day="$10")
    assert not target.exists()

    # Every folder walletcap makes is 0700, as the npm package's are, not only the last.
    path = tmp_path / "a" / "b" / "walletcap" / "budget.sqlite"
    open_budget(WALLET, path=path, create=True, per_day="$10")
    modes = [oct(folder.stat().st_mode & 0o777) for folder in list(path.parents)[:3]]
    assert modes == ["0o700"] * 3
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_one_address_is_one_budget_the_shared_wallet_name_vectors() -> None:
    vectors = json.loads((REPO / "spec" / "vectors" / "wallets.json").read_text(encoding="utf-8"))
    for group in vectors["same"]:
        for spelling in group["spellings"]:
            assert normalize_wallet(spelling) == group["name"], spelling
    for case in vectors["refused"]:
        with pytest.raises(UsageError):
            normalize_wallet(case["input"])


def test_another_wallets_id_is_refused_without_describing_its_payment(tmp_path: Path) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, create=True, per_day="$100")
    other = open_budget(OTHER, path=path, create=True, per_day="$100")
    budget.hold("$33.33", id="order-17")
    # 0.4.1 answered "…for $33.33 from 0xd797…ca02" to any wallet's payer that guessed the id.
    with pytest.raises(UsageError) as refused:
        other.hold("$1", id="order-17")
    message = str(refused.value)
    assert "already in the ledger, under another wallet's budget" in message
    assert "33.33" not in message
    assert "0xd797" not in message
    assert other.payment("order-17") is None
    with pytest.raises(UsageError, match=r"already in the ledger, for \$33\.33$"):
        budget.hold("$1", id="order-17")

    for payment_id in ("--all-unknown", "-h", "--json"):
        with pytest.raises(UsageError, match="can't start with '-'"):
            budget.hold("$1", id=payment_id)
    assert len(budget.holds()) == 1


def test_the_owner_sees_text_never_terminal_controls(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, create=True, per_day="$100")
    erase = "\r\x1b[2K\x1b[1A\x1b[2K"
    budget.hold("$45", id="real-45", settles_within=timedelta(minutes=10))
    budget.hold("$0.01", note=f"{erase}no open payments\x1b[8m", to=f"0xabc\u202e{erase}")
    done = budget.hold("$1", settles_within=timedelta(minutes=10))
    done.settle(
        tx=f"0xabc\n2026-11-10T00:00:00Z      $0.00  void       safe to void real-45{erase}"
    )
    for command, lines in (("holds", 2), ("history", 3)):
        assert main(["--path", str(path), command]) == 0
        out = capsys.readouterr().out
        assert not re.search("[\x00-\x1f\x7f-\x9f\u202e]", out.replace("\n", "")), command
        assert len(out.rstrip().split("\n")) == lines, f"{command} prints one line a payment"
        assert "real-45" in out
        assert "\ufffd" in out
    assert main(["--path", str(path), "holds", "--json"]) == 0
    held = json.loads(capsys.readouterr().out)
    assert any("\x1b[2K" in (hold["note"] or "") for hold in held), "--json keeps the text"


def test_fields_a_payer_wrote_as_something_else_and_far_times_do_not_break_the_owner(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, create=True, per_day="$100")
    # 0.4.1's command line died on a payTo that wasn't a string, and on a settle-by time past
    # the year 9999 (a "no deadline" sentinel), which left no way to void the hold by its id.
    budget.hold("$1", details={"payTo": 12345, "network": 7, "tx": ["x"], "error": {"a": 1}})
    budget.hold("$2", id="far-1", settles_by=datetime(9999, 12, 31, tzinfo=UTC))
    deep = json.loads("[" * 900 + "]" * 900)
    budget.hold("$3", details={"deep": deep} if len(json.dumps(deep)) < 4000 else {})
    for command in ("holds", "history"):
        assert main(["--path", str(path), command]) == 0, command
        assert "far-1" in capsys.readouterr().out
    assert [hold.to for hold in budget.holds()] == [None, None, None]
    far = budget.payment("far-1")
    assert far is not None
    assert far.counts_until == datetime.max.replace(tzinfo=UTC)
    assert main(["--path", str(path), "void", "far-1", "--evidence", "never sent"]) == 0
    assert "Voided far-1" in capsys.readouterr().out
    with pytest.raises(UsageError):
        open_budget(WALLET, path=path, max_payments=2**70)


def test_the_command_line_takes_whole_flags_and_none_as_a_limit(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "b.sqlite"
    open_owner(path, create=True).set_limits(WALLET, per_day="$100", per_payment="$5")
    # argparse took --all for --all-unknown and --old for --older-than; the npm command line
    # never did.
    with pytest.raises(SystemExit) as stopped:
        main(["--path", str(path), "void", "--all", "--old", "1ms"])
    assert stopped.value.code == 2
    capsys.readouterr()
    # "none" alone is a change: the npm command line takes it, and 0.4.1's Python one refused.
    assert main(["--path", str(path), "set", "--per-payment", "none"]) == 0
    assert open_owner(path).status(WALLET).per_payment is None


def test_half_a_surrogate_pair_in_a_note_prints_as_a_replacement_character(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "b.sqlite"
    budget = open_budget(WALLET, path=path, create=True, per_day="$100")
    # A JavaScript payer can store half a surrogate pair. UTF-8 can't write one, so history and
    # holds raised UnicodeEncodeError on it.
    budget.hold("$1", note="half \ud83d pair")
    for command in ("holds", "history"):
        assert main(["--path", str(path), command]) == 0
        out = capsys.readouterr().out
        assert "half \ufffd pair" in out
        out.encode("utf-8")
