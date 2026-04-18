import type { ApprovalDecision, ApprovalRequest, LatchkeyConfig, NotificationChannel, NotificationChannelKind, NotificationDispatchPayload, RiskResult } from "./types.js";
export interface ParsedWhatsAppDecision {
    decision: ApprovalDecision;
    code: string;
}
export declare class NotificationError extends Error {
    constructor(message: string);
}
export declare function parseWhatsAppDecision(message: string): ParsedWhatsAppDecision | null;
export declare class NotificationService {
    private readonly channel;
    readonly kind: NotificationChannelKind;
    constructor(channel: NotificationChannel);
    sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void>;
    sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void>;
}
export declare function createNotificationService(config: LatchkeyConfig): NotificationService;
export declare function buildNotificationPreview(request: ApprovalRequest, risk: RiskResult, timeoutMs: number): string;
//# sourceMappingURL=notification.d.ts.map