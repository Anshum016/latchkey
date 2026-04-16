import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalService } from "./approval-service.js";
import { getDefaultDatabasePath, loadConfig, saveConfig } from "./config.js";
import { NotificationError, NotificationService, buildNotificationPreview } from "./notification.js";
import { PolicyEngine } from "./policy-engine.js";
import { parseSecurityRules } from "./policy.js";
import { RiskEngine } from "./risk.js";
import { SQLiteApprovalStore } from "./storage.js";
import type { LatchkeyConfig, NotificationChannel, NotificationDispatchPayload } from "./types.js";

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
    toolNameMode: "transparent"
  };
}

async function run(): Promise<void> {
  let passed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  }

  await test("RiskEngine scores permanent delete as critical and approval-required", () => {
    const engine = new RiskEngine();
    const result = engine.score({
      toolName: "delete_email",
      payload: { id: "msg_1", permanent: true },
      sessionTask: "summarize my inbox",
      now: new Date("2026-04-12T12:00:00Z")
    });

    assert.equal(result.action, "notify");
    assert.equal(result.level, "critical");
    assert.ok(result.score >= 65);
  });

  await test("RiskEngine allows low-risk aligned task", () => {
    const engine = new RiskEngine();
    const result = engine.score({
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

  await test("PolicyEngine overrides heuristic approvals", () => {
    const policyEngine = new PolicyEngine([
      { action: "delete_*", approval: "required", reason: "Delete actions need approval" },
      { action: "read_email", approval: "none", reason: "Read actions should stay seamless" }
    ]);
    const riskEngine = new RiskEngine();

    const notifyRisk = policyEngine.applyToRisk(
      "delete_email",
      riskEngine.score({
        toolName: "delete_email",
        payload: { id: "msg_1" },
        sessionTask: "clean inbox",
        now: new Date("2026-04-12T12:00:00Z")
      })
    );
    assert.equal(notifyRisk.action, "notify");

    const approvedRisk = policyEngine.applyToRisk(
      "read_email",
      riskEngine.score({
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

    const approveRisk = new RiskEngine().score({
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

    const notifyRisk = new RiskEngine().score({
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

    const blockRisk = new RiskEngine().score({
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
    const risk = new RiskEngine().score({
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

  await test("Notification helpers include approval codes, links, and CLI fallback", () => {
    const engine = new RiskEngine();
    const risk = engine.score({
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
  });

  await test("Default database path remains under ~/.latchkey", () => {
    assert.match(getDefaultDatabasePath(), /[\\/]\.latchkey[\\/]latchkey\.db$/);
  });

  console.log(`\n${passed} core tests passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
