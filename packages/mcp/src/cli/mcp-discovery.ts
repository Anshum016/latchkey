import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DiscoveredMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

// Names that must never be wrapped — would cause recursive proxying
const FILTER_NAMES = ["latchkey", "latchkey-proxy"];

// ---------------------------------------------------------------------------
// Path helpers (used by setup.ts install functions, not for auto-discovery)
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
// Shared entry extraction (used by both flat and nested readers)
// ---------------------------------------------------------------------------

function extractServers(mcpServers: Record<string, unknown>): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];

  for (const [name, cfg] of Object.entries(mcpServers)) {
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

// ---------------------------------------------------------------------------
// Flat reader — { mcpServers: { ... } }
// Exported so tests can call it with arbitrary temp-file paths.
// ---------------------------------------------------------------------------

export function readMcpServersFromFile(filePath: string): DiscoveredMcpServer[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.warn(`  Warning: ${filePath} contains invalid JSON — skipping.`);
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

  return extractServers(mcpServers as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Nested reader — { projects: { "<path>": { mcpServers: { ... } } } }
// Exported so tests can call it with arbitrary temp-file paths.
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

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

  // Match regardless of whether keys use \ or /
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

  const mcpServers = (projectConfig as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return [];
  }

  return extractServers(mcpServers as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Smart reader — resolves ~ and auto-detects flat vs nested format.
// This is what the setup wizard calls with the user-provided path.
// ---------------------------------------------------------------------------

export function readMcpServersFromConfig(filePath: string): DiscoveredMcpServer[] {
  const resolved = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch {
    console.warn(`  Warning: ${resolved} contains invalid JSON.`);
    return [];
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }

  const record = raw as Record<string, unknown>;

  // ~/.claude.json style — has a "projects" key, not top-level "mcpServers"
  if ("projects" in record) {
    // Try the current working directory first
    const cwdServers = readMcpServersFromClaudeJson(resolved, process.cwd());
    if (cwdServers.length > 0) {
      return cwdServers;
    }

    // cwd didn't match any project key — collect from all projects (dedup by name)
    const projects = record.projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
      return [];
    }
    const seen = new Set<string>();
    const all: DiscoveredMcpServer[] = [];
    for (const projectConfig of Object.values(projects as Record<string, unknown>)) {
      if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
        continue;
      }
      const mcpServers = (projectConfig as Record<string, unknown>).mcpServers;
      if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
        continue;
      }
      for (const server of extractServers(mcpServers as Record<string, unknown>)) {
        if (!seen.has(server.name)) {
          seen.add(server.name);
          all.push(server);
        }
      }
    }
    return all;
  }

  // Flat style — settings.json, claude_desktop_config.json, .mcp.json
  return readMcpServersFromFile(resolved);
}

// ---------------------------------------------------------------------------
// Removal helpers — write back to the config file after wrapping
// ---------------------------------------------------------------------------

export function removeServersFromFile(filePath: string, names: string[]): void {
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

export function removeServersFromClaudeJson(
  filePath: string,
  names: string[],
  projectDir?: string
): void {
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
      projects: { ...projects, [matchingKey]: { ...projectConfig, mcpServers } }
    };
    fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn(
      `  Warning: could not update ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Removes servers from a user-provided config file.
 * Detects flat vs nested format automatically.
 */
export function removeServersFromConfig(filePath: string, names: string[]): void {
  if (!fs.existsSync(filePath) || names.length === 0) {
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  if ("projects" in (raw as Record<string, unknown>)) {
    removeServersFromClaudeJson(filePath, names);
  } else {
    removeServersFromFile(filePath, names);
  }
}
