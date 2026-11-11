# SPDX-License-Identifier: Apache-2.0
"""``walletcap watch``: every entry the ledger takes, as it happens, while an agent runs.

It opens the file read-only and changes nothing: no upgrade, no journal switch, no write. The npm
package's cli/watch.ts reads the same rows and prints the same lines.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import sqlite3
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import quote

from walletcap._ledger import MIN_SQLITE_VERSION, SCHEMA_VERSION, _spec, _version
from walletcap.budget import path_flag, status_of
from walletcap.errors import BudgetUnavailable
from walletcap.money import format_usd, normalize_wallet, short_wallet, to_window_ms

# How often the ledger is asked for new entries, and the most it hands over at once.
_INTERVAL = 0.5
_BATCH = 500
# An entry and its payment's hold, which carries the rail, the payee and the note.
_ENTRIES_SQL = """
SELECT e.seq, e.at, e.kind, e.payment, e.wallet, e.amount, e.until, e.outcome, e.evidence,
       h.rail, h.info
FROM wc_entry e LEFT JOIN wc_entry h ON h.payment = e.payment AND h.kind = 'held'
WHERE e.seq > :after AND (:wallet IS NULL OR e.wallet = :wallet)
ORDER BY e.seq
LIMIT :batch
"""
# Where watch starts: after the ledger's last entry, or after the last one older than --since by
# the ledger's own clock.
_END_SQL = "SELECT coalesce(max(seq), 0) FROM wc_entry"
_SINCE_SQL = """
SELECT coalesce((SELECT seq FROM wc_entry WHERE at < (SELECT now FROM wc_clock) - :since_ms
                  ORDER BY seq DESC LIMIT 1), 0)
"""
# The ledger keeps times up to 10^15 ms, about the year 33,658. A datetime stops at the end of
# 9999, so both command lines print a later time as that moment.
_LAST_MOMENT = datetime.max.replace(tzinfo=UTC)
# Half a surrogate pair, which a payee's JSON can carry and UTF-8 can't.
_SURROGATES = re.compile("[\ud800-\udfff]")


@dataclass(frozen=True)
class Entry:
    """One entry of the ledger as watch prints it. ``--json`` prints these keys, in this order."""

    seq: int
    at: datetime
    kind: str
    payment: str
    wallet: str
    amount: int
    until: datetime | None
    outcome: str | None
    rail: str | None
    to: str | None
    note: str | None
    evidence: str | None
    remaining: int | None


def _moment(ms: int) -> datetime:
    ms = max(ms, 0)
    try:
        whole = datetime.fromtimestamp(ms // 1000, tz=UTC)
    except (OverflowError, ValueError, OSError):
        return _LAST_MOMENT
    return whole.replace(microsecond=ms % 1000 * 1000)


def _iso(moment: datetime) -> str:
    # As JavaScript's toISOString(): UTC, to the millisecond.
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _refuse(constant: str) -> None:
    raise ValueError(f"{constant} is not JSON")


def _info(text: str | None) -> dict[str, Any]:
    """The JSON a payer kept with its hold, as JavaScript's JSON.parse reads it."""

    try:
        info = json.loads(text, parse_constant=_refuse) if text else {}
    except (ValueError, RecursionError):
        return {}
    return info if isinstance(info, dict) else {}


def _text_of(value: object) -> str | None:
    """A payee wrote some of a hold's JSON: a field is read only if it is a string."""

    return value if isinstance(value, str) else None


def _entry(row: sqlite3.Row, remaining: int | None) -> Entry:
    info = _info(row["info"])
    to = _text_of(info.get("to"))
    return Entry(
        seq=row["seq"],
        at=_moment(row["at"]),
        kind=row["kind"],
        payment=row["payment"],
        wallet=row["wallet"],
        amount=row["amount"],
        until=None if row["until"] is None else _moment(row["until"]),
        outcome=row["outcome"],
        rail=row["rail"],
        to=_text_of(info.get("payTo")) if to is None else to,
        note=_text_of(info.get("note")),
        evidence=row["evidence"],
        remaining=remaining,
    )


def watch_json(entry: Entry) -> str:
    """One entry as a line of JSON, as the npm command line writes it."""

    wire = {
        "seq": str(entry.seq),
        "at": _iso(entry.at),
        "kind": entry.kind,
        "payment": entry.payment,
        "wallet": entry.wallet,
        "amount": str(entry.amount),
        "until": None if entry.until is None else _iso(entry.until),
        "outcome": entry.outcome,
        "rail": entry.rail,
        "to": entry.to,
        "note": entry.note,
        "evidence": entry.evidence,
        "remaining": None if entry.remaining is None else str(entry.remaining),
    }
    text = json.dumps(wire, ensure_ascii=False, separators=(",", ":"))
    return _SURROGATES.sub(lambda half: f"\\u{ord(half.group()):04x}", text)


def watch_line(entry: Entry, *, many: bool, plain: Callable[[str], str]) -> str:
    """One entry as a line of text.

    When, what, how much, on which rail, to whom, what the entry says, the payment's id, and what
    the budget has left. ``many`` adds the wallet, for a file with more than one budget.
    Everything the file holds as text goes through ``plain``.
    """

    evidence = plain(entry.evidence) if entry.evidence else ""
    if entry.kind == "noted":
        says = ": ".join(part for part in (plain(entry.outcome or ""), evidence) if part)
    elif entry.kind == "settled" and evidence:
        says = f"tx {evidence}"
    else:
        says = evidence
    fields = [
        entry.at.strftime("%H:%M:%SZ"),
        entry.kind.ljust(7),
        format_usd(entry.amount).rjust(10),
        plain(short_wallet(entry.wallet)) if many else "",
        plain(entry.rail).ljust(6) if entry.rail else "",
        f"to {plain(short_wallet(entry.to.lower()))}" if entry.to else "",
        plain(entry.note or ""),
        "" if entry.until is None else f"settles by {entry.until.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        says,
        plain(entry.payment),
        "" if entry.remaining is None else f"({format_usd(entry.remaining)} left)",
    ]
    return _SURROGATES.sub("\ufffd", "  ".join(field for field in fields if field))


def _identity(path: Path) -> tuple[int, int] | None:
    """Which file a path names right now, or None if it names none."""

    try:
        found = path.stat()
    except OSError:
        return None
    return found.st_dev, found.st_ino


def _unusable(path: Path, error: Exception) -> BudgetUnavailable:
    return BudgetUnavailable(f"the budget file {path} cannot be used: {error}")


def _busy(error: sqlite3.Error) -> bool:
    code = getattr(error, "sqlite_errorcode", 0) & 0xFF
    return code == sqlite3.SQLITE_BUSY or "locked" in str(error)


def _check(connection: sqlite3.Connection, path: Path) -> None:
    """Refuse a file that isn't a budget at this version's schema, and say what to do."""

    version = sqlite3.sqlite_version
    if _version(version) < _version(MIN_SQLITE_VERSION):
        raise BudgetUnavailable(
            f"walletcap needs SQLite {MIN_SQLITE_VERSION} or later; this Python has {version}"
        )
    tables = [
        row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
    ]
    if not tables:
        raise BudgetUnavailable(
            f"{path} is empty: walletcap set --wallet <address> --per-day <dollars> "
            "creates the budget"
        )
    schema: str | None = None
    if "budget_meta" in tables:
        row = connection.execute("SELECT value FROM budget_meta WHERE key = 'schema'").fetchone()
        schema = None if row is None else str(row[0])
    if schema is None:
        raise BudgetUnavailable(f"{path} is a SQLite file, not a walletcap budget")
    if schema in ("1", "2"):
        # Upgrading is a write, and one that every older process must be stopped for.
        raise BudgetUnavailable(
            f"{path} is at schema {schema}, which an older walletcap wrote, and watch only "
            "reads. Stop every older walletcap process, open the file once with this version "
            f"to upgrade it (walletcap status{path_flag(path)}), then watch it"
        )
    if schema != SCHEMA_VERSION:
        raise BudgetUnavailable(
            f"{path} is at schema {schema}, which a newer walletcap wrote; "
            f"this one reads {SCHEMA_VERSION}"
        )


def _open(path: Path) -> sqlite3.Connection:
    """The budget file, open for reading only, once it is a budget at this version's schema."""

    if not path.exists():
        raise BudgetUnavailable(
            f"no budget file at {path}: its owner creates one with "
            "walletcap set --wallet <address> --per-day <dollars>"
        )
    try:
        connection = sqlite3.connect(
            f"file:{quote(str(path))}?mode=ro", uri=True, timeout=2, isolation_level=None
        )
    except sqlite3.Error as error:
        raise _unusable(path, error) from error
    try:
        connection.row_factory = sqlite3.Row
        # Text SQLite can't decode is replaced, as Node replaces it, not raised on.
        connection.text_factory = lambda text: text.decode("utf-8", "replace")
        connection.execute("PRAGMA query_only = ON")
        _check(connection, path)
    except sqlite3.Error as error:
        connection.close()
        raise _unusable(path, error) from error
    except BaseException:
        connection.close()
        raise
    return connection


@contextlib.contextmanager
def _reading(connection: sqlite3.Connection) -> Iterator[None]:
    """One read transaction: the entries and what each budget has left are of one moment."""

    try:
        connection.execute("BEGIN")
        yield
        connection.execute("COMMIT")
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise


def _interrupted(*_: object) -> None:
    raise KeyboardInterrupt


def watch(
    path: Path,
    *,
    wallet: str | None = None,
    since: str | None = None,
    lasting: str | None = None,
    as_json: bool = False,
    plain: Callable[[str], str],
    out: TextIO | None = None,
) -> None:
    """Print every entry the budget file at ``path`` takes, oldest first.

    Until the process is interrupted, or ``lasting`` (--for) has passed. Reads only.
    """

    out = sys.stdout if out is None else out
    only = None if wallet is None else normalize_wallet(wallet)
    since_ms = None if since is None else to_window_ms(since, "--since")
    lasting_ms = None if lasting is None else to_window_ms(lasting, "--for")
    # An interrupt, or a reader that went away (walletcap watch | head), ends the watch: exit 0.
    # Python turns Ctrl-C into KeyboardInterrupt itself; a signal handler is the main thread's
    # to set, so a caller on another thread keeps its own.
    previous = None
    with contextlib.suppress(ValueError):
        previous = signal.signal(signal.SIGTERM, _interrupted)
    try:
        _watch(path, only, since_ms, lasting_ms, as_json=as_json, plain=plain, out=out)
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        # Python flushes stdout once more as it exits: hand it somewhere that takes the bytes.
        with contextlib.suppress(OSError, ValueError, AttributeError):
            os.dup2(os.open(os.devnull, os.O_WRONLY), out.fileno())
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)


def _watch(
    path: Path,
    only: str | None,
    since_ms: int | None,
    lasting_ms: int | None,
    *,
    as_json: bool,
    plain: Callable[[str], str],
    out: TextIO,
) -> None:
    statements = _spec("schema.sql").statements
    connection = _open(path)
    try:
        identity = _identity(path)

        def remaining_of(name: str) -> int | None:
            row = connection.execute(statements["status"], {"wallet": name}).fetchone()
            return None if row is None else int(row["remaining"])

        # Where to start, and what each watched budget holds as the watch starts.
        try:
            with _reading(connection):
                watched = (
                    [row["wallet"] for row in connection.execute(statements["budgets"])]
                    if only is None
                    else [only]
                )
                rows = [
                    connection.execute(statements["status"], {"wallet": name}).fetchone()
                    for name in watched
                ]
                if only is not None and rows[0] is None:
                    raise BudgetUnavailable(
                        f"{short_wallet(only)} has no budget in {path}: its owner creates one "
                        f"with walletcap set --wallet {only} --per-day <dollars>"
                    )
                if not rows:
                    raise BudgetUnavailable(
                        f"no budget in {path} yet: "
                        "walletcap set --wallet <address> --per-day <dollars>"
                    )
                start = (
                    connection.execute(_END_SQL)
                    if since_ms is None
                    else connection.execute(_SINCE_SQL, {"since_ms": since_ms})
                )
                last = int(start.fetchone()[0])
                summaries = [status_of(dict(row), path).summary for row in rows if row is not None]
        except sqlite3.Error as error:
            raise _unusable(path, error) from error

        def emit(lines: list[str]) -> None:
            out.write("\n".join(lines) + "\n")
            out.flush()

        if not as_json:
            emit([f"Watching {path}", *summaries, ""])

        def read() -> list[str]:
            """The entries the ledger took since the last read, as the lines to print."""

            nonlocal last
            # This connection keeps the file it opened, even once that file is deleted or another
            # is moved into its place: it would go on watching a ledger no payment is counted in.
            now = _identity(path)
            if identity is not None and now != identity:
                if now is None:
                    raise BudgetUnavailable(
                        f"the budget file {path} was removed while walletcap watched it"
                    )
                raise BudgetUnavailable(
                    f"the budget file {path} was replaced while walletcap watched it: "
                    "run walletcap watch again to watch the file now there"
                )
            with _reading(connection):
                rows = connection.execute(
                    _ENTRIES_SQL, {"after": last, "wallet": only, "batch": _BATCH}
                ).fetchall()
                many = (
                    only is None and len(connection.execute(statements["budgets"]).fetchall()) > 1
                )
                left: dict[str, int | None] = {}
                lines = []
                for row in rows:
                    if row["wallet"] not in left:
                        left[row["wallet"]] = remaining_of(row["wallet"])
                    entry = _entry(row, left[row["wallet"]])
                    lines.append(
                        watch_json(entry) if as_json else watch_line(entry, many=many, plain=plain)
                    )
            if rows:
                last = int(rows[-1]["seq"])
            return lines

        deadline = None if lasting_ms is None else time.monotonic() + lasting_ms / 1000
        while True:
            while True:
                try:
                    lines = read()
                except sqlite3.Error as error:
                    # Another process holds the file's lock: its entries are read the next time
                    # round.
                    if _busy(error):
                        break
                    raise _unusable(path, error) from error
                if lines:
                    emit(lines)
                if len(lines) < _BATCH:
                    break
            left_s = _INTERVAL if deadline is None else deadline - time.monotonic()
            if left_s <= 0:
                break
            time.sleep(min(_INTERVAL, left_s))
    finally:
        connection.close()
