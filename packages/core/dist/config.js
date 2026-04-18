import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
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
const upstreamServerSchema = z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const record = value;
    if ("transport" in record) {
        return value;
    }
    return {
        transport: "stdio",
        ...record
    };
}, z.union([stdioUpstreamServerSchema, dockerUpstreamServerSchema]));
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
    .refine((value) => value.equals !== undefined ||
    value.notEquals !== undefined ||
    value.regex !== undefined ||
    value.glob !== undefined ||
    value.contains !== undefined ||
    value.exists !== undefined, {
    message: "Policy param conditions need at least one matcher."
});
const policyRuleSchema = z.object({
    action: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    upstream: z.string().min(1).optional(),
    params: z.array(policyParamConditionSchema).optional(),
    approval: z.enum(["none", "required", "block"]),
    reason: z.string().min(1).optional()
});
const notificationConfigSchema = z.object({
    channel: z.enum(["whatsapp", "slack", "email"]).default("whatsapp"),
    twilioSid: z.string().min(1).optional(),
    twilioToken: z.string().min(1).optional(),
    twilioFrom: z.string().min(1).optional(),
    userPhone: z.string().min(1).optional(),
    slackWebhookUrl: z.string().min(1).optional(),
    resendApiKey: z.string().min(1).optional(),
    userEmail: z.string().email().optional(),
    webhookBaseUrl: z.string().min(1).default("http://localhost:3001"),
    timeoutMs: z.number().int().positive().default(60_000),
    databasePath: z.string().min(1).optional()
});
const proxyConfigSchema = z.object({
    toolNameMode: z.enum(["transparent", "prefixed"]).default("transparent")
});
const storedConfigSchema = notificationConfigSchema.extend({
    upstreamServers: z.array(upstreamServerSchema).default([]),
    rules: z.array(policyRuleSchema).default([]),
    toolNameMode: z.enum(["transparent", "prefixed"]).default("transparent")
});
const yamlConfigSchema = z.object({
    notifications: notificationConfigSchema.partial().default({}),
    upstreams: z.array(upstreamServerSchema).default([]),
    rules: z.array(policyRuleSchema).default([]),
    proxy: proxyConfigSchema.partial().default({})
});
function parseTimeout(value) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function getEnvOverrides() {
    const overrides = {};
    const channel = process.env.LATCHKEY_CHANNEL;
    const timeoutMs = parseTimeout(process.env.LATCHKEY_TIMEOUT_MS);
    const toolNameMode = process.env.LATCHKEY_TOOL_NAME_MODE;
    if (channel) {
        overrides.channel = channel;
    }
    if (process.env.LATCHKEY_TWILIO_SID) {
        overrides.twilioSid = process.env.LATCHKEY_TWILIO_SID;
    }
    if (process.env.LATCHKEY_TWILIO_TOKEN) {
        overrides.twilioToken = process.env.LATCHKEY_TWILIO_TOKEN;
    }
    if (process.env.LATCHKEY_TWILIO_FROM) {
        overrides.twilioFrom = process.env.LATCHKEY_TWILIO_FROM;
    }
    if (process.env.LATCHKEY_USER_PHONE) {
        overrides.userPhone = process.env.LATCHKEY_USER_PHONE;
    }
    if (process.env.LATCHKEY_SLACK_WEBHOOK_URL) {
        overrides.slackWebhookUrl = process.env.LATCHKEY_SLACK_WEBHOOK_URL;
    }
    if (process.env.LATCHKEY_RESEND_API_KEY) {
        overrides.resendApiKey = process.env.LATCHKEY_RESEND_API_KEY;
    }
    if (process.env.LATCHKEY_USER_EMAIL) {
        overrides.userEmail = process.env.LATCHKEY_USER_EMAIL;
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
    return overrides;
}
function isYamlConfigPath(configPath) {
    return configPath.endsWith(".yaml") || configPath.endsWith(".yml");
}
function parseStoredConfig(data) {
    if (data && typeof data === "object") {
        const record = data;
        if ("notifications" in record || "upstreams" in record || "proxy" in record) {
            const parsed = yamlConfigSchema.parse(data);
            return storedConfigSchema.parse({
                ...parsed.notifications,
                upstreamServers: parsed.upstreams,
                rules: parsed.rules,
                toolNameMode: parsed.proxy.toolNameMode ?? "transparent"
            });
        }
    }
    return storedConfigSchema.parse(data);
}
function readStoredConfigFile(configPath) {
    if (!fs.existsSync(configPath)) {
        return {};
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = isYamlConfigPath(configPath) ? parseYaml(raw) : JSON.parse(raw);
    return parseStoredConfig(parsed);
}
function toYamlConfig(config) {
    return {
        notifications: {
            channel: config.channel,
            ...(config.twilioSid ? { twilioSid: config.twilioSid } : {}),
            ...(config.twilioToken ? { twilioToken: config.twilioToken } : {}),
            ...(config.twilioFrom ? { twilioFrom: config.twilioFrom } : {}),
            ...(config.userPhone ? { userPhone: config.userPhone } : {}),
            ...(config.slackWebhookUrl ? { slackWebhookUrl: config.slackWebhookUrl } : {}),
            ...(config.resendApiKey ? { resendApiKey: config.resendApiKey } : {}),
            ...(config.userEmail ? { userEmail: config.userEmail } : {}),
            webhookBaseUrl: config.webhookBaseUrl,
            timeoutMs: config.timeoutMs,
            ...(config.databasePath ? { databasePath: config.databasePath } : {})
        },
        upstreams: config.upstreamServers,
        rules: config.rules,
        proxy: {
            toolNameMode: config.toolNameMode
        }
    };
}
export function getLatchkeyHomeDir() {
    return path.join(os.homedir(), ".latchkey");
}
export function getDefaultProjectConfigPath() {
    return path.join(process.cwd(), "latchkey.yaml");
}
export function getDefaultLegacyConfigPath() {
    return path.join(getLatchkeyHomeDir(), "config.json");
}
export function getDefaultConfigPath() {
    return getDefaultProjectConfigPath();
}
export function getDefaultDatabasePath() {
    return path.join(getLatchkeyHomeDir(), "latchkey.db");
}
function resolveConfigPath(configPath) {
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
function ensureConfigDirectory(configPath) {
    const directory = path.dirname(configPath);
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
}
function normalizePolicyScalar(value) {
    return value;
}
function normalizePolicyParamCondition(condition) {
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
function normalizeUpstreamServer(server) {
    if (server.transport === "docker") {
        const dockerServer = {
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
    const stdioServer = {
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {})
    };
    return stdioServer;
}
function normalizeConfig(parsed) {
    return {
        channel: parsed.channel,
        twilioSid: parsed.twilioSid,
        twilioToken: parsed.twilioToken,
        twilioFrom: parsed.twilioFrom,
        userPhone: parsed.userPhone,
        slackWebhookUrl: parsed.slackWebhookUrl,
        resendApiKey: parsed.resendApiKey,
        userEmail: parsed.userEmail,
        webhookBaseUrl: parsed.webhookBaseUrl,
        timeoutMs: parsed.timeoutMs,
        databasePath: parsed.databasePath ?? getDefaultDatabasePath(),
        upstreamServers: parsed.upstreamServers.map((server) => normalizeUpstreamServer(server)),
        rules: parsed.rules.map((rule) => ({
            ...(rule.action ? { action: rule.action } : {}),
            ...(rule.tool ? { tool: rule.tool } : {}),
            ...(rule.upstream ? { upstream: rule.upstream } : {}),
            ...(rule.params ? { params: rule.params.map(normalizePolicyParamCondition) } : {}),
            approval: rule.approval,
            ...(rule.reason ? { reason: rule.reason } : {})
        })),
        toolNameMode: parsed.toolNameMode
    };
}
export function loadConfig(configPath) {
    const resolvedPath = resolveConfigPath(configPath);
    const fileConfig = readStoredConfigFile(resolvedPath);
    const merged = { ...fileConfig, ...getEnvOverrides() };
    const parsed = storedConfigSchema.parse(merged);
    return normalizeConfig(parsed);
}
export function saveConfig(config, configPath) {
    const resolvedPath = resolveConfigPath(configPath ?? getDefaultConfigPath());
    const current = readStoredConfigFile(resolvedPath);
    const candidate = storedConfigSchema.parse({
        ...current,
        ...config
    });
    ensureConfigDirectory(resolvedPath);
    if (isYamlConfigPath(resolvedPath)) {
        fs.writeFileSync(resolvedPath, stringifyYaml(toYamlConfig(candidate), { indent: 2 }), "utf-8");
    }
    else {
        fs.writeFileSync(resolvedPath, JSON.stringify(candidate, null, 2), "utf-8");
    }
    return normalizeConfig(candidate);
}
