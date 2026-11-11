// SPDX-License-Identifier: Apache-2.0
// walletcap init's last step: the code that puts the budget in front of an agent's payments, one
// snippet a rail. They are the README's, with the wallet filled in. The Python package's
// walletcap/_init.py holds the same text, character for character.
import type { Status } from '../core/budget.js';
import { type DoctorReport, doctorFindings } from './doctor.js';

/** The rails init has a snippet for; the first is the default. */
export const RAILS = ['pay', 'x402', 'cdp', 'agentkit', 'awal', 'mcp', 'python'] as const;
export type Rail = (typeof RAILS)[number];

const WALLET = '<wallet>';
const SNIPPETS: Readonly<Record<Rail, string>> = {
  pay: `// npm install walletcap
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: '<wallet>' });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));`,

  x402: `// npm install walletcap @x402/core @x402/evm @x402/fetch
import { openBudget } from 'walletcap';
import { guard } from 'walletcap/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const budget = await openBudget({ wallet: '<wallet>' });
const client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);
const fetchPaid = wrapFetchWithPayment(fetch, client);`,

  cdp: `// npm install walletcap @coinbase/cdp-sdk
import { openBudget } from 'walletcap';
import { cdpStore } from 'walletcap/cdp';

const budget = await openBudget({ wallet: '<wallet>' });

applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});`,

  agentkit: `// npm install walletcap @coinbase/agentkit
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';

const budget = await openBudget({ wallet: '<wallet>' });
const x402 = guardAgentKit(new X402ActionProvider(), budget);
// AgentKit.from({ walletProvider, actionProviders: [x402] })`,

  awal: `# npm install walletcap awal
# walletcap asks awal for its wallet's address, which must be <wallet>
npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …`,

  mcp: `# npx @coinbase/payments-mcp install --client other --no-auto-config
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap-mcp", "--wallet", "<wallet>"] } } }`,

  python: `# pip install walletcap
from walletcap import open_budget

budget = open_budget("<wallet>")

with budget.pay("$12.50") as payment:
    payment.tx = send_usdc(payee, "12.50")`,
};

/** The rail a command line named, or undefined if init has no snippet for it. */
export const railOf = (name: string): Rail | undefined => RAILS.find(rail => rail === name);

/** The rail's snippet, for the wallet under its canonical name. */
export const snippetFor = (rail: Rail, wallet: string): string => SNIPPETS[rail].replaceAll(WALLET, () => wallet);

export interface InitResult {
  status: Status;
  doctor: DoctorReport;
  rail: Rail;
  snippet: string;
}

/**
 * What init prints: the budget in one line, what doctor found, and the code to run next. `aside`
 * says the budget is not in the default file, where the snippet's code would look for it.
 */
export function initText({ status, doctor, snippet }: InitResult, { aside }: { aside: boolean }): string {
  const lines = [status.summary, doctorFindings(doctor), '', 'Next:', snippet];
  if (aside) lines.push('', `The budget is in ${status.path}, not the default file: set WALLETCAP_PATH to it where the agent runs.`);
  return lines.join('\n');
}
