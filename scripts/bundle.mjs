#!/usr/bin/env node
import esbuild from "esbuild";
import fs from "node:fs";

fs.mkdirSync("bin", { recursive: true });

const external = [
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@slack/webhook",
  "better-sqlite3",
  "cors",
  "dotenv",
  "express",
  "resend",
  "yaml",
  "zod",
];

const shared = { bundle: true, platform: "node", format: "esm", external };

await esbuild.build({
  ...shared,
  entryPoints: ["packages/mcp/src/cli/latchkey.ts"],
  outfile: "bin/latchkey.js",
});

await esbuild.build({
  ...shared,
  entryPoints: ["packages/webhook/src/server.ts"],
  outfile: "bin/webhook.js",
});

console.log("Bundled → bin/latchkey.js  bin/webhook.js");
