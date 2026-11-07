"""spec/vectors/ledger.json: the admission sequences the JavaScript suite runs too."""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "src"))

from walletcap import _clock  # noqa: E402
from walletcap._ledger import Ledger, ProcessLimits  # noqa: E402
from walletcap.errors import BudgetRefused, UsageError  # noqa: E402

VECTORS: dict[str, Any] = json.loads(
    (REPO / "spec" / "vectors" / "ledger.json").read_text(encoding="utf-8")
)


def _nothing(_: object) -> None:
    return None


def _outcome(work: Callable[[], Any], expect: dict[str, Any], check: Callable[[Any], None]) -> None:
    refused: BudgetRefused | None = None
    usage: UsageError | None = None
    try:
        result = work()
    except BudgetRefused as error:
        refused = error
    except UsageError as error:
        usage = error
    if refused is not None:
        assert "refused" in expect, f"refused {refused.code}: {refused}"
        got = (refused.code, refused.source, refused.brief)
        assert got == (expect["refused"], expect["source"], expect["brief"])
    elif usage is not None:
        assert expect.get("error") == "usage", str(usage)
    else:
        assert "refused" not in expect, f"expected {expect}, got {result}"
        assert "error" not in expect, f"expected {expect}, got {result}"
        check(result)


@pytest.mark.parametrize("vector", VECTORS["cases"], ids=lambda vector: vector["name"])
def test_vector(vector: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": VECTORS["start"]}
    monkeypatch.setattr(_clock, "source", lambda: clock["now"] / 1000)
    ledger = Ledger(tmp_path / "vector.sqlite", create=True)
    wallet = VECTORS["wallet"]
    budget = vector["budget"]
    ledger.create_budget(
        wallet,
        cap=budget["cap"],
        window_ms=budget["window_ms"],
        per_payment=budget.get("per_payment"),
        max_payments=budget.get("max_payments"),
    )
    # Each payment's token, as the process that held it keeps it. A step "as": "other" acts as
    # another process (no token); "as": "owner" uses the owner's moves.
    holders: dict[str, str] = {}
    for step in vector["steps"]:
        expect = step.get("expect", {})
        op = step["op"]
        holder = None if step.get("as") == "other" else holders.get(step.get("id", ""))
        as_owner = step.get("as") == "owner"
        until = None if "until_from_now" not in step else clock["now"] + step["until_from_now"]

        def state(row: dict[str, Any], expect: dict[str, Any] = expect) -> None:
            assert row["state"] == expect["state"]

        if op == "advance":
            clock["now"] += step["ms"]
        elif op == "freeze":
            ledger.freeze(wallet)
        elif op == "unfreeze":
            ledger.unfreeze(wallet)
        elif op == "hold":
            limits = step.get("limits", {})

            def held(row: dict[str, Any], expect: dict[str, Any] = expect) -> None:
                if expect["held"] != "*":
                    assert row["payment"] == expect["held"]
                if row["holder"] is not None:
                    holders.setdefault(str(row["payment"]), str(row["holder"]))

            _outcome(
                partial(
                    ledger.hold,
                    wallet,
                    step["amount"],
                    rail=step.get("rail", "vector"),
                    payment=step.get("id"),
                    until=until,
                    within_ms=step.get("within_ms"),
                    limits=ProcessLimits(
                        per_payment=limits.get("per_payment"),
                        cap=limits.get("cap"),
                        window_ms=limits.get("window_ms"),
                        max_payments=limits.get("max_payments"),
                    ),
                ),
                expect,
                held,
            )
        elif op == "settle":
            settle = (
                partial(ledger.owner_settle, step["id"], evidence=step.get("evidence"))
                if as_owner
                else partial(
                    ledger.settle, step["id"], holder=holder, evidence=step.get("evidence")
                )
            )
            _outcome(settle, expect, state)
        elif op == "void":
            void = (
                partial(ledger.owner_void, step["id"], evidence=step.get("evidence"))
                if as_owner
                else partial(ledger.void, step["id"], holder=holder)
            )
            _outcome(void, expect, state)
        elif op == "note":
            _outcome(
                partial(
                    ledger.note,
                    step["id"],
                    step["outcome"],
                    holder=holder,
                    evidence=step.get("evidence"),
                ),
                expect,
                state,
            )
        elif op == "bound":
            _outcome(
                partial(
                    ledger.bound,
                    step["id"],
                    holder=holder,
                    until=until,
                    within_ms=step.get("within_ms"),
                ),
                expect,
                state,
            )
        elif op == "set_limits":
            changes = {key: step[key] for key in ("cap", "window_ms") if key in step}
            _outcome(partial(ledger.set_limits, wallet, **changes), expect, _nothing)
        elif op == "void_unknown":
            voided = ledger.void_unknown(wallet, step["older_than_ms"])
            assert [row["payment"] for row in voided] == expect["voided"]
        elif op == "holds":
            assert [row["payment"] for row in ledger.counting(wallet, held_only=True)] == expect[
                "ids"
            ]
        elif op == "status":
            status = ledger.status(wallet)
            got = {**status, "frozen": status["frozen_at"] is not None}
            for key, value in expect.items():
                assert got[key] == value, f"{op} {key}"
        else:
            raise AssertionError(f"unknown op {op}")
