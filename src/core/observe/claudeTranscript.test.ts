import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./claudeTranscript";

/**
 * Lines shaped like the vendored client writes them (measured 2026-09-05):
 * one line per content block, an assistant message split over lines that
 * share message.id and repeat the usage, tool results as user lines.
 */
const usage1 = {
  input_tokens: 12,
  output_tokens: 40,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 5,
};

function assistant(
  uuid: string,
  messageId: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  usage: Record<string, unknown> = usage1,
): unknown {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    uuid,
    timestamp: "2026-09-05T10:00:01.000Z",
    sessionId: "sess-1",
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-opus-4-1",
      content,
      stop_reason: extra.stop_reason ?? null,
      usage,
    },
    ...extra,
  };
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("parseClaudeTranscript", () => {
  it("reads Claude's split assistant lines into one assistant/tool/usage sequence", () => {
    const parsed = parseClaudeTranscript(
      jsonl([
        { type: "queue-operation", operation: "enqueue", sessionId: "sess-1" },
        {
          type: "user",
          isSidechain: false,
          uuid: "u1",
          sessionId: "sess-1",
          timestamp: "2026-09-05T10:00:00.000Z",
          message: { role: "user", content: "You are a crewmate.\n\n# Task\nfix the flaky test" },
        },
        assistant("a1", "msg_1", [{ type: "thinking", thinking: "hmm" }]),
        assistant("a2", "msg_1", [{ type: "text", text: "Looking at the timer." }]),
        assistant(
          "a3",
          "msg_1",
          [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } }],
          { stop_reason: "tool_use" },
        ),
        {
          type: "user",
          uuid: "u2",
          timestamp: "2026-09-05T10:00:03.000Z",
          message: {
            role: "user",
            content: [
              { tool_use_id: "toolu_1", type: "tool_result", content: "1 passed", is_error: false },
            ],
          },
          toolUseResult: { stdout: "1 passed" },
        },
        assistant("a4", "msg_2", [{ type: "text", text: "Patched the timer." }], {
          stop_reason: "end_turn",
          timestamp: "2026-09-05T10:00:05.000Z",
        }),
        { type: "file-history-snapshot", messageId: "u1", snapshot: {} },
      ]),
    );
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.model).toBe("anthropic-claude/claude-opus-4-1");
    expect(parsed.turns.map((turn) => turn.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "usage",
      "tool",
      "assistant",
      "usage",
    ]);
    expect(parsed.turns[0]?.text).toContain("fix the flaky test");
    expect(parsed.turns[1]?.text).toBe("Looking at the timer.");
    expect(parsed.turns[2]).toMatchObject({ toolName: "Bash", text: "Bash" });
    // One usage per message, not one per split line, after its last block.
    expect(parsed.turns[3]?.usage).toEqual({
      input: 12,
      output: 40,
      cacheRead: 100,
      cacheWrite: 5,
    });
    expect(parsed.turns[4]).toMatchObject({ toolName: "Bash", text: "1 passed", isError: false });
    expect(parsed.turns[5]?.text).toBe("Patched the timer.");
    expect(parsed.startedAt).toBe(Date.parse("2026-09-05T10:00:00.000Z"));
    expect(parsed.endedAt).toBe(Date.parse("2026-09-05T10:00:05.000Z"));
    expect(parsed.error).toBeNull();
    expect(parsed.authFailure).toBe(false);
  });

  it("surfaces the client's API error line and classifies it from the typed error", () => {
    const parsed = parseClaudeTranscript(
      jsonl([
        assistant("a1", "msg_1", [{ type: "text", text: "ok" }], { stop_reason: "end_turn" }),
        assistant(
          "a2",
          "msg_err",
          [
            {
              type: "text",
              text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
            },
          ],
          { isApiErrorMessage: true, error: "authentication_failed" },
          { input_tokens: 0, output_tokens: 0 },
        ),
      ]),
    );
    expect(parsed.turns.map((turn) => turn.kind)).toEqual(["assistant", "usage", "error"]);
    expect(parsed.error).toMatch(/401/);
    expect(parsed.authFailure).toBe(true);
  });

  it("never badges a firewall's 403 block page as a sign-in problem", () => {
    // The shape the client wrote when a network block page answered a
    // crewmate's request: the sign-in label, but status 403.
    const parsed = parseClaudeTranscript(
      jsonl([
        assistant(
          "a1",
          "msg_err",
          [
            {
              type: "text",
              text: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
            },
          ],
          { isApiErrorMessage: true, error: "authentication_failed", apiErrorStatus: 403 },
          { input_tokens: 0, output_tokens: 0 },
        ),
      ]),
    );
    expect(parsed.error).toMatch(/403/);
    expect(parsed.authFailure).toBe(false);
  });

  it("never reads a sign-in from an API error's words", () => {
    const apiError = (error?: string) =>
      parseClaudeTranscript(
        jsonl([
          assistant(
            "a1",
            "msg_err",
            [{ type: "text", text: "API Error: 401 Unauthorized - invalid_api_key" }],
            { isApiErrorMessage: true, ...(error ? { error } : {}) },
            { input_tokens: 0, output_tokens: 0 },
          ),
        ]),
      );
    // Words that say 401, with a typed error that is not a sign-in, or none.
    expect(apiError("server_error").authFailure).toBe(false);
    // A refusal of the sign-in badges like a sign-out, as a 403 does on Pi.
    expect(apiError("oauth_org_not_allowed").authFailure).toBe(true);
    expect(apiError().authFailure).toBe(false);
    expect(apiError().error).toMatch(/401/);
  });

  it("keeps meta, compaction, sidechain, and failed tool results in their own lanes", () => {
    const parsed = parseClaudeTranscript(
      jsonl([
        {
          type: "user",
          isMeta: true,
          uuid: "m1",
          message: {
            role: "user",
            content: "<local-command-caveat>injected</local-command-caveat>",
          },
        },
        {
          type: "user",
          isSidechain: true,
          uuid: "s1",
          message: { role: "user", content: "a subagent's own turn" },
        },
        {
          type: "user",
          isCompactSummary: true,
          uuid: "c1",
          message: { role: "user", content: "This session is being continued: summary here." },
        },
        assistant("a1", "msg_1", [
          { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "/x" } },
        ]),
        {
          type: "user",
          uuid: "u9",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "toolu_9",
                type: "tool_result",
                content: [{ type: "text", text: "ENOENT: no such file" }],
                is_error: true,
              },
            ],
          },
        },
      ]),
    );
    expect(parsed.turns.map((turn) => turn.kind)).toEqual([
      "context",
      "compaction",
      "tool",
      "usage",
      "tool",
    ]);
    expect(parsed.turns.some((turn) => turn.text.includes("subagent"))).toBe(false);
    expect(parsed.turns[4]).toMatchObject({ toolName: "Read", isError: true });
    expect(parsed.error).toMatch(/ENOENT/);
    expect(parsed.authFailure).toBe(false);
  });

  it("skips malformed and partial lines", () => {
    const parsed = parseClaudeTranscript(
      '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assis',
    );
    expect(parsed.turns.map((turn) => turn.kind)).toEqual(["user"]);
  });
});
