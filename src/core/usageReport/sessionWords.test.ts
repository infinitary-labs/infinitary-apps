import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { SessionWords } from "./sessionWords";

/**
 * INF-6587's approved plan, piece 3: with the content switch on, the
 * person's reporting connection carries each turn's prompts, outputs and
 * tool arguments from Infinitary's own session records, for every provider
 * alike. The records are session files as Pi and the Claude client write
 * them.
 */

type Line = Record<string, unknown>;

const at = (seconds: number) => Date.now() + seconds * 1000;
const iso = (time: number) => new Date(time).toISOString();
const jsonl = (lines: Line[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

function piMessage(time: number, id: string, message: Line): Line {
  return { type: "message", id, timestamp: iso(time), message };
}

function piSession(lines: Line[]): string {
  const path = join(scratchDir("infinitary-session-words-"), "2026-11-20_pi.jsonl");
  writeFileSync(path, jsonl([{ type: "session", id: "pi-1", timestamp: iso(at(-60)) }, ...lines]));
  return path;
}

const SESSION = "6a1d3b5f-2222-4333-8444-a55566667777";

function claude(line: Line): Line {
  return {
    sessionId: SESSION,
    isSidechain: false,
    userType: "external",
    version: "2.1.234",
    ...line,
  };
}

describe("SessionWords", () => {
  it("reads a Pi turn's prompt, replies and tool calls, never its thinking or a tool's result", () => {
    const start = at(-30);
    const path = piSession([
      piMessage(start - 5000, "old", {
        role: "user",
        content: [{ type: "text", text: "Earlier turn" }],
      }),
      piMessage(start + 1000, "u1", {
        role: "user",
        content: [{ type: "text", text: "Rename the meter's idle state" }],
      }),
      piMessage(start + 2000, "a1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The state lives in meter.ts." },
          { type: "text", text: "Reading the meter first." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/meter.ts" } },
        ],
        stopReason: "toolUse",
      }),
      piMessage(start + 3000, "r1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "export const IDLE = 'idle';" }],
        isError: false,
      }),
      piMessage(start + 4000, "a2", {
        role: "assistant",
        content: [{ type: "text", text: "Renamed it to resting." }],
        stopReason: "stop",
      }),
    ]);
    const words = new SessionWords(() => [path]).between("task-1", start, start + 5000);

    expect(words).toEqual({
      claude: false,
      messages: [
        {
          role: "user",
          at: start + 1000,
          parts: [{ type: "text", content: "Rename the meter's idle state" }],
        },
        {
          role: "assistant",
          at: start + 2000,
          parts: [
            { type: "text", content: "Reading the meter first." },
            { type: "tool_call", id: "call-1", name: "read", arguments: { path: "src/meter.ts" } },
          ],
          finishReason: "tool_call",
        },
        {
          role: "assistant",
          at: start + 4000,
          parts: [{ type: "text", content: "Renamed it to resting." }],
          finishReason: "stop",
        },
      ],
    });
  });

  it("hides a key in a prompt or a call's arguments before it leaves", () => {
    const start = at(-30);
    const key = "sk-ant-api03-invented-example-key";
    const token = "ghp_inventedExampleToken123";
    const path = piSession([
      piMessage(start + 1000, "u1", {
        role: "user",
        content: [{ type: "text", text: `Use ${key} for the staging check` }],
      }),
      piMessage(start + 2000, "a1", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: `echo ${token} | gh auth login --with-token` },
          },
        ],
        stopReason: "toolUse",
      }),
    ]);
    const words = new SessionWords(() => [path]).between("task-1", start, start + 5000);

    expect(JSON.stringify(words)).not.toContain(key);
    expect(JSON.stringify(words)).not.toContain(token);
    expect(words?.messages.map((message) => message.parts[0])).toEqual([
      { type: "text", content: "Use [redacted api key] for the staging check" },
      {
        type: "tool_call",
        id: "call-1",
        name: "bash",
        arguments: { command: "echo [redacted token] | gh auth login --with-token" },
      },
    ]);
  });

  it("reads a Claude-served turn the same way, without the client's own notices", () => {
    const start = at(-30);
    const store = new SessionRecordStore(scratchDir("infinitary-session-words-claude-"));
    const path = store.transcriptPath(SESSION);
    writeFileSync(
      path,
      jsonl([
        claude({
          type: "user",
          uuid: "u1",
          timestamp: iso(start + 1000),
          message: { role: "user", content: [{ type: "text", text: "start the fix" }] },
        }),
        claude({
          type: "attachment",
          uuid: "n1",
          timestamp: iso(start + 1500),
          attachment: {
            type: "queued_command",
            prompt: "<task-notification>build done</task-notification>",
            source_uuid: "src-n1",
            commandMode: "task-notification",
          },
        }),
        claude({
          type: "attachment",
          uuid: "s1",
          timestamp: iso(start + 1600),
          attachment: {
            type: "queued_command",
            prompt: "and keep it small",
            source_uuid: "src-s1",
          },
        }),
        claude({
          type: "assistant",
          uuid: "x1",
          timestamp: iso(start + 2000),
          message: {
            id: "msg_1",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__infinitary__emit_card",
                input: { title: "The fix is ready" },
              },
            ],
            stop_reason: "tool_use",
          },
        }),
        claude({
          type: "user",
          uuid: "i1",
          timestamp: iso(start + 3000),
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user]" }],
          },
        }),
      ]),
    );
    const words = new SessionWords(() => [path]).between("firstmate", start, start + 5000);

    expect(words?.claude).toBe(true);
    expect(words?.messages.map((message) => [message.role, message.parts])).toEqual([
      ["user", [{ type: "text", content: "start the fix" }]],
      ["user", [{ type: "text", content: "and keep it small" }]],
      [
        "assistant",
        [
          {
            type: "tool_call",
            id: "toolu_1",
            name: "emit_card",
            arguments: { title: "The fix is ready" },
          },
        ],
      ],
    ]);
  });

  it("reads each turn once, from the lines the session wrote after the last one", () => {
    const start = at(-30);
    const path = piSession([
      piMessage(start + 1000, "u1", {
        role: "user",
        content: [{ type: "text", text: "First ask" }],
      }),
      piMessage(start + 2000, "a1", {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      }),
    ]);
    const words = new SessionWords(() => [path]);
    const texts = (from: number, until: number) =>
      words
        .between("task-1", from, until)
        ?.messages.flatMap((message) =>
          message.parts.map((part) => (part.type === "text" ? part.content : "")),
        );

    expect(texts(start, start + 3000)).toEqual(["First ask", "First answer"]);
    appendFileSync(
      path,
      jsonl([
        piMessage(start + 4000, "u2", {
          role: "user",
          content: [{ type: "text", text: "Second ask" }],
        }),
        piMessage(start + 5000, "a2", {
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        }),
      ]),
    );
    expect(texts(start + 3000, start + 6000)).toEqual(["Second ask", "Second answer"]);
    expect(texts(start + 6000, start + 9000)).toBeUndefined();
  });
});
