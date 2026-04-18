import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { AIClassifierNotConfiguredError } from "./ai-classifier.js";
import type {
  AIConfig,
  DockerUpstreamServerConfig,
  LatchkeyConfig,
  NotificationChannelKind,
  PolicyMatchScalar,
  PolicyParamCondition,
  PolicyRule,
  StdioUpstreamServerConfig,
  ToolNameMode,
  UpstreamServerConfig
} from "./types.js";

const dockerMountSchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().min(1),
  readOnly: z.boolean().optional()
});

const stdioUpstreamServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional()
});

const dockerUpstreamServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("docker"),
  image: z.string().min(1),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  containerArgs: z.array(z.string()).default([]),
  mounts: z.array(dockerMountSchema).default([]),
  containerCwd: z.string().min(1).optional(),
  passWorkspace: z.boolean().default(false),
  workspaceMountPath: z.string().min(1).default("/workspace")
});

const upstreamServerSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const record = value as Record<string, unknown>;
    if ("transport" in record) {
      return value;
    }

    return {
      transport: "stdio",
      ...record
    };
  },
  z.union([stdioUpstreamServerSchema, dockerUpstreamServerSchema])
);

const policyMatchScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const policyParamConditionSchema = z
  .object({
    path: z.string().min(1),
    equals: policyMatchScalarSchema.optional(),
    notEquals: policyMatchScalarSchema.optional(),
    regex: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    contains: z.string().min(1).optional(),
    exists: z.boolean().optional()
  })
  .refine(
    (value) =>
      value.equals !== undefined ||
      value.notEquals !== undefined ||
      value.regex !== undefined ||
      value.glob !== undefined ||
      value.contains !== undefined ||
      value.exists !== undefined,
    {
      message: "Policy param conditions need at least one matcher."
    }
  );

const policyRuleSchema = z.object({
  action: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  upstream: z.string().min(1).optional(),
  params: z.array(policyParamConditionSchema).optional(),
  approval: z.enum(["none", "required", "block"]),
  reason: z.string().min(1).optional()
});

const notificationConfigSchema = z.object({
  channel: z.enum(["slack", "email"]).default("slack"),
  slackWebhookUrl: z.string().min(1).optional(),
  slackSigningSecret: z.string().min(1).optional(),
  resendApiKey: z.string().min(1).optional(),
  userEmail: z.string().email().optional(),
  emailFrom: z.string().min(1).optional(),
  webhookBaseUrl: z.string().min(1).default("http://localhost:3001"),
  timeoutMs: z.number().int().positive().default(60_000),
  databasePath: z.string().min(1).optional()
});

const proxyConfigSchema = z.object({
  toolNameMode: z.enum(["transparent", "prefixed"]).default("transparent")
});

const aiConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).default("claude-haiku-4-5-20251001"),
  timeoutMs: z.number().int().positive().default(5000)
});

const storedConfigSchema = notificationConfigSchema.extend({
  upstreamServers: z.array(upstreamServerSchema).default([]),
  rules: z.array(policyRuleSchema).default([]),
  toolNameMode: z.enum(["transparent", "prefixed"]).default("transparent"),
  ai: aiConfigSchema.default({})
});

const yamlConfigSchema = z.object({
  notifications: notificationConfigSchema.partial().default({}),
  upstreams: z.array(upstreamServerSchema).default([]),
  rules: z.array(policyRuleSchema).default([]),
  proxy: proxyConfigSchema.partial().default({}),
  ai: aiConfigSchema.partial().default({})
});

type StoredConfig = z.infer<typeof storedConfigSchema>;
type YamlConfig = z.infer<typeof yamlConfigSchema>;

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getEnvOverrides(): Partial<StoredConfig> {
  const overrides: Partial<StoredConfig> = {};

  const channel = process.env.LATCHKEY_CHANNEL as NotificationChannelKind | undefined;
  const timeoutMs = parseTimeout(process.env.LATCHKEY_TIMEOUT_MS);
  const toolNameMode = process.env.LATCHKEY_TOOL_NAME_MODE as ToolNameMode | undefined;

  if (channel) {
    overrides.channel = channel;
  }

  if (process.env.LATCHKEY_SLACK_WEBHOOK_URL) {
    overrides.slackWebhookUrl = process.env.LATCHKEY_SLACK_WEBHOOK_URL;
  }

  if (process.env.LATCHKEY_SLACK_SIGNING_SECRET) {
    overrides.slackSigningSecret = process.env.LATCHKEY_SLACK_SIGNING_SECRET;
  }

  if (process.env.LATCHKEY_RESEND_API_KEY) {
    overrides.resendApiKey = process.env.LATCHKEY_RESEND_API_KEY;
  }

  if (process.env.LATCHKEY_USER_EMAIL) {
    overrides.userEmail = process.env.LATCHKEY_USER_EMAIL;
  }

  if (process.env.LATCHKEY_EMAIL_FROM) {
    overrides.emailFrom = process.env.LATCHKEY_EMAIL_FROM;
  }

  if (process.env.LATCHKEY_WEBHOOK_BASE_URL) {
    overrides.webhookBaseUrl = process.env.LATCHKEY_WEBHOOK_BASE_URL;
  }

  if (timeoutMs !== undefined) {
    overrides.timeoutMs = timeoutMs;
  }

  if (process.env.LATCHKEY_DATABASE_PATH) {
    overrides.databasePath = process.env.LATCHKEY_DATABASE_PATH;
  }

  if (toolNameMode) {
    overrides.toolNameMode = toolNameMode;
  }

  const aiApiKey = process.env.LATCHKEY_AI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const aiModel = process.env.LATCHKEY_AI_MODEL;
  const aiTimeoutMs = parseTimeout(process.env.LATCHKEY_AI_TIMEOUT_MS);

  if (aiApiKey || aiModel || aiTimeoutMs !== undefined) {
    const currentAi: Record<string, unknown> = (overrides.ai as Record<string, unknown> | undefined) ?? {};
    overrides.ai = aiConfigSchema.parse({
      ...currentAi,
      ...(aiApiKey ? { apiKey: aiApiKey } : {}),
      ...(aiModel ? { model: aiModel } : {}),
      ...(aiTimeoutMs !== undefined ? { timeoutMs: aiTimeoutMs } : {})
    });
  }

  return overrides;
}

function isYamlConfigPath(configPath: string): boolean {
  return configPath.endsWith(".yaml") || configPath.endsWith(".yml");
}

function normalizeDeprecatedChannel(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  const record = data as Record<string, unknown>;
  if (record.channel === "whatsapp") {
    throw new Error('WhatsApp notifications are no longer supported. Please switch the channel to "slack" or "email".');
  }

  if ("notifications" in record) {
    const notifications = record.notifications;
    if (notifications && typeof notifications === "object" && !Array.isArray(notifications)) {
      const notificationRecord = notifications as Record<string, unknown>;
      if (notificationRecord.channel === "whatsapp") {
        throw new Error('WhatsApp notifications are no longer supported. Please switch the channel to "slack" or "email".');
      }
    }
  }

  return data;
}

function parseStoredConfig(data: unknown): StoredConfig {
  const normalizedInput = normalizeDeprecatedChannel(data);
  if (normalizedInput && typeof normalizedInput === "object") {
    const record = normalizedInput as Record<string, unknown>;
    if ("notifications" in record || "upstreams" in record || "proxy" in record || "ai" in record) {
      const parsed = yamlConfigSchema.parse(normalizedInput as YamlConfig);
      return storedConfigSchema.parse({
        ...parsed.notifications,
        upstreamServers: parsed.upstreams,
        rules: parsed.rules,
        toolNameMode: parsed.proxy.toolNameMode ?? "transparent",
        ai: parsed.ai
      });
    }
  }

  return storedConfigSchema.parse(normalizedInput);
}

function readStoredConfigFile(configPath: string): Partial<StoredConfig> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = isYamlConfigPath(configPath) ? parseYaml(raw) : JSON.parse(raw);
  return parseStoredConfig(parsed);
}

function toYamlConfig(config: StoredConfig): YamlConfig {
  return {
    notifications: {
      channel: config.channel,
      ...(config.slackWebhookUrl ? { slackWebhookUrl: config.slackWebhookUrl } : {}),
      ...(config.slackSigningSecret ? { slackSigningSecret: config.slackSigningSecret } : {}),
      ...(config.resendApiKey ? { resendApiKey: config.resendApiKey } : {}),
      ...(config.userEmail ? { userEmail: config.userEmail } : {}),
      ...(config.emailFrom ? { emailFrom: config.emailFrom } : {}),
      webhookBaseUrl: config.webhookBaseUrl,
      timeoutMs: config.timeoutMs,
      ...(config.databasePath ? { databasePath: config.databasePath } : {})
    },
    upstreams: config.upstreamServers,
    rules: config.rules,
    proxy: {
      toolNameMode: config.toolNameMode
    },
    ai: config.ai
  };
}

export function getLatchkeyHomeDir(): string {
  return path.join(os.homedir(), ".latchkey");
}

export function getDefaultProjectConfigPath(): string {
  return path.join(process.cwd(), "latchkey.yaml");
}

export function getDefaultLegacyConfigPath(): string {
  return path.join(getLatchkeyHomeDir(), "config.json");
}

export function getDefaultConfigPath(): string {
  return getDefaultProjectConfigPath();
}

export function getDefaultDatabasePath(): string {
  return path.join(getLatchkeyHomeDir(), "latchkey.db");
}

function resolveConfigPath(configPath?: string): string {
  if (configPath) {
    return configPath;
  }

  if (process.env.LATCHKEY_CONFIG_PATH) {
    return process.env.LATCHKEY_CONFIG_PATH;
  }

  const yamlPath = path.join(process.cwd(), "latchkey.yaml");
  if (fs.existsSync(yamlPath)) {
    return yamlPath;
  }

  const ymlPath = path.join(process.cwd(), "latchkey.yml");
  if (fs.existsSync(ymlPath)) {
    return ymlPath;
  }

  return getDefaultLegacyConfigPath();
}

function ensureConfigDirectory(configPath: string): void {
  const directory = path.dirname(configPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function normalizePolicyScalar(value: PolicyMatchScalar | undefined): PolicyMatchScalar | undefined {
  return value;
}

function normalizePolicyParamCondition(condition: PolicyParamCondition): PolicyParamCondition {
  return {
    path: condition.path,
    ...(condition.equals !== undefined ? { equals: normalizePolicyScalar(condition.equals) } : {}),
    ...(condition.notEquals !== undefined ? { notEquals: normalizePolicyScalar(condition.notEquals) } : {}),
    ...(condition.regex ? { regex: condition.regex } : {}),
    ...(condition.glob ? { glob: condition.glob } : {}),
    ...(condition.contains ? { contains: condition.contains } : {}),
    ...(condition.exists !== undefined ? { exists: condition.exists } : {})
  };
}

function normalizeUpstreamServer(server: UpstreamServerConfig): UpstreamServerConfig {
  if (server.transport === "docker") {
    const dockerServer: DockerUpstreamServerConfig = {
      name: server.name,
      transport: "docker",
      image: server.image,
      args: server.args ?? [],
      ...(server.command ? { command: server.command } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.containerArgs ? { containerArgs: server.containerArgs } : {}),
      ...(server.mounts ? { mounts: server.mounts } : {}),
      ...(server.containerCwd ? { containerCwd: server.containerCwd } : {}),
      ...(server.passWorkspace !== undefined ? { passWorkspace: server.passWorkspace } : {}),
      ...(server.workspaceMountPath ? { workspaceMountPath: server.workspaceMountPath } : {})
    };
    return dockerServer;
  }

  const stdioServer: StdioUpstreamServerConfig = {
    name: server.name,
    transport: "stdio",
    command: server.command,
    args: server.args ?? [],
    ...(server.env ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {})
  };
  return stdioServer;
}

function normalizeConfig(parsed: StoredConfig): LatchkeyConfig {
  return {
    channel: parsed.channel,
    slackWebhookUrl: parsed.slackWebhookUrl,
    slackSigningSecret: parsed.slackSigningSecret,
    resendApiKey: parsed.resendApiKey,
    userEmail: parsed.userEmail,
    emailFrom: parsed.emailFrom,
    webhookBaseUrl: parsed.webhookBaseUrl,
    timeoutMs: parsed.timeoutMs,
    databasePath: parsed.databasePath ?? getDefaultDatabasePath(),
    upstreamServers: parsed.upstreamServers.map((server: UpstreamServerConfig) => normalizeUpstreamServer(server)),
    rules: parsed.rules.map((rule: PolicyRule) => ({
      ...(rule.action ? { action: rule.action } : {}),
      ...(rule.tool ? { tool: rule.tool } : {}),
      ...(rule.upstream ? { upstream: rule.upstream } : {}),
      ...(rule.params ? { params: rule.params.map(normalizePolicyParamCondition) } : {}),
      approval: rule.approval,
      ...(rule.reason ? { reason: rule.reason } : {})
    })),
    toolNameMode: parsed.toolNameMode,
    ai: {
      apiKey: parsed.ai.apiKey,
      model: parsed.ai.model ?? "claude-haiku-4-5-20251001",
      timeoutMs: parsed.ai.timeoutMs ?? 5000
    }
  };
}

export function assertAIConfigured(config: LatchkeyConfig): void {
  const key = config.ai.apiKey?.trim();
  if (!key) {
    throw new AIClassifierNotConfiguredError(
      "Latchkey requires an Anthropic API key to start. " +
        "Set ai.apiKey in latchkey.yaml, or export LATCHKEY_AI_API_KEY / ANTHROPIC_API_KEY in the environment."
    );
  }
}

export function loadConfig(configPath?: string): LatchkeyConfig {
  const resolvedPath = resolveConfigPath(configPath);
  const fileConfig = readStoredConfigFile(resolvedPath);
  const merged = { ...fileConfig, ...getEnvOverrides() };
  const parsed = storedConfigSchema.parse(merged);
  return normalizeConfig(parsed);
}

export function saveConfig(config: Partial<LatchkeyConfig>, configPath?: string): LatchkeyConfig {
  const resolvedPath = resolveConfigPath(configPath ?? getDefaultConfigPath());
  const current = readStoredConfigFile(resolvedPath);
  const candidate = storedConfigSchema.parse({
    ...current,
    ...config
  });

  ensureConfigDirectory(resolvedPath);
  if (isYamlConfigPath(resolvedPath)) {
    fs.writeFileSync(resolvedPath, stringifyYaml(toYamlConfig(candidate), { indent: 2 }), "utf-8");
  } else {
    fs.writeFileSync(resolvedPath, JSON.stringify(candidate, null, 2), "utf-8");
  }

  return normalizeConfig(candidate);
}
