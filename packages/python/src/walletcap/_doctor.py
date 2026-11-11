# SPDX-License-Identifier: Apache-2.0
"""``walletcap doctor``: check a budget file before relying on it.

It opens the file read-only and changes nothing: no upgrade, no journal switch, no write. The npm
package's cli/doctor.ts runs the same checks, in the same order, with the same words.
"""

from __future__ import annotations

import os
import re
import sqlite3
import stat
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from walletcap._ledger import MIN_SQLITE_VERSION, SCHEMA_VERSION, _spec, _version
from walletcap.money import normalize_wallet, short_wallet

# Filesystems another host serves, or a hypervisor shares: SQLite's locks aren't reliable there.
_REMOTE_FILESYSTEMS = frozenset(
    {
        "nfs",
        "nfs4",
        "cifs",
        "smb3",
        "smbfs",
        "9p",
        "virtiofs",
        "ceph",
        "glusterfs",
        "lustre",
        "afs",
        "ncpfs",
        "beegfs",
        "davfs",
        "vboxsf",
        "vmhgfs",
        "prl_fs",
    }
)
_OPEN_HOLD = 9223372036854775807
# How many payments' current rows disagree with their entries: another latest entry, another
# state, a count that doesn't follow from the state, or a row with no hold behind it.
_PROJECTION_SQL = """
SELECT (SELECT count(*) FROM wc_current c
         WHERE c.seq IS NOT (SELECT max(e.seq) FROM wc_entry e WHERE e.payment = c.payment)
            OR c.state IS NOT (SELECT CASE e.kind WHEN 'held' THEN 'held' ELSE e.kind END
                                 FROM wc_entry e
                                WHERE e.payment = c.payment
                                  AND e.kind IN ('held', 'settled', 'void')
                                ORDER BY e.seq DESC LIMIT 1)
            OR (c.counts_from IS NULL) IS NOT (c.state = 'void'))
     + abs((SELECT count(*) FROM wc_entry WHERE kind = 'held') - (SELECT count(*) FROM wc_current))
"""
_ESCAPE = re.compile(r"\\([0-7]{3})")
_MOUNT_POINT = 4  # the field of a mountinfo line that holds the mount point
_LABEL = {"ok": "ok", "warn": "warn", "fail": "FAIL", "skipped": "skip"}


def _octal(mode: int) -> str:
    return format(mode & 0o777, "04o")


def _plural(count: int) -> str:
    return "" if count == 1 else "s"


def _squeeze(sql: str | None) -> str:
    return " ".join((sql or "").split())


def filesystem_of(mountinfo: str, path: str) -> str | None:
    """The type of the filesystem ``path`` is on, from the text of /proc/self/mountinfo.

    The mount whose mount point is the longest prefix of the path wins, the last one listed if
    two share it. None if no line covers it.
    """

    best: tuple[str, str] | None = None
    for line in mountinfo.split("\n"):
        before, separator, after = line.partition(" - ")
        fields = before.split(" ")
        if not separator or len(fields) <= _MOUNT_POINT:
            continue
        # Space, tab, newline and backslash are octal escapes in a mount point.
        point = _ESCAPE.sub(lambda match: chr(int(match.group(1), 8)), fields[_MOUNT_POINT])
        kind = after.split(" ")[0]
        if not point or not kind:
            continue
        covers = point in ("/", path) or path.startswith(point + "/")
        if covers and (best is None or len(point) >= len(best[0])):
            best = (point, kind)
    return None if best is None else best[1]


def _objects(connection: sqlite3.Connection) -> dict[str, str]:
    rows = connection.execute(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
    )
    return {f"{kind} {name}": _squeeze(sql) for kind, name, sql in rows}


def _rule_differences(connection: sqlite3.Connection) -> list[str]:
    """The rule's tables, indexes, views and triggers that the file lacks or holds changed."""

    reference = sqlite3.connect(":memory:")
    try:
        schema = _spec("schema.sql")
        for name in ("tables", "projection", "guards"):
            reference.executescript(schema.sections[name])
        found = _objects(connection)
        return sorted(
            key.split(" ")[1] for key, sql in _objects(reference).items() if found.get(key) != sql
        )
    finally:
        reference.close()


def doctor(path: Path, *, wallet: str | None = None) -> dict[str, Any]:
    """Check the budget file at ``path``, and ``wallet``'s budget in it, or every budget's."""

    checks: list[dict[str, Any]] = []
    version: str | None = None

    def add(name: str, status: str, message: str, about: str | None = None) -> None:
        checks.append({"id": name, "status": status, "message": message, "wallet": about})

    def report() -> dict[str, Any]:
        return {
            "path": path,
            "ok": all(check["status"] != "fail" for check in checks),
            "sqlite_version": version,
            "checks": checks,
        }

    only = None if wallet is None else normalize_wallet(wallet)

    if not path.exists():
        add(
            "file",
            "fail",
            f"no budget file at {path}: its owner creates one with "
            "walletcap set --wallet <address> --per-day <dollars>",
        )
        return report()
    add("file", "ok", "the budget file exists")

    if sys.platform != "win32":
        file = path.stat()
        folder = path.parent.stat()
        if file.st_mode & 0o022:
            add(
                "file_mode",
                "fail",
                f"the file is mode {_octal(file.st_mode)}: other users on this host can write "
                "it, and so change the budget; chmod 600 it",
            )
        elif file.st_mode & 0o077:
            add(
                "file_mode",
                "warn",
                f"the file is mode {_octal(file.st_mode)}: other users on this host can read "
                "it, each hold's token included; chmod 600 it",
            )
        else:
            add("file_mode", "ok", "only its owner can read or write the file")
        # A sticky folder (/tmp) lets only a file's owner replace it.
        if folder.st_mode & 0o022 and not folder.st_mode & stat.S_ISVTX:
            add(
                "folder_mode",
                "warn",
                f"the folder is mode {_octal(folder.st_mode)}: another user who can write it "
                "can replace the budget file; chmod 700 it",
            )
        else:
            add("folder_mode", "ok", "only its owner can replace the file in its folder")
        me = os.getuid()
        if file.st_uid != me:
            add(
                "file_owner",
                "warn",
                f"the file belongs to uid {file.st_uid}, and this process runs as uid {me}",
            )
        else:
            add("file_owner", "ok", "the file belongs to this user")

    kind: str | None = None
    if sys.platform == "linux":
        try:
            mountinfo = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
            kind = filesystem_of(mountinfo, os.path.realpath(path))
        except OSError:
            kind = None
    if kind is None:
        add(
            "filesystem",
            "skipped",
            "not checked on this platform: keep the file on a local disk, not NFS, SMB or a "
            "Docker Desktop bind mount",
        )
    elif kind in _REMOTE_FILESYSTEMS:
        add(
            "filesystem",
            "fail",
            f"the file is on {kind}, where SQLite's locks aren't reliable: two processes can "
            "both take the last dollar. Keep it on this host's local disk",
        )
    elif kind == "fuse" or kind.startswith("fuse."):
        add(
            "filesystem",
            "warn",
            f"the file is on {kind}: if another host or a hypervisor serves it, SQLite's locks "
            "aren't reliable there",
        )
    else:
        add("filesystem", "ok", f"the file is on a local filesystem ({kind})")

    try:
        connection = sqlite3.connect(
            f"file:{quote(str(path))}?mode=ro", uri=True, timeout=2, isolation_level=None
        )
    except sqlite3.Error as error:
        add("sqlite", "fail", f"SQLite can't open the file: {error}")
        return report()
    try:
        connection.execute("PRAGMA query_only = ON")
        version = sqlite3.sqlite_version
        if _version(version) >= _version(MIN_SQLITE_VERSION):
            add("sqlite", "ok", f"this runtime's SQLite is {MIN_SQLITE_VERSION} or later")
        else:
            add(
                "sqlite",
                "fail",
                f"this runtime's SQLite is {version}; walletcap needs {MIN_SQLITE_VERSION} "
                "or later",
            )

        try:
            tables = [
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_schema WHERE type = 'table'")
            ]
        except sqlite3.Error as error:
            add(
                "schema",
                "fail",
                f"the file is not a SQLite database walletcap can read: {error}",
            )
            return report()
        if not tables:
            add(
                "schema",
                "warn",
                "the file is empty: walletcap set --wallet <address> --per-day <dollars> "
                "creates the budget",
            )
            return report()
        schema: str | None = None
        if "budget_meta" in tables:
            row = connection.execute(
                "SELECT value FROM budget_meta WHERE key = 'schema'"
            ).fetchone()
            schema = None if row is None else str(row[0])
        if schema is None:
            add("schema", "fail", "the file is a SQLite file, not a walletcap budget")
            return report()
        if schema in ("1", "2"):
            add(
                "schema",
                "warn",
                f"the file is at schema {schema}, which an older walletcap wrote: this version "
                "upgrades it the first time it opens it, so stop every older walletcap process "
                "first",
            )
            return report()
        if schema != SCHEMA_VERSION:
            add(
                "schema",
                "fail",
                f"the file is at schema {schema}, which a newer walletcap wrote; this one reads "
                f"{SCHEMA_VERSION}",
            )
            return report()
        add("schema", "ok", f"the file is at schema {SCHEMA_VERSION}")

        damage = [str(row[0]) for row in connection.execute("PRAGMA quick_check")]
        if damage == ["ok"]:
            add("integrity", "ok", "SQLite finds the file intact")
        else:
            first = damage[0] if damage else "no answer"
            add("integrity", "fail", f"SQLite reports damage in the file: {first}")

        journal = str(connection.execute("PRAGMA journal_mode").fetchone()[0])
        if journal == "wal":
            add("journal", "ok", "write-ahead logging is on")
        else:
            add(
                "journal",
                "warn",
                f"the journal mode is {journal}, not wal: walletcap switches it the next time "
                "it opens the file while no other process holds it",
            )

        changed = _rule_differences(connection)
        if not changed:
            add(
                "rules",
                "ok",
                "every table, index, view and trigger of the rule is in place, as walletcap "
                "ships it",
            )
        else:
            verb = "is" if len(changed) == 1 else "are"
            add(
                "rules",
                "fail",
                f"the file's rule differs from the one walletcap ships: {', '.join(changed)} "
                f"{verb} missing or changed. Its triggers enforce the budget for every writer, "
                "so payments from this file are not held to it; restore the file from a backup",
            )
            return report()

        # Each payment's latest state is kept beside the ledger's entries, by trigger. A row put
        # there any other way (INSERT OR REPLACE passes the guards) un-counts a payment with no
        # entry.
        odd = int(connection.execute(_PROJECTION_SQL).fetchone()[0])
        if odd == 0:
            add("projection", "ok", "every payment's state matches the ledger's entries")
        else:
            has, them = ("has", "it") if odd == 1 else ("have", "them")
            add(
                "projection",
                "fail",
                f"{odd} payment{_plural(odd)} {has} a state the ledger's entries don't give "
                f"{them}: the file was written outside walletcap's statements, so its count "
                "can't be trusted; restore the file from a backup",
            )
            return report()

        budgets = [
            (str(name), frozen_at)
            for name, frozen_at in connection.execute(
                "SELECT wallet, frozen_at FROM wc_budget ORDER BY wallet"
            )
            if only is None or name == only
        ]
        if not budgets:
            if only is None:
                add(
                    "budgets",
                    "warn",
                    "the file holds no budget yet: "
                    "walletcap set --wallet <address> --per-day <dollars>",
                )
            else:
                add(
                    "budgets",
                    "fail",
                    f"{short_wallet(only)} has no budget in the file: "
                    f"walletcap set --wallet {only} --per-day <dollars>",
                    only,
                )
            return report()
        add(
            "budgets",
            "ok",
            f"the file holds {len(budgets)} budget{_plural(len(budgets))}"
            if only is None
            else f"{short_wallet(only)} has a budget in the file",
            only,
        )
        for name, frozen_at in budgets:
            short = short_wallet(name)
            if frozen_at is not None:
                add(
                    "frozen",
                    "warn",
                    f"{short} is frozen: every payment is refused until walletcap unfreeze",
                    name,
                )
            held = int(
                connection.execute(
                    "SELECT count(*) FROM wc_current "
                    "WHERE wallet = ? AND state = 'held' AND counts_from = ?",
                    (name, _OPEN_HOLD),
                ).fetchone()[0]
            )
            if held > 0:
                counts = "it counts" if held == 1 else "they count"
                add(
                    "open_holds",
                    "warn",
                    f"{short} has {held} held payment{_plural(held)} with no settle-by time: "
                    f"{counts} until voided or settled (walletcap holds)",
                    name,
                )
        return report()
    except sqlite3.Error as error:
        add("sqlite", "fail", f"SQLite can't read the file: {error}")
        return report()
    finally:
        connection.close()


def doctor_text(report: dict[str, Any]) -> str:
    """The report as the command prints it."""

    checks = report["checks"]
    width = max(len(check["id"]) for check in checks)
    failed = sum(1 for check in checks if check["status"] == "fail")
    warned = sum(1 for check in checks if check["status"] == "warn")
    if failed == 0 and warned == 0:
        verdict = "Everything checks out."
    else:
        parts = []
        if failed:
            parts.append(f"{failed} problem{_plural(failed)}")
        if warned:
            parts.append(f"{warned} warning{_plural(warned)}")
        verdict = ", ".join(parts) + "."
    lines = [
        f"  {_LABEL[check['status']].ljust(4)}  {check['id'].ljust(width)}  {check['message']}"
        for check in checks
    ]
    return "\n".join([f"Budget file {report['path']}", "", *lines, "", verdict])
