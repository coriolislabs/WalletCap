<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap-mcp

Coinbase's payments MCP server (the Agentic Wallet's) behind a [walletcap](https://github.com/coriolislabs/WalletCap)
spend limit: a per-payment cap and a rolling 24-hour USDC budget per wallet, counted in one budget
file that every process on the host shares.

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx @coinbase/payments-mcp install --client other --no-auto-config
```

In the MCP client's config:

```json
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap-mcp", "--wallet", "0xYourAgentWallet"] } } }
```

- `send` and `make_http_request_with_x402` are checked against the wallet's budget before the
  wallet signs anything, and counted. An x402 payment is priced from the endpoint's own 402
  answer, and the wallet is handed only the terms walletcap can price that are valid an hour or
  less, capped at that amount.
- Tools that move no money (balance, address, sign-in, bazaar search, payment discovery) pass
  through. Any other tool, `trade` included, is refused and left out of `tools/list`.
  `--allow-tool <name>` lets one through, uncounted. JSON-RPC batches are refused.
- A refusal tells the agent why, not which open payments its owner could void.
- It runs `~/.payments-mcp/bundle.js`, the server Coinbase's installer puts there. To run another
  server, put its command after `--`. `--path <file>` names the budget file when it isn't the
  default per-user one.
- Any failure the wallet reports keeps the payment held, noted unknown, until its owner voids it
  with `npx walletcap void <id>`.

Docs: https://coriolislabs.github.io/WalletCap/coinbase-agentic-wallet-budget/

Node 22.13 or later. Apache-2.0. Copyright 2026 Coriolis Labs Inc.
