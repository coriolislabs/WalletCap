// SPDX-License-Identifier: Apache-2.0
// CI: check the --json output of `npx -p walletcap-crash-test -p @coinbase/agentkit … --agentkit`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const row = run.agentkit;
assert.ok(row, 'the AgentKit row did not run');
assert.deepEqual(row.agentkit.received.map(p => [p.network, p.amount, p.toStranger]), [['eip155:8453', '1000000', true]]);
assert.deepEqual([row.agentkit.reported.network, row.agentkit.reported.amount], ['eip155:84532', '10000']);
assert.deepEqual(row.walletcap.received, []);
for (const s of run.scenarios) assert.equal(s.walletcap.over, '0', `${s.id}: walletcap let money past the cap`);
console.log(`AgentKit ${row.version}: signed $1.00 on Base mainnet, reported $0.01 on Base Sepolia; walletcap refused.`);
