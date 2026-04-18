## Latchkey Examples

These example configs show the two main adoption paths the repo supports today:

- `latchkey.local.yaml`: run an upstream MCP server directly on the host with stdio and send approvals to Slack.
- `latchkey.docker.yaml`: run an upstream MCP server through `docker run` and send approvals to an email inbox such as Gmail.

Both examples include richer policy rules that can match:

- A tool glob such as `write_*`
- A specific upstream name such as `filesystem`
- Specific request params such as `path`

Example rule shapes:

```yaml
rules:
  - action: "delete_*"
    approval: required
    reason: Deletes always need approval.

  - tool: "write_*"
    upstream: "filesystem"
    params:
      - path: path
        contains: ".env"
    approval: required
    reason: Environment files stay human-reviewed.
```
