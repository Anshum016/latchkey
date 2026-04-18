# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What We're Building

Latchkey is an MCP proxy server that intercepts dangerous AI agent tool calls and routes them to the human for approval via Slack or email. "Your agent needs your key."

## Commands

```bash
# Easiest end-user flow
npm run init              # build + interactive setup wizard
npm run start:latchkey    # build + start proxy + webhook

# Helpful follow-up commands
npm run status:latchkey
npm run validate:latchkey
npm run approve:latchkey -- <token-or-code> <allow|deny>

# Dry-run risk scoring (requires config with ai.apiKey or LATCHKEY_AI_API_KEY / ANTHROPIC_API_KEY)
node packages/mcp/build/cli/latchkey.js score <tool-name>
node packages/mcp/build/cli/latchkey.js score <tool-name> --params '{"key":"value"}'

# Build all packages (core must build first — mcp and webhook depend on it)
npm run build

# Bundle CLI for publishing (produces bin/latchkey.js + bin/webhook.js via esbuild)
npm run bundle

# Typecheck all packages
npm run typecheck

# Run all tests
npm run test

# Per-package (run from repo root)
npm run build --workspace @latchkey/core
npm run build --workspace @latchkey/mcp
npm run build --workspace @latchkey/webhook

npm run test --workspace @latchkey/core      # builds then runs build/test.js        (23 tests)
npm run test --workspace @latchkey/mcp       # builds then runs build/runtime-test.js (21 tests)
npm run test --workspace @latchkey/webhook   # builds then runs build/test.js         (5 tests)

npm run test:email-approval                  # manual email approval flow (scripts/email-approval-test.mjs)
```

Tests are compiled TypeScript run directly with Node — no test framework. Run a single package's test with the workspace commands above.

All CLI commands except `score` accept a `--config <path>` flag before the command name.

## Architecture

Three npm workspaces, ESM throughout (`"type": "module"`):

```
packages/core/      @latchkey/core     - shared domain logic, no MCP dependency
packages/mcp/       @latchkey/mcp      - MCP proxy server + CLI (latchkey-proxy)
packages/webhook/   @latchkey/webhook  - Express webhook receiver (latchkey-webhook)
```

`@latchkey/mcp` depends on both `@latchkey/core` and `@latchkey/webhook`. The `start` command spawns the webhook server as a **child process** and then starts the MCP proxy in the same process; `serve` starts only the MCP proxy without launching the webhook.

**Webhook entry path resolution** (`cli/latchkey.ts` → `getWebhookEntryPath()`): first checks for a sibling `webhook.js` in the same directory as `latchkey.js` (the bundled install path), then falls back to `createRequire(import.meta.url).resolve("@latchkey/webhook")` for the monorepo dev path.

**`@latchkey/core`** is the shared kernel. It exports:
- `AIClassifier` / error classes (`ai-classifier.ts`) — calls `claude-haiku-4-5-20251001` (default) via `@anthropic-ai/sdk` using `tool_use` forced output (`classify_risk` tool). Hard timeout via `Promise.race`. Exported error classes: `AIClassifierError`, `AIClassifierTimeoutError`, `AIClassifierNotConfiguredError`. Requires non-empty API key at construction; throws on empty key. The `AIClassifierLike` interface (`classify(ctx, heuristic)`) is used for DI and stubbing in tests.
- `RiskEngine` (`risk.ts`) — `async score(ctx)` runs heuristic → AI classifier → fusion; throws `AIClassifierNotConfiguredError` if no classifier was injected. Constructor: `new RiskEngine(userRules?, aiClassifier?)`. `scoreToolBase()` is synchronous and heuristic-only — runs once at tool registration, never calls the model. Exports `fuseScores(heuristic, ai)` for the three-branch fusion rule.
- `PolicyEngine` (`policy-engine.ts`) — evaluates declarative `PolicyRule[]` from config; `approval: block` coerces to `notify` (identical to `required`); rules support `upstream`, `tool`/`action` glob patterns, and `params` conditions
- `ApprovalService` (`approval-service.ts`) — orchestrates the approval lifecycle: auto-approve or notify+wait; polls SQLite every 250 ms; calls `execute()` after approval; timeout always denies
- `SQLiteApprovalStore` (`storage.ts`) — `better-sqlite3` persistence for `ApprovalRequest` and `AuditEvent` records
- `NotificationService` / `createNotificationService` (`notification.ts`) — dispatches to Slack Incoming Webhooks or Resend email; all three formats (plain text, Slack blocks, email HTML) include truncated tool parameters to help the approver make an informed decision
- `loadConfig` / `saveConfig` / `assertAIConfigured` (`config.ts`) — reads `latchkey.yaml` (or `.yml`) from cwd, falling back to `~/.latchkey/config.json`; env vars override file values **except** `ai.apiKey`: the config file value takes priority over `LATCHKEY_AI_API_KEY` / `ANTHROPIC_API_KEY` so `latchkey-proxy init` works without manual env setup. `assertAIConfigured(config)` throws `AIClassifierNotConfiguredError` with a clear message if `config.ai.apiKey` is missing — called by `startMcpProxyServer` before constructing the AI classifier.
- `parseSecurityRules` / `loadSecurityRules` (`policy.ts`) — loads custom `SecurityRule[]` from a `SECURITY.md` file in the project dir; rules are encoded as a JSON array in either an HTML comment block (`<!--latchkey-rules:start-->`) or a fenced code block (`` ```latchkey-rules ``); each rule has `pattern` (regex), `scoreDelta`, and `reason`

**`@latchkey/mcp`** (`mcp-entry.ts` + `runtime/proxy.ts`):
- `startMcpProxyServer()` — wires all core services, then calls `buildProxyTools()`
- `buildProxyTools()` — connects to each upstream MCP server via stdio (or docker), discovers their tools, and re-registers them on the proxy `McpServer`. Tools with base risk ≥ 30 or matching a policy rule are "protected" and routed through `ApprovalService`; others pass through directly.
- `runtime/upstream.ts` — `buildUpstreamTransportConfig()` converts any `UpstreamServerConfig` to stdio parameters; docker upstreams become `docker run --rm -i [containerArgs] [-v mounts] [-e env] image [command] [args]`
- `runtime/json-schema.ts` — `jsonSchemaToZodShape()` converts MCP tool `inputSchema` to a Zod shape for re-registration on the proxy server
- Session state (`task`, `callCounts`, `startTime`) is a single in-memory object shared across all concurrent calls — not per-connection isolated.
- `latchkey_set_task` is a synthetic tool always registered on the proxy so agents can declare their current task.
- CLI (`cli/latchkey.ts`): `start | serve | init | setup | doctor | validate | status | approve <token-or-code> <allow|deny> | score <tool-name> [--params '{}']`
- `cli/mcp-discovery.ts` — **MCP server discovery with four-level priority**: (1) `~/.claude.json → projects[cwd].mcpServers` (Claude Code project-level, via `discoverClaudeCodeProjectServers()` / `readMcpServersFromClaudeJson(filePath, projectDir)`), (2) `~/.claude/settings.json` (Claude Code user-level), (3) Claude Desktop config, (4) none. `discoverMcpServers()` walks this priority and returns the first non-empty result with a `DiscoverySource` tag (`"claude-code-project" | "claude-code" | "claude-desktop" | "none"`). Path helpers: `getClaudeJsonPath()`, `getClaudeCodeSettingsPath()`, `getClaudeDesktopConfigPath()`. Removal helpers: `removeServersFromClaudeCodeProjectConfig()`, `removeServersFromClaudeCodeConfig()`, `removeServersFromClaudeDesktopConfig()`. Project-key matching normalises `\` → `/` and lowercases both sides for cross-platform safety. `FILTER_NAMES = ["latchkey", "latchkey-proxy"]` is applied everywhere to prevent recursive proxying. All reads are resilient — missing file, invalid JSON, missing keys, and malformed entries all return `[]`.
- `cli/setup.ts` (the `latchkey-proxy init` wizard): uses `discoverMcpServers()` from `mcp-discovery.ts`; shows "Claude Code (project)", "Claude Code", or "Claude Desktop" in prompts depending on where servers were found; removes wrapped servers from the correct source config (project-level, user-level, or Desktop); writes `latchkey-proxy` entry to Claude Desktop config and/or `~/.claude/settings.json`

**`@latchkey/webhook`** (`server.ts`):
- Express app; port defaults to `3001` or `$PORT`
- `GET /health` — liveness check; returns `{ status: "ok" }`
- `POST /webhook/slack` — Slack interactive component payload; reads `action_id` + `value` (token). Verifies `X-Slack-Signature` HMAC-SHA256 when `slackSigningSecret` is configured (opt-in); raw body is captured via `express.urlencoded({ verify: ... })` into a `WeakMap`.
- `GET /approve?token=&decision=` — email link click handler; returns HTML confirmation page
- Self-starts when run directly as a script (checked via `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`)

## Risk Tiers & Scoring

| Score  | Tier     | Action                                           |
|--------|----------|--------------------------------------------------|
| 0–29   | low      | auto-approve                                     |
| 30–64  | high     | notify + wait up to `timeoutMs`; deny on timeout |
| 65–100 | critical | notify + wait up to `timeoutMs`; deny on timeout |

**Every protected tool call goes through two stages: heuristic then AI classifier.** Latchkey requires an Anthropic API key (`ai.apiKey` / `LATCHKEY_AI_API_KEY` / `ANTHROPIC_API_KEY`). Starting the proxy without one fails immediately.

**Stage 1 — heuristic** (`scoreHeuristically`): six dimensions scored and normalized. `scoreToolBase()` is heuristic-only and runs once at startup to classify tools into protected/unprotected; it does NOT call the model.

**Stage 2 — AI classifier** (`AIClassifier.classify`): always called for every protected tool call (no fast-path skips). Uses `claude-haiku-4-5-20251001` by default with `tool_use` forced output. On API failure or timeout, throws — the error propagates and the tool call is denied as a safe default.

**Stage 3 — fusion** (`fuseScores`):
- `final = max(heuristic, ai)`
- If both ≥ 50: `final = min(100, final + 10)`
- If heuristic < 30 and ai > 60: `final = ai`
- Strategy tag: `fusionStrategy: "max_with_agreement"` on `RiskResult`

`RiskEngine.score()` always returns `action: "notify"` for scores ≥ 30 — critical never auto-blocks. The `"block"` action type exists but is currently unreachable through normal scoring.

Heuristic scoring dimensions (raw scores normalized over 65):
- **Reversibility** (max 35): permanent deletion > overwrite > send/publish > delete
- **Blast Radius** (max 25): "all" targets, arrays >100 / >20 / >5 items
- **Data Sensitivity** (max 20): credentials/secrets, HIPAA, financial, PII, legal; test data gives −5
- **Intent Alignment** (max 20): +20 if task is read-only but tool is destructive; 0 if task matches tool; +10 if no task set
- **Temporal Anomaly** (max 15): off-hours (+8), call count >10 (+12), session age >2h (+5)
- **External Scope** (max 15): broadcast/tweet (+15), outbound email scaled by recipient count

**Timeout always defaults to DENY** — safe fallback.

## Config File Format

Project-level `latchkey.yaml` (resolved before `~/.latchkey/config.json`):

```yaml
notifications:
  channel: slack           # slack | email
  webhookBaseUrl: http://localhost:3001
  timeoutMs: 60000
  slackSigningSecret: ...  # optional; enables X-Slack-Signature verification on POST /webhook/slack
upstreams:
  - name: my-server
    command: npx
    args: [-y, some-mcp-server]
    env: {}                # optional; passed to child process
    cwd: /path/to/dir      # optional; working directory
  - name: docker-server    # docker transport
    transport: docker
    image: my-mcp-image
    args: []
    containerArgs: []      # extra args inserted before the image name in docker run
    mounts:                # volume mounts
      - hostPath: ./data
        containerPath: /data
        readOnly: true
    passWorkspace: false   # mount cwd as /workspace (default path) inside container
    workspaceMountPath: /workspace
    containerCwd: /app     # sets -w inside container
rules:
  - tool: write_file        # glob patterns supported (e.g. write_*)
    approval: required
  - tool: delete_*
    upstream: my-server     # scope rule to one upstream
    approval: block         # treated same as required
  - tool: send_email
    params:
      - path: recipients
        exists: true        # params conditions: equals/notEquals/regex/glob/contains/exists
    approval: required
proxy:
  toolNameMode: transparent # transparent | prefixed
ai:
  apiKey: sk-ant-...         # required; config file takes priority over env vars
  model: claude-haiku-4-5-20251001  # optional override
  timeoutMs: 5000            # optional; hard timeout for the AI call (ms)
```

Environment variable overrides: `LATCHKEY_CHANNEL`, `LATCHKEY_SLACK_WEBHOOK_URL`, `LATCHKEY_SLACK_SIGNING_SECRET`, `LATCHKEY_RESEND_API_KEY`, `LATCHKEY_USER_EMAIL`, `LATCHKEY_EMAIL_FROM`, `LATCHKEY_WEBHOOK_BASE_URL`, `LATCHKEY_TIMEOUT_MS`, `LATCHKEY_DATABASE_PATH`, `LATCHKEY_TOOL_NAME_MODE`, `LATCHKEY_CONFIG_PATH`, `LATCHKEY_AI_API_KEY` (or `ANTHROPIC_API_KEY`), `LATCHKEY_AI_MODEL`, `LATCHKEY_AI_TIMEOUT_MS`. Note: `ai.apiKey` in the config file takes precedence over `LATCHKEY_AI_API_KEY` / `ANTHROPIC_API_KEY`.

## Publishing

The root package (`latchkey-proxy`) bundles all workspace code via esbuild into `bin/latchkey.js` and `bin/webhook.js`. Only one package needs to be published — the sub-packages (`@latchkey/core`, `@latchkey/webhook`, `@latchkey/mcp`) do not need to be on npm.

```bash
npm run build && npm run bundle
npm publish   # publishes latchkey-proxy
```

`prepublishOnly` runs `npm run build && npm run bundle` automatically. The bundle script is at `scripts/bundle.mjs`. `bin/` is gitignored — it is always generated, never committed.

After publishing, users install with `npm install -g latchkey-proxy` or `npx latchkey-proxy@latest init`.

## TypeScript Rules

Strict mode, no `any` types, all async functions must have `try/catch`.
