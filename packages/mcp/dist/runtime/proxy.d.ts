import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalService, LatchkeyConfig, PolicyEngine, RiskEngine } from "@latchkey/core";
export interface BuildProxyToolsOptions {
    config: LatchkeyConfig;
    approvalService: ApprovalService;
    riskEngine: RiskEngine;
    policyEngine: PolicyEngine;
    projectDir?: string;
}
export declare function buildProxyTools(server: McpServer, options: BuildProxyToolsOptions): Promise<number>;
//# sourceMappingURL=proxy.d.ts.map