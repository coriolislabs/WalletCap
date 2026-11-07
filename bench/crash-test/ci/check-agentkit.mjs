// SPDX-License-Identifier: Apache-2.0
// CI: check the --json output of `npx -p walletcap-crash-test -p @coinbase/agentkit … --agentkit`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const row = run.agentkit;
assert.ok(row, 'the AgentKit row did not run');
assert.deepEqual(row.agentkit.received.map(p => [p.network, p.amount, p.toStranger]), [['eip155:8453', '1000000', true]]);
assert.deepEqual([row.agentkit.reported.network, row.agentkit.reported.amount], ['eip155:84532', '10000']);
// walletcap passes over the $1.00, valid 4 days; the offer left is the 1¢ the agent approved.
// It limits the amount, not the offer: anything but the approved offer, or nothing, fails here.
assert.deepEqual(row.walletcap.received.map(p => [p.network, p.amount, p.toStranger, p.approved]), [['eip155:84532', '10000', false, true]]);
for (const s of run.scenarios) {
  assert.equal(s.walletcap.over, '0', `${s.id}: walletcap let money past the cap`);
  assert.equal(s.cdpStore.over, '0', `${s.id}: CDP on walletcap's cdpStore let money past the cap`);
}
console.log(`AgentKit ${row.version}: signed $1.00 on Base mainnet, reported $0.01 on Base Sepolia; walletcap signed the $0.01 on Base Sepolia.`);
