# Latchkey

**Your agent needs your key.**

Latchkey is an MCP proxy server that intercepts dangerous AI agent tool calls and routes them to you for approval via Slack or email — before the action executes.

> You do **not** need to clone this repository. Install directly from npm.

---

## Install

```bash
npm install -g latchkey-proxy
```

or run without installing:

```bash
npx latchkey-proxy@latest init
```

## Setup

Run the interactive setup wizard:

```bash
latchkey init
```

The wizard will ask you for:

1. **Anthropic API key** — used for AI-powered risk evaluation of tool calls
2. **Notification channel** — Slack (webhook URL) or email (Resend API key + addresses)
3. **Upstream MCP servers** — auto-discovered from your Claude Desktop config; choose which ones Latchkey should protect
4. **Protection rules** — starter rules are generated (e.g. `delete_*` requires approval)
5. **Claude integration** — automatically installs the Latchkey MCP entry in Claude Desktop and/or Claude Code

## Start

```bash
latchkey start
```

This launches the MCP proxy server and the webhook approval server together. Open Claude Desktop or Claude Code — Latchkey is now intercepting tool calls.

## How approvals work

When your AI agent tries to call a protected tool (e.g. `delete_file`, `write_file` on `.env`):

1. Latchkey scores the call for risk using heuristics + an AI classifier
2. If the score is ≥ 30, it pauses execution and sends you a notification
3. **Slack**: an interactive message with Allow / Deny buttons appears in your channel
4. **Email**: a link lands in your inbox — click to approve or deny
5. If you approve, the tool call executes; if you deny (or the timeout elapses), it is blocked

## Other commands

```bash
latchkey doctor          # verify config is complete and ready
latchkey status          # list pending approvals
latchkey approve <code> <allow|deny>   # approve/deny from the terminal
latchkey validate        # check config syntax
latchkey score <tool>    # preview risk score for a tool name
```

## Config file

Setup writes `latchkey.yaml` to your current directory (or `~/.latchkey/config.json` as a fallback). You can edit it directly:

```yaml
notifications:
  channel: slack
  slackWebhookUrl: https://hooks.slack.com/services/...
  timeoutMs: 60000

upstreams:
  - name: my-server
    command: npx
    args: [-y, some-mcp-server]

rules:
  - tool: delete_*
    approval: required
  - tool: write_*
    params:
      - path: path
        contains: .env
    approval: required

ai:
  apiKey: sk-ant-...
  model: claude-haiku-4-5-20251001
```

## Publish (for contributors)

The root package bundles all workspace code — only one publish needed:

```bash
npm run build && npm run bundle
npm publish  # publishes latchkey-proxy
```
