import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIClassifier, AIClassifierNotConfiguredError } from "./ai-classifier.js";
import { ApprovalService } from "./approval-service.js";
import { assertAIConfigured, getDefaultDatabasePath, loadConfig, saveConfig } from "./config.js";
import { NotificationError, NotificationService, buildNotificationPreview } from "./notification.js";
import { PolicyEngine } from "./policy-engine.js";
import { parseSecurityRules } from "./policy.js";
import { RiskEngine, fuseScores } from "./risk.js";
import { SQLiteApprovalStore } from "./storage.js";
import type {
  AIClassifierResult,
  HeuristicScoringResult,
  LatchkeyConfig,
  NotificationChannel,
  NotificationDispatchPayload,
  RiskContext
} from "./types.js";

class StubAIClassifier {
  public result: AIClassifierResult;
  public shouldThrow: boolean;
  public thrownError: Error;

  public constructor(scoreOverride = 0) {
    this.result = {
      score: scoreOverride,
      agreement: "confirm",
      primary_concern: "none",
      reasoning: "",
      latency_ms: 1,
      input_tokens: 10,
      output_tokens: 5
    };
    this.shouldThrow = false;
    this.thrownError = new Error("stub classifier failure");
  }

  public async classify(_ctx: RiskContext, _heuristic: HeuristicScoringResult): Promise<AIClassifierResult> {
    if (this.shouldThrow) {
      throw this.thrownError;
    }
    return this.result;
  }
}

class StubNotificationChannel implements NotificationChannel {
  public readonly kind = "email" as const;
  public sentApprovals: NotificationDispatchPayload[] = [];
  public sentAutoBlocks: NotificationDispatchPayload[] = [];
  public onSendApproval: ((payload: NotificationDispatchPayload) => void) | undefined;
  public failApproval = false;

  public async sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void> {
    this.sentApprovals.push(payload);
    if (this.failApproval) {
      throw new NotificationError("simulated notification failure");
    }

    this.onSendApproval?.(payload);
  }

  public async sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void> {
    this.sentAutoBlocks.push(payload);
  }
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-core-"));
}

function createConfig(databasePath: string): LatchkeyConfig {
  return {
    channel: "email",
    webhookBaseUrl: "http://localhost:3001",
    timeoutMs: 500,
    databasePath,
    upstreamServers: [],
    rules: [],
    toolNameMode: "transparent",
    ai: { model: "claude-haiku-4-5-20251001", timeoutMs: 5000 }
  };
}

async function run(): Promise<void> {
  let passed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  }

  await test("RiskEngine scores permanent delete as critical and approval-required", async () => {
    const stub = new StubAIClassifier(0);
    const engine = new RiskEngine([], stub);
    const result = await engine.score({
      toolName: "delete_email",
      payload: { id: "msg_1", permanent: true },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    assert.equal(result.action, "notify");
    assert.equal(result.level, "critical");
    assert.ok(result.score >= 65);
  });

  await test("RiskEngine allows low-risk aligned task", async () => {
    const stub = new StubAIClassifier(0);
    const engine = new RiskEngine([], stub);
    const result = await engine.score({
      toolName: "delete_email",
      payload: { id: "msg_1" },
      sessionTask: "clean inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    assert.equal(result.action, "approve");
  });

  await test("Config save/load supports YAML, policy rules, and env overrides", () => {
    const tempDir = createTempDirectory();
    const configPath = path.join(tempDir, "latchkey.yaml");
    saveConfig(
      {
        channel: "email",
        userEmail: "dev@example.com",
        resendApiKey: "resend_key",
        webhookBaseUrl: "http://example.test",
        timeoutMs: 1234,
        upstreamServers: [],
        toolNameMode: "transparent",
        rules: [{ action: "delete_*", approval: "required", reason: "Deletes need approval" }]
      },
      configPath
    );

    process.env.LATCHKEY_TIMEOUT_MS = "4321";
    process.env.LATCHKEY_DATABASE_PATH = path.join(tempDir, "override.db");
    const loaded = loadConfig(configPath);
    assert.equal(loaded.timeoutMs, 4321);
    assert.equal(loaded.databasePath, path.join(tempDir, "override.db"));
    assert.equal(loaded.rules[0]?.approval, "required");
    assert.equal(loaded.toolNameMode, "transparent");
    delete process.env.LATCHKEY_TIMEOUT_MS;
    delete process.env.LATCHKEY_DATABASE_PATH;
  });

  await test("Config save/load preserves Docker upstreams and param-aware policy rules", () => {
    const tempDir = createTempDirectory();
    const configPath = path.join(tempDir, "latchkey.yaml");
    saveConfig(
      {
        channel: "slack",
        slackWebhookUrl: "https://hooks.slack.test/example",
        webhookBaseUrl: "http://localhost:3001",
        timeoutMs: 60_000,
        databasePath: path.join(tempDir, "latchkey.db"),
        toolNameMode: "transparent",
        upstreamServers: [
          {
            name: "filesystem",
            transport: "docker",
            image: "ghcr.io/example/filesystem-mcp:latest",
            args: ["serve"],
            passWorkspace: true,
            workspaceMountPath: "/workspace",
            containerCwd: "/workspace"
          }
        ],
        rules: [
          {
            tool: "write_*",
            upstream: "filesystem",
            params: [{ path: "path", contains: ".env" }],
            approval: "block",
            reason: "Do not let agents write env files directly"
          }
        ]
      },
      configPath
    );

    const loaded = loadConfig(configPath);
    assert.equal(loaded.upstreamServers[0]?.transport, "docker");
    assert.equal(
      loaded.upstreamServers[0]?.transport === "docker" ? loaded.upstreamServers[0].image : "",
      "ghcr.io/example/filesystem-mcp:latest"
    );
    assert.equal(loaded.rules[0]?.tool, "write_*");
    assert.equal(loaded.rules[0]?.upstream, "filesystem");
    assert.equal(loaded.rules[0]?.params?.[0]?.path, "path");
  });

  await test("Policy parser reads deterministic rules blocks", () => {
    const rules = parseSecurityRules(`
      # SECURITY
      <!-- latchkey-rules:start -->
      [
        { "pattern": "delete_.*", "scoreDelta": 60, "reason": "Never delete data" }
      ]
      <!-- latchkey-rules:end -->
    `);

    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.reason, "Never delete data");
  });

  await test("PolicyEngine overrides heuristic approvals", async () => {
    const policyEngine = new PolicyEngine([
      { action: "delete_*", approval: "required", reason: "Delete actions need approval" },
      { action: "read_email", approval: "none", reason: "Read actions should stay seamless" }
    ]);
    const stub = new StubAIClassifier(0);
    const riskEngine = new RiskEngine([], stub);

    const notifyRisk = policyEngine.applyToRisk(
      "delete_email",
      await riskEngine.score({
        toolName: "delete_email",
        payload: { id: "msg_1" },
        sessionTask: "clean inbox",
        now: new Date("2026-04-12T12:00:00Z")
      })
    );
    assert.equal(notifyRisk.action, "notify");

    const approvedRisk = policyEngine.applyToRisk(
      "read_email",
      await riskEngine.score({
        toolName: "read_email",
        payload: { id: "msg_1" },
        sessionTask: "summarize inbox",
        now: new Date("2026-04-12T12:00:00Z")
      })
    );
    assert.equal(approvedRisk.action, "approve");
  });

  await test("PolicyEngine matches upstream and params for specific tool calls", () => {
    const policyEngine = new PolicyEngine([
      {
        tool: "write_file",
        upstream: "filesystem",
        params: [{ path: "path", contains: ".env" }],
        approval: "block",
        reason: "Environment files stay human-reviewed"
      }
    ]);

    assert.equal(policyEngine.mayMatchTool({ toolName: "write_file", upstreamName: "filesystem" }), true);
    assert.equal(
      policyEngine.evaluate({
        toolName: "write_file",
        upstreamName: "filesystem",
        params: { path: "/workspace/.env" }
      }).actionOverride,
      "notify"
    );
    assert.equal(
      policyEngine.evaluate({
        toolName: "write_file",
        upstreamName: "filesystem",
        params: { path: "/workspace/notes.md" }
      }).actionOverride,
      null
    );
  });

  await test("SQLiteApprovalStore migrates legacy tables", async () => {
    const tempDir = createTempDirectory();
    const databasePath = path.join(tempDir, "legacy.db");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE pending (
        token TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        params TEXT NOT NULL,
        risk INTEGER NOT NULL,
        decision TEXT,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        tool TEXT NOT NULL,
        params TEXT NOT NULL,
        risk INTEGER NOT NULL,
        decision TEXT,
        channel TEXT,
        ts INTEGER NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO pending (token, tool, params, risk, decision, created, expires) VALUES (?,?,?,?,?,?,?)"
    ).run("legacy-token", "delete_email", "{\"id\":\"1\"}", 70, null, Date.now(), Date.now() + 5_000);
    db.close();

    const store = new SQLiteApprovalStore(databasePath);
    store.init();
    const migrated = store.getRequest("legacy-token");
    assert.ok(migrated);
    assert.equal(migrated?.toolName, "delete_email");
    store.close();
  });

  await test("ApprovalService supports approve, deny, timeout, high-risk approval, and execution-failure flows", async () => {
    const tempDir = createTempDirectory();
    const config = createConfig(path.join(tempDir, "approval.db"));
    const store = new SQLiteApprovalStore(config.databasePath);
    store.init();
    const channel = new StubNotificationChannel();
    const service = new ApprovalService(store, new NotificationService(channel), config);

    const approveRisk = await new RiskEngine([], new StubAIClassifier(0)).score({
      toolName: "delete_email",
      payload: { id: "msg_1" },
      sessionTask: "clean inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    const approved = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_1" },
      risk: approveRisk,
      timeoutMs: config.timeoutMs,
      execute: async () => "ok"
    });
    assert.equal(approved.status, "executed");
    assert.equal(approved.result, "ok");

    const notifyRisk = await new RiskEngine([], new StubAIClassifier(0)).score({
      toolName: "delete_email",
      payload: { id: "msg_2" },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    channel.onSendApproval = (payload) => {
      setTimeout(() => {
        service.resolvePendingDecision(payload.request.code, "allow", "test");
      }, 25);
    };

    const allowed = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_2" },
      risk: notifyRisk,
      timeoutMs: config.timeoutMs,
      execute: async () => "deleted"
    });
    assert.equal(allowed.status, "executed");

    channel.onSendApproval = (payload) => {
      setTimeout(() => {
        service.resolvePendingDecision(payload.request.code, "deny", "test");
      }, 25);
    };

    const denied = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_2" },
      risk: notifyRisk,
      timeoutMs: config.timeoutMs,
      execute: async () => "not reached"
    });
    assert.equal(denied.status, "denied");

    channel.onSendApproval = undefined;
    const timedOut = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_2" },
      risk: notifyRisk,
      timeoutMs: 100,
      execute: async () => "not reached"
    });
    assert.equal(timedOut.status, "timed_out");

    const blockRisk = await new RiskEngine([], new StubAIClassifier(0)).score({
      toolName: "delete_email",
      payload: { id: "msg_1", permanent: true },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });
    channel.onSendApproval = (payload) => {
      setTimeout(() => {
        service.resolvePendingDecision(payload.request.code, "allow", "test");
      }, 25);
    };

    const criticalAllowed = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_1", permanent: true },
      risk: blockRisk,
      timeoutMs: config.timeoutMs,
      execute: async () => "critical deleted"
    });
    assert.equal(criticalAllowed.status, "executed");
    assert.equal(criticalAllowed.result, "critical deleted");
    assert.equal(channel.sentAutoBlocks.length, 0);

    channel.onSendApproval = (payload) => {
      setTimeout(() => {
        service.resolvePendingDecision(payload.request.code, "allow", "test");
      }, 25);
    };
    const failed = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_2" },
      risk: notifyRisk,
      timeoutMs: config.timeoutMs,
      execute: async () => {
        throw new Error("boom");
      }
    });
    assert.equal(failed.status, "execution_failed");
    store.close();
  });

  await test("ApprovalService denies notify flow on notification failure", async () => {
    const tempDir = createTempDirectory();
    const config = createConfig(path.join(tempDir, "notify-failure.db"));
    const store = new SQLiteApprovalStore(config.databasePath);
    store.init();
    const channel = new StubNotificationChannel();
    channel.failApproval = true;
    const service = new ApprovalService(store, new NotificationService(channel), config);
    const risk = await new RiskEngine([], new StubAIClassifier(0)).score({
      toolName: "delete_email",
      payload: { id: "msg_2" },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    const result = await service.executeWithApproval({
      toolName: "delete_email",
      params: { id: "msg_2" },
      risk,
      timeoutMs: config.timeoutMs,
      execute: async () => "not reached"
    });

    assert.equal(result.status, "denied");
    store.close();
  });

  await test("Notification helpers include approval codes, links, and CLI fallback", async () => {
    const engine = new RiskEngine([], new StubAIClassifier(0));
    const risk = await engine.score({
      toolName: "send_email",
      payload: { to: "dev@example.com" },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    const request = {
      token: "token-123",
      code: "ABC12345",
      toolName: "send_email",
      params: { to: "dev@example.com" },
      riskScore: risk.score,
      riskLevel: risk.level,
      riskAction: risk.action,
      explanation: risk.explanation,
      status: "pending" as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
      resolvedAt: null,
      decision: null,
      decisionSource: null
    };

    const preview = buildNotificationPreview(request, risk, 1000);
    assert.match(preview, /Allow:/);
    assert.match(preview, /Deny:/);
    assert.match(preview, /latchkey approve ABC12345 allow/);
    assert.match(preview, /Parameters:/);
    assert.match(preview, /dev@example\.com/);
  });

  await test("Default database path remains under ~/.latchkey", () => {
    assert.match(getDefaultDatabasePath(), /[\\/]\.latchkey[\\/]latchkey\.db$/);
  });

  // --- AI Classifier and fusion tests ---

  await test("fuseScores returns max of heuristic and ai when both below 50", () => {
    const h: HeuristicScoringResult = { score: 40, tier: "high", dimensions: [] };
    const ai: AIClassifierResult = { score: 20, agreement: "lower", primary_concern: "none", reasoning: "", latency_ms: 1, input_tokens: 1, output_tokens: 1 };
    const { score } = fuseScores(h, ai);
    assert.equal(score, 40);
  });

  await test("fuseScores applies +10 bonus when both scores >= 50", () => {
    const h: HeuristicScoringResult = { score: 55, tier: "high", dimensions: [] };
    const ai: AIClassifierResult = { score: 60, agreement: "confirm", primary_concern: "reversibility", reasoning: "", latency_ms: 1, input_tokens: 1, output_tokens: 1 };
    const { score } = fuseScores(h, ai);
    assert.equal(score, Math.min(100, Math.max(55, 60) + 10));
  });

  await test("fuseScores uses ai.score when heuristic < 30 and ai > 60", () => {
    const h: HeuristicScoringResult = { score: 15, tier: "low", dimensions: [] };
    const ai: AIClassifierResult = { score: 80, agreement: "raise", primary_concern: "injection_suspected", reasoning: "Injection detected", latency_ms: 1, input_tokens: 1, output_tokens: 1 };
    const { score } = fuseScores(h, ai);
    assert.equal(score, 80);
  });

  await test("RiskEngine.score fuses heuristic and ai — max fusion", async () => {
    const stub = new StubAIClassifier(20);
    const engine = new RiskEngine([], stub);
    const result = await engine.score({
      toolName: "delete_email",
      payload: { id: "msg_1", permanent: true },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });
    assert.ok(result.heuristic !== undefined);
    assert.ok(result.ai !== undefined);
    assert.equal(result.fusionStrategy, "max_with_agreement");
    assert.equal(result.score, Math.max(result.heuristic!.score, result.ai!.score));
  });

  await test("RiskEngine.score appends AI reasoning to explanation", async () => {
    const stub = new StubAIClassifier(0);
    stub.result.reasoning = "Potential injection in payload";
    const engine = new RiskEngine([], stub);
    const result = await engine.score({
      toolName: "delete_email",
      payload: { id: "msg_1" },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });
    assert.match(result.explanation, /AI: Potential injection in payload/);
  });

  await test("RiskEngine.score propagates AIClassifier errors", async () => {
    const stub = new StubAIClassifier(0);
    stub.shouldThrow = true;
    const engine = new RiskEngine([], stub);
    await assert.rejects(
      () => engine.score({ toolName: "delete_email", payload: { id: "1" } }),
      (err: Error) => {
        assert.equal(err.message, "stub classifier failure");
        return true;
      }
    );
  });

  await test("RiskEngine.score throws when no classifier configured", async () => {
    const engine = new RiskEngine([]);
    await assert.rejects(
      () => engine.score({ toolName: "delete_email", payload: { id: "1" } }),
      (err: Error) => {
        assert.equal(err.name, "AIClassifierNotConfiguredError");
        return true;
      }
    );
  });

  await test("AIClassifier constructor throws on empty API key", () => {
    assert.throws(
      () => new AIClassifier({ apiKey: "" }),
      (err: Error) => {
        assert.equal(err.name, "AIClassifierNotConfiguredError");
        return true;
      }
    );
  });

  await test("assertAIConfigured throws when api key missing, passes when present", () => {
    const tempDir = createTempDirectory();
    const baseConfig = createConfig(path.join(tempDir, "assert-ai.db"));

    const missingKeyConfig = { ...baseConfig, ai: { model: "claude-haiku-4-5-20251001", timeoutMs: 5000 } };
    assert.throws(
      () => assertAIConfigured(missingKeyConfig),
      (err: Error) => {
        assert.equal(err.name, "AIClassifierNotConfiguredError");
        return true;
      }
    );

    const withKeyConfig = { ...baseConfig, ai: { apiKey: "sk-ant-test-key", model: "claude-haiku-4-5-20251001", timeoutMs: 5000 } };
    assert.doesNotThrow(() => assertAIConfigured(withKeyConfig));
  });

  await test("loadConfig succeeds without ai.apiKey; assertAIConfigured rejects it", () => {
    const tempDir = createTempDirectory();
    const configPath = path.join(tempDir, "no-ai-key.yaml");
    saveConfig(
      {
        channel: "email",
        webhookBaseUrl: "http://localhost:3001",
        timeoutMs: 1000,
        upstreamServers: [],
        rules: [],
        toolNameMode: "transparent"
      },
      configPath
    );

    const loaded = loadConfig(configPath);
    assert.equal(loaded.ai.apiKey, undefined);
    assert.equal(loaded.ai.model, "claude-haiku-4-5-20251001");
    assert.throws(() => assertAIConfigured(loaded), (err: Error) => {
      assert.equal(err.name, "AIClassifierNotConfiguredError");
      return true;
    });
  });

  await test("Config round-trip preserves ai block", () => {
    const tempDir = createTempDirectory();
    const configPath = path.join(tempDir, "ai-roundtrip.yaml");
    saveConfig(
      {
        channel: "email",
        webhookBaseUrl: "http://localhost:3001",
        timeoutMs: 1000,
        upstreamServers: [],
        rules: [],
        toolNameMode: "transparent",
        ai: { apiKey: "sk-ant-round-trip", model: "claude-haiku-4-5-20251001", timeoutMs: 8000 }
      },
      configPath
    );

    const loaded = loadConfig(configPath);
    assert.equal(loaded.ai.apiKey, "sk-ant-round-trip");
    assert.equal(loaded.ai.model, "claude-haiku-4-5-20251001");
    assert.equal(loaded.ai.timeoutMs, 8000);
  });

  console.log(`\n${passed} core tests passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
