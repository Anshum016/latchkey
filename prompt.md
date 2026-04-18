Deeply analyze the current Latchkey codebase and identify **exactly how we are currently discovering/fetching MCP servers** during setup and runtime.

I want you to first understand the current implementation end-to-end before making changes.

## Context

Our product vision is:

* Latchkey should integrate with **Claude Code**
* We want to fetch MCP servers configured for **Claude Code**, **not Claude Desktop**
* Right now I suspect the logic may be reading the wrong config source
* I want a robust implementation that resolves the **correct user-level Claude Code config path dynamically**
* The solution should be **cross-platform**, **stable**, and should **not fail easily**

## Your tasks

### 1. Audit the current implementation

Read the relevant files and explain:

* where MCP server discovery currently happens
* which file path(s) are currently being read
* whether we are reading Claude Desktop config or Claude Code config
* how the discovered servers are transformed into Latchkey upstream configs
* what happens afterward during `latchkey init` and `latchkey start`

Focus especially on files like:

* setup/init CLI flow
* config loading/saving
* proxy startup/runtime
* any file path resolution helpers

I want a precise technical explanation of the current flow before any code changes.

### 2. Identify the architecture gap

After understanding the current behavior, explain clearly:

* why the current implementation is wrong or incomplete for Claude Code
* what risks exist if we rely on Claude Desktop config
* what the correct source of truth should be for **Claude Code user-level MCP servers**

### 3. Implement Claude Code–first MCP discovery

Refactor the implementation so that MCP discovery is based on the **Claude Code user-level config**, not Claude Desktop config.

Target source of truth:

* `~/.claude/settings.json`

But do **not** hardcode OS-specific absolute paths unsafely.
Implement proper dynamic path resolution using Node APIs.

### 4. Make path resolution robust and cross-platform

Implement a clean path resolution strategy that works on:

* Windows
* macOS
* Linux

Use the user home directory dynamically.

I want code that safely resolves the Claude Code settings path using something like:

* `os.homedir()`
* `path.join(...)`

Do not assume usernames or fixed machine-specific absolute paths.

### 5. Make the discovery logic resilient

The implementation should not fail abruptly.

Handle cases like:

* `~/.claude/settings.json` does not exist
* file exists but contains invalid JSON
* `mcpServers` key is missing
* settings file exists but has empty config
* permission/read issues

In each case:

* fail gracefully
* return a safe fallback
* print helpful and actionable error messages
* do not crash the whole setup flow unless absolutely necessary

### 6. Preserve existing user experience where possible

If needed, you may keep Claude Desktop config support only as a **secondary fallback/import option**, but the primary discovery logic must be **Claude Code first**.

If you keep fallback support:

* make the priority order explicit
* document it in code comments
* explain why it exists

### 7. Refactor cleanly

I do not want a hacky patch.

Please:

* create well-named helper functions
* separate path resolution from file reading and parsing
* keep the code readable and production-quality
* avoid duplication
* keep compatibility with the existing architecture

### 8. Add validation and tests

Update or add tests for:

* path resolution
* valid Claude Code settings parsing
* missing file behavior
* malformed JSON behavior
* missing `mcpServers`
* fallback behavior if implemented

### 9. Output I want from you

After making the changes, provide:

1. A clear explanation of the **old flow**
2. A clear explanation of the **new flow**
3. All modified files
4. Why the new approach is correct for Claude Code
5. Any remaining edge cases or limitations

## Important constraints

* Do not make assumptions without verifying them in the code
* First understand the current behavior deeply, then refactor
* Keep the implementation production-grade
* Prioritize Claude Code user-level config over Claude Desktop
* The final behavior should be reliable enough that it does not fail on a fresh machine unnecessarily

If needed, improve naming as part of the refactor so the code clearly reflects:

* Claude Code config
* Claude Desktop config
* upstream discovery
* fallback logic
