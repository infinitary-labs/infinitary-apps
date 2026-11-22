import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@core/storage/db";
import { SessionRecordStore } from "@core/storage/sessionRecordStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BYTE_CLASSES,
  classifyLine,
  type FootprintReport,
  main,
  measureFile,
  measureSessionFootprint,
  parseArgs,
  summarize,
} from "../scripts/measure-session-footprint.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The footprint measurement over a fixture userData: session files shaped
 * like Pi writes them (user text, assistant text with thinking and a tool
 * call, a tool result with text and an image), joined to task rows the
 * app's own writer made. Every byte lands in exactly one class, closed
 * work older than the window is the candidate set, and nothing on disk
 * changes.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-09T12:00:00.000Z");

let root: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function jsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const IMAGE = "A".repeat(4_000);

function crewmateSession(): string {
  return jsonl([
    { type: "session", version: 3, id: "s1", timestamp: "2026-08-01T10:00:00.000Z", cwd: "/w" },
    {
      type: "model_change",
      id: "m1",
      timestamp: "2026-08-01T10:00:00.000Z",
      provider: "openai",
      modelId: "gpt-5",
    },
    {
      type: "message",
      id: "u1",
      timestamp: "2026-08-01T10:00:01.000Z",
      message: {
        role: "user",
        content: "You are a crewmate. Fix the flaky meter test.",
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-08-01T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me look at the test first." },
          { type: "text", text: "Reading the test." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "meter.test.ts" } },
        ],
        provider: "openai",
        model: "gpt-5",
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "t1",
      timestamp: "2026-08-01T10:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [
          { type: "text", text: "x".repeat(2_000) },
          { type: "image", data: IMAGE, mimeType: "image/png" },
        ],
        isError: false,
      },
    },
    {
      type: "message",
      id: "a2",
      timestamp: "2026-08-01T10:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Awaited the queue; the test is green ten runs in a row." },
        ],
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
      },
    },
  ]);
}

/** The fields the Claude client writes on every conversation line. */
function claudeFrame(uuid: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/w",
    sessionId: "c1",
    version: "2.1.0",
    gitBranch: "fm/task-1",
    uuid,
    timestamp: "2026-08-01T10:00:00.000Z",
  };
}

const STEER = "Also check the meter's label.";
const SIGNATURE = "S".repeat(600);
const OUTPUT = "x".repeat(2_000);
const SNAPSHOT = { type: "prompt_snapshot", systemPrompt: "You are a crewmate.", tools: ["Read"] };
const REMINDER = { type: "total_tokens_reminder", text: "<total_tokens>9000 left</total_tokens>" };
const RENDERED = [{ content: "<system-reminder>9000 tokens left</system-reminder>" }];
const READ_INPUT = { file_path: "/w/meter.png" };
const BASH_INPUT = { command: "pnpm test meter", description: "Run the meter test" };
const IMAGE_COPY = {
  type: "image",
  file: { base64: IMAGE, type: "image/png", originalSize: 3_000 },
};
const OUTPUT_COPY = { stdout: OUTPUT, stderr: "", interrupted: false, isImage: false };

/** A crewmate session as the Claude client writes it, one line per content block. */
function claudeSessionLines(): string[] {
  const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
    ...claudeFrame(uuid),
    type: "assistant",
    requestId: "req_1",
    message: {
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 9_000 },
    },
    ...extra,
  });
  return [
    { type: "queue-operation", operation: "enqueue", sessionId: "c1", content: STEER },
    {
      ...claudeFrame("u1"),
      type: "user",
      promptId: "p1",
      message: { role: "user", content: "You are a crewmate. Fix the flaky meter test." },
    },
    { ...claudeFrame("at1"), type: "attachment", attachment: SNAPSHOT },
    {
      ...claudeFrame("at2"),
      type: "attachment",
      attachment: REMINDER,
      rendered: RENDERED,
      renderedRole: "user",
    },
    assistant("a1", [{ type: "thinking", thinking: "", signature: SIGNATURE }]),
    assistant(
      "a2",
      [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: READ_INPUT,
          caller: { type: "direct" },
        },
      ],
      { wireToolInputs: { toolu_1: READ_INPUT } },
    ),
    {
      ...claudeFrame("u2"),
      type: "user",
      sourceToolAssistantUUID: "a2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE } },
            ],
          },
        ],
      },
      toolUseResult: IMAGE_COPY,
    },
    assistant(
      "a3",
      [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Bash",
          input: BASH_INPUT,
          caller: { type: "direct" },
        },
      ],
      { wireToolInputs: { toolu_2: BASH_INPUT } },
    ),
    {
      ...claudeFrame("u3"),
      type: "user",
      sourceToolAssistantUUID: "a3",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_2", content: OUTPUT, is_error: false },
        ],
      },
      toolUseResult: OUTPUT_COPY,
    },
    {
      ...claudeFrame("at3"),
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: STEER,
        source_uuid: "s1",
        commandMode: "prompt",
      },
      rendered: [{ content: STEER }],
      renderedRole: "user",
    },
    assistant("a4", [
      { type: "text", text: "Awaited the queue; the test is green ten runs in a row." },
    ]),
    {
      ...claudeFrame("u4"),
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: /w" }],
      },
    },
    {
      ...claudeFrame("u5"),
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "Earlier: the meter test was flaky." },
    },
    { type: "last-prompt", lastPrompt: STEER, leafUuid: "a4", sessionId: "c1" },
    { type: "ai-title", aiTitle: "Fix the flaky meter test", sessionId: "c1" },
  ].map((entry) => JSON.stringify(entry));
}

/** The authored Claude-format planning session, including a long tool result. */
const RECORDED_CLAUDE_SESSION = fileURLToPath(
  new URL(
    "./fixtures/replay/handoff-approval/crewmates/8c300001/sessions/8c300001-235a-429d-a3ec-f812f73b4e00.jsonl",
    import.meta.url,
  ),
);

function fixture(): string {
  root = scratchDir("infinitary-footprint-");
  const db = openDatabase(root);
  const closedAt = NOW - 40 * DAY;
  let now = closedAt - 1_000;
  const tasks = new TaskService({ db, now: () => now, strict: true });
  // WI-11 retired `delivered`/`finish`: a finished crewmate is closed by
  // landing it, so seed idle then land at the moment that sets its closedDays.
  seedTask(tasks, { id: "old1", title: "Old and done", status: "idle" });
  now = closedAt;
  tasks.close("old1", { status: "done", reason: "landed", actor: "captain" });
  now = NOW - 2 * DAY - 1_000;
  seedTask(tasks, { id: "new1", title: "Recently done", status: "idle" });
  now = NOW - 2 * DAY;
  tasks.close("new1", { status: "done", reason: "landed", actor: "captain" });
  now = NOW - DAY;
  seedTask(tasks, { id: "live1", title: "Still running", status: "idle" });
  db.close();
  for (const id of ["old1", "new1", "live1", "orphan"]) {
    const dir = join(root, "crewmates", id, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), crewmateSession());
  }
  const fm = join(root, "firstmate", "sessions");
  mkdirSync(fm, { recursive: true });
  writeFileSync(
    join(fm, "rolling.jsonl"),
    jsonl([
      { type: "session", version: 3, id: "fm", timestamp: "2026-08-01T10:00:00.000Z" },
      {
        type: "message",
        id: "u1",
        timestamp: "2026-08-01T10:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "how is the meter going?" }] },
      },
      {
        type: "compaction",
        id: "c1",
        timestamp: "2026-08-02T10:00:00.000Z",
        summary: "earlier: meter work",
      },
    ]),
  );
  return root;
}

describe("measure-session-footprint (task-system P5)", () => {
  it("puts every byte of a line in exactly one class", () => {
    const lines = crewmateSession().trim().split("\n");
    for (const line of lines) {
      const classes = classifyLine(line);
      const sum = BYTE_CLASSES.reduce((n, key) => n + classes[key], 0);
      expect(sum).toBe(Buffer.byteLength(line));
    }
    const toolResult = classifyLine(lines[4] as string);
    expect(toolResult.images).toBe(IMAGE.length);
    expect(toolResult.toolResults).toBe(2_000);
    const assistant = classifyLine(lines[3] as string);
    expect(assistant.thinking).toBe("Let me look at the test first.".length);
    expect(assistant.assistantText).toBe("Reading the test.".length);
    expect(assistant.toolCalls).toBeGreaterThan(0);
    expect(classifyLine("not json").framing).toBe(8);
  });

  it("reads the Claude client's lines into their classes, not framing", () => {
    const bytes = (value: unknown) =>
      Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
    const lines = claudeSessionLines();
    const classes = lines.map((line) => classifyLine(line));
    lines.forEach((line, index) => {
      const sum = BYTE_CLASSES.reduce((n, key) => n + (classes[index]?.[key] ?? 0), 0);
      expect(sum).toBe(Buffer.byteLength(line));
    });
    const [queued, brief, snapshot, reminder, thinking, read, image, bash, output, steer] = classes;
    const [said, meta, compacted, lastPrompt, title] = classes.slice(10);
    expect(queued?.userText).toBe(bytes(STEER));
    expect(brief?.userText).toBe(bytes("You are a crewmate. Fix the flaky meter test."));
    expect(snapshot?.attachments).toBe(bytes(SNAPSHOT));
    expect(reminder?.attachments).toBe(bytes(REMINDER) + bytes(RENDERED));
    expect(thinking?.thinking).toBe(SIGNATURE.length);
    expect(read?.toolCalls).toBe(
      bytes("Read") + bytes(READ_INPUT) + bytes({ toolu_1: READ_INPUT }),
    );
    expect(image).toMatchObject({ images: IMAGE.length, toolResultCopies: bytes(IMAGE_COPY) });
    expect(bash?.toolCalls).toBe(
      bytes("Bash") + bytes(BASH_INPUT) + bytes({ toolu_2: BASH_INPUT }),
    );
    expect(output).toMatchObject({
      toolResults: OUTPUT.length,
      toolResultCopies: bytes(OUTPUT_COPY),
    });
    expect(steer?.userText).toBe(bytes(STEER) + bytes([{ content: STEER }]));
    expect(said?.assistantText).toBe(
      bytes("Awaited the queue; the test is green ten runs in a row."),
    );
    expect(meta?.attachments).toBe(bytes("Base directory for this skill: /w"));
    expect(compacted?.compaction).toBe(bytes("Earlier: the meter test was flaky."));
    expect(lastPrompt?.userText).toBe(bytes(STEER));
    expect(title?.framing).toBe(lines[14]?.length);

    const recorded = measureFile(RECORDED_CLAUDE_SESSION);
    expect(BYTE_CLASSES.reduce((n, key) => n + recorded.classes[key], 0)).toBe(recorded.bytes);
    for (const key of BYTE_CLASSES.filter((key) => key !== "compaction" && key !== "framing")) {
      expect(recorded.classes[key], key).toBeGreaterThan(0);
    }
    expect(recorded.classes.framing).toBeLessThan(recorded.bytes / 10);
  });

  it("measures a userData: files by session, joined to the record, with the candidate window", () => {
    const dir = fixture();
    const before = readFileSync(join(dir, "crewmates", "old1", "sessions", "session.jsonl"));
    const report = measureSessionFootprint({ userDataDir: dir, olderThanDays: 30, now: NOW });

    expect(report.database).toBe(true);
    expect(report.totals.files).toBe(5);
    const file = measureFile(join(dir, "crewmates", "old1", "sessions", "session.jsonl"));
    expect(BYTE_CLASSES.reduce((n, key) => n + file.classes[key], 0)).toBe(file.bytes);
    expect(report.totals.bytes).toBe(4 * file.bytes + report.singletons.firstmate.bytes);
    expect(report.singletons.firstmate.classes.compaction).toBe("earlier: meter work".length);
    expect(report.singletons.supervision.files).toBe(0);

    expect(report.crewmates.map((c) => [c.taskId, c.status, c.closedDays])).toEqual([
      ["live1", "active", null],
      ["new1", "done", 2],
      ["old1", "done", 40],
      ["orphan", "unknown", null],
    ]);
    expect(report.crewmates[2]?.key).toBe("SCR-1");
    expect(report.byStatus).toEqual({
      active: { tasks: 1, bytes: file.bytes },
      done: { tasks: 2, bytes: 2 * file.bytes },
      unknown: { tasks: 1, bytes: file.bytes },
    });
    expect(report.candidates).toEqual({
      olderThanDays: 30,
      tasks: 1,
      bytes: file.bytes,
      droppable: {
        toolResults: file.classes.toolResults,
        toolResultCopies: file.classes.toolResultCopies,
        images: file.classes.images,
        thinking: file.classes.thinking,
      },
      kept: {
        userText: file.classes.userText,
        assistantText: file.classes.assistantText,
        toolCalls: file.classes.toolCalls,
        attachments: file.classes.attachments,
        framing: file.classes.framing + file.classes.compaction,
      },
    });
    expect(report.candidates.droppable.images).toBe(IMAGE.length);

    expect(readFileSync(join(dir, "crewmates", "old1", "sessions", "session.jsonl"))).toEqual(
      before,
    );
    const text = summarize(report);
    expect(text).toContain("candidates (closed >= 30 days): 1 tasks");
    expect(text).toContain("nothing was changed");
    expect(text).not.toContain("flaky meter");
  });

  it("runs without a database and reports statuses unknown", () => {
    root = scratchDir("infinitary-footprint-nodb-");
    const dir = join(root, "crewmates", "x", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), crewmateSession());
    const report = measureSessionFootprint({ userDataDir: root, now: NOW });
    expect(report.database).toBe(false);
    expect(report.crewmates[0]).toMatchObject({ taskId: "x", status: "unknown", key: null });
    expect(report.candidates.tasks).toBe(0);
    expect(summarize(report)).toContain("no database found");
  });

  it.each([false, true])(
    "counts Firstmate Claude copies and sidecars without changing files (other sessions: %s)",
    async (withOtherSessions) => {
      const dir = withOtherSessions ? fixture() : scratchDir("infinitary-footprint-claude-");
      root = dir;
      if (withOtherSessions) {
        const supervision = join(dir, "supervision", "sessions");
        mkdirSync(supervision, { recursive: true });
        writeFileSync(join(supervision, "legacy.jsonl"), crewmateSession());
      }
      const baseline = measureSessionFootprint({ userDataDir: dir });
      const claudeDir = join(dir, "firstmate", "claude");
      const store = new SessionRecordStore(claudeDir);
      // The producer mirrors the client's original and writes its served sidecar.
      // The original, outside the session folders, must not be counted again.
      const original = join(dir, "client-original.jsonl");
      writeFileSync(
        original,
        jsonl([
          { type: "user", uuid: "u1", message: { role: "user", content: "Private café request" } },
          {
            type: "assistant",
            uuid: "a1",
            message: { role: "assistant", content: [{ type: "text", text: "Private reply" }] },
          },
        ]),
      );
      store.mirror("seat", original);
      await store.stamp("seat", {
        kind: "served",
        at: NOW,
        prompt: { textSha256: "fixture-sha", uuid: "u1" },
        steers: [],
      });
      const ignored = join(claudeDir, "readme.txt");
      writeFileSync(ignored, "Not a transcript");
      const paths = [store.transcriptPath("seat"), store.sidecarPath("seat"), original, ignored];
      const before = paths.map((path) => readFileSync(path));
      const addedBytes = (before[0]?.length ?? 0) + (before[1]?.length ?? 0);
      const out = join(dir, "footprint.json");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(main(["--user-data", dir, "--out", out])).toBe(0);
      const report = JSON.parse(readFileSync(out, "utf8")) as FootprintReport;

      expect(report.singletons.firstmate).toMatchObject({
        files: baseline.singletons.firstmate.files + 2,
        bytes: baseline.singletons.firstmate.bytes + addedBytes,
        lines: baseline.singletons.firstmate.lines + 3,
      });
      expect(report.totals).toMatchObject({
        files: baseline.totals.files + 2,
        bytes: baseline.totals.bytes + addedBytes,
        lines: baseline.totals.lines + 3,
      });
      for (const totals of [report.singletons.firstmate, report.totals]) {
        expect(BYTE_CLASSES.reduce((sum, key) => sum + totals.classes[key], 0)).toBe(totals.bytes);
      }
      expect(report.singletons.supervision).toEqual(baseline.singletons.supervision);
      expect(report.crewmates).toEqual(baseline.crewmates);
      expect(report.byStatus).toEqual(baseline.byStatus);
      expect(report.candidates).toEqual(baseline.candidates);
      expect(report.database).toBe(withOtherSessions);
      const printed = log.mock.calls.map(([text]) => String(text)).join("\n");
      expect(printed).toContain(`${report.totals.files} files, ${report.totals.lines} lines`);
      expect(printed).toContain(`firstmate ${report.singletons.firstmate.bytes} B`);
      for (const output of [printed, JSON.stringify(report)]) {
        expect(output).not.toContain("Private café request");
        expect(output).not.toContain("Private reply");
      }
      expect(paths.map((path) => readFileSync(path))).toEqual(before);
    },
  );

  it("writes the report through main and refuses bad arguments", () => {
    const dir = fixture();
    const out = join(dir, "footprint.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--user-data", dir, "--out", out, "--older-than-days", "7"])).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8")) as {
      candidates: { olderThanDays: number };
    };
    expect(written.candidates.olderThanDays).toBe(7);
    expect(log.mock.calls.some((call) => String(call[0]).includes("by class:"))).toBe(true);
    expect(main(["--older-than-days", "soon"])).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/whole number/);
    expect(parseArgs([]).olderThanDays).toBe(30);
    expect(main(["--help"])).toBe(0);
  });
});
