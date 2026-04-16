import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalService,
  NotificationService,
  RiskEngine,
  SQLiteApprovalStore
} from "@latchkey/core";
import type { LatchkeyConfig, NotificationChannel, NotificationDispatchPayload } from "@latchkey/core";
import { startWebhookServer } from "./server.js";

class StubNotificationChannel implements NotificationChannel {
  public readonly kind = "slack" as const;

  public async sendApprovalRequest(_payload: NotificationDispatchPayload): Promise<void> {}

  public async sendAutoBlocked(_payload: NotificationDispatchPayload): Promise<void> {}
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-webhook-"));
}

async function run(): Promise<void> {
  const tempDir = createTempDirectory();
  const databasePath = path.join(tempDir, "webhook.db");
  const config: LatchkeyConfig = {
    channel: "slack",
    webhookBaseUrl: "http://localhost:0",
    timeoutMs: 500,
    databasePath,
    upstreamServers: [],
    rules: [],
    toolNameMode: "transparent"
  };

  const store = new SQLiteApprovalStore(databasePath);
  store.init();
  const service = new ApprovalService(store, new NotificationService(new StubNotificationChannel()), config);
  const risk = new RiskEngine().score({
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

  const secondRequest = store.createRequest({
    toolName: "send_email",
    params: { to: "dev@example.com" },
    risk,
    timeoutMs: 5_000
  });

  const emailResponse = await fetch(
    `${baseUrl}/approve?token=${encodeURIComponent(secondRequest.token)}&decision=deny`
  );
  assert.equal(emailResponse.status, 200);
  assert.equal(store.getRequest(secondRequest.token)?.status, "denied");

  const thirdRequest = store.createRequest({
    toolName: "send_email",
    params: { to: "dev@example.com" },
    risk,
    timeoutMs: 5_000
  });

  const slackPayload = {
    actions: [{ action_id: "allow", value: thirdRequest.token }]
  };

  const slackResponse = await fetch(`${baseUrl}/webhook/slack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `payload=${encodeURIComponent(JSON.stringify(slackPayload))}`
  });
  assert.equal(slackResponse.status, 200);
  assert.equal(store.getRequest(thirdRequest.token)?.status, "approved");

  server.close();
  store.close();
  console.log("✓ webhook routes resolve approvals through ApprovalService");
  console.log("\n1 webhook integration test passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
