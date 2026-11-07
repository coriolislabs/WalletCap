<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0015. An amount reads back as itself

## Context

walletcap reads a number as dollars and a micro-dollar type as micro-dollars: JavaScript
reads a `number` as dollars and a `bigint` as micro-dollars; Python reads an `int`, `float` or
`Decimal` as dollars and a `Micros` as micro-dollars. Every amount the API returns is
micro-dollars, so `check(status().remaining)` works in both.

A review of 0.4 found that Python's first `Micros`, an `int` subclass, lost its type under
arithmetic: `status.cap // 2` returned a plain `int`, which `to_micros` read as dollars, so a
$150 cap halved became $75,000,000. `cap * 1.5` truncated the factor, and `cap + "3"` added 3.
An `int` subclass can't close all of it: `1.5 * cap` and `Decimal(2) * cap` call `float` and
`Decimal` first, which accept any `int` and return a dollar-typed number before `Micros` sees
the operation.

## Decision

No arithmetic on an amount may give a value that is read back as a larger amount. A mistake
fails with `TypeError`.

- Python's `Micros` is its own type, not an `int` subclass. Every operator returns a `Micros`
  or raises `TypeError`, whichever side the other operand is on:
  - `Micros ± Micros` is a `Micros`; zero adds as itself, so `sum()` works;
  - `Micros * int`, `int * Micros`, `Micros // int`, `Micros % int`, `divmod(Micros, int)`,
    `round`, `abs`, unary `-` and `+`, and `math.floor`, `ceil` and `trunc` are `Micros`;
  - a bare `int`, `float`, `Decimal` or `str` added or subtracted (it could be dollars), a
    `float` or `Decimal` factor, true division, `Micros // Micros`, `Micros % Micros`, powers,
    bit operations and `float()` raise.
  `<`, `<=`, `>` and `>=` take another `Micros`, or zero, as `+` and `-` do: against a bare
  number, `min(status.cap, 150)` would keep the 150 as micro-dollars, and `set_limits` would read
  it as $150. `==` and hashing work like the int of micro-dollars, which can't raise an amount.
  `int(amount)` gives the micro-dollars as a plain int, for code that leaves walletcap.
- A bare Python `int` stays whole dollars on input, as a JavaScript `number` is.
- JavaScript needs no change: bigint arithmetic always gives a bigint, and walletcap reads a
  bigint as micro-dollars. `Number(amount)` is an explicit conversion, like `int(amount)`.

## Consequences

- `Micros` is not an `int`: `isinstance(amount, int)` is false, and `json.dumps` and
  `sqlite3` need `int(amount)` or `str(amount)`. walletcap converts at its own edges (the CLI's
  JSON, the ledger's parameters).
- A Hypothesis test applies every operator to `Micros` and ints, floats, `Decimal`s, strings
  and booleans, on both sides, and checks each result is a `Micros` equal to the same arithmetic
  on micro-dollars, or a `TypeError`.

## Alternatives

- Read a bare `int` as micro-dollars in Python: one rule for every int, but `per_day=150` would
  mean $0.00015, a silent change for code written against 0.3.
- Keep the `int` subclass and override more operators: `float` and `Decimal` on the left still
  win.
