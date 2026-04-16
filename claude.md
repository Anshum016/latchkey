# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What We're Building

Latchkey is an MCP proxy server that intercepts dangerous AI agent tool calls and routes them to the human for approval via Slack or email. "Your agent needs your key."

## Commands

```bash
# Easiest end-user flow
npm run init              # build + interactive setup
npm run start:latchkey    # build + start proxy + webhook

# Helpful follow-up commands
npm run status:latchkey
npm run validate:latchkey
npm run approve:latchkey -- <token-or-code> <allow|deny>

# Build all packages (core must build first - mcp and webhook depend on it)
npm run build

# Typecheck all packages
npm run typecheck

# Run all tests
npm run test

# Per-package (run from repo root)
npm run build --workspace @latchkey/core
npm run build --workspace @latchkey/mcp
npm run build --workspace @latchkey/webhook

npm run test --workspace @latchkey/core      # builds then runs build/test.js
npm run test --workspace @latchkey/mcp       # builds then runs dist/runtime-test.js
npm run test --workspace @latchkey/webhook   # builds then runs dist/test.js
```

Tests are compiled TypeScript run directly with Node - no test framework. Run a single package's test with the workspace commands above.

## Architecture

Three npm workspaces, ESM throughout (`"type": "module"`):

```
packages/core/      @latchkey/core     - shared domain logic, no MCP dependency
packages/mcp/       @latchkey/mcp      - MCP proxy server + CLI (latchkey)
packages/webhook/   @latchkey/webhook  - Express webhook receiver (latchkey-webhook)
```

**`@latchkey/core`** is the shared kernel. It exports:
- `RiskEngine` (`risk.ts`) - scores tool calls using pattern matching; produces `RiskResult` with score 0-100
- `PolicyEngine` (`policy-engine.ts`) - evaluates declarative `PolicyRule[]` from config; `approval: block` coerces to `notify` action (identical to `required`); rules support `upstream`, `tool`/`action` glob patterns, and `params` conditions
- `ApprovalService` (`approval-service.ts`) - orchestrates the approval lifecycle: auto-approve or notify+wait; calls `execute()` after approval
- `SQLiteApprovalStore` (`storage.ts`) - `better-sqlite3` persistence for `ApprovalRequest` and `AuditEvent` records
- `NotificationService` / `createNotificationService` (`notification.ts`) - dispatches to Slack Incoming Webhooks or Resend email
- `loadConfig` / `saveConfig` (`config.ts`) - reads `latchkey.yaml` (preferred) or `~/.latchkey/config.json`; env vars override file values

**`@latchkey/mcp`** (`mcp-entry.ts` + `runtime/proxy.ts`):
- `startMcpProxyServer()` - wires all core services, then calls `buildProxyTools()`
- `buildProxyTools()` connects to each upstream MCP server via stdio, discovers their tools, and re-registers them on the proxy `McpServer`. Tools with base risk >= 30 or matching a policy rule are "protected" and routed through `ApprovalService`; others pass through directly.
- Session state (`task`, `callCounts`, `startTime`) is kept in memory and fed into risk scoring.
- `latchkey_set_task` is a synthetic tool always registered on the proxy so agents can declare their current task.
- CLI (`cli/latchkey.ts`): `start | serve | init | setup | validate | status | approve <token-or-code> <allow|deny>`

**`@latchkey/webhook`** (`server.ts`):
- Express app on port 3001 (default)
- `POST /webhook/slack` - Slack interactive component payload; reads `action_id` + `value`
- `GET /approve?token=&decision=` - email link click handler; returns HTML confirmation page

## Risk Tiers & Scoring

| Score | Tier     | Action                                              |
|-------|----------|-----------------------------------------------------|
| 0–29  | low      | auto-approve                                        |
| 30–64 | high     | notify + wait up to `timeoutMs`; deny on timeout    |
| 65–100| critical | notify + wait up to `timeoutMs`; deny on timeout    |

`RiskEngine.score()` always returns `action: "notify"` for scores ≥ 30 — critical never auto-blocks. The `"block"` action type exists but is currently unreachable through normal scoring.

Scoring uses six dimensions (raw scores normalized over 65):
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
  channel: slack      # slack | email
  webhookBaseUrl: http://localhost:3001
  timeoutMs: 60000
upstreams:
  - name: my-server
    command: npx
    args: [-y, some-mcp-server]
  - name: docker-server          # docker transport (transport: docker)
    transport: docker
    image: my-mcp-image
    args: []
rules:
  - tool: write_file             # glob patterns supported (e.g. write_*)
    approval: required
  - tool: delete_*
    upstream: my-server          # scope rule to one upstream
    approval: block              # treated same as required
  - tool: send_email
    params:
      - path: recipients
        exists: true             # params conditions: equals/notEquals/regex/glob/contains/exists
    approval: required
proxy:
  toolNameMode: transparent  # transparent | prefixed
```

Environment variables (`LATCHKEY_CHANNEL`, `LATCHKEY_SLACK_WEBHOOK_URL`, `LATCHKEY_WEBHOOK_BASE_URL`, etc.) override file values.

## TypeScript Rules

Strict mode, no `any` types, all async functions must have `try/catch`.
