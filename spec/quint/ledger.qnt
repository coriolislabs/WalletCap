// SPDX-License-Identifier: Apache-2.0
// Why the ledger owns the clock (spec/ledger.md). Processes admit one-unit payments against one
// cap per rolling window. A payment moves money at the real time it is admitted, and the
// admitting process stamps it with the time it reads, which is what the count uses. With the
// ledger's clock every process reads the real time; with a clock of its own, each reads the real
// time plus an offset of up to SKEW. The invariant is the cap: in every window of real time, the
// money moved is at most CAP.
module ledger {
  const CAP: int
  const WINDOW: int
  const SKEW: int
  const PROCS: Set[str]

  type Payment = { amount: int, stamped: int, moved: int }

  var now: int
  var offset: str -> int
  var payments: List[Payment]

  // What counts at time t: the payments stamped in (t - WINDOW, t].
  pure def counted(ps: List[Payment], t: int): int =
    ps.foldl(0, (sum, p) => if (p.stamped > t - WINDOW and p.stamped <= t) sum + p.amount else sum)

  // The money that really moved in (end - WINDOW, end].
  pure def moved(ps: List[Payment], end: int): int =
    ps.foldl(0, (sum, p) => if (p.moved > end - WINDOW and p.moved <= end) sum + p.amount else sum)

  action init = {
    nondet clocks = PROCS.setOfMaps((0 - SKEW).to(SKEW)).oneOf()
    all { now' = 0, offset' = clocks, payments' = List() }
  }

  action tick = all { now' = now + 1, offset' = offset, payments' = payments }

  // Admission: the process reads its clock, and admits if what counts then leaves room.
  action admit(process: str): bool = {
    val t = now + offset.get(process)
    all {
      counted(payments, t) + 1 <= CAP,
      payments' = payments.append({ amount: 1, stamped: t, moved: now }),
      now' = now,
      offset' = offset,
    }
  }

  action step = any { tick, nondet process = PROCS.oneOf() admit(process) }

  // In every window of real time that ends at a payment, at most CAP moved.
  val capHolds = payments.foldl(true, (ok, p) => ok and moved(payments, p.moved) <= CAP)
}

// walletcap 0.4: the ledger reads its own clock in SQL, so every admission uses the real time.
module ledgerClock {
  import ledger(CAP = 2, WINDOW = 3, SKEW = 0, PROCS = Set("a", "b")).*
}

// walletcap 0.2: each process brought its own clock, up to 2 ticks off.
module processClocks {
  import ledger(CAP = 2, WINDOW = 3, SKEW = 2, PROCS = Set("a", "b")).*
}
