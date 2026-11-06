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
| A payee | Ask for a different asset, a longer validity, or a "failed" settlement it keeps | The guard prices known USD stablecoins and refuses the rest; the CDP store refuses a different asset; an unknown outcome keeps counting | An asset the guard cannot price is refused, not valued |
| A payee with a 402 it can replay | Hold authorizations and settle later | A reservation counts until it is committed/released, or its expiry plus one window | A confirmed settlement still needs the chain to be read back |
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
4. **One host, one volume.** SQLite locking is a local-filesystem contract. A
   shared volume is not a multi-host database; replicas on separate hosts need
   the Postgres backend (next), not a network mount.

## What the guard does not do

- It does not decide whether a payment *should* happen; it only bounds it.
- It does not confirm settlement. A payment the payee calls failed keeps
  counting until its authorization expires, and a payment with no expiry keeps
  counting until an owner releases it.
- It does not protect the wallet key or the chain.
- It does not make an unaudited contract safe.

## CDP store vs guard

Use **one** per client. `budget.guard(client)` is walletcap's own counter and
prices every asset. `applySpendControls(..., { store: budget.cdpStore() })`
keeps CDP's policy layer but replaces its store with walletcap's ledger. Both
write the same budget, so both on one client double-count the payment.
