You need to modify the Latchkey MCP discovery logic so it correctly discovers MCP servers configured by Claude Code.

IMPORTANT CONTEXT

Currently our discovery logic only reads MCP servers from:
1. ~/.claude/settings.json
2. Claude Desktop config

However, Claude Code also stores MCP server configuration inside the file:

~/.claude.json

Inside this file, MCP servers are often stored under a project-specific structure:

{
  "projects": {
    "<project-path>": {
      "mcpServers": {
        "server-name": {
          "type": "stdio",
          "command": "...",
          "args": [...]
        }
      }
    }
  }
}

Example:

projects["C:/Users/anshu/OneDrive/Desktop/latchkey"].mcpServers.drawio

Claude Code loads MCP servers from this location when a project is opened.

OUR CURRENT PROBLEM

Latchkey currently cannot discover MCP servers that are stored inside ~/.claude.json under projects[].mcpServers.

Therefore our proxy fails to detect upstream MCP servers when users configure them via Claude Code's built-in MCP UI.

GOAL

Extend the discovery system so Latchkey can:

1. Locate ~/.claude.json
2. Parse the file safely
3. Identify the current project path
4. Extract MCP servers defined under:

projects[currentProjectPath].mcpServers

5. Normalize those servers into our internal upstream format
6. Allow them to be wrapped by Latchkey

IMPORTANT REQUIREMENTS

1. This must NOT break the current discovery logic.
2. The discovery priority should be:

   a) Claude Code project config (~/.claude.json → projects[currentProjectPath].mcpServers)
   b) Claude Code user config (~/.claude/settings.json)
   c) Claude Desktop config
   d) manual configuration

3. Handle path normalization because project keys may appear as:

   C:\Users\...
   or
   C:/Users/...

4. Only extract valid MCP servers with:
   command
   args

5. Ignore:
   latchkey
   latchkey-proxy
   or any server that would cause recursive proxying.

6. The new logic should live in:

packages/mcp/src/cli/mcp-discovery.ts

7. Add a new function:

discoverClaudeCodeProjectServers()

which:

- reads ~/.claude.json
- determines the current project directory
- extracts mcpServers
- returns normalized server configs

8. Integrate this function into the existing:

discoverMcpServers()

so project-level servers are discovered first.

9. Add robust error handling:

- file missing
- invalid JSON
- project not found
- missing mcpServers
- malformed server configs

10. Add unit tests for:

- project path match
- slash normalization
- missing file
- missing project
- malformed server entries
- filtering latchkey

EXPECTED OUTPUT

Implement the code changes required for this feature.

Modify only the necessary files and keep the architecture clean.

Explain:
- what changes were made
- why they are safe
- how discovery order now works