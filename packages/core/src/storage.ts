import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalStore,
  AuditEvent,
  AuditEventType,
  CreateApprovalRequestInput,
  CreateAuditEventInput,
  RequestMutationResult,
  UpdateRequestStatusOptions
} from "./types.js";

type MetadataRow = { value: string };
type ApprovalRequestRow = {
  token: string;
  code: string;
  tool_name: string;
  params_json: string;
  risk_score: number;
  risk_level: "low" | "high" | "critical";
  risk_action: "approve" | "notify" | "block";
  explanation: string;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  decision: ApprovalDecision | null;
  decision_source: string | null;
};
type AuditEventRow = {
  id: number;
  token: string;
  event_type: AuditEventType;
  channel: string | null;
  message: string | null;
  data_json: string;
  created_at: number;
};
type LegacyPendingRow = {
  token: string;
  tool: string;
  params: string;
  risk: number;
  decision: string | null;
  created: number;
  expires: number;
};
type LegacyAuditRow = {
  token: string;
  tool: string;
  params: string;
  risk: number;
  decision: string | null;
  channel: string | null;
  ts: number;
};

const FINAL_STATUSES = new Set<ApprovalStatus>([
  "approved",
  "denied",
  "timed_out",
  "auto_blocked",
  "executed",
  "execution_failed"
]);

export class SQLiteApprovalStore implements ApprovalStore {
  private db: Database.Database | null = null;

  public constructor(private readonly databasePath: string) {}

  public init(): void {
    const directory = path.dirname(this.databasePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.runMigrations();
  }

  public close(): void {
    this.db?.close();
    this.db = null;
  }

  public createRequest(input: CreateApprovalRequestInput): ApprovalRequest {
    const db = this.getDb();
    const now = Date.now();
    const token = crypto.randomUUID();
    const code = this.generateUniqueCode();
    const status = input.status ?? "pending";
    const decision = input.decision ?? null;
    const decisionSource = input.decisionSource ?? null;
    const resolvedAt = FINAL_STATUSES.has(status) ? now : null;

    db.prepare(
      `
        INSERT INTO approval_requests (
          token,
          code,
          tool_name,
          params_json,
          risk_score,
          risk_level,
          risk_action,
          explanation,
          status,
          created_at,
          expires_at,
          resolved_at,
          decision,
          decision_source
        ) VALUES (
          @token,
          @code,
          @tool_name,
          @params_json,
          @risk_score,
          @risk_level,
          @risk_action,
          @explanation,
          @status,
          @created_at,
          @expires_at,
          @resolved_at,
          @decision,
          @decision_source
        )
      `
    ).run({
      token,
      code,
      tool_name: input.toolName,
      params_json: JSON.stringify(input.params),
      risk_score: input.risk.score,
      risk_level: input.risk.level,
      risk_action: input.risk.action,
      explanation: input.risk.explanation,
      status,
      created_at: now,
      expires_at: now + input.timeoutMs,
      resolved_at: resolvedAt,
      decision,
      decision_source: decisionSource
    });

    return this.requireRequest(token);
  }

  public getRequest(identifier: string): ApprovalRequest | null {
    const row = this.getDb()
      .prepare(
        `
          SELECT *
          FROM approval_requests
          WHERE token = ? OR code = UPPER(?)
          LIMIT 1
        `
      )
      .get(identifier, identifier) as ApprovalRequestRow | undefined;

    return row ? this.mapApprovalRequest(row) : null;
  }

  public getRequestByToken(token: string): ApprovalRequest | null {
    const row = this.getDb()
      .prepare(
        `
          SELECT *
          FROM approval_requests
          WHERE token = ?
          LIMIT 1
        `
      )
      .get(token) as ApprovalRequestRow | undefined;

    return row ? this.mapApprovalRequest(row) : null;
  }

  public listPendingRequests(): ApprovalRequest[] {
    const rows = this.getDb()
      .prepare(
        `
          SELECT *
          FROM approval_requests
          WHERE status = 'pending'
          ORDER BY created_at DESC
        `
      )
      .all() as ApprovalRequestRow[];

    return rows.map((row) => this.mapApprovalRequest(row));
  }

  public updateRequestStatus(
    token: string,
    status: ApprovalStatus,
    options: UpdateRequestStatusOptions = {}
  ): ApprovalRequest | null {
    const current = this.getRequestByToken(token);
    if (!current) {
      return null;
    }

    const nextResolvedAt =
      options.resolvedAt !== undefined
        ? options.resolvedAt
        : FINAL_STATUSES.has(status)
          ? current.resolvedAt ?? Date.now()
          : current.resolvedAt;

    const nextDecision = options.decision !== undefined ? options.decision : current.decision;
    const nextDecisionSource =
      options.decisionSource !== undefined ? options.decisionSource : current.decisionSource;

    this.getDb()
      .prepare(
        `
          UPDATE approval_requests
          SET status = @status,
              resolved_at = @resolved_at,
              decision = @decision,
              decision_source = @decision_source
          WHERE token = @token
        `
      )
      .run({
        token,
        status,
        resolved_at: nextResolvedAt,
        decision: nextDecision,
        decision_source: nextDecisionSource
      });

    return this.requireRequest(token);
  }

  public resolveRequest(identifier: string, decision: ApprovalDecision, source: string): RequestMutationResult {
    const current = this.getRequest(identifier);
    if (!current) {
      return { request: null, updated: false };
    }

    if (current.status !== "pending") {
      return { request: current, updated: false };
    }

    const nextStatus: ApprovalStatus = decision === "allow" ? "approved" : "denied";
    const request = this.updateRequestStatus(current.token, nextStatus, {
      decision,
      decisionSource: source,
      resolvedAt: Date.now()
    });

    return { request, updated: request !== null };
  }

  public timeoutRequest(token: string): RequestMutationResult {
    const current = this.getRequestByToken(token);
    if (!current) {
      return { request: null, updated: false };
    }

    if (current.status !== "pending") {
      return { request: current, updated: false };
    }

    const request = this.updateRequestStatus(token, "timed_out", {
      decision: "deny",
      decisionSource: "timeout",
      resolvedAt: Date.now()
    });

    return { request, updated: request !== null };
  }

  public appendAuditEvent(event: CreateAuditEventInput): void {
    this.getDb()
      .prepare(
        `
          INSERT INTO audit_events (
            token,
            event_type,
            channel,
            message,
            data_json,
            created_at
          ) VALUES (
            @token,
            @event_type,
            @channel,
            @message,
            @data_json,
            @created_at
          )
        `
      )
      .run({
        token: event.token,
        event_type: event.eventType,
        channel: event.channel ?? null,
        message: event.message ?? null,
        data_json: JSON.stringify(event.data ?? {}),
        created_at: event.createdAt ?? Date.now()
      });
  }

  public listAuditEvents(token: string): AuditEvent[] {
    const rows = this.getDb()
      .prepare(
        `
          SELECT *
          FROM audit_events
          WHERE token = ?
          ORDER BY created_at ASC
        `
      )
      .all(token) as AuditEventRow[];

    return rows.map((row) => ({
      id: row.id,
      token: row.token,
      eventType: row.event_type,
      channel: row.channel,
      message: row.message,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error("SQLiteApprovalStore not initialized.");
    }

    return this.db;
  }

  private requireRequest(token: string): ApprovalRequest {
    const request = this.getRequestByToken(token);
    if (!request) {
      throw new Error(`Approval request ${token} was not found.`);
    }

    return request;
  }

  private runMigrations(): void {
    const db = this.getDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        token TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        tool_name TEXT NOT NULL,
        params_json TEXT NOT NULL,
        risk_score INTEGER NOT NULL,
        risk_level TEXT NOT NULL,
        risk_action TEXT NOT NULL,
        explanation TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        decision TEXT,
        decision_source TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        event_type TEXT NOT NULL,
        channel TEXT,
        message TEXT,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    if (!this.getMetadata("schema_version")) {
      this.setMetadata("schema_version", "1");
    }

    this.migrateLegacyTables();
  }

  private migrateLegacyTables(): void {
    if (this.getMetadata("legacy_migrated") === "1") {
      return;
    }

    const db = this.getDb();
    const hasPending = this.tableExists("pending");
    const hasAudit = this.tableExists("audit");

    if (!hasPending && !hasAudit) {
      this.setMetadata("legacy_migrated", "1");
      return;
    }

    const insertRequest = db.prepare(
      `
        INSERT OR IGNORE INTO approval_requests (
          token,
          code,
          tool_name,
          params_json,
          risk_score,
          risk_level,
          risk_action,
          explanation,
          status,
          created_at,
          expires_at,
          resolved_at,
          decision,
          decision_source
        ) VALUES (
          @token,
          @code,
          @tool_name,
          @params_json,
          @risk_score,
          @risk_level,
          @risk_action,
          @explanation,
          @status,
          @created_at,
          @expires_at,
          @resolved_at,
          @decision,
          @decision_source
        )
      `
    );

    const insertAudit = db.prepare(
      `
        INSERT INTO audit_events (
          token,
          event_type,
          channel,
          message,
          data_json,
          created_at
        ) VALUES (
          @token,
          @event_type,
          @channel,
          @message,
          @data_json,
          @created_at
        )
      `
    );

    db.transaction(() => {
      if (hasPending) {
        const pendingRows = db.prepare("SELECT * FROM pending").all() as LegacyPendingRow[];
        for (const row of pendingRows) {
          const status = this.legacyStatusForDecision(row.decision, row.expires);
          const decision = row.decision === "allow" || row.decision === "deny" ? row.decision : null;
          const resolvedAt = decision || status === "timed_out" ? row.expires : null;
          const score = row.risk;

          insertRequest.run({
            token: row.token,
            code: row.token.slice(0, 8).toUpperCase(),
            tool_name: row.tool,
            params_json: row.params,
            risk_score: score,
            risk_level: score >= 65 ? "critical" : score >= 30 ? "high" : "low",
            risk_action: score >= 65 ? "block" : score >= 30 ? "notify" : "approve",
            explanation: "Migrated legacy request",
            status,
            created_at: row.created,
            expires_at: row.expires,
            resolved_at: resolvedAt,
            decision,
            decision_source: decision ? "legacy" : status === "timed_out" ? "timeout" : null
          });
        }
      }

      if (hasAudit) {
        const auditRows = db.prepare("SELECT * FROM audit").all() as LegacyAuditRow[];
        for (const row of auditRows) {
          const eventType: AuditEventType = row.decision === "allow" ? "approved" : "denied";
          insertAudit.run({
            token: row.token,
            event_type: eventType,
            channel: row.channel,
            message: "Migrated legacy audit event",
            data_json: JSON.stringify({
              toolName: row.tool,
              riskScore: row.risk,
              decision: row.decision,
              params: this.safeParseJson(row.params)
            }),
            created_at: row.ts
          });
        }
      }
    })();

    this.setMetadata("legacy_migrated", "1");
  }

  private tableExists(name: string): boolean {
    const row = this.getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { name: string } | undefined;

    return row !== undefined;
  }

  private getMetadata(key: string): string | null {
    const row = this.getDb()
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key) as MetadataRow | undefined;

    return row?.value ?? null;
  }

  private setMetadata(key: string, value: string): void {
    this.getDb()
      .prepare(
        `
          INSERT INTO metadata (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `
      )
      .run(key, value);
  }

  private generateUniqueCode(): string {
    const db = this.getDb();

    while (true) {
      const code = crypto.randomBytes(4).toString("hex").toUpperCase();
      const existing = db
        .prepare("SELECT token FROM approval_requests WHERE code = ? LIMIT 1")
        .get(code) as { token: string } | undefined;

      if (!existing) {
        return code;
      }
    }
  }

  private mapApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
    return {
      token: row.token,
      code: row.code,
      toolName: row.tool_name,
      params: this.safeParseJson(row.params_json),
      riskScore: row.risk_score,
      riskLevel: row.risk_level,
      riskAction: row.risk_action,
      explanation: row.explanation,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
      decision: row.decision,
      decisionSource: row.decision_source
    };
  }

  private safeParseJson(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private legacyStatusForDecision(decision: string | null, expiresAt: number): ApprovalStatus {
    if (decision === "allow") {
      return "approved";
    }

    if (decision === "deny") {
      return "denied";
    }

    return Date.now() >= expiresAt ? "timed_out" : "pending";
  }
}
