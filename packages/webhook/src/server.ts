import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  ApprovalService,
  SQLiteApprovalStore,
  createNotificationService,
  loadConfig
} from "@latchkey/core";

dotenv.config();

export interface StartWebhookServerOptions {
  port?: number;
  configPath?: string;
  configOverride?: ReturnType<typeof loadConfig>;
  service?: ApprovalService;
}

export async function startWebhookServer(
  options: StartWebhookServerOptions = {}
): Promise<Server> {
  const config = options.configOverride ?? loadConfig(options.configPath);
  const service =
    options.service ??
    (() => {
      const store = new SQLiteApprovalStore(config.databasePath);
      store.init();
      return new ApprovalService(store, createNotificationService(config), config);
    })();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "latchkey-webhook", time: new Date().toISOString() });
  });

  app.post("/webhook/slack", (req, res) => {
    try {
      const payload = JSON.parse(String(req.body.payload ?? "{}")) as {
        actions?: Array<{ action_id?: string; value?: string }>;
      };
      const action = payload.actions?.[0];
      if (!action?.action_id || !action.value) {
        res.status(400).json({ error: "Invalid Slack action payload." });
        return;
      }

      const decision = action.action_id === "allow" ? "allow" : "deny";
      const resolved = service.resolvePendingDecision(action.value, decision, "slack");
      if (!resolved.request) {
        res.status(404).json({ error: "Approval request not found." });
        return;
      }

      if (!resolved.updated) {
        res.status(409).json({ error: `Approval request is already ${resolved.request.status}.` });
        return;
      }

      res.json({ text: `Action ${decision}d for ${resolved.request.code}.` });
    } catch {
      res.status(400).json({ error: "Invalid payload." });
    }
  });

  app.get("/approve", (req, res) => {
    const token = String(req.query.token ?? "");
    const decision = String(req.query.decision ?? "");

    if (!token || (decision !== "allow" && decision !== "deny")) {
      res.status(400).send("Invalid approval link.");
      return;
    }

    const resolved = service.resolvePendingDecision(token, decision, "email");
    if (!resolved.request) {
      res.status(404).send("Approval request not found.");
      return;
    }

    if (!resolved.updated) {
      res.status(409).send(`Approval request is already ${resolved.request.status}.`);
      return;
    }

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Latchkey</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f5f7fb; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { background: white; border-radius: 16px; padding: 2rem 2.5rem; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); text-align: center; }
      h1 { margin: 0 0 0.5rem; font-size: 2rem; }
      p { color: #475569; margin: 0.35rem 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${decision === "allow" ? "Approved" : "Denied"}</h1>
      <p>Request code: <strong>${resolved.request.code}</strong></p>
      <p>You can close this tab.</p>
    </div>
  </body>
</html>`);
  });

  const port = options.port ?? Number(process.env.PORT ?? 3001);
  return app.listen(port, () => {
    console.log(`[Latchkey webhook] running on http://localhost:${port}`);
    console.log(`[Latchkey webhook] DB: ${path.resolve(config.databasePath)}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void startWebhookServer();
}
