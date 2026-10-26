import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { TIMELINE_CONTENT_KINDS, timelineEntrySchema } from "@shared/timeline";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CardService } from "../orchestrator/cardService";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { CrewActions } from "./crewActions";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";
import { EVENT_CONTENT, OBSERVATION_CONTENT, TaskTimeline } from "./taskTimeline";

// INF-1296 piece 1 (plan B, "Approve and build"): one versioned entry
// schema and one read-only reader over a task's events, card evidence and
// threads, and its crewmate's actions - explicit aliases only, a stable
// order and paging, and exact expansion - so moving the records later
// leaves what an existing user's task shows unchanged.

const T0 = Date.parse("2026-10-20T16:00:00.000Z");
const WORKTREE = "/work/rerun-practice";
const SESSION = "2026-10-20T16-00-00-000Z_pi-rerun.jsonl";

const decision = {
  id: "which-fix",
  title: "Which fix should I keep?",
  body: "<p>Two fixes pass the practice release.</p>",
  actions: [
    { id: "flush", label: "Await the queue flush", default: true },
    { id: "retry", label: "Keep the retry" },
  ],
};

function setup(clock: "ticks" | "still" = "ticks") {
  const db = openInMemoryDatabase();
  let at = T0;
  const now = () => {
    if (clock === "ticks") at += 1_000;
    return at;
  };
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const cards = new CardService({
    now,
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    noteCapAnswered: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  const root = scratchDir("infinitary-task-timeline-");
  const sessionsOf = (taskId: string) => join(root, taskId, "sessions");
  const actions = new CrewActions({
    recordDirOf: sessionsOf,
    appTools: new Set(["report", "note_progress", "emit_card"]),
  });
  const timeline = new TaskTimeline({
    tasks,
    cards: cardStore,
    actions: (record) => actions.sourced(record),
  });
  const session = (taskId: string, lines: Record<string, unknown>[]) => {
    mkdirSync(sessionsOf(taskId), { recursive: true });
    writeFileSync(
      join(sessionsOf(taskId), SESSION),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  };
  return { db, tasks, cardStore, cards, timeline, session, clock: () => at };
}

/** A Pi session line for one call; `seconds` undefined writes a line that names no time. */
function piCall(seconds: number | undefined, name: string, args: Record<string, unknown>) {
  return {
    type: "message",
    ...(seconds === undefined ? {} : { timestamp: new Date(T0 + seconds * 1000).toISOString() }),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: `c${seconds ?? "x"}`, name, arguments: args }],
    },
  };
}

/** A task's history as the app writes it, through its own writers. */
function history(world: ReturnType<typeof setup>) {
  const { tasks, cards } = world;
  seedTask(tasks, {
    id: "rerun",
    title: "Rerun the practice release's Mac check",
    intent: { goal: "The practice release passes.", userWords: "rerun the practice release" },
    worktreeDir: WORKTREE,
    status: "idle",
  });
  tasks.recordBrief("rerun", ["Goal: The practice release passes."]);
  tasks.noteProgress("rerun", "The rerun failed on a different journey; reading its log.");
  const id = cards.emitCrewmateCard("rerun", decision, "Rerun", "GPT-6 Sol");
  cards.addMessage(id, "captain", "does the flush cover windows too?");
  cards.addMessage(id, "crewmate", "Yes: the flush runs on every platform.");
  cards.resolve(cards.get(id) as Card, "flush", "flush");
  tasks.recordReport("rerun", {
    text: "The Mac check passes with the queue flush. I kept it and removed the retry.",
    summary: "The Mac check passes with the queue flush.",
    declared: { result: { kept: "flush", runs: 10 } },
  });
  return id;
}

const RANK = ["task-event", "card-observation", "card-message", "session-action"];

describe("the unified task timeline (INF-1296 piece 1)", () => {
  it("maps every event and card observation kind to a content kind the schema knows", () => {
    for (const kind of [...Object.values(EVENT_CONTENT), ...Object.values(OBSERVATION_CONTENT)])
      expect(TIMELINE_CONTENT_KINDS).toContain(kind);
  });

  it("reads every retained entry once, in time order, folding only what an owner named as the same occurrence", () => {
    const world = setup();
    const cardId = history(world);
    world.session("rerun", [
      { type: "session", version: 3, id: "pi-rerun", cwd: WORKTREE },
      piCall(undefined, "read", { path: `${WORKTREE}/release.yml` }),
      piCall(4, "bash", { command: "gh run view 3757 --log-failed" }),
    ]);
    const entries = world.timeline.entries("rerun");
    for (const entry of entries) expect(timelineEntrySchema.parse(entry)).toEqual(entry);

    // Every task event is an entry, but the choice its card evidence holds.
    const events = world.tasks.timeline("rerun");
    const resolved = events.find((event) => event.kind === "card_resolved");
    const choice = world.cardStore
      .observations(cardId)
      .find((observation) => observation.kind === "action");
    const ids = entries.map((entry) => entry.id);
    for (const event of events) {
      if (event === resolved) continue;
      expect(ids).toContain(`task-event:${event.id}`);
    }
    expect(ids).not.toContain(`task-event:${resolved?.id}`);
    const receipt = entries.find((entry) => entry.id === `card-observation:${choice?.id}`);
    expect(receipt).toMatchObject({
      content: { kind: "card-choice" },
      actor: { kind: "captain" },
      summary: '"Which fix should I keep?": Await the queue flush',
      aliases: [`task-event:${resolved?.id}`],
    });

    // Each thread line is one entry, its card evidence reference folded in,
    // under the offer it was written beside.
    const offer = world.cardStore.observations(cardId).find((o) => o.kind === "offer");
    const lines = entries.filter((entry) => entry.content.kind === "card-message");
    expect(lines.map((entry) => [entry.actor?.kind, entry.summary])).toEqual([
      ["captain", "does the flush cover windows too?"],
      ["crewmate", "Yes: the flush runs on every platform."],
    ]);
    for (const line of lines) {
      expect(line.aliases).toHaveLength(1);
      expect(line.links).toEqual([{ rel: "reply", to: `card-observation:${offer?.id}` }]);
    }

    // The report reads as its headline; bookkeeping and evidence stay, quiet.
    expect(entries.find((entry) => entry.content.kind === "report")).toMatchObject({
      summary: "The Mac check passes with the queue flush.",
      quiet: false,
    });
    expect(entries.find((entry) => entry.content.kind === "brief")?.quiet).toBe(true);

    // The action whose line names no time stays undated, ahead of the dated ones.
    const actions = entries.filter((entry) => entry.content.kind === "session-action");
    expect(actions.map((entry) => [entry.at, entry.summary])).toEqual([
      [null, "Read release.yml"],
      [T0 + 4_000, "Ran gh run view 3757 --log-failed"],
    ]);
    expect(entries[0]?.id).toBe(actions[0]?.id);
    const dated = entries.slice(1).map((entry) => entry.at as number);
    expect(dated).toEqual([...dated].sort((a, b) => a - b));
  });

  it("keeps a choice an older release recorded without naming its evidence visible from both owners", () => {
    const world = setup();
    const cardId = history(world);
    // What a release before INF-1296 piece 1 wrote: no alias on the event.
    world.db
      .prepare(
        "UPDATE task_events SET data_json = json_remove(data_json, '$.observation') WHERE kind = 'card_resolved'",
      )
      .run();
    const entries = world.timeline.entries("rerun");
    const resolved = world.tasks.timeline("rerun").find((event) => event.kind === "card_resolved");
    const choice = world.cardStore.observations(cardId).find((o) => o.kind === "action");
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([`task-event:${resolved?.id}`, `card-observation:${choice?.id}`]),
    );
    expect(
      entries.every((entry) => entry.aliases.every((alias) => !alias.startsWith("task-"))),
    ).toBe(true);
  });

  it("pages from the cut its first page took, so work arriving between pages neither shifts nor repeats one", () => {
    const world = setup();
    const cardId = history(world);
    const whole = world.timeline.entries("rerun");
    const first = world.timeline.read("rerun", { limit: 4 });
    expect(first.entries).toEqual(whole.slice(0, 4));
    // Meanwhile: a newer event and a thread line arrive.
    world.tasks.noteProgress("rerun", "Watching the next scheduled run.");
    world.cards.addMessage(cardId, "captain", "thanks");
    const read = [...first.entries];
    let cursor = first.cursor;
    while (cursor) {
      const page = world.timeline.read("rerun", { limit: 4, cursor });
      read.push(...page.entries);
      cursor = page.cursor;
    }
    expect(read).toEqual(whole);
    // A fresh read takes a new cut and holds what arrived.
    expect(world.timeline.entries("rerun").length).toBe(whole.length + 2);
    expect(() => world.timeline.read("rerun", { cursor: "not-a-cursor" })).toThrow(
      "That timeline cursor is not one this reader gave.",
    );
  });

  it("opens an entry's exact record, never a later revision, says so when its owner no longer holds it, and changes nothing", () => {
    const world = setup();
    const cardId = history(world);
    const offerEntry = world.timeline
      .entries("rerun")
      .find((entry) => entry.content.kind === "card-offer");
    // The crewmate revises the card afterwards; the offer it showed is unchanged.
    const revised = world.cards.emitCrewmateCard(
      "rerun",
      { ...decision, body: "<p>Revised after the windows run.</p>" },
      "Rerun",
    );
    expect(revised).toBe(cardId);
    const counts = () =>
      ["task_events", "card_observations", "card_messages", "tasks"].map(
        (table) =>
          (world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    const before = counts();
    const opened = world.timeline.expand("rerun", offerEntry?.id ?? "");
    expect(opened).toMatchObject({
      status: "available",
      record: {
        source: "card-observation",
        observation: { kind: "offer", payload: { body: decision.body } },
      },
    });

    const report = world.timeline.entries("rerun").find((entry) => entry.content.kind === "report");
    expect(world.timeline.expand("rerun", report?.id ?? "")).toMatchObject({
      status: "available",
      record: {
        report: {
          version: 1,
          summary: "The Mac check passes with the queue flush.",
          result: { kept: "flush", runs: 10 },
        },
      },
    });
    const brief = world.timeline.entries("rerun").find((entry) => entry.content.kind === "brief");
    expect(world.timeline.expand("rerun", brief?.id ?? "")).toMatchObject({
      record: { brief: "Goal: The practice release passes." },
    });
    expect(counts()).toEqual(before);

    // Another task's entry is not this one's, and an erased card's evidence is gone.
    seedTask(world.tasks, { id: "other", title: "Another task", status: "idle" });
    expect(world.timeline.expand("other", report?.id ?? "")).toEqual({
      id: report?.id,
      status: "unavailable",
      reason: "unknown",
    });
    world.cardStore.deleteForTask("rerun");
    expect(world.timeline.expand("rerun", offerEntry?.id ?? "")).toEqual({
      id: offerEntry?.id,
      status: "unavailable",
      reason: "gone",
    });
    expect(world.timeline.expand("rerun", "made-up:1").status).toBe("unavailable");
  });

  it("orders entries that share a time by source, then each source's own order, never by their words", () => {
    const world = setup("still");
    history(world);
    const entries = world.timeline.entries("rerun");
    // The card store stamps thread lines with its own clock; the rest share one time.
    const still = entries.filter((entry) => entry.at === T0);
    expect(still.length).toBeGreaterThan(entries.length / 2);
    const sources = still.map((entry) => entry.content.ref.source);
    expect(new Set(sources)).toEqual(new Set(["task-event", "card-observation"]));
    expect(sources).toEqual([...sources].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b)));
    const events = entries.filter((entry) => entry.content.ref.source === "task-event");
    const eventIds = events.map((entry) => Number(entry.id.split(":")[1]));
    expect(eventIds).toEqual([...eventIds].sort((a, b) => a - b));
    expect(
      entries.filter((entry) => entry.content.kind === "card-message").map((e) => e.summary),
    ).toEqual(["does the flush cover windows too?", "Yes: the flush runs on every platform."]);
    // The same read again is the same timeline.
    expect(world.timeline.entries("rerun")).toEqual(entries);
  });

  it("reads another task's event that concerns this one, linked by how that task stands to it", () => {
    const world = setup();
    history(world);
    seedTask(world.tasks, { id: "followup", title: "Flaky meter test", status: "queued" });
    world.tasks.link("followup", "rerun", "discovered-from", "crewmate");
    world.tasks.close("followup", { status: "dropped", reason: "cancelled", actor: "captain" });
    const concerned = world.timeline
      .entries("rerun")
      .filter((entry) => entry.links.some((link) => link.rel === "concern"));
    expect(concerned.length).toBeGreaterThan(0);
    for (const entry of concerned) {
      expect(entry.content.ref).toMatchObject({ source: "task-event", taskId: "followup" });
      expect(world.timeline.expand("rerun", entry.id).status).toBe("available");
    }
  });
});
