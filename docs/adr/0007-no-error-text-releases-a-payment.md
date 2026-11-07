# 0007. No error's text releases a payment

## Context

0.3's Agentic Wallet wrapper read the wallet's error messages and gave the amount back when one
matched a refusal it knew came before signing. A payee can put any text in an error, and wallet
messages change between releases.

## Decision

The wrapper reads no error text. Any failure the wallet reports keeps the payment held, noted
unknown, until its owner voids it, or the bulk release voids it once it is an hour and a minute
old. A free endpoint's one-unit hold is still given back, because nothing was signed for value.

## Consequences

- A refusal the wallet makes before signing now holds its amount until it is voided: more
  conservative, and an owner sees it in `walletcap holds`.
- No message can make walletcap forget a signature.
