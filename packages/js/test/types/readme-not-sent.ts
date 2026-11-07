// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
declare const error: Error;
// --- README ---
import { notSent } from 'walletcap';

throw notSent(error); // inside the payment function
// --- end ---

export {};
