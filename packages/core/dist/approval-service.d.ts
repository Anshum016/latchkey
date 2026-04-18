import type { ApprovalDecision, ApprovalExecutionInput, ApprovalExecutionResult, ApprovalRequest, ApprovalStore, LatchkeyConfig } from "./types.js";
import { NotificationService } from "./notification.js";
export declare class ApprovalService {
    private readonly store;
    private readonly notifications;
    private readonly config;
    constructor(store: ApprovalStore, notifications: NotificationService, config: Pick<LatchkeyConfig, "webhookBaseUrl" | "timeoutMs">);
    listPendingRequests(): ApprovalRequest[];
    getRequest(identifier: string): ApprovalRequest | null;
    resolvePendingDecision(identifier: string, decision: ApprovalDecision, source: string): ApprovalRequest | null;
    executeWithApproval<T>(input: ApprovalExecutionInput<T>): Promise<ApprovalExecutionResult<T>>;
    private executeApprovedRequest;
    private waitForResolution;
}
//# sourceMappingURL=approval-service.d.ts.map