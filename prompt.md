Read CLAUDE.md completely before touching any file.

Then read these files carefully:

- packages/mcp/src/cli/mcp-discovery.ts
- packages/mcp/src/cli/setup.ts
- packages/mcp/src/cli/latchkey.ts

Understand the existing discovery flow completely before writing any code.

--------------------------------------------

GOAL

We are simplifying the architecture of Latchkey.

Latchkey must NO LONGER auto-discover MCP servers.

All automatic discovery mechanisms must be removed.

Instead, the user must explicitly provide the configuration file path that contains the MCP servers.

This path can be something like:

- .mcp.json
- claude_desktop_config.json
- ~/.claude.json

But Latchkey will not search for these automatically anymore.

The user must always provide the path during `latchkey-proxy init`.

--------------------------------------------

DESIGN CHANGE

Current behavior:
Latchkey tries to discover MCP servers automatically using multiple strategies:

- Claude Code project scope (~/.claude.json)
- Claude Code user scope (~/.claude/settings.json)
- Claude Desktop config
- .mcp.json in project directory

This entire discovery system must be removed.

New behavior:

Latchkey should only read MCP servers from a path explicitly provided by the user.

--------------------------------------------

