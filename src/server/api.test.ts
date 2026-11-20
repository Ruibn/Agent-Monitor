import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectorEvent, CollectorSnapshot } from "./collector.js";
import { MonitorDatabase } from "./db.js";
import { buildServer, type CollectorApi } from "./index.js";
import type { Message, Session, Source, UsageEvent } from "./types.js";

const now = Date.UTC(2026, 10, 20, 8, 0, 0);

class StubCollector implements CollectorApi {
  requested = 0;
  snapshot: CollectorSnapshot = {
    startedAt: now - 60_000,
    lastScanAt: now - 1_000,
    scanning: false,
    lastError: null,
  };
  private readonly listeners = new Set<(event: CollectorEvent) => void>();

  getSnapshot(): CollectorSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (event: CollectorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requestRescan(): void {
    this.requested += 1;
  }
}

const source: Source = {
  id: "source-codex",
  agent: "codex",
  channel: "unknown",
  adapter: "codex-rollout",
  rootPath: "C:\\Users\\tester\\.codex\\sessions",
  canonicalRoot: "c:/users/tester/.codex/sessions",
  status: "watching",
  lastError: null,
  discoveredAt: now - 120_000,
  lastSeenAt: now,
  metadata: {},
};

const session: Session = {
  id: "session-codex",
  sourceId: source.id,
  externalId: "external-codex",
  agent: "codex",
  channel: "desktop",
  cwd: "D:\\code\\project",
  title: "Inspect repository",
  model: "gpt-test",
  startedAt: now - 30_000,
  endedAt: now - 5_000,
  updatedAt: now - 5_000,
  status: "completed",
  metadata: {},
};

const message: Message = {
  id: "message-codex",
  sessionId: session.id,
  eventKey: "message:1",
  ordinal: 1,
  timestamp: now - 20_000,
  role: "user",
  kind: "message",
  content: "Inspect this repository.",
  metadata: {},
};

const usage: UsageEvent = {
  id: "usage-codex",
  sessionId: session.id,
  messageId: message.id,
  eventKey: "usage:1",
  timestamp: now - 10_000,
  model: "gpt-test",
  inputTokens: 1_000,
  outputTokens: 200,
  reasoningTokens: 50,
  cacheReadTokens: 400,
  cacheWriteTokens: 20,
  totalTokens: 1_200,
  provenance: "reported",
  metadata: {},
};

describe("HTTP API", () => {
  let database: MonitorDatabase;
  let collector: StubCollector;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    database = new MonitorDatabase();
    collector = new StubCollector();
    database.upsertSource(source);
    database.upsertSession(session);
    database.upsertMessage(message);
    database.upsertUsageEvent(usage);
    app = buildServer({
      database,
      collector,
      databasePath: ":memory:",
      production: false,
      closeDependencies: false,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it("reports runtime health and mapped source state", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      startedAt: new Date(now - 60_000).toISOString(),
      lastScanAt: new Date(now - 1_000).toISOString(),
      databasePath: ":memory:",
      version: "0.1.0",
    });

    const sources = await app.inject({ method: "GET", url: "/api/sources" });
    expect(sources.json()).toEqual([
      expect.objectContaining({
        id: source.id,
        agent: "codex",
        label: "Codex",
        status: "live",
        sessions: 1,
        tokens: 1_200,
      }),
    ]);
  });

  it("returns overview aggregates in the client contract", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/overview?range=all&agent=all",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      usage: {
        input: 1_000,
        output: 200,
        cacheRead: 400,
        cacheWrite: 20,
        reasoning: 50,
        total: 1_200,
      },
      sessions: 1,
      messages: 1,
      cacheRate: 40,
    });
    expect(body.series).toHaveLength(1);
    expect(body.agents).toHaveLength(5);
    expect(body.agents.find((row: { agent: string }) => row.agent === "codex")).toMatchObject({
      sessions: 1,
      usage: { total: 1_200 },
    });
    expect(body.recentSessions[0]).toMatchObject({
      id: session.id,
      agent: "codex",
      channel: "desktop",
      messageCount: 1,
      usage: { total: 1_200 },
    });
  });

  it("lists, searches, and opens sessions", async () => {
    database.upsertSession({
      ...session,
      id: "session-subagent",
      externalId: "external-subagent",
      channel: "subagent",
      title: "Delegated repository scan",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions?agent=codex&channel=desktop&q=repository&limit=100",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      total: 1,
      items: [
        {
          id: session.id,
          externalId: session.externalId,
          title: session.title,
          model: session.model,
          usage: { total: 1_200 },
        },
      ],
    });

    const subagents = await app.inject({
      method: "GET",
      url: "/api/sessions?agent=codex&channel=subagent",
    });
    expect(subagents.json()).toMatchObject({
      total: 1,
      items: [{ id: "session-subagent", channel: "subagent" }],
    });

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: session.id,
      messages: [{ role: "user", content: "Inspect this repository." }],
      usageEvents: [{ model: "gpt-test", total: 1_200 }],
    });

    const missing = await app.inject({ method: "GET", url: "/api/sessions/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "会话不存在" });
  });

  it("accepts an asynchronous manual rescan", async () => {
    const response = await app.inject({ method: "POST", url: "/api/rescan" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(collector.requested).toBe(1);
  });

  it("exposes the SSE endpoint", async () => {
    await app.ready();
    expect(
      app.hasRoute({ method: "GET", url: "/api/events" }),
    ).toBe(true);
  });
});
