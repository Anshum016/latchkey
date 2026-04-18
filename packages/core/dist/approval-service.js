const POLL_INTERVAL_MS = 250;
export class ApprovalService {
    store;
    notifications;
    config;
    constructor(store, notifications, config) {
        this.store = store;
        this.notifications = notifications;
        this.config = config;
    }
    listPendingRequests() {
        return this.store.listPendingRequests();
    }
    getRequest(identifier) {
        return this.store.getRequest(identifier);
    }
    resolvePendingDecision(identifier, decision, source) {
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
        return result.request;
    }
    async executeWithApproval(input) {
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
        if (input.risk.action === "block") {
            const blocked = this.store.updateRequestStatus(request.token, "auto_blocked", {
                decision: "deny",
                decisionSource: input.decisionSource ?? "risk_engine",
                resolvedAt: Date.now()
            });
            const finalRequest = blocked ?? request;
            this.store.appendAuditEvent({
                token: finalRequest.token,
                eventType: "auto_blocked",
                data: {
                    explanation: finalRequest.explanation
                }
            });
            await this.notifications.sendAutoBlocked({
                request: finalRequest,
                risk: input.risk,
                webhookBaseUrl: this.config.webhookBaseUrl,
                timeoutMs: input.timeoutMs
            });
            return { status: "auto_blocked", request: finalRequest };
        }
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
        }
        catch (error) {
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
    async executeApprovedRequest(token, execute) {
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
        }
        catch (error) {
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
    async waitForResolution(token, timeoutMs) {
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
