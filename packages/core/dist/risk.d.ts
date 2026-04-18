import type { RiskContext, RiskResult, SecurityRule } from "./types.js";
export declare const NOTIFY_THRESHOLD = 30;
export declare const BLOCK_THRESHOLD = 65;
export declare class RiskEngine {
    private readonly userRules;
    constructor(userRules?: SecurityRule[]);
    scoreToolBase(toolName: string, payload?: Record<string, unknown>): number;
    score(ctx: RiskContext): RiskResult;
}
//# sourceMappingURL=risk.d.ts.map