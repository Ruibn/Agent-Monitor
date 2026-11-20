import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MonitorDatabase } from "./db.js";
import type { Artifact, Message, Session, Source, UsageEvent } from "./types.js";

const now = Date.UTC(2026, 10, 20, 8, 0, 0);

const source: Source = {
  id: "source-codex",
  agent: "codex",
  channel: "cli",
  adapter: "codex-jsonl",
  rootPath: "C:\\Users\\tester\\.codex\\sessions",
  canonicalRoot: "c:\\users\\tester\\.codex\\sessions",
  status: "watching",
  lastError: null,
  discoveredAt: now - 60_000,
  lastSeenAt: now,
  metadata: { format: "jsonl" },
};

const artifact: Artifact = {
  id: "artifact-1",
  sourceId: source.id,
  path: "C:\\Users\\tester\\.codex\\sessions\\session.jsonl",
  canonicalPath: "c:\\users\\tester\\.codex\\sessions\\session.jsonl",
  fileIdentity: "volume:file",
  generation: 0,
  cursorBytes: 128,
  carry: "",
  size: 128,
  mtime: now,
  metadata: {},
};

const session: Session = {
  id: "session-1",
  sourceId: source.id,
  externalId: "external-session-1",
  agent: "codex",
  channel: "cli",
  cwd: "D:\\code\\project",
  title: "Inspect repository",
  model: "gpt-test",
  startedAt: now - 30_000,
  endedAt: now,
  updatedAt: now,
  status: "completed",
  metadata: { origin: "fixture" },
};

const message: Message = {
  id: "message-1",
  sessionId: session.id,
  eventKey: "message:event:1",
  ordinal: 0,
  timestamp: now - 20_000,
  role: "user",
  kind: "message",
  content: "Inspect this repository.",
  metadata: {},
};

const usage: UsageEvent = {
  id: "usage-1",
  sessionId: session.id,
  messageId: message.id,
  eventKey: "usage:event:1",
  timestamp: now - 10_000,
  model: "gpt-test",
  inputTokens: 120,
  outputTokens: 30,
  reasoningTokens: 10,
  cacheReadTokens: 40,
  cacheWriteTokens: 5,
  totalTokens: 150,
  provenance: "reported",
  metadata: {},
};

describe("MonitorDatabase", () => {
  let database: MonitorDatabase;

  beforeEach(() => {
    database = new MonitorDatabase();
  });

  afterEach(() => {
    database.close();
  });

  function seed(): void {
    database.upsertSource(source);
    database.upsertArtifact(artifact);
    database.upsertSession(session);
    database.upsertMessage(message);
    database.upsertUsageEvent(usage);
  }

  it("applies migrations exactly once", () => {
    expect(database.getSchemaVersion()).toBe(2);

    database.migrate();

    expect(database.getSchemaVersion()).toBe(2);
  });

  it("upserts sources and artifacts by their stable natural keys", () => {
    const inserted = database.upsertSource(source);
    const updated = database.upsertSource({
      ...source,
      id: "ignored-new-source-id",
      status: "idle",
      lastSeenAt: now + 1_000,
    });

    expect(inserted.id).toBe(source.id);
    expect(updated.id).toBe(source.id);
    expect(updated.status).toBe("idle");
    expect(updated.lastSeenAt).toBe(now + 1_000);
    expect(database.listSources()).toHaveLength(1);

    const firstArtifact = database.upsertArtifact(artifact);
    const updatedArtifact = database.upsertArtifact({
      ...artifact,
      id: "ignored-new-artifact-id",
      cursorBytes: 512,
      size: 512,
      carry: "partial",
    });
    expect(firstArtifact.id).toBe(artifact.id);
    expect(updatedArtifact.id).toBe(artifact.id);
    expect(updatedArtifact.cursorBytes).toBe(512);
    expect(updatedArtifact.carry).toBe("partial");
  });

  it("deduplicates messages and usage by session event_key", () => {
    seed();

    const updatedMessage = database.upsertMessage({
      ...message,
      id: "ignored-new-message-id",
      content: "Inspect this repository carefully.",
    });
    const updatedUsage = database.upsertUsageEvent({
      ...usage,
      id: "ignored-new-usage-id",
      inputTokens: 125,
      totalTokens: 155,
    });

    expect(updatedMessage.id).toBe(message.id);
    expect(updatedMessage.content).toContain("carefully");
    expect(updatedUsage.id).toBe(usage.id);
    expect(updatedUsage.inputTokens).toBe(125);

    const details = database.getSessionDetails(session.id);
    expect(details?.messages).toHaveLength(1);
    expect(details?.usageEvents).toHaveLength(1);
    expect(details?.tokens).toEqual({
      inputTokens: 125,
      outputTokens: 30,
      reasoningTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      totalTokens: 155,
    });
  });

  it("lists and filters sessions with aggregate token counts", () => {
    seed();

    expect(database.listSessions({ agent: "codex", query: "repository" })).toMatchObject([
      {
        id: session.id,
        messageCount: 1,
        usageEventCount: 1,
        tokens: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      },
    ]);
    expect(database.listSessions({ channel: "desktop" })).toEqual([]);
    expect(database.listSessions({ startedAfter: now })).toEqual([]);
  });

  it("summarizes usage by agent, model, channel, and UTC day", () => {
    seed();

    expect(database.summarizeUsage({ groupBy: "agent" })).toEqual([
      {
        key: "codex",
        sessionCount: 1,
        eventCount: 1,
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 10,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        totalTokens: 150,
      },
    ]);
    expect(database.summarizeUsage({ groupBy: "model" })[0]?.key).toBe("gpt-test");
    expect(database.summarizeUsage({ groupBy: "channel" })[0]?.key).toBe("cli");
    expect(database.summarizeUsage({ groupBy: "day" })[0]?.key).toBe("2026-11-20");
    expect(database.summarizeUsage({ from: now, groupBy: "agent" })).toEqual([]);
  });

  it("returns database, source, and all-agent health", () => {
    seed();

    const health = database.getHealth();

    expect(health).toMatchObject({
      status: "ok",
      database: "ok",
      schemaVersion: 2,
      counts: { sources: 1, sessions: 1, messages: 1, usageEvents: 1 },
    });
    expect(health.agents).toHaveLength(5);
    expect(health.agents.find((agent) => agent.id === "codex")?.status).toBe("watching");
    expect(health.agents.find((agent) => agent.id === "podex")?.status).toBe("unavailable");
  });

  it("rejects fractional and negative token counts", () => {
    database.upsertSource(source);
    database.upsertSession(session);

    expect(() =>
      database.upsertUsageEvent({ ...usage, inputTokens: 1.5, messageId: null }),
    ).toThrow(/inputTokens/);
    expect(() =>
      database.upsertUsageEvent({ ...usage, outputTokens: -1, messageId: null }),
    ).toThrow(/outputTokens/);
  });
});
