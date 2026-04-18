import { IncomingWebhook } from "@slack/webhook";
import { Resend } from "resend";
import twilio from "twilio";
export class NotificationError extends Error {
    constructor(message) {
        super(message);
        this.name = "NotificationError";
    }
}
export function parseWhatsAppDecision(message) {
    const match = message.trim().toUpperCase().match(/^(ALLOW|DENY)\s+([A-Z0-9]{6,})$/);
    if (!match) {
        return null;
    }
    const decisionWord = match[1];
    const code = match[2];
    if (!decisionWord || !code) {
        return null;
    }
    return {
        decision: decisionWord === "ALLOW" ? "allow" : "deny",
        code
    };
}
function topReasons(risk) {
    return risk.breakdown
        .filter((dimension) => dimension.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .map((dimension) => `${dimension.reason} (+${dimension.score})`);
}
function buildApprovalText(payload) {
    const reasons = topReasons(payload.risk).map((line) => `- ${line}`).join("\n");
    const timeoutSeconds = Math.round(payload.timeoutMs / 1000);
    return [
        "Latchkey needs your approval",
        "",
        `Tool: ${payload.request.toolName}`,
        `Risk: ${payload.risk.score}/100 (${payload.risk.level.toUpperCase()})`,
        `Code: ${payload.request.code}`,
        "",
        "Why flagged:",
        reasons || "- No additional detail",
        "",
        `Reply with "ALLOW ${payload.request.code}" or "DENY ${payload.request.code}" within ${timeoutSeconds}s.`
    ].join("\n");
}
function buildAutoBlockedText(payload) {
    const reasons = topReasons(payload.risk).map((line) => `- ${line}`).join("\n");
    return [
        "Latchkey auto-blocked an action",
        "",
        `Tool: ${payload.request.toolName}`,
        `Risk: ${payload.risk.score}/100 (${payload.risk.level.toUpperCase()})`,
        "",
        "Why blocked:",
        reasons || "- No additional detail"
    ].join("\n");
}
function buildApproveUrl(baseUrl, token, decision) {
    const url = new URL("/approve", baseUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("decision", decision);
    return url.toString();
}
class TwilioWhatsAppChannel {
    config;
    kind = "whatsapp";
    constructor(config) {
        this.config = config;
    }
    async sendApprovalRequest(payload) {
        const client = this.getClient();
        await client.messages.create({
            from: this.config.twilioFrom,
            to: this.config.userPhone,
            body: buildApprovalText(payload)
        });
    }
    async sendAutoBlocked(payload) {
        const client = this.getClient();
        await client.messages.create({
            from: this.config.twilioFrom,
            to: this.config.userPhone,
            body: buildAutoBlockedText(payload)
        });
    }
    getClient() {
        if (!this.config.twilioSid || !this.config.twilioToken || !this.config.twilioFrom || !this.config.userPhone) {
            throw new NotificationError("WhatsApp notifications require Twilio credentials and a destination phone number.");
        }
        return twilio(this.config.twilioSid, this.config.twilioToken);
    }
}
class SlackWebhookChannel {
    config;
    kind = "slack";
    webhook;
    constructor(config) {
        this.config = config;
        if (!config.slackWebhookUrl) {
            throw new NotificationError("Slack notifications require a webhook URL.");
        }
        this.webhook = new IncomingWebhook(config.slackWebhookUrl);
    }
    async sendApprovalRequest(payload) {
        const allowUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "allow");
        const denyUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "deny");
        await this.webhook.send({
            text: buildApprovalText(payload),
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Latchkey needs approval*\n*Tool:* \`${payload.request.toolName}\`\n*Risk:* ${payload.risk.score}/100\n*Code:* \`${payload.request.code}\``
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "Allow" },
                            style: "primary",
                            url: allowUrl,
                            value: payload.request.token,
                            action_id: "allow"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "Deny" },
                            style: "danger",
                            url: denyUrl,
                            value: payload.request.token,
                            action_id: "deny"
                        }
                    ]
                }
            ]
        });
    }
    async sendAutoBlocked(payload) {
        await this.webhook.send({ text: buildAutoBlockedText(payload) });
    }
}
class EmailChannel {
    config;
    kind = "email";
    client;
    constructor(config) {
        this.config = config;
        if (!config.resendApiKey || !config.userEmail) {
            throw new NotificationError("Email notifications require a Resend API key and destination email.");
        }
        this.client = new Resend(config.resendApiKey);
    }
    async sendApprovalRequest(payload) {
        const allowUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "allow");
        const denyUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "deny");
        await this.client.emails.send({
            from: "Latchkey <noreply@latchkey.dev>",
            to: [this.config.userEmail],
            subject: `Approval needed: ${payload.request.toolName}`,
            text: buildApprovalText(payload),
            html: `
        <p>${buildApprovalText(payload).replace(/\n/g, "<br>")}</p>
        <p>
          <a href="${allowUrl}">Allow</a>
          &nbsp;|&nbsp;
          <a href="${denyUrl}">Deny</a>
        </p>
      `
        });
    }
    async sendAutoBlocked(payload) {
        await this.client.emails.send({
            from: "Latchkey <noreply@latchkey.dev>",
            to: [this.config.userEmail],
            subject: `Auto-blocked: ${payload.request.toolName}`,
            text: buildAutoBlockedText(payload),
            html: `<p>${buildAutoBlockedText(payload).replace(/\n/g, "<br>")}</p>`
        });
    }
}
export class NotificationService {
    channel;
    kind;
    constructor(channel) {
        this.channel = channel;
        this.kind = channel.kind;
    }
    async sendApprovalRequest(payload) {
        await this.channel.sendApprovalRequest(payload);
    }
    async sendAutoBlocked(payload) {
        try {
            await this.channel.sendAutoBlocked(payload);
        }
        catch {
            // Auto-block alerts are intentionally best-effort.
        }
    }
}
export function createNotificationService(config) {
    switch (config.channel) {
        case "whatsapp":
            return new NotificationService(new TwilioWhatsAppChannel(config));
        case "slack":
            return new NotificationService(new SlackWebhookChannel(config));
        case "email":
            return new NotificationService(new EmailChannel(config));
    }
}
export function buildNotificationPreview(request, risk, timeoutMs) {
    return buildApprovalText({
        request,
        risk,
        webhookBaseUrl: "http://localhost:3001",
        timeoutMs
    });
}
