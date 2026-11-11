# SPDX-License-Identifier: Apache-2.0
"""Each budget handle's decision log: its callback and its file. Internal.

A decision is what a handle did about a payment: held it, refused it, or moved a hold it took.
Each one is handed to the handle's ``on_decision`` callback and appended, as one JSON line, to
the file ``WALLETCAP_LOG`` named when the budget was opened. The log is outside the ledger and
comes after it: by the time anything here runs the ledger has answered, so a callback that
raises or a file that can't be written changes no payment. It is swallowed, with one warning.

The JavaScript package writes the same line for the same decision, byte for byte.
"""

from __future__ import annotations

import contextlib
import dataclasses
import errno
import inspect
import json
import os
import threading
import warnings
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from walletcap._ledger import _private_folder
from walletcap.errors import BudgetWarning
from walletcap.money import Micros, expand_home

if TYPE_CHECKING:
    from walletcap.budget import Decision

__all__ = ["DecisionLog", "decision_log_file", "wire"]

_APPEND = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0)
"""Opened for append, and on Windows as bytes: a line ends in a line feed everywhere."""


def decision_log_file() -> Path | None:
    """The file ``WALLETCAP_LOG`` names, ``~/`` expanded as for ``WALLETCAP_PATH``, or None."""

    configured = os.environ.get("WALLETCAP_LOG")
    return expand_home(configured).absolute() if configured else None


def wire(decision: Decision) -> str:
    """One decision as its log line, without the line feed: its JSON, in ASCII.

    Keys in the order of the fields, amounts as decimal strings of micro-dollars, times as ISO
    8601 UTC to the millisecond, None as null, and no spaces: what JSON.stringify gives the
    JavaScript package. JSON escapes the control characters, and every character past ``~`` is
    escaped too. So nothing a payee sent ends a line early for a reader that splits on more than
    line feeds (U+2028, NEL) or reaches a terminal as a control code, and both languages write
    the same bytes.
    """

    fields: dict[str, Any] = {}
    for field in dataclasses.fields(decision):
        value = getattr(decision, field.name)
        if isinstance(value, datetime):
            value = value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        elif isinstance(value, Micros):
            value = str(int(value))
        fields[field.name] = value
    return json.dumps(fields, ensure_ascii=True, separators=(",", ":"))


def _append(file: Path, line: bytes) -> None:
    """One line, appended in one write: the lines of several handles and processes stay whole.

    The file is its owner's alone, and so is a folder made for it.
    """

    try:
        descriptor = os.open(file, _APPEND, 0o600)
    except FileNotFoundError:
        _private_folder(file.parent)
        descriptor = os.open(file, _APPEND, 0o600)
    try:
        # One write takes a whole line; the loop is for a system that takes less.
        left = memoryview(line)
        while left:
            left = left[os.write(descriptor, left) :]
    finally:
        os.close(descriptor)


def _kind(error: BaseException) -> str:
    """A name a warning may repeat: an error's system code or its class, never its message.

    The message can carry what a payee sent.
    """

    code = errno.errorcode.get(error.errno or 0) if isinstance(error, OSError) else None
    return type(error).__name__ if code is None else code


class DecisionLog:
    """One budget handle's decision log: its callback, its file, and the warnings it has given."""

    def __init__(self, on_decision: Callable[[Decision], object] | None, file: Path | None) -> None:
        self._on_decision = on_decision
        self._file = file
        self._warned: set[str] = set()
        self._lock = threading.Lock()

    def record(self, decision: Decision) -> None:
        """Log one decision. An error here is swallowed: the ledger has answered already."""

        if self._file is not None:
            try:
                # A payee's text reaches the file only as JSON strings.
                _append(self._file, (wire(decision) + "\n").encode("ascii"))
            except Exception as error:  # noqa: BLE001 - the log never changes a decision
                self._warn(
                    "file",
                    f"walletcap: the decision log {self._file} can't be written ({_kind(error)}). "
                    "Payments are decided as the budget says, without a log line; this warning "
                    "is not repeated for this budget handle.",
                )
        if self._on_decision is None:
            return
        try:
            result = self._on_decision(decision)
        except Exception as error:  # noqa: BLE001 - the callback never changes a decision
            self._warn(
                "callback",
                f"walletcap: the on_decision callback failed ({_kind(error)}). Payments are "
                "decided as the budget says, and the callback is still called; this warning is "
                "not repeated for this budget handle.",
            )
            return
        if inspect.iscoroutine(result):
            # Nothing here waits for a coroutine, and one left alone warns that it never ran.
            result.close()
            self._warn(
                "callback",
                "walletcap: on_decision is a coroutine function, which is called but never "
                "awaited, so it does nothing: pass a plain function. This warning is not "
                "repeated for this budget handle.",
            )

    def _warn(self, about: str, message: str) -> None:
        """Once per handle for the callback and once for the file, never once per payment."""

        with self._lock:
            if about in self._warned:
                return
            self._warned.add(about)
        # A filter that turns warnings into errors changes no payment either.
        with contextlib.suppress(Exception):
            warnings.warn(message, BudgetWarning, stacklevel=2)
