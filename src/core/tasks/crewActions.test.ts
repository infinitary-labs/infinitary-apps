import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { TaskRecord } from "../storage/taskRecords";
import { ACTION_TEXT_MAX, CrewActions } from "./crewActions";

type Line = Record<string, unknown>;

const SESSION = "5a1d2c3e-0f00-4bcd-8e11-2a6f0c9d7b10";
const WORKTREE = "/work/fix-journey";
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function jsonl(lines: Line[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A Claude client's line for one call, as it writes each content block. */
function claudeCall(seconds: number, name: string, input: Line): Line {
  return {
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    uuid: `a${seconds}`,
    timestamp: iso(seconds),
    message: {
      id: `m${seconds}`,
      role: "assistant",
      content: [{ type: "tool_use", id: `t${seconds}`, name, input }],
    },
  };
}

/** A Claude client's line for the words it wrote, as it writes a text block. */
function claudeText(seconds: number, text: string): Line {
  return {
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    uuid: `w${seconds}`,
    timestamp: iso(seconds),
    message: { id: `m${seconds}`, role: "assistant", content: [{ type: "text", text }] },
  };
}

const CLAUDE_HEAD: Line = {
  type: "queue-operation",
  operation: "enqueue",
  sessionId: SESSION,
  timestamp: iso(0),
};

function piCall(seconds: number, name: string, args: Line): Line {
  return {
    type: "message",
    timestamp: iso(seconds),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: `c${seconds}`, name, arguments: args }],
    },
  };
}

function task(id: string): TaskRecord {
  return { id, worktreeDir: WORKTREE } as TaskRecord;
}

function setup(current?: (task: TaskRecord) => string | null) {
  const root = scratchDir("infinitary-crew-actions-");
  const dirOf = (taskId: string) => join(root, taskId, "sessions");
  const reader = new CrewActions({
    recordDirOf: dirOf,
    ...(current ? { currentSession: current } : {}),
    appTools: new Set(["report", "note_progress", "emit_card"]),
  });
  const write = (taskId: string, name: string, text: string) => {
    mkdirSync(dirOf(taskId), { recursive: true });
    const path = join(dirOf(taskId), name);
    writeFileSync(path, text);
    return path;
  };
  return { root, reader, write };
}

describe("a crewmate's actions, read from its kept session", () => {
  it("reads each call but the app's own in the line the crewmate wrote, or a plain reading of it", () => {
    const { reader, write } = setup();
    write(
      "t1",
      `${SESSION}.jsonl`,
      jsonl([
        CLAUDE_HEAD,
        claudeCall(1, "Bash", {
          command: "gh run view 3757 --log-failed",
          description: "Read the failing journey's log",
        }),
        claudeCall(2, "Read", { file_path: `${WORKTREE}/tests/e2e/knowledge.spec.ts` }),
        claudeCall(3, "mcp__infinitary__note_progress", { text: "The panel opens too early." }),
        claudeCall(4, "Grep", { pattern: "openKnowledge", path: `${WORKTREE}/src` }),
        claudeCall(5, "Edit", {
          file_path: `${WORKTREE}/tests/e2e/knowledge.spec.ts`,
          old_string: "a",
          new_string: "b",
        }),
        claudeCall(6, "Bash", { command: "pnpm test\nsecond line" }),
        claudeCall(7, "mcp__infinitary__report", { text: "Done." }),
        claudeCall(8, "ToolSearch", { query: "select:Monitor" }),
      ]),
    );
    expect(reader.of(task("t1"))).toEqual([
      { at: T0 + 1000, text: "Read the failing journey's log" },
      { at: T0 + 2000, text: "Read tests/e2e/knowledge.spec.ts" },
      { at: T0 + 4000, text: 'Searched for "openKnowledge" in src' },
      { at: T0 + 5000, text: "Edited tests/e2e/knowledge.spec.ts" },
      { at: T0 + 6000, text: "Ran pnpm test" },
      { at: T0 + 8000, text: "Used ToolSearch" },
    ]);
  });

  it("leaves out a shell call that runs the app's own task command, so what it typed into a page never shows", () => {
    const { reader, write } = setup();
    write(
      "t3",
      "2026-10-07T11-00-00-000Z_pi.jsonl",
      jsonl([
        { type: "session", version: 3, id: "pi-3", timestamp: iso(0), cwd: WORKTREE },
        piCall(1, "bash", { command: "infinitary-browser-axi open http://127.0.0.1:5173/" }),
        piCall(2, "bash", {
          command: "infinitary-browser-axi fill @g1:e2 'Sam Lee'",
          description: "Type the passenger's name",
        }),
        piCall(3, "bash", { command: "pnpm dev --port 5173" }),
      ]),
    );
    write(
      "t3",
      `${SESSION}.jsonl`,
      jsonl([
        CLAUDE_HEAD,
        claudeCall(4, "Bash", {
          command: "infinitary-browser-axi click @g1:e3",
          description: "Click Send",
        }),
        claudeCall(5, "Bash", { command: "echo infinitary-browser-axi" }),
      ]),
    );
    expect(reader.of(task("t3")).map((action) => action.text)).toEqual([
      "Ran pnpm dev --port 5173",
      "Ran echo infinitary-browser-axi",
    ]);
  });

  it("reads a Pi crewmate's session the same way, redacting a secret and clipping a long line", () => {
    const { reader, write } = setup();
    write(
      "t2",
      "2026-10-07T10-00-00-000Z_pi.jsonl",
      jsonl([
        { type: "session", version: 3, id: "pi-1", timestamp: iso(0), cwd: WORKTREE },
        piCall(1, "bash", { command: "pnpm test", description: "Run the unit tests" }),
        piCall(2, "bash", {
          command: "curl -H 'Authorization: Bearer abcdef1234567890' https://example.test",
        }),
        piCall(3, "ls", { path: WORKTREE }),
        piCall(4, "emit_card", { title: "Done" }),
        piCall(5, "bash", { command: "x".repeat(400) }),
      ]),
    );
    const read = reader.of(task("t2"));
    expect(read.map((action) => action.text).slice(0, 3)).toEqual([
      "Run the unit tests",
      expect.not.stringContaining("abcdef1234567890"),
      "Listed the working copy",
    ]);
    expect(read).toHaveLength(4);
    expect(read[3]?.text).toHaveLength(ACTION_TEXT_MAX);
    expect(read[3]?.text.endsWith("…")).toBe(true);
  });

  it("follows a growing session: a call shows once its line is whole, and a shorter file is read again", () => {
    const { reader, write } = setup();
    const path = write(
      "t3",
      `${SESSION}.jsonl`,
      jsonl([CLAUDE_HEAD, claudeCall(1, "Bash", { command: "ls", description: "List the files" })]),
    );
    expect(reader.of(task("t3")).map((action) => action.text)).toEqual(["List the files"]);

    const next = JSON.stringify(
      claudeCall(2, "Bash", { command: "pnpm build", description: "Build the app" }),
    );
    appendFileSync(path, next.slice(0, 40));
    expect(reader.of(task("t3")).map((action) => action.text)).toEqual(["List the files"]);
    appendFileSync(path, `${next.slice(40)}\n`);
    expect(reader.of(task("t3")).map((action) => action.text)).toEqual([
      "List the files",
      "Build the app",
    ]);
    // Read again from the start when the file is shorter than what was read.
    writeFileSync(
      path,
      jsonl([CLAUDE_HEAD, claudeCall(3, "Bash", { command: "ls", description: "Look again" })]),
    );
    expect(reader.of(task("t3")).map((action) => action.text)).toEqual(["Look again"]);
  });

  it("reads the session the crewmate runs now where it is further along than the copy", () => {
    const client = join(scratchDir("infinitary-crew-actions-client-"), `${SESSION}.jsonl`);
    const { reader, write } = setup(() => client);
    const lines = [
      CLAUDE_HEAD,
      claudeCall(1, "Bash", { command: "ls", description: "List the files" }),
      claudeCall(2, "Bash", { command: "pnpm build", description: "Build the app" }),
    ];
    write("t4", `${SESSION}.jsonl`, jsonl(lines.slice(0, 2)));
    writeFileSync(client, jsonl(lines));
    expect(reader.of(task("t4")).map((action) => action.text)).toEqual([
      "List the files",
      "Build the app",
    ]);
    // A task with no kept session has done nothing to read.
    expect(setup().reader.of(task("t5"))).toEqual([]);
  });

  // INF-557: the Now line reads the last sentence the crewmate wrote between its notes.
  it("reads the last sentence the crewmate wrote, past its thinking and a list's mark, never a sidechain's", () => {
    const { reader, write } = setup();
    expect(reader.said(task("t6"))).toBeNull();
    write(
      "t6",
      `${SESSION}.jsonl`,
      jsonl([
        CLAUDE_HEAD,
        claudeText(1, "Push access confirmed; now finding the e2e helper that seeds a session."),
        claudeCall(2, "Read", { file_path: `${WORKTREE}/tests/e2e/crew.ts` }),
        claudeText(
          3,
          "The cause is the timer.\n\n- Wait on the saved row instead. Then rerun the journey.",
        ),
        {
          ...claudeText(4, "A helper's own words."),
          isSidechain: true,
        },
        {
          ...claudeText(5, ""),
          message: {
            id: "m5",
            role: "assistant",
            content: [{ type: "thinking", thinking: "Should I check the lint too?" }],
          },
        },
      ]),
    );
    expect(reader.said(task("t6"))).toEqual({ at: T0 + 3000, text: "Then rerun the journey." });
    write(
      "t6",
      "2026-10-07T12-00-00-000Z_pi.jsonl",
      jsonl([
        { type: "session", version: 3, id: "pi-6", timestamp: iso(0), cwd: WORKTREE },
        {
          type: "message",
          timestamp: iso(9),
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Building the NOW change from the plan." },
              { type: "toolCall", id: "c9", name: "bash", arguments: { command: "pnpm build" } },
            ],
          },
        },
      ]),
    );
    expect(reader.said(task("t6"))).toEqual({
      at: T0 + 9000,
      text: "Building the NOW change from the plan.",
    });
  });
});
