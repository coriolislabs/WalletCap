// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
declare const paymentId: string;
// --- README ---
import { openOwner } from 'walletcap';

const owner = await openOwner();
await owner.setLimits('0xYourAgentWallet', { perPayment: '$50', perDay: '$150' });
await owner.void(paymentId, { evidence: 'authorization unused past its validBefore' });
await owner.voidUnknown('0xYourAgentWallet', { olderThan: '24h' });
// --- end ---

export {};
