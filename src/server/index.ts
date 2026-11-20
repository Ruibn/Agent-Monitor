import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import {
  MonitorCollector,
  type CollectorEvent,
  type CollectorSnapshot,
} from "./collector.js";
import { MonitorDatabase } from "./db.js";
import type {
  AgentId,
  SessionDetails,
  SessionListItem,
  Source,
  SourceChannel,
  TokenCounts,
} from "./types.js";
import { SOURCE_CHANNELS } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const VERSION = "0.1.0";

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, unknown>;

export interface CollectorApi {
  getSnapshot(): CollectorSnapshot;
  subscribe(listener: (event: CollectorEvent) => void): () => void;
  requestRescan(reason?: string): void;
  start?(): Promise<void>;
  close?(): Promise<void>;
}

export interface BuildServerOptions {
  database?: MonitorDatabase;
  collector?: CollectorApi;
  databasePath?: string;
  production?: boolean;
  closeDependencies?: boolean;
}

interface RuntimeContext {
  database: MonitorDatabase;
  collector: CollectorApi;
  databasePath: string;
}

const CLIENT_AGENT: Record<AgentId, "codex" | "podex" | "claude" | "workbuddy" | "deepseek"> = {
  codex: "codex",
  podex: "podex",
  "claude-code": "claude",
  workbuddy: "workbuddy",
  "deepseek-harness": "deepseek",
};

const SERVER_AGENT: Record<string, AgentId> = {
  codex: "codex",
  podex: "podex",
  claude: "claude-code",
  "claude-code": "claude-code",
  workbuddy: "workbuddy",
  deepseek: "deepseek-harness",
  "deepseek-harness": "deepseek-harness",
};

const AGENT_LABEL: Record<AgentId, string> = {
  codex: "Codex",
  podex: "Podex",
  "claude-code": "Claude Code",
  workbuddy: "WorkBuddy",
  "deepseek-harness": "DeepSeek Harness",
};

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value !== "") return Number(value);
  return 0;
}

function iso(value: number | null | undefined): string {
  return new Date(value ?? 0).toISOString();
}

function optionalIso(value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : iso(value);
}

function toClientTokens(tokens: Partial<TokenCounts> | SqlRow): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
} {
  const values = tokens as Record<string, unknown>;
  return {
    input: numberValue(values.inputTokens ?? values.input_tokens),
    output: numberValue(values.outputTokens ?? values.output_tokens),
    cacheRead: numberValue(
      values.cacheReadTokens ?? values.cache_read_tokens,
    ),
    cacheWrite: numberValue(
      values.cacheWriteTokens ?? values.cache_write_tokens,
    ),
    reasoning: numberValue(
      values.reasoningTokens ?? values.reasoning_tokens,
    ),
    total: numberValue(values.totalTokens ?? values.total_tokens),
  };
}

function sourceStatus(status: Source["status"]): "live" | "idle" | "unavailable" | "error" | "scanning" {
  switch (status) {
    case "watching":
      return "live";
    case "discovering":
      return "scanning";
    case "error":
      return "error";
    case "unavailable":
    case "unsupported":
      return "unavailable";
    default:
      return "idle";
  }
}

function resolveDatabasePath(explicit?: string): string {
  const configured = explicit ?? process.env.AGENT_MONITOR_DB;
  const filename = configured?.trim()
    ? path.resolve(configured)
    : path.resolve(process.cwd(), ".data", "agent-monitor.sqlite");
  mkdirSync(path.dirname(filename), { recursive: true });
  return filename;
}

function parseAgent(value: unknown): AgentId | undefined {
  if (typeof value !== "string" || value === "" || value === "all") return undefined;
  return SERVER_AGENT[value];
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function rangeStart(range: unknown): number | undefined {
  const now = Date.now();
  switch (range) {
    case "24h":
      return now - 24 * 60 * 60 * 1_000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1_000;
    case "all":
      return undefined;
    case "7d":
    default:
      return now - 7 * 24 * 60 * 60 * 1_000;
  }
}

function startOfShanghaiToday(now = Date.now()): number {
  const local = new Date(now + 8 * 60 * 60 * 1_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 60 * 60 * 1_000;
}

function sessionRow(item: SessionListItem) {
  return {
    id: item.id,
    externalId: item.externalId,
    agent: CLIENT_AGENT[item.agent],
    channel: item.channel,
    title: item.title ?? "未命名会话",
    cwd: item.cwd ?? undefined,
    model: item.model ?? undefined,
    startedAt: iso(item.startedAt),
    updatedAt: iso(item.updatedAt ?? item.endedAt ?? item.startedAt),
    messageCount: item.messageCount,
    usage: toClientTokens(item.tokens),
  };
}

function sessionDetails(details: SessionDetails) {
  const item: SessionListItem = {
    ...details.session,
    messageCount: details.messages.length,
    usageEventCount: details.usageEvents.length,
    tokens: details.tokens,
  };
  return {
    ...sessionRow(item),
    messages: details.messages.map((message) => ({
      id: message.id,
      timestamp: iso(message.timestamp),
      role: message.role,
      kind: message.kind,
      content: message.content,
      model:
        typeof message.metadata.model === "string" ? message.metadata.model : undefined,
    })),
    usageEvents: details.usageEvents.map((event) => ({
      id: event.id,
      timestamp: iso(event.timestamp),
      model: event.model ?? undefined,
      ...toClientTokens(event),
    })),
  };
}

function filteredSessionCount(
  database: MonitorDatabase,
  query: Record<string, unknown>,
): number {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const agent = parseAgent(query.agent);
  if (agent) {
    clauses.push("agent = ?");
    params.push(agent);
  }
  if (typeof query.channel === "string" && query.channel !== "all") {
    if ((SOURCE_CHANNELS as readonly string[]).includes(query.channel)) {
      clauses.push("channel = ?");
      params.push(query.channel);
    }
  }
  if (typeof query.model === "string" && query.model.trim()) {
    clauses.push("model = ?");
    params.push(query.model.trim());
  }
  const search = typeof query.q === "string" ? query.q.trim() : "";
  if (search) {
    const pattern = `%${search}%`;
    clauses.push("(title LIKE ? OR cwd LIKE ? OR model LIKE ? OR external_id LIKE ?)");
    params.push(pattern, pattern, pattern, pattern);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = database.connection
    .prepare(`SELECT COUNT(*) AS count FROM sessions ${where}`)
    .get(...params) as SqlRow;
  return numberValue(row.count);
}

function registerHealthRoute(app: FastifyInstance, context: RuntimeContext): void {
  app.get("/api/health", async () => {
    const collector = context.collector.getSnapshot();
    let databaseError = false;
    try {
      context.database.connection.prepare("SELECT 1").get();
    } catch {
      databaseError = true;
    }
    return {
      status:
        databaseError || collector.lastError
          ? "error"
          : collector.scanning && collector.lastScanAt === null
            ? "scanning"
            : "ok",
      startedAt: iso(collector.startedAt),
      lastScanAt: optionalIso(collector.lastScanAt),
      databasePath: context.databasePath,
      version: VERSION,
    };
  });
}

function registerSourceRoute(app: FastifyInstance, context: RuntimeContext): void {
  app.get("/api/sources", async () => {
    const rows = context.database.connection
      .prepare(`
        SELECT
          so.*,
          (SELECT COUNT(*) FROM sessions se WHERE se.source_id = so.id) AS session_count,
          (
            SELECT COALESCE(SUM(u.total_tokens), 0)
            FROM usage_events u
            JOIN sessions se ON se.id = u.session_id
            WHERE se.source_id = so.id
          ) AS token_count
        FROM sources so
        ORDER BY so.agent, so.root_path
      `)
      .all() as SqlRow[];
    return rows.map((row) => {
      const agent = String(row.agent) as AgentId;
      return {
        id: String(row.id),
        agent: CLIENT_AGENT[agent],
        label: AGENT_LABEL[agent],
        root: String(row.root_path),
        status: sourceStatus(String(row.status) as Source["status"]),
        channel: String(row.channel),
        sessions: numberValue(row.session_count),
        tokens: numberValue(row.token_count),
        lastSeenAt: optionalIso(row.last_seen_at === null ? null : numberValue(row.last_seen_at)),
        error: row.last_error ? String(row.last_error) : undefined,
      };
    });
  });
}

function registerOverviewRoute(app: FastifyInstance, context: RuntimeContext): void {
  app.get("/api/overview", async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = rangeStart(query.range);
    const agent = parseAgent(query.agent);
    const usageClauses: string[] = [];
    const usageParams: SqlValue[] = [];
    if (from !== undefined) {
      usageClauses.push("u.timestamp >= ?");
      usageParams.push(from);
    }
    if (agent) {
      usageClauses.push("s.agent = ?");
      usageParams.push(agent);
    }
    const usageWhere = usageClauses.length > 0 ? `WHERE ${usageClauses.join(" AND ")}` : "";
    const usage = context.database.connection
      .prepare(`
        SELECT
          COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(u.total_tokens), 0) AS total_tokens
        FROM usage_events u
        JOIN sessions s ON s.id = u.session_id
        ${usageWhere}
      `)
      .get(...usageParams) as SqlRow;

    const sessionClauses: string[] = [];
    const sessionParams: SqlValue[] = [];
    if (from !== undefined) {
      sessionClauses.push("COALESCE(updated_at, ended_at, started_at, 0) >= ?");
      sessionParams.push(from);
    }
    if (agent) {
      sessionClauses.push("agent = ?");
      sessionParams.push(agent);
    }
    const sessionWhere = sessionClauses.length > 0 ? `WHERE ${sessionClauses.join(" AND ")}` : "";
    const sessionCount = context.database.connection
      .prepare(`SELECT COUNT(*) AS count FROM sessions ${sessionWhere}`)
      .get(...sessionParams) as SqlRow;

    const messageClauses: string[] = [];
    const messageParams: SqlValue[] = [];
    if (from !== undefined) {
      messageClauses.push("m.timestamp >= ?");
      messageParams.push(from);
    }
    if (agent) {
      messageClauses.push("s.agent = ?");
      messageParams.push(agent);
    }
    const messageWhere = messageClauses.length > 0 ? `WHERE ${messageClauses.join(" AND ")}` : "";
    const messageCount = context.database.connection
      .prepare(`
        SELECT COUNT(*) AS count
        FROM messages m JOIN sessions s ON s.id = m.session_id
        ${messageWhere}
      `)
      .get(...messageParams) as SqlRow;

    const activeParams: SqlValue[] = [startOfShanghaiToday()];
    const activeAgent = agent ? "AND agent = ?" : "";
    if (agent) activeParams.push(agent);
    const activeToday = context.database.connection
      .prepare(`
        SELECT COUNT(*) AS count FROM sessions
        WHERE COALESCE(updated_at, ended_at, started_at, 0) >= ? ${activeAgent}
      `)
      .get(...activeParams) as SqlRow;

    const bucketExpression =
      query.range === "24h"
        ? "strftime('%Y-%m-%dT%H:00:00+08:00', u.timestamp / 1000, 'unixepoch', '+8 hours')"
        : "strftime('%Y-%m-%d', u.timestamp / 1000, 'unixepoch', '+8 hours')";
    const seriesRows = context.database.connection
      .prepare(`
        SELECT
          ${bucketExpression} AS bucket,
          COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(u.total_tokens), 0) AS total_tokens
        FROM usage_events u
        JOIN sessions s ON s.id = u.session_id
        ${usageWhere}
        GROUP BY bucket
        ORDER BY bucket
      `)
      .all(...usageParams) as SqlRow[];

    const agentRows = context.database.connection
      .prepare(`
        SELECT
          s.agent,
          COUNT(DISTINCT s.id) AS session_count,
          COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
          COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
          COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(u.total_tokens), 0) AS total_tokens
        FROM usage_events u
        JOIN sessions s ON s.id = u.session_id
        ${usageWhere}
        GROUP BY s.agent
      `)
      .all(...usageParams) as SqlRow[];
    const byAgent = new Map(agentRows.map((row) => [String(row.agent) as AgentId, row]));

    const recentSessions = context.database.listSessions({
      agent,
      updatedAfter: from,
      limit: 6,
    });
    const clientUsage = toClientTokens(usage);
    const cacheRate =
      clientUsage.input > 0
        ? Math.min(100, (clientUsage.cacheRead / clientUsage.input) * 100)
        : 0;
    return {
      usage: clientUsage,
      sessions: numberValue(sessionCount.count),
      messages: numberValue(messageCount.count),
      activeToday: numberValue(activeToday.count),
      cacheRate,
      series: seriesRows.map((row) => ({
        bucket: String(row.bucket),
        input: numberValue(row.input_tokens),
        output: numberValue(row.output_tokens),
        cacheRead: numberValue(row.cache_read_tokens),
        total: numberValue(row.total_tokens),
      })),
      agents: (Object.keys(CLIENT_AGENT) as AgentId[]).map((id) => {
        const row = byAgent.get(id) ?? {};
        return {
          agent: CLIENT_AGENT[id],
          sessions: numberValue(row.session_count),
          usage: toClientTokens(row),
        };
      }),
      recentSessions: recentSessions.map(sessionRow),
      updatedAt: iso(Date.now()),
    };
  });
}

function registerSessionRoutes(app: FastifyInstance, context: RuntimeContext): void {
  app.get("/api/sessions", async (request) => {
    const query = request.query as Record<string, unknown>;
    const agent = parseAgent(query.agent);
    const channelValue = typeof query.channel === "string" ? query.channel : undefined;
    const channel =
      channelValue && (SOURCE_CHANNELS as readonly string[]).includes(channelValue)
        ? (channelValue as SourceChannel)
        : undefined;
    const limit = Math.max(1, Math.min(200, parseInteger(query.limit) ?? 50));
    const items = context.database.listSessions({
      agent,
      channel,
      model: typeof query.model === "string" && query.model !== "all" ? query.model : undefined,
      query: typeof query.q === "string" ? query.q : undefined,
      limit,
    });
    return {
      items: items.map(sessionRow),
      total: filteredSessionCount(context.database, query),
    };
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const details = context.database.getSessionDetails(id);
    if (!details) return reply.code(404).send({ error: "会话不存在" });
    return sessionDetails(details);
  });
}

function registerRescanRoute(app: FastifyInstance, context: RuntimeContext): void {
  app.post("/api/rescan", async (_request, reply) => {
    context.collector.requestRescan("api");
    return reply.code(202).send({ accepted: true });
  });
}

function registerEventRoute(app: FastifyInstance, context: RuntimeContext): void {
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify(context.collector.getSnapshot())}\n\n`);
    const unsubscribe = context.collector.subscribe((event) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
  });
}

function registerStatic(app: FastifyInstance): void {
  const root = path.resolve(process.cwd(), "dist");
  if (!existsSync(root)) return;
  void app.register(fastifyStatic, { root, prefix: "/" });
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "接口不存在" });
    }
    return reply.sendFile("index.html");
  });
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const databasePath = options.database
    ? options.databasePath ?? ":memory:"
    : resolveDatabasePath(options.databasePath);
  const database = options.database ?? new MonitorDatabase(databasePath);
  const collector = options.collector ?? new MonitorCollector({ database });
  const closeDependencies = options.closeDependencies ?? (!options.database || !options.collector);
  const context: RuntimeContext = { database, collector, databasePath };
  const app = Fastify({ logger: false });

  registerHealthRoute(app, context);
  registerSourceRoute(app, context);
  registerOverviewRoute(app, context);
  registerSessionRoutes(app, context);
  registerRescanRoute(app, context);
  registerEventRoute(app, context);
  if (options.production ?? process.env.NODE_ENV === "production") registerStatic(app);

  if (closeDependencies) {
    app.addHook("onClose", async () => {
      await collector.close?.();
      database.close();
    });
  }
  return app;
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`AGENT_MONITOR_PORT is invalid: ${value}`);
  }
  return port;
}

export async function startServer(): Promise<FastifyInstance> {
  const databasePath = resolveDatabasePath();
  const database = new MonitorDatabase(databasePath);
  const collector = new MonitorCollector({ database });
  const app = buildServer({
    database,
    collector,
    databasePath,
    production: true,
    closeDependencies: true,
  });
  const host = process.env.AGENT_MONITOR_HOST?.trim() || DEFAULT_HOST;
  const port = parsePort(process.env.AGENT_MONITOR_PORT);
  await app.listen({ host, port });
  void collector.start().catch((error) => {
    console.error("Agent Monitor collector failed:", error);
  });
  console.log(`Agent Monitor: http://${host}:${port}`);
  return app;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
