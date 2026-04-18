function escapeRegex(source) {
    return source.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globToRegex(pattern) {
    const normalized = pattern.split("*").map(escapeRegex).join(".*");
    return new RegExp(`^${normalized}$`, "i");
}
function matchesGlob(pattern, value) {
    if (pattern === value) {
        return true;
    }
    if (!pattern.includes("*")) {
        return false;
    }
    return globToRegex(pattern).test(value);
}
function getRuleToolPattern(rule) {
    return rule.tool ?? rule.action;
}
function getParamValue(params, inputPath) {
    if (!params) {
        return undefined;
    }
    const parts = inputPath.split(".").filter((part) => part.length > 0);
    let current = params;
    for (const part of parts) {
        if (Array.isArray(current)) {
            const index = Number(part);
            if (!Number.isInteger(index)) {
                return undefined;
            }
            current = current[index];
            continue;
        }
        if (!current || typeof current !== "object") {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
function stringifyMatchValue(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value === undefined) {
        return "";
    }
    return JSON.stringify(value);
}
function matchesParamCondition(condition, params) {
    const value = getParamValue(params, condition.path);
    const exists = value !== undefined;
    if (condition.exists !== undefined && condition.exists !== exists) {
        return false;
    }
    if (!exists) {
        return (condition.equals === undefined &&
            condition.notEquals === undefined &&
            condition.regex === undefined &&
            condition.glob === undefined &&
            condition.contains === undefined);
    }
    if (condition.equals !== undefined && value !== condition.equals) {
        return false;
    }
    if (condition.notEquals !== undefined && value === condition.notEquals) {
        return false;
    }
    const stringified = stringifyMatchValue(value);
    if (condition.regex && !new RegExp(condition.regex, "i").test(stringified)) {
        return false;
    }
    if (condition.glob && !matchesGlob(condition.glob, stringified)) {
        return false;
    }
    if (condition.contains) {
        if (Array.isArray(value)) {
            const contained = value.some((item) => stringifyMatchValue(item).includes(condition.contains));
            if (!contained) {
                return false;
            }
        }
        else if (!stringified.includes(condition.contains)) {
            return false;
        }
    }
    return true;
}
function matchesRule(rule, context, includeParams) {
    const toolPattern = getRuleToolPattern(rule);
    if (toolPattern && !matchesGlob(toolPattern, context.toolName)) {
        return false;
    }
    if (rule.upstream) {
        if (!context.upstreamName) {
            return false;
        }
        if (!matchesGlob(rule.upstream, context.upstreamName)) {
            return false;
        }
    }
    if (includeParams && rule.params) {
        return rule.params.every((condition) => matchesParamCondition(condition, context.params));
    }
    return true;
}
function approvalModeToRiskAction(approval) {
    switch (approval) {
        case "none":
            return "approve";
        case "required":
            return "notify";
        case "block":
            return "block";
    }
}
function normalizeContext(context) {
    return typeof context === "string" ? { toolName: context } : context;
}
function describeRule(rule) {
    const scope = [];
    const toolPattern = getRuleToolPattern(rule);
    if (toolPattern) {
        scope.push(`tool "${toolPattern}"`);
    }
    if (rule.upstream) {
        scope.push(`upstream "${rule.upstream}"`);
    }
    if (rule.params?.length) {
        scope.push(`${rule.params.length} param condition(s)`);
    }
    return scope.length > 0 ? scope.join(", ") : "all tool calls";
}
export class PolicyEngine {
    rules;
    constructor(rules) {
        this.rules = rules;
    }
    mayMatchTool(context) {
        const normalized = normalizeContext(context);
        return this.rules.some((rule) => matchesRule(rule, normalized, false));
    }
    evaluate(context) {
        const normalized = normalizeContext(context);
        for (const rule of this.rules) {
            if (matchesRule(rule, normalized, true)) {
                const actionOverride = approvalModeToRiskAction(rule.approval);
                return {
                    matchedRule: rule,
                    actionOverride,
                    explanation: rule.reason ??
                        `Policy rule for ${describeRule(rule)} requires "${rule.approval}" handling for ${normalized.toolName}.`
                };
            }
        }
        return {
            matchedRule: null,
            actionOverride: null,
            explanation: null
        };
    }
    applyToRisk(context, risk) {
        const normalized = normalizeContext(context);
        const evaluation = this.evaluate(normalized);
        if (!evaluation.actionOverride) {
            return risk;
        }
        const policyReason = evaluation.explanation ?? "Policy override applied";
        const existingReasons = risk.explanation === "Safe action" ? [] : [risk.explanation];
        const explanation = [policyReason, ...existingReasons].join(" · ");
        const combinedExplanation = [policyReason, ...existingReasons].join(" - ");
        return {
            ...risk,
            action: evaluation.actionOverride,
            explanation: combinedExplanation,
            breakdown: [
                {
                    dimension: "Policy",
                    score: 0,
                    max: 0,
                    reason: policyReason
                },
                ...risk.breakdown
            ]
        };
    }
}
