import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeDeepSeekZstdChunk,
  consumeJsonlChunk,
  createAdapterState,
  discoverAgentSources,
  parseAdapterLine,
  scanZstdFrames,
} from "./adapters.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("source discovery", () => {
  it("finds the five Windows-local agent roots without opening config files", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-monitor-adapters-"));
    tempRoots.push(home);
    await Promise.all([
      mkdir(path.join(home, ".codex", "sessions"), { recursive: true }),
      mkdir(path.join(home, ".podex", "profiles", "profile-a", "sessions"), {
        recursive: true,
      }),
      mkdir(path.join(home, ".claude", "projects"), { recursive: true }),
      mkdir(path.join(home, ".workbuddy", "projects"), { recursive: true }),
      mkdir(path.join(home, ".dsh", "sessions"), { recursive: true }),
    ]);

    const discovered = await discoverAgentSources({ homeDir: home, env: {} });
    expect(discovered.map((source) => source.agent)).toEqual([
      "codex",
      "podex",
      "claude-code",
      "workbuddy",
      "deepseek-harness",
    ]);
    expect(discovered.every((source) => source.available)).toBe(true);
    expect(discovered.find((source) => source.agent === "podex")?.metadata).toEqual({
      profile: "profile-a",
    });
  });
});

describe("JSONL adapters", () => {
  it("keeps a half line until the newline arrives", () => {
    const line = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-11-20T00:00:00Z",
      payload: {
        id: "session-1",
        cwd: "D:\\repo",
        source: "exec",
        originator: "codex_exec",
      },
    });
    const split = Math.floor(line.length / 2);
    const initial = createAdapterState("rollout-session-1.jsonl");
    const first = consumeJsonlChunk("codex-rollout", line.slice(0, split), initial);
    expect(first.patches).toEqual([]);
    expect(first.state.lineCarry.length).toBeGreaterThan(0);

    const second = consumeJsonlChunk(
      "codex-rollout",
      `${line.slice(split)}\n`,
      first.state,
    );
    expect(second.completeLines).toBe(1);
    expect(second.patches).toHaveLength(1);
    expect(second.patches[0]).toMatchObject({
      type: "session",
      session: { externalId: "session-1", channel: "exec" },
    });
    expect(second.state.lineCarry.length).toBe(0);
  });

  it("gives duplicate rollout usage records the same stable event key", () => {
    const line = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-11-20T01:02:03Z",
      payload: {
        // Subagents can carry their parent's session_id while thread_id is
        // their own durable session identity.
        session_id: "parent-session",
        thread_id: "session-1",
        turn_id: "turn-1",
        response_id: "response-1",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 3,
          cache_write_input_tokens: 2,
          output_tokens: 4,
          reasoning_output_tokens: 1,
          total_tokens: 14,
        },
        thread_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          cache_write_input_tokens: 20,
          output_tokens: 40,
          reasoning_output_tokens: 10,
          total_tokens: 140,
        },
      },
    });
    const state = createAdapterState("rollout-session-1.jsonl", "session-1");
    const first = parseAdapterLine("codex-rollout", line, state);
    const second = parseAdapterLine("codex-rollout", line, first.state);
    const firstUsage = first.patches.find((patch) => patch.type === "usage");
    const secondUsage = second.patches.find((patch) => patch.type === "usage");
    expect(firstUsage?.eventKey).toBe(secondUsage?.eventKey);
    expect(firstUsage).toMatchObject({
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 14,
        provenance: "reported",
        messageExternalId: null,
        sessionExternalId: "session-1",
      },
    });
    expect(firstUsage?.eventKey).toBe("codex:usage:session-1:response-1");
    expect(first.state.hasReportedUsage).toBe(true);
  });

  it("uses token_count total_token_usage as the same session-total fallback", () => {
    const state = createAdapterState("rollout-session-1.jsonl", "session-1");
    const result = parseAdapterLine(
      "codex-rollout",
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-11-20T01:02:03Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 21,
              output_tokens: 8,
              cached_input_tokens: 5,
              cache_write_input_tokens: 2,
              reasoning_output_tokens: 3,
              total_tokens: 29,
            },
          },
        },
      }),
      state,
    );
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]).toMatchObject({
      eventKey: "codex:usage:session-1:session-total",
      usage: { totalTokens: 29, messageExternalId: null },
    });
  });

  it("skips copied parent history at the start of a subagent rollout", () => {
    const lines = [
      {
        ordinal: 0,
        type: "session_meta",
        payload: {
          id: "child-session",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent-session" } } },
          thread_source: "subagent",
          agent_nickname: "Builder",
          subagent_history_start_ordinal: 3,
        },
      },
      {
        ordinal: 1,
        type: "session_meta",
        payload: { id: "parent-session", source: "vscode" },
      },
      {
        ordinal: 2,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "copied parent prompt" }],
        },
      },
      {
        ordinal: 3,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "child answer" }],
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    const result = consumeJsonlChunk(
      "codex-rollout",
      lines,
      createAdapterState("rollout-child-session.jsonl", "child-session"),
    );
    expect(
      result.patches
        .filter((patch) => patch.type === "session")
        .map((patch) => patch.session.externalId),
    ).toEqual(["child-session"]);
    expect(
      result.patches
        .filter((patch) => patch.type === "message")
        .map((patch) => patch.message.content),
    ).toEqual(["child answer"]);
    expect(result.state.channel).toBe("subagent");
  });

  it("does not expose host-injected instructions as user conversation", () => {
    const state = createAdapterState("rollout-session-1.jsonl", "session-1");
    const injected = parseAdapterLine(
      "codex-rollout",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions for D:\\\\code\\\\project\n\n<INSTRUCTIONS>\nprivate host context\n</INSTRUCTIONS>",
            },
          ],
        },
      }),
      state,
    );
    const reminder = parseAdapterLine(
      "codex-rollout",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<system-reminder>private host context</system-reminder>",
            },
          ],
        },
      }),
      injected.state,
    );
    expect(injected.patches.find((patch) => patch.type === "message")).toBeUndefined();
    expect(reminder.patches.find((patch) => patch.type === "message")).toBeUndefined();
  });

  it("deduplicates WorkBuddy usage repeated on tool and final message records", () => {
    const commonProviderData = {
      messageId: "provider-message-7",
      requestModelName: "model-x",
      rawUsage: {
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
      },
    };
    const tool = JSON.stringify({
      type: "function_call",
      id: "tool-1",
      sessionId: "wb-session",
      timestamp: 1_700_000_000_000,
      name: "read",
      providerData: commonProviderData,
    });
    const message = JSON.stringify({
      type: "message",
      id: "assistant-1",
      sessionId: "wb-session",
      timestamp: 1_700_000_000_001,
      role: "assistant",
      content: "done",
      providerData: commonProviderData,
    });
    const state = createAdapterState("wb-session.jsonl", "wb-session");
    const first = parseAdapterLine("workbuddy-project", tool, state);
    const second = parseAdapterLine("workbuddy-project", message, first.state);
    const firstUsage = first.patches.find((patch) => patch.type === "usage");
    const secondUsage = second.patches.find((patch) => patch.type === "usage");
    expect(first.patches.find((patch) => patch.type === "message")).toBeUndefined();
    expect(firstUsage?.eventKey).toBe(secondUsage?.eventKey);
    expect(firstUsage).toMatchObject({ usage: { messageExternalId: null } });
    expect(secondUsage).toMatchObject({
      usage: { totalTokens: 25, messageExternalId: "assistant-1" },
    });
  });

  it("uses WorkBuddy sessionId and strips system reminder context from user text", () => {
    const state = createAdapterState("wb-session.jsonl", "wb-session");
    const meta = parseAdapterLine(
      "workbuddy-project",
      JSON.stringify({
        type: "session-meta",
        id: "event-id-not-session-id",
        sessionId: "wb-session",
        timestamp: 1_700_000_000_000,
        meta: { "codebuddy.ai/hostKind": "unopted" },
      }),
      state,
    );
    expect(meta.patches[0]).toMatchObject({
      type: "session",
      session: { externalId: "wb-session" },
    });

    const message = parseAdapterLine(
      "workbuddy-project",
      JSON.stringify({
        type: "message",
        id: "user-1",
        sessionId: "wb-session",
        role: "user",
        content:
          "<system-reminder>private injected context</system-reminder>\n<user_query>show my usage</user_query>",
      }),
      meta.state,
    );
    expect(message.patches.find((patch) => patch.type === "message")).toMatchObject({
      message: { content: "show my usage" },
    });
  });

  it("uses one event key for repeated Claude streaming snapshots", () => {
    const makeLine = (outputTokens: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "claude-session",
        uuid: `row-${outputTokens}`,
        timestamp: "2026-11-20T01:02:03Z",
        message: {
          id: "message-1",
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "private chain", text: "private chain" },
            { type: "tool_use", name: "read", input: { secret: true } },
            { type: "text", text: "hello" },
          ],
          usage: {
            input_tokens: 7,
            output_tokens: outputTokens,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      });
    const state = createAdapterState("claude-session.jsonl", "claude-session");
    const first = parseAdapterLine("claude-project", makeLine(1), state);
    const second = parseAdapterLine("claude-project", makeLine(3), first.state);
    expect(first.patches.find((patch) => patch.type === "message")?.eventKey).toBe(
      second.patches.find((patch) => patch.type === "message")?.eventKey,
    );
    expect(first.patches.find((patch) => patch.type === "usage")?.eventKey).toBe(
      second.patches.find((patch) => patch.type === "usage")?.eventKey,
    );
    expect(second.patches.find((patch) => patch.type === "message")).toMatchObject({
      message: { content: "hello" },
    });
    expect(second.patches.find((patch) => patch.type === "usage")).toMatchObject({
      usage: { totalTokens: 13, provenance: "derived" },
    });
  });

  it("emits Claude cost-state as an authoritative session-total replacement", () => {
    const result = parseAdapterLine(
      "claude-project",
      JSON.stringify({
        type: "cost-state",
        sessionId: "claude-session",
        startTime: "2026-11-20T00:00:00Z",
        totalCostUSD: 1.25,
        modelUsage: {
          "claude-a": {
            inputTokens: 10,
            outputTokens: 3,
            thinkingTokens: 1,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 2,
          },
          "claude-b": {
            inputTokens: 20,
            outputTokens: 5,
            thinkingTokens: 2,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 1,
          },
        },
      }),
      createAdapterState("claude-session.jsonl", "claude-session"),
    );
    expect(result.patches).toEqual([
      expect.objectContaining({
        eventKey: "claude-code:usage:claude-session:session-total",
        usage: expect.objectContaining({
          inputTokens: 43,
          outputTokens: 8,
          reasoningTokens: 3,
          cacheReadTokens: 10,
          cacheWriteTokens: 3,
          totalTokens: 51,
          messageExternalId: null,
          metadata: expect.objectContaining({
            aggregate: "session",
            replaceSessionUsage: true,
            models: ["claude-a", "claude-b"],
          }),
        }),
      }),
    ]);
  });
});

describe("zstd frame scanner", () => {
  it("returns complete concatenated frames and retains the torn frame start", () => {
    const first = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'));
    const second = zstdCompressSync(
      Buffer.from(
        '{"type":"user/message","seq":1,"data":{"id":"m1","role":"user","content":[{"type":"text","text":"hi"}]}}\n',
      ),
    );
    const splitAt = first.length + Math.floor(second.length / 2);
    const prefix = Buffer.concat([first, second]).subarray(0, splitAt);
    const suffix = Buffer.concat([first, second]).subarray(splitAt);

    const partial = scanZstdFrames(prefix);
    expect(partial.frames).toHaveLength(1);
    expect(partial.frames[0].bytes.equals(first)).toBe(true);
    expect(partial.tornStart.length).toBeGreaterThan(4);

    const completed = scanZstdFrames(Buffer.concat([partial.tornStart, suffix]));
    expect(completed.frames).toHaveLength(1);
    expect(completed.frames[0].bytes.equals(second)).toBe(true);
    expect(completed.tornStart.length).toBe(0);
  });

  it("preserves a partial leading magic number", () => {
    const scanned = scanZstdFrames(Buffer.from([0x28, 0xb5]));
    expect(scanned.frames).toEqual([]);
    expect([...scanned.tornStart]).toEqual([0x28, 0xb5]);
  });

  it("rejects junk before a frame instead of silently resynchronizing", () => {
    const frame = zstdCompressSync(Buffer.from("{}\n"));
    expect(() => scanZstdFrames(Buffer.concat([Buffer.from([0x00]), frame]))).toThrow(
      /expected frame magic/,
    );
  });

  it("decompresses every DeepSeek frame and emits session, message and usage patches", () => {
    const records = [
      {
        type: "session",
        id: "deep-session",
        cwd: "D:\\repo",
        createdAt: "2026-11-20T00:00:00Z",
        version: 4,
      },
      {
        type: "assistant/message",
        seq: 2,
        time: "2026-11-20T00:00:01Z",
        data: {
          message: {
            id: "deep-message",
            role: "assistant",
            source: { model: "deepseek-test" },
            content: [
              { type: "reasoning", text: "private reasoning" },
              { type: "text", text: "answer" },
            ],
          },
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            cacheReadTokens: 3,
            totalTokens: 16,
          },
        },
      },
      {
        type: "session/title",
        seq: 3,
        time: "2026-11-20T00:00:02Z",
        data: { title: "Deep task" },
      },
    ];
    const stream = Buffer.concat(
      records.map((record) => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`))),
    );
    const result = consumeDeepSeekZstdChunk(
      stream,
      createAdapterState("session-deep-session/session.v4.jsonl.zstd", "deep-session"),
    );
    expect(result.state.zstdTornStart.length).toBe(0);
    expect(result.patches.filter((patch) => patch.type === "message")).toHaveLength(1);
    expect(result.patches.filter((patch) => patch.type === "usage")).toHaveLength(1);
    expect(result.patches.find((patch) => patch.type === "usage")).toMatchObject({
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 3,
        totalTokens: 16,
        provenance: "reported",
        model: "deepseek-test",
      },
    });
    expect(result.patches.find((patch) => patch.type === "message")).toMatchObject({
      message: { content: "answer" },
    });
    expect(
      result.patches.find(
        (patch) => patch.type === "session" && patch.session.title === "Deep task",
      ),
    ).toBeDefined();
  });
});
