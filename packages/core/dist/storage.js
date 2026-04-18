import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const FINAL_STATUSES = new Set([
    "approved",
    "denied",
    "timed_out",
    "auto_blocked",
    "executed",
    "execution_failed"
]);
export class SQLiteApprovalStore {
    databasePath;
    db = null;
    constructor(databasePath) {
        this.databasePath = databasePath;
    }
    init() {
        const directory = path.dirname(this.databasePath);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        this.db = new Database(this.databasePath);
        this.db.pragma("journal_mode = WAL");
        this.runMigrations();
    }
    close() {
        this.db?.close();
        this.db = null;
    }
    createRequest(input) {
        const db = this.getDb();
        const now = Date.now();
        const token = crypto.randomUUID();
        const code = this.generateUniqueCode();
        const status = input.status ?? "pending";
        const decision = input.decision ?? null;
        const decisionSource = input.decisionSource ?? null;
        const resolvedAt = FINAL_STATUSES.has(status) ? now : null;
        db.prepare(`
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
      `).run({
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
    getRequest(identifier) {
        const row = this.getDb()
            .prepare(`
          SELECT *
          FROM approval_requests
          WHERE token = ? OR code = UPPER(?)
          LIMIT 1
        `)
            .get(identifier, identifier);
        return row ? this.mapApprovalRequest(row) : null;
    }
    getRequestByToken(token) {
        const row = this.getDb()
            .prepare(`
          SELECT *
          FROM approval_requests
          WHERE token = ?
          LIMIT 1
        `)
            .get(token);
        return row ? this.mapApprovalRequest(row) : null;
    }
    listPendingRequests() {
        const rows = this.getDb()
            .prepare(`
          SELECT *
          FROM approval_requests
          WHERE status = 'pending'
          ORDER BY created_at DESC
        `)
            .all();
        return rows.map((row) => this.mapApprovalRequest(row));
    }
    updateRequestStatus(token, status, options = {}) {
        const current = this.getRequestByToken(token);
        if (!current) {
            return null;
        }
        const nextResolvedAt = options.resolvedAt !== undefined
            ? options.resolvedAt
            : FINAL_STATUSES.has(status)
                ? current.resolvedAt ?? Date.now()
                : current.resolvedAt;
        const nextDecision = options.decision !== undefined ? options.decision : current.decision;
        const nextDecisionSource = options.decisionSource !== undefined ? options.decisionSource : current.decisionSource;
        this.getDb()
            .prepare(`
          UPDATE approval_requests
          SET status = @status,
              resolved_at = @resolved_at,
              decision = @decision,
              decision_source = @decision_source
          WHERE token = @token
        `)
            .run({
            token,
            status,
            resolved_at: nextResolvedAt,
            decision: nextDecision,
            decision_source: nextDecisionSource
        });
        return this.requireRequest(token);
    }
    resolveRequest(identifier, decision, source) {
        const current = this.getRequest(identifier);
        if (!current) {
            return { request: null, updated: false };
        }
        if (current.status !== "pending") {
            return { request: current, updated: false };
        }
        const nextStatus = decision === "allow" ? "approved" : "denied";
        const request = this.updateRequestStatus(current.token, nextStatus, {
            decision,
            decisionSource: source,
            resolvedAt: Date.now()
        });
        return { request, updated: request !== null };
    }
    timeoutRequest(token) {
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
    appendAuditEvent(event) {
        this.getDb()
            .prepare(`
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
        `)
            .run({
            token: event.token,
            event_type: event.eventType,
            channel: event.channel ?? null,
            message: event.message ?? null,
            data_json: JSON.stringify(event.data ?? {}),
            created_at: event.createdAt ?? Date.now()
        });
    }
    listAuditEvents(token) {
        const rows = this.getDb()
            .prepare(`
          SELECT *
          FROM audit_events
          WHERE token = ?
          ORDER BY created_at ASC
        `)
            .all(token);
        return rows.map((row) => ({
            id: row.id,
            token: row.token,
            eventType: row.event_type,
            channel: row.channel,
            message: row.message,
            data: JSON.parse(row.data_json),
            createdAt: row.created_at
        }));
    }
    getDb() {
        if (!this.db) {
            throw new Error("SQLiteApprovalStore not initialized.");
        }
        return this.db;
    }
    requireRequest(token) {
        const request = this.getRequestByToken(token);
        if (!request) {
            throw new Error(`Approval request ${token} was not found.`);
        }
        return request;
    }
    runMigrations() {
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
    migrateLegacyTables() {
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
        const insertRequest = db.prepare(`
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
      `);
        const insertAudit = db.prepare(`
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
      `);
        db.transaction(() => {
            if (hasPending) {
                const pendingRows = db.prepare("SELECT * FROM pending").all();
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
                const auditRows = db.prepare("SELECT * FROM audit").all();
                for (const row of auditRows) {
                    const eventType = row.decision === "allow" ? "approved" : "denied";
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
    tableExists(name) {
        const row = this.getDb()
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(name);
        return row !== undefined;
    }
    getMetadata(key) {
        const row = this.getDb()
            .prepare("SELECT value FROM metadata WHERE key = ?")
            .get(key);
        return row?.value ?? null;
    }
    setMetadata(key, value) {
        this.getDb()
            .prepare(`
          INSERT INTO metadata (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
            .run(key, value);
    }
    generateUniqueCode() {
        const db = this.getDb();
        while (true) {
            const code = crypto.randomBytes(4).toString("hex").toUpperCase();
            const existing = db
                .prepare("SELECT token FROM approval_requests WHERE code = ? LIMIT 1")
                .get(code);
            if (!existing) {
                return code;
            }
        }
    }
    mapApprovalRequest(row) {
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
    safeParseJson(value) {
        try {
            return JSON.parse(value);
        }
        catch {
            return {};
        }
    }
    legacyStatusForDecision(decision, expiresAt) {
        if (decision === "allow") {
            return "approved";
        }
        if (decision === "deny") {
            return "denied";
        }
        return Date.now() >= expiresAt ? "timed_out" : "pending";
    }
}
