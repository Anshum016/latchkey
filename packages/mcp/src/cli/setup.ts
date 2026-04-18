import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDefaultConfigPath, loadConfig, saveConfig } from "@latchkey/core";
import type {
  DockerUpstreamServerConfig,
  LatchkeyConfig,
  NotificationChannelKind,
  PolicyRule,
  UpstreamServerConfig
} from "@latchkey/core";
import {
  type DiscoveredMcpServer,
  type DiscoverySource,
  discoverMcpServers,
  getClaudeCodeSettingsPath,
  getClaudeDesktopConfigPath,
  removeServersFromClaudeCodeConfig,
  removeServersFromClaudeDesktopConfig
} from "./mcp-discovery.js";

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  preferences?: Record<string, unknown>;
}

interface ClaudeCodeSettings {
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
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

function discoveredToUpstream(server: DiscoveredMcpServer): UpstreamServerConfig {
  return {
    name: server.name,
    transport: "stdio",
    command: server.command,
    args: server.args,
    ...(server.env ? { env: server.env } : {})
  };
}

function formatCommandPreview(command: string, args: string[]): string {
  const full = [command, ...args].join(" ");
  return full.length > 64 ? `${full.slice(0, 61)}…` : full;
}


async function configureUpstreams(
  rl: readline.Interface,
  existing: UpstreamServerConfig[],
  discovered: DiscoveredMcpServer[],
  discoverySource: DiscoverySource
): Promise<{ upstreams: UpstreamServerConfig[]; removeFromSource: string[] }> {
  const sourceName =
    discoverySource === "claude-code" ? "Claude Code" : "Claude Desktop";

  if (discovered.length === 0) {
    if (existing.length === 0) {
      console.log("\nNo MCP servers found in Claude Code or Claude Desktop. Configuring manually.");
    }
    return { upstreams: await configurePrimaryUpstream(rl, existing), removeFromSource: [] };
  }

  const existingNames = new Set(existing.map((u) => u.name));
  console.log(`\nDiscovered ${discovered.length} MCP server(s) in ${sourceName}:`);
  discovered.forEach((server, i) => {
    const tag = existingNames.has(server.name) ? " (already wrapped)" : "";
    console.log(
      `  [${i + 1}] ${server.name.padEnd(18)} ${formatCommandPreview(server.command, server.args)}${tag}`
    );
  });
  console.log(`  [m] Configure manually instead`);

  const defaultAnswer = existing.length > 0 ? "skip" : "all";
  const answer = (
    await ask(rl, `Wrap which servers? (e.g. 1,2 or "all" or "skip" or "m")`, defaultAnswer)
  ).trim().toLowerCase();

  if (answer === "m" || answer === "manual") {
    return { upstreams: await configurePrimaryUpstream(rl, existing), removeFromSource: [] };
  }

  if (answer === "skip") {
    return { upstreams: existing, removeFromSource: [] };
  }

  let selected: DiscoveredMcpServer[];
  if (answer === "all") {
    selected = discovered;
  } else {
    const indices = answer
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < discovered.length);
    selected = indices.flatMap((i) => (discovered[i] ? [discovered[i] as DiscoveredMcpServer] : []));
  }

  if (selected.length === 0) {
    console.log("No valid selection — configuring manually.");
    return { upstreams: await configurePrimaryUpstream(rl, existing), removeFromSource: [] };
  }

  const upstreams = selected.map(discoveredToUpstream);

  const shouldRemove = parseBooleanAnswer(
    await ask(
      rl,
      `Remove selected servers from ${sourceName} to prevent direct bypasses? (yes/no)`,
      "yes"
    ),
    true
  );

  return {
    upstreams,
    removeFromSource: shouldRemove ? selected.map((s) => s.name) : []
  };
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


function installClaudeCodeConfig(configPath: string): string {
  const settingsPath = getClaudeCodeSettingsPath();
  const directory = path.dirname(settingsPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const existing: ClaudeCodeSettings = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as ClaudeCodeSettings)
    : {};

  const absoluteConfigPath = path.resolve(configPath);
  const mcpServers = existing.mcpServers ?? {};
  mcpServers.latchkey = {
    command: "latchkey-proxy",
    args: ["--config", absoluteConfigPath, "start"]
  };

  const nextConfig: ClaudeCodeSettings = { ...existing, mcpServers };
  fs.writeFileSync(settingsPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  return settingsPath;
}

function installClaudeDesktopConfig(configPath: string): string {
  const claudeConfigPath = getClaudeDesktopConfigPath(); // from mcp-discovery
  const directory = path.dirname(claudeConfigPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const existing = fs.existsSync(claudeConfigPath)
    ? (JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8")) as ClaudeDesktopConfig)
    : {};

  const absoluteConfigPath = path.resolve(configPath);
  const mcpServers = existing.mcpServers ?? {};
  mcpServers.latchkey = {
    command: "latchkey-proxy",
    args: ["--config", absoluteConfigPath, "start"]
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

    // Step 1: Anthropic API key
    const apiKey = (
      await ask(rl, "Enter your Anthropic API key (used for AI risk evaluation)", existing.ai.apiKey)
    ).trim();
    if (!apiKey) {
      throw new Error("Anthropic API key is required.");
    }

    // Step 2: Notification channel
    const channel = normalizeChannelAnswer(
      await ask(rl, "Notification channel (slack/gmail)", getChannelPromptValue(existing.channel)),
      existing.channel
    );

    // Claude Code is the primary source; Claude Desktop is the fallback
    const { servers: discovered, source: discoverySource } = discoverMcpServers();
    const { upstreams: upstreamServers, removeFromSource } = await configureUpstreams(
      rl,
      existing.upstreamServers,
      discovered,
      discoverySource
    );

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

    const installClaudeCode = parseBooleanAnswer(
      await ask(rl, "Auto-install Claude Code MCP config? (yes/no)", "yes"),
      true
    );

    const updates: Partial<LatchkeyConfig> = {
      channel,
      webhookBaseUrl: existing.webhookBaseUrl,
      timeoutMs,
      databasePath: existing.databasePath,
      toolNameMode: existing.toolNameMode,
      upstreamServers,
      rules: buildStarterRules(protectedUpstream.trim()),
      ai: { apiKey, model: existing.ai.model, timeoutMs: existing.ai.timeoutMs }
    };

    if (channel === "slack") {
      updates.slackWebhookUrl = await ask(rl, "Slack Incoming Webhook URL", existing.slackWebhookUrl);
      const signingSecret = await ask(
        rl,
        "Slack Signing Secret (optional, press Enter to skip)",
        existing.slackSigningSecret
      );
      updates.slackSigningSecret = signingSecret.trim() || undefined;
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
      updates.slackSigningSecret = undefined;
    }

    const saved = saveConfig(updates, configPath);
    const claudeConfigPath = installClaude ? installClaudeDesktopConfig(configPath) : null;
    const claudeCodeConfigPath = installClaudeCode ? installClaudeCodeConfig(configPath) : null;

    if (removeFromSource.length > 0) {
      if (discoverySource === "claude-code") {
        removeServersFromClaudeCodeConfig(removeFromSource);
      } else if (discoverySource === "claude-desktop") {
        removeServersFromClaudeDesktopConfig(removeFromSource);
      }
    }

    console.log("\nSaved configuration:");
    console.log(`  channel: ${saved.channel === "email" ? "gmail" : saved.channel}`);
    console.log(`  webhookBaseUrl: ${saved.webhookBaseUrl}`);
    console.log(`  databasePath: ${saved.databasePath}`);
    console.log(`  upstreams: ${saved.upstreamServers.length} (${saved.upstreamServers.map((u) => u.name).join(", ") || "none"})`);
    console.log(`  starter rules: ${saved.rules.length}`);

    if (claudeConfigPath) {
      console.log(`  Claude Desktop config: ${claudeConfigPath}`);
    }

    if (claudeCodeConfigPath) {
      console.log(`  Claude Code config:    ${claudeCodeConfigPath}`);
    }

    if (removeFromSource.length > 0) {
      const sourceLabel = discoverySource === "claude-code" ? "Claude Code" : "Claude Desktop";
      console.log(`  Removed from ${sourceLabel}: ${removeFromSource.join(", ")}`);
    }

    console.log("\nNext steps:");
    if (claudeConfigPath) {
      console.log("  1. Restart Claude Desktop so it picks up the new Latchkey MCP server.");
    } else {
      console.log('  1. Register Latchkey in Claude Desktop using the "start" command.');
    }
    if (claudeCodeConfigPath) {
      console.log("     Claude Code picks up the MCP config automatically — no restart needed.");
    }
    console.log("  2. Use `latchkey start` if you want to run the proxy and webhook together yourself.");
    console.log('  3. Optionally tell the agent to call "latchkey_set_task" at the start of each session.');
    console.log("  4. Use `latchkey approve <code> <allow|deny>` any time you need a CLI fallback.");
    console.log("  5. Use `latchkey score <tool-name>` to preview risk scores before going live.");
  } finally {
    rl.close();
  }
}
