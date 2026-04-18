import assert from "node:assert/strict";
import { jsonSchemaToZodShape } from "./runtime/json-schema.js";
import { RiskEngine } from "@latchkey/core";
import { buildDockerRunArgs, buildUpstreamTransportConfig } from "./runtime/upstream.js";
async function run() {
    let passed = 0;
    function test(name, fn) {
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
        const transport = buildUpstreamTransportConfig({
            name: "filesystem",
            transport: "docker",
            image: "ghcr.io/example/filesystem-mcp:latest",
            args: ["serve"],
            env: { ACCESS_TOKEN: "secret" },
            mounts: [{ hostPath: "./fixtures", containerPath: "/fixtures", readOnly: true }],
            passWorkspace: true,
            workspaceMountPath: "/workspace",
            containerCwd: "/workspace"
        }, "C:\\repo");
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
        assert.deepEqual(buildDockerRunArgs({
            name: "writer",
            transport: "docker",
            image: "ghcr.io/example/writer:latest",
            args: ["--stdio"],
            containerArgs: ["--pull=always", "--network=host"]
        }, "C:\\repo"), ["run", "--rm", "-i", "--pull=always", "--network=host", "ghcr.io/example/writer:latest", "--stdio"]);
    });
    console.log(`\n${passed} MCP runtime tests passed.`);
}
run().catch((error) => {
    console.error(error);
    process.exit(1);
});
