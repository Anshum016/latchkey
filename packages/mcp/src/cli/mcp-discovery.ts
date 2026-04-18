import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DiscoveredMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

export type DiscoverySource = "claude-code-project" | "claude-code" | "claude-desktop" | "none";

export interface DiscoveryResult {
  servers: DiscoveredMcpServer[];
  source: DiscoverySource;
}

// Names that must never be wrapped (would cause recursive proxying)
const FILTER_NAMES = ["latchkey", "latchkey-proxy"];

// ---------------------------------------------------------------------------
// Path resolution — dynamic, cross-platform, no hardcoded usernames
// ---------------------------------------------------------------------------

export function getClaudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

export function getClaudeCodeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function getClaudeDesktopConfigPath(): string {
  switch (os.platform()) {
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    default:
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

// ---------------------------------------------------------------------------
// File reading — separated from path resolution, resilient to all error cases
// ---------------------------------------------------------------------------

/**
 * Reads MCP server entries from any settings/config JSON file.
 * Exported so tests can call it with arbitrary temp-file paths.
 * Returns [] gracefully for: missing file, invalid JSON, missing mcpServers,
 * malformed entries, or permission errors.
 */
export function readMcpServersFromFile(
  filePath: string,
  filterNames: string[] = FILTER_NAMES
): DiscoveredMcpServer[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.warn(`  Warning: ${filePath} contains invalid JSON — skipping MCP server discovery from this source.`);
    return [];
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const mcpServers = record.mcpServers;

  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }

  const servers: DiscoveredMcpServer[] = [];
  for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (filterNames.includes(name)) {
      continue;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      continue;
    }

    const entry = cfg as Record<string, unknown>;
    const command = typeof entry.command === "string" ? entry.command : null;
    if (!command) {
      continue;
    }

    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];

    const rawEnv = entry.env;
    const env =
      rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
        ? (rawEnv as Record<string, string>)
        : undefined;

    servers.push({ name, command, args, ...(env ? { env } : {}) });
  }

  return servers;
}

// Normalise path separators and case for cross-platform key matching
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Reads MCP servers for a specific project from ~/.claude.json.
 * Exported so tests can inject an arbitrary file path and project dir.
 * Returns [] for: missing file, invalid JSON, project not found, malformed entries.
 */
export function readMcpServersFromClaudeJson(
  filePath: string,
  projectDir: string
): DiscoveredMcpServer[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.warn(`  Warning: ${filePath} contains invalid JSON — skipping project MCP server discovery.`);
    return [];
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const projects = record.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    return [];
  }

  const projectsMap = projects as Record<string, unknown>;
  const normalizedTarget = normalizePath(projectDir);

  // Match project key regardless of whether slashes are \ or /
  const matchingKey = Object.keys(projectsMap).find(
    (key) => normalizePath(key) === normalizedTarget
  );

  if (!matchingKey) {
    return [];
  }

  const projectConfig = projectsMap[matchingKey];
  if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
    return [];
  }

  const projectRecord = projectConfig as Record<string, unknown>;
  const mcpServers = projectRecord.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }

  const servers: DiscoveredMcpServer[] = [];
  for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (FILTER_NAMES.includes(name)) {
      continue;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      continue;
    }

    const entry = cfg as Record<string, unknown>;
    const command = typeof entry.command === "string" ? entry.command : null;
    if (!command) {
      continue;
    }

    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];

    const rawEnv = entry.env;
    const env =
      rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
        ? (rawEnv as Record<string, string>)
        : undefined;

    servers.push({ name, command, args, ...(env ? { env } : {}) });
  }

  return servers;
}

export function discoverClaudeCodeProjectServers(projectDir?: string): DiscoveredMcpServer[] {
  return readMcpServersFromClaudeJson(getClaudeJsonPath(), projectDir ?? process.cwd());
}

export function readClaudeCodeMcpServers(): DiscoveredMcpServer[] {
  return readMcpServersFromFile(getClaudeCodeSettingsPath());
}

export function readClaudeDesktopMcpServers(): DiscoveredMcpServer[] {
  return readMcpServersFromFile(getClaudeDesktopConfigPath());
}

// ---------------------------------------------------------------------------
// Discovery with explicit priority
// ---------------------------------------------------------------------------

export function discoverMcpServers(): DiscoveryResult {
  // 1. Claude Code project-level config (~/.claude.json → projects[cwd].mcpServers)
  const projectServers = discoverClaudeCodeProjectServers();
  if (projectServers.length > 0) {
    return { servers: projectServers, source: "claude-code-project" };
  }

  // 2. Claude Code user-level config (~/.claude/settings.json)
  const claudeCodeServers = readClaudeCodeMcpServers();
  if (claudeCodeServers.length > 0) {
    return { servers: claudeCodeServers, source: "claude-code" };
  }

  // 3. Claude Desktop (fallback for users who haven't migrated or use both)
  const claudeDesktopServers = readClaudeDesktopMcpServers();
  if (claudeDesktopServers.length > 0) {
    return { servers: claudeDesktopServers, source: "claude-desktop" };
  }

  return { servers: [], source: "none" };
}

// ---------------------------------------------------------------------------
// Removal helpers — write back to the correct config after wrapping
// ---------------------------------------------------------------------------

function removeServersFromConfigFile(filePath: string, names: string[]): void {
  if (!fs.existsSync(filePath) || names.length === 0) {
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const mcpServers = { ...((raw.mcpServers as Record<string, unknown>) ?? {}) };
    for (const name of names) {
      delete mcpServers[name];
    }
    fs.writeFileSync(filePath, `${JSON.stringify({ ...raw, mcpServers }, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `  Warning: could not update ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function removeServersFromClaudeCodeConfig(names: string[]): void {
  removeServersFromConfigFile(getClaudeCodeSettingsPath(), names);
}

export function removeServersFromClaudeDesktopConfig(names: string[]): void {
  removeServersFromConfigFile(getClaudeDesktopConfigPath(), names);
}

export function removeServersFromClaudeCodeProjectConfig(
  names: string[],
  projectDir?: string
): void {
  const filePath = getClaudeJsonPath();
  if (!fs.existsSync(filePath) || names.length === 0) {
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const projects = raw.projects as Record<string, unknown> | undefined;
    if (!projects) {
      return;
    }

    const normalizedTarget = normalizePath(projectDir ?? process.cwd());
    const matchingKey = Object.keys(projects).find(
      (key) => normalizePath(key) === normalizedTarget
    );
    if (!matchingKey) {
      return;
    }

    const projectConfig = projects[matchingKey] as Record<string, unknown> | undefined;
    if (!projectConfig) {
      return;
    }

    const mcpServers = { ...((projectConfig.mcpServers as Record<string, unknown>) ?? {}) };
    for (const name of names) {
      delete mcpServers[name];
    }

    const updated = {
      ...raw,
      projects: {
        ...projects,
        [matchingKey]: { ...projectConfig, mcpServers }
      }
    };
    fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `  Warning: could not update ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
