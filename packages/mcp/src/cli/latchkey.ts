#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _require = createRequire(import.meta.url);
import {
  AIClassifier,
  ApprovalService,
  NotificationService,
  RiskEngine,
  SQLiteApprovalStore,
  assertAIConfigured,
  loadConfig,
  loadSecurityRules
} from "@latchkey/core";
import type { NotificationChannel, NotificationDispatchPayload } from "@latchkey/core";
import { startMcpProxyServer } from "../mcp-entry.js";
import { runSetup } from "./setup.js";

class NullNotificationChannel implements NotificationChannel {
  public readonly kind = "email" as const;

  public async sendApprovalRequest(_payload: NotificationDispatchPayload): Promise<void> {}

  public async sendAutoBlocked(_payload: NotificationDispatchPayload): Promise<void> {}
}

function printUsage(): void {
  console.log(`Latchkey

Usage:
  latchkey [--config ./latchkey.yaml] start
  latchkey [--config ./latchkey.yaml] serve
  latchkey [--config ./latchkey.yaml] init
  latchkey [--config ./latchkey.yaml] setup
  latchkey [--config ./latchkey.yaml] doctor
  latchkey [--config ./latchkey.yaml] validate
  latchkey [--config ./latchkey.yaml] status
  latchkey [--config ./latchkey.yaml] approve <token-or-code> <allow|deny>
  latchkey score <tool-name> [--params '{"key":"value"}']`);
}

async function runScore(commandArgs: string[], configPath: string | undefined): Promise<void> {
  let toolName = "";
  let paramsJson: string | undefined;

  for (let i = 0; i < commandArgs.length; i += 1) {
    const arg = commandArgs[i];
    if (!arg) {
      continue;
    }

    if (arg === "--params") {
      paramsJson = commandArgs[i + 1];
      i += 1;
    } else if (!toolName && !arg.startsWith("--")) {
      toolName = arg;
    }
  }

  if (!toolName) {
    throw new Error("Usage: latchkey score <tool-name> [--params '{...}']");
  }

  let params: Record<string, unknown> = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid JSON for --params: ${paramsJson}`);
    }
  }

  const config = loadConfig(configPath);
  assertAIConfigured(config);

  const aiClassifier = new AIClassifier({
    apiKey: config.ai.apiKey!,
    model: config.ai.model,
    timeoutMs: config.ai.timeoutMs
  });
  const rules = loadSecurityRules(process.cwd());
  const engine = new RiskEngine(rules, aiClassifier);
  const result = await engine.score({ toolName, payload: params });

  const heuristic = result.heuristic;
  const ai = result.ai;

  const C1 = 22;
  const C2 = 7;
  const C3 = 5;

  if (heuristic) {
    console.log(`\nHeuristic:`);
    console.log(`  Score: ${heuristic.score}/100 (${heuristic.tier})`);
    console.log(
      `\n  ${"Dimension".padEnd(C1)} ${"Score".padEnd(C2)} ${"Max".padEnd(C3)} Reason`
    );
    console.log(`  ${"─".repeat(C1)} ${"─".repeat(C2)} ${"─".repeat(C3)} ${"─".repeat(42)}`);
    for (const dim of heuristic.dimensions) {
      console.log(
        `  ${dim.dimension.padEnd(C1)} ${String(dim.score).padEnd(C2)} ${String(dim.max).padEnd(C3)} ${dim.reason}`
      );
    }
  }

  if (ai) {
    const bonusNote =
      heuristic && heuristic.score >= 50 && ai.score >= 50 ? " (agreement bonus applied)" : "";
    const aiOverrideNote = heuristic && heuristic.score < 30 && ai.score > 60 ? " (AI override)" : "";

    console.log(`\nAI Classifier:`);
    console.log(`  Score: ${ai.score}/100`);
    console.log(`  Agreement: ${ai.agreement}`);
    console.log(`  Concern: ${ai.primary_concern}`);
    console.log(`  Reasoning: ${ai.reasoning}`);
    console.log(`  Latency: ${ai.latency_ms}ms`);
    console.log(`  Tokens: ${ai.input_tokens} in / ${ai.output_tokens} out`);

    const fusionNote = result.fusionStrategy
      ? ` (${result.fusionStrategy}${bonusNote}${aiOverrideNote})`
      : "";
    console.log(`\nFinal:`);
    console.log(`  Score: ${result.score}/100 (${result.level})`);
    console.log(`  Action: ${result.action}`);
    console.log(`  Fusion:${fusionNote}`);
  } else {
    console.log(`\nFinal Score: ${result.score}/100 (${result.level})`);
    console.log(`Action:      ${result.action}`);
  }

  console.log();
}

function getWebhookEntryPath(): string {
  // Bundled install: webhook.js lives alongside latchkey.js in bin/
  const siblingPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "webhook.js");
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }
  // Monorepo dev: resolve via workspace symlink in node_modules
  try {
    const webhookMain = _require.resolve("@latchkey/webhook");
    return path.join(path.dirname(webhookMain), "server.js");
  } catch {
    throw new Error(
      "@latchkey/webhook could not be found. Ensure @latchkey/mcp is installed correctly (try: npm install)."
    );
  }
}

function startWebhookProcess(configPath?: string) {
  const webhookEntryPath = getWebhookEntryPath();
  if (!fs.existsSync(webhookEntryPath)) {
    throw new Error(`Latchkey webhook build was not found at ${webhookEntryPath}. Run npm run build first.`);
  }

  const child = spawn(process.execPath, [webhookEntryPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(configPath ? { LATCHKEY_CONFIG_PATH: path.resolve(configPath) } : {})
    }
  });

  child.stdout?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  process.on("exit", () => {
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  });

  return child;
}

async function runStart(configPath?: string): Promise<void> {
  const webhookProcess = startWebhookProcess(configPath);

  try {
    await startMcpProxyServer(configPath ? { configPath } : {});
  } catch (error) {
    if (webhookProcess.exitCode === null && !webhookProcess.killed) {
      webhookProcess.kill();
    }
    throw error;
  }
}

async function runStatus(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  const store = new SQLiteApprovalStore(config.databasePath);
  store.init();

  const pending = store.listPendingRequests();
  if (pending.length === 0) {
    console.log("No pending approvals.");
    store.close();
    return;
  }

  console.log(`\n${pending.length} pending approval(s):\n`);
  for (const request of pending) {
    const ageSeconds = Math.round((Date.now() - request.createdAt) / 1000);
    console.log(
      `${request.code.padEnd(8)}  ${request.toolName.padEnd(24)} risk=${String(request.riskScore).padEnd(3)} age=${ageSeconds}s token=${request.token.slice(0, 8)}`
    );
  }
  console.log();
  store.close();
}

async function runApprove(identifier: string, decision: string, configPath?: string): Promise<void> {
  if (decision !== "allow" && decision !== "deny") {
    throw new Error("Decision must be either 'allow' or 'deny'.");
  }

  const config = loadConfig(configPath);
  const store = new SQLiteApprovalStore(config.databasePath);
  store.init();
  const service = new ApprovalService(store, new NotificationService(new NullNotificationChannel()), config);
  const resolved = service.resolvePendingDecision(identifier, decision, "cli");
  store.close();

  if (!resolved.request) {
    throw new Error(`No pending approval found for "${identifier}".`);
  }

  if (!resolved.updated) {
    throw new Error(`Approval request "${resolved.request.code}" is already ${resolved.request.status}.`);
  }

  console.log(`Resolved ${resolved.request.code} -> ${decision}.`);
}

async function runDoctor(configPath?: string): Promise<void> {
  console.log("\nLatchkey Doctor\n");
  let allGood = true;

  function pass(msg: string): void { console.log(`✓ ${msg}`); }
  function fail(msg: string, hint: string): void {
    console.log(`✗ ${msg}\n  → ${hint}`);
    allGood = false;
  }

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(configPath);
    pass("Config loaded");
  } catch (error) {
    fail("Config could not be loaded", "Run: latchkey init");
    console.log("\nRun `latchkey init` to create a configuration.\n");
    process.exitCode = 1;
    return;
  }

  if (config.ai.apiKey?.trim()) {
    pass("Anthropic API key configured");
  } else {
    fail("Anthropic API key not configured", "Run: latchkey init  (or set ANTHROPIC_API_KEY env var)");
  }

  const channelOk =
    (config.channel === "slack" && !!config.slackWebhookUrl) ||
    (config.channel === "email" && !!config.userEmail && !!config.resendApiKey);
  if (channelOk) {
    pass(`Notification channel: ${config.channel}`);
  } else {
    fail(
      `Notification channel not fully configured (${config.channel})`,
      "Run: latchkey init to complete notification setup"
    );
  }

  if (config.upstreamServers.length > 0) {
    pass(`Upstream servers: ${config.upstreamServers.map((u) => u.name).join(", ")}`);
  } else {
    fail("No upstream MCP servers configured", "Run: latchkey init to add an MCP server to proxy");
  }

  console.log();
  if (allGood) {
    console.log("All checks passed — run `latchkey start` to launch the proxy.\n");
  } else {
    console.log("Some checks failed — run `latchkey init` to fix them.\n");
    process.exitCode = 1;
  }
}

async function runValidate(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);
  console.log("Latchkey config is valid.");
  console.log(`  channel: ${config.channel}`);
  console.log(`  toolNameMode: ${config.toolNameMode}`);
  console.log(`  upstreams: ${config.upstreamServers.length}`);
  console.log(`  rules: ${config.rules.length}`);
  console.log(`  webhookBaseUrl: ${config.webhookBaseUrl}`);
  console.log(`  databasePath: ${config.databasePath}`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  let configPath: string | undefined;
  const args: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index];
    if (!current) {
      continue;
    }

    if (current === "--config") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("Usage: latchkey --config <path> <command>");
      }

      configPath = value;
      index += 1;
      continue;
    }

    args.push(current);
  }

  const [command, ...commandArgs] = args;

  try {
    switch (command) {
      case "start":
        await runStart(configPath);
        return;
      case "serve":
        await startMcpProxyServer(configPath ? { configPath } : {});
        return;
      case "init":
      case "setup":
        await runSetup(configPath);
        return;
      case "doctor":
        await runDoctor(configPath);
        return;
      case "validate":
        await runValidate(configPath);
        return;
      case "status":
        await runStatus(configPath);
        return;
      case "approve":
        if (commandArgs.length !== 2) {
          throw new Error("Usage: latchkey approve <token-or-code> <allow|deny>");
        }
        if (!commandArgs[0] || !commandArgs[1]) {
          throw new Error("Usage: latchkey approve <token-or-code> <allow|deny>");
        }
        await runApprove(commandArgs[0], commandArgs[1], configPath);
        return;
      case "score":
        await runScore(commandArgs, configPath);
        return;
      default:
        printUsage();
        if (command) {
          process.exitCode = 1;
        }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
