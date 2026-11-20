import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import type {
  AgentId,
  JsonMetadata,
  SourceChannel,
  TokenCounts,
  UsageProvenance,
} from "./types.js";

export type AdapterKind =
  | "codex-rollout"
  | "podex-rollout"
  | "claude-project"
  | "workbuddy-project"
  | "deepseek-session";

export interface DiscoveredAdapterSource {
  id: string;
  agent: AgentId;
  adapter: AdapterKind;
  rootPath: string;
  channel: SourceChannel;
  available: boolean;
  filePatterns: string[];
  metadata: JsonMetadata;
}

export interface DiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export interface NormalizedSession {
  externalId: string;
  agent: AgentId;
  channel: SourceChannel;
  cwd?: string | null;
  title?: string | null;
  model?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  status?: "active" | "completed" | "unknown" | "error";
  metadata?: JsonMetadata;
}

export interface NormalizedMessage {
  externalId: string;
  sessionExternalId: string;
  ordinal: number;
  timestamp: number | null;
  role: string;
  kind: string;
  content: string;
  metadata: JsonMetadata;
}

export interface NormalizedUsage extends TokenCounts {
  sessionExternalId: string;
  messageExternalId: string | null;
  timestamp: number;
  model: string | null;
  provenance: UsageProvenance;
  metadata: JsonMetadata;
}

export type AdapterPatch =
  | { type: "session"; eventKey: string; session: NormalizedSession }
  | { type: "message"; eventKey: string; message: NormalizedMessage }
  | { type: "usage"; eventKey: string; usage: NormalizedUsage };

export interface AdapterParseState {
  artifactPath: string;
  sessionExternalId: string | null;
  channel: SourceChannel;
  model: string | null;
  cwd: string | null;
  nextOrdinal: number;
  hasReportedUsage: boolean;
  sawSessionMeta: boolean;
  historyStartOrdinal: number | null;
  lineCarry: Buffer;
  zstdTornStart: Buffer;
}

export interface ParseLineResult {
  patches: AdapterPatch[];
  state: AdapterParseState;
  malformed?: string;
}

export interface ConsumeResult extends ParseLineResult {
  completeLines: number;
}

const ADAPTER_AGENT: Record<AdapterKind, AgentId> = {
  "codex-rollout": "codex",
  "podex-rollout": "podex",
  "claude-project": "claude-code",
  "workbuddy-project": "workbuddy",
  "deepseek-session": "deepseek-harness",
};

const JSONL_PATTERNS = ["**/*.jsonl"];
const DEEPSEEK_PATTERNS = ["**/session.v*.jsonl", "**/session.v*.jsonl.zstd"];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function canonicalPath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

function sourceId(agent: AgentId, rootPath: string): string {
  return `${agent}:${hash(canonicalPath(rootPath))}`;
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function directoryNames(value: string): Promise<string[]> {
  try {
    return (await readdir(value, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function configuredHome(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const configured = env[key]?.trim();
  return configured ? path.resolve(configured) : fallback;
}

function makeSource(
  agent: AgentId,
  adapter: AdapterKind,
  rootPath: string,
  available: boolean,
  filePatterns: string[],
  metadata: JsonMetadata = {},
): DiscoveredAdapterSource {
  return {
    id: sourceId(agent, rootPath),
    agent,
    adapter,
    rootPath,
    channel: adapter === "claude-project" ? "cli" : "unknown",
    available,
    filePatterns,
    metadata,
  };
}

/**
 * Finds only known session roots. It never opens config, auth, cookie, or
 * credential files; PodeX profile discovery enumerates directory names only.
 */
export async function discoverAgentSources(
  options: DiscoveryOptions = {},
): Promise<DiscoveredAdapterSource[]> {
  const home = path.resolve(options.homeDir ?? homedir());
  const env = options.env ?? process.env;
  const results: DiscoveredAdapterSource[] = [];

  const codexHome = configuredHome(env, "CODEX_HOME", path.join(home, ".codex"));
  const codexSessions = path.join(codexHome, "sessions");
  results.push(
    makeSource(
      "codex",
      "codex-rollout",
      codexSessions,
      await isDirectory(codexSessions),
      ["**/rollout-*.jsonl"],
    ),
  );

  const podexHome = configuredHome(env, "PODEX_HOME", path.join(home, ".podex"));
  const podexProfiles = path.join(podexHome, "profiles");
  const profileNames = await directoryNames(podexProfiles);
  const profileSessionRoots = (
    await Promise.all(
      profileNames.map(async (profile) => {
        const rootPath = path.join(podexProfiles, profile, "sessions");
        return (await isDirectory(rootPath)) ? { profile, rootPath } : null;
      }),
    )
  ).filter((value): value is { profile: string; rootPath: string } => value !== null);

  if (profileSessionRoots.length > 0) {
    for (const { profile, rootPath } of profileSessionRoots) {
      results.push(
        makeSource(
          "podex",
          "podex-rollout",
          rootPath,
          true,
          ["**/rollout-*.jsonl"],
          { profile },
        ),
      );
    }
  } else {
    const legacySessions = path.join(podexHome, "sessions");
    results.push(
      makeSource(
        "podex",
        "podex-rollout",
        legacySessions,
        await isDirectory(legacySessions),
        ["**/rollout-*.jsonl"],
      ),
    );
  }

  const claudeHome = configuredHome(
    env,
    "CLAUDE_CONFIG_DIR",
    path.join(home, ".claude"),
  );
  const claudeProjects = path.join(claudeHome, "projects");
  results.push(
    makeSource(
      "claude-code",
      "claude-project",
      claudeProjects,
      await isDirectory(claudeProjects),
      JSONL_PATTERNS,
    ),
  );

  const workbuddyHome = configuredHome(
    env,
    "WORKBUDDY_HOME",
    path.join(home, ".workbuddy"),
  );
  const workbuddyProjects = path.join(workbuddyHome, "projects");
  results.push(
    makeSource(
      "workbuddy",
      "workbuddy-project",
      workbuddyProjects,
      await isDirectory(workbuddyProjects),
      JSONL_PATTERNS,
    ),
  );

  const deepseekHome = configuredHome(env, "DSH_HOME", path.join(home, ".dsh"));
  const deepseekSessions = path.join(deepseekHome, "sessions");
  results.push(
    makeSource(
      "deepseek-harness",
      "deepseek-session",
      deepseekSessions,
      await isDirectory(deepseekSessions),
      DEEPSEEK_PATTERNS,
    ),
  );

  return results;
}

function sessionIdFromPath(artifactPath: string): string | null {
  if (!artifactPath) return null;
  const ids = artifactPath.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  );
  return ids?.at(-1) ?? null;
}

export function createAdapterState(
  artifactPath = "",
  sessionExternalId: string | null = sessionIdFromPath(artifactPath),
): AdapterParseState {
  return {
    artifactPath,
    sessionExternalId,
    channel: "unknown",
    model: null,
    cwd: null,
    nextOrdinal: 0,
    hasReportedUsage: false,
    sawSessionMeta: false,
    historyStartOrdinal: null,
    lineCarry: Buffer.alloc(0),
    zstdTornStart: Buffer.alloc(0),
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function firstToken(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return 0;
}

function hasTokenValue(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some(
    (key) =>
      typeof value[key] === "number" &&
      Number.isFinite(value[key]) &&
      (value[key] as number) >= 0,
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 0 && value < 10_000_000_000) return Math.trunc(value * 1_000);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function eventTimestamp(record: Record<string, unknown>): number | null {
  return timestamp(record.timestamp ?? record.time ?? record.createdAt);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(extractText)
      .filter(Boolean)
      .join("\n");
  }
  const object = asObject(value);
  if (!object) return "";
  const blockType = asString(object.type)?.toLowerCase();
  if (
    blockType &&
    !["text", "input_text", "output_text"].includes(blockType)
  ) {
    // Never expose hidden reasoning or tool payloads as conversation text.
    return "";
  }
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string" || Array.isArray(object.content)) {
    return extractText(object.content);
  }
  return "";
}

function visibleConversationText(value: unknown): string {
  const text = extractText(value)
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<app-context\b[^>]*>[\s\S]*?<\/app-context>/gi, "")
    .trim();

  // Agent hosts often persist their injected context using a user-shaped
  // message. It is useful to the model, but it is not part of the human
  // conversation and makes session titles misleading.
  if (
    /^# AGENTS\.md instructions for [^\r\n]+[\r\n]+<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*$/i.test(
      text,
    )
  ) {
    return "";
  }
  if (
    /^<(system-reminder|in-app-browser-context|external_browser_tabs|external_codex_apps_open_page|external_codex_apps_selected_page[^\s>]*|local-command-stdout|task-notification)\b[^>]*>[\s\S]*<\/\1>\s*$/i.test(
      text,
    )
  ) {
    return "";
  }
  return text;
}

function fallbackSessionId(state: AdapterParseState, adapter: AdapterKind): string {
  return (
    state.sessionExternalId ??
    sessionIdFromPath(state.artifactPath) ??
    `${ADAPTER_AGENT[adapter]}-${hash(canonicalPath(state.artifactPath || adapter))}`
  );
}

function channelFromSource(
  source: unknown,
  originator: unknown,
  fallback: SourceChannel,
): SourceChannel {
  if (asObject(source)?.subagent) {
    return "subagent";
  }
  const sourceText =
    typeof source === "string" ? source.toLowerCase() : JSON.stringify(source ?? "").toLowerCase();
  const originatorText = String(originator ?? "").toLowerCase();
  if (sourceText.includes("exec") || originatorText.includes("_exec")) return "exec";
  if (
    sourceText.includes("vscode") ||
    sourceText.includes("desktop") ||
    originatorText.includes("desktop")
  ) {
    return "desktop";
  }
  if (
    sourceText === "cli" ||
    sourceText.includes("terminal") ||
    originatorText.includes("tui") ||
    originatorText.includes("cli")
  ) {
    return "cli";
  }
  return fallback;
}

function patchSession(
  agent: AgentId,
  session: NormalizedSession,
): AdapterPatch {
  return {
    type: "session",
    eventKey: `${agent}:session:${session.externalId}`,
    session,
  };
}

function patchMessage(
  agent: AgentId,
  message: NormalizedMessage,
): AdapterPatch {
  return {
    type: "message",
    eventKey: `${agent}:message:${message.sessionExternalId}:${message.externalId}`,
    message,
  };
}

function patchUsage(
  agent: AgentId,
  nativeKey: string,
  usage: NormalizedUsage,
): AdapterPatch {
  return {
    type: "usage",
    eventKey: `${agent}:usage:${usage.sessionExternalId}:${nativeKey}`,
    usage,
  };
}

function normalizedOrdinal(record: Record<string, unknown>, state: AdapterParseState): number {
  return typeof record.ordinal === "number" && Number.isFinite(record.ordinal)
    ? Math.trunc(record.ordinal)
    : state.nextOrdinal;
}

function sessionUpdate(
  agent: AgentId,
  state: AdapterParseState,
  overrides: Partial<NormalizedSession> = {},
): AdapterPatch {
  const externalId = overrides.externalId ?? fallbackSessionId(state, agentToAdapter(agent));
  return patchSession(agent, {
    externalId,
    agent,
    channel: overrides.channel ?? state.channel,
    cwd: overrides.cwd === undefined ? state.cwd : overrides.cwd,
    model: overrides.model === undefined ? state.model : overrides.model,
    ...overrides,
  });
}

function agentToAdapter(agent: AgentId): AdapterKind {
  switch (agent) {
    case "codex":
      return "codex-rollout";
    case "podex":
      return "podex-rollout";
    case "claude-code":
      return "claude-project";
    case "workbuddy":
      return "workbuddy-project";
    case "deepseek-harness":
      return "deepseek-session";
  }
}

function codexTokens(value: unknown): TokenCounts | null {
  const usage = asObject(value);
  if (!usage) return null;
  const keys = [
    "input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "total_tokens",
  ];
  if (!hasTokenValue(usage, keys)) return null;
  return {
    inputTokens: asToken(usage.input_tokens),
    outputTokens: asToken(usage.output_tokens),
    reasoningTokens: asToken(usage.reasoning_output_tokens),
    cacheReadTokens: asToken(usage.cached_input_tokens),
    cacheWriteTokens: asToken(usage.cache_write_input_tokens),
    totalTokens: asToken(usage.total_tokens),
  };
}

function parseRollout(
  adapter: "codex-rollout" | "podex-rollout",
  record: Record<string, unknown>,
  inputState: AdapterParseState,
): ParseLineResult {
  const agent = ADAPTER_AGENT[adapter];
  const payload = asObject(record.payload) ?? {};
  const patches: AdapterPatch[] = [];
  let state = { ...inputState };
  const at = eventTimestamp(record);
  const recordOrdinal =
    typeof record.ordinal === "number" && Number.isFinite(record.ordinal)
      ? Math.trunc(record.ordinal)
      : null;

  if (
    state.historyStartOrdinal !== null &&
    recordOrdinal !== null &&
    recordOrdinal > 0 &&
    recordOrdinal < state.historyStartOrdinal
  ) {
    state.nextOrdinal += 1;
    return { patches, state };
  }

  if (record.type === "session_meta") {
    const externalId =
      asString(payload.id) ?? asString(payload.session_id) ?? fallbackSessionId(state, adapter);
    if (
      state.sawSessionMeta &&
      state.sessionExternalId !== null &&
      externalId !== state.sessionExternalId
    ) {
      state.nextOrdinal += 1;
      return { patches, state };
    }
    const channel = channelFromSource(payload.source, payload.originator, state.channel);
    const cwd = asString(payload.cwd) ?? state.cwd;
    state = {
      ...state,
      sessionExternalId: externalId,
      channel,
      cwd,
      sawSessionMeta: true,
      historyStartOrdinal:
        typeof payload.subagent_history_start_ordinal === "number"
          ? Math.trunc(payload.subagent_history_start_ordinal)
          : state.historyStartOrdinal,
    };
    patches.push(
      patchSession(agent, {
        externalId,
        agent,
        channel,
        cwd,
        title:
          payload.thread_source === "subagent"
            ? asString(payload.agent_nickname) ?? asString(payload.agent_path)
            : null,
        startedAt: timestamp(payload.timestamp) ?? at,
        status: "active",
        metadata: {
          source: payload.source ?? null,
          originator: payload.originator ?? null,
          threadSource: payload.thread_source ?? null,
        },
      }),
    );
  } else if (record.type === "turn_context") {
    const model = asString(payload.model) ?? state.model;
    const cwd = asString(payload.cwd) ?? state.cwd;
    state = { ...state, model, cwd };
    if (model !== inputState.model || cwd !== inputState.cwd) {
      patches.push(sessionUpdate(agent, state, { model, cwd, status: "active" }));
    }
  } else if (record.type === "response_item" && payload.type === "message") {
    const sessionExternalId = fallbackSessionId(state, adapter);
    const role = asString(payload.role) ?? "unknown";
    const content = visibleConversationText(payload.content);
    const nativeId =
      asString(payload.id) ??
      `${normalizedOrdinal(record, state)}-${hash(JSON.stringify(record))}`;
    if ((role === "user" || role === "assistant") && content) {
      patches.push(
        patchMessage(agent, {
        externalId: nativeId,
        sessionExternalId,
        ordinal: normalizedOrdinal(record, state),
        timestamp: at,
        role,
        kind: asString(payload.phase) ?? "message",
        content,
        metadata: {
          status: payload.status ?? null,
          phase: payload.phase ?? null,
        },
        }),
      );
    }
  } else if (record.type === "token_usage_record") {
    // Response deltas preserve an accurate time series. response_id is stable,
    // while thread_token_usage is cumulative and would place a whole thread's
    // history at its final timestamp.
    const tokens = codexTokens(payload.usage);
    if (tokens) {
      const sessionExternalId =
        asString(payload.thread_id) ??
        state.sessionExternalId ??
        asString(payload.session_id) ??
        fallbackSessionId(state, adapter);
      const responseId =
        asString(payload.response_id) ??
        asString(payload.turn_id) ??
        `${normalizedOrdinal(record, state)}-${hash(JSON.stringify(record))}`;
      state = { ...state, hasReportedUsage: true };
      patches.push(
        patchUsage(agent, responseId, {
          ...tokens,
          sessionExternalId,
          messageExternalId: null,
          timestamp: at ?? 0,
          model: state.model,
          provenance: "reported",
          metadata: {
            aggregate: "response",
            removeThreadFallback: true,
            responseId: payload.response_id ?? null,
            turnId: payload.turn_id ?? null,
          },
        }),
      );
    }
  } else if (
    record.type === "event_msg" &&
    payload.type === "token_count" &&
    !state.hasReportedUsage
  ) {
    const info = asObject(payload.info);
    const tokens = codexTokens(info?.total_token_usage);
    if (tokens) {
      const sessionExternalId =
        asString(payload.thread_id) ??
        state.sessionExternalId ??
        fallbackSessionId(state, adapter);
      patches.push(
        patchUsage(agent, "session-total", {
          ...tokens,
          sessionExternalId,
          messageExternalId: null,
          timestamp: at ?? 0,
          model: state.model,
          provenance: "reported",
          metadata: { aggregate: "thread-fallback", fallback: "token_count" },
        }),
      );
    }
  } else if (record.type === "event_msg" && payload.type === "task_complete") {
    patches.push(
      sessionUpdate(agent, state, {
        endedAt: timestamp(payload.completed_at) ?? at,
        status: "completed",
      }),
    );
  }

  state.nextOrdinal += 1;
  return { patches, state };
}

function claudeTokens(value: unknown): { tokens: TokenCounts; provenance: UsageProvenance } | null {
  const usage = asObject(value);
  if (!usage) return null;
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "total_tokens",
  ];
  if (!hasTokenValue(usage, keys)) return null;
  const inputTokens = asToken(usage.input_tokens);
  const outputTokens = asToken(usage.output_tokens);
  const cacheReadTokens = asToken(usage.cache_read_input_tokens);
  const cacheWriteTokens = asToken(usage.cache_creation_input_tokens);
  const normalizedInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const hasReportedTotal = hasTokenValue(usage, ["total_tokens"]);
  return {
    tokens: {
      inputTokens: normalizedInputTokens,
      outputTokens,
      reasoningTokens: firstToken(
        asObject(usage.output_tokens_details)?.reasoning_tokens,
        asObject(usage.output_tokens_details)?.thinking_tokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: hasReportedTotal
        ? asToken(usage.total_tokens)
        : normalizedInputTokens + outputTokens,
    },
    provenance: hasReportedTotal ? "reported" : "derived",
  };
}

function parseClaude(
  record: Record<string, unknown>,
  inputState: AdapterParseState,
): ParseLineResult {
  const agent: AgentId = "claude-code";
  const message = asObject(record.message);
  const externalId =
    asString(record.sessionId) ?? asString(record.session_id) ?? fallbackSessionId(inputState, "claude-project");
  const cwd = asString(record.cwd) ?? inputState.cwd;
  const model = asString(message?.model) ?? inputState.model;
  const entrypoint = asString(record.entrypoint);
  const channel: SourceChannel = entrypoint?.toLowerCase().includes("sdk")
    ? "sdk"
    : "cli";
  const state: AdapterParseState = {
    ...inputState,
    sessionExternalId: externalId,
    channel,
    cwd,
    model,
    nextOrdinal: inputState.nextOrdinal + 1,
  };
  const patches: AdapterPatch[] = [];
  const at = eventTimestamp(record);

  if (record.type === "ai-title") {
    patches.push(
      sessionUpdate(agent, state, {
        title: asString(record.aiTitle),
        status: "active",
      }),
    );
    return { patches, state };
  }

  if (record.type === "cost-state") {
    const modelUsage = asObject(record.modelUsage);
    if (!modelUsage) return { patches, state };
    const models = Object.keys(modelUsage).sort();
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let foundUsage = false;
    for (const modelName of models) {
      const counts = asObject(modelUsage[modelName]);
      if (!counts) continue;
      const numericKeys = [
        "inputTokens",
        "outputTokens",
        "thinkingTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
      ];
      if (hasTokenValue(counts, numericKeys)) foundUsage = true;
      inputTokens += asToken(counts.inputTokens);
      outputTokens += asToken(counts.outputTokens);
      reasoningTokens += asToken(counts.thinkingTokens);
      cacheReadTokens += asToken(counts.cacheReadInputTokens);
      cacheWriteTokens += asToken(counts.cacheCreationInputTokens);
    }
    if (foundUsage) {
      const startedAt = timestamp(record.startTime) ?? at ?? 0;
      const duration = asToken(record.totalDuration);
      patches.push(
        patchUsage(agent, "session-total", {
          inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens:
            inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
          sessionExternalId: externalId,
          messageExternalId: null,
          timestamp: startedAt + duration,
          model: models.length === 1 ? models[0] : null,
          provenance: "derived",
          metadata: {
            aggregate: "session",
            replaceSessionUsage: true,
            models,
            totalCostUsd:
              typeof record.totalCostUSD === "number" ? record.totalCostUSD : null,
          },
        }),
      );
    }
    return { patches, state };
  }

  if (record.type === "user" || record.type === "assistant") {
    if (
      inputState.nextOrdinal === 0 ||
      externalId !== inputState.sessionExternalId ||
      cwd !== inputState.cwd ||
      model !== inputState.model ||
      channel !== inputState.channel
    ) {
      patches.push(
        sessionUpdate(agent, state, {
          startedAt: at,
          status: "active",
          metadata: { entrypoint: record.entrypoint ?? null },
        }),
      );
    }
    const messageId =
      asString(message?.id) ??
      asString(record.uuid) ??
      `${inputState.nextOrdinal}-${hash(JSON.stringify(record))}`;
    const role = asString(message?.role) ?? String(record.type);
    const content = visibleConversationText(message?.content ?? record.content);
    const storesMessage =
      content.length > 0 &&
      record.isMeta !== true &&
      record.toolUseResult === undefined &&
      (role === "user" || role === "assistant");
    if (storesMessage) {
      patches.push(
        patchMessage(agent, {
        externalId: messageId,
        sessionExternalId: externalId,
        ordinal: inputState.nextOrdinal,
        timestamp: at,
        role,
        kind: String(record.type),
        content,
        metadata: {
          parentUuid: record.parentUuid ?? null,
          stopReason: message?.stop_reason ?? null,
        },
        }),
      );
    }

    const normalized = claudeTokens(message?.usage);
    if (normalized) {
      patches.push(
        patchUsage(agent, messageId, {
          ...normalized.tokens,
          sessionExternalId: externalId,
          messageExternalId: storesMessage ? messageId : null,
          timestamp: at ?? 0,
          model,
          provenance: normalized.provenance,
          metadata: {},
        }),
      );
    }
  }

  // cost-state is emitted above as an authoritative snapshot. The collector
  // stores only its adjustment over response deltas, preserving both totals
  // and the response-level time series.
  return { patches, state };
}

function workbuddyTokens(
  record: Record<string, unknown>,
): { tokens: TokenCounts; provenance: UsageProvenance } | null {
  const providerData = asObject(record.providerData) ?? {};
  const rawUsage = asObject(providerData.rawUsage);
  const providerUsage = asObject(providerData.usage);
  const messageUsage = asObject(asObject(record.message)?.usage);
  const tokenKeys = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "input_tokens",
    "output_tokens",
  ];
  const usage = [rawUsage, providerUsage, messageUsage].find(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && hasTokenValue(candidate, tokenKeys),
  );
  if (!usage) return null;

  const inputTokens = firstToken(
    usage.prompt_tokens,
    usage.inputTokens,
    usage.input_tokens,
  );
  const outputTokens = firstToken(
    usage.completion_tokens,
    usage.outputTokens,
    usage.output_tokens,
  );
  const totalWasReported = hasTokenValue(usage, ["total_tokens", "totalTokens"]);
  const promptDetails = asObject(usage.prompt_tokens_details);
  const completionDetails = asObject(usage.completion_tokens_details);
  return {
    tokens: {
      inputTokens,
      outputTokens,
      reasoningTokens: firstToken(
        usage.completion_thinking_tokens,
        completionDetails?.reasoning_tokens,
        asObject(providerUsage?.outputTokensDetails)?.reasoningTokens,
      ),
      cacheReadTokens: firstToken(
        usage.cache_read_input_tokens,
        usage.prompt_cache_hit_tokens,
        usage.cached_tokens,
        promptDetails?.cached_tokens,
        asObject(providerUsage?.inputTokensDetails)?.cacheReadTokens,
      ),
      cacheWriteTokens: firstToken(
        usage.cache_creation_input_tokens,
        usage.prompt_cache_write_tokens,
        asObject(providerUsage?.inputTokensDetails)?.cacheWriteTokens,
      ),
      totalTokens: totalWasReported
        ? firstToken(usage.total_tokens, usage.totalTokens)
        : inputTokens + outputTokens,
    },
    provenance: totalWasReported ? "reported" : "derived",
  };
}

function workbuddyMessageContent(record: Record<string, unknown>, role: string): string {
  const content = extractText(record.content);
  if (role !== "user") return content;
  const userQueries = [...content.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (userQueries.length > 0) return userQueries.join("\n\n");
  return content
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    .trim();
}

function parseWorkbuddy(
  record: Record<string, unknown>,
  inputState: AdapterParseState,
): ParseLineResult {
  const agent: AgentId = "workbuddy";
  const sessionExternalId =
    asString(record.sessionId) ?? fallbackSessionId(inputState, "workbuddy-project");
  const providerData = asObject(record.providerData) ?? {};
  const cwd = asString(record.cwd) ?? inputState.cwd;
  const model =
    asString(providerData.requestModelName) ??
    asString(providerData.model) ??
    asString(providerData.requestModelId) ??
    inputState.model;
  const state: AdapterParseState = {
    ...inputState,
    sessionExternalId,
    channel: inputState.channel === "unknown" ? "interactive" : inputState.channel,
    cwd,
    model,
    nextOrdinal: inputState.nextOrdinal + 1,
  };
  const at = eventTimestamp(record);
  const patches: AdapterPatch[] = [];

  if (record.type === "session-meta") {
    const meta = asObject(record.meta) ?? {};
    const channel = channelFromSource(meta["codebuddy.ai/hostKind"], null, state.channel);
    state.channel = channel;
    patches.push(
      sessionUpdate(agent, state, {
        // record.id identifies this session-meta event, not the session.
        externalId: sessionExternalId,
        channel,
        startedAt: at,
        status: "active",
        metadata: { hostKind: meta["codebuddy.ai/hostKind"] ?? null },
      }),
    );
    return { patches, state };
  }

  if (record.type === "ai-title") {
    patches.push(
      sessionUpdate(agent, state, {
        title: asString(record.aiTitle),
        status: "active",
      }),
    );
    return { patches, state };
  }

  const usageBearing = new Set([
    "message",
    "reasoning",
    "function_call",
    "function_call_result",
  ]);
  if (typeof record.type === "string" && usageBearing.has(record.type)) {
    if (
      inputState.nextOrdinal === 0 ||
      sessionExternalId !== inputState.sessionExternalId ||
      cwd !== inputState.cwd ||
      model !== inputState.model
    ) {
      patches.push(sessionUpdate(agent, state, { startedAt: at, status: "active" }));
    }
    const messageId =
      asString(record.id) ??
      asString(providerData.messageId) ??
      `${inputState.nextOrdinal}-${hash(JSON.stringify(record))}`;
    const role = asString(record.role);
    const storesMessage =
      record.type === "message" && (role === "user" || role === "assistant");
    if (storesMessage) {
      patches.push(
        patchMessage(agent, {
          externalId: messageId,
          sessionExternalId,
          ordinal: inputState.nextOrdinal,
          timestamp: at,
          role,
          kind: "message",
          content: workbuddyMessageContent(record, role),
          metadata: {
            parentId: record.parentId ?? null,
            status: record.status ?? null,
          },
        }),
      );
    }

    const normalized = workbuddyTokens(record);
    if (normalized) {
      // One provider message can surface the same usage on a function_call and
      // again on the final assistant message. providerData.messageId makes
      // those records idempotent rather than additive.
      const usageNativeId = asString(providerData.messageId) ?? messageId;
      patches.push(
        patchUsage(agent, usageNativeId, {
          ...normalized.tokens,
          sessionExternalId,
          messageExternalId: storesMessage ? messageId : null,
          timestamp: at ?? 0,
          model,
          provenance: normalized.provenance,
          metadata: {
            traceId: providerData.traceId ?? null,
            requestModelId: providerData.requestModelId ?? null,
          },
        }),
      );
    }
  }

  return { patches, state };
}

function deepseekTokens(value: unknown): { tokens: TokenCounts; provenance: UsageProvenance } | null {
  const usage = asObject(value);
  if (!usage) return null;
  const keys = [
    "inputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
  ];
  if (!hasTokenValue(usage, keys)) return null;
  const rawInputTokens = firstToken(usage.uncachedInputTokens, usage.inputTokens);
  const outputTokens = asToken(usage.outputTokens);
  const cacheReadTokens = asToken(usage.cacheReadTokens);
  const cacheWriteTokens = asToken(usage.cacheWriteTokens);
  const totalWasReported = hasTokenValue(usage, ["totalTokens"]);
  const totalTokens = totalWasReported
    ? asToken(usage.totalTokens)
    : rawInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  const inputTokens = totalWasReported
    ? Math.max(rawInputTokens, totalTokens - outputTokens)
    : rawInputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    tokens: {
      inputTokens,
      outputTokens,
      reasoningTokens: asToken(usage.reasoningTokens),
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
    },
    provenance: totalWasReported ? "reported" : "derived",
  };
}

function parseDeepseek(
  record: Record<string, unknown>,
  inputState: AdapterParseState,
): ParseLineResult {
  const agent: AgentId = "deepseek-harness";
  const data = asObject(record.data) ?? {};
  const patches: AdapterPatch[] = [];
  let state = { ...inputState, nextOrdinal: inputState.nextOrdinal + 1 };
  const at = eventTimestamp(record);

  if (record.type === "session") {
    const sessionExternalId = asString(record.id) ?? fallbackSessionId(state, "deepseek-session");
    const cwd = asString(record.cwd) ?? state.cwd;
    state = { ...state, sessionExternalId, cwd };
    patches.push(
      patchSession(agent, {
        externalId: sessionExternalId,
        agent,
        channel: state.channel,
        cwd,
        startedAt: timestamp(record.createdAt) ?? at,
        status: "active",
        metadata: {
          version: record.version ?? null,
          agentPreset: record.agentPreset ?? null,
        },
      }),
    );
    return { patches, state };
  }

  const sessionExternalId = fallbackSessionId(state, "deepseek-session");
  if (record.type === "session/title") {
    patches.push(
      sessionUpdate(agent, state, {
        externalId: sessionExternalId,
        title: asString(data.title),
        status: "active",
      }),
    );
    return { patches, state };
  }

  if (record.type === "user/message" || record.type === "assistant/message") {
    const message = record.type === "assistant/message" ? asObject(data.message) ?? {} : data;
    const source = message.source ?? data.source;
    const channel = channelFromSource(source, null, state.channel);
    const sourceObject = asObject(source);
    const model = asString(sourceObject?.model) ?? state.model;
    const sessionChanged = channel !== state.channel || model !== state.model;
    state = { ...state, channel, model };
    const messageId =
      asString(message.id) ??
      (typeof record.seq === "number" ? `seq-${record.seq}` : `${inputState.nextOrdinal}-${hash(JSON.stringify(record))}`);
    if (sessionChanged) {
      patches.push(sessionUpdate(agent, state, { channel, model, status: "active" }));
    }
    const content = visibleConversationText(message.content);
    if (content) {
      patches.push(
        patchMessage(agent, {
        externalId: messageId,
        sessionExternalId,
        ordinal:
          typeof record.seq === "number" && Number.isFinite(record.seq)
            ? Math.trunc(record.seq)
            : inputState.nextOrdinal,
        timestamp: at,
        role: asString(message.role) ?? (record.type === "user/message" ? "user" : "assistant"),
        kind: record.type,
        content,
        metadata: {
          source: source ?? null,
          turn: data.turn ?? null,
          step: data.step ?? null,
          interrupted: data.interrupted ?? null,
        },
        }),
      );
    }
    const normalized = deepseekTokens(data.usage);
    if (normalized) {
      patches.push(
        patchUsage(agent, messageId, {
          ...normalized.tokens,
          sessionExternalId,
          messageExternalId: content ? messageId : null,
          timestamp: at ?? 0,
          model,
          provenance: normalized.provenance,
          metadata: {},
        }),
      );
    }
  }

  return { patches, state };
}

export function parseAdapterLine(
  adapter: AdapterKind,
  line: string,
  inputState: AdapterParseState,
): ParseLineResult {
  if (!line.trim()) return { patches: [], state: inputState };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      patches: [],
      state: inputState,
      malformed: error instanceof Error ? error.message : String(error),
    };
  }
  const record = asObject(parsed);
  if (!record) return { patches: [], state: inputState, malformed: "JSON value is not an object" };

  switch (adapter) {
    case "codex-rollout":
    case "podex-rollout":
      return parseRollout(adapter, record, inputState);
    case "claude-project":
      return parseClaude(record, inputState);
    case "workbuddy-project":
      return parseWorkbuddy(record, inputState);
    case "deepseek-session":
      return parseDeepseek(record, inputState);
  }
}

/** Collector-facing short name. */
export const parseLine = parseAdapterLine;

/** Incrementally consumes newline-delimited JSON without decoding a torn UTF-8 tail. */
export function consumeJsonlChunk(
  adapter: AdapterKind,
  chunk: Buffer | string,
  inputState: AdapterParseState,
): ConsumeResult {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const combined = Buffer.concat([inputState.lineCarry, bytes]);
  let offset = 0;
  let completeLines = 0;
  let state: AdapterParseState = { ...inputState, lineCarry: Buffer.alloc(0) };
  const patches: AdapterPatch[] = [];
  let malformed: string | undefined;

  for (let newline = combined.indexOf(0x0a, offset); newline >= 0; newline = combined.indexOf(0x0a, offset)) {
    let end = newline;
    if (end > offset && combined[end - 1] === 0x0d) end -= 1;
    const line = combined.subarray(offset, end).toString("utf8");
    const result = parseAdapterLine(adapter, line, state);
    state = result.state;
    patches.push(...result.patches);
    malformed ??= result.malformed;
    completeLines += 1;
    offset = newline + 1;
  }

  state = { ...state, lineCarry: Buffer.from(combined.subarray(offset)) };
  return { patches, state, malformed, completeLines };
}

export function flushJsonlCarry(
  adapter: AdapterKind,
  inputState: AdapterParseState,
): ConsumeResult {
  if (inputState.lineCarry.length === 0) {
    return { patches: [], state: inputState, completeLines: 0 };
  }
  const line = inputState.lineCarry.toString("utf8");
  const cleared = { ...inputState, lineCarry: Buffer.alloc(0) };
  const result = parseAdapterLine(adapter, line, cleared);
  return { ...result, completeLines: 1 };
}

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_BASE = 0x184d2a50;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface ZstdFrame {
  bytes: Buffer;
  offset: number;
  kind: "zstd" | "skippable";
}

export interface ZstdFrameScan {
  frames: ZstdFrame[];
  tornStart: Buffer;
}

type FrameLengthResult =
  | { status: "complete"; length: number; kind: ZstdFrame["kind"] }
  | { status: "incomplete" }
  | { status: "invalid" };

function zstdFrameLength(buffer: Buffer, start: number): FrameLengthResult {
  if (buffer.length - start < 4) return { status: "incomplete" };
  const magic = buffer.readUInt32LE(start);
  if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC_BASE) {
    if (buffer.length - start < 8) return { status: "incomplete" };
    const payloadSize = buffer.readUInt32LE(start + 4);
    const length = 8 + payloadSize;
    return buffer.length - start >= length
      ? { status: "complete", length, kind: "skippable" }
      : { status: "incomplete" };
  }
  if (magic !== ZSTD_MAGIC) return { status: "invalid" };

  let cursor = start + 4;
  if (cursor >= buffer.length) return { status: "incomplete" };
  const descriptor = buffer[cursor++];
  const frameContentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryIdFlag = descriptor & 0x03;
  if ((descriptor & 0x18) !== 0) return { status: "invalid" };

  if (!singleSegment) cursor += 1; // Window Descriptor
  cursor += [0, 1, 2, 4][dictionaryIdFlag];
  cursor +=
    frameContentSizeFlag === 0
      ? singleSegment
        ? 1
        : 0
      : frameContentSizeFlag === 1
        ? 2
        : frameContentSizeFlag === 2
          ? 4
          : 8;
  if (cursor > buffer.length) return { status: "incomplete" };

  for (;;) {
    if (cursor + 3 > buffer.length) return { status: "incomplete" };
    const blockHeader = buffer.readUIntLE(cursor, 3);
    cursor += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3 || blockSize > 128 * 1024) return { status: "invalid" };
    cursor += blockType === 1 ? 1 : blockSize;
    if (cursor > buffer.length) return { status: "incomplete" };
    if (lastBlock) break;
  }

  if (checksum) cursor += 4;
  if (cursor > buffer.length) return { status: "incomplete" };
  return { status: "complete", length: cursor - start, kind: "zstd" };
}

function isSkippableMagicAt(buffer: Buffer, offset: number): boolean {
  return (
    buffer.length - offset >= 4 &&
    (buffer.readUInt32LE(offset) & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC_BASE
  );
}

function isStandardMagicAt(buffer: Buffer, offset: number): boolean {
  return buffer.length - offset >= 4 && buffer.readUInt32LE(offset) === ZSTD_MAGIC;
}

function possibleMagicPrefix(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length >= 4) return false;
  let standard = true;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== ZSTD_MAGIC_BYTES[index]) standard = false;
  }
  if (standard) return true;
  if (bytes[0] < 0x50 || bytes[0] > 0x5f) return false;
  const suffix = [0x2a, 0x4d, 0x18];
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] !== suffix[index - 1]) return false;
  }
  return true;
}

function trailingMagicPrefix(buffer: Buffer): Buffer {
  for (let length = Math.min(3, buffer.length); length > 0; length -= 1) {
    const candidate = buffer.subarray(buffer.length - length);
    if (possibleMagicPrefix(candidate)) return Buffer.from(candidate);
  }
  return Buffer.alloc(0);
}

/**
 * Scans concatenated RFC 8878 frames. Complete frames are returned exactly;
 * an incomplete frame (or partial trailing magic) is retained as tornStart.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrame[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    if (buffer.length - cursor < 4) {
      const tail = buffer.subarray(cursor);
      if (possibleMagicPrefix(tail)) {
        return { frames, tornStart: Buffer.from(tail) };
      }
      throw new Error(`Malformed zstd stream at offset ${cursor}: invalid magic prefix`);
    }
    if (!isStandardMagicAt(buffer, cursor) && !isSkippableMagicAt(buffer, cursor)) {
      throw new Error(`Malformed zstd stream at offset ${cursor}: expected frame magic`);
    }

    const parsed = zstdFrameLength(buffer, cursor);
    if (parsed.status === "incomplete") {
      return { frames, tornStart: Buffer.from(buffer.subarray(cursor)) };
    }
    if (parsed.status === "invalid") {
      throw new Error(`Malformed zstd frame at offset ${cursor}`);
    }

    frames.push({
      bytes: Buffer.from(buffer.subarray(cursor, cursor + parsed.length)),
      offset: cursor,
      kind: parsed.kind,
    });
    cursor += parsed.length;
  }

  return { frames, tornStart: Buffer.alloc(0) };
}

export function decodeZstdFrame(frame: ZstdFrame | Buffer): Buffer {
  const bytes = Buffer.isBuffer(frame) ? frame : frame.bytes;
  if (!Buffer.isBuffer(frame) && frame.kind === "skippable") return Buffer.alloc(0);
  return zstdDecompressSync(bytes);
}

export function consumeDeepSeekZstdChunk(
  chunk: Buffer,
  inputState: AdapterParseState,
): ConsumeResult {
  const compressed = Buffer.concat([inputState.zstdTornStart, chunk]);
  const scan = scanZstdFrames(compressed);
  let state = { ...inputState, zstdTornStart: scan.tornStart };
  const patches: AdapterPatch[] = [];
  let completeLines = 0;
  let malformed: string | undefined;

  for (const frame of scan.frames) {
    if (frame.kind === "skippable") continue;
    const decoded = decodeZstdFrame(frame);
    const consumed = consumeJsonlChunk("deepseek-session", decoded, state);
    state = consumed.state;
    patches.push(...consumed.patches);
    completeLines += consumed.completeLines;
    malformed ??= consumed.malformed;
  }

  state = { ...state, zstdTornStart: scan.tornStart };
  return { patches, state, completeLines, malformed };
}

/** Collector-facing name for decoding one or more complete/torn frame chunks. */
export const decodeDeepSeekFrames = consumeDeepSeekZstdChunk;
