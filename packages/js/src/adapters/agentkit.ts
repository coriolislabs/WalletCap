// SPDX-License-Identifier: Apache-2.0
// walletcap/agentkit: count every payment a Coinbase AgentKit X402ActionProvider makes in a
// budget. AgentKit builds a fresh x402 client for each action through a method its types
// declare private, so a TypeScript subclass can't override it; guardAgentKit() wraps it on the
// instance, and every client the provider builds is guarded before it can sign.
//
//   import { guardAgentKit } from 'walletcap/agentkit';
//   const x402 = guardAgentKit(new X402ActionProvider(), budget);
export { guardAgentKit } from './_x402.js';
export type { AssetEntry } from './_x402.js';
