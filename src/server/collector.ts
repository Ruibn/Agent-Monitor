import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import {
  consumeDeepSeekZstdChunk,
  consumeJsonlChunk,
  createAdapterState,
  discoverAgentSources,
  type AdapterKind,
  type AdapterParseState,
  type AdapterPatch,
  type DiscoveredAdapterSource,
} from "./adapters.js";
import { MonitorDatabase } from "./db.js";
import type {
  AgentId,
  Artifact,
  JsonMetadata,
  Session,
  Source,
  SourceChannel,
} from "./types.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
const READ_CHUNK_BYTES = 64 * 1024;
const FINGERPRINT_BYTES = 96;
const PARSER_VERSION = 7;

type CollectorEventType = "scan-start" | "scan-complete" | "update" | "error";

export interface CollectorEvent {
  type: CollectorEventType;
  at: number;
  reason?: string;
  sourceId?: string;
  artifactPath?: string;
  patches?: number;
  error?: string;
}

export interface CollectorSnapshot {
  startedAt: number;
  lastScanAt: number | null;
  scanning: boolean;
  lastError: string | null;
}

export interface CollectorOptions {
  database: MonitorDatabase;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  reconcileIntervalMs?: number;
  watch?: boolean;
}

interface ArtifactMetadata extends JsonMetadata {
  parserVersion: number;
  adapter: AdapterKind;
  sessionExternalId: string | null;
  channel: SourceChannel;
  model: string | null;
  cwd: string | null;
  nextOrdinal: number;
  hasReportedUsage: boolean;
  sawSessionMeta: boolean;
  historyStartOrdinal: number | null;
  zstdTornStartBase64: string;
  carryEncoding: "base64";
  headHash: string;
  boundaryHash: string;
}

interface ArtifactScanResult {
  changed: boolean;
  patchCount: number;
  mtime: number;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${hash(parts.join("\u0000")).slice(0, 32)}`;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function artifactMetadata(
  adapter: AdapterKind,
  state: AdapterParseState,
  headHash: string,
  boundaryHash: string,
): ArtifactMetadata {
  return {
    parserVersion: PARSER_VERSION,
    adapter,
    sessionExternalId: state.sessionExternalId,
    channel: state.channel,
    model: state.model,
    cwd: state.cwd,
    nextOrdinal: state.nextOrdinal,
    hasReportedUsage: state.hasReportedUsage,
    sawSessionMeta: state.sawSessionMeta,
    historyStartOrdinal: state.historyStartOrdinal,
    zstdTornStartBase64: state.zstdTornStart.toString("base64"),
    carryEncoding: "base64",
    headHash,
    boundaryHash,
  };
}

function restoreAdapterState(
  adapter: AdapterKind,
  artifactPath: string,
  artifact: Artifact | null,
): AdapterParseState {
  const state = createAdapterState(artifactPath);
  if (!artifact) return state;
  const metadata = asObject(artifact.metadata);
  if (metadata.adapter !== adapter) return state;
  return {
    ...state,
    sessionExternalId: asString(metadata.sessionExternalId) ?? state.sessionExternalId,
    channel:
      metadata.channel === "desktop" ||
      metadata.channel === "cli" ||
      metadata.channel === "exec" ||
      metadata.channel === "subagent" ||
      metadata.channel === "sdk" ||
      metadata.channel === "interactive" ||
      metadata.channel === "unknown"
        ? metadata.channel
        : "unknown",
    model: asString(metadata.model),
    cwd: asString(metadata.cwd),
    nextOrdinal: asInteger(metadata.nextOrdinal),
    hasReportedUsage: metadata.hasReportedUsage === true,
    sawSessionMeta: metadata.sawSessionMeta === true,
    historyStartOrdinal:
      typeof metadata.historyStartOrdinal === "number"
        ? Math.trunc(metadata.historyStartOrdinal)
        : null,
    lineCarry:
      metadata.carryEncoding === "base64" && artifact.carry
        ? Buffer.from(artifact.carry, "base64")
        : Buffer.alloc(0),
    zstdTornStart:
      typeof metadata.zstdTornStartBase64 === "string"
        ? Buffer.from(metadata.zstdTornStartBase64, "base64")
        : Buffer.alloc(0),
  };
}

function matchesArtifact(adapter: AdapterKind, filePath: string): boolean {
  const name = path.basename(filePath);
  switch (adapter) {
    case "codex-rollout":
    case "podex-rollout":
      return name.startsWith("rollout-") && name.endsWith(".jsonl");
    case "claude-project":
    case "workbuddy-project":
      return name.endsWith(".jsonl");
    case "deepseek-session":
      return /^session\.v\d+\.jsonl(?:\.zstd)?$/i.test(name);
  }
}

async function listArtifacts(root: string, adapter: AdapterKind): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && matchesArtifact(adapter, entryPath)) files.push(entryPath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function readSlice(filePath: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function fileFingerprints(filePath: string, boundary: number): Promise<{
  headHash: string;
  boundaryHash: string;
}> {
  const head = await readSlice(filePath, 0, FINGERPRINT_BYTES);
  const boundaryStart = Math.max(0, boundary - FINGERPRINT_BYTES);
  const tail = await readSlice(filePath, boundaryStart, boundary - boundaryStart);
  return { headHash: hash(head), boundaryHash: hash(tail) };
}

function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${Math.trunc(stats.birthtimeMs)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSensitiveText(input: string): { content: string; count: number } {
  let content = input;
  let count = 0;
  const replace = (
    pattern: RegExp,
    replacement: string | ((match: string, ...groups: string[]) => string),
  ) => {
    content = content.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === "string"
        ? replacement
        : replacement(args[0], ...args.slice(1, -2));
    });
  };
  replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    "[REDACTED TOKEN]",
  );
  replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "$1 [REDACTED]");
  replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b(\s*[:=]\s*)["']?([^\s,"'}]{8,})["']?/gi,
    (_match, name, separator) => `${name}${separator}[REDACTED]`,
  );
  const limit = 256 * 1024;
  if (content.length > limit) {
    content = `${content.slice(0, limit)}\n\n[TRUNCATED BY AGENT MONITOR]`;
  }
  return { content, count };
}

export class MonitorCollector {
  readonly database: MonitorDatabase;
  readonly startedAt = Date.now();

  private readonly homeDir?: string;
  private readonly env?: Record<string, string | undefined>;
  private readonly reconcileIntervalMs: number;
  private readonly watchEnabled: boolean;
  private readonly listeners = new Set<(event: CollectorEvent) => void>();
  private readonly watchers = new Map<string, FSWatcher>();
  private interval: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileAgain = false;
  private stopped = false;
  private lastScanAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: CollectorOptions) {
    this.database = options.database;
    this.homeDir = options.homeDir;
    this.env = options.env;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.watchEnabled = options.watch ?? true;
  }

  getSnapshot(): CollectorSnapshot {
    return {
      startedAt: this.startedAt,
      lastScanAt: this.lastScanAt,
      scanning: this.reconcilePromise !== null,
      lastError: this.lastError,
    };
  }

  subscribe(listener: (event: CollectorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("collector has been stopped");
    await this.rescan("startup");
    this.interval ??= setInterval(() => {
      void this.rescan("interval");
    }, this.reconcileIntervalMs);
    this.interval.unref();
  }

  requestRescan(reason = "manual"): void {
    void this.rescan(reason);
  }

  async rescan(reason = "manual"): Promise<void> {
    if (this.stopped) return;
    if (this.reconcilePromise) {
      this.reconcileAgain = true;
      return this.reconcilePromise;
    }
    this.reconcilePromise = this.runReconcile(reason).finally(() => {
      this.reconcilePromise = null;
      if (this.reconcileAgain && !this.stopped) {
        this.reconcileAgain = false;
        void this.rescan("queued");
      }
    });
    return this.reconcilePromise;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.interval = null;
    this.wakeTimer = null;
    await this.reconcilePromise?.catch(() => undefined);
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
  }

  private emit(event: Omit<CollectorEvent, "at">): void {
    const value = { ...event, at: Date.now() } as CollectorEvent;
    for (const listener of this.listeners) listener(value);
  }

  private wake(reason: string): void {
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.rescan(reason);
    }, 75);
    this.wakeTimer.unref();
  }

  private async ensureWatcher(source: DiscoveredAdapterSource): Promise<void> {
    if (!this.watchEnabled || !source.available || this.watchers.has(source.id)) return;
    const watcher = chokidar.watch(source.rootPath, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
    });
    watcher.on("all", () => this.wake("filesystem"));
    watcher.on("error", (error) => {
      const message = errorMessage(error);
      const stored = this.database.getSource(source.id);
      if (stored) this.database.upsertSource({ ...stored, status: "error", lastError: message });
      this.emit({ type: "error", sourceId: source.id, error: message });
    });
    this.watchers.set(source.id, watcher);
  }

  private async runReconcile(reason: string): Promise<void> {
    this.emit({ type: "scan-start", reason });
    let changed = false;
    let patchCount = 0;
    try {
      const discovered = await discoverAgentSources({ homeDir: this.homeDir, env: this.env });
      this.resetIncompatibleCheckpoints();
      const seen = new Set(discovered.map((source) => source.id));
      for (const existing of this.database.listSources()) {
        if (!seen.has(existing.id)) {
          this.database.upsertSource({
            ...existing,
            status: "unavailable",
            lastError: null,
          });
        }
      }

      for (const source of discovered) {
        const canonicalRoot = canonicalPath(source.rootPath);
        const previous = this.database.getSource(source.id);
        const stored = this.database.upsertSource({
          id: source.id,
          agent: source.agent,
          channel: source.channel,
          adapter: source.adapter,
          rootPath: source.rootPath,
          canonicalRoot,
          status: source.available
            ? previous?.status === "watching" || previous?.status === "idle"
              ? previous.status
              : "discovering"
            : "unavailable",
          lastError: null,
          discoveredAt: previous?.discoveredAt ?? Date.now(),
          lastSeenAt: previous?.lastSeenAt ?? null,
          metadata: source.metadata,
        });
        if (!source.available) continue;

        try {
          await this.ensureWatcher(source);
          const files = await listArtifacts(source.rootPath, source.adapter);
          let lastSeenAt = stored.lastSeenAt;
          for (const filePath of files) {
            const result = await this.scanArtifact(stored, source.adapter, filePath);
            changed ||= result.changed;
            patchCount += result.patchCount;
            lastSeenAt = Math.max(lastSeenAt ?? 0, result.mtime);
          }
          this.database.upsertSource({
            ...stored,
            status: this.watchEnabled ? "watching" : "idle",
            lastError: null,
            lastSeenAt,
          });
        } catch (error) {
          const message = errorMessage(error);
          this.database.upsertSource({ ...stored, status: "error", lastError: message });
          this.emit({ type: "error", sourceId: source.id, error: message });
        }
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.emit({ type: "error", error: this.lastError });
    } finally {
      this.lastScanAt = Date.now();
      if (changed) this.emit({ type: "update", reason, patches: patchCount });
      this.emit({ type: "scan-complete", reason, patches: patchCount });
    }
  }

  private resetIncompatibleCheckpoints(): void {
    const row = this.database.connection
      .prepare(`
        SELECT COUNT(*) AS count
        FROM artifacts
        WHERE COALESCE(json_extract(metadata_json, '$.parserVersion'), -1) <> ?
      `)
      .get(PARSER_VERSION) as { count?: number | bigint };
    if (Number(row.count ?? 0) === 0) return;

    const connection = this.database.connection;
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.prepare("DELETE FROM sessions").run();
      connection
        .prepare(`
          UPDATE artifacts
          SET generation = generation + 1,
              cursor_bytes = 0,
              carry = '',
              size = 0,
              metadata_json = ?
        `)
        .run(JSON.stringify({ parserVersion: PARSER_VERSION }));
      connection.exec("COMMIT");
      this.emit({ type: "update", reason: "parser-upgrade" });
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  private findArtifact(sourceId: string, canonical: string): Artifact | null {
    const row = this.database.connection
      .prepare("SELECT id FROM artifacts WHERE source_id = ? AND canonical_path = ?")
      .get(sourceId, canonical) as { id?: unknown } | undefined;
    return row?.id ? this.database.getArtifact(String(row.id)) : null;
  }

  private resetArtifactSessions(sourceId: string, artifactId: string): void {
    this.database.connection
      .prepare(
        "DELETE FROM sessions WHERE source_id = ? AND json_extract(metadata_json, '$.artifactId') = ?",
      )
      .run(sourceId, artifactId);
  }

  private async scanArtifact(
    source: Source,
    adapter: AdapterKind,
    filePath: string,
  ): Promise<ArtifactScanResult> {
    const stats = await stat(filePath);
    if (!stats.isFile()) return { changed: false, patchCount: 0, mtime: 0 };
    const canonical = canonicalPath(filePath);
    const artifactId = stableId("artifact", source.id, canonical);
    let artifact = this.findArtifact(source.id, canonical);
    const identity = fileIdentity(stats);
    let reset = false;

    if (artifact) {
      const previousMetadata = asObject(artifact.metadata);
      if (
        previousMetadata.parserVersion !== PARSER_VERSION ||
        stats.size < artifact.cursorBytes ||
        (artifact.fileIdentity && artifact.fileIdentity !== identity)
      ) {
        reset = true;
      } else if (artifact.cursorBytes > 0) {
        const fingerprints = await fileFingerprints(filePath, artifact.cursorBytes);
        const expectedHead = asString(previousMetadata.headHash);
        const expectedBoundary = asString(previousMetadata.boundaryHash);
        if (
          (expectedHead && expectedHead !== fingerprints.headHash) ||
          (expectedBoundary && expectedBoundary !== fingerprints.boundaryHash)
        ) {
          reset = true;
        }
      }
    }

    if (reset && artifact) {
      this.resetArtifactSessions(source.id, artifact.id);
      artifact = {
        ...artifact,
        generation: artifact.generation + 1,
        cursorBytes: 0,
        carry: "",
        size: 0,
        metadata: {},
      };
      this.emit({ type: "update", sourceId: source.id, artifactPath: filePath, reason: "reset" });
    }

    let state = restoreAdapterState(adapter, filePath, artifact);
    let cursor = artifact?.cursorBytes ?? 0;
    let patchCount = 0;
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (cursor < stats.size) {
        const length = Math.min(buffer.length, stats.size - cursor);
        const { bytesRead } = await handle.read(buffer, 0, length, cursor);
        if (bytesRead === 0) break;
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        const consumed =
          adapter === "deepseek-session" && filePath.toLowerCase().endsWith(".zstd")
            ? consumeDeepSeekZstdChunk(chunk, state)
            : consumeJsonlChunk(adapter, chunk, state);
        state = consumed.state;
        cursor += bytesRead;
        if (consumed.patches.length > 0) {
          this.applyPatches(source, adapter, artifactId, state, consumed.patches);
          patchCount += consumed.patches.length;
        }
        // Backfills can span hundreds of megabytes. Yield between bounded
        // chunks so health/API/SSE requests stay responsive throughout.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      await handle.close();
    }

    const fingerprints = await fileFingerprints(filePath, cursor);
    const storedArtifact: Artifact = {
      id: artifactId,
      sourceId: source.id,
      path: filePath,
      canonicalPath: canonical,
      fileIdentity: identity,
      generation: artifact?.generation ?? 0,
      cursorBytes: cursor,
      carry: state.lineCarry.toString("base64"),
      size: stats.size,
      mtime: Math.trunc(stats.mtimeMs),
      metadata: artifactMetadata(adapter, state, fingerprints.headHash, fingerprints.boundaryHash),
    };
    this.database.upsertArtifact(storedArtifact);

    return {
      changed: reset || patchCount > 0 || !artifact,
      patchCount,
      mtime: Math.trunc(stats.mtimeMs),
    };
  }

  private applyPatches(
    source: Source,
    adapter: AdapterKind,
    artifactId: string,
    state: AdapterParseState,
    patches: AdapterPatch[],
  ): void {
    const connection = this.database.connection;
    const ensuredSessions = new Set<string>();
    const insertedMessages = new Set<string>();
    const activityBySession = new Map<string, number>();
    const noteActivity = (sessionId: string, value: number | null | undefined) => {
      if (value === null || value === undefined || value <= 0) return;
      activityBySession.set(sessionId, Math.max(activityBySession.get(sessionId) ?? 0, value));
    };
    const findMessage = connection.prepare("SELECT id FROM messages WHERE id = ?");
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const patch of patches) {
        if (patch.type === "session") {
          const externalId =
            adapter === "workbuddy-project" && state.sessionExternalId
              ? state.sessionExternalId
              : patch.session.externalId;
          const sessionId = stableId("session", source.id, externalId);
          this.database.upsertSession({
            id: sessionId,
            sourceId: source.id,
            externalId,
            agent: patch.session.agent,
            channel: patch.session.channel,
            cwd: patch.session.cwd ?? null,
            title: patch.session.title ?? null,
            model: patch.session.model ?? null,
            startedAt: patch.session.startedAt ?? null,
            endedAt: patch.session.endedAt ?? null,
            updatedAt: patch.session.endedAt ?? patch.session.startedAt ?? null,
            status: patch.session.status ?? "unknown",
            metadata: {
              ...(patch.session.metadata ?? {}),
              artifactId,
              artifactPath: state.artifactPath,
            },
          }, false);
          ensuredSessions.add(sessionId);
          noteActivity(
            sessionId,
            patch.session.endedAt ?? patch.session.startedAt,
          );
          continue;
        }

        const externalSessionId =
          adapter === "workbuddy-project" && state.sessionExternalId
            ? state.sessionExternalId
            : patch.type === "message"
              ? patch.message.sessionExternalId
              : patch.usage.sessionExternalId;
        const sessionId = stableId("session", source.id, externalSessionId);
        if (!ensuredSessions.has(sessionId)) {
          this.ensureSession(source, state, artifactId, externalSessionId, sessionId);
          ensuredSessions.add(sessionId);
        }

        if (patch.type === "message") {
          const messageId = stableId(
            "message",
            source.id,
            externalSessionId,
            patch.message.externalId,
          );
          const redacted = redactSensitiveText(patch.message.content);
          this.database.upsertMessage({
            id: messageId,
            sessionId,
            eventKey: patch.eventKey,
            ordinal: patch.message.ordinal,
            timestamp: patch.message.timestamp,
            role: patch.message.role,
            kind: patch.message.kind,
            content: redacted.content,
            metadata: {
              ...patch.message.metadata,
              artifactId,
              ...(redacted.count > 0 ? { redactedSecrets: redacted.count } : {}),
            },
          }, false);
          insertedMessages.add(messageId);
          noteActivity(sessionId, patch.message.timestamp);
          continue;
        }

        const candidateMessageId = patch.usage.messageExternalId
          ? stableId(
              "message",
              source.id,
              externalSessionId,
              patch.usage.messageExternalId,
            )
          : null;
        const linkedMessage = candidateMessageId
          ? insertedMessages.has(candidateMessageId)
            ? { id: candidateMessageId }
            : (findMessage.get(candidateMessageId) as
              | { id?: unknown }
              | undefined)
          : undefined;
        if (patch.usage.metadata.removeThreadFallback === true) {
          connection
            .prepare(
              "DELETE FROM usage_events WHERE session_id = ? AND json_extract(metadata_json, '$.aggregate') = 'thread-fallback'",
            )
            .run(sessionId);
        }
        let usageCounts = patch.usage;
        if (patch.usage.metadata.replaceSessionUsage === true) {
          const existing = connection
            .prepare(`
              SELECT
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
              FROM usage_events
              WHERE session_id = ? AND event_key <> ?
            `)
            .get(sessionId, patch.eventKey) as Record<string, number | bigint>;
          const delta = (reported: number, stored: number | bigint | undefined) =>
            Math.max(0, reported - Number(stored ?? 0));
          usageCounts = {
            ...patch.usage,
            inputTokens: delta(patch.usage.inputTokens, existing.input_tokens),
            outputTokens: delta(patch.usage.outputTokens, existing.output_tokens),
            reasoningTokens: delta(patch.usage.reasoningTokens, existing.reasoning_tokens),
            cacheReadTokens: delta(patch.usage.cacheReadTokens, existing.cache_read_tokens),
            cacheWriteTokens: delta(patch.usage.cacheWriteTokens, existing.cache_write_tokens),
            totalTokens: delta(patch.usage.totalTokens, existing.total_tokens),
            metadata: {
              ...patch.usage.metadata,
              artifactId,
              adjustment: true,
              authoritativeTotal: patch.usage.totalTokens,
            },
          };
        }
        this.database.upsertUsageEvent({
          id: stableId("usage", source.id, externalSessionId, patch.eventKey),
          sessionId,
          messageId: linkedMessage?.id ? String(linkedMessage.id) : null,
          eventKey: patch.eventKey,
          timestamp: usageCounts.timestamp,
          model: usageCounts.model,
          inputTokens: usageCounts.inputTokens,
          outputTokens: usageCounts.outputTokens,
          reasoningTokens: usageCounts.reasoningTokens,
          cacheReadTokens: usageCounts.cacheReadTokens,
          cacheWriteTokens: usageCounts.cacheWriteTokens,
          totalTokens: usageCounts.totalTokens,
          provenance: usageCounts.provenance,
          metadata: { ...usageCounts.metadata, artifactId },
        }, false);
        noteActivity(sessionId, usageCounts.timestamp);
      }
      for (const [sessionId, updatedAt] of activityBySession) {
        this.database.touchSession(sessionId, updatedAt);
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureSession(
    source: Source,
    state: AdapterParseState,
    artifactId: string,
    externalId: string,
    sessionId: string,
  ): Session {
    const existing = this.database.getSession(sessionId);
    if (existing) return existing;
    return this.database.upsertSession({
      id: sessionId,
      sourceId: source.id,
      externalId,
      agent: source.agent as AgentId,
      channel: state.channel,
      cwd: state.cwd,
      title: null,
      model: state.model,
      startedAt: null,
      endedAt: null,
      updatedAt: null,
      status: "unknown",
      metadata: { artifactId, artifactPath: state.artifactPath },
    });
  }
}
