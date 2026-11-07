<!-- SPDX-License-Identifier: Apache-2.0 -->
# Quint model: why the ledger owns the clock

[`ledger.qnt`](ledger.qnt) models processes that admit one-unit payments against one cap per
rolling window. A payment moves money at the real time it is admitted, and the count uses the
time the admitting process read. The invariant, `capHolds`, says that in every window of real
time at most `CAP` moved.

- `ledgerClock` is walletcap 0.4: every process reads the ledger's clock, which is the real
  time.
- `processClocks` is walletcap 0.2: each process reads its own clock, up to `SKEW` ticks off.

Both use `CAP = 2`, `WINDOW = 3` and two processes. Quint's simulator needs only Node:

```console
$ npx -y @informalsystems/quint@0.33.0 run ledger.qnt --main=ledgerClock --invariant=capHolds --max-steps=24 --max-samples=20000
[ok] No violation found
$ npx -y @informalsystems/quint@0.33.0 run ledger.qnt --main=processClocks --invariant=capHolds --max-steps=24 --max-samples=20000
[violation] Found an issue
```

The violation takes three steps, all at real time 0. Process `a`, whose clock runs 2 ahead,
admits two payments stamped 2. Process `b`, whose clock runs 2 behind, counts the window ending
at −2, finds it empty, and admits a third. 3 units move in one window against a cap of 2.

The simulator samples traces; it does not prove the invariant for all of them. CI runs both
commands: the first must pass and the second must find the violation.
