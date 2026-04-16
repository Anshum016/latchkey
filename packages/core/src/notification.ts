import { IncomingWebhook } from "@slack/webhook";
import { Resend } from "resend";
import type {
  ApprovalRequest,
  LatchkeyConfig,
  NotificationChannel,
  NotificationChannelKind,
  NotificationDispatchPayload,
  RiskResult
} from "./types.js";

export class NotificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotificationError";
  }
}

function topReasons(risk: RiskResult): string[] {
  const reasons = risk.breakdown
    .filter((dimension) => dimension.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((dimension) => `${dimension.reason} (+${dimension.score})`);

  if (reasons.length > 0) {
    return reasons;
  }

  return risk.explanation === "Safe action" ? [] : [risk.explanation];
}

function buildApproveUrl(baseUrl: string, token: string, decision: "allow" | "deny"): string {
  const url = new URL("/approve", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("decision", decision);
  return url.toString();
}

function buildCliFallback(code: string): string[] {
  return [`latchkey approve ${code} allow`, `latchkey approve ${code} deny`];
}

function buildReasonBullets(risk: RiskResult): string[] {
  return topReasons(risk).map((line) => `- ${line}`);
}

function buildApprovalText(payload: NotificationDispatchPayload): string {
  const reasons = buildReasonBullets(payload.risk).join("\n");
  const timeoutSeconds = Math.round(payload.timeoutMs / 1000);
  const allowUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "allow");
  const denyUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "deny");
  const cliFallback = buildCliFallback(payload.request.code).map((line) => `- ${line}`).join("\n");

  return [
    "Latchkey approval needed",
    "",
    `Tool: ${payload.request.toolName}`,
    `Risk: ${payload.risk.score}/100 (${payload.risk.level.toUpperCase()})`,
    `Code: ${payload.request.code}`,
    `Expires in: ${timeoutSeconds}s`,
    "",
    "Why it was flagged:",
    reasons || "- No additional detail",
    "",
    "Approve:",
    `- Allow: ${allowUrl}`,
    `- Deny: ${denyUrl}`,
    "",
    "CLI fallback:",
    cliFallback
  ].join("\n");
}

function buildAutoBlockedText(payload: NotificationDispatchPayload): string {
  const reasons = buildReasonBullets(payload.risk).join("\n");

  return [
    "Latchkey auto-blocked an action",
    "",
    `Tool: ${payload.request.toolName}`,
    `Risk: ${payload.risk.score}/100 (${payload.risk.level.toUpperCase()})`,
    `Code: ${payload.request.code}`,
    "",
    "Why blocked:",
    reasons || "- No additional detail",
    "",
    "CLI fallback:",
    buildCliFallback(payload.request.code).map((line) => `- ${line}`).join("\n")
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildSlackReasonList(risk: RiskResult): string {
  const reasons = topReasons(risk);
  if (reasons.length === 0) {
    return "No additional detail";
  }

  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function buildEmailHtml(payload: NotificationDispatchPayload): string {
  const allowUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "allow");
  const denyUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "deny");
  const timeoutSeconds = Math.round(payload.timeoutMs / 1000);
  const reasons = topReasons(payload.risk)
    .map((reason) => `<li>${escapeHtml(reason)}</li>`)
    .join("");
  const cliFallback = buildCliFallback(payload.request.code)
    .map((command) => `<div><code>${escapeHtml(command)}</code></div>`)
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f7fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f0;border-radius:16px;padding:24px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:12px;">Latchkey approval needed</div>
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;">${escapeHtml(payload.request.toolName)}</h1>
      <p style="margin:0 0 6px;"><strong>Risk:</strong> ${payload.risk.score}/100 (${escapeHtml(payload.risk.level.toUpperCase())})</p>
      <p style="margin:0 0 6px;"><strong>Code:</strong> ${escapeHtml(payload.request.code)}</p>
      <p style="margin:0 0 18px;"><strong>Expires in:</strong> ${timeoutSeconds}s</p>
      <h2 style="font-size:16px;margin:0 0 10px;">Why it was flagged</h2>
      <ul style="margin:0 0 24px 20px;padding:0;">
        ${reasons || "<li>No additional detail</li>"}
      </ul>
      <div style="margin:0 0 24px;">
        <a href="${escapeHtml(allowUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;margin-right:12px;">Allow</a>
        <a href="${escapeHtml(denyUrl)}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;">Deny</a>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">CLI fallback</div>
        ${cliFallback}
      </div>
    </div>
  </body>
</html>`;
}

function assertResendResponse(
  response: Awaited<ReturnType<Resend["emails"]["send"]>>,
  operation: string
): void {
  if (response.error) {
    throw new NotificationError(`Resend ${operation} failed: ${response.error.message}`);
  }
}

class SlackWebhookChannel implements NotificationChannel {
  public readonly kind: NotificationChannelKind = "slack";
  private readonly webhook: IncomingWebhook;

  public constructor(private readonly config: LatchkeyConfig) {
    if (!config.slackWebhookUrl) {
      throw new NotificationError("Slack notifications require a webhook URL.");
    }

    this.webhook = new IncomingWebhook(config.slackWebhookUrl);
  }

  public async sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void> {
    const allowUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "allow");
    const denyUrl = buildApproveUrl(payload.webhookBaseUrl, payload.request.token, "deny");
    const timeoutSeconds = Math.round(payload.timeoutMs / 1000);
    const cliFallback = buildCliFallback(payload.request.code);

    await this.webhook.send({
      text: `Latchkey approval needed for ${payload.request.toolName} (${payload.risk.score}/100, code ${payload.request.code})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `*Latchkey approval needed*\n` +
              `*Tool:* \`${payload.request.toolName}\`\n` +
              `*Risk:* ${payload.risk.score}/100 (${payload.risk.level.toUpperCase()})\n` +
              `*Code:* \`${payload.request.code}\`\n` +
              `*Expires in:* ${timeoutSeconds}s`
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Why it was flagged*\n${buildSlackReasonList(payload.risk)}`
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
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `CLI fallback: \`${cliFallback[0]}\` or \`${cliFallback[1]}\``
            }
          ]
        }
      ]
    });
  }

  public async sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void> {
    await this.webhook.send({ text: buildAutoBlockedText(payload) });
  }
}

class EmailChannel implements NotificationChannel {
  public readonly kind: NotificationChannelKind = "email";
  private readonly client: Resend;
  private readonly from: string;

  public constructor(private readonly config: LatchkeyConfig) {
    if (!config.resendApiKey || !config.userEmail) {
      throw new NotificationError("Email notifications require a Resend API key and destination email.");
    }

    this.client = new Resend(config.resendApiKey);
    this.from = config.emailFrom ?? "Latchkey <onboarding@resend.dev>";
  }

  public async sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void> {
    const response = await this.client.emails.send({
      from: this.from,
      to: [this.config.userEmail!],
      subject: `Approve ${payload.request.toolName} (${payload.risk.score}/100)`,
      text: buildApprovalText(payload),
      html: buildEmailHtml(payload)
    });
    assertResendResponse(response, "approval send");
  }

  public async sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void> {
    const response = await this.client.emails.send({
      from: this.from,
      to: [this.config.userEmail!],
      subject: `Auto-blocked: ${payload.request.toolName}`,
      text: buildAutoBlockedText(payload),
      html: `<p>${buildAutoBlockedText(payload).replace(/\n/g, "<br>")}</p>`
    });
    assertResendResponse(response, "auto-block send");
  }
}

export class NotificationService {
  public readonly kind: NotificationChannelKind;

  public constructor(private readonly channel: NotificationChannel) {
    this.kind = channel.kind;
  }

  public async sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void> {
    await this.channel.sendApprovalRequest(payload);
  }

  public async sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void> {
    try {
      await this.channel.sendAutoBlocked(payload);
    } catch {
      // Auto-block alerts are intentionally best-effort.
    }
  }
}

export function createNotificationService(config: LatchkeyConfig): NotificationService {
  switch (config.channel) {
    case "slack":
      return new NotificationService(new SlackWebhookChannel(config));
    case "email":
      return new NotificationService(new EmailChannel(config));
  }
}

export function buildNotificationPreview(request: ApprovalRequest, risk: RiskResult, timeoutMs: number): string {
  return buildApprovalText({
    request,
    risk,
    webhookBaseUrl: "http://localhost:3001",
    timeoutMs
  });
}
