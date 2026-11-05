// SPDX-License-Identifier: Apache-2.0
// Stand-in for the awal CLI's IPC client, for the tests only. It is NOT
// Coinbase's wallet: it never signs or sends anything. It answers the three
// channels walletcap uses, logs each one to FAKE_AWAL_LOG, and settles every
// x402 payment it is asked about (FAKE_AWAL_MODE=settle).
import { appendFileSync } from 'node:fs';

const TX = `0x${'cd'.repeat(32)}`;
const WALLET = '0xd797ead28C38575FDf4fC523866287372340Ca02';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');

export async function sendIpcRequest(channel, data) {
  if (process.env.FAKE_AWAL_LOG !== undefined) {
    appendFileSync(process.env.FAKE_AWAL_LOG, `${JSON.stringify({ channel })}\n`);
  }
  if (channel === 'get-wallet-address') return { address: WALLET };
  if (channel === 'send-transaction') return { transactionHash: TX };
  if (channel === 'make-x402-request') {
    return { status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX }) } };
  }
  return {};
}
