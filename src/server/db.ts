import { DatabaseSync } from "node:sqlite";

import {
  AGENT_IDS,
  ZERO_TOKEN_COUNTS,
  type Agent,
  type AgentId,
  type Artifact,
  type HealthCounts,
  type HealthSnapshot,
  type JsonMetadata,
  type Message,
  type Session,
  type SessionDetails,
  type SessionListItem,
  type SessionListQuery,
  type Source,
  type SourceStatus,
  type TokenCounts,
  type UsageEvent,
  type UsageGroupBy,
  type UsageSummaryQuery,
  type UsageSummaryRow,
} from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, unknown>;
type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

const AGENT_LABELS: Record<AgentId, string> = {
  codex: "Codex",
  podex: "Podex",
  "claude-code": "Claude Code",
  workbuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek Harness",
};

const migrations = [
  {
    version: 1,
    name: "initial agent monitor schema",
    sql: `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL CHECK (agent IN ('codex', 'podex', 'claude-code', 'workbuddy', 'deepseek-harness')),
        channel TEXT NOT NULL CHECK (channel IN ('desktop', 'cli', 'exec', 'subagent', 'sdk', 'interactive', 'unknown')),
        adapter TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unavailable', 'discovering', 'watching', 'idle', 'unsupported', 'error')),
        last_error TEXT,
        discovered_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (adapter, canonical_root)
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        file_identity TEXT,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        cursor_bytes INTEGER NOT NULL DEFAULT 0 CHECK (cursor_bytes >= 0),
        carry TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
        mtime INTEGER NOT NULL DEFAULT 0 CHECK (mtime >= 0),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (source_id, canonical_path)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('codex', 'podex', 'claude-code', 'workbuddy', 'deepseek-harness')),
        channel TEXT NOT NULL CHECK (channel IN ('desktop', 'cli', 'exec', 'subagent', 'sdk', 'interactive', 'unknown')),
        cwd TEXT,
        title TEXT,
        model TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'unknown', 'error')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (source_id, external_id)
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        timestamp INTEGER,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (session_id, event_key)
      );

      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        event_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(input_tokens) = 'integer' AND input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(output_tokens) = 'integer' AND output_tokens >= 0),
        reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reasoning_tokens) = 'integer' AND reasoning_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cache_write_tokens) = 'integer' AND cache_write_tokens >= 0),
        total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total_tokens) = 'integer' AND total_tokens >= 0),
        provenance TEXT NOT NULL CHECK (provenance IN ('reported', 'derived', 'estimated')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (session_id, event_key)
      );

      CREATE INDEX idx_artifacts_source ON artifacts(source_id);
      CREATE INDEX idx_sessions_started ON sessions(started_at DESC, id DESC);
      CREATE INDEX idx_sessions_agent_channel ON sessions(agent, channel);
      CREATE INDEX idx_messages_session_order ON messages(session_id, ordinal, timestamp);
      CREATE INDEX idx_usage_session_time ON usage_events(session_id, timestamp);
      CREATE INDEX idx_usage_time ON usage_events(timestamp);
    `,
  },
  {
    version: 2,
    name: "track session activity time",
    sql: `
      ALTER TABLE sessions ADD COLUMN updated_at INTEGER;
      UPDATE sessions
      SET updated_at = COALESCE(ended_at, started_at)
      WHERE updated_at IS NULL;
      CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC, id DESC);
    `,
  },
] as const;

function metadataToJson(metadata: JsonMetadata): string {
  return JSON.stringify(metadata ?? {});
}

function jsonToMetadata(value: unknown): JsonMetadata {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonMetadata)
      : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : numberValue(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function tokenCountsFromRow(row?: SqlRow): TokenCounts {
  if (!row) return { ...ZERO_TOKEN_COUNTS };
  return {
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    reasoningTokens: numberValue(row.reasoning_tokens),
    cacheReadTokens: numberValue(row.cache_read_tokens),
    cacheWriteTokens: numberValue(row.cache_write_tokens),
    totalTokens: numberValue(row.total_tokens),
  };
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertNullableInteger(value: number | null, name: string): void {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer or null`);
  }
}

function assertTokenCounts(value: TokenCounts): void {
  assertNonNegativeInteger(value.inputTokens, "inputTokens");
  assertNonNegativeInteger(value.outputTokens, "outputTokens");
  assertNonNegativeInteger(value.reasoningTokens, "reasoningTokens");
  assertNonNegativeInteger(value.cacheReadTokens, "cacheReadTokens");
  assertNonNegativeInteger(value.cacheWriteTokens, "cacheWriteTokens");
  assertNonNegativeInteger(value.totalTokens, "totalTokens");
}

function mapSource(row: SqlRow): Source {
  return {
    id: String(row.id),
    agent: String(row.agent) as Source["agent"],
    channel: String(row.channel) as Source["channel"],
    adapter: String(row.adapter),
    rootPath: String(row.root_path),
    canonicalRoot: String(row.canonical_root),
    status: String(row.status) as Source["status"],
    lastError: nullableString(row.last_error),
    discoveredAt: numberValue(row.discovered_at),
    lastSeenAt: nullableNumber(row.last_seen_at),
    metadata: jsonToMetadata(row.metadata_json),
  };
}

function mapArtifact(row: SqlRow): Artifact {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    path: String(row.path),
    canonicalPath: String(row.canonical_path),
    fileIdentity: nullableString(row.file_identity),
    generation: numberValue(row.generation),
    cursorBytes: numberValue(row.cursor_bytes),
    carry: String(row.carry ?? ""),
    size: numberValue(row.size),
    mtime: numberValue(row.mtime),
    metadata: jsonToMetadata(row.metadata_json),
  };
}

function mapSession(row: SqlRow): Session {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    externalId: String(row.external_id),
    agent: String(row.agent) as Session["agent"],
    channel: String(row.channel) as Session["channel"],
    cwd: nullableString(row.cwd),
    title: nullableString(row.title),
    model: nullableString(row.model),
    startedAt: nullableNumber(row.started_at),
    endedAt: nullableNumber(row.ended_at),
    updatedAt: nullableNumber(row.updated_at),
    status: String(row.status) as Session["status"],
    metadata: jsonToMetadata(row.metadata_json),
  };
}

function mapMessage(row: SqlRow): Message {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    eventKey: String(row.event_key),
    ordinal: numberValue(row.ordinal),
    timestamp: nullableNumber(row.timestamp),
    role: String(row.role),
    kind: String(row.kind),
    content: String(row.content),
    metadata: jsonToMetadata(row.metadata_json),
  };
}

function mapUsageEvent(row: SqlRow): UsageEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: nullableString(row.message_id),
    eventKey: String(row.event_key),
    timestamp: numberValue(row.timestamp),
    model: nullableString(row.model),
    ...tokenCountsFromRow(row),
    provenance: String(row.provenance) as UsageEvent["provenance"],
    metadata: jsonToMetadata(row.metadata_json),
  };
}

function aggregateAgentStatus(sources: Source[]): SourceStatus {
  if (sources.length === 0) return "unavailable";
  if (sources.some((source) => source.status === "error")) return "error";
  if (sources.some((source) => source.status === "watching")) return "watching";
  if (sources.some((source) => source.status === "discovering")) return "discovering";
  if (sources.every((source) => source.status === "unsupported")) return "unsupported";
  return "idle";
}

export class MonitorDatabase {
  readonly connection: DatabaseSync;
  private readonly statementCache = new Map<string, PreparedStatement>();

  constructor(filename = ":memory:") {
    this.connection = new DatabaseSync(filename);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private prepare(sql: string): PreparedStatement {
    const cached = this.statementCache.get(sql);
    if (cached) return cached;
    const statement = this.connection.prepare(sql);
    this.statementCache.set(sql, statement);
    return statement;
  }

  close(): void {
    this.connection.close();
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const appliedRows = this.connection
      .prepare("SELECT version FROM schema_migrations")
      .all() as SqlRow[];
    const applied = new Set(appliedRows.map((row) => numberValue(row.version)));

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.connection.exec("BEGIN IMMEDIATE");
      try {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
        this.connection.exec("COMMIT");
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
    }
  }

  getSchemaVersion(): number {
    const row = this.connection
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as SqlRow;
    return numberValue(row.version);
  }

  upsertSource(source: Source): Source {
    assertNonEmpty(source.id, "source.id");
    assertNonEmpty(source.adapter, "source.adapter");
    assertNonEmpty(source.canonicalRoot, "source.canonicalRoot");
    assertNonNegativeInteger(source.discoveredAt, "source.discoveredAt");
    assertNullableInteger(source.lastSeenAt, "source.lastSeenAt");

    this.connection
      .prepare(`
        INSERT INTO sources (
          id, agent, channel, adapter, root_path, canonical_root, status,
          last_error, discovered_at, last_seen_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (adapter, canonical_root) DO UPDATE SET
          agent = excluded.agent,
          channel = excluded.channel,
          root_path = excluded.root_path,
          status = excluded.status,
          last_error = excluded.last_error,
          discovered_at = MIN(sources.discovered_at, excluded.discovered_at),
          last_seen_at = CASE
            WHEN excluded.last_seen_at IS NULL THEN sources.last_seen_at
            WHEN sources.last_seen_at IS NULL THEN excluded.last_seen_at
            ELSE MAX(sources.last_seen_at, excluded.last_seen_at)
          END,
          metadata_json = excluded.metadata_json
      `)
      .run(
        source.id,
        source.agent,
        source.channel,
        source.adapter,
        source.rootPath,
        source.canonicalRoot,
        source.status,
        source.lastError,
        source.discoveredAt,
        source.lastSeenAt,
        metadataToJson(source.metadata),
      );

    const stored = this.connection
      .prepare("SELECT * FROM sources WHERE adapter = ? AND canonical_root = ?")
      .get(source.adapter, source.canonicalRoot) as SqlRow;
    return mapSource(stored);
  }

  getSource(id: string): Source | null {
    const row = this.connection.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? mapSource(row) : null;
  }

  listSources(): Source[] {
    return (
      this.connection
        .prepare("SELECT * FROM sources ORDER BY agent, channel, canonical_root")
        .all() as SqlRow[]
    ).map(mapSource);
  }

  upsertArtifact(artifact: Artifact): Artifact {
    assertNonEmpty(artifact.id, "artifact.id");
    assertNonEmpty(artifact.canonicalPath, "artifact.canonicalPath");
    assertNonNegativeInteger(artifact.generation, "artifact.generation");
    assertNonNegativeInteger(artifact.cursorBytes, "artifact.cursorBytes");
    assertNonNegativeInteger(artifact.size, "artifact.size");
    assertNonNegativeInteger(artifact.mtime, "artifact.mtime");

    this.connection
      .prepare(`
        INSERT INTO artifacts (
          id, source_id, path, canonical_path, file_identity, generation,
          cursor_bytes, carry, size, mtime, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id, canonical_path) DO UPDATE SET
          path = excluded.path,
          file_identity = excluded.file_identity,
          generation = excluded.generation,
          cursor_bytes = excluded.cursor_bytes,
          carry = excluded.carry,
          size = excluded.size,
          mtime = excluded.mtime,
          metadata_json = excluded.metadata_json
      `)
      .run(
        artifact.id,
        artifact.sourceId,
        artifact.path,
        artifact.canonicalPath,
        artifact.fileIdentity,
        artifact.generation,
        artifact.cursorBytes,
        artifact.carry,
        artifact.size,
        artifact.mtime,
        metadataToJson(artifact.metadata),
      );

    const stored = this.connection
      .prepare("SELECT * FROM artifacts WHERE source_id = ? AND canonical_path = ?")
      .get(artifact.sourceId, artifact.canonicalPath) as SqlRow;
    return mapArtifact(stored);
  }

  getArtifact(id: string): Artifact | null {
    const row = this.connection.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? mapArtifact(row) : null;
  }

  upsertSession(session: Session, readBack = true): Session {
    assertNonEmpty(session.id, "session.id");
    assertNonEmpty(session.externalId, "session.externalId");
    assertNullableInteger(session.startedAt, "session.startedAt");
    assertNullableInteger(session.endedAt, "session.endedAt");
    assertNullableInteger(session.updatedAt, "session.updatedAt");

    this.prepare(`
        INSERT INTO sessions (
          id, source_id, external_id, agent, channel, cwd, title, model,
          started_at, ended_at, updated_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          agent = excluded.agent,
          channel = excluded.channel,
          cwd = COALESCE(excluded.cwd, sessions.cwd),
          title = COALESCE(excluded.title, sessions.title),
          model = COALESCE(excluded.model, sessions.model),
          started_at = CASE
            WHEN excluded.started_at IS NULL THEN sessions.started_at
            WHEN sessions.started_at IS NULL THEN excluded.started_at
            ELSE MIN(sessions.started_at, excluded.started_at)
          END,
          ended_at = CASE
            WHEN excluded.ended_at IS NULL THEN sessions.ended_at
            WHEN sessions.ended_at IS NULL THEN excluded.ended_at
            ELSE MAX(sessions.ended_at, excluded.ended_at)
          END,
          updated_at = CASE
            WHEN excluded.updated_at IS NULL THEN sessions.updated_at
            WHEN sessions.updated_at IS NULL THEN excluded.updated_at
            ELSE MAX(sessions.updated_at, excluded.updated_at)
          END,
          status = excluded.status,
          metadata_json = json_patch(sessions.metadata_json, excluded.metadata_json)
      `).run(
        session.id,
        session.sourceId,
        session.externalId,
        session.agent,
        session.channel,
        session.cwd,
        session.title,
        session.model,
        session.startedAt,
        session.endedAt,
        session.updatedAt,
        session.status,
        metadataToJson(session.metadata),
      );

    if (!readBack) return session;

    const stored = this.prepare("SELECT * FROM sessions WHERE source_id = ? AND external_id = ?")
      .get(session.sourceId, session.externalId) as SqlRow;
    return mapSession(stored);
  }

  getSession(id: string): Session | null {
    const row = this.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SqlRow
      | undefined;
    return row ? mapSession(row) : null;
  }

  touchSession(id: string, updatedAt: number): void {
    assertNonNegativeInteger(updatedAt, "session.updatedAt");
    this.prepare(`
        UPDATE sessions
        SET updated_at = CASE
          WHEN updated_at IS NULL THEN ?
          ELSE MAX(updated_at, ?)
        END
        WHERE id = ?
      `).run(updatedAt, updatedAt, id);
  }

  upsertMessage(message: Message, readBack = true): Message {
    assertNonEmpty(message.id, "message.id");
    assertNonEmpty(message.eventKey, "message.eventKey");
    assertNonNegativeInteger(message.ordinal, "message.ordinal");
    assertNullableInteger(message.timestamp, "message.timestamp");

    this.prepare(`
        INSERT INTO messages (
          id, session_id, event_key, ordinal, timestamp, role, kind, content, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id, event_key) DO UPDATE SET
          ordinal = excluded.ordinal,
          timestamp = COALESCE(excluded.timestamp, messages.timestamp),
          role = excluded.role,
          kind = excluded.kind,
          content = excluded.content,
          metadata_json = excluded.metadata_json
      `).run(
        message.id,
        message.sessionId,
        message.eventKey,
        message.ordinal,
        message.timestamp,
        message.role,
        message.kind,
        message.content,
        metadataToJson(message.metadata),
      );

    if (!readBack) return message;

    const stored = this.prepare("SELECT * FROM messages WHERE session_id = ? AND event_key = ?")
      .get(message.sessionId, message.eventKey) as SqlRow;
    return mapMessage(stored);
  }

  upsertUsageEvent(event: UsageEvent, readBack = true): UsageEvent {
    assertNonEmpty(event.id, "usageEvent.id");
    assertNonEmpty(event.eventKey, "usageEvent.eventKey");
    assertNonNegativeInteger(event.timestamp, "usageEvent.timestamp");
    assertTokenCounts(event);

    this.prepare(`
        INSERT INTO usage_events (
          id, session_id, message_id, event_key, timestamp, model,
          input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, provenance, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id, event_key) DO UPDATE SET
          message_id = COALESCE(excluded.message_id, usage_events.message_id),
          timestamp = excluded.timestamp,
          model = COALESCE(excluded.model, usage_events.model),
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          total_tokens = excluded.total_tokens,
          provenance = excluded.provenance,
          metadata_json = excluded.metadata_json
      `).run(
        event.id,
        event.sessionId,
        event.messageId,
        event.eventKey,
        event.timestamp,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.reasoningTokens,
        event.cacheReadTokens,
        event.cacheWriteTokens,
        event.totalTokens,
        event.provenance,
        metadataToJson(event.metadata),
      );

    if (!readBack) return event;

    const stored = this.prepare("SELECT * FROM usage_events WHERE session_id = ? AND event_key = ?")
      .get(event.sessionId, event.eventKey) as SqlRow;
    return mapUsageEvent(stored);
  }

  listSessions(query: SessionListQuery = {}): SessionListItem[] {
    const clauses: string[] = [];
    const params: SqlValue[] = [];

    if (query.sourceId) {
      clauses.push("s.source_id = ?");
      params.push(query.sourceId);
    }
    if (query.agent) {
      clauses.push("s.agent = ?");
      params.push(query.agent);
    }
    if (query.channel) {
      clauses.push("s.channel = ?");
      params.push(query.channel);
    }
    if (query.model) {
      clauses.push("s.model = ?");
      params.push(query.model);
    }
    if (query.query?.trim()) {
      const pattern = `%${query.query.trim()}%`;
      clauses.push("(s.title LIKE ? OR s.cwd LIKE ? OR s.external_id LIKE ?)");
      params.push(pattern, pattern, pattern);
    }
    if (query.startedAfter !== undefined) {
      clauses.push("s.started_at >= ?");
      params.push(query.startedAfter);
    }
    if (query.startedBefore !== undefined) {
      clauses.push("s.started_at < ?");
      params.push(query.startedBefore);
    }
    if (query.updatedAfter !== undefined) {
      clauses.push("COALESCE(s.updated_at, s.started_at, -1) >= ?");
      params.push(query.updatedAfter);
    }
    if (query.updatedBefore !== undefined) {
      clauses.push("COALESCE(s.updated_at, s.started_at, -1) < ?");
      params.push(query.updatedBefore);
    }
    if (query.before) {
      const cursorTime = query.before.startedAt ?? -1;
      clauses.push("(COALESCE(s.started_at, -1) < ? OR (COALESCE(s.started_at, -1) = ? AND s.id < ?))");
      params.push(cursorTime, cursorTime, query.before.id);
    }

    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.connection
      .prepare(`
        SELECT
          s.*,
          COALESCE(mc.message_count, 0) AS message_count,
          COALESCE(uc.usage_event_count, 0) AS usage_event_count,
          COALESCE(uc.input_tokens, 0) AS input_tokens,
          COALESCE(uc.output_tokens, 0) AS output_tokens,
          COALESCE(uc.reasoning_tokens, 0) AS reasoning_tokens,
          COALESCE(uc.cache_read_tokens, 0) AS cache_read_tokens,
          COALESCE(uc.cache_write_tokens, 0) AS cache_write_tokens,
          COALESCE(uc.total_tokens, 0) AS total_tokens,
          (
            SELECT substr(m2.content, 1, 160)
            FROM messages m2
            WHERE m2.session_id = s.id
              AND m2.role = 'user'
              AND length(trim(m2.content)) > 0
            ORDER BY m2.ordinal, COALESCE(m2.timestamp, 0), m2.id
            LIMIT 1
          ) AS derived_title
        FROM sessions s
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS message_count
          FROM messages
          GROUP BY session_id
        ) mc ON mc.session_id = s.id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*) AS usage_event_count,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(total_tokens) AS total_tokens
          FROM usage_events
          GROUP BY session_id
        ) uc ON uc.session_id = s.id
        ${where}
        ORDER BY COALESCE(s.updated_at, s.started_at, -1) DESC, s.id DESC
        LIMIT ?
      `)
      .all(...params) as SqlRow[];

    return rows.map((row) => {
      const session = mapSession(row);
      if (!session.title && row.derived_title) {
        session.title = String(row.derived_title).replace(/\s+/g, " ").trim();
      }
      return {
        ...session,
        messageCount: numberValue(row.message_count),
        usageEventCount: numberValue(row.usage_event_count),
        tokens: tokenCountsFromRow(row),
      };
    });
  }

  listMessages(sessionId: string): Message[] {
    return (
      this.connection
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal, COALESCE(timestamp, 0), id")
        .all(sessionId) as SqlRow[]
    ).map(mapMessage);
  }

  listUsageEvents(sessionId: string): UsageEvent[] {
    return (
      this.connection
        .prepare("SELECT * FROM usage_events WHERE session_id = ? ORDER BY timestamp, id")
        .all(sessionId) as SqlRow[]
    ).map(mapUsageEvent);
  }

  getSessionDetails(id: string): SessionDetails | null {
    const session = this.getSession(id);
    if (!session) return null;
    const messages = this.listMessages(id);
    const usageEvents = this.listUsageEvents(id);
    if (!session.title) {
      const firstUser = messages.find(
        (message) => message.role === "user" && message.content.trim().length > 0,
      );
      if (firstUser) {
        session.title = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 160);
      }
    }
    const totalsRow = this.connection
      .prepare(`
        SELECT
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM usage_events
        WHERE session_id = ?
      `)
      .get(id) as SqlRow;

    return { session, messages, usageEvents, tokens: tokenCountsFromRow(totalsRow) };
  }

  summarizeUsage(query: UsageSummaryQuery = {}): UsageSummaryRow[] {
    const groupBy: UsageGroupBy = query.groupBy ?? "agent";
    const groupExpressions: Record<UsageGroupBy, string> = {
      agent: "s.agent",
      channel: "s.channel",
      model: "COALESCE(NULLIF(u.model, ''), NULLIF(s.model, ''), 'unknown')",
      day: "strftime('%Y-%m-%d', u.timestamp / 1000, 'unixepoch')",
    };
    const groupExpression = groupExpressions[groupBy];
    const clauses: string[] = [];
    const params: SqlValue[] = [];

    if (query.from !== undefined) {
      clauses.push("u.timestamp >= ?");
      params.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push("u.timestamp < ?");
      params.push(query.to);
    }
    if (query.sourceId) {
      clauses.push("s.source_id = ?");
      params.push(query.sourceId);
    }
    if (query.agent) {
      clauses.push("s.agent = ?");
      params.push(query.agent);
    }
    if (query.channel) {
      clauses.push("s.channel = ?");
      params.push(query.channel);
    }
    if (query.model) {
      clauses.push("COALESCE(NULLIF(u.model, ''), NULLIF(s.model, ''), 'unknown') = ?");
      params.push(query.model);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.connection
      .prepare(`
        SELECT
          ${groupExpression} AS group_key,
          COUNT(DISTINCT s.id) AS session_count,
          COUNT(*) AS event_count,
          COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(u.total_tokens), 0) AS total_tokens
        FROM usage_events u
        JOIN sessions s ON s.id = u.session_id
        ${where}
        GROUP BY ${groupExpression}
        ORDER BY group_key
      `)
      .all(...params) as SqlRow[];

    return rows.map((row) => ({
      key: String(row.group_key ?? "unknown"),
      sessionCount: numberValue(row.session_count),
      eventCount: numberValue(row.event_count),
      ...tokenCountsFromRow(row),
    }));
  }

  getHealth(): HealthSnapshot {
    let database: HealthSnapshot["database"] = "ok";
    try {
      const row = this.connection.prepare("PRAGMA quick_check").get() as SqlRow;
      if (String(Object.values(row)[0]) !== "ok") database = "error";
    } catch {
      database = "error";
    }

    const sources = this.listSources();
    const agents: Agent[] = AGENT_IDS.map((id) => {
      const agentSources = sources.filter((source) => source.agent === id);
      const lastSeen = agentSources
        .map((source) => source.lastSeenAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => right - left)[0] ?? null;
      const lastError = agentSources.find((source) => source.lastError)?.lastError ?? null;
      return {
        id,
        label: AGENT_LABELS[id],
        status: aggregateAgentStatus(agentSources),
        sourceCount: agentSources.length,
        lastSeenAt: lastSeen,
        lastError,
      };
    });

    const countRow = this.connection
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM sources) AS sources,
          (SELECT COUNT(*) FROM sessions) AS sessions,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM usage_events) AS usage_events
      `)
      .get() as SqlRow;
    const counts: HealthCounts = {
      sources: numberValue(countRow.sources),
      sessions: numberValue(countRow.sessions),
      messages: numberValue(countRow.messages),
      usageEvents: numberValue(countRow.usage_events),
    };

    const status: HealthSnapshot["status"] =
      database === "error"
        ? "error"
        : sources.some((source) => source.status === "error")
          ? "degraded"
          : "ok";

    return {
      status,
      database,
      schemaVersion: this.getSchemaVersion(),
      checkedAt: Date.now(),
      counts,
      agents,
      sources,
    };
  }
}
