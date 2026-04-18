import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalService,
  NotificationService,
  RiskEngine,
  SQLiteApprovalStore
} from "@latchkey/core";
import type { AIClassifierResult, HeuristicScoringResult, RiskContext } from "@latchkey/core";
import type { LatchkeyConfig, NotificationChannel, NotificationDispatchPayload } from "@latchkey/core";
import { startWebhookServer } from "./server.js";

class StubAIClassifier {
  public async classify(_ctx: RiskContext, _h: HeuristicScoringResult): Promise<AIClassifierResult> {
    return { score: 0, agreement: "confirm", primary_concern: "none", reasoning: "", latency_ms: 1, input_tokens: 1, output_tokens: 1 };
  }
}

class StubNotificationChannel implements NotificationChannel {
  public readonly kind = "slack" as const;

  public async sendApprovalRequest(_payload: NotificationDispatchPayload): Promise<void> {}

  public async sendAutoBlocked(_payload: NotificationDispatchPayload): Promise<void> {}
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-webhook-"));
}

function slackSignatureHeaders(signingSecret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `v0:${timestamp}:${body}`;
  const sig = `v0=${crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex")}`;
  return {
    "x-slack-signature": sig,
    "x-slack-request-timestamp": timestamp
  };
}

async function run(): Promise<void> {
  let passed = 0;

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  }

  const tempDir = createTempDirectory();
  const databasePath = path.join(tempDir, "webhook.db");
  const config: LatchkeyConfig = {
    channel: "slack",
    webhookBaseUrl: "http://localhost:0",
    timeoutMs: 500,
    databasePath,
    upstreamServers: [],
    rules: [],
    toolNameMode: "transparent",
    ai: { model: "claude-haiku-4-5-20251001", timeoutMs: 5000 }
  };

  const store = new SQLiteApprovalStore(databasePath);
  store.init();
  const service = new ApprovalService(store, new NotificationService(new StubNotificationChannel()), config);
  const risk = await new RiskEngine([], new StubAIClassifier()).score({
    toolName: "send_email",
    payload: { to: "dev@example.com" },
    sessionTask: "summarize inbox",
    now: new Date("2026-04-12T12:00:00Z")
  });

  const server = await startWebhookServer({ port: 0, configOverride: config, service });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Webhook server did not expose a TCP port.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  await test("email link resolves approval via GET /approve", async () => {
    const request = store.createRequest({
      toolName: "send_email",
      params: { to: "dev@example.com" },
      risk,
      timeoutMs: 5_000
    });

    const response = await fetch(
      `${baseUrl}/approve?token=${encodeURIComponent(request.token)}&decision=deny`
    );
    assert.equal(response.status, 200);
    assert.equal(store.getRequest(request.token)?.status, "denied");
  });

  await test("Slack webhook resolves approval without signing secret configured", async () => {
    const request = store.createRequest({
      toolName: "send_email",
      params: { to: "dev@example.com" },
      risk,
      timeoutMs: 5_000
    });

    const body = `payload=${encodeURIComponent(JSON.stringify({ actions: [{ action_id: "allow", value: request.token }] }))}`;
    const response = await fetch(`${baseUrl}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    assert.equal(response.status, 200);
    assert.equal(store.getRequest(request.token)?.status, "approved");
  });

  server.close();
  store.close();

  // Signing secret verification tests use a separate server instance
  const signingSecret = "test-signing-secret-abc123";
  const signedConfig: LatchkeyConfig = { ...config, slackSigningSecret: signingSecret };
  const signedTempDir = createTempDirectory();
  const signedDbPath = path.join(signedTempDir, "signed.db");
  const signedStore = new SQLiteApprovalStore(signedDbPath);
  signedStore.init();
  const signedService = new ApprovalService(signedStore, new NotificationService(new StubNotificationChannel()), signedConfig);
  const signedServer = await startWebhookServer({ port: 0, configOverride: signedConfig, service: signedService });
  const signedAddress = signedServer.address();
  if (!signedAddress || typeof signedAddress === "string") {
    throw new Error("Signed webhook server did not expose a TCP port.");
  }

  const signedBaseUrl = `http://127.0.0.1:${signedAddress.port}`;

  await test("Slack webhook with valid signature is accepted", async () => {
    const request = signedStore.createRequest({
      toolName: "send_email",
      params: { to: "dev@example.com" },
      risk,
      timeoutMs: 5_000
    });

    const body = `payload=${encodeURIComponent(JSON.stringify({ actions: [{ action_id: "allow", value: request.token }] }))}`;
    const response = await fetch(`${signedBaseUrl}/webhook/slack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...slackSignatureHeaders(signingSecret, body)
      },
      body
    });
    assert.equal(response.status, 200);
    assert.equal(signedStore.getRequest(request.token)?.status, "approved");
  });

  await test("Slack webhook with missing signature is rejected when secret is configured", async () => {
    const body = `payload=${encodeURIComponent(JSON.stringify({ actions: [{ action_id: "allow", value: "any-token" }] }))}`;
    const response = await fetch(`${signedBaseUrl}/webhook/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    assert.equal(response.status, 401);
  });

  await test("Slack webhook with wrong signature is rejected", async () => {
    const body = `payload=${encodeURIComponent(JSON.stringify({ actions: [{ action_id: "allow", value: "any-token" }] }))}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await fetch(`${signedBaseUrl}/webhook/slack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=badhash",
        "x-slack-request-timestamp": timestamp
      },
      body
    });
    assert.equal(response.status, 401);
  });

  signedServer.close();
  signedStore.close();

  console.log(`\n${passed} webhook integration tests passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
