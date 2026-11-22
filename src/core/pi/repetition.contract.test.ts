import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { RepetitionNotice, ToolObservation } from "@shared/toolCompletion";
import { placedEventRecordSchema } from "@shared/work";
import { describe, expect, it } from "vitest";
import { fakeSession } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderWake } from "../orchestrator/wakes";
import { completionDigest } from "../session/completionFingerprint";
import { followCompletions } from "../session/followCompletions";
import { openDatabase, openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { SessionCompletionStore } from "../storage/sessionCompletionStore";
import { REPETITION_WAKE_AT, TaskRepetitionStore } from "../storage/taskRepetitionStore";
import { UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";

// Intent: INF-1996's accepted piece 2, including the captain's three-total
// choice for failed repeats and efficient long-session observation, and
// INF-6091 finding 4: repeats that worked wake the first mate only at a higher
// count. Real read-tool content is used below; the transcript envelopes are
// the two backends' recorded shapes.
const WORKED = REPETITION_WAKE_AT.worked;
const picturePath = resolve("release-notes/pictures/activity-settles-setting-runs-light.png");
async function pictureResult() {
  return (
    await createReadTool(process.cwd(), { autoResizeImages: false }).execute("capture", {
      path: picturePath,
    })
  ).content;
}
async function missingFileRefusal(): Promise<string> {
  try {
    await createReadTool(process.cwd(), {}).execute("missing", { path: "gone.md" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("The read tool read a file that is not there");
}
function append(path: string, ...entries: unknown[]) {
  appendFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
function pi(call: string, args: unknown, content: unknown, isError = false) {
  return [
    {
      type: "message",
      id: `${call}-start`,
      timestamp: 1000,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: call, name: "read", arguments: args }],
      },
    },
    {
      type: "message",
      id: `${call}-end`,
      timestamp: 2000,
      message: { role: "toolResult", toolCallId: call, toolName: "read", content, isError },
    },
  ];
}
function claude(call: string, args: unknown, content: unknown, isError = false) {
  const returned = Array.isArray(content)
    ? content.map((part) =>
        part?.type === "image"
          ? {
              type: "image",
              source: { type: "base64", media_type: part.mimeType, data: part.data },
            }
          : part,
      )
    : content;
  return [
    {
      type: "assistant",
      uuid: `${call}-start`,
      timestamp: "2026-10-30T12:00:00-07:00",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: call, name: "Read", input: args }],
      },
    },
    {
      type: "user",
      uuid: `${call}-end`,
      timestamp: "2026-10-30T12:00:01-07:00",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call, content: returned, is_error: isError }],
      },
    },
  ];
}
function environment() {
  const dir = scratchDir("infinitary-repetition-");
  const path = join(dir, "conversation.jsonl");
  writeFileSync(path, "");
  const journal = join(dir, "completions.sqlite");
  const work = new SessionCompletionStore(journal, () => 2000);
  work.activate(path);
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, now: () => 2000 });
  seedTask(tasks, { id: "task", title: "Compare pictures", status: "running" });
  const inbox = new InboxStore(db, { now: () => 2000 });
  const notices: RepetitionNotice[] = [];
  const events: ToolObservation[] = [];
  const enqueue = (notice: RepetitionNotice) => {
    notices.push(notice);
    inbox.enqueueWake(
      "firstmate",
      {
        once: notice.identity,
        facts: {
          kind: "possible-repetition",
          task: { id: "task", title: "Compare pictures" },
          notice,
          usage: null,
        },
      },
      "agent",
      "task",
    );
  };
  const deliver = (event: ToolObservation) => {
    events.push(event);
    tasks.observeTool("task", event, enqueue);
  };
  return { dir, path, journal, work, db, tasks, inbox, notices, events, deliver, enqueue };
}

describe("incremental completed-operation repetition", () => {
  it("canonicalizes typed arguments without losing array, scalar, image or error identity", async () => {
    expect(completionDigest({ b: 2, a: [1, "1", null] })).toBe(
      completionDigest({ a: [1, "1", null], b: 2 }),
    );
    expect(completionDigest([1, "1"])).not.toBe(completionDigest(["1", 1]));
    expect(completionDigest({ a: undefined })).not.toBe(completionDigest({}));
    const content = await pictureResult();
    expect(content.some((block) => block.type === "image")).toBe(true);
    expect(completionDigest([content, false])).not.toBe(completionDigest([content, true]));
    expect(completionDigest(content)).not.toBe(completionDigest([...content].reverse()));
    const image = content.find((block) => block.type === "image");
    if (image?.type !== "image") throw new Error("The real read tool returned no picture");
    expect(completionDigest(image)).not.toBe(
      completionDigest({ ...image, mimeType: "image/jpeg" }),
    );
    expect(completionDigest(image)).not.toBe(
      completionDigest({ ...image, data: image.data.slice(1) }),
    );
  });

  for (const [backend, entries] of [
    ["Pi", pi],
    ["Claude", claude],
  ] as const) {
    it(`${backend}: a third working completion wakes nobody; the higher count notifies once across interleaved operations and compaction`, async () => {
      const e = environment();
      try {
        const content = await pictureResult();
        const operations = ["A", "B", "C", "A", "B", "C", ...Array(WORKED - 1).fill("A")];
        // A's completions sit at 0, 3 and 6 onward, so its WORKED-th is here.
        const wakes = WORKED + 3;
        for (const [index, operation] of operations.entries()) {
          append(e.path, ...entries(`call-${index}`, { path: operation, limit: 20 }, content));
          e.work.scan(e.path, e.deliver);
          expect(e.notices).toHaveLength(index < wakes ? 0 : 1);
          // INF-6091 finding 4: A's third identical working completion wakes nobody.
          if (index === 6) expect(e.notices).toHaveLength(0);
          if (index === 4) {
            append(e.path, { type: "compaction", id: "fold", summary: "pictures compared" });
            if (backend === "Claude")
              append(e.path, {
                type: "user",
                uuid: "compact-summary",
                isCompactSummary: true,
                message: { role: "user", content: "Summary of earlier work" },
              });
          }
        }
        expect(e.notices[0]).toMatchObject({
          count: WORKED,
          outcome: "worked",
          first: { callId: "call-0" },
          latest: { callId: `call-${wakes}` },
        });
        expect(e.inbox.pending("firstmate")).toHaveLength(1);
        const notice = e.notices[0];
        if (!notice) throw new Error("The third result did not produce its notice");
        const text = renderWake({
          facts: {
            kind: "possible-repetition",
            task: { id: "task", title: "Compare pictures" },
            notice,
            usage: null,
          },
        });
        // INF-5123 finding 2: a repeat of calls that worked never reads as a failure.
        expect(text).toContain("every one of those calls worked; none failed");
        expect(text).not.toContain("error");
        expect(text).toContain("Repeated tests, rereads and polling may be useful");
        expect(text).toContain("unknown, not zero");
        expect(text).not.toContain(picturePath);
        expect(text).not.toContain(content.find((block) => block.type === "image")?.data);
        const count = e.work.work.fingerprintBytes;
        for (const event of [...e.events]) e.deliver(event);
        e.work.scan(e.path, e.deliver);
        expect(e.work.work.fingerprintBytes).toBe(count);
        expect(e.inbox.pending("firstmate")).toHaveLength(1);
        expect(
          e.db
            .prepare(
              "SELECT count FROM task_repetitions WHERE task_id = ? ORDER BY count DESC LIMIT 1",
            )
            .get("task"),
        ).toEqual({ count: WORKED + 1 });
      } finally {
        e.work.close();
        e.db.close();
      }
    });
  }

  for (const [backend, entries] of [
    ["Pi", pi],
    ["Claude", claude],
  ] as const) {
    it(`${backend}: three identical failed completions say they failed`, async () => {
      const e = environment();
      try {
        // The real read tool's refusal of a missing file, as its session records it.
        const refusal = [{ type: "text", text: await missingFileRefusal() }];
        for (let index = 0; index < 3; index++)
          append(e.path, ...entries(`failed-${index}`, { path: "gone.md" }, refusal, true));
        e.work.scan(e.path, e.deliver);
        expect(e.notices).toEqual([expect.objectContaining({ count: 3, outcome: "failed" })]);
        const notice = e.notices[0];
        if (!notice) throw new Error("The third failed result did not produce its notice");
        expect(
          renderWake({
            facts: {
              kind: "possible-repetition",
              task: { id: "task", title: "Compare pictures" },
              notice,
              usage: null,
            },
          }),
        ).toContain("every one of those calls failed with the same error");
      } finally {
        e.work.close();
        e.db.close();
      }
    });
  }

  it("a work computer that does not say whether its calls failed leaves the outcome unknown", () => {
    const e = environment();
    try {
      for (let sequence = 1; sequence <= 3; sequence++)
        e.deliver({
          type: "tool_observation",
          stream: "older.jsonl",
          sequence,
          source: "crewmate",
          at: 2000 + sequence,
          fact: {
            kind: "completed",
            callId: `older-${sequence}`,
            toolName: "read",
            operation: "op",
            result: "same",
          },
        });
      expect(e.notices).toEqual([expect.objectContaining({ count: 3, outcome: "unknown" })]);
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("changed content/error starts at one; delivered guidance retires old derived state, unlike compaction", () => {
    const e = environment();
    try {
      const result = [{ type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") }];
      for (let index = 0; index < WORKED; index++)
        append(e.path, ...pi(`before-${index}`, { path: "CONTRIBUTING.md" }, result));
      e.work.scan(e.path, e.deliver);
      expect(e.notices).toHaveLength(1);
      for (const [index, isError] of [true, ...Array(WORKED).fill(false)].entries()) {
        append(e.path, ...pi(`changed-${index}`, { path: "CONTRIBUTING.md" }, result, isError));
        e.work.scan(e.path, e.deliver);
        expect(e.notices).toHaveLength(index === WORKED ? 2 : 1);
      }
      const changed = [{ type: "text", text: readFileSync("CLAUDE.md", "utf8") }];
      append(e.path, ...pi("new-content-1", { path: "CONTRIBUTING.md" }, changed));
      e.work.scan(e.path, e.deliver);
      expect(e.db.prepare("SELECT count FROM task_repetitions").get()).toEqual({ count: 1 });
      expect(e.notices).toHaveLength(2);
      append(e.path, {
        type: "message",
        id: "guidance",
        message: {
          role: "user",
          content: [{ type: "text", text: "Run the prescribed three checks again" }],
        },
      });
      e.work.scan(e.path, e.deliver);
      expect(e.db.prepare("SELECT COUNT(*) AS n FROM task_repetitions").get()).toEqual({ n: 0 });
      for (let index = 0; index < WORKED; index++)
        append(e.path, ...pi(`after-${index}`, { path: "CONTRIBUTING.md" }, result));
      e.work.scan(e.path, e.deliver);
      expect(e.notices).toHaveLength(3);
      expect(new Set(e.notices.map((notice) => notice.identity)).size).toBe(3);
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("waits on gaps, ignores duplicate facts, and rolls back checkpoint, operation and inbox together on a delivery crash", () => {
    const e = environment();
    try {
      const event = (sequence: number): ToolObservation => ({
        type: "tool_observation",
        stream: "source",
        sequence,
        source: `source:${sequence}`,
        at: sequence * 1000,
        fact: {
          kind: "completed",
          callId: `c${sequence}`,
          toolName: "read",
          operation: "read-source",
          result: "unchanged",
        },
      });
      expect(() => e.tasks.observeTool("task", event(2), e.enqueue)).toThrow("ordering gap");
      e.tasks.observeTool("task", event(1), e.enqueue);
      e.tasks.observeTool("task", event(1), e.enqueue);
      e.tasks.observeTool("task", event(2), e.enqueue);
      expect(() =>
        e.tasks.observeTool("task", event(3), (notice) => {
          e.enqueue(notice);
          throw new Error("crash before commit");
        }),
      ).toThrow("crash before commit");
      expect(e.inbox.pending("firstmate")).toHaveLength(0);
      expect(e.db.prepare("SELECT sequence FROM task_repetition_cursors").get()).toEqual({
        sequence: 2,
      });
      expect(e.db.prepare("SELECT count FROM task_repetitions").get()).toEqual({ count: 2 });
      const recovered = new TaskRepetitionStore(e.db);
      recovered.consume("task", event(3), e.enqueue);
      recovered.consume("task", event(3), e.enqueue);
      expect(e.inbox.pending("firstmate")).toHaveLength(1);
      expect(e.db.prepare("SELECT COUNT(*) AS n FROM inbox_once").get()).toEqual({ n: 1 });
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("reopens at durable checkpoints, retries pending delivery without rehashing pictures, and retains incomplete pairs", async () => {
    const e = environment();
    let work = e.work;
    try {
      const content = await pictureResult();
      append(e.path, ...pi("one", { path: "picture" }, content));
      for (let index = 3; index < WORKED; index++)
        append(e.path, ...pi(`earlier-${index}`, { path: "picture" }, content));
      work.scan(e.path, e.deliver);
      const [start, end] = pi("two", { path: "picture" }, content);
      append(e.path, start);
      work.scan(e.path, e.deliver);
      work.close();
      work = new SessionCompletionStore(e.journal);
      append(e.path, end);
      expect(() =>
        work.scan(e.path, () => {
          throw new Error("home unreachable");
        }),
      ).toThrow("home unreachable");
      work.close();
      work = new SessionCompletionStore(e.journal);
      work.scan(e.path, e.deliver);
      expect(work.work).toMatchObject({ lines: 0, fingerprintBytes: 0, completions: 0 });
      append(e.path, ...pi("three", { path: "picture" }, content));
      work.scan(e.path, e.deliver);
      expect(e.notices).toHaveLength(1);
      expect(work.work.lines).toBe(2);
      expect(work.work.completions).toBe(1);
      // A crash after the home committed but before the work side
      // acknowledged it must redeliver without incrementing or rehashing.
      append(e.path, ...pi("four", { path: "picture" }, content));
      expect(() =>
        work.scan(e.path, (event) => {
          e.deliver(event);
          throw new Error("lost acknowledgement");
        }),
      ).toThrow("lost acknowledgement");
      work.close();
      work = new SessionCompletionStore(e.journal);
      work.scan(e.path, e.deliver);
      expect(work.work).toMatchObject({ lines: 0, fingerprintBytes: 0, completions: 0 });
      expect(e.db.prepare("SELECT count FROM task_repetitions").get()).toEqual({
        count: WORKED + 1,
      });
      // A reconnect carries only the compact fact through the existing wire.
      const transported = placedEventRecordSchema.parse({
        seq: 10,
        at: 2000,
        event: e.events.at(-1),
      });
      e.deliver(transported.event as ToolObservation);
      expect(e.inbox.pending("firstmate")).toHaveLength(1);
    } finally {
      work.close();
      e.db.close();
    }
  });

  it("first activation is fresh, while later restarts process only the uncheckpointed suffix", () => {
    const dir = scratchDir("infinitary-repetition-activation-");
    const path = join(dir, "source.jsonl");
    const journal = join(dir, "completions.sqlite");
    const content = [{ type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") }];
    for (let index = 0; index < 100; index++) append(path, ...pi(`old-${index}`, {}, content));
    let work = new SessionCompletionStore(journal);
    const seen: ToolObservation[] = [];
    work.scan(path, (fact) => seen.push(fact));
    expect(work.work.lines).toBe(0);
    expect(seen).toHaveLength(0);
    append(path, ...pi("new", {}, content));
    work.close();
    work = new SessionCompletionStore(journal);
    try {
      work.scan(path, (fact) => seen.push(fact));
      expect(work.work.lines).toBe(2);
      expect(seen).toHaveLength(1);
    } finally {
      work.close();
    }
  });

  it("a later conversation is not treated as another first activation", () => {
    const e = environment();
    let work = e.work;
    try {
      const content = [{ type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") }];
      for (let index = 2; index < WORKED; index++)
        append(e.path, ...pi(`first-${index}`, {}, content));
      work.scan(e.path, e.deliver);
      const next = join(e.dir, "next-conversation.jsonl");
      append(next, ...pi("second", {}, content), ...pi("third", {}, content));
      work.close();
      work = new SessionCompletionStore(e.journal);
      work.activate(next, readFileSync(next).length);
      work.recover(e.deliver);
      expect(e.notices).toHaveLength(1);
      expect(work.work.completions).toBe(2);
    } finally {
      work.close();
      e.db.close();
    }
  });

  it("keeps checkpoint and notice identity when the task folder moves, without revisiting the kept old copy", () => {
    const e = environment();
    let work = e.work;
    try {
      const content = [{ type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") }];
      for (let index = 1; index < WORKED; index++)
        append(e.path, ...pi(`earlier-${index}`, {}, content));
      work.scan(e.path, e.deliver);
      work.close();
      const moved = join(e.dir, "moved");
      mkdirSync(moved);
      const source = join(moved, "conversation.jsonl");
      const journal = join(moved, "completions.sqlite");
      cpSync(e.path, source);
      cpSync(e.journal, journal);
      // Anything appended to the recovery copy is not this conversation's new work.
      append(e.path, ...pi("old-copy", {}, content));
      work = new SessionCompletionStore(journal);
      work.activate(source);
      work.recover(e.deliver, moved);
      expect(work.work.lines).toBe(0);
      expect(e.notices).toHaveLength(0);
      append(source, ...pi("third", {}, content));
      work.scan(source, e.deliver);
      expect(e.notices).toHaveLength(1);
      expect(e.notices[0]?.latest.callId).toBe("third");
    } finally {
      work.close();
      e.db.close();
    }
  });

  it("continues after the deletion owner replaces a transcript without replaying changed history", () => {
    const e = environment();
    try {
      const content = [{ type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") }];
      append(e.path, ...pi("first", {}, content));
      e.work.scan(e.path, e.deliver);
      const changed = `${e.path}.rewritten`;
      append(changed, {
        type: "message",
        id: "removed",
        message: { role: "user", content: "Earlier outside content was removed." },
      });
      renameSync(changed, e.path);
      e.work.scan(e.path, e.deliver);
      expect(e.events).toHaveLength(1);
      for (let index = 1; index < WORKED; index++)
        append(e.path, ...pi(`later-${index}`, {}, content));
      e.work.scan(e.path, e.deliver);
      expect(e.notices).toHaveLength(1);
      expect(e.notices[0]?.count).toBe(WORKED);
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("appending one result does constant source work at increasing session lengths and indexed operation counts", async () => {
    const content = await pictureResult();
    for (const length of [10, 100, 500]) {
      const e = environment();
      try {
        for (let index = 0; index < length; index++)
          append(e.path, ...pi(`c${index}`, { path: `picture-${index}` }, content));
        e.work.scan(e.path, e.deliver);
        expect(e.db.prepare("SELECT COUNT(*) AS n FROM task_repetitions").get()).toEqual({
          n: length,
        });
        const before = { ...e.work.work };
        append(e.path, ...pi("appended", { path: "picture-0" }, content));
        e.work.scan(e.path, e.deliver);
        expect(e.work.work.lines - before.lines).toBe(2);
        expect(e.work.work.completions - before.completions).toBe(1);
        expect(e.work.work.fingerprintBytes - before.fingerprintBytes).toBe(
          completionWork(content),
        );
        const plan = e.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM task_repetitions WHERE task_id = ? AND operation = ?",
          )
          .all("task", "digest");
        expect(plan).toEqual([
          expect.objectContaining({ detail: expect.stringContaining("USING INDEX") }),
        ]);
        const row = e.db.prepare("SELECT * FROM task_repetitions LIMIT 1").get();
        expect(JSON.stringify(row).length).toBeLessThan(1500);
        expect(e.work.retainedSourceBytes).toBe(0);
        expect(e.events.at(-1)?.fact).toMatchObject({ kind: "completed", callId: "appended" });
        console.info(
          "repetition-work",
          JSON.stringify({
            priorCompletions: length,
            distinctOperations: length,
            appendedLines: e.work.work.lines - before.lines,
            appendedSourceBytes: e.work.work.sourceBytes - before.sourceBytes,
            appendedFingerprintBytes: e.work.work.fingerprintBytes - before.fingerprintBytes,
            appendedCompletions: e.work.work.completions - before.completions,
            retainedSourceBytes: e.work.retainedSourceBytes,
            recordBytes: JSON.stringify(row).length,
            plan,
          }),
        );
      } finally {
        e.work.close();
        e.db.close();
      }
    }
  });

  it("does not reread partial image lines, and releases their buffers once the source line completes", async () => {
    const e = environment();
    try {
      const content = await pictureResult();
      const [start, result] = pi("partial", { path: "picture" }, content);
      append(e.path, start);
      e.work.scan(e.path, e.deliver);
      const line = `${JSON.stringify(result)}\n`;
      const middle = Math.floor(line.length / 2);
      appendFileSync(e.path, line.slice(0, middle));
      e.work.scan(e.path, e.deliver);
      expect(e.events).toHaveLength(0);
      expect(e.work.retainedSourceBytes).toBe(middle);
      const before = { ...e.work.work };
      e.work.scan(e.path, e.deliver);
      expect(e.work.work.sourceBytes).toBe(before.sourceBytes);
      expect(e.work.work.fingerprintBytes).toBe(before.fingerprintBytes);
      appendFileSync(e.path, line.slice(middle));
      e.work.scan(e.path, e.deliver);
      expect(e.events).toHaveLength(1);
      expect(e.work.work.sourceBytes - before.sourceBytes).toBe(
        Buffer.byteLength(line.slice(middle)),
      );
      expect(e.work.retainedSourceBytes).toBe(0);
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("session owners emit compact facts while activity continues; a placed copy is never fingerprinted again", async () => {
    const dir = scratchDir("infinitary-repetition-follow-");
    const path = join(dir, "source.jsonl");
    writeFileSync(path, "");
    const session = fakeSession({ recordPath: path });
    const seen: ToolObservation[] = [];
    let observed!: () => void;
    const completion = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const stop = await followCompletions(
      session,
      (event) => {
        if (event.type === "tool_observation") {
          seen.push(event);
          observed();
        }
      },
      () => 2000,
    );
    try {
      append(
        path,
        ...pi("read", { path: "CONTRIBUTING.md" }, [
          { type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") },
        ]),
      );
      session.emit({
        type: "tool_end",
        taskId: "task",
        callId: "read",
        toolName: "read",
        isError: false,
      });
      await completion;
      expect(seen).toHaveLength(1);
      const remote = fakeSession({ recordPath: path });
      const stopRemote = await followCompletions(
        remote,
        (event) => {
          if (event.type === "tool_observation") seen.push(event);
        },
        () => 2000,
        false,
      );
      const observed = seen[0];
      if (!observed) throw new Error("The source emitted no compact fact");
      remote.emit(observed);
      await Promise.resolve();
      await stopRemote();
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
    } finally {
      await stop();
    }
  });

  // INF-2248: asynchronous transcript discovery must neither overlap scans nor lose the final completion.
  it("drains an in-flight refresh and the final completion before closing its index", async () => {
    const dir = scratchDir("infinitary-repetition-refresh-");
    const path = join(dir, "source.jsonl");
    writeFileSync(path, "");
    const session = fakeSession({ recordPath: path });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    let active = 0;
    let peak = 0;
    function recordPath(): string;
    function recordPath(options: { refresh?: boolean }): string | Promise<string>;
    function recordPath(options?: { refresh?: boolean }): string | Promise<string> {
      if (!options?.refresh || !hold) return path;
      active++;
      peak = Math.max(peak, active);
      entered();
      return ready.then(() => {
        active--;
        return path;
      });
    }
    session.recordPath = recordPath;
    const seen: ToolObservation[] = [];
    const stop = await followCompletions(
      session,
      (event) => {
        if (event.type === "tool_observation") seen.push(event);
      },
      () => 2000,
    );
    hold = true;
    session.emit({ type: "turn_closed" });
    await waiting;
    append(
      path,
      ...pi("read", { path: "CONTRIBUTING.md" }, [
        { type: "text", text: readFileSync("CONTRIBUTING.md", "utf8") },
      ]),
    );
    session.emit({ type: "turn_closed" });
    let closed = false;
    const closing = stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(peak).toBe(1);
    expect(seen).toHaveLength(1);
    expect(stop()).toBe(stop());
  });

  it("uses an indexed available usage reading without treating missing cost or tokens as zero", () => {
    const e = environment();
    try {
      const usage = new UsageStore(e.db);
      expect(usage.latestForTask("task")).toBeNull();
      usage.record({ taskId: "task", at: 1000, usage: { input: 300, output: 20 } });
      expect(usage.latestForTask("task")).toMatchObject({
        input: 300,
        output: 20,
        cost: null,
        cache_read: null,
      });
      usage.record({ taskId: "task", at: 2000, usage: { input: 300, output: 20 } });
      usage.record({ taskId: "task", at: 2000, usage: {} });
      // The accepted plan asks for the latest available reading, not the last
      // imported historical row. Equal times keep the last recorded reading.
      usage.record({ taskId: "task", at: 1000, usage: { input: 300, output: 20 } });
      expect(usage.latestForTask("task")).toEqual({
        at: 2000,
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        cost: null,
      });
    } finally {
      e.work.close();
      e.db.close();
    }
  });

  it("task state and notice once-identity survive a real database close and reopen", () => {
    const dir = scratchDir("infinitary-repetition-home-");
    let db = openDatabase(dir);
    seedTask(new TaskService({ db }), {
      id: "task",
      title: "Repeated prescribed checks",
      status: "running",
    });
    const event = (sequence: number): ToolObservation => ({
      type: "tool_observation",
      stream: "source",
      sequence,
      source: `source:${sequence}`,
      at: sequence,
      fact: {
        kind: "completed",
        callId: `c${sequence}`,
        toolName: "read",
        operation: "operation",
        result: "result",
      },
    });
    new TaskService({ db }).observeTool("task", event(1), () => {
      throw new Error("too early");
    });
    new TaskService({ db }).observeTool("task", event(2), () => {
      throw new Error("too early");
    });
    db.close();
    db = openDatabase(dir);
    try {
      const tasks = new TaskService({ db });
      const inbox = new InboxStore(db);
      const enqueue = (notice: RepetitionNotice) =>
        inbox.enqueueWake(
          "firstmate",
          {
            once: notice.identity,
            facts: {
              kind: "possible-repetition",
              task: { id: "task", title: "Repeated prescribed checks" },
              notice,
              usage: null,
            },
          },
          "agent",
          "task",
        );
      tasks.observeTool("task", event(3), enqueue);
      tasks.observeTool("task", event(3), enqueue);
      tasks.observeTool("task", event(4), enqueue);
      expect(inbox.pending("firstmate")).toHaveLength(1);
      expect(db.prepare("SELECT count FROM task_repetitions").get()).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });
});

function completionWork(content: unknown): number {
  let bytes = 0;
  completionDigest(["read", { path: "picture-0" }], (count) => {
    bytes += count;
  });
  completionDigest([content, false], (count) => {
    bytes += count;
  });
  return bytes;
}
