#!/usr/bin/env node
import { ApprovalService, NotificationService, SQLiteApprovalStore, loadConfig } from "@latchkey/core";
import { startMcpProxyServer } from "../mcp-entry.js";
import { runSetup } from "./setup.js";
class NullNotificationChannel {
    kind = "email";
    async sendApprovalRequest(_payload) { }
    async sendAutoBlocked(_payload) { }
}
function printUsage() {
    console.log(`Latchkey

Usage:
  latchkey [--config ./latchkey.yaml] serve
  latchkey [--config ./latchkey.yaml] setup
  latchkey [--config ./latchkey.yaml] validate
  latchkey [--config ./latchkey.yaml] status
  latchkey [--config ./latchkey.yaml] approve <token-or-code> <allow|deny>`);
}
async function runStatus(configPath) {
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
        console.log(`${request.code.padEnd(8)}  ${request.toolName.padEnd(24)} risk=${String(request.riskScore).padEnd(3)} age=${ageSeconds}s token=${request.token.slice(0, 8)}`);
    }
    console.log();
    store.close();
}
async function runApprove(identifier, decision, configPath) {
    if (decision !== "allow" && decision !== "deny") {
        throw new Error("Decision must be either 'allow' or 'deny'.");
    }
    const config = loadConfig(configPath);
    const store = new SQLiteApprovalStore(config.databasePath);
    store.init();
    const service = new ApprovalService(store, new NotificationService(new NullNotificationChannel()), config);
    const resolved = service.resolvePendingDecision(identifier, decision, "cli");
    store.close();
    if (!resolved) {
        throw new Error(`No pending approval found for "${identifier}".`);
    }
    console.log(`Resolved ${resolved.code} -> ${decision}.`);
}
async function runValidate(configPath) {
    const config = loadConfig(configPath);
    console.log("Latchkey config is valid.");
    console.log(`  channel: ${config.channel}`);
    console.log(`  toolNameMode: ${config.toolNameMode}`);
    console.log(`  upstreams: ${config.upstreamServers.length}`);
    console.log(`  rules: ${config.rules.length}`);
    console.log(`  webhookBaseUrl: ${config.webhookBaseUrl}`);
    console.log(`  databasePath: ${config.databasePath}`);
}
async function main() {
    const rawArgs = process.argv.slice(2);
    let configPath;
    const args = [];
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
            case "serve":
                await startMcpProxyServer(configPath ? { configPath } : {});
                return;
            case "setup":
                await runSetup(configPath);
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
            default:
                printUsage();
                if (command) {
                    process.exitCode = 1;
                }
        }
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
void main();
