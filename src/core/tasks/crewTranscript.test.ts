import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CrewLine } from "@shared/crewTranscript";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderWake, replyWordsSpan, type TypedWake } from "../orchestrator/wakes";
import { EMIT_CARD_TOOL_NAME } from "../pi/cardTool";
import { NOTE_PROGRESS_TOOL_NAME, REPORT_TOOL_NAME } from "../pi/crewmateTaskTools";
import { OPEN_CHANGE_TOOL_NAME } from "../pi/forgeTools";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskStore";
import { CREW_BLOCK_TOOLS, CrewLiveText, CrewTranscripts, diffOf } from "./crewTranscript";

type Line = Record<string, unknown>;

const SESSION = "5a1d2c3e-0f00-4bcd-8e11-2a6f0c9d7b10";
const WORKTREE = "/work/theme-toggle";
const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const BRIEF = "Goal: add a Theme toggle to Settings.";
const TYPED = "Keep the toggle reachable with Tab too";

function jsonl(lines: Line[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** The lines a Claude client writes: one per content block, a result inside a user line. */
const claude = {
  prompt: (seconds: number, text: string): Line => ({
    type: "user",
    sessionId: SESSION,
    uuid: `u${seconds}`,
    timestamp: iso(seconds),
    message: { role: "user", content: text },
  }),
  block: (seconds: number, message: string, block: Line): Line => ({
    type: "assistant",
    sessionId: SESSION,
    isSidechain: false,
    uuid: `a${seconds}`,
    timestamp: iso(seconds),
    message: { id: message, role: "assistant", content: [block] },
  }),
  result: (seconds: number, toolUseId: string, content: unknown, isError = false): Line => ({
    type: "user",
    sessionId: SESSION,
    uuid: `r${seconds}`,
    timestamp: iso(seconds),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  }),
};

const steer = (id: number, seconds: number, wake: TypedWake | string, via: string): TaskEvent => {
  const words = typeof wake === "string" ? undefined : replyWordsSpan(wake);
  return {
    id,
    taskId: "t1",
    at: T0 + seconds * 1000,
    actor: via === "tool" ? "firstmate" : "captain",
    kind: "steered",
    text: renderWake(wake),
    data: { via, outcome: "mid-turn", ...(words ? { words } : {}) },
    ref: null,
    feed: false,
  };
};

const typedLine = (words: string): TypedWake => ({
  facts: { kind: "crewmate-tab-line", words },
});

function task(id = "t1"): TaskRecord {
  return { id, worktreeDir: WORKTREE } as TaskRecord;
}

function setup() {
  const root = scratchDir("infinitary-crew-transcript-");
  const dir = join(root, "t1", "sessions");
  mkdirSync(dir, { recursive: true });
  const transcripts = new CrewTranscripts({
    recordDirOf: (taskId) => join(root, taskId, "sessions"),
  });
  return { dir, transcripts };
}

const kinds = (lines: readonly CrewLine[]) => lines.map((line) => line.kind);
const ofKind = <K extends CrewLine["kind"]>(lines: readonly CrewLine[], kind: K) =>
  lines.filter((line): line is Extract<CrewLine, { kind: K }> => line.kind === kind);

describe("the Crewmate tab's transcript", () => {
  it("reads a Claude crewmate's session as its brief, words, calls with folded results, and blocks", () => {
    const { dir, transcripts } = setup();
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        claude.prompt(1, BRIEF),
        claude.block(2, "m1", { type: "thinking", thinking: "never shown" }),
        claude.block(2, "m1", { type: "text", text: "I'll read the Settings code first." }),
        claude.block(3, "m1", {
          type: "tool_use",
          id: "read1",
          name: "Read",
          input: { file_path: `${WORKTREE}/src/settings/Appearance.tsx` },
        }),
        claude.result(4, "read1", "line one\nline two\nline three"),
        claude.block(5, "m2", {
          type: "tool_use",
          id: "bash1",
          name: "Bash",
          input: { command: "pnpm test src/settings", description: "Run the Settings tests" },
        }),
        claude.result(6, "bash1", "1 failed", true),
        claude.block(7, "m3", {
          type: "tool_use",
          id: "plan1",
          name: `mcp__infinitary__${NOTE_PROGRESS_TOOL_NAME}`,
          input: {
            text: "Tests run.",
            plan: [
              { label: "Read the code", short: "Read", state: "done" },
              { label: "Add the toggle", short: "Toggle", state: "current" },
            ],
          },
        }),
        claude.block(8, "m4", {
          type: "tool_use",
          id: "card1",
          name: `mcp__infinitary__${EMIT_CARD_TOOL_NAME}`,
          input: { id: "merge-it", title: "Merge the Theme toggle?" },
        }),
        claude.block(9, "m5", {
          type: "tool_use",
          id: "pr1",
          name: `mcp__infinitary__${OPEN_CHANGE_TOOL_NAME}`,
          input: { title: "feat(settings): a Theme toggle", body: "..." },
        }),
        claude.block(10, "m6", {
          type: "tool_use",
          id: "report1",
          name: `mcp__infinitary__${REPORT_TOOL_NAME}`,
          input: { text: "Added the toggle.\n\nTests pass.", summary: "The toggle is in." },
        }),
        {
          ...claude.block(11, "side", { type: "text", text: "a helper's words" }),
          isSidechain: true,
        },
      ]),
    );
    const { lines } = transcripts.of(task(), [], false);
    expect(kinds(lines)).toEqual([
      "brief",
      "said",
      "tool",
      "tool",
      "plan",
      "card",
      "change",
      "report",
    ]);
    expect(lines[0]).toMatchObject({ kind: "brief", text: BRIEF });
    expect(lines[1]).toMatchObject({ kind: "said", text: "I'll read the Settings code first." });
    const [read, bash] = ofKind(lines, "tool");
    // A path inside the working copy reads relative to it; a call that says what it does keeps its words.
    expect(read).toMatchObject({
      name: "Read",
      target: "src/settings/Appearance.tsx",
      reading: "",
    });
    expect(read?.result).toMatchObject({ lines: 3, preview: "line one", error: false });
    expect(bash).toMatchObject({
      name: "Bash",
      target: "pnpm test src/settings",
      reading: "Run the Settings tests",
    });
    expect(bash?.result).toMatchObject({ lines: 1, error: true });
    expect(ofKind(lines, "plan")[0]?.items).toEqual([
      { label: "Read the code", state: "done" },
      { label: "Add the toggle", state: "current" },
    ]);
    expect(ofKind(lines, "card")[0]).toMatchObject({
      title: "Merge the Theme toggle?",
      cardId: "merge-it",
    });
    expect(ofKind(lines, "change")[0]?.title).toBe("feat(settings): a Theme toggle");
    expect(ofKind(lines, "report")[0]).toMatchObject({
      summary: "The toggle is in.",
      text: "Added the toggle.\n\nTests pass.",
    });
    // Thinking and a helper's sidechain never show.
    expect(JSON.stringify(lines)).not.toContain("never shown");
    expect(JSON.stringify(lines)).not.toContain("a helper's words");
    // The fold opens to the whole result, read on its own.
    expect(read?.result && transcripts.result(task(), read.result.ref)).toEqual({
      text: "line one\nline two\nline three",
      cut: 0,
    });
  });

  it("reads a Pi crewmate's session the same way", () => {
    const { dir, transcripts } = setup();
    const message = (seconds: number, body: Line, id = `e${seconds}`): Line => ({
      type: "message",
      id,
      timestamp: iso(seconds),
      message: body,
    });
    writeFileSync(
      join(dir, "2026-10-09_pi.jsonl"),
      jsonl([
        { type: "session", id: "pi-session", timestamp: iso(0) },
        message(1, { role: "user", content: [{ type: "text", text: BRIEF }] }),
        message(2, {
          role: "assistant",
          content: [
            { type: "text", text: "Reading first." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: `${WORKTREE}/a.ts` } },
          ],
        }),
        message(3, {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "export const a = 1;" }],
          isError: false,
        }),
      ]),
    );
    const { lines } = transcripts.of(task(), [], false);
    expect(kinds(lines)).toEqual(["brief", "said", "tool"]);
    expect(ofKind(lines, "tool")[0]).toMatchObject({ name: "read", target: "a.ts" });
    expect(ofKind(lines, "tool")[0]?.result?.preview).toBe("export const a = 1;");
  });

  it("tells who sent each line from the record, and keeps the captain's typed line queued until the session holds it", () => {
    const { dir, transcripts } = setup();
    const file = join(dir, `${SESSION}.jsonl`);
    const typed = steer(1, 20, typedLine(TYPED), "crewmate-tab");
    const told = steer(2, 5, "Use the existing Switch component.", "tool");
    writeFileSync(
      file,
      jsonl([
        claude.prompt(1, BRIEF),
        claude.prompt(6, told.text),
        claude.prompt(8, "The checks on your pull request passed."),
      ]),
    );
    const before = transcripts.of(task(), [told, typed], false);
    expect(
      ofKind(before.lines, "sent").map(({ from, text, queued }) => ({ from, text, queued })),
    ).toEqual([
      { from: "firstmate", text: "Use the existing Switch component.", queued: false },
      { from: "app", text: "The checks on your pull request passed.", queued: false },
      // Only the captain's own words, never the lead the crewmate is sent with them.
      { from: "captain", text: TYPED, queued: true },
    ]);
    expect(before.lines.at(-1)).toMatchObject({ via: "crewmate-tab" });

    // The crewmate takes it: the session holds it once, no longer queued.
    appendFileSync(
      file,
      jsonl([
        {
          type: "attachment",
          sessionId: SESSION,
          uuid: "q1",
          timestamp: iso(21),
          attachment: { type: "queued_command", prompt: typed.text },
        },
      ]),
    );
    const after = transcripts.of(task(), [told, typed], false);
    expect(after.revision).not.toBe(before.revision);
    const captain = ofKind(after.lines, "sent").filter((line) => line.from === "captain");
    expect(captain).toHaveLength(1);
    expect(captain[0]).toMatchObject({ text: TYPED, queued: false });
    // Nothing moved: the same transcript, so a re-read is not delivered again.
    expect(transcripts.of(task(), [told, typed], false)).toBe(after);
  });

  it("never reads a closed task's undelivered line as queued, and says where a turn was stopped", () => {
    const { dir, transcripts } = setup();
    writeFileSync(join(dir, `${SESSION}.jsonl`), jsonl([claude.prompt(1, BRIEF)]));
    const typed = steer(1, 5, typedLine(TYPED), "crewmate-tab");
    const stop: TaskEvent = {
      id: 2,
      taskId: "t1",
      at: T0 + 3_000,
      actor: "captain",
      kind: "interrupted",
      text: "interrupt requested",
      data: { mode: "interrupt", effect: "aborted-turn", via: "crewmate-tab" },
      ref: null,
      feed: false,
    };
    const { lines } = transcripts.of(task(), [stop, typed], true);
    expect(kinds(lines)).toEqual(["brief", "stopped", "sent"]);
    expect(lines[1]).toMatchObject({ kind: "stopped", by: "captain" });
    expect(lines[2]).toMatchObject({ kind: "sent", queued: false });
  });

  it("leaves out the client's own interrupt notice, and reads a line sent again as its sender's", () => {
    const { dir, transcripts } = setup();
    const typed = steer(1, 2, typedLine(TYPED), "crewmate-tab");
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        claude.prompt(1, BRIEF),
        claude.prompt(3, typed.text),
        claude.prompt(4, "[Request interrupted by user]"),
        // The turn's end took the line back and sent it as the next turn.
        claude.prompt(5, typed.text),
      ]),
    );
    const { lines } = transcripts.of(task(), [typed], false);
    expect(kinds(lines)).toEqual(["brief", "sent", "sent"]);
    expect(ofKind(lines, "sent").map(({ from, text }) => ({ from, text }))).toEqual([
      { from: "captain", text: TYPED },
      { from: "captain", text: TYPED },
    ]);
  });

  it("redacts what it shows and leaves out the crewmate's system prompt", () => {
    const { dir, transcripts } = setup();
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        claude.prompt(1, "You are a crewmate: a background worker aboard Firstmate 3000. ..."),
        claude.block(2, "m1", { type: "text", text: "The key is sk-ant-abcdefghijklmnop." }),
      ]),
    );
    const text = JSON.stringify(transcripts.of(task(), [], false).lines);
    expect(text).toContain("[system prompt redacted]");
    expect(text).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("shows a picture a call's result holds by its ref, read only when asked", () => {
    const { dir, transcripts } = setup();
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        claude.prompt(1, BRIEF),
        claude.block(2, "m1", {
          type: "tool_use",
          id: "cap1",
          name: "mcp__infinitary__browser_capture",
          input: { name: "settings-dark" },
        }),
        claude.result(3, "cap1", [
          { type: "text", text: "Saved settings-dark.png" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ]),
      ]),
    );
    const { lines } = transcripts.of(task(), [], false);
    const capture = ofKind(lines, "tool")[0];
    expect(capture).toMatchObject({ name: "browser_capture", target: "settings-dark" });
    const picture = capture?.result?.pictures[0];
    expect(picture?.mimeType).toBe("image/png");
    // The transcript names the picture; its bytes never ride it.
    expect(JSON.stringify(lines)).not.toContain("iVBORw0KGgo=");
    expect(picture && transcripts.picture(task(), picture.ref)).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(transcripts.picture(task(), "elsewhere.jsonl#x#1")).toBeNull();
  });

  it("names a task command by what it was asked to do, never by what the crewmate typed into a page", () => {
    const { dir, transcripts } = setup();
    writeFileSync(
      join(dir, `${SESSION}.jsonl`),
      jsonl([
        claude.prompt(1, BRIEF),
        claude.block(2, "m1", {
          type: "tool_use",
          id: "fill1",
          name: "Bash",
          input: { command: "infinitary-browser-axi fill @g1:e2 'Sam Lee, 12 Mar 1988'" },
        }),
        claude.result(3, "fill1", [{ type: "text", text: "page:\n  title: Passenger" }]),
        claude.block(4, "m2", {
          type: "tool_use",
          id: "ls1",
          name: "Bash",
          input: { command: "ls -la src" },
        }),
      ]),
    );
    const calls = ofKind(transcripts.of(task(), [], false).lines, "tool");
    expect(calls.map(({ name, target }) => ({ name, target }))).toEqual([
      { name: "Bash", target: "infinitary-browser-axi fill" },
      { name: "Bash", target: "ls -la src" },
    ]);
    expect(JSON.stringify(calls)).not.toContain("Sam Lee");
  });

  it("names the app's own tools it draws as blocks by the names the tools give themselves", () => {
    expect(CREW_BLOCK_TOOLS).toEqual({
      plan: NOTE_PROGRESS_TOOL_NAME,
      report: REPORT_TOOL_NAME,
      card: EMIT_CARD_TOOL_NAME,
      change: OPEN_CHANGE_TOOL_NAME,
    });
  });
});

describe("a diff drawn from an edit's own arguments", () => {
  it("keeps two lines of what it kept around what it took out and put in", () => {
    const before = ["a", "b", "c", "old", "d", "e", "f"].join("\n");
    const after = ["a", "b", "c", "new one", "new two", "d", "e", "f"].join("\n");
    expect(diffOf("Edit", { file_path: "x", old_string: before, new_string: after })).toEqual({
      added: 2,
      removed: 1,
      more: 0,
      lines: [
        { kind: "context", text: "b" },
        { kind: "context", text: "c" },
        { kind: "removed", text: "old" },
        { kind: "added", text: "new one" },
        { kind: "added", text: "new two" },
        { kind: "context", text: "d" },
        { kind: "context", text: "e" },
      ],
    });
  });

  it("reads several edits as hunks apart, a Pi edit's own words, and a new file as its lines", () => {
    const multi = diffOf("MultiEdit", {
      file_path: "x",
      edits: [
        { old_string: "one", new_string: "1" },
        { old_string: "two", new_string: "2" },
      ],
    });
    expect(multi?.lines.map((line) => line.kind)).toEqual([
      "removed",
      "added",
      "gap",
      "removed",
      "added",
    ]);
    expect(diffOf("edit", { path: "x", edits: [{ oldText: "a", newText: "b" }] })).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect(diffOf("Write", { file_path: "x", content: "line 1\nline 2\n" })).toMatchObject({
      added: 2,
      removed: 0,
    });
    expect(diffOf("Read", { file_path: "x" })).toBeUndefined();
  });

  it("bounds a long one and counts what it left out", () => {
    const content = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const diff = diffOf("Write", { file_path: "x", content });
    expect(diff?.lines).toHaveLength(80);
    expect(diff?.more).toBe(20);
    expect(diff?.added).toBe(100);
  });
});

describe("what a crewmate is writing now", () => {
  it("holds the words since its last call, and lets them go when the session has them", () => {
    const live = new CrewLiveText();
    live.apply({ type: "assistant_delta", taskId: "t1", text: "Opening the " });
    live.apply({ type: "assistant_delta", taskId: "t1", text: "pull request" });
    expect(live.read("t1", 5)).toEqual({
      taskId: "t1",
      text: "Opening the pull request",
      since: 5,
    });
    live.apply({ type: "tool_start", taskId: "t1", callId: "c1", toolName: "open_change" });
    expect(live.read("t1", 5).text).toBe("");
    live.apply({ type: "assistant_delta", taskId: "t1", text: "token sk-ant-abcdefghijklmnop" });
    expect(live.read("t1", null).text).not.toContain("sk-ant-abcdefghijklmnop");
    live.apply({ type: "turn_end", taskId: "t1" });
    expect(live.read("t1", null)).toEqual({ taskId: "t1", text: "", since: null });
  });
});
