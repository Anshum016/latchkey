import type {
  ApprovalDecision,
  ApprovalExecutionInput,
  ApprovalExecutionResult,
  ApprovalRequest,
  ApprovalStore,
  LatchkeyConfig,
  RequestMutationResult
} from "./types.js";
import { NotificationService } from "./notification.js";

const POLL_INTERVAL_MS = 250;

export class ApprovalService {
  public constructor(
    private readonly store: ApprovalStore,
    private readonly notifications: NotificationService,
    private readonly config: Pick<LatchkeyConfig, "webhookBaseUrl" | "timeoutMs">
  ) {}

  public listPendingRequests(): ApprovalRequest[] {
    return this.store.listPendingRequests();
  }

  public getRequest(identifier: string): ApprovalRequest | null {
    return this.store.getRequest(identifier);
  }

  public resolvePendingDecision(
    identifier: string,
    decision: ApprovalDecision,
    source: string
  ): RequestMutationResult {
    const result = this.store.resolveRequest(identifier, decision, source);
    if (result.request && result.updated) {
      this.store.appendAuditEvent({
        token: result.request.token,
        eventType: decision === "allow" ? "approved" : "denied",
        channel: source,
        data: {
          code: result.request.code,
          source
        }
      });
    }

    return result;
  }

  public async executeWithApproval<T>(input: ApprovalExecutionInput<T>): Promise<ApprovalExecutionResult<T>> {
    const request = this.store.createRequest({
      toolName: input.toolName,
      params: input.params,
      risk: input.risk,
      timeoutMs: input.timeoutMs
    });

    this.store.appendAuditEvent({
      token: request.token,
      eventType: "intercepted",
      data: {
        code: request.code,
        toolName: request.toolName,
        riskScore: request.riskScore,
        riskAction: request.riskAction
      }
    });

    if (input.risk.action === "approve") {
      const approved = this.store.updateRequestStatus(request.token, "approved", {
        decision: "allow",
        decisionSource: input.decisionSource ?? "risk_engine",
        resolvedAt: Date.now()
      });

      const finalRequest = approved ?? request;
      this.store.appendAuditEvent({
        token: finalRequest.token,
        eventType: "approved",
        channel: input.decisionSource ?? "risk_engine",
        data: {
          code: finalRequest.code
        }
      });

      return this.executeApprovedRequest(finalRequest.token, input.execute);
    }

    try {
      await this.notifications.sendApprovalRequest({
        request,
        risk: input.risk,
        webhookBaseUrl: this.config.webhookBaseUrl,
        timeoutMs: input.timeoutMs
      });
    } catch (error) {
      const denied = this.store.updateRequestStatus(request.token, "denied", {
        decision: "deny",
        decisionSource: "notification_failure",
        resolvedAt: Date.now()
      });

      const finalRequest = denied ?? request;
      this.store.appendAuditEvent({
        token: finalRequest.token,
        eventType: "denied",
        channel: this.notifications.kind,
        message: "Notification delivery failed; request denied safely.",
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });

      return {
        status: "denied",
        request: finalRequest,
        error
      };
    }

    this.store.appendAuditEvent({
      token: request.token,
      eventType: "notified",
      channel: this.notifications.kind,
      data: {
        code: request.code
      }
    });

    const resolved = await this.waitForResolution(request.token, input.timeoutMs);
    if (resolved.status !== "approved") {
      return { status: resolved.status, request: resolved };
    }

    return this.executeApprovedRequest(resolved.token, input.execute);
  }

  private async executeApprovedRequest<T>(
    token: string,
    execute: () => Promise<T>
  ): Promise<ApprovalExecutionResult<T>> {
    const current = this.store.getRequestByToken(token);
    if (!current) {
      throw new Error(`Approval request ${token} disappeared before execution.`);
    }

    try {
      const result = await execute();
      const executed = this.store.updateRequestStatus(token, "executed");
      const finalRequest = executed ?? current;

      this.store.appendAuditEvent({
        token: finalRequest.token,
        eventType: "executed",
        data: {
          code: finalRequest.code
        }
      });

      return {
        status: "executed",
        request: finalRequest,
        result
      };
    } catch (error) {
      const failed = this.store.updateRequestStatus(token, "execution_failed");
      const finalRequest = failed ?? current;

      this.store.appendAuditEvent({
        token: finalRequest.token,
        eventType: "execution_failed",
        message: error instanceof Error ? error.message : String(error),
        data: {
          code: finalRequest.code
        }
      });

      return {
        status: "execution_failed",
        request: finalRequest,
        error
      };
    }
  }

  private async waitForResolution(token: string, timeoutMs: number): Promise<ApprovalRequest> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const current = this.store.getRequestByToken(token);
      if (!current) {
        throw new Error(`Approval request ${token} disappeared while waiting for a decision.`);
      }

      if (current.status !== "pending") {
        return current;
      }

      if (Date.now() >= current.expiresAt) {
        const timedOut = this.store.timeoutRequest(token);
        if (timedOut.request && timedOut.updated) {
          this.store.appendAuditEvent({
            token: timedOut.request.token,
            eventType: "timed_out",
            channel: "timeout",
            data: {
              code: timedOut.request.code
            }
          });
        }

        return timedOut.request ?? current;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const timedOut = this.store.timeoutRequest(token);
    if (timedOut.request && timedOut.updated) {
      this.store.appendAuditEvent({
        token: timedOut.request.token,
        eventType: "timed_out",
        channel: "timeout",
        data: {
          code: timedOut.request.code
        }
      });
    }

    const current = this.store.getRequestByToken(token);
    if (!current) {
      throw new Error(`Approval request ${token} disappeared after timing out.`);
    }

    return timedOut.request ?? current;
  }
}
