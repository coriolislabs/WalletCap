# Threat model

This is the model a security reviewer should test walletcap 0.4 against. It is deliberately
narrow: walletcap is a spend *counter*, not a sandbox, a key store, or a chain observer. The
rule it counts by is [spec/ledger.md](https://github.com/coriolislabs/WalletCap/blob/main/spec/ledger.md);
both packages run it from the same SQL, [spec/schema.sql](https://github.com/coriolislabs/WalletCap/blob/main/spec/schema.sql).

## Assets

- the funds in the wallet;
- the budget file: limits, the ledger of payments, and its upgrade notes;
- the agent's ability to keep paying after a restart, a replica, or a key rotation.

## Enforcement tiers

| Tier | What enforces the limit | Ships | Holds against |
|---|---|---|---|
| Advisory | the library, in the agent's own process | yes | bugs, runaway loops, restarts, replicas on one host, payees that bend terms |
| Enforced | a service under its own OS user, reached over a Unix socket checked by peer credentials (`walletcapd`) | no, planned | an agent that can edit files as its own user |
| On chain | the payment path itself: `AccountCapSpender` for Coinbase Spend Permissions | yes, unaudited, testnet only | an agent's own code |

Everything below is the advisory tier unless it says otherwise.

## Adversaries and controls

| Adversary | What they can do | Control | Residual risk |
|---|---|---|---|
| A buggy agent | Pay more than intended | Per-payment cap, rolling cap, `max_payments`, one held payment per payment identity | A bug that pays outside walletcap |
| An agent with the same OS user | Delete the budget file, edit it, drop its triggers, open an owner's handle, call the wallet directly | A missing file refuses by default (`create: false`); triggers refuse any write outside the rule; the owner's handle is a separate API | The payer/owner split is an API boundary, not an OS one. An agent that can write the file as its own user can drop the triggers or delete the file. Use a separate OS user, a separate service, or the on-chain cap |
| A second process or replica on the same host | Race for the last dollar | Admission is one conditional insert inside `BEGIN IMMEDIATE`; SQLite admits one writer at a time, and a `BEFORE INSERT` trigger checks the same rule | A process that edits the file outside SQLite |
| A second process on the same file | Hold an id it read from `holds()`, void that payment and spend the room; or hold a voided id again and settle it | Each hold gets a token, and the payer's settle, void, bound and note need it: a hold of an existing id comes back without one. A voided id can't be held again | A process that reads the token from the file, or opens an owner's handle (see above) |
| The `sqlite3` shell, or a client that skips the conditional insert | Insert a payment past the cap, backdate one, or edit or delete rows | Triggers refuse a held entry the budget doesn't admit, an entry not dated by the ledger's clock, any update or delete of the ledger, and any write to the payments' current state that doesn't come from the ledger | A writer that drops the triggers first |
| A process with a wrong clock | Pay as if the window had passed, or date a payment early | The ledger reads its clock in SQL (`julianday('now')`), inside the statement that writes; no API takes the present time from a caller; an entry must be dated by that clock | A host whose system clock is wrong, or jumps backwards: the ledger counts by the host's clock |
| A second host | Open the same file over NFS, SMB or a Docker Desktop bind mount | Not supported: the file serves one host, on a local disk | SQLite's locks aren't reliable on those filesystems, so two hosts can both take the last dollar. walletcap doesn't detect a network filesystem at open yet. Multiple hosts need a shared service, which isn't shipped |
| A payee | Ask for a different asset, a longer validity, or a "failed" settlement it keeps | The x402 guard prices known USD stablecoins and refuses the rest (`asset`), passes over terms valid more than an hour (`timeout`), and refuses terms it can't read (`terms`); the CDP store refuses a different asset; an unknown outcome keeps counting | An asset the guard cannot price is refused, not valued |
| A payee with a 402 it can replay | Hold authorizations and settle later | A held payment counts until one window past its settle-by time; neither the guard nor the Agentic Wallet wrapper lets terms valid more than an hour, or terms that don't say how long, be signed | A confirmed settlement still needs the chain to be read back |
| A payee that says "settled" | Answer success with a made-up hash, keep the authorization and redeem it later | A settlement never shortens a hold: a settled payment counts until one window past the later of its settlement and its hold's settle-by time, whatever the payee says. The guard reads that time from the signed payload (EIP-3009 `validBefore`, Permit2 `deadline`), or else takes the terms' `maxTimeoutSeconds` from the ledger's now. The Agentic Wallet wrapper hands the wallet the terms it checked, discovered ones included, and takes the longest `maxTimeoutSeconds` among them, plus a minute | The Agentic Wallet decides what it signs, in a page Coinbase hosts and can change: walletcap relies on it signing only a term it was handed, as it did when checked (awal 2.12.2, November 2026). A payment the wallet never answered counts until an owner voids it |
| The same signed payment seen twice | Count it twice, or under a second key | A payment is keyed by its rail's own identity where there is one (`eip3009:<from>:<nonce>`, `permit2:<owner>:<nonce>`); holding an identity again returns the payment already held | A rail with no identity walletcap reads gets a ledger-generated one per hold |
| A payment call that fails halfway | Time out after the money left | An error never settles a payment: the payment stays held, noted unknown, until one window past its settle-by time or until an owner voids it. Nothing in an error's text voids it. `void --all-unknown` leaves one the payee could still settle, an x402 payment with no settle-by time until it is an hour and a minute old, and any other with no settle-by time, a transfer say, for its owner to void by id | An owner who voids a payment that did settle: later evidence can still settle it (`VOID` to `SETTLED`), and the count then includes it |
| Code that retries on errors | Pay twice after "the payment went through but couldn't be recorded" | `PaymentNotRecorded` shares no base class with `BudgetRefused`, `BudgetUnavailable` or `UsageError`, and `pay()` refuses an id already in the ledger | Code that retries on every exception |
| A paying process that asks for looser limits | Raise its own limits | Limits a process passes only tighten its own payments; the stored limits change only through the owner's handle, and a looser ask is a warning | Any process that opens an owner's handle (see above) |
| An agent told why it was refused | Learn which holds take the room, and ask for them to be voided | What the x402 guard (AgentKit's too), the CDP store, the Agentic Wallet wrapper and walletcap-mcp tell the agent is a refusal's `brief`, without hold ids or what the owner can do; `walletcap holds` and `budget.check().message` keep them for the owner | An agent with a shell as the owner's user can run `walletcap holds` itself |
| Another local user | Read the budget file | The file is created `0600` in a `0700` folder, and SQLite gives its WAL and shared-memory files the same mode | Files copied out of that folder keep their own mode |
| A crash or power loss | Lose the last payments | WAL mode with `synchronous = FULL`: the log is synced at every commit, before admission returns. An upgrade from an older file runs in one transaction, and a crash leaves the file as it was | A disk that acknowledges a sync it hasn't made (macOS `fsync` without `F_FULLFSYNC`, some virtual disks) can lose the last commits on power loss. A lost or deleted file is a lost count; the default refuses to recreate it |
| A later on-chain revoke | Land in the same block after a payment | The payment is already ordered ahead of the revoke | The owner's revocation is not retroactive |

## Deployment patterns

1. **One agent, one OS user.** The owner runs `walletcap set` and keeps the budget file out of
   the agent's reach. This is the strong pattern for the library.
2. **A service the agent calls.** The service owns the file and the wallet; the agent gets an
   API, not the key. `walletcapd` will package this.
3. **On chain.** `AccountCapSpender` makes the cap part of the payment path, so the agent's own
   code cannot raise it. It is unaudited; testnet only until an audit.
4. **One host.** The budget file lives on a local disk of the one host whose processes open it.

## What walletcap does not do

- It does not decide whether a payment *should* happen; it only bounds it, and it limits the
  amount, not which offer is paid.
- It does not confirm settlement on chain. A payment the payee calls failed keeps counting until
  its authorization expires (the EIP-3009 `validBefore`, the Permit2 `deadline`, or the terms'
  `maxTimeoutSeconds`), plus one window. A payment whose outcome is unknown counts the same way,
  or until an owner voids it.
- It does not protect the wallet key or the chain.
- It does not make an unaudited contract safe.

## CDP store vs guard

Use **one** per client. `guard(client, budget)` from `walletcap/x402` is walletcap's own counter
and prices every asset. `applySpendControls(..., { store: cdpStore(budget, …) })` keeps CDP's
policy layer but puts its count in walletcap's ledger. Both write the same budget, so both on one
client would count each payment twice; `guard()` refuses a client that already has CDP controls.
