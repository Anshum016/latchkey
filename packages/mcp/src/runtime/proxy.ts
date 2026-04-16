import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ApprovalService, LatchkeyConfig, PolicyEngine, RiskEngine } from "@latchkey/core";
import { jsonSchemaToZodShape } from "./json-schema.js";
import { buildUpstreamTransportConfig } from "./upstream.js";

interface SessionState {
  task: string;
  startTime: number;
  callCounts: Record<string, number>;
}

export interface BuildProxyToolsOptions {
  config: LatchkeyConfig;
  approvalService: ApprovalService;
  riskEngine: RiskEngine;
  policyEngine: PolicyEngine;
  projectDir?: string;
}

export async function buildProxyTools(server: McpServer, options: BuildProxyToolsOptions): Promise<number> {
  const session: SessionState = {
    task: "",
    startTime: Date.now(),
    callCounts: {}
  };

  server.registerTool(
    "latchkey_set_task",
    {
      description: "Tell Latchkey what task the agent is currently working on.",
      inputSchema: {
        task: z.string()
      }
    },
    async ({ task }) => {
      session.task = task;
      console.error(`[Latchkey] task set: "${task}"`);
      return {
        content: [{ type: "text", text: `Latchkey task set to "${task}"` }]
      };
    }
  );

  let connectedUpstreams = 0;

  for (const upstream of options.config.upstreamServers) {
    try {
      const client = new Client({ name: "latchkey-proxy", version: "0.1.0" });
      const transportConfig: ConstructorParameters<typeof StdioClientTransport>[0] =
        buildUpstreamTransportConfig(upstream, options.projectDir ?? process.cwd());

      const transport = new StdioClientTransport(transportConfig);
      await client.connect(transport);
      const { tools } = await client.listTools();

      connectedUpstreams += 1;
      console.error(`[Latchkey] upstream "${upstream.name}" connected with ${tools.length} tools`);

      for (const tool of tools) {
        registerUpstreamTool(server, client, upstream.name, tool, session, options);
      }
    } catch (error) {
      console.error(
        `[Latchkey] failed to connect upstream "${upstream.name}":`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return connectedUpstreams;
}

function registerUpstreamTool(
  server: McpServer,
  client: Client,
  upstreamName: string,
  tool: Tool,
  session: SessionState,
  options: BuildProxyToolsOptions
): void {
  const inputSchema = jsonSchemaToZodShape(tool.inputSchema);
  const policyApplies = options.policyEngine.mayMatchTool({
    toolName: tool.name,
    upstreamName
  });
  const baseScore = options.riskEngine.scoreToolBase(tool.name);
  const shouldProtect = policyApplies || baseScore >= 30;
  const exposedToolName =
    shouldProtect && options.config.toolNameMode === "prefixed" ? `latchkey_${tool.name}` : tool.name;

  if (shouldProtect) {
    server.registerTool(
      exposedToolName,
      {
        description: `${tool.description ?? tool.name} [Protected by Latchkey]`,
        inputSchema,
        annotations: tool.annotations
          ? { ...tool.annotations, destructiveHint: true }
          : { destructiveHint: true }
      },
      async (params) => {
        session.callCounts[tool.name] = (session.callCounts[tool.name] ?? 0) + 1;
        return handleProtectedToolCall(tool.name, upstreamName, params, client, session, options);
      }
    );
    return;
  }

  server.registerTool(
    tool.name,
    {
      description: tool.description ?? tool.name,
      inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {})
    },
    async (params) => {
      try {
        return normalizeToolResult(await client.callTool({ name: tool.name, arguments: params }));
      } catch (error) {
        return createToolError(
          `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

async function handleProtectedToolCall(
  toolName: string,
  upstreamName: string,
  params: Record<string, unknown>,
  client: Client,
  session: SessionState,
  options: BuildProxyToolsOptions
): Promise<CallToolResult> {
  const heuristicRisk = options.riskEngine.score({
    toolName,
    payload: params,
    sessionTask: session.task,
    callCount: session.callCounts[toolName] ?? 0,
    sessionAgeMs: Date.now() - session.startTime
  });
  const policyContext = {
    toolName,
    upstreamName,
    params
  };
  const policyEvaluation = options.policyEngine.evaluate(policyContext);
  const risk = options.policyEngine.applyToRisk(policyContext, heuristicRisk);

  const outcome = await options.approvalService.executeWithApproval({
    toolName,
    params,
    risk,
    timeoutMs: options.config.timeoutMs,
    decisionSource: policyEvaluation.matchedRule ? "policy" : "risk_engine",
    execute: async () => normalizeToolResult(await client.callTool({ name: toolName, arguments: params }))
  });

  switch (outcome.status) {
    case "executed":
      return outcome.result ?? createToolError(`Latchkey executed ${toolName} but no tool result was returned.`);
    case "auto_blocked":
      return createToolError(
        `Latchkey auto-blocked ${toolName}.\nRisk: ${risk.score}/100\nReason: ${risk.explanation}\nCode: ${outcome.request.code}`
      );
    case "denied":
      return createToolError(`Action denied by user via Latchkey.\nTool: ${toolName}\nCode: ${outcome.request.code}`);
    case "timed_out":
      return createToolError(`Action timed out waiting for approval.\nTool: ${toolName}\nCode: ${outcome.request.code}`);
    case "execution_failed":
      return createToolError(
        `Tool execution failed after approval.\nTool: ${toolName}\nCode: ${outcome.request.code}\nError: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`
      );
    case "approved":
    case "pending":
      return createToolError(`Latchkey reached an unexpected state for ${toolName}.`);
  }

  return createToolError(`Latchkey reached an unknown state for ${toolName}.`);
}

function createToolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function normalizeToolResult(result: unknown): CallToolResult {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as CallToolResult;
  }

  return createToolError("The upstream MCP server returned an unsupported tool result shape.");
}
