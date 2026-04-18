import type { PolicyRule, RiskAction, RiskResult } from "./types.js";
export interface PolicyContext {
    toolName: string;
    upstreamName?: string | undefined;
    params?: Record<string, unknown> | undefined;
}
export interface PolicyEvaluation {
    matchedRule: PolicyRule | null;
    actionOverride: RiskAction | null;
    explanation: string | null;
}
export declare class PolicyEngine {
    private readonly rules;
    constructor(rules: PolicyRule[]);
    mayMatchTool(context: string | Omit<PolicyContext, "params">): boolean;
    evaluate(context: string | PolicyContext): PolicyEvaluation;
    applyToRisk(context: string | PolicyContext, risk: RiskResult): RiskResult;
}
//# sourceMappingURL=policy-engine.d.ts.map