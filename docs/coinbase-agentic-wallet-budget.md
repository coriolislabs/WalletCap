---
title: Coinbase Agentic Wallet and payments MCP budget
description: "Put a dollar budget on Coinbase's Agentic Wallet CLI (awal) and payments MCP server: walletcap checks each send and x402 payment before the wallet signs."
---

# Coinbase Agentic Wallet and payments MCP budget

You give an agent Coinbase's Agentic Wallet, through the `awal` CLI or through the payments MCP
server in Claude Desktop or another MCP client, and you want a dollar limit per payment and per
day on what it sends and pays. `npx walletcap awal` and `npx walletcap awal-mcp` run the wallet's
CLI and MCP server through walletcap. Every `send` and x402 payment is checked against the
wallet's budget before the wallet signs anything, and counted, whichever process or session on
the host makes it.

## The CLI: one word in front of `awal`

```console
$ npm install walletcap awal
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
$ npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …
```

`send` and `x402 pay` are checked and counted by walletcap. Every other command is the wallet's
own.

## The MCP server: one entry in the client's config

Install Coinbase's server once. It goes to `~/.payments-mcp`, and walletcap runs
`~/.payments-mcp/bundle.js` from there. Run on its own, `npx @coinbase/payments-mcp` is the
installer:

```console
$ npx @coinbase/payments-mcp install --client other --no-auto-config
```

Then start the server behind walletcap from the MCP client, Claude Desktop for example:

```json
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap", "awal-mcp", "--wallet", "0xYourAgentWallet"] } } }
```

- `send` and `make_http_request_with_x402` are checked against the wallet's budget before the
  wallet signs anything, and counted.
- The tools that move no money (balance, address, sign-in, bazaar search, payment discovery)
  pass through. Any other tool, `trade` or one the server adds later, is refused and left out of
  the tool list, because walletcap can't count it. `--allow-tool <name>` lets one through,
  uncounted.
- JSON-RPC batches are refused.
- To run another server, put its command after `--`.

## What gets counted

- An x402 payment is priced from the endpoint's own 402 answer, and the wallet is capped at
  exactly that amount, so it refuses to sign for more. The wallet is handed, as
  `paymentRequirements`, only the terms walletcap can price that are valid an hour or less, so it
  skips its own discovery and signs only one of them. With none left, the payment is refused.
- Once the wallet answers, the payment counts until the longest `maxTimeoutSeconds` among the
  terms it was handed (a Solana term at least two minutes), plus a minute, after that answer,
  plus one window, whatever the payee says about it.
- A refusal from the wallet before it signs gives the amount back. Any other failure, a send
  included, keeps counting as unknown until you check the chain and release it. `npx walletcap
  holds` lists them, and `npx walletcap release --all-unknown --older-than 24h` gives back the
  ones you've checked, except one the payee could still settle, and one with no settle-by time
  that is under an hour and a minute old.
- The agent is told why a payment was refused, not which holds you could release.
- A free endpoint's one-unit hold is given back unless the payee confirms a payment.
- Only USDC is counted; a send in any other asset is refused. Amounts are read exactly.
- The budget file serves one host. Machines can't share a budget through a shared volume:
  SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts.
- It binds the payments that go through it, so keep the real `awal` out of the agent's reach.

## What the tests check: 25 tests of `walletcap awal` and `walletcap awal-mcp`

The test suite drives both commands against stand-ins for Coinbase's wallet and MCP server.
Among them:

- sends count in the wallet's budget, and the one past the cap never reaches the wallet;
- the wallet is capped at exactly the price walletcap checked;
- the wallet is handed the terms walletcap discovered, so the payee's word can't end the hold early;
- assets walletcap cannot price are refused before the wallet is asked;
- two processes on one budget share one cap;
- `npx walletcap awal`: payments are counted, everything else is awal;
- `npx walletcap awal-mcp`: the MCP server answers, and payments past the cap never reach it.

## Links

- [README: Coinbase Agentic Wallet](https://github.com/coriolislabs/WalletCap#coinbase-agentic-wallet-awal-cli-and-mcp-server)
  and [the wrapper's source](https://github.com/coriolislabs/WalletCap/blob/main/js/agentic.mjs)
- Tests: [agentic.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/js/tests/agentic.test.mjs)
- [The owner's controls](https://github.com/coriolislabs/WalletCap#the-owners-controls):
  `walletcap status`, `set`, `freeze`, `history` and `release`
- [All pages](index.md). Other stacks: [any x402 client](x402-spending-limit.md),
  [Coinbase AgentKit](coinbase-agentkit-spending-limit.md),
  [Python](python-agent-spending-limit.md)
