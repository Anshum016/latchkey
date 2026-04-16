export type NotificationChannelKind = "slack" | "email";
export type ToolNameMode = "transparent" | "prefixed";
export type PolicyApprovalMode = "none" | "required" | "block";
export type UpstreamTransportKind = "stdio" | "docker";
export type PolicyMatchScalar = string | number | boolean | null;

export interface DockerMountConfig {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean | undefined;
}

export interface StdioUpstreamServerConfig {
  name: string;
  transport?: "stdio" | undefined;
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
}

export interface DockerUpstreamServerConfig {
  name: string;
  transport: "docker";
  image: string;
  command?: string | undefined;
  args: string[];
  env?: Record<string, string> | undefined;
  containerArgs?: string[] | undefined;
  mounts?: DockerMountConfig[] | undefined;
  containerCwd?: string | undefined;
  passWorkspace?: boolean | undefined;
  workspaceMountPath?: string | undefined;
}

export type UpstreamServerConfig = StdioUpstreamServerConfig | DockerUpstreamServerConfig;

export interface PolicyParamCondition {
  path: string;
  equals?: PolicyMatchScalar | undefined;
  notEquals?: PolicyMatchScalar | undefined;
  regex?: string | undefined;
  glob?: string | undefined;
  contains?: string | undefined;
  exists?: boolean | undefined;
}

export interface PolicyRule {
  action?: string | undefined;
  tool?: string | undefined;
  upstream?: string | undefined;
  params?: PolicyParamCondition[] | undefined;
  approval: PolicyApprovalMode;
  reason?: string | undefined;
}

export interface LatchkeyConfig {
  channel: NotificationChannelKind;
  slackWebhookUrl?: string | undefined;
  resendApiKey?: string | undefined;
  userEmail?: string | undefined;
  emailFrom?: string | undefined;
  webhookBaseUrl: string;
  timeoutMs: number;
  databasePath: string;
  upstreamServers: UpstreamServerConfig[];
  rules: PolicyRule[];
  toolNameMode: ToolNameMode;
}

export interface SecurityRule {
  pattern: string;
  scoreDelta: number;
  reason: string;
}

export interface RiskContext {
  toolName: string;
  payload: Record<string, unknown>;
  sessionTask?: string;
  callCount?: number;
  sessionAgeMs?: number;
  now?: Date;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  max: number;
  reason: string;
}

export type RiskLevel = "low" | "high" | "critical";
export type RiskAction = "approve" | "notify" | "block";

export interface RiskResult {
  score: number;
  level: RiskLevel;
  action: RiskAction;
  breakdown: DimensionScore[];
  explanation: string;
}

export type ApprovalDecision = "allow" | "deny";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "timed_out"
  | "auto_blocked"
  | "executed"
  | "execution_failed";

export interface ApprovalRequest {
  token: string;
  code: string;
  toolName: string;
  params: Record<string, unknown>;
  riskScore: number;
  riskLevel: RiskLevel;
  riskAction: RiskAction;
  explanation: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  decision: ApprovalDecision | null;
  decisionSource: string | null;
}

export type AuditEventType =
  | "intercepted"
  | "notified"
  | "approved"
  | "denied"
  | "timed_out"
  | "auto_blocked"
  | "executed"
  | "execution_failed";

export interface AuditEvent {
  id: number;
  token: string;
  eventType: AuditEventType;
  channel: string | null;
  message: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface CreateApprovalRequestInput {
  toolName: string;
  params: Record<string, unknown>;
  risk: RiskResult;
  timeoutMs: number;
  status?: ApprovalStatus;
  decision?: ApprovalDecision | null;
  decisionSource?: string | null;
}

export interface CreateAuditEventInput {
  token: string;
  eventType: AuditEventType;
  channel?: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt?: number;
}

export interface UpdateRequestStatusOptions {
  decision?: ApprovalDecision | null;
  decisionSource?: string | null;
  resolvedAt?: number | null;
}

export interface RequestMutationResult {
  request: ApprovalRequest | null;
  updated: boolean;
}

export interface ApprovalStore {
  init(): void;
  close(): void;
  createRequest(input: CreateApprovalRequestInput): ApprovalRequest;
  getRequest(identifier: string): ApprovalRequest | null;
  getRequestByToken(token: string): ApprovalRequest | null;
  listPendingRequests(): ApprovalRequest[];
  updateRequestStatus(
    token: string,
    status: ApprovalStatus,
    options?: UpdateRequestStatusOptions
  ): ApprovalRequest | null;
  resolveRequest(identifier: string, decision: ApprovalDecision, source: string): RequestMutationResult;
  timeoutRequest(token: string): RequestMutationResult;
  appendAuditEvent(event: CreateAuditEventInput): void;
  listAuditEvents(token: string): AuditEvent[];
}

export interface NotificationDispatchPayload {
  request: ApprovalRequest;
  risk: RiskResult;
  webhookBaseUrl: string;
  timeoutMs: number;
}

export interface NotificationChannel {
  readonly kind: NotificationChannelKind;
  sendApprovalRequest(payload: NotificationDispatchPayload): Promise<void>;
  sendAutoBlocked(payload: NotificationDispatchPayload): Promise<void>;
}

export interface ApprovalExecutionInput<T> {
  toolName: string;
  params: Record<string, unknown>;
  risk: RiskResult;
  timeoutMs: number;
  decisionSource?: string;
  execute: () => Promise<T>;
}

export interface ApprovalExecutionResult<T> {
  status: ApprovalStatus;
  request: ApprovalRequest;
  result?: T;
  error?: unknown;
}
