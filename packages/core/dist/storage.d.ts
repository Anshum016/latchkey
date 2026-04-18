import type { ApprovalDecision, ApprovalRequest, ApprovalStatus, ApprovalStore, AuditEvent, CreateApprovalRequestInput, CreateAuditEventInput, RequestMutationResult, UpdateRequestStatusOptions } from "./types.js";
export declare class SQLiteApprovalStore implements ApprovalStore {
    private readonly databasePath;
    private db;
    constructor(databasePath: string);
    init(): void;
    close(): void;
    createRequest(input: CreateApprovalRequestInput): ApprovalRequest;
    getRequest(identifier: string): ApprovalRequest | null;
    getRequestByToken(token: string): ApprovalRequest | null;
    listPendingRequests(): ApprovalRequest[];
    updateRequestStatus(token: string, status: ApprovalStatus, options?: UpdateRequestStatusOptions): ApprovalRequest | null;
    resolveRequest(identifier: string, decision: ApprovalDecision, source: string): RequestMutationResult;
    timeoutRequest(token: string): RequestMutationResult;
    appendAuditEvent(event: CreateAuditEventInput): void;
    listAuditEvents(token: string): AuditEvent[];
    private getDb;
    private requireRequest;
    private runMigrations;
    private migrateLegacyTables;
    private tableExists;
    private getMetadata;
    private setMetadata;
    private generateUniqueCode;
    private mapApprovalRequest;
    private safeParseJson;
    private legacyStatusForDecision;
}
//# sourceMappingURL=storage.d.ts.map