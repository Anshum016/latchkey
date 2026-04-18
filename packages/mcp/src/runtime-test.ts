import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jsonSchemaToZodShape } from "./runtime/json-schema.js";
import { RiskEngine } from "@latchkey/core";
import { buildDockerRunArgs, buildUpstreamTransportConfig } from "./runtime/upstream.js";
import {
  getClaudeCodeSettingsPath,
  getClaudeDesktopConfigPath,
  readMcpServersFromFile,
  discoverMcpServers
} from "./cli/mcp-discovery.js";

async function run(): Promise<void> {
  let passed = 0;

  function test(name: string, fn: () => void): void {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  }

  test("jsonSchemaToZodShape preserves required and optional fields", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        permanent: { type: "boolean" }
      }
    });

    assert.ok("id" in shape);
    assert.ok("permanent" in shape);
  });

  test("RiskEngine base score identifies protected tools", () => {
    const engine = new RiskEngine();
    assert.ok(engine.scoreToolBase("delete_email", { permanent: true }) >= 30);
    assert.ok(engine.scoreToolBase("read_email", { id: "msg_1" }) < 30);
  });

  test("Docker upstreams resolve to docker run stdio transports", () => {
    const transport = buildUpstreamTransportConfig(
      {
        name: "filesystem",
        transport: "docker",
        image: "ghcr.io/example/filesystem-mcp:latest",
        args: ["serve"],
        env: { ACCESS_TOKEN: "secret" },
        mounts: [{ hostPath: "./fixtures", containerPath: "/fixtures", readOnly: true }],
        passWorkspace: true,
        workspaceMountPath: "/workspace",
        containerCwd: "/workspace"
      },
      "C:\\repo"
    );

    assert.equal(transport.command, "docker");
    assert.deepEqual(transport.args, [
      "run",
      "--rm",
      "-i",
      "-v",
      "C:\\repo:/workspace",
      "-v",
      "C:\\repo\\fixtures:/fixtures:ro",
      "-e",
      "ACCESS_TOKEN=secret",
      "-w",
      "/workspace",
      "ghcr.io/example/filesystem-mcp:latest",
      "serve"
    ]);
  });

  test("buildDockerRunArgs appends container args before the image", () => {
    assert.deepEqual(
      buildDockerRunArgs(
        {
          name: "writer",
          transport: "docker",
          image: "ghcr.io/example/writer:latest",
          args: ["--stdio"],
          containerArgs: ["--pull=always", "--network=host"]
        },
        "C:\\repo"
      ),
      ["run", "--rm", "-i", "--pull=always", "--network=host", "ghcr.io/example/writer:latest", "--stdio"]
    );
  });

  // -----------------------------------------------------------------------
  // MCP discovery tests
  // -----------------------------------------------------------------------

  test("getClaudeCodeSettingsPath resolves under home dir via os.homedir()", () => {
    const p = getClaudeCodeSettingsPath();
    assert.ok(p.startsWith(os.homedir()), `expected path under homedir, got: ${p}`);
    assert.ok(p.includes(".claude"), `expected .claude in path, got: ${p}`);
    assert.ok(p.endsWith("settings.json"));
  });

  test("getClaudeDesktopConfigPath resolves cross-platform without hardcoded usernames", () => {
    const p = getClaudeDesktopConfigPath();
    assert.ok(
      p.startsWith(os.homedir()) || p.toLowerCase().includes("appdata"),
      `expected path under homedir or AppData, got: ${p}`
    );
    assert.ok(p.endsWith("claude_desktop_config.json"));
  });

  test("readMcpServersFromFile returns empty array for nonexistent file", () => {
    const result = readMcpServersFromFile(path.join(os.tmpdir(), "__nonexistent__", "settings.json"));
    assert.deepEqual(result, []);
  });

  test("readMcpServersFromFile returns empty array for invalid JSON", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-disc-"));
    const filePath = path.join(tmp, "settings.json");
    fs.writeFileSync(filePath, "{ not valid json }");
    assert.deepEqual(readMcpServersFromFile(filePath), []);
    fs.rmSync(tmp, { recursive: true });
  });

  test("readMcpServersFromFile returns empty array when mcpServers key is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-disc-"));
    const filePath = path.join(tmp, "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({ effortLevel: "high", theme: "dark" }));
    assert.deepEqual(readMcpServersFromFile(filePath), []);
    fs.rmSync(tmp, { recursive: true });
  });

  test("readMcpServersFromFile returns empty array for empty mcpServers object", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-disc-"));
    const filePath = path.join(tmp, "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(readMcpServersFromFile(filePath), []);
    fs.rmSync(tmp, { recursive: true });
  });

  test("readMcpServersFromFile filters latchkey and returns valid servers with env", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-disc-"));
    const filePath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        mcpServers: {
          latchkey: { command: "latchkey", args: ["start"] },
          filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
          demo: { command: "uv", args: ["run", "demo.py"], env: { KEY: "val" } }
        }
      })
    );
    const result = readMcpServersFromFile(filePath);
    assert.equal(result.length, 2);
    assert.ok(result.find((s) => s.name === "filesystem"));
    assert.ok(!result.find((s) => s.name === "latchkey"));
    const demo = result.find((s) => s.name === "demo");
    assert.deepEqual(demo?.env, { KEY: "val" });
    fs.rmSync(tmp, { recursive: true });
  });

  test("readMcpServersFromFile skips entries without a command field", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latchkey-disc-"));
    const filePath = path.join(tmp, "settings.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        mcpServers: {
          valid: { command: "npx", args: [] },
          nocommand: { args: ["foo"] },
          nullentry: null
        }
      })
    );
    const result = readMcpServersFromFile(filePath);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "valid");
    fs.rmSync(tmp, { recursive: true });
  });

  test("discoverMcpServers returns a valid DiscoveryResult without throwing", () => {
    const result = discoverMcpServers();
    assert.ok(["claude-code", "claude-desktop", "none"].includes(result.source));
    assert.ok(Array.isArray(result.servers));
  });

  console.log(`\n${passed} MCP runtime tests passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
