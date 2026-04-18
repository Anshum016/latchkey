import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AIClassifier,
  ApprovalService,
  PolicyEngine,
  RiskEngine,
  SQLiteApprovalStore,
  assertAIConfigured,
  createNotificationService,
  loadConfig,
  loadSecurityRules
} from "@latchkey/core";
import { buildProxyTools } from "./runtime/proxy.js";

export interface StartMcpProxyServerOptions {
  configPath?: string;
  configOverride?: ReturnType<typeof loadConfig>;
  projectDir?: string;
}

export async function startMcpProxyServer(
  options: StartMcpProxyServerOptions = {}
): Promise<void> {
  const config = options.configOverride ?? loadConfig(options.configPath);
  assertAIConfigured(config);
  const aiClassifier = new AIClassifier({
    apiKey: config.ai.apiKey!,
    model: config.ai.model,
    timeoutMs: config.ai.timeoutMs
  });
  const rules = loadSecurityRules(options.projectDir ?? process.cwd());
  const riskEngine = new RiskEngine(rules, aiClassifier);
  const policyEngine = new PolicyEngine(config.rules);
  const store = new SQLiteApprovalStore(config.databasePath);
  store.init();

  const notificationService = createNotificationService(config);
  const approvalService = new ApprovalService(store, notificationService, config);

  const server = new McpServer({
    name: "latchkey",
    version: "0.1.0"
  });

  const connectedUpstreams = await buildProxyTools(server, {
    config,
    approvalService,
    riskEngine,
    policyEngine,
    ...(options.projectDir ? { projectDir: options.projectDir } : {})
  });

  if (connectedUpstreams === 0) {
    throw new Error("Latchkey could not connect to any upstream MCP servers.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[Latchkey] running - your agent needs your key");
  console.error(`[Latchkey] upstreams: ${connectedUpstreams}`);
  console.error(`[Latchkey] channel: ${config.channel}`);
}
