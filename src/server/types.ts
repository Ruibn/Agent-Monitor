export const AGENT_IDS = [
  "codex",
  "podex",
  "claude-code",
  "workbuddy",
  "deepseek-harness",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const SOURCE_CHANNELS = [
  "desktop",
  "cli",
  "exec",
  "subagent",
  "sdk",
  "interactive",
  "unknown",
] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

export const SOURCE_STATUSES = [
  "unavailable",
  "discovering",
  "watching",
  "idle",
  "unsupported",
  "error",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const SESSION_STATUSES = ["active", "completed", "unknown", "error"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const USAGE_PROVENANCE = ["reported", "derived", "estimated"] as const;
export type UsageProvenance = (typeof USAGE_PROVENANCE)[number];

export type JsonMetadata = Record<string, unknown>;

export interface Agent {
  id: AgentId;
  label: string;
  status: SourceStatus;
  sourceCount: number;
  lastSeenAt: number | null;
  lastError: string | null;
}

export interface Source {
  id: string;
  agent: AgentId;
  channel: SourceChannel;
  adapter: string;
  rootPath: string;
  canonicalRoot: string;
  status: SourceStatus;
  lastError: string | null;
  discoveredAt: number;
  lastSeenAt: number | null;
  metadata: JsonMetadata;
}

export interface Artifact {
  id: string;
  sourceId: string;
  path: string;
  canonicalPath: string;
  fileIdentity: string | null;
  generation: number;
  cursorBytes: number;
  carry: string;
  size: number;
  mtime: number;
  metadata: JsonMetadata;
}

export interface Session {
  id: string;
  sourceId: string;
  externalId: string;
  agent: AgentId;
  channel: SourceChannel;
  cwd: string | null;
  title: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number | null;
  status: SessionStatus;
  metadata: JsonMetadata;
}

export interface Message {
  id: string;
  sessionId: string;
  eventKey: string;
  ordinal: number;
  timestamp: number | null;
  role: string;
  kind: string;
  content: string;
  metadata: JsonMetadata;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface UsageEvent extends TokenCounts {
  id: string;
  sessionId: string;
  messageId: string | null;
  eventKey: string;
  timestamp: number;
  model: string | null;
  provenance: UsageProvenance;
  metadata: JsonMetadata;
}

export interface SessionListQuery {
  sourceId?: string;
  agent?: AgentId;
  channel?: SourceChannel;
  model?: string;
  query?: string;
  startedAfter?: number;
  startedBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  before?: {
    startedAt: number | null;
    id: string;
  };
  limit?: number;
}

export interface SessionListItem extends Session {
  messageCount: number;
  usageEventCount: number;
  tokens: TokenCounts;
}

export interface SessionDetails {
  session: Session;
  messages: Message[];
  usageEvents: UsageEvent[];
  tokens: TokenCounts;
}

export type UsageGroupBy = "agent" | "channel" | "model" | "day";

export interface UsageSummaryQuery {
  from?: number;
  to?: number;
  sourceId?: string;
  agent?: AgentId;
  channel?: SourceChannel;
  model?: string;
  groupBy?: UsageGroupBy;
}

export interface UsageSummaryRow extends TokenCounts {
  key: string;
  sessionCount: number;
  eventCount: number;
}

export interface HealthCounts {
  sources: number;
  sessions: number;
  messages: number;
  usageEvents: number;
}

export interface HealthSnapshot {
  status: "ok" | "degraded" | "error";
  database: "ok" | "error";
  schemaVersion: number;
  checkedAt: number;
  counts: HealthCounts;
  agents: Agent[];
  sources: Source[];
}

export const ZERO_TOKEN_COUNTS: Readonly<TokenCounts> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});
