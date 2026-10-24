import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import { outsideDataDeletedNote } from "@shared/savedOutsideData";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GoogleStandIn,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../../../tests/helpers/googleStandIn";
import { allowIntegrationReads } from "../../../tests/helpers/integrationApprovals";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { Scheduler } from "../orchestrator/scheduler";
import { renderWake } from "../orchestrator/wakes";
import { appPathsFor, crewmateSessionsDir } from "../paths";
import { createScheduleTools } from "../pi/scheduleTools";
import { openInMemoryDatabase } from "../storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import {
  FIRSTMATE_READER,
  FileIntegrationSecrets,
  googleIntegration,
  googleSetup,
  IntegrationSettingsStore,
  IntegrationsService,
  OutsideReads,
  SavedOutsideData,
} from ".";

/**
 * INF-952: "A person can delete the Gmail and Calendar content Infinitary
 * saved without purging every task ... and Google-derived content is not
 * kept indefinitely." The captain's answers: a due passage is replaced
 * with a note and the conversation stays ("Yes, replace the passage and
 * keep the conversation"), 30 days after it was read ("30 days, the same
 * as Claude's own sweep").
 *
 * Gmail is the stand-in (`tests/helpers/googleStandIn.ts`), answering in
 * the shapes Google documents, through the real integrations service and
 * INF-951's fence; each answer is saved where Pi, the Claude client and
 * the app's copy of it save one.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOTE = outsideDataDeletedNote("Gmail and Calendar content");
const LENA = {
  from: "Lena Ortiz <lena@ortiz-studio.com>",
  subject: "Invoice 2214 for the October shoot",
  text: "Hi Ada,\n\nThe invoice for the October shoot is attached. Payment is due by Nov 4.\n\nThanks,\nLena",
};
const SESSION = "b0cd136b-1ae0-4fc3-b4e1-3c8a17807411";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function world() {
  const google: GoogleStandIn = await startGoogleStandIn();
  cleanup.push(() => google.close());
  const root = scratchDir("fm-outside-");
  const paths = appPathsFor(join(root, "userData"));
  const claudeConfigDir = join(root, "claude");
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  const tasks = new TaskService({ db, strict: true });
  const piWork = join(root, "worktrees", "task-1");
  const claudeWork = join(root, "worktrees", "task-2");
  seedTask(tasks, { id: "task-1", title: "Answer Lena", status: "idle", worktreeDir: piWork });
  seedTask(tasks, {
    id: "task-2",
    title: "File the invoice",
    status: "idle",
    worktreeDir: claudeWork,
    sessionFile: SESSION,
  });
  const clock = { now: Date.UTC(2026, 8, 20, 16, 5) };
  const reads = new OutsideReads(paths.integrationsDir);
  const setup = googleSetup({
    packaged: false,
    env: {
      INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
      INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
      INFINITARY_GOOGLE_URL: google.base,
    },
  });
  if (!setup) throw new Error("a run that names a client has a Google setup");
  const secrets = new FileIntegrationSecrets(join(paths.integrationsDir, "secrets"));
  let integrations: IntegrationsService | undefined;
  integrations = new IntegrationsService({
    bindings: [
      googleIntegration({
        root: paths.integrationsDir,
        secrets,
        ...setup,
        open: async (url) => {
          await (await fetch(url)).text();
        },
        now: () => clock.now,
        changed: () => integrations?.changed(),
      }),
    ],
    store: new IntegrationSettingsStore(paths.integrationsDir),
    secrets,
    reads,
    now: () => clock.now,
  });
  const service = integrations;
  cleanup.push(() => service.dispose());
  await service.signIn("google", NOTICE_ACCEPTED);
  // Content retention starts after the captain has allowed these reads.
  allowIntegrationReads(service);

  const store = new ScheduleStore(db);
  const inbox = new InboxStore(db);
  const scheduler = new Scheduler({
    store,
    inbox,
    notify: (wake, origin) => inbox.enqueue(FIRSTMATE_RECIPIENT, wake, undefined, origin),
    broadcastEvent: () => {},
    now: () => clock.now,
    events: {
      find: (integration, event) => service.listenable(integration, event),
      look: (integration, event, cursor, filter) =>
        service.look(integration, event, cursor, filter),
    },
  });

  // The live conversations' owners, as the supervisor and the first mate answer.
  const busy = new Set<string>();
  const released: string[] = [];
  const saved = new SavedOutsideData({
    paths,
    reads,
    task: (id) => tasks.get(id),
    tasks: () => tasks.list(),
    kept: () => service.kept(),
    legacy: () => service.legacyCalls(),
    claudeConfigDir: () => claudeConfigDir,
    firstmateClaudeSessions: () => [],
    conversations: {
      busy: (reader) => busy.has(reader),
      release: async (reader) => {
        if (busy.has(reader)) return false;
        released.push(reader);
        return true;
      },
      held: () => false,
    },
    // No computer runs work for this Mac.
    placed: async () => "gone",
    runs: { rewrite: (scrub) => store.rewriteRuns(scrub) },
    inbox: { rewrite: (scrub) => inbox.rewritePending(scrub) },
    now: () => clock.now,
    log: () => {},
  });

  /** A message Lena sent, read by a crewmate through its integrations command. */
  const crewReads = async (taskId: string) => {
    const id = google.deliver(LENA);
    return (await service.forTask(taskId).call("Google", "read_message", { id })).text;
  };

  /** A Pi session line pair: the shell call and its result. */
  const piTurn = (callId: string, result: string) =>
    [
      JSON.stringify({
        type: "message",
        id: `${callId}-a`,
        parentId: "5c8c86e7",
        timestamp: new Date(clock.now).toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: "bash",
              arguments: { command: "infinitary-integrations-axi call Google read_message" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: `${callId}-r`,
        parentId: `${callId}-a`,
        timestamp: new Date(clock.now).toISOString(),
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "bash",
          content: [{ type: "text", text: `exit 0\n${result}` }],
          isError: false,
        },
      }),
    ].join("\n");

  const piFile = join(
    crewmateSessionsDir(paths, "task-1"),
    "2026-09-20T16-05-00-000Z_01a09ddd.jsonl",
  );
  tasks.setSessionFile("task-1", piFile);
  const append = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    let before = "";
    try {
      before = readFileSync(file, "utf8");
    } catch {}
    writeFileSync(file, `${before}${text}\n`);
  };

  return {
    google,
    paths,
    claudeConfigDir,
    claudeWork,
    tasks,
    clock,
    reads,
    service,
    scheduler,
    store,
    inbox,
    busy,
    released,
    saved,
    crewReads,
    piTurn,
    piFile,
    append,
  };
}

describe("words from outside in saved conversations", () => {
  it("replace a crewmate's Gmail answer 30 days after it was read, and keep one read since", async () => {
    const w = await world();
    const first = await w.crewReads("task-1");
    w.append(w.piFile, w.piTurn("call-1", first));
    w.clock.now += 20 * DAY;
    const second = await w.crewReads("task-1");
    w.append(w.piFile, w.piTurn("call-2", second));
    const unchanged = readFileSync(w.piFile, "utf8");

    // Day 29: nothing is due yet, and nothing is read or written.
    w.clock.now += 9 * DAY;
    await w.saved.sweep();
    expect(readFileSync(w.piFile, "utf8")).toBe(unchanged);
    expect(w.released).toEqual([]);

    // Past day 30 of the first read, its answer goes; the second stays.
    w.clock.now += 1 * DAY + 2 * 60 * 60 * 1000;
    await w.saved.sweep();
    const lines = readFileSync(w.piFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(unchanged.split("\n")[0]);
    expect(JSON.parse(lines[1] ?? "").message.content).toEqual([
      { type: "text", text: `exit 0\n${NOTE}` },
    ]);
    expect(lines.slice(2)).toEqual(unchanged.trimEnd().split("\n").slice(2));
    expect(lines[3]).toContain("Payment is due by Nov 4");
    expect(w.released).toEqual(["task-1"]);

    // The ledger names who read when, never what: the second read is still to come.
    const ledger = readFileSync(join(w.paths.integrationsDir, "outside-reads.json"), "utf8");
    expect(ledger).not.toContain("Lena");
    expect(w.reads.due(w.clock.now + 30 * DAY)).toEqual(["task-1"]);
  });

  it("wait for a crewmate still working, and clean its conversation once it pauses", async () => {
    const w = await world();
    w.append(w.piFile, w.piTurn("call-1", await w.crewReads("task-1")));
    w.clock.now += 31 * DAY;
    w.busy.add("task-1");
    await w.saved.sweep();
    expect(readFileSync(w.piFile, "utf8")).toContain("Payment is due by Nov 4");
    expect(w.released).toEqual([]);

    w.busy.delete("task-1");
    w.clock.now += 60_000;
    await w.saved.sweep();
    expect(readFileSync(w.piFile, "utf8")).not.toContain("Payment is due by Nov 4");
    expect(w.released).toEqual(["task-1"]);
  });

  it("go now on the captain's delete, from every conversation and rule run, Claude's own files and the app's copy alike", async () => {
    const w = await world();
    // A crewmate on Pi read Lena's message today, and one read before the fence existed.
    w.append(w.piFile, w.piTurn("call-1", await w.crewReads("task-1")));
    const id = w.google.deliver(LENA);
    w.append(w.piFile, w.piTurn("call-0", JSON.stringify({ id, subject: LENA.subject })));

    // A crewmate on Claude read it; the client spilled the long output beside its transcript.
    const answer = await w.crewReads("task-2");
    const transcript = join(
      w.claudeConfigDir,
      "projects",
      encodeClaudeProjectDir(w.claudeWork),
      `${SESSION}.jsonl`,
    );
    const spilled = join(dirname(transcript), SESSION, "tool-results", "toolu_01.txt");
    w.append(spilled, answer);
    w.append(
      transcript,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: "toolu_01",
              type: "tool_result",
              content: `Output too large. Preview:\n${answer.slice(0, 600)}`,
              is_error: false,
            },
          ],
        },
        uuid: "20a0d61d-9631-49d0-aff2-69f6f2579bd7",
        timestamp: new Date(w.clock.now).toISOString(),
        sessionId: SESSION,
      }),
    );
    const copies = new SessionRecordStore(crewmateSessionsDir(w.paths, "task-2"));
    expect(copies.mirror(SESSION, transcript)).toMatchObject({ kind: "copied" });

    // A rule told the first mate of a new message.
    const rule = createScheduleTools({
      create: (spec, prompt, extra) =>
        w.scheduler.create(spec, prompt, true, extra.name, undefined, { draft: extra.draft }),
      cancel: async () => true,
    }).find((tool) => tool.name === "schedule_prompt");
    await rule?.run({ on_event: "google/message_received", prompt: "Tell me: {{events}}" });
    const tick = async () => {
      w.clock.now += 60_000;
      w.scheduler.tick(w.clock.now);
      await w.scheduler.settled();
    };
    await tick();
    w.google.deliver(LENA);
    await tick();
    const [saved] = w.store.list();
    if (!saved) throw new Error("No saved rule");
    const [run] = w.scheduler.history(saved.id);
    expect(run?.events?.[0]?.summary).toContain(LENA.subject);
    const [delivered] = w.inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(delivered && renderWake(delivered)).toContain(LENA.subject);

    // The first mate read it too, through its own tool.
    const seat = (await w.service.call({ kind: "firstmate" }, "Google", "read_message", { id }))
      .text;
    const firstmateFile = join(w.paths.firstmateSessionsDir, "2026-09-20T16-09-00-000Z_9c1d.jsonl");
    w.append(firstmateFile, w.piTurn("call-7", seat));

    expect(await w.saved.deleteNow()).toEqual({ conversations: 3, waiting: 0 });

    for (const file of [w.piFile, transcript, spilled, firstmateFile]) {
      const text = readFileSync(file, "utf8");
      expect(text).toContain(NOTE);
      expect(text).not.toContain(LENA.subject);
    }
    // The app's copy was cleaned the same way, so it still extends the client's file.
    const copy = readFileSync(copies.transcriptPath(SESSION), "utf8");
    expect(copy).toBe(readFileSync(transcript, "utf8"));
    expect(copies.mirror(SESSION, transcript)).toMatchObject({ kind: "copied" });
    // The rule's run keeps its event, by id, with a note for its words.
    const [after] = w.scheduler.history(saved.id);
    expect(after?.events?.[0]).toMatchObject({ id: run?.events?.[0]?.id });
    expect(after?.events?.[0]?.summary).toBe(NOTE);
    expect(after?.prompt).not.toContain(LENA.subject);
    expect(w.store.carried(saved.id)).toEqual(new Set([run?.events?.[0]?.id]));
    // Its message, still waiting for the first mate's next turn, carries the note too.
    const [waiting] = w.inbox.allFor(FIRSTMATE_RECIPIENT);
    if (!waiting) throw new Error("The rule's delivery is not waiting");
    expect(renderWake(waiting)).toContain(NOTE);
    expect(renderWake(waiting)).not.toContain(LENA.subject);
    expect(w.reads.due(w.clock.now)).toEqual([]);
  });

  it("follow a delete into a conversation that was working when the captain asked", async () => {
    const w = await world();
    const seat = await w.service.call({ kind: "firstmate" }, "Google", "read_message", {
      id: w.google.deliver(LENA),
    });
    const firstmateFile = join(w.paths.firstmateSessionsDir, "2026-09-20T16-09-00-000Z_9c1d.jsonl");
    w.append(firstmateFile, w.piTurn("call-7", seat.text));
    w.busy.add(FIRSTMATE_READER);
    w.clock.now += 60_000;

    expect(await w.saved.deleteNow()).toEqual({ conversations: 0, waiting: 1 });
    expect(readFileSync(firstmateFile, "utf8")).toContain(LENA.subject);

    // The turn ends; the next minute's sweep cleans it, though the words are a day old.
    w.busy.delete(FIRSTMATE_READER);
    w.clock.now += 60_000;
    await w.saved.sweep();
    expect(readFileSync(firstmateFile, "utf8")).not.toContain(LENA.subject);
    expect(readFileSync(firstmateFile, "utf8")).toContain(NOTE);
  });
});
