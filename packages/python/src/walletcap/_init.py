# SPDX-License-Identifier: Apache-2.0
"""``walletcap init``'s last step: the code that puts the budget in front of an agent's payments.

One snippet a rail. They are the README's, with the wallet filled in. The npm package's
cli/init.ts holds the same text, character for character.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from walletcap._doctor import doctor_findings

if TYPE_CHECKING:
    from walletcap.budget import Status

RAILS = ("pay", "x402", "cdp", "agentkit", "awal", "mcp", "python")
"""The rails init has a snippet for; the first is the default."""

_WALLET = "<wallet>"
_SNIPPETS = {
    "pay": """// npm install walletcap
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: '<wallet>' });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));""",
    "x402": """// npm install walletcap @x402/core @x402/evm @x402/fetch
import { openBudget } from 'walletcap';
import { guard } from 'walletcap/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const budget = await openBudget({ wallet: '<wallet>' });
const client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);
const fetchPaid = wrapFetchWithPayment(fetch, client);""",
    "cdp": """// npm install walletcap @coinbase/cdp-sdk
import { openBudget } from 'walletcap';
import { cdpStore } from 'walletcap/cdp';

const budget = await openBudget({ wallet: '<wallet>' });

applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});""",
    "agentkit": """// npm install walletcap @coinbase/agentkit
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';

const budget = await openBudget({ wallet: '<wallet>' });
const x402 = guardAgentKit(new X402ActionProvider(), budget);
// AgentKit.from({ walletProvider, actionProviders: [x402] })""",
    "awal": """# npm install walletcap awal
# walletcap asks awal for its wallet's address, which must be <wallet>
npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …""",
    "mcp": """# npx @coinbase/payments-mcp install --client other --no-auto-config
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap-mcp", "--wallet", "<wallet>"] } } }""",  # noqa: E501
    "python": """# pip install walletcap
from walletcap import open_budget

budget = open_budget("<wallet>")

with budget.pay("$12.50") as payment:
    payment.tx = send_usdc(payee, "12.50")""",
}


def snippet_for(rail: str, wallet: str) -> str:
    """The rail's snippet, for the wallet under its canonical name."""

    return _SNIPPETS[rail].replace(_WALLET, wallet)


def init_text(status: Status, report: dict[str, Any], snippet: str, *, aside: bool) -> str:
    """What init prints: the budget in one line, what doctor found, and the code to run next.

    ``aside`` says the budget is not in the default file, where the snippet's code would look
    for it.
    """

    lines = [status.summary, doctor_findings(report), "", "Next:", snippet]
    if aside:
        lines += [
            "",
            (
                f"The budget is in {status.path}, not the default file: "
                "set WALLETCAP_PATH to it where the agent runs."
            ),
        ]
    return "\n".join(lines)
