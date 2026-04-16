import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { getDefaultConfigPath, loadConfig, saveConfig } from "@latchkey/core";
import type {
  DockerUpstreamServerConfig,
  LatchkeyConfig,
  NotificationChannelKind,
  PolicyRule,
  UpstreamServerConfig
} from "@latchkey/core";

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  preferences?: Record<string, unknown>;
}

async function ask(rl: readline.Interface, label: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue ?? "";
}

function parseArgumentList(value: string): string[] {
  const matches = value.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
  return matches.map((match) => {
    if (
      (match.startsWith('"') && match.endsWith('"')) ||
      (match.startsWith("'") && match.endsWith("'"))
    ) {
      return match.slice(1, -1);
    }

    return match;
  });
}

function formatArgumentList(args: string[] | undefined): string {
  if (!args || args.length === 0) {
    return "";
  }

  return args
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

function parseBooleanAnswer(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  return normalized === "y" || normalized === "yes" || normalized === "true";
}

function getChannelPromptValue(channel: NotificationChannelKind): string {
  return channel === "email" ? "gmail" : channel;
}

function normalizeChannelAnswer(answer: string, fallback: NotificationChannelKind): NotificationChannelKind {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "gmail" || normalized === "email") {
    return "email";
  }

  if (normalized === "slack") {
    return "slack";
  }

  return fallback;
}

function getDefaultProtectedUpstream(existingUpstreams: UpstreamServerConfig[], existingRules: PolicyRule[]): string {
  const fromRule = existingRules.find((rule) => rule.upstream)?.upstream;
  if (fromRule) {
    return fromRule;
  }

  return existingUpstreams[0]?.name ?? "";
}

function buildStarterRules(upstreamName: string): PolicyRule[] {
  const scopedRule = upstreamName ? { upstream: upstreamName } : {};
  return [
    {
      tool: "delete_*",
      ...scopedRule,
      approval: "required",
      reason: upstreamName
        ? `${upstreamName} deletes always need approval.`
        : "Delete actions always need approval."
    },
    {
      tool: "write_*",
      ...scopedRule,
      params: [{ path: "path", contains: ".env" }],
      approval: "required",
      reason: upstreamName
        ? `${upstreamName} writes to .env stay human-reviewed.`
        : "Writes to .env stay human-reviewed."
    }
  ];
}

function getClaudeDesktopConfigPath(): string {
  switch (os.platform()) {
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    default:
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

function getCliEntryPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "latchkey.js");
}

function installClaudeDesktopConfig(configPath: string): string {
  const claudeConfigPath = getClaudeDesktopConfigPath();
  const directory = path.dirname(claudeConfigPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const existing = fs.existsSync(claudeConfigPath)
    ? (JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8")) as ClaudeDesktopConfig)
    : {};

  const cliEntryPath = getCliEntryPath();
  if (!fs.existsSync(cliEntryPath)) {
    throw new Error(`Latchkey CLI was not found at ${cliEntryPath}. Run npm run build before installing Claude Desktop config.`);
  }

  const absoluteConfigPath = path.resolve(configPath);
  const mcpServers = existing.mcpServers ?? {};
  mcpServers.latchkey = {
    command: process.execPath,
    args: [cliEntryPath, "--config", absoluteConfigPath, "start"]
  };

  const nextConfig: ClaudeDesktopConfig = {
    ...existing,
    mcpServers
  };

  fs.writeFileSync(claudeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  return claudeConfigPath;
}

async function configurePrimaryUpstream(
  rl: readline.Interface,
  existingUpstreams: UpstreamServerConfig[]
): Promise<UpstreamServerConfig[]> {
  const current = existingUpstreams[0];
  const rest = existingUpstreams.slice(1);
  const defaultMode = current?.transport === "docker" ? "docker" : current ? "stdio" : "skip";
  const requestedMode = (
    await ask(rl, "Primary upstream type (stdio/docker/skip)", defaultMode)
  ).toLowerCase();
  const mode = requestedMode === "docker" || requestedMode === "skip" ? requestedMode : "stdio";

  if (mode === "skip") {
    return existingUpstreams;
  }

  const name = await ask(rl, "Primary upstream name", current?.name ?? "primary");
  const args = parseArgumentList(
    await ask(rl, "Upstream args (space-separated)", formatArgumentList(current?.args))
  );

  if (mode === "docker") {
    const dockerCurrent = current?.transport === "docker" ? current : undefined;
    const image = await ask(rl, "Docker image", dockerCurrent?.image);
    if (!image) {
      throw new Error("Docker image is required for Docker upstreams.");
    }

    const containerCommand = await ask(rl, "Container command (optional)", dockerCurrent?.command);
    const mountWorkspaceDefault = dockerCurrent?.passWorkspace ?? true;
    const mountWorkspace = parseBooleanAnswer(
      await ask(rl, "Mount the current project into the container? (yes/no)", mountWorkspaceDefault ? "yes" : "no"),
      mountWorkspaceDefault
    );
    const workspaceMountPath = mountWorkspace
      ? await ask(rl, "Container workspace path", dockerCurrent?.workspaceMountPath ?? "/workspace")
      : "";
    const containerCwd = await ask(
      rl,
      "Container working directory (optional)",
      dockerCurrent?.containerCwd ?? (mountWorkspace ? workspaceMountPath : "")
    );
    const containerArgs = parseArgumentList(
      await ask(
        rl,
        "Extra docker run args (space-separated)",
        formatArgumentList(dockerCurrent?.containerArgs)
      )
    );

    const dockerUpstream: DockerUpstreamServerConfig = {
      name,
      transport: "docker",
      image,
      args,
      ...(containerCommand ? { command: containerCommand } : {}),
      ...(dockerCurrent?.env ? { env: dockerCurrent.env } : {}),
      ...(containerArgs.length > 0 ? { containerArgs } : {}),
      ...(dockerCurrent?.mounts ? { mounts: dockerCurrent.mounts } : {}),
      ...(containerCwd ? { containerCwd } : {}),
      ...(mountWorkspace ? { passWorkspace: true } : { passWorkspace: false }),
      ...(mountWorkspace && workspaceMountPath ? { workspaceMountPath } : {})
    };

    return [dockerUpstream, ...rest];
  }

  const stdioCurrent = current?.transport === "docker" ? undefined : current;
  const command = await ask(rl, "Upstream command", stdioCurrent?.command);
  if (!command) {
    throw new Error("An upstream command is required for stdio upstreams.");
  }

  const cwd = await ask(rl, "Upstream working directory (optional)", stdioCurrent?.cwd);
  return [
    {
      name,
      transport: "stdio",
      command,
      args,
      ...(stdioCurrent?.env ? { env: stdioCurrent.env } : {}),
      ...(cwd ? { cwd } : {})
    },
    ...rest
  ];
}

export async function runSetup(configPath = getDefaultConfigPath()): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log("\nLatchkey Init\n");
    console.log(`Config file: ${configPath}\n`);

    const existing = loadConfig(configPath);
    const channel = normalizeChannelAnswer(
      await ask(rl, "Notification channel (slack/gmail)", getChannelPromptValue(existing.channel)),
      existing.channel
    );
    const upstreamServers = await configurePrimaryUpstream(rl, existing.upstreamServers);
    const defaultProtectedUpstream = getDefaultProtectedUpstream(upstreamServers, existing.rules);
    const protectedUpstream = await ask(
      rl,
      "Starter protection upstream name",
      defaultProtectedUpstream || upstreamServers[0]?.name
    );
    const timeoutMs =
      Number(await ask(rl, "Approval timeout in milliseconds", String(existing.timeoutMs))) || existing.timeoutMs;
    const installClaude = parseBooleanAnswer(
      await ask(rl, "Auto-install Claude Desktop MCP config? (yes/no)", "yes"),
      true
    );

    const updates: Partial<LatchkeyConfig> = {
      channel,
      webhookBaseUrl: existing.webhookBaseUrl,
      timeoutMs,
      databasePath: existing.databasePath,
      toolNameMode: existing.toolNameMode,
      upstreamServers,
      rules: buildStarterRules(protectedUpstream.trim())
    };

    if (channel === "slack") {
      updates.slackWebhookUrl = await ask(rl, "Slack Incoming Webhook URL", existing.slackWebhookUrl);
      updates.resendApiKey = undefined;
      updates.userEmail = undefined;
      updates.emailFrom = undefined;
    } else {
      updates.userEmail = await ask(rl, "Gmail address for approvals", existing.userEmail);
      updates.resendApiKey = await ask(rl, "Resend API key", existing.resendApiKey);
      updates.emailFrom = await ask(
        rl,
        "Email sender (use onboarding@resend.dev or a verified domain sender)",
        existing.emailFrom ?? "Latchkey <onboarding@resend.dev>"
      );
      updates.slackWebhookUrl = undefined;
    }

    const saved = saveConfig(updates, configPath);
    const claudeConfigPath = installClaude ? installClaudeDesktopConfig(configPath) : null;

    console.log("\nSaved configuration:");
    console.log(`  channel: ${saved.channel === "email" ? "gmail" : saved.channel}`);
    console.log(`  webhookBaseUrl: ${saved.webhookBaseUrl}`);
    console.log(`  databasePath: ${saved.databasePath}`);
    console.log(`  upstreams: ${saved.upstreamServers.length}`);
    console.log(`  starter rules: ${saved.rules.length}`);

    if (claudeConfigPath) {
      console.log(`  Claude Desktop config: ${claudeConfigPath}`);
    }

    console.log("\nNext steps:");
    if (claudeConfigPath) {
      console.log("  1. Restart Claude Desktop so it picks up the new Latchkey MCP server.");
    } else {
      console.log('  1. Register Latchkey in Claude Desktop using the "start" command.');
    }
    console.log("  2. Use `latchkey start` if you want to run the proxy and webhook together yourself.");
    console.log('  3. Optionally tell the agent to call "latchkey_set_task" at the start of each session.');
    console.log("  4. Use `latchkey approve <code> <allow|deny>` any time you need a CLI fallback.");
  } finally {
    rl.close();
  }
}
