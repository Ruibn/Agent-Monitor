export type AgentId = "codex" | "podex" | "claude" | "workbuddy" | "deepseek";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface SourceStatus {
  id: string;
  agent: AgentId;
  label: string;
  root: string;
  status: "live" | "idle" | "unavailable" | "error" | "scanning";
  channel?: string;
  sessions: number;
  tokens: number;
  lastSeenAt?: string;
  error?: string;
}

export interface SessionRow {
  id: string;
  externalId: string;
  agent: AgentId;
  channel: string;
  title: string;
  cwd?: string;
  model?: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  usage: TokenUsage;
}

export interface SeriesPoint {
  bucket: string;
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}

export interface OverviewData {
  usage: TokenUsage;
  sessions: number;
  messages: number;
  activeToday: number;
  cacheRate: number;
  series: SeriesPoint[];
  agents: Array<{
    agent: AgentId;
    sessions: number;
    usage: TokenUsage;
  }>;
  recentSessions: SessionRow[];
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  timestamp: string;
  role: string;
  kind: string;
  content: string;
  model?: string;
}

export interface UsageEvent extends TokenUsage {
  id: string;
  timestamp: string;
  model?: string;
}

export interface SessionDetail extends SessionRow {
  messages: MessageRow[];
  usageEvents: UsageEvent[];
}

export interface HealthData {
  status: "ok" | "scanning" | "error";
  startedAt: string;
  lastScanAt?: string;
  databasePath: string;
  version: string;
}
