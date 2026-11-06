# Threat model

This is the model a security reviewer should test against. It is deliberately
narrow: walletcap is a spend *counter*, not a sandbox, a key store, or a chain
observer.

## Assets

- the funds in the wallet;
- the budget file (limits, reservations, payment history);
- the agent's ability to keep paying after a restart, a replica, or a key
  rotation.

## Adversaries and controls

| Adversary | What they can do | Control | Residual risk |
|---|---|---|---|
| A buggy agent | Pay more than intended | Per-payment cap, rolling cap, `max_uses`, one reservation per payment | A bug that bypasses the guard entirely |
| An agent with the same OS user | Delete the budget file, edit it, call the wallet directly | A missing file refuses by default (`create: false`); owner-only `walletcap set`; the file is the source of truth | It can still call the wallet or edit the file. Use a separate OS user, a separate service, or the on-chain cap |
| A second process or replica on the same host | Race for the last dollar | `BEGIN IMMEDIATE` + a re-check inside the write transaction | A process that writes the file outside the library |
| A second host | Open the same file over NFS, SMB or a Docker Desktop bind mount | Not supported: the file serves one host, on a local disk | SQLite's locks aren't reliable on those filesystems, so two hosts can both take the last dollar. Multiple hosts need a shared service, which isn't shipped yet |
| A process with a wrong clock | Pay as if the window had passed | The ledger reads the system clock; there is no clock option, and a settle-by time already past counts as now | A host whose system clock is wrong |
| A payee | Ask for a different asset, a longer validity, or a "failed" settlement it keeps | The guard prices known USD stablecoins and refuses the rest, and passes over terms valid more than an hour; the CDP store refuses a different asset; an unknown outcome keeps counting | An asset the guard cannot price is refused, not valued |
| A payee with a 402 it can replay | Hold authorizations and settle later | A reservation counts until it is committed/released, or its expiry plus one window; neither the guard nor the Agentic Wallet wrapper signs terms valid more than an hour, or terms that don't say how long | A confirmed settlement still needs the chain to be read back |
| A payee that says "settled" | Answer success with a made-up hash, keep the authorization and redeem it later | A commit never shortens a hold: the payment counts until one window past its authorization's expiry, whatever the payee says. The guard reads the expiry from the signed payload (EIP-3009 `validBefore`, Permit2 `deadline`), or else takes the signing time plus `maxTimeoutSeconds`. The Agentic Wallet wrapper hands the wallet the terms it checked, discovered ones included, and takes the longest `maxTimeoutSeconds` among them, plus a minute | The Agentic Wallet decides what it signs, in a page Coinbase hosts and can change: walletcap relies on it signing only a term it was handed, as it did when checked (awal 2.12.2, November 2026). A payment the wallet never answered counts until an owner releases it |
| A payment call that fails halfway | Time out after the money left | An error never settles a payment: the reservation stays open, marked unknown, until its settle-by time plus one window or until an owner releases it. `release --all-unknown` leaves one the payee could still settle | An owner who releases a payment that did settle |
| An agent told why it was refused | Learn which holds take the room, and ask for them to be released | What the Agentic Wallet wrapper, its CLI and its MCP proxy tell the agent leaves out hold ids and release instructions; `walletcap holds` and `budget.check()` keep them for the owner | An agent with a shell as the owner's user can run `walletcap holds` itself |
| Another local user | Read the budget file | The parent directory is created `0700`; use a `0600` file if you pass a custom `path` | Files copied out of that directory keep their mode |
| A host failure | Lose the file | The database is one file; back it up like any other state | A lost file is a lost count; the default refuses to recreate it |
| A later on-chain revoke | Land in the same block after a payment | The payment is already ordered ahead of the revoke | The owner's revocation is not retroactive |

## Deployment patterns

1. **One agent, one OS user.** The owner runs `walletcap set` and keeps the
   budget file out of the agent's reach. This is the strong pattern.
2. **A service the agent calls.** The service owns the file and the wallet; the
   agent gets an API, not the key.
3. **On chain.** `AccountCapSpender` makes the cap part of the payment path, so
   the agent's own code cannot raise it. It is unaudited; testnet only until an
   audit.
4. **One host.** The budget file lives on a local disk of the one host whose
   processes open it. SQLite's locks aren't reliable over NFS, SMB or Docker
   Desktop bind mounts, so a file shared that way can let two hosts both take
   the last dollar. Multiple hosts need a shared service, which isn't shipped
   yet.

## What the guard does not do

- It does not decide whether a payment *should* happen; it only bounds it.
- It does not confirm settlement. A payment the payee calls failed keeps
  counting until its authorization expires (the EIP-3009 `validBefore`, the
  Permit2 `deadline`, or the signing time plus `maxTimeoutSeconds`), plus one
  window. A payment whose outcome is unknown counts the same way.
- It does not protect the wallet key or the chain.
- It does not make an unaudited contract safe.

## CDP store vs guard

Use **one** per client. `budget.guard(client)` is walletcap's own counter and
prices every asset. `applySpendControls(..., { store: budget.cdpStore() })`
keeps CDP's policy layer but replaces its store with walletcap's ledger. Both
write the same budget, so both on one client double-count the payment.
