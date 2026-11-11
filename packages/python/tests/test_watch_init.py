"""``walletcap watch`` and ``walletcap init``.

The npm suite runs the same cases (packages/js/test/watch-init.test.mjs), and test_cli_json.py
compares the two command lines' JSON.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from walletcap import BudgetRefused, _clock, open_budget, open_owner
from walletcap.__main__ import main

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / "src"
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
OTHER = "0x4165cb72de51a67aac32dc33197d779552205efd"
PAYEE = "0x4165cb72De51A67aac32DC33197d779552205efD"
TX = "0x" + "ab" * 32
POSIX = sys.platform != "win32"
RAILS = ["pay", "x402", "cdp", "agentkit", "awal", "mcp", "python"]
KEYS = [
    "seq",
    "at",
    "kind",
    "payment",
    "wallet",
    "amount",
    "until",
    "outcome",
    "rail",
    "to",
    "note",
    "evidence",
    "remaining",
]
MOMENT = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
TIME = re.compile(r"\d\d:\d\d:\d\dZ  ")


@pytest.fixture
def budget_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "budget.sqlite"
    open_owner(path, create=True).set_limits(WALLET, per_day="$150", per_payment="$50")
    # The default file, so init's snippet needs no word about where the budget is.
    monkeypatch.setenv("WALLETCAP_PATH", str(path))
    return path


def _cli(capsys: pytest.CaptureFixture[str], path: Path, *args: str) -> tuple[int, str, str]:
    code = main(["--path", str(path), *args])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _sql(path: Path, statement: str) -> list[Any]:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        return connection.execute(statement).fetchall()
    finally:
        connection.close()


def _summary(path: Path, wallet: str = WALLET) -> str:
    return open_owner(path).status(wallet).summary


def _moment(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _control(character: str) -> bool:
    code = ord(character)
    return code < 0x20 or 0x7F <= code <= 0x9F or 0x202A <= code <= 0x202E


def _start(path: Path, *args: str) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [sys.executable, "-m", "walletcap", "--path", str(path), "watch", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONPATH": str(SOURCE)},
    )


class _Watching:
    """``walletcap watch``, running: the lines it has printed so far, and how it ended."""

    def __init__(self, path: Path, *args: str) -> None:
        self.process = _start(path, *args)
        self._printed: list[str] = []
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self._printed.append(line.decode("utf-8").rstrip("\r\n"))

    def lines(self, count: int) -> list[str]:
        """Its first ``count`` lines, once it has printed them."""

        deadline = time.monotonic() + 20
        while len(self._printed) < count:
            ended = self.process.poll() is not None and not self._reader.is_alive()
            assert not ended, f"watch ended with {self._printed}"
            assert time.monotonic() < deadline, f"watch printed only {self._printed}"
            time.sleep(0.02)
        return self._printed[:count]

    def ended(self) -> tuple[int, list[str], str]:
        """Its exit code, every line it printed, and what it said on stderr."""

        code = self.process.wait(timeout=30)
        self._reader.join(timeout=5)
        assert self.process.stderr is not None
        return code, list(self._printed), self.process.stderr.read().decode("utf-8")

    def stop(self) -> tuple[int, list[str], str]:
        """An interrupt ends it at once; Windows has none to send, so there it runs out --for."""

        if POSIX:
            self.process.send_signal(signal.SIGINT)
        return self.ended()


def test_watch_json_prints_one_line_an_entry_as_the_ledger_takes_it_with_what_is_left(
    budget_file: Path,
) -> None:
    budget = open_budget(WALLET, path=budget_file)
    # --since reaches back for a payment made before the watch: its lines say the watcher is
    # reading.
    budget.hold("$1", id="before-1").settle(tx=TX)
    watcher = _Watching(budget_file, "--json", "--since", "1h", "--for", "10s")
    watcher.lines(2)

    paid = budget.hold(
        "$5", id="order-17", to=PAYEE, note="weather API", settles_within=timedelta(minutes=5)
    )
    paid.settle(tx=TX)
    watcher.lines(4)
    # A hold whose payee is under payTo, as x402 names it, and whose note is no string.
    lost = budget.hold("$7", id="lost-1", rail="x402", details={"payTo": PAYEE, "note": 7})
    lost.settles_within(timedelta(minutes=1))
    lost.note("unknown", "rpc timeout")
    watcher.lines(7)
    lost.void(evidence="never broadcast")
    # A refusal is no entry: the ledger took nothing, so watch prints nothing.
    with pytest.raises(BudgetRefused), budget.pay("$60"):
        pass
    watcher.lines(8)

    code, lines, err = watcher.stop()
    assert (code, err) == (0, "")
    assert len(lines) == 8, "a line an entry, and no line of its own"
    entries = [json.loads(line) for line in lines]
    for index, entry in enumerate(entries):
        assert list(entry) == KEYS
        compact = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        assert compact == lines[index], "one object, on one line"
        assert all(value is None or isinstance(value, str) for value in entry.values())
        assert entry["seq"] == str(index + 1)
        assert MOMENT.fullmatch(entry["at"])
        assert entry["wallet"] == WALLET
    fields = ("kind", "payment", "amount", "outcome", "rail", "to", "note", "evidence", "remaining")
    assert [tuple(entry[field] for field in fields) for entry in entries] == [
        ("held", "before-1", "1000000", None, "python", None, None, None, "149000000"),
        ("settled", "before-1", "1000000", None, "python", None, None, TX, "149000000"),
        ("held", "order-17", "5000000", None, "python", PAYEE, "weather API", None, "144000000"),
        ("settled", "order-17", "5000000", None, "python", PAYEE, "weather API", TX, "144000000"),
        ("held", "lost-1", "7000000", None, "x402", PAYEE, None, None, "137000000"),
        ("bound", "lost-1", "7000000", None, "x402", PAYEE, None, None, "137000000"),
        ("noted", "lost-1", "7000000", "unknown", "x402", PAYEE, None, "rpc timeout", "137000000"),
        ("void", "lost-1", "7000000", None, "x402", PAYEE, None, "never broadcast", "144000000"),
    ]
    # A hold's settle-by time, and the one a bound gives it; no other entry has one.
    assert [
        None if entry["until"] is None else _moment(entry["until"]) - _moment(entry["at"])
        for entry in entries
    ] == [None, None, timedelta(minutes=5), None, None, timedelta(minutes=1), None, None]
    assert MOMENT.fullmatch(entries[2]["until"])


def test_watch_prints_a_line_of_text_an_entry_from_the_end_of_the_ledger_with_controls_filtered(
    budget_file: Path,
) -> None:
    budget = open_budget(WALLET, path=budget_file)
    budget.hold("$1", id="before-1").settle(tx=TX)
    watcher = _Watching(budget_file, "--for", "10s")
    assert watcher.lines(3) == [f"Watching {budget_file}", _summary(budget_file), ""]

    paid = budget.hold(
        "$5", id="order-17", to=PAYEE, note="weather API", settles_within=timedelta(minutes=5)
    )
    paid.settle(tx=TX)
    watcher.lines(5)
    # What a payee or a payer wrote can carry what a terminal acts on: an escape sequence, a line
    # break, a bell, a bidi override.
    evil = budget.hold(
        "$7", id="evil-1", rail="x402", to="pay\u202eee", note="clear\x1b[2J\nscreen"
    )
    evil.note("refused", "said no\r\n\x07")
    watcher.lines(7)
    evil.void(evidence="never\x9bsent")
    watcher.lines(8)

    code, printed, err = watcher.stop()
    assert (code, err) == (0, "")
    lines = printed[3:]
    assert len(lines) == 5, "a line an entry, and none for the payment made before the watch"
    assert not any(_control(character) for character in "".join(lines))
    assert all(TIME.match(line) for line in lines), "the time of day, UTC"
    assert re.fullmatch(
        r"held {10}\$5\.00 {2}python {2}to 0x4165…5efd {2}weather API {2}"
        r"settles by \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ {2}order-17 {2}\(\$144\.00 left\)",
        lines[0][11:],
    )
    said = "to pay\ufffdee  clear\ufffd[2J\ufffdscreen"
    assert [line[11:] for line in lines[1:]] == [
        (
            f"settled       $5.00  python  to 0x4165…5efd  weather API  tx {TX}  order-17  "
            "($144.00 left)"
        ),
        f"held          $7.00  x402    {said}  evil-1  ($137.00 left)",
        (
            f"noted         $7.00  x402    {said}  refused: said no\ufffd\ufffd\ufffd  evil-1  "
            "($137.00 left)"
        ),
        f"void          $7.00  x402    {said}  never\ufffdsent  evil-1  ($144.00 left)",
    ]


def test_watch_since_first_prints_the_entries_of_that_long_ago_for_every_wallet_or_for_one(
    budget_file: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    open_owner(budget_file).set_limits(OTHER, per_day="$20")
    budget = open_budget(WALLET, path=budget_file)
    now = time.time()
    with monkeypatch.context() as clock:
        clock.setattr(_clock, "source", lambda: now - 7_200)  # this payment was two hours ago
        budget.hold("$4", id="old-1").settle(tx=TX)
    budget.hold("$5", id="new-1")
    open_budget(OTHER, path=budget_file).hold("$2", id="new-2", settles_within=timedelta(minutes=5))

    def entries(*args: str) -> list[str]:
        code, out, err = _cli(capsys, budget_file, "watch", "--json", "--for", "200ms", *args)
        assert code == 0, err
        rows = [json.loads(line) for line in out.split("\n")[:-1]]
        return [f"{row['kind']} {row['payment']} {row['remaining']}" for row in rows]

    assert entries() == [], "without --since, only what the ledger takes from now on"
    assert entries("--since", "1h") == ["held new-1 141000000", "held new-2 18000000"]
    assert entries("--since", "3h") == [
        "held old-1 141000000",
        "settled old-1 141000000",
        "held new-1 141000000",
        "held new-2 18000000",
    ]
    assert entries("--since", "3h", "--wallet", OTHER) == ["held new-2 18000000"]
    named = entries("--since", "3h", "--wallet", f"eip155:8453:{PAYEE}")
    assert named == ["held new-2 18000000"], "the wallet under any name normalize_wallet reads"

    # With two budgets watched, each has its line at the top and its name on its entries.
    every = _cli(capsys, budget_file, "watch", "--since", "1h", "--for", "200ms")[1].split("\n")
    summaries = [_summary(budget_file, OTHER), _summary(budget_file)]
    assert every[:4] == [f"Watching {budget_file}", *summaries, ""]
    assert every[1].startswith("0x4165…5efd: ")
    assert every[4][11:] == "held          $5.00  0xd797…ca02  python  new-1  ($141.00 left)"
    assert re.fullmatch(
        r"held {10}\$2\.00 {2}0x4165…5efd {2}python {2}settles by \S+ {2}new-2 {2}"
        r"\(\$18\.00 left\)",
        every[5][11:],
    )
    assert every[6:] == [""]
    one = _cli(capsys, budget_file, "watch", "--since", "1h", "--for", "200ms", "--wallet", WALLET)[
        1
    ].split("\n")
    assert [TIME.sub("", line, count=1) for line in one] == [
        f"Watching {budget_file}",
        summaries[1],
        "",
        "held          $5.00  python  new-1  ($141.00 left)",
        "",
    ]


def test_watch_prints_a_time_past_9999_and_half_a_surrogate_pair_as_the_npm_command_line_does(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The ledger keeps times a datetime can't hold, and a note cut through an emoji is no UTF-8.
    # The npm package writes both; here SQL does, as the ledger's own hold statement would.
    _sql(
        budget_file,
        "INSERT INTO wc_entry (payment, kind, at, wallet, amount, until, rail, info) "
        "SELECT 'odd-1', 'held', k.now, b.wallet, 1000000, 1000000000000000, 'js', "
        """'{"note":"cut \\ud83d here"}' FROM wc_clock k, wc_budget b""",
    )
    code, out, err = _cli(capsys, budget_file, "watch", "--since", "1h", "--for", "200ms", "--json")
    assert code == 0, err
    assert re.search(r'"until":"9999-12-31T23:59:59\.999Z",.*"note":"cut \\ud83d here"', out)
    assert json.loads(out)["note"] == "cut \ud83d here"
    code, out, err = _cli(capsys, budget_file, "watch", "--since", "1h", "--for", "200ms")
    assert code == 0, err
    assert out.split("\n")[3][11:] == (
        "held          $1.00  js      cut \ufffd here  settles by 9999-12-31T23:59:59Z  odd-1  "
        "($149.00 left)"
    )


def test_watch_exits_1_for_a_missing_file_an_older_file_a_stranger_and_a_wallet_with_no_budget(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = tmp_path / "nowhere" / "budget.sqlite"
    assert _cli(capsys, missing, "watch", "--for", "1s") == (
        1,
        "",
        (
            f"no budget file at {missing}: its owner creates one with "
            "walletcap set --wallet <address> --per-day <dollars>\n"
        ),
    )
    assert not missing.parent.exists(), "watch never creates the file, or its folder"

    # An older file needs an upgrade, which is a write: watch says how, and leaves the file as
    # it is.
    fixture = REPO / "spec" / "fixtures" / "schema-2.sqlite"
    old = tmp_path / "schema-2.sqlite"
    shutil.copyfile(fixture, old)
    before = old.read_bytes()
    for mode in ([], ["--json"]):
        code, out, err = _cli(capsys, old, "watch", "--since", "1h", "--for", "1s", *mode)
        assert (code, out) == (1, "")
        assert "is at schema 2, which an older walletcap wrote, and watch only reads. " in err
        assert "open the file once with this version to upgrade it (walletcap status --path" in err
    assert old.read_bytes() == before, "the file is byte for byte what it was"
    assert fixture.read_bytes() == before, "and so is the fixture it was copied from"
    assert _sql(old, "SELECT value FROM budget_meta WHERE key = 'schema'") == [("2",)]

    stranger = tmp_path / "stranger.sqlite"
    _sql(stranger, "CREATE TABLE notes (body TEXT)")
    code, _, err = _cli(capsys, stranger, "watch", "--for", "1s")
    assert code == 1
    assert "is a SQLite file, not a walletcap budget" in err
    empty = tmp_path / "empty.sqlite"
    empty.touch()
    assert _cli(capsys, empty, "watch", "--for", "1s") == (
        1,
        "",
        (
            f"{empty} is empty: walletcap set --wallet <address> --per-day <dollars> "
            "creates the budget\n"
        ),
    )
    assert empty.stat().st_size == 0
    bare = tmp_path / "bare.sqlite"
    open_owner(bare, create=True)
    assert _cli(capsys, bare, "watch", "--for", "1s") == (
        1,
        "",
        f"no budget in {bare} yet: walletcap set --wallet <address> --per-day <dollars>\n",
    )
    _sql(bare, "UPDATE budget_meta SET value = '4' WHERE key = 'schema'")
    assert _cli(capsys, bare, "watch", "--for", "1s") == (
        1,
        "",
        f"{bare} is at schema 4, which a newer walletcap wrote; this one reads 3\n",
    )

    code, out, err = _cli(capsys, budget_file, "watch", "--wallet", OTHER, "--for", "1s")
    assert (code, out) == (1, "")
    assert err.startswith("0x4165…5efd has no budget in ")
    assert f": its owner creates one with walletcap set --wallet {OTHER} " in err

    code, _, err = _cli(capsys, budget_file, "watch", "--since", "soon")
    assert code == 1
    assert err.startswith('--since must be a duration like "24h"')
    code, _, err = _cli(capsys, budget_file, "watch", "--for", "0s")
    assert code == 1
    assert err.startswith('--for must be a duration like "24h"')
    with pytest.raises(SystemExit) as stopped:
        main(["--path", str(budget_file), "watch", "--until", "3s"])
    assert stopped.value.code == 2, "an option watch does not have"
    capsys.readouterr()


def test_watch_writes_nothing_to_the_budget_file(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    budget = open_budget(WALLET, path=budget_file)
    with budget.pay("$6") as paid:
        paid.tx = TX
    budget.hold("$3")
    before = budget_file.read_bytes()
    versions = _sql(budget_file, "SELECT count(*) FROM wc_budget_log")
    replayed = _cli(capsys, budget_file, "watch", "--since", "1h", "--for", "200ms")[1]
    assert len(replayed.split("\n")) == 7
    assert _cli(capsys, budget_file, "watch", "--json", "--for", "700ms") == (0, "", "")
    assert budget_file.read_bytes() == before, "the file is byte for byte what it was"
    # SQLite keeps its own write-ahead log beside a file a reader has open: it holds nothing.
    log = Path(f"{budget_file}-wal")
    assert not log.exists() or log.stat().st_size == 0
    assert _sql(budget_file, "SELECT count(*) FROM wc_budget_log") == versions


@pytest.mark.skipif(not POSIX, reason="signals, and files replaced while open, are POSIX")
def test_watch_ends_with_exit_0_when_interrupted_or_unread_and_with_exit_1_when_the_file_goes(
    budget_file: Path, tmp_path: Path
) -> None:
    top = [f"Watching {budget_file}", _summary(budget_file), ""]
    for sent in (signal.SIGINT, signal.SIGTERM):
        watcher = _Watching(budget_file)
        watcher.lines(3)
        watcher.process.send_signal(sent)
        assert watcher.ended() == (0, top, ""), sent

    # walletcap watch | head: the pipe closes, and the next line has nowhere to go.
    budget = open_budget(WALLET, path=budget_file)
    budget.hold("$1", id="first-1")
    piped = _start(budget_file, "--json", "--since", "1h", "--for", "10s")
    assert piped.stdout is not None
    assert piped.stderr is not None
    assert json.loads(piped.stdout.readline())["payment"] == "first-1"
    piped.stdout.close()
    budget.hold("$1", id="second-1")
    assert (piped.wait(timeout=30), piped.stderr.read()) == (0, b"")

    # The path names another file, then none: the watcher's connection still has the first.
    replaced = _Watching(budget_file, "--for", "10s")
    replaced.lines(3)
    replacement = tmp_path / "replacement.sqlite"
    open_owner(replacement, create=True).set_limits(WALLET, per_day="$150")
    replacement.replace(budget_file)
    code, _, err = replaced.ended()
    assert (code, err) == (
        1,
        (
            f"the budget file {budget_file} was replaced while walletcap watched it: "
            "run walletcap watch again to watch the file now there\n"
        ),
    )
    removed = _Watching(budget_file, "--for", "10s")
    removed.lines(3)
    budget_file.unlink()
    code, _, err = removed.ended()
    assert (code, err) == (
        1,
        f"the budget file {budget_file} was removed while walletcap watched it\n",
    )


def test_init_on_a_fresh_machine_creates_the_file_and_the_budget_and_prints_the_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "fresh" / "state" / "walletcap" / "budget.sqlite"
    monkeypatch.setenv("WALLETCAP_PATH", str(path))
    created = _cli(
        capsys,
        path,
        "init",
        "--wallet",
        "0xd797ead28C38575FDf4fC523866287372340Ca02",
        "--per-day",
        "150",
        "--per-payment",
        "50",
    )
    text = "\n".join(
        [
            "0xd797…ca02: $0.00 spent of $150.00 per 24h, $150.00 left · at most $50.00 a payment",
            "Everything checks out.",
            "",
            "Next:",
            "// npm install walletcap",
            "import { openBudget } from 'walletcap';",
            "",
            f"const budget = await openBudget({{ wallet: '{WALLET}' }});",
            "",
            "await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));",
            "",
        ]
    )
    assert created == (0, text, "")
    if POSIX:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600, "as set creates it"

    # --json: what set --json prints, what doctor --json prints, and the snippet.
    again = json.loads(
        _cli(capsys, path, "init", "--wallet", WALLET, "--per-day", "150", "--json")[1]
    )
    assert list(again) == ["status", "doctor", "rail", "snippet"]
    assert again["status"] == json.loads(_cli(capsys, path, "set", "--per-day", "150", "--json")[1])
    assert again["doctor"] == json.loads(
        _cli(capsys, path, "doctor", "--wallet", WALLET, "--json")[1]
    )
    assert again["rail"] == "pay"
    assert again["snippet"] == text.split("Next:\n")[1].rstrip("\n")

    # A budget outside the default file: the snippet's code would look in the default one.
    monkeypatch.setenv("WALLETCAP_PATH", str(tmp_path / "default.sqlite"))
    code, out, _ = _cli(capsys, path, "init")
    assert code == 0
    assert out.endswith(
        f"\n\nThe budget is in {path}, not the default file: "
        "set WALLETCAP_PATH to it where the agent runs.\n"
    )


def test_init_prints_the_code_for_every_rail_and_refuses_one_it_does_not_know(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    opened = f"const budget = await openBudget({{ wallet: '{WALLET}' }});\n"
    code = {
        "pay": opened + "\nawait budget.pay('$12.50', () => sendUsdc(payee, '12.50'));",
        "x402": opened + "const client = guard(new x402Client().register('eip155:8453', "
        "new ExactEvmScheme(account)), budget);",
        "cdp": opened + "\napplySpendControls(client, {",
        "agentkit": opened + "const x402 = guardAgentKit(new X402ActionProvider(), budget);",
        "awal": f"which must be {WALLET}\n"
        "npx walletcap awal x402 pay https://api.example.com/data ",
        "mcp": '{ "mcpServers": { "payments": { "command": "npx", '
        f'"args": ["walletcap-mcp", "--wallet", "{WALLET}"] }} }} }}',
        "python": f'budget = open_budget("{WALLET}")\n\nwith budget.pay("$12.50") as payment:',
    }
    install = {
        "pay": "// npm install walletcap\n",
        "x402": "// npm install walletcap @x402/core @x402/evm @x402/fetch\n",
        "cdp": "// npm install walletcap @coinbase/cdp-sdk\n",
        "agentkit": "// npm install walletcap @coinbase/agentkit\n",
        "awal": "# npm install walletcap awal\n",
        "mcp": "# npx @coinbase/payments-mcp install --client other --no-auto-config\n",
        "python": "# pip install walletcap\n",
    }
    assert list(code) == RAILS
    for rail in RAILS:
        status, out, err = _cli(capsys, budget_file, "init", "--rail", rail)
        assert status == 0, err
        snippet = out.split("\n\nNext:\n")[1]
        assert snippet.startswith(install[rail]), "the install line comes first, as a comment"
        assert code[rail] in snippet, snippet
        assert "<wallet>" not in snippet
        answer = json.loads(_cli(capsys, budget_file, "init", "--rail", rail, "--json")[1])
        assert (answer["rail"], answer["snippet"] + "\n") == (rail, snippet)
    cdp = _cli(capsys, budget_file, "init", "--rail", "cdp")[1]
    assert "store: cdpStore(budget, { asset: USDC })," in cdp
    awal = _cli(capsys, budget_file, "init", "--rail", "awal")[1]
    assert "npx walletcap awal send 0.05 0xRecipient --chain base" in awal

    missing = tmp_path / "no-rail" / "budget.sqlite"
    unknown = _cli(
        capsys, missing, "init", "--wallet", WALLET, "--per-day", "150", "--rail", "stripe"
    )
    assert unknown == (
        2,
        "",
        f"unknown rail stripe: init prints the code for one of {', '.join(RAILS)}\n",
    )
    assert not missing.parent.exists(), "nothing was created"


def test_init_leaves_a_budget_as_it_was_when_no_limit_is_named_and_changes_one_as_set_does(
    budget_file: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    budget = open_budget(WALLET, path=budget_file)
    with budget.pay("$40") as paid:
        paid.tx = TX
    status = open_owner(budget_file).status(WALLET)
    versions = _sql(budget_file, "SELECT count(*) FROM wc_budget_log")
    # The file holds one budget, so its wallet needn't be named.
    code, out, err = _cli(capsys, budget_file, "init")
    assert code == 0, err
    assert out.startswith(
        "0xd797…ca02: $40.00 spent of $150.00 per 24h, $110.00 left · at most $50.00 a payment\n"
        "Everything checks out.\n\nNext:\n"
    )
    assert open_owner(budget_file).status(WALLET) == status
    assert _sql(budget_file, "SELECT count(*) FROM wc_budget_log") == versions, (
        "the budget was not written again"
    )

    # What doctor warns about is printed as doctor prints it, and is no failure.
    budget.hold("$5")  # no settle-by time
    code, out, _ = _cli(capsys, budget_file, "init")
    assert code == 0
    assert re.search(
        r"in flight · at most \$50\.00 a payment\n {2}warn {2}open_holds {2}0xd797…ca02 has 1 held "
        r"payment with no settle-by time: .*\n1 warning\.\n\nNext:\n",
        out,
    )

    # A limit changes the budget as set does: what was spent keeps counting.
    code, out, err = _cli(capsys, budget_file, "init", "--per-day", "200", "--per-payment", "none")
    assert code == 0, err
    assert out.startswith(
        "0xd797…ca02: $40.00 spent of $200.00 per 24h, $155.00 left · $5.00 in flight\n"
    )

    # A wallet with no budget needs a rolling limit, and a file with two budgets a wallet.
    third = "0x1111111111111111111111111111111111111111"
    assert _cli(capsys, budget_file, "init", "--wallet", third) == (
        2,
        "",
        (
            "0x1111…1111 has no budget yet: init needs a rolling limit to create it, "
            "like --per-day 150\n"
        ),
    )
    code, _, err = _cli(capsys, budget_file, "init", "--wallet", third, "--per-payment", "5")
    assert code == 1, "as set refuses it"
    assert "has no budget yet: give it a rolling limit too" in err
    limits = ("--cap", "20", "--window", "7d", "--max-payments", "3")
    assert _cli(capsys, budget_file, "init", "--wallet", third, *limits)[0] == 0
    assert _cli(capsys, budget_file, "init") == (2, "", "init needs --wallet <address>\n")

    missing = tmp_path / "no-limit" / "budget.sqlite"
    assert _cli(capsys, missing, "init", "--wallet", WALLET)[0] == 2
    assert _cli(capsys, missing, "init")[0] == 2
    assert not missing.parent.exists(), "init with no limit creates nothing"


def test_init_exits_1_on_a_file_whose_guard_trigger_was_dropped_and_still_prints_everything(
    budget_file: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _sql(budget_file, "DROP TRIGGER wc_entry_admitted")
    code, out, _ = _cli(capsys, budget_file, "init", "--rail", "python")
    assert code == 1
    assert re.match(
        r"0xd797…ca02: \$0\.00 spent of \$150\.00 per 24h, \$150\.00 left · at most \$50\.00 a "
        r"payment\n {2}FAIL {2}rules {2}the file's rule differs from the one walletcap ships: "
        r"wc_entry_admitted is missing or changed\. .*\n1 problem\.\n\nNext:\n"
        r"# pip install walletcap\n",
        out,
    )
    assert f'budget = open_budget("{WALLET}")' in out
    code, out, _ = _cli(capsys, budget_file, "init", "--json")
    report = json.loads(out)
    assert (code, report["doctor"]["ok"], report["status"]["cap"]) == (1, False, "150000000")
    assert WALLET in report["snippet"]
