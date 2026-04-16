import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "packages", "mcp", "build", "cli", "latchkey.js");
const configPath = path.join(repoRoot, "email-test.yaml");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it first in PowerShell, for example: $env:${name}="value"`
    );
  }

  return value;
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found at ${targetPath}. Run npm run build first.`);
  }
}

async function main() {
  requireEnv("LATCHKEY_RESEND_API_KEY");
  requireEnv("LATCHKEY_USER_EMAIL");

  if (!process.env.LATCHKEY_EMAIL_FROM) {
    process.env.LATCHKEY_EMAIL_FROM = "Latchkey <onboarding@resend.dev>";
  }

  assertExists(cliPath, "Latchkey CLI");
  assertExists(configPath, "Email test config");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--config", configPath, "start"],
    cwd: repoRoot,
    env: process.env,
    stderr: "pipe"
  });

  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const client = new Client({ name: "email-approval-test", version: "0.1.0" });

  try {
    await client.connect(transport);

    await client.callTool({
      name: "latchkey_set_task",
      arguments: {
        task: "review inbox only"
      }
    });

    console.log(`Sending approval email to ${process.env.LATCHKEY_USER_EMAIL}.`);
    console.log("Open the email on this machine and click Allow.");
    console.log("The command will stay open until the approval arrives or times out.");

    const result = await client.callTool({
      name: "send_email",
      arguments: {
        to: "dev@example.com",
        subject: "Latchkey approval test",
        body: "If you approved this, the protected tool executed."
      }
    }, undefined, { timeout: 300000 });

    const message = result.content?.find((item) => item.type === "text")?.text ?? JSON.stringify(result);
    console.log("\nTool completed:");
    console.log(message);
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
