import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDefaultConfigPath, loadConfig, saveConfig } from "@latchkey/core";
async function ask(rl, label, defaultValue) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer.length > 0 ? answer : defaultValue ?? "";
}
function parseArgumentList(value) {
    const matches = value.match(/"([^"]*)"|'([^']*)'|[^\s]+/g) ?? [];
    return matches.map((match) => {
        if ((match.startsWith('"') && match.endsWith('"')) ||
            (match.startsWith("'") && match.endsWith("'"))) {
            return match.slice(1, -1);
        }
        return match;
    });
}
function formatArgumentList(args) {
    if (!args || args.length === 0) {
        return "";
    }
    return args
        .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
        .join(" ");
}
function parseBooleanAnswer(value, defaultValue) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return defaultValue;
    }
    return normalized === "y" || normalized === "yes" || normalized === "true";
}
async function configurePrimaryUpstream(rl, existingUpstreams) {
    const current = existingUpstreams[0];
    const rest = existingUpstreams.slice(1);
    const defaultMode = current?.transport === "docker" ? "docker" : current ? "stdio" : "skip";
    const requestedMode = (await ask(rl, "Primary upstream type (stdio/docker/skip)", defaultMode)).toLowerCase();
    const mode = requestedMode === "docker" || requestedMode === "skip" ? requestedMode : "stdio";
    if (mode === "skip") {
        return existingUpstreams;
    }
    const name = await ask(rl, "Primary upstream name", current?.name ?? "primary");
    const args = parseArgumentList(await ask(rl, "Upstream args (space-separated)", formatArgumentList(current?.args)));
    if (mode === "docker") {
        const dockerCurrent = current?.transport === "docker" ? current : undefined;
        const image = await ask(rl, "Docker image", dockerCurrent?.image);
        if (!image) {
            throw new Error("Docker image is required for Docker upstreams.");
        }
        const containerCommand = await ask(rl, "Container command (optional)", dockerCurrent?.command);
        const mountWorkspaceDefault = dockerCurrent?.passWorkspace ?? true;
        const mountWorkspace = parseBooleanAnswer(await ask(rl, "Mount the current project into the container? (yes/no)", mountWorkspaceDefault ? "yes" : "no"), mountWorkspaceDefault);
        const workspaceMountPath = mountWorkspace
            ? await ask(rl, "Container workspace path", dockerCurrent?.workspaceMountPath ?? "/workspace")
            : "";
        const containerCwd = await ask(rl, "Container working directory (optional)", dockerCurrent?.containerCwd ?? (mountWorkspace ? workspaceMountPath : ""));
        const containerArgs = parseArgumentList(await ask(rl, "Extra docker run args (space-separated)", formatArgumentList(dockerCurrent?.containerArgs)));
        const dockerUpstream = {
            name,
            transport: "docker",
            image,
            args,
            ...(containerCommand ? { command: containerCommand } : {}),
            ...(dockerCurrent?.env ? { env: dockerCurrent.env } : {}),
            ...(containerArgs.length > 0 ? { containerArgs } : {}),
            ...(dockerCurrent?.mounts ? { mounts: dockerCurrent.mounts } : {}),
            ...(containerCwd ? { containerCwd } : {}),
            ...(mountWorkspace ? { passWorkspace: true } : { passWorkspace: false }),
            ...(mountWorkspace && workspaceMountPath ? { workspaceMountPath } : {})
        };
        return [dockerUpstream, ...rest];
    }
    const stdioCurrent = current?.transport === "docker" ? undefined : current;
    const command = await ask(rl, "Upstream command", stdioCurrent?.command);
    if (!command) {
        throw new Error("An upstream command is required for stdio upstreams.");
    }
    const cwd = await ask(rl, "Upstream working directory (optional)", stdioCurrent?.cwd);
    return [
        {
            name,
            transport: "stdio",
            command,
            args,
            ...(stdioCurrent?.env ? { env: stdioCurrent.env } : {}),
            ...(cwd ? { cwd } : {})
        },
        ...rest
    ];
}
export async function runSetup(configPath = getDefaultConfigPath()) {
    const rl = readline.createInterface({ input, output });
    try {
        console.log("\nLatchkey Setup\n");
        console.log(`Config file: ${configPath}\n`);
        const existing = loadConfig(configPath);
        const channelAnswer = (await ask(rl, "Notification channel (whatsapp/slack/email)", existing.channel)).toLowerCase();
        const channel = channelAnswer === "slack" || channelAnswer === "email" ? channelAnswer : "whatsapp";
        const toolNameModeAnswer = (await ask(rl, "Tool name mode (transparent/prefixed)", existing.toolNameMode)).toLowerCase();
        const toolNameMode = toolNameModeAnswer === "prefixed" ? "prefixed" : "transparent";
        const upstreamServers = await configurePrimaryUpstream(rl, existing.upstreamServers);
        const updates = {
            channel,
            webhookBaseUrl: await ask(rl, "Webhook server URL", existing.webhookBaseUrl),
            timeoutMs: Number(await ask(rl, "Approval timeout in milliseconds", String(existing.timeoutMs))) || existing.timeoutMs,
            databasePath: await ask(rl, "Database path", existing.databasePath),
            toolNameMode,
            upstreamServers,
            rules: existing.rules
        };
        if (channel === "whatsapp") {
            updates.twilioSid = await ask(rl, "Twilio Account SID", existing.twilioSid);
            updates.twilioToken = await ask(rl, "Twilio Auth Token", existing.twilioToken);
            updates.twilioFrom = await ask(rl, "Twilio WhatsApp number", existing.twilioFrom);
            updates.userPhone = await ask(rl, "Your WhatsApp number", existing.userPhone);
        }
        else if (channel === "slack") {
            updates.slackWebhookUrl = await ask(rl, "Slack Incoming Webhook URL", existing.slackWebhookUrl);
        }
        else {
            updates.resendApiKey = await ask(rl, "Resend API key", existing.resendApiKey);
            updates.userEmail = await ask(rl, "Destination email", existing.userEmail);
        }
        const saved = saveConfig(updates, configPath);
        console.log("\nSaved configuration:");
        console.log(`  channel: ${saved.channel}`);
        console.log(`  webhookBaseUrl: ${saved.webhookBaseUrl}`);
        console.log(`  databasePath: ${saved.databasePath}`);
        console.log(`  toolNameMode: ${saved.toolNameMode}`);
        console.log(`  upstreams: ${saved.upstreamServers.length}`);
        console.log("\nNext steps:");
        console.log('  1. Register Latchkey in your MCP client as: "latchkey" -> ["serve"]');
        console.log("  2. Start the webhook service with: latchkey-webhook");
        console.log('  3. Optionally tell the agent to call "latchkey_set_task" at the start of each session.');
        console.log("  4. Add rules to latchkey.yaml to match tools, upstreams, or specific params.");
    }
    finally {
        rl.close();
    }
}
