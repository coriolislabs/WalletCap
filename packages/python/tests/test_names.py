"""spec/vectors/names.json: the public names both packages share.

The list is in JavaScript's spelling; Python's is the same name in snake_case. The JavaScript
suite checks the same list (packages/js/test/names.test.mjs).
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import re
import sys
import typing
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "src"))

import walletcap  # noqa: E402

NAMES: dict[str, Any] = json.loads(
    (REPO / "spec" / "vectors" / "names.json").read_text(encoding="utf-8")
)


def _python(name: str) -> str:
    """openBudget is open_budget and windowMs is window_ms; Budget and MAX_AMOUNT stay."""

    if name[:1].isupper():
        return name
    return re.sub(r"([A-Z])", r"_\1", name).lower()


def test_the_package_exports_every_shared_name() -> None:
    for name in NAMES["exports"]:
        assert _python(name) in walletcap.__all__, name


def test_the_handles_have_the_shared_methods_each_with_an_async_form_on_the_payer() -> None:
    for name, methods in NAMES["methods"].items():
        cls = getattr(walletcap, name)
        for method in methods:
            assert callable(getattr(cls, _python(method), None)), f"{name}.{method}"
            # The payer's calls have async forms; the owner's and close() don't.
            if name in ("Budget", "Hold") and method not in ("close", "pay"):
                assert callable(getattr(cls, "a" + _python(method), None)), f"{name}.a{method}"
    for name, properties in NAMES["properties"].items():
        cls = getattr(walletcap, name)
        for prop in properties:
            found = inspect.getattr_static(cls, _python(prop))
            assert isinstance(found, property), f"{name}.{prop}"


def test_the_returned_objects_have_the_shared_fields_and_no_others() -> None:
    for name, fields in NAMES["fields"].items():
        declared = [field.name for field in dataclasses.fields(getattr(walletcap, name))]
        assert sorted(declared) == sorted(_python(field) for field in fields), name


def test_the_errors_carry_the_shared_fields() -> None:
    refused = walletcap.BudgetRefused("budget", "over")
    for field in NAMES["errors"]["BudgetRefused"]:
        assert hasattr(refused, _python(field)), field
    lost = walletcap.PaymentNotRecorded("wc-1", RuntimeError("locked"))
    for field in NAMES["errors"]["PaymentNotRecorded"]:
        assert hasattr(lost, _python(field)), field


def test_every_shared_option_is_a_keyword_the_call_takes() -> None:
    calls: dict[str, Callable[..., Any]] = {
        "openBudget": walletcap.open_budget,
        "openOwner": walletcap.open_owner,
        "hold": walletcap.Budget.hold,
        "setLimits": walletcap.Owner.set_limits,
        "void": walletcap.Owner.void,
        "settle": walletcap.Owner.settle,
        "voidUnknown": walletcap.Owner.void_unknown,
    }
    for name, options in NAMES["options"].items():
        parameters = inspect.signature(calls[name]).parameters
        for option in options:
            assert _python(option) in parameters, f"{name}({option})"
        # No catch-all: a misspelt option is a TypeError, not a silent no-op.
        assert all(p.kind is not inspect.Parameter.VAR_KEYWORD for p in parameters.values()), name
    hold = inspect.signature(walletcap.Hold.void).parameters
    assert "evidence" in hold


def test_the_literal_types_match_the_shared_values() -> None:
    for name, values in NAMES["values"].items():
        assert list(typing.get_args(getattr(walletcap, name))) == values, name
