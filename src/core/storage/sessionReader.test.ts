import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  readSession,
  sessionDialect,
  sessionDialectAt,
  sessionFilesIn,
  sessionToolCalls,
  sidecarPathOf,
} from "./sessionReader";
import { SessionRecordStore } from "./sessionRecordStore";

type Line = Record<string, unknown>;

const SESSION = "5f0c2a4e-1111-4222-8333-944455556666";

/** One line as the Claude client writes it: every line names its session. */
function claude(line: Line): Line {
  return {
    sessionId: SESSION,
    isSidechain: false,
    userType: "external",
    cwd: "/app/firstmate/home",
    version: "2.1.234",
    ...line,
  };
}

function jsonl(lines: Line[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A Claude seat session in the app's store: the copy and its served sidecar. */
function claudeSession(lines: Line[], sidecar: Line[]): string {
  const store = new SessionRecordStore(scratchDir("infinitary-session-reader-"));
  const path = store.transcriptPath(SESSION);
  writeFileSync(path, jsonl(lines));
  writeFileSync(store.sidecarPath(SESSION), jsonl(sidecar));
  return path;
}

const contract = (at: number, version: string) => ({
  kind: "contract",
  at,
  version,
  prompt_sha: `prompt-${version}`,
  instructions_sha: `instructions-${version}`,
  tools_sha: `tools-${version}`,
});

/** The Pi-dialect messages a read session holds, by role and what matters to its readers. */
function messages(path: string): unknown[] {
  return readSession(path).entries.flatMap((entry): unknown[] => {
    if (entry.type === "custom") return [{ contract: (entry.data as Line).version }];
    if (entry.type !== "message") return [];
    const message = entry.message as Line;
    return [{ role: message.role, ...message }];
  });
}

describe("the one session reader (W1 S11)", () => {
  it("tells the dialect from the file's own first line", () => {
    expect(sessionDialect('{"type":"session","version":3,"id":"s1"}')).toBe("pi");
    expect(
      sessionDialect(JSON.stringify(claude({ type: "queue-operation", operation: "enqueue" }))),
    ).toBe("claude");
    // A served sidecar, a torn line, or nothing is not a session's first line.
    expect(sessionDialect(JSON.stringify(contract(1, "4.13")))).toBeNull();
    expect(sessionDialect('{"type":"sess')).toBeNull();
    expect(sessionDialect("")).toBeNull();
  });

  it("reads a Pi session exactly as it was written", () => {
    const dir = scratchDir("infinitary-session-reader-");
    // Even filed where Claude's sessions live: the path decides nothing.
    const path = join(dir, "claude-looking.jsonl");
    const raw = `${JSON.stringify({ type: "session", id: "pi-1", timestamp: "2026-09-26T10:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } })}\n{"torn`;
    writeFileSync(path, raw);
    const read = readSession(path);
    expect(read).toMatchObject({ dialect: "pi", sessionId: "pi-1", text: raw });
    expect(read.entries.map((entry) => entry.type)).toEqual(["session", "message"]);
  });

  it("maps a Claude-served session into the Pi dialect's turns, tools and results", () => {
    const path = claudeSession(
      [
        claude({ type: "queue-operation", operation: "enqueue", content: "how is the crew?" }),
        claude({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-09-26T10:00:00.000Z",
          message: { role: "user", content: "how is the crew?" },
        }),
        claude({
          type: "attachment",
          uuid: "a1",
          parentUuid: "u1",
          attachment: { type: "total_tokens_reminder", text: "<total_tokens>9</total_tokens>" },
        }),
        // One assistant message, written as one line per content block.
        claude({
          type: "assistant",
          uuid: "x1",
          parentUuid: "a1",
          timestamp: "2026-09-26T10:00:01.000Z",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "Looking." }],
          },
        }),
        claude({
          type: "assistant",
          uuid: "x2",
          parentUuid: "x1",
          timestamp: "2026-09-26T10:00:01.000Z",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [
              { type: "tool_use", id: "toolu_1", name: "mcp__infinitary__crew_status", input: {} },
            ],
            stop_reason: "tool_use",
          },
        }),
        claude({
          type: "user",
          uuid: "r1",
          parentUuid: "x2",
          timestamp: "2026-09-26T10:00:02.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "No crew right now." }],
              },
            ],
          },
        }),
        // The client's own injected line and a side conversation are not the session's.
        claude({
          type: "user",
          uuid: "meta",
          isMeta: true,
          message: { role: "user", content: "<local-command>" },
        }),
        claude({
          type: "user",
          uuid: "side",
          isSidechain: true,
          message: { role: "user", content: "a subagent's brief" },
        }),
        claude({
          type: "assistant",
          uuid: "x3",
          parentUuid: "r1",
          timestamp: "2026-09-26T10:00:03.000Z",
          message: {
            id: "msg_2",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "The crew is idle." }],
            stop_reason: "end_turn",
          },
        }),
        claude({ type: "last-prompt", lastPrompt: "how is the crew?", leafUuid: "x3" }),
      ],
      [contract(0, "4.13")],
    );
    const read = readSession(path);
    expect(read).toMatchObject({ dialect: "claude", sessionId: SESSION });
    expect(read.entries[0]).toEqual({
      type: "session",
      id: SESSION,
      timestamp: "2026-09-26T10:00:00.000Z",
    });
    expect(messages(path)).toEqual([
      { contract: "4.13" },
      { role: "user", content: "how is the crew?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "toolCall", id: "toolu_1", name: "crew_status", arguments: {} },
        ],
        provider: CLAUDE_PROVIDER_ID,
        model: "claude-opus-5-5",
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "crew_status",
        content: [{ type: "text", text: "No crew right now." }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The crew is idle." }],
        provider: CLAUDE_PROVIDER_ID,
        model: "claude-opus-5-5",
        stopReason: "stop",
      },
    ]);
  });

  // The Infinitary rename (step 8 of FI3-1780's plan): a conversation
  // recorded before it names the app's tools under its old server.
  it("reads the app's tools by their own names under the server's name before the rename too", () => {
    const call = (name: string) =>
      claudeSession(
        [
          claude({
            type: "assistant",
            uuid: "x1",
            parentUuid: null,
            timestamp: "2026-09-26T10:00:01.000Z",
            message: {
              id: "msg_1",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "tool_use", id: "toolu_1", name, input: {} }],
              stop_reason: "tool_use",
            },
          }),
        ],
        [],
      );
    const named = (path: string) =>
      JSON.stringify(readSession(path).entries).match(/"name":"([^"]+)"/)?.[1];
    expect(named(call("mcp__firstmate__crew_status"))).toBe("crew_status");
    expect(named(call("mcp__infinitary__crew_status"))).toBe("crew_status");
    expect(named(call("Bash"))).toBe("Bash");
  });

  it("keeps per-message usage once across blocks, taking later counters without inventing missing ones", () => {
    let blockId = 0;
    const block = (id: string, usage?: Line) =>
      claude({
        type: "assistant",
        uuid: `${id}-${++blockId}`,
        message: {
          id,
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "A reply block." }],
          ...(usage ? { usage } : {}),
        },
      });
    const path = claudeSession(
      [
        block("one", {
          input_tokens: 3,
          output_tokens: 0,
          cache_read_input_tokens: 700,
          cache_creation_input_tokens: 200,
        }),
        block("one", {
          input_tokens: 3,
          output_tokens: 11,
          cache_read_input_tokens: 700,
          cache_creation_input_tokens: 200,
        }),
        block("one", { output_tokens: 17 }),
        block("one"),
        block("two", { input_tokens: 0, output_tokens: 9 }),
        block("missing"),
        block("invalid", {
          input_tokens: -1,
          output_tokens: "unknown",
          cache_read_input_tokens: null,
        }),
      ],
      [],
    );
    const read = messages(path) as Line[];
    expect(read).toHaveLength(4);
    expect(read.map((message) => message.usage)).toEqual([
      { input: 3, output: 17, cacheRead: 700, cacheWrite: 200 },
      { input: 0, output: 9 },
      undefined,
      undefined,
    ]);
    expect(read[0]?.content as unknown[]).toHaveLength(4);
  });

  it("reads a folded steer as a user message, and a provider failure as a failed reply", () => {
    const path = claudeSession(
      [
        claude({
          type: "user",
          uuid: "u1",
          timestamp: "2026-09-26T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "start the fix" }] },
        }),
        claude({
          type: "attachment",
          uuid: "s1",
          timestamp: "2026-09-26T10:00:01.000Z",
          attachment: {
            type: "queued_command",
            prompt: "and keep it small",
            source_uuid: "steer-1",
          },
        }),
        claude({
          type: "assistant",
          uuid: "e1",
          isApiErrorMessage: true,
          error: "rate_limit",
          timestamp: "2026-09-26T10:00:02.000Z",
          message: {
            id: "err_1",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: 429 rate limited" }],
          },
        }),
      ],
      [contract(0, "4.13")],
    );
    expect(messages(path)).toEqual([
      { contract: "4.13" },
      { role: "user", content: [{ type: "text", text: "start the fix" }] },
      { role: "user", content: "and keep it small" },
      {
        role: "assistant",
        content: [{ type: "text", text: "API Error: 429 rate limited" }],
        stopReason: "error",
        errorMessage: "API Error: 429 rate limited",
      },
    ]);
  });

  it("keeps the client's own notice apart from a served steer by the mode the client gave it", () => {
    const queued = (uuid: string, prompt: string, commandMode: string) =>
      claude({
        type: "attachment",
        uuid,
        timestamp: "2026-09-26T10:00:01.000Z",
        attachment: { type: "queued_command", prompt, source_uuid: `src-${uuid}`, commandMode },
      });
    const path = claudeSession(
      [
        claude({
          type: "user",
          uuid: "u1",
          timestamp: "2026-09-26T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "start the fix" }] },
        }),
        queued("n1", "<task-notification>build done</task-notification>", "task-notification"),
        queued("s1", "and keep it small", "prompt"),
      ],
      [contract(0, "4.13")],
    );
    expect(messages(path)).toEqual([
      { contract: "4.13" },
      { role: "user", content: [{ type: "text", text: "start the fix" }] },
      {
        role: "user",
        content: "<task-notification>build done</task-notification>",
        commandMode: "task-notification",
      },
      { role: "user", content: "and keep it small" },
    ]);
  });

  it("gives each turn the contract its served stamp names, whenever the client wrote the turn", () => {
    const at = (second: number) => `2026-09-26T10:00:0${second}.000Z`;
    const path = claudeSession(
      [
        claude({ type: "user", uuid: "p1", timestamp: at(1), message: { content: "one" } }),
        claude({ type: "user", uuid: "p2", timestamp: at(2), message: { content: "two" } }),
        claude({
          type: "attachment",
          uuid: "s2",
          timestamp: at(3),
          attachment: { type: "queued_command", prompt: "and three", source_uuid: "steer-2" },
        }),
        // No served stamp names this prompt: the contract stamped last before it.
        claude({ type: "user", uuid: "p3", timestamp: at(4), message: { content: "four" } }),
      ],
      [
        contract(Date.parse(at(0)), "4.12"),
        { kind: "served", at: Date.parse(at(1)), prompt: { uuid: "p1" }, steers: [] },
        // New instructions: a second contract before the second prompt was
        // served, stamped on the host's clock, which reads later than the
        // client's line for that prompt - only the uuid joins them.
        contract(Date.parse(at(2)) + 500, "4.13"),
        {
          kind: "served",
          at: Date.parse(at(5)),
          prompt: { uuid: "p2" },
          steers: [{ uuid: "steer-2" }],
        },
      ],
    );
    expect(messages(path)).toEqual([
      { contract: "4.12" },
      { role: "user", content: "one" },
      { contract: "4.13" },
      { role: "user", content: "two" },
      { role: "user", content: "and three" },
      { role: "user", content: "four" },
    ]);
  });

  it("lists every session in a directory but the served sidecars beside them", () => {
    const path = claudeSession(
      [claude({ type: "user", uuid: "u1", message: { content: "hi" } })],
      [contract(0, "4.13")],
    );
    expect(sidecarPathOf(path)).toBe(path.replace(/\.jsonl$/, ".served.jsonl"));
    expect(sessionFilesIn(join(path, ".."))).toEqual([path]);
    expect(sessionFilesIn(join(path, "..", "missing"))).toEqual([]);
  });

  it("lists the calls a session's own conversation made, in either dialect", () => {
    const pi = jsonl([
      { type: "session", id: "pi-1", timestamp: "2026-09-26T10:00:00.000Z" },
      {
        type: "message",
        timestamp: "2026-09-26T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "look first" },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
            { type: "toolCall", id: "c2", name: "note_progress", arguments: { text: "Reading." } },
          ],
        },
      },
      // A tool's output quoting an assistant line is not a call.
      {
        type: "message",
        timestamp: "2026-09-26T10:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          content: [{ type: "text", text: '{"role":"assistant","content":[]}' }],
        },
      },
    ]);
    expect(sessionToolCalls(pi, "pi")).toEqual([
      { at: Date.parse("2026-09-26T10:00:01.000Z"), name: "read", arguments: { path: "src/a.ts" } },
      {
        at: Date.parse("2026-09-26T10:00:01.000Z"),
        name: "note_progress",
        arguments: { text: "Reading." },
      },
    ]);

    const claudeText = jsonl([
      claude({ type: "queue-operation", operation: "enqueue", content: "go" }),
      claude({
        type: "assistant",
        uuid: "x1",
        timestamp: "2026-09-26T10:00:03.000Z",
        message: {
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "pnpm test", description: "Run the unit tests" },
            },
          ],
        },
      }),
      claude({
        type: "assistant",
        uuid: "x2",
        timestamp: "2026-09-26T10:00:04.000Z",
        message: {
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "mcp__infinitary__report",
              input: { text: "Done." },
            },
          ],
        },
      }),
      // A helper's own calls are not the session's.
      claude({
        type: "assistant",
        isSidechain: true,
        uuid: "x3",
        timestamp: "2026-09-26T10:00:05.000Z",
        message: {
          id: "msg_2",
          content: [{ type: "tool_use", id: "t3", name: "Grep", input: {} }],
        },
      }),
    ]);
    expect(sessionToolCalls(claudeText, "claude")).toEqual([
      {
        at: Date.parse("2026-09-26T10:00:03.000Z"),
        name: "Bash",
        arguments: { command: "pnpm test", description: "Run the unit tests" },
      },
      { at: Date.parse("2026-09-26T10:00:04.000Z"), name: "report", arguments: { text: "Done." } },
    ]);
    // A torn line, the tail of a session still being written, is no call yet.
    const torn = claudeText.split("\n").slice(0, 3).join("\n").slice(0, -20);
    expect(sessionToolCalls(torn, "claude").map((call) => call.name)).toEqual(["Bash"]);
  });

  it("reads a file's dialect off its first line alone, however long that line is", () => {
    const dir = scratchDir("infinitary-session-reader-");
    const long = join(dir, "long.jsonl");
    writeFileSync(
      long,
      jsonl([
        claude({ type: "queue-operation", operation: "enqueue", content: "x".repeat(200_000) }),
        { type: "session" },
      ]),
    );
    expect(sessionDialectAt(long)).toBe("claude");
    const pi = join(dir, "pi.jsonl");
    writeFileSync(pi, `\n${JSON.stringify({ type: "session", id: "p" })}`);
    expect(sessionDialectAt(pi)).toBe("pi");
    expect(sessionDialectAt(join(dir, "missing.jsonl"))).toBeNull();
  });
});
