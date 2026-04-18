import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DiscoveredMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

export type DiscoverySource = "claude-code" | "claude-desktop" | "none";

export interface DiscoveryResult {
  servers: DiscoveredMcpServer[];
  source: DiscoverySource;
}

// ---------------------------------------------------------------------------
// Path resolution — dynamic, cross-platform, no hardcoded usernames
// ---------------------------------------------------------------------------

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
  filterName = "latchkey"
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
    if (name === filterName) {
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

export function readClaudeCodeMcpServers(): DiscoveredMcpServer[] {
  return readMcpServersFromFile(getClaudeCodeSettingsPath());
}

export function readClaudeDesktopMcpServers(): DiscoveredMcpServer[] {
  return readMcpServersFromFile(getClaudeDesktopConfigPath());
}

// ---------------------------------------------------------------------------
// Discovery with explicit priority: Claude Code first, Desktop as fallback
// ---------------------------------------------------------------------------

export function discoverMcpServers(): DiscoveryResult {
  // Primary: Claude Code user-level config
  const claudeCodeServers = readClaudeCodeMcpServers();
  if (claudeCodeServers.length > 0) {
    return { servers: claudeCodeServers, source: "claude-code" };
  }

  // Fallback: Claude Desktop (for users who haven't migrated or use both)
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
