# SPDX-License-Identifier: Apache-2.0
"""``walletcap`` (or ``python -m walletcap``): see, set and freeze a budget, and reconcile payments.

The same commands, options and output as ``npx walletcap``, on the same file, through the
owner's handle.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from walletcap import __version__
from walletcap.budget import UNSET, PaymentRecord, Status
from walletcap.errors import BudgetUnavailable, UsageError, is_walletcap_error
from walletcap.money import (
    Micros,
    default_budget_path,
    describe_limits,
    expand_home,
    format_age,
    format_usd,
    format_window,
    normalize_wallet,
    short_wallet,
    stored_wallet_name,
    strip_ascii,
    to_window_ms,
)
from walletcap.owner import Owner

_EPILOG = "Amounts are dollars: --per-day 150. Leave out the $ sign, which your shell would expand."
_COMMAND_NAMES = ["status", "set", "freeze", "unfreeze", "history", "holds", "void", "settle"]


class _ArgumentError(Exception):
    """A command line that can't run as given: exit 2, as argparse does."""


_INT64_DIGITS = 19  # the most digits a 64-bit integer has


def _whole(text: str) -> int:
    """A whole number in ASCII digits, as the JavaScript CLI reads one."""

    digits = strip_ascii(text)
    if not digits.isascii() or not digits.isdigit() or len(digits.lstrip("0")) > _INT64_DIGITS:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number that fits in 64 bits")
    return int(digits)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="walletcap",
        description="One spend budget per wallet, for every agent that pays from it.",
        epilog=_EPILOG,
    )
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("command", nargs="?", default="status", choices=_COMMAND_NAMES)
    parser.add_argument("id", nargs="?", help="the payment to void or settle")
    parser.add_argument("--wallet", help="the wallet the money leaves from")
    parser.add_argument("--path", help=f"the budget file (default: {default_budget_path()})")
    parser.add_argument("--per-payment", help="most one payment may spend, or none")
    parser.add_argument("--per-hour")
    parser.add_argument("--per-day")
    parser.add_argument("--per-week")
    parser.add_argument("--cap")
    parser.add_argument("--window", help="24h, 7d, 30m")
    parser.add_argument("--max-payments", help="most payments in one window, or none")
    parser.add_argument("--limit", type=_whole, default=20, help="how many payments history shows")
    parser.add_argument(
        "--all-unknown",
        action="store_true",
        help="with void: every payment of unknown or refused outcome older than --older-than "
        "that its payee can no longer settle; an x402 payment with no settle-by time, once an "
        "hour and a minute old; any other with none, a transfer say, only by id",
    )
    parser.add_argument("--older-than", help="with void --all-unknown: 24h, 7d, 30m")
    parser.add_argument("--tx", help="with settle: the transaction that shows it paid")
    parser.add_argument("--evidence", help="with void or settle: what shows it")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    return parser


def _json(value: Any) -> str:
    def plain(item: Any) -> Any:
        if dataclasses.is_dataclass(item) and not isinstance(item, type):
            fields = {
                field.name: plain(getattr(item, field.name)) for field in dataclasses.fields(item)
            }
            if isinstance(item, Status):
                fields["summary"] = item.summary
            return fields
        if isinstance(item, list):
            return [plain(entry) for entry in item]
        if isinstance(item, dict):
            return {key: plain(entry) for key, entry in item.items()}
        if isinstance(item, Micros) or (isinstance(item, int) and not isinstance(item, bool)):
            return str(int(item))
        if isinstance(item, Path):
            return str(item)
        if hasattr(item, "isoformat"):
            return item.isoformat()
        return item

    return json.dumps(plain(value), indent=2, ensure_ascii=False)


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _owner(path: Path, *, create: bool = False) -> Owner:
    return Owner(path, create=create)


def _wallets(path: Path) -> list[str]:
    if not path.exists():
        return []
    # A budget the 0.3.0 upgrade couldn't merge stays under its 0.2.x name: one wallet, listed once.
    names = [stored_wallet_name(budget.wallet) for budget in _owner(path).budgets()]
    return list(dict.fromkeys(names))


def _wallet(args: argparse.Namespace, path: Path) -> str:
    if args.wallet is not None:
        return normalize_wallet(args.wallet)
    known = _wallets(path)
    if len(known) == 1:
        return known[0]
    if not known:
        raise BudgetUnavailable(
            f"no budget in {path} yet: walletcap set --wallet <address> --per-day <dollars>"
        )
    raise _ArgumentError(
        f"the file holds {len(known)} budgets; pick one with --wallet:\n  " + "\n  ".join(known)
    )


def _detail(status: Status) -> str:
    window = format_window(status.window_ms)
    plural = "" if status.payments == 1 else "s"
    lines = [
        f"Wallet       {status.wallet}",
        f"Limit        {format_usd(status.cap)} per {window}, rolling",
        "Per payment  "
        + ("no limit" if status.per_payment is None else format_usd(status.per_payment)),
    ]
    if status.max_payments is not None:
        lines.append(f"Payments     at most {status.max_payments} per {window}")
    lines += [
        (
            f"Spent        {format_usd(status.spent)} in the last {window} "
            f"({status.payments} payment{plural})"
        ),
        f"In flight    {format_usd(status.in_flight)}",
        f"Left         {format_usd(status.remaining)}",
        "State        " + ("FROZEN: every payment is refused" if status.frozen else "active"),
    ]
    return "\n".join(lines)


def _status(args: argparse.Namespace, path: Path) -> str:
    if args.wallet is None:
        known = _wallets(path)
        statuses = [_owner(path).status(wallet) for wallet in known]
        if args.json:
            return _json({"path": path, "budgets": statuses})
        if not statuses:
            return (
                f"No budget in {path} yet. Create one:\n"
                "  walletcap set --wallet <address> --per-day 150 --per-payment 50"
            )
        return "\n".join([f"Budget file {path}", "", *(status.summary for status in statuses)])
    status = _owner(path).status(_wallet(args, path))
    return _json(status) if args.json else _detail(status)


def _set(args: argparse.Namespace, path: Path) -> str:
    def none(value: str | None) -> object:
        if value is None:
            return UNSET
        return None if strip_ascii(value).lower() == "none" else value

    max_payments = none(args.max_payments)
    if isinstance(max_payments, str):
        count = strip_ascii(max_payments)
        if not count.isascii() or not count.isdigit() or len(count.lstrip("0")) > _INT64_DIGITS:
            raise UsageError("--max-payments must be a whole number of payments, or none")
        max_payments = int(count)
    limits: dict[str, Any] = {
        "per_payment": none(args.per_payment),
        "per_hour": args.per_hour,
        "per_day": args.per_day,
        "per_week": args.per_week,
        "cap": args.cap,
        "window": args.window,
        "max_payments": max_payments,
    }
    if all(value is None or value is UNSET for value in limits.values()):
        raise _ArgumentError("set needs a limit, like --per-day 150 or --per-payment 50")
    if args.wallet is None and len(_wallets(path)) != 1:
        raise _ArgumentError("set needs --wallet <address>")
    wallet = _wallet(args, path)
    status = _owner(path, create=True).set_limits(wallet, **limits)
    if args.json:
        return _json(status)
    now = describe_limits(
        cap=status.cap,
        window_ms=status.window_ms,
        per_payment=status.per_payment,
        max_uses=status.max_payments,
    )
    return (
        f"{short_wallet(wallet)}: {now}.\nWhat was spent still counts: "
        f"{format_usd(status.spent)} spent, {format_usd(status.in_flight)} in flight, "
        f"{format_usd(status.remaining)} left."
    )


def _freeze(args: argparse.Namespace, path: Path) -> str:
    wallet = _wallet(args, path)
    owner = _owner(path)
    owner.freeze(wallet)
    if args.json:
        return _json(owner.status(wallet))
    return (
        f"Frozen {short_wallet(wallet)}: every payment from it is refused, "
        "on every rail and in every process, until you run unfreeze."
    )


def _unfreeze(args: argparse.Namespace, path: Path) -> str:
    wallet = _wallet(args, path)
    owner = _owner(path)
    owner.unfreeze(wallet)
    status = owner.status(wallet)
    return _json(status) if args.json else f"Unfrozen. {status.summary}"


def _history(args: argparse.Namespace, path: Path) -> str:
    wallet = _wallet(args, path)
    payments = _owner(path).history(wallet, limit=args.limit)
    if args.json:
        return _json(payments)
    if not payments:
        return f"No payments from {short_wallet(wallet)} yet."
    lines = []
    for payment in payments:
        fields = [
            _iso(payment.at),
            format_usd(payment.amount).rjust(10),
            payment.status.ljust(9),
            payment.rail.ljust(6),
            f"to {short_wallet(payment.to.lower())}" if payment.to else "",
            f"tx {payment.tx}" if payment.tx else (payment.note or ""),
            f"({payment.id})" if payment.status in ("in flight", "refused", "unknown") else "",
            _CDP_HISTORY
            if payment.rail == "cdp" and payment.status in ("in flight", "refused", "unknown")
            else "",
        ]
        lines.append("  ".join(field for field in fields if field))
    return "\n".join(lines)


# A payment the CDP store holds isn't one that never left: CDP signed it, and its payee can redeem
# the authorization until an hour and a minute after CDP recorded it.
_CDP_HISTORY = "CDP signed it: void it only if the chain shows it was never redeemed"


def _cdp_signed(until: datetime | None) -> str:
    when = "an hour and a minute after CDP recorded it" if until is None else _iso(until)
    return (
        f"CDP signed it: its authorization can be redeemed until {when}, "
        "so void it only if the chain shows it was never redeemed"
    )


def _holds(args: argparse.Namespace, path: Path) -> str:
    wallet = _wallet(args, path)
    holds = _owner(path).holds(wallet)
    if args.json:
        return _json(holds)
    if not holds:
        return f"No open payments from {short_wallet(wallet)}."
    lines = []
    for hold in holds:
        until = (
            "counts until voided or settled"
            if hold.counts_until is None
            else f"counts until {_iso(hold.counts_until)}"
        )
        fields = [
            hold.id,
            format_usd(hold.amount).rjust(10),
            hold.reason.ljust(9),
            f"{format_age(hold.age_ms)} old".ljust(12),
            hold.rail.ljust(6),
            f"to {short_wallet(hold.to.lower())}" if hold.to else (hold.note or ""),
            until,
            _cdp_signed(hold.settles_by) if hold.rail == "cdp" else "",
        ]
        lines.append("  ".join(field for field in fields if field))
    return "\n".join(lines)


def _void_unknown(args: argparse.Namespace, path: Path) -> str:
    """Every payment of unknown or refused outcome older than --older-than that can't settle.

    An x402 payment with no settle-by time, once it is an hour and a minute old. For an owner
    who has checked the chain.
    """

    if args.id is not None:
        raise _ArgumentError("void takes an id or --all-unknown, not both")
    if args.older_than is None:
        raise _ArgumentError("void --all-unknown needs --older-than, like --older-than 24h")
    older_than = to_window_ms(args.older_than, "--older-than")
    wallet = _wallet(args, path)
    voided = _owner(path).void_unknown(wallet, older_than=older_than)
    if args.json:
        return _json(voided)
    window = format_window(older_than)
    if not voided:
        return (
            f"No payment of unknown or refused outcome from {short_wallet(wallet)} can be voided "
            f"yet. One goes once it is older than {window} and its payee can no longer settle it; "
            "an x402 payment with no settle-by time, once it is also an hour and a minute old. "
            "Any other payment with no settle-by time, a transfer say, goes only by id, once the "
            "chain shows it never moved: walletcap void <id> --evidence <what shows it>."
        )
    plural = "" if len(voided) == 1 else "s"
    total = sum(payment.amount for payment in voided)
    return (
        f"Voided {len(voided)} payment{plural} of unknown or refused outcome older than {window} "
        f"({format_usd(total)} from {short_wallet(wallet)}): they no longer count. "
        "Only do this for payments you know never left the wallet."
    )


def _payment(args: argparse.Namespace, path: Path, owner: Owner) -> PaymentRecord:
    if not path.exists():
        raise _ArgumentError(f"no budget file at {path}")
    payment = owner.payment(args.id)
    if payment is None:
        raise _ArgumentError(f"no payment {args.id} in {path}")
    if args.wallet is not None and payment.wallet != normalize_wallet(args.wallet):
        raise _ArgumentError(
            f"{args.id} is {short_wallet(payment.wallet)}'s payment, "
            f"not {short_wallet(normalize_wallet(args.wallet))}'s"
        )
    return payment


def _void(args: argparse.Namespace, path: Path) -> str:
    if args.all_unknown:
        return _void_unknown(args, path)
    if args.id is None:
        raise _ArgumentError("void needs the id of a held payment; holds and history show it")
    if not path.exists():
        raise _ArgumentError(f"no budget file at {path}")
    owner = _owner(path)
    payment = _payment(args, path, owner)
    if payment.state == "void":
        return _json(payment) if args.json else f"{args.id} is void already: it counts nothing."
    voided = owner.void(args.id, evidence=args.evidence or "voided by its owner")
    if args.json:
        return _json(voided)
    return (
        f"Voided {args.id} ({format_usd(payment.amount)} from "
        f"{short_wallet(payment.wallet)}): it no longer counts. "
        "Only do this for a payment you know never left the wallet."
    )


def _settle(args: argparse.Namespace, path: Path) -> str:
    if args.id is None:
        raise _ArgumentError("settle needs the id of a payment; holds and history show it")
    if not path.exists():
        raise _ArgumentError(f"no budget file at {path}")
    owner = _owner(path)
    payment = _payment(args, path, owner)
    settled = owner.settle(args.id, evidence=args.tx or args.evidence or "settled by its owner")
    if args.json:
        return _json(settled)
    until = (
        "" if settled.counts_until is None else f"; it counts until {_iso(settled.counts_until)}"
    )
    return (
        f"Settled {args.id} ({format_usd(payment.amount)} from "
        f"{short_wallet(payment.wallet)}){until}."
    )


_COMMANDS: dict[str, Callable[[argparse.Namespace, Path], str]] = {
    "status": _status,
    "set": _set,
    "freeze": _freeze,
    "unfreeze": _unfreeze,
    "history": _history,
    "holds": _holds,
    "void": _void,
    "settle": _settle,
}


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    path = expand_home(args.path if args.path is not None else default_budget_path()).absolute()
    try:
        print(_COMMANDS[args.command](args, path))
    except _ArgumentError as error:
        print(error, file=sys.stderr)
        return 2
    except Exception as error:
        if not is_walletcap_error(error):
            raise
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
