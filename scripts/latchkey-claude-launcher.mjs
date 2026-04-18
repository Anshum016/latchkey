import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve repo root relative to this script — no hardcoded paths
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.chdir(repoRoot);

const webhookEntry = path.join(repoRoot, "packages", "webhook", "build", "server.js");
let webhookProcess;

try {
  if (!fs.existsSync(webhookEntry)) {
    throw new Error(`Webhook build not found at ${webhookEntry}. Run npm run build first.`);
  }

  webhookProcess = spawn(process.execPath, [webhookEntry], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  webhookProcess.stdout?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  webhookProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  process.on("exit", () => {
    if (webhookProcess.exitCode === null && !webhookProcess.killed) {
      webhookProcess.kill();
    }
  });

  const { startMcpProxyServer } = await import("../packages/mcp/build/mcp-entry.js");
  await startMcpProxyServer({
    configPath: process.env.LATCHKEY_CONFIG_PATH,
    projectDir: repoRoot
  });
} catch (error) {
  if (webhookProcess && webhookProcess.exitCode === null && !webhookProcess.killed) {
    webhookProcess.kill();
  }

  console.error("[Latchkey launcher] failed to start");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
