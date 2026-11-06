// SPDX-License-Identifier: Apache-2.0
// The ledger's clock: the system clock. No option changes it, so every process
// that opens a budget counts with the same time. walletcap's own tests replace
// it through this module, which the package does not export.

let source = Date.now;

/** Milliseconds since the epoch. */
export const now = () => source();

/** For walletcap's tests only: read the time from `read` until resetClock(). */
export function setClock(read) {
  if (typeof read !== 'function') throw new TypeError('setClock takes a function that returns milliseconds');
  source = read;
}

/** For walletcap's tests only: back to the system clock. */
export function resetClock() {
  source = Date.now;
}
