import type { DimensionScore, RiskContext, RiskResult, SecurityRule } from "./types.js";

export const NOTIFY_THRESHOLD = 30;
// Retained for compatibility: scores above this threshold are still "critical",
// but they now route to approval instead of being auto-blocked.
export const BLOCK_THRESHOLD = 65;
const NORMALIZATION_DIVISOR = 65;

export class RiskEngine {
  public constructor(private readonly userRules: SecurityRule[] = []) {}

  public scoreToolBase(toolName: string, payload: Record<string, unknown> = {}): number {
    const ctx: RiskContext = { toolName, payload };
    const rawTotal =
      calculateReversibility(ctx).score +
      calculateBlastRadius(ctx).score +
      calculateDataSensitivity(ctx).score +
      calculateExternalScope(ctx).score;

    return normalizeScore(rawTotal);
  }

  public score(ctx: RiskContext): RiskResult {
    const breakdown: DimensionScore[] = [
      calculateReversibility(ctx),
      calculateBlastRadius(ctx),
      calculateDataSensitivity(ctx),
      calculateIntentAlignment(ctx),
      calculateTemporalAnomaly(ctx),
      calculateExternalScope(ctx)
    ];

    const payloadString = JSON.stringify(ctx.payload);
    for (const rule of this.userRules) {
      if (new RegExp(rule.pattern, "i").test(`${ctx.toolName} ${payloadString}`)) {
        breakdown.push({
          dimension: `rule:${rule.reason}`,
          score: rule.scoreDelta,
          max: Math.abs(rule.scoreDelta),
          reason: rule.reason
        });
      }
    }

    const score = normalizeScore(breakdown.reduce((sum, dimension) => sum + dimension.score, 0));
    return {
      score,
      level: score >= BLOCK_THRESHOLD ? "critical" : score >= NOTIFY_THRESHOLD ? "high" : "low",
      action: score >= NOTIFY_THRESHOLD ? "notify" : "approve",
      breakdown,
      explanation:
        breakdown
          .filter((dimension) => dimension.score !== 0)
          .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
          .slice(0, 3)
          .map((dimension) => `${dimension.reason} (${dimension.score > 0 ? "+" : ""}${dimension.score})`)
          .join(" · ") || "Safe action"
    };
  }
}

function normalizeScore(rawTotal: number): number {
  return Math.round(Math.min(100, Math.max(0, (rawTotal / NORMALIZATION_DIVISOR) * 100)));
}

function calculateReversibility(ctx: RiskContext): DimensionScore {
  const serialized = JSON.stringify(ctx.payload);

  if (/permanent":\s*true|hard_delete|force_delete/i.test(serialized)) {
    return { dimension: "Reversibility", score: 35, max: 35, reason: "permanent / irreversible deletion" };
  }

  if (/overwrite|replace|wipe|format|reset/i.test(ctx.toolName)) {
    return { dimension: "Reversibility", score: 25, max: 35, reason: "data overwrite" };
  }

  if (/send|publish|post|deploy|transfer/i.test(ctx.toolName)) {
    return { dimension: "Reversibility", score: 22, max: 35, reason: "sent or published externally" };
  }

  if (/delete|remove|destroy/i.test(ctx.toolName)) {
    return { dimension: "Reversibility", score: 12, max: 35, reason: "destructive delete action" };
  }

  return { dimension: "Reversibility", score: 0, max: 35, reason: "reversible action" };
}

function calculateBlastRadius(ctx: RiskContext): DimensionScore {
  const serialized = JSON.stringify(ctx.payload);
  if (/"all"|all_emails|entire|everything/i.test(serialized)) {
    return { dimension: "Blast Radius", score: 25, max: 25, reason: "affects all matching items" };
  }

  let largestArray = 0;
  for (const value of Object.values(ctx.payload)) {
    if (Array.isArray(value)) {
      largestArray = Math.max(largestArray, value.length);
    }
  }

  if (largestArray > 100) {
    return { dimension: "Blast Radius", score: 25, max: 25, reason: "massive batch operation" };
  }

  if (largestArray > 20) {
    return { dimension: "Blast Radius", score: 20, max: 25, reason: "large batch operation" };
  }

  if (largestArray > 5) {
    return { dimension: "Blast Radius", score: 12, max: 25, reason: "batch operation" };
  }

  if (largestArray > 1) {
    return { dimension: "Blast Radius", score: 5, max: 25, reason: "multiple items" };
  }

  return { dimension: "Blast Radius", score: 0, max: 25, reason: "single item" };
}

function calculateDataSensitivity(ctx: RiskContext): DimensionScore {
  const serialized = JSON.stringify(ctx.payload);
  let score = 0;
  let reason = "non-sensitive data";

  if (/api.?key|secret|token|password|private.?key|pem|\.env/i.test(serialized)) {
    score = 20;
    reason = "credential or secret material";
  } else if (/patient|medical|health|hipaa|diagnosis|prescription/i.test(serialized)) {
    score = 20;
    reason = "medical or HIPAA data";
  } else if (/payment|invoice|contract|bank|financial|billing|stripe/i.test(serialized)) {
    score = 18;
    reason = "financial document";
  } else if (/ssn|passport|dob|date.of.birth|home.address/i.test(serialized)) {
    score = 18;
    reason = "PII data";
  } else if (/agreement|nda|legal|gdpr|compliance|terms|policy/i.test(serialized)) {
    score = 15;
    reason = "legal or compliance document";
  } else if (/temp|tmp|test|mock|fixture|sample|dummy|log\./i.test(serialized)) {
    score = -5;
    reason = "temporary or test data";
  }

  return {
    dimension: "Data Sensitivity",
    score: Math.max(-5, Math.min(20, score)),
    max: 20,
    reason
  };
}

function calculateIntentAlignment(ctx: RiskContext): DimensionScore {
  if (!ctx.sessionTask) {
    return { dimension: "Intent Alignment", score: 10, max: 20, reason: "unknown session intent" };
  }

  const task = ctx.sessionTask.toLowerCase();
  const tool = ctx.toolName.toLowerCase();

  if (/delete|clean|remove/.test(task) && /delete|remove|clean/.test(tool)) {
    return { dimension: "Intent Alignment", score: 0, max: 20, reason: "matches stated clean-up task" };
  }

  if (/send|email|reply/.test(task) && /send|reply|compose/.test(tool)) {
    return { dimension: "Intent Alignment", score: 0, max: 20, reason: "matches stated communication task" };
  }

  if (/read|summari[sz]e|list|find|search/.test(task) && /delete|send|publish|remove|wipe/.test(tool)) {
    return { dimension: "Intent Alignment", score: 20, max: 20, reason: "read-only task with destructive action" };
  }

  return { dimension: "Intent Alignment", score: 5, max: 20, reason: "loosely related to stated task" };
}

function calculateTemporalAnomaly(ctx: RiskContext): DimensionScore {
  const now = ctx.now ?? new Date();
  let score = 0;

  if (now.getHours() >= 23 || now.getHours() <= 5) {
    score += 8;
  }

  if ((ctx.callCount ?? 0) > 10) {
    score += 12;
  }

  if ((ctx.sessionAgeMs ?? 0) > 7_200_000) {
    score += 5;
  }

  return {
    dimension: "Temporal Anomaly",
    score: Math.min(15, score),
    max: 15,
    reason: score > 0 ? "unusual timing or velocity" : "normal usage"
  };
}

function calculateExternalScope(ctx: RiskContext): DimensionScore {
  if (/broadcast|announce|post_public/i.test(ctx.toolName)) {
    return { dimension: "External Scope", score: 15, max: 15, reason: "public broadcast" };
  }

  if (/tweet|publish|post/i.test(ctx.toolName)) {
    return { dimension: "External Scope", score: 15, max: 15, reason: "public social post" };
  }

  if (/send_email|send_message|reply_email/i.test(ctx.toolName)) {
    const recipients = JSON.stringify(ctx.payload).match(/@/g)?.length ?? 0;
    const score = recipients > 5 ? 12 : recipients > 0 ? 6 : 0;
    return { dimension: "External Scope", score, max: 15, reason: "outbound communication" };
  }

  return { dimension: "External Scope", score: 0, max: 15, reason: "internal action" };
}
