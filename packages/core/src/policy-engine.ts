import type { PolicyParamCondition, PolicyRule, RiskAction, RiskResult } from "./types.js";

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

function escapeRegex(source: string): string {
  return source.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${normalized}$`, "i");
}

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }

  if (!pattern.includes("*")) {
    return false;
  }

  return globToRegex(pattern).test(value);
}

function getRuleToolPattern(rule: PolicyRule): string | undefined {
  return rule.tool ?? rule.action;
}

function getParamValue(params: Record<string, unknown> | undefined, inputPath: string): unknown {
  if (!params) {
    return undefined;
  }

  const parts = inputPath.split(".").filter((part) => part.length > 0);
  let current: unknown = params;

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

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function stringifyMatchValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function matchesParamCondition(
  condition: PolicyParamCondition,
  params: Record<string, unknown> | undefined
): boolean {
  const value = getParamValue(params, condition.path);
  const exists = value !== undefined;

  if (condition.exists !== undefined && condition.exists !== exists) {
    return false;
  }

  if (!exists) {
    return (
      condition.equals === undefined &&
      condition.notEquals === undefined &&
      condition.regex === undefined &&
      condition.glob === undefined &&
      condition.contains === undefined
    );
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
      const contained = value.some((item) => stringifyMatchValue(item).includes(condition.contains as string));
      if (!contained) {
        return false;
      }
    } else if (!stringified.includes(condition.contains)) {
      return false;
    }
  }

  return true;
}

function matchesRule(rule: PolicyRule, context: PolicyContext, includeParams: boolean): boolean {
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

function approvalModeToRiskAction(approval: PolicyRule["approval"]): RiskAction {
  switch (approval) {
    case "none":
      return "approve";
    case "required":
      return "notify";
    case "block":
      return "notify";
  }
}

function normalizeContext(context: string | PolicyContext): PolicyContext {
  return typeof context === "string" ? { toolName: context } : context;
}

function describeRule(rule: PolicyRule): string {
  const scope: string[] = [];
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
  public constructor(private readonly rules: PolicyRule[]) {}

  public mayMatchTool(context: string | Omit<PolicyContext, "params">): boolean {
    const normalized = normalizeContext(context);
    return this.rules.some((rule) => matchesRule(rule, normalized, false));
  }

  public evaluate(context: string | PolicyContext): PolicyEvaluation {
    const normalized = normalizeContext(context);

    for (const rule of this.rules) {
      if (matchesRule(rule, normalized, true)) {
        const effectiveApproval = rule.approval === "block" ? "required" : rule.approval;
        const actionOverride = approvalModeToRiskAction(rule.approval);
        return {
          matchedRule: rule,
          actionOverride,
          explanation:
            rule.reason ??
            `Policy rule for ${describeRule(rule)} requires "${effectiveApproval}" handling for ${normalized.toolName}.`
        };
      }
    }

    return {
      matchedRule: null,
      actionOverride: null,
      explanation: null
    };
  }

  public applyToRisk(context: string | PolicyContext, risk: RiskResult): RiskResult {
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
