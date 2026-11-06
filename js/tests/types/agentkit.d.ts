// SPDX-License-Identifier: Apache-2.0
// What @coinbase/agentkit 0.10.4 declares for X402ActionProvider
// (dist/action-providers/x402/x402ActionProvider.d.ts), cut to the members the recipes touch.
// AgentKit itself is not a devDependency: it pulls in some 35 packages.
declare module '@coinbase/agentkit' {
  export class X402ActionProvider {
    constructor(config?: unknown);
    private createX402Client;
  }
}
