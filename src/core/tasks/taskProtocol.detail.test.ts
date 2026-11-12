import { readFileSync } from "node:fs";
import {
  DROPPED_BEFORE_START_ACTIVITY,
  dropReviewKeys,
  NO_LONGER_WANTED,
} from "@shared/recordDrop";
import { BOARD_RECENT_MS, taskBoardSchema, taskDetailSchema } from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { DecisionStore } from "../storage/decisionStore";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { recentFeed, SETTLE_FOLD } from "./taskFeed";
import { TIMELINE_CAP } from "./timelineCompaction";

/**
 * The task protocol (task-system P3, design section 9): a record's detail,
 * search and the feed.
 */

describe("the task protocol (task-system P3)", () => {
  it("folds what the crewmate did into the record's Activity at each read, writing nothing to the task", () => {
    const did: import("@shared/tasks").TaskActionLine[] = [];
    const f = taskProtocolFixture({ actions: () => did });
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    f.tick();
    f.tasks.noteProgress("t", "Reading the log.");
    const before = f.tasks.timeline("t").length;
    did.push(
      { at: f.clock(), text: "Read the failing journey's log" },
      { at: f.clock() + 5, text: "Run the journey alone" },
    );
    const detail = taskDetailSchema.parse(f.protocol.detail("t"));
    expect(
      detail.activityLog.map((row) => [row.text, row.actions?.map((line) => line.text)]),
    ).toEqual([
      [expect.any(String), undefined],
      ["Reading the log.", ["Read the failing journey's log", "Run the journey alone"]],
    ]);
    expect(f.tasks.timeline("t")).toHaveLength(before);
    f.protocol.dispose();
    f.db.close();
  });

  it("reads the newest plan a progress note carried, each item since it first read its state (FI3-734)", () => {
    const f = taskProtocolFixture();
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    expect(f.protocol.detail("t").plan).toBeNull();
    const item = (label: string, state: "done" | "current" | "next" | "skipped") => ({
      label,
      short: label.slice(0, 6),
      state,
    });
    f.tick();
    f.tasks.noteProgress("t", "Briefed", "crewmate", [
      item("Reproduce", "current"),
      item("Fix", "next"),
    ]);
    const first = f.tasks.timeline("t").at(-1)?.at ?? 0;
    f.tick();
    f.tasks.noteProgress("t", "Halfway");
    f.tick();
    f.tasks.noteProgress("t", "Reproduced", "crewmate", [
      item("Reproduce", "done"),
      item("Fix", "current"),
    ]);
    const second = f.tasks.timeline("t").at(-1)?.at ?? 0;
    f.tick();
    // Folded: one item stands for the two before it, since the note that folded them.
    f.tasks.noteProgress("t", "Folded", "crewmate", [
      item("Reproduce", "done"),
      item("Fix", "current"),
      item("Ship", "next"),
    ]);
    const third = f.tasks.timeline("t").at(-1)?.at ?? 0;
    const detail = f.protocol.detail("t");
    expect(detail.plan).toEqual({
      at: third,
      items: [
        { ...item("Reproduce", "done"), since: second },
        { ...item("Fix", "current"), since: second },
        { ...item("Ship", "next"), since: third },
      ],
    });
    expect(first).toBeLessThan(second);
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    f.protocol.dispose();
    f.db.close();
  });

  it("keeps the newest plan when compaction folds the note that carried it (INF-866 K2)", () => {
    const f = taskProtocolFixture();
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    const plan = [
      { label: "Find", short: "Find", state: "done" as const },
      { label: "Check", short: "Check", state: "current" as const },
    ];
    f.tick();
    f.tasks.noteProgress("t", "Phase: check", "host", plan);
    const at = f.tasks.timeline("t").at(-1)?.at ?? 0;
    // A long run of plain lines follows, enough that the plan's own note folds.
    for (let index = 0; index < TIMELINE_CAP; index += 1) {
      f.tick();
      f.tasks.noteProgress("t", `checked file ${index}`);
    }
    const timeline = f.tasks.timeline("t");
    expect(timeline.some((event) => event.text === "Phase: check")).toBe(false);
    expect(f.protocol.detail("t").plan).toEqual({
      at,
      items: plan.map((item) => ({ ...item, since: at })),
    });
    f.protocol.dispose();
    f.db.close();
  });

  it("carries why a crewmate runs on its model in the record's detail, never on the board", () => {
    const { db, tasks, protocol } = taskProtocolFixture();
    const model = { provider: "openai-codex", id: "gpt-5.5" };
    const plan = seedTask(tasks, {
      id: "plan",
      title: "The plan",
      status: "completed",
      outcome: "Planned.",
    });
    seedTask(tasks, {
      id: "build",
      title: "Build it",
      status: "idle",
      model,
      shape: { kind: "implement", basis: "plan", basis_verified: true },
    });
    seedTask(tasks, { id: "unrouted", title: "Never routed", status: "idle", model });
    new DecisionStore(db).recordRouting({
      taskId: "build",
      ...model,
      model: model.id,
      bucket: "medium",
      rule: "R4",
      served: "medium",
      reasons: ["rule R4: implement on the verified basis plan -> medium"],
    });
    const detail = protocol.detail("build");
    expect(detail.modelReason).toEqual({
      rule: "R4",
      asked: "medium",
      served: "medium",
      basis: plan.key,
    });
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    expect(protocol.detail("unrouted")).not.toHaveProperty("modelReason");
    expect(protocol.board().tasks.find((task) => task.id === "build")).not.toHaveProperty(
      "modelReason",
    );
  });

  it("carries the reasoning a crewmate's session opened at while it is still on that model", () => {
    const { tasks, protocol } = taskProtocolFixture();
    const model = { provider: "anthropic-claude", id: "claude-opus-5-5" };
    seedTask(tasks, {
      id: "quick",
      title: "A Quick change",
      status: "idle",
      model,
      reasoning: { level: "high", lower: "quick" },
    });
    seedTask(tasks, {
      id: "unsaid",
      title: "Opened before it was recorded",
      status: "idle",
      model,
    });
    const detail = protocol.detail("quick");
    expect(detail.reasoning).toEqual({ level: "high", lower: "quick" });
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    expect(protocol.detail("unsaid")).not.toHaveProperty("reasoning");
    expect(protocol.board().tasks.find((task) => task.id === "quick")).not.toHaveProperty(
      "reasoning",
    );
    // Dispatched again on another model that says nothing: the old reasoning
    // was about the old model, so the record no longer claims one.
    tasks.starts.dispatch("quick", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
      model: { provider: "openai-codex", id: "gpt-6-sol" },
    });
    expect(protocol.detail("quick")).not.toHaveProperty("reasoning");
    // A newer dispatch that says what it opened at is read instead.
    tasks.starts.dispatch("quick", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
      model: { provider: "openai-codex", id: "gpt-6-sol" },
      reasoning: { level: "medium", lower: "capped" },
    });
    expect(protocol.detail("quick").reasoning).toEqual({ level: "medium", lower: "capped" });
  });

  it("finds closed work beyond the board's window, and dropped work, only for typed text", async () => {
    const { tasks, protocol, tick } = taskProtocolFixture();
    tasks.create({ id: "old-done", title: "Reconcile idle answers", prompt: "p", repoId: null });
    tasks.create({
      id: "old-goal",
      title: "Other",
      goal: "tidy the zebra",
      prompt: "p",
      repoId: null,
    });
    tasks.create({ id: "dropped", title: "Stalled zebra follow-up", prompt: "p", repoId: null });
    tasks.create({ id: "live", title: "Live zebra", prompt: "p", repoId: null });
    tasks.close("old-done", { status: "done", reason: "settled", actor: "host" });
    tasks.close("old-goal", { status: "done", reason: "settled", actor: "host" });
    tick(BOARD_RECENT_MS + 1);
    tasks.create({ id: "recent", title: "Recent zebra", prompt: "p", repoId: null });
    tasks.close("recent", { status: "done", reason: "settled", actor: "host" });
    tasks.close("dropped", { status: "dropped", reason: "superseded", actor: "host" });
    const ids = async (text: string) => (await protocol.search(text)).map((task) => task.id);
    // Nothing earlier until text is typed.
    expect(await protocol.search("")).toEqual([]);
    expect(await protocol.search("   ")).toEqual([]);
    // Eight-day-old work by title, and dropped work of any age, never live or
    // recently done work (the board lists those).
    expect(await ids("idle")).toEqual(["old-done"]);
    expect((await ids("ZEBRA")).sort()).toEqual(["dropped", "old-goal"]);
    // Key and goal match too.
    const key = (await protocol.search("idle"))[0]?.key ?? "";
    expect(await ids(key.toLowerCase())).toEqual(["old-done"]);
    expect(await ids("nothing like this")).toEqual([]);
    // The result is the board's own row shape, so the panel paints it as any row.
    expect((await protocol.search("idle"))[0]).toMatchObject({
      status: "done",
      title: "Reconcile idle answers",
    });
  });

  it("answers at most 50 earlier matches, newest first, the limit the panel contract names", async () => {
    const { tasks, protocol, tick } = taskProtocolFixture();
    for (let i = 0; i < 55; i += 1) {
      tasks.create({ id: `old-${i}`, title: `Older zebra ${i}`, prompt: "p", repoId: null });
      tasks.close(`old-${i}`, { status: "done", reason: "settled", actor: "host" });
      tick(1);
    }
    tick(BOARD_RECENT_MS + 1);
    const found = await protocol.search("zebra");
    // `PanelTaskSearch` says an answer of 50 may have been cut; the task board asks for narrower words then.
    expect(found).toHaveLength(50);
    expect(found[0]?.id).toBe("old-54");
  });

  it("finds a title with a curly apostrophe or quote from the plain one typed (FI3-930)", async () => {
    const { tasks, protocol } = taskProtocolFixture();
    const titles = {
      note: "What’s new in 0.1.28",
      quoted: "Rename the “Later” group",
      plain: "Don't rename it",
    };
    for (const [id, title] of Object.entries(titles)) {
      tasks.create({ id, kind: "question", title, prompt: "p", repoId: null });
      tasks.close(id, { status: "done", reason: "answered", actor: "host" });
    }
    const ids = async (text: string) => (await protocol.search(text)).map((task) => task.id);
    expect(await ids("what's new")).toEqual(["note"]);
    expect(await ids("What’s new")).toEqual(["note"]);
    expect(await ids('"later"')).toEqual(["quoted"]);
    expect(await ids("don’t")).toEqual(["plain"]);
  });

  it("finds a question answered within the board's window, which the panel never lists", async () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "q", kind: "question", title: "Gauge", prompt: "p", repoId: null });
    tasks.close("q", { status: "done", reason: "answered", actor: "host" });
    tasks.create({ id: "w", title: "Gauge work", prompt: "p", repoId: null });
    tasks.close("w", { status: "done", reason: "settled", actor: "host" });
    const key = protocol.board().tasks.find((task) => task.id === "q")?.key ?? "";
    expect((await protocol.search(key)).map((task) => task.id)).toEqual(["q"]);
    // Recently done work stays the board's: the panel lists it as landed.
    expect((await protocol.search("gauge")).map((task) => task.id)).toEqual(["q"]);
  });

  it("serves a detail with intent, brief, outcome, timeline and asks that parses on the wire", () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({
      id: "a",
      title: "A",
      prompt: "the brief",
      repoId: "r1",
      intent: { goal: "Ship", userWords: "ship it", constraints: [{ kind: "minimal-diff" }] },
    });
    tasks.capture.openAsk({ id: "turn-1", text: "ship it", images: [{ mimeType: "image/png" }] });
    tasks.capture.attachAsk("turn-1", "a", "tool:spawn_crewmate");
    tasks.capture.closeAsk("turn-1", "closed");
    tasks.turns.recordReport("a", { text: "Shipped." });
    const detail = protocol.detail("a");
    expect(taskDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      key: "NIA-1",
      intent: { goal: "Ship", userWords: "ship it" },
      brief: "the brief",
      outcome: "Shipped.",
      outcomeSummary: "Shipped.",
      asks: [
        {
          id: "turn-1",
          text: "ship it",
          images: 1,
          attachedVia: "tool:spawn_crewmate",
          turnState: "closed",
        },
      ],
    });
    expect(detail.events.map((event) => event.kind)).toEqual(["created", "ask", "report"]);
    expect(detail.dropEffects).toEqual({ parts: [], waiting: [], underway: [] });
  });

  // INF-3908 (INF-3896's piece 2): on the captain's record these three made
  // 16.1 MB of a 21.5 MB board, and no view draws them from a row.
  it("sends no change story, live validation or check repair record on a board row or a record's delivery", () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "a", title: "Color the chart", prompt: "p", repoId: "r1" });
    const head = "a".repeat(40);
    // A real check repair record, as an older profile saved it.
    const saved = JSON.parse(
      readFileSync(
        new URL("../../../tests/fixtures/replay/sep30-handoff-agree/tables.json", import.meta.url),
        "utf8",
      ),
    ) as { tasks: { id: string; delivery_json: string | null }[] };
    const ciRepair = JSON.parse(
      saved.tasks.find((row) => row.id === "e8ef69f8")?.delivery_json ?? "{}",
    ).ciRepair;
    const story = {
      revisions: [{ revision: 1, head, base: "main", title: "feat(chart): color the chart" }],
      receipts: [],
      published: { revision: 1, head, state: "confirmed", region: "", regionHash: "", number: 88 },
    };
    seedDelivery(tasks, "a", {
      mode: "direct-pr",
      prNumber: 88,
      changeLabel: "#88",
      headSha: head,
      ci: "green",
      presentation: story as never,
      presentations: [{ ...story, branch: "fm/older" } as never],
      liveValidation: noSurfaceProof(head),
      ciRepair,
    });
    expect(tasks.get("a")?.delivery?.ciRepair?.diagnoses.length).toBeGreaterThan(0);

    const row = taskBoardSchema.parse(protocol.board()).tasks.find((task) => task.id === "a");
    const detail = protocol.detail("a");
    for (const delivery of [row?.delivery, detail.delivery]) {
      expect(delivery).toMatchObject({ prNumber: 88, changeLabel: "#88", ci: "green" });
      for (const field of ["presentation", "presentations", "liveValidation", "ciRepair"])
        expect(delivery).not.toHaveProperty(field);
    }
    // The record still draws its validation, from its own read.
    expect(detail.liveValidation).toMatchObject({ head, revision: 1, verdict: "no-surface" });
  });

  it("keeps a captain drop of unstarted work as a dropped record, not done", () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1", startPolicy: "on-request" });
    const before = protocol.detail("a");
    expect(before.dropEffects).toEqual({ parts: [], waiting: [], underway: [] });
    expect(before.dropEffects && dropReviewKeys(before.dropEffects).parts).toEqual([]);
    tasks.starts.dropUnstarted("a", {
      actor: "captain",
      review: dropReviewKeys(before.dropEffects ?? { parts: [], waiting: [], underway: [] }),
    });
    const detail = protocol.detail("a");
    expect(detail.dropEffects).toBeUndefined();
    expect(detail).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      closing: { note: NO_LONGER_WANTED },
    });
    expect(detail.activityLog.map((row) => row.text)).toContain(DROPPED_BEFORE_START_ACTIVITY);
    expect(taskDetailSchema.parse(detail)).toEqual(detail);
  });

  // INF-3169's plan, piece 3: "the facts on the record" - each delivery fact
  // a close as done recorded, marked checked, as stated or unread, and the
  // captain's word when it asked the close. The facts are the ones the one
  // close as done records for a task with an open pull request and work it saved.
  it("carries a close as done's delivery facts and the captain's word on its closing, and drops a note's repeat of the reason", () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "a", title: "Correct the meter", prompt: "p", repoId: "r1" });
    tasks.close("a", {
      status: "done",
      reason: "finished",
      actor: "captain",
      text: "finished on the captain's word",
      data: {
        why: "word",
        captainWords: "Close as done, pressed on the task's record.",
        onWord: true,
        deliveryFacts: [
          {
            kind: "pull-request",
            basis: "checked",
            text: "Its own pull request #55 is still open",
          },
          {
            kind: "work",
            basis: "checked",
            text: "1 commit not on the main branch and uncommitted edits, saved",
          },
          {
            kind: "evidence",
            basis: "stated",
            text: "Result named by the first mate: The meter reads on time.",
          },
          {
            kind: "pull-request",
            basis: "unread",
            text: "Its own pull request #54 could not be read",
          },
        ],
      },
    });
    const detail = taskDetailSchema.parse(protocol.detail("a"));
    expect(detail.closing).toEqual({
      at: expect.any(Number),
      // The host's words stay whole for a reader that does not read onWord.
      note: "finished on the captain's word",
      onWord: true,
      facts: [
        { basis: "checked", text: "Its own pull request #55 is still open" },
        { basis: "checked", text: "1 commit not on the main branch and uncommitted edits, saved" },
        { basis: "stated", text: "Result named by the first mate: The meter reads on time." },
        { basis: "unread", text: "Its own pull request #54 could not be read" },
      ],
    });

    // A finished close with evidence keeps the evidence, not the reason's word again.
    tasks.create({ id: "b", title: "Sound the shoal", prompt: "p", repoId: "r1" });
    tasks.close("b", {
      status: "done",
      reason: "finished",
      actor: "firstmate",
      text: "finished: The shoal is sounded.",
      data: { why: "finished", deliveryFacts: [] },
    });
    expect(protocol.detail("b").closing).toEqual({
      at: expect.any(Number),
      note: "The shoal is sounded.",
    });
  });

  it("reads the record the way the popup shows it: headline, model name, condensed activity, closing and problem", () => {
    const { db, tasks, protocol, tick } = taskProtocolFixture({
      modelLabel: (model) => (model === "openai/gpt-6-sol" ? "GPT-6 Sol" : undefined),
    });
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tick();
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 21",
      model: { provider: "openai", id: "gpt-6-sol" },
    });
    tick();
    tasks.note("a", "a warm working copy was reused", { news: false });
    tick();
    tasks.noteProgress("a", "Opened the change; waiting on the checks.");
    tick();
    seedDelivery(
      tasks,
      "a",
      { changeLabel: "#422", prNumber: 422, prUrl: "https://github.com/o/r/pull/422" },
      { kind: "pr_opened", text: "PR #422 https://github.com/o/r/pull/422", feed: true },
    );
    for (const ci of ["pending", "pending", "green", "green"] as const) {
      tick();
      seedDelivery(
        tasks,
        "a",
        { ci, ciAt: 1, headSha: "abc123" },
        { kind: "ci", text: `CI ${ci}` },
      );
    }
    tick();
    tasks.noteProgress("a", "The checks passed.");
    tick();
    const report =
      "Intent: fix the popup.\nWhat changed: the popup reads plainly. It shows the model.";
    tasks.turns.recordReport("a", { text: report });
    const detail = taskDetailSchema.parse(protocol.detail("a"));
    expect(detail.modelLabel).toBe("GPT-6 Sol");
    expect(detail.outcomeSummary).toBe("the popup reads plainly.");
    expect(detail.activityLog.map((row) => [row.kind, row.text])).toEqual([
      ["created", expect.any(String)],
      ["dispatched", "crewmate 21 started on GPT-6 Sol."],
      ["progress", "Opened the change; waiting on the checks."],
      ["pr_opened", "Opened pull request #422."],
      ["ci", "The checks are running on pull request #422."],
      ["ci", "The checks passed on pull request #422."],
      ["report", "the popup reads plainly."],
    ]);
    // What is minor folds under the row it led to, so nothing is left out.
    expect(detail.activityLog.map((row) => row.folded?.map((line) => line.text) ?? [])).toEqual([
      [],
      [],
      ["a warm working copy was reused"],
      [],
      [],
      ["The checks are running on pull request #422."],
      ["The checks passed on pull request #422.", "The checks passed."],
    ]);
    // The whole timeline is still there beneath it.
    expect(detail.events.length).toBeGreaterThan(detail.activityLog.length);
    expect(detail.closing).toBeNull();
    expect(detail.problem).toBeNull();

    // A row stored before reports skipped their Intent section reads again.
    db.prepare("UPDATE tasks SET outcome_summary = ? WHERE id = ?").run(
      "Intent: fix the popup.",
      "a",
    );
    expect(protocol.detail("a").outcomeSummary).toBe("the popup reads plainly.");
    // The report's own summary wins over any sentence of it.
    tick();
    tasks.turns.recordReport("a", { text: report, summary: "The popup reads plainly now." });
    expect(protocol.detail("a").outcomeSummary).toBe("The popup reads plainly now.");
    expect(protocol.detail("a").activityLog.at(-1)?.text).toBe("The popup reads plainly now.");

    // A failed turn reads in plain words; the raw error stays on the timeline.
    tick();
    tasks.turns.recordTurnFailure("a", "401 Unauthorized");
    expect(protocol.detail("a").problem).toBe(
      "The provider did not accept your sign-in - sign in again.",
    );

    // A drop carries the words it was dropped with.
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1" });
    tick();
    tasks.dropWithChildren("b", { reason: "Duplicate of NIA-1.", actor: "firstmate" });
    const dropped = protocol.detail("b");
    expect(dropped.closing).toEqual({ at: dropped.closedAt, note: "Duplicate of NIA-1." });
    expect(dropped.activityLog.map((row) => row.kind)).toEqual(["created", "status"]);
    expect(dropped.modelLabel).toBeNull();
  });

  it("shows the basis the same on the detail, the published view and the export, its verdict derived at read", () => {
    const { db, tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "plan", title: "Plan the panel", prompt: "p", repoId: "r1" });
    const planKey = tasks.get("plan")?.key ?? "";
    // Routed with a verdict on the shape, the way a spawn hands it over:
    // this one is stale (the plan has not answered), and it is not kept.
    tasks.create({
      id: "build",
      title: "Build the panel",
      prompt: "b",
      repoId: "r1",
      shape: {
        kind: "implement",
        kind_source: "classifier:test",
        basis: planKey,
        basis_verified: true,
      },
    });
    tasks.create({ id: "free", title: "Unrelated", prompt: "f", repoId: "r1" });
    const shown = (id: string) => ({
      detail: taskDetailSchema.parse(protocol.detail(id)).basis?.ref ?? null,
      view:
        (
          db.prepare("SELECT basis FROM v_tasks_v1 WHERE task_id = ?").get(id) as {
            basis: string | null;
          }
        ).basis ?? null,
      export:
        parseTaskExport(exportTaskRecords(tasks).join("\n")).tasks.find((task) => task.id === id)
          ?.shape?.basis ?? null,
    });
    expect(shown("build")).toEqual({ detail: planKey, view: planKey, export: planKey });
    expect(shown("free")).toEqual({ detail: null, view: null, export: null });
    expect(protocol.detail("build").basis).toEqual({ ref: planKey, verified: false });

    // The plan answers: the verdict follows with no write to the build row.
    const before = tasks.get("build")?.updatedAt;
    tasks.turns.recordReport("plan", { text: "Group the rows into sections." });
    expect(protocol.detail("build").basis).toEqual({ ref: planKey, verified: true });
    expect(tasks.get("build")?.updatedAt).toBe(before);
    expect(protocol.detail("free").basis).toBeNull();
  });

  it("reads the feed as a view: timeline lines merged with task-less lines by time, keyed", () => {
    const { tasks, activity, tick } = taskProtocolFixture();
    activity.record({ kind: "you", text: "Captain: build it" });
    tick();
    tasks.create({ id: "a", title: "Build it", prompt: "p", repoId: "r1" });
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    activity.record({ kind: "info", text: "First mate · remembered: squash merges" });
    tick();
    tasks.turns.recordReport("a", { text: "Built. Tests green." });
    const feed = recentFeed(tasks, activity, 200);
    expect(feed.map((line) => [line.text, line.taskKey ?? null])).toEqual([
      ["Captain: build it", null],
      ["Started", "NIA-1"],
      ["First mate · remembered: squash merges", null],
      ["Reported: Built.", "NIA-1"],
    ]);
    expect(feed.map((line) => line.kind)).toEqual(["you", "info", "info", "info"]);
    // A task line names the timeline event it was authored from; a task-less
    // line names none.
    expect(feed.map((line) => line.event ?? null)).toEqual([null, "dispatched", null, "report"]);
    // The limit cuts the oldest, whichever table they came from.
    expect(recentFeed(tasks, activity, 2).map((line) => line.text)).toEqual([
      "First mate · remembered: squash merges",
      "Reported: Built.",
    ]);
  });

  // INF-1845, the captain's pick: one keyed line, "Merging #709", which becomes "Merged #709 on GitHub" or "Cannot merge: …".
  it("shows one line per settle: the click gives way to its outcome, and the record keeps both", () => {
    const { tasks, activity, tick } = taskProtocolFixture();
    tasks.create({ id: "a", title: "Ship it", prompt: "p", repoId: "r1" });
    const settle = (text: string) => {
      tasks.note("a", text, {
        news: true,
        feed: true,
        data: { feedLine: true, feedOnce: SETTLE_FOLD },
      });
      tick();
    };
    const shown = () =>
      recentFeed(tasks, activity, 200)
        .filter((line) => line.taskKey === tasks.get("a")?.key)
        .map((line) => line.text);
    settle("Merging #709");
    expect(shown()).toEqual(["Merging #709"]);
    settle("Cannot merge: it conflicts with newer work in the project");
    expect(shown()).toEqual(["Cannot merge: it conflicts with newer work in the project"]);
    settle("Merging #709");
    tasks.close("a", {
      status: "done",
      reason: "merged",
      actor: "captain",
      text: "Merged #709 on GitHub. https://github.com/o/r/pull/709",
      data: { line: "Merged #709 on GitHub" },
    });
    expect(shown()).toEqual(["Merged #709 on GitHub"]);
    expect(tasks.timeline("a").filter((event) => event.kind === "note")).toHaveLength(3);
  });

  it("folds only programs into one feed row before the recent limit (INF-1137 friction 8)", () => {
    const { tasks, activity, tick } = taskProtocolFixture();
    tasks.create({ id: "ordinary", title: "Website refresh", prompt: "p", repoId: "r1" });
    tasks.create({
      id: "ordinary-child",
      parentId: "ordinary",
      title: "Review the home page",
      prompt: "p",
      repoId: "r1",
    });
    tasks.turns.recordReport("ordinary", { text: "Layout reviewed." });
    tick();
    tasks.turns.recordReport("ordinary-child", { text: "Home page reviewed." });
    tick();
    tasks.create({
      id: "program",
      title: "Research release questions",
      prompt: "p",
      repoId: "r1",
      shape: { kind: "research", program: { script: "return null;", bound: 29 } },
    });
    for (let i = 0; i < 29; i++) {
      const id = `part-${i}`;
      tasks.create({
        id,
        parentId: "program",
        title: `Research question ${i + 1}`,
        prompt: "p",
        repoId: "r1",
      });
      tasks.turns.recordReport(id, { text: "Research ready." });
      tick();
    }
    const program = tasks.get("program");
    const feed = () => recentFeed(tasks, activity, 3);
    expect(feed().map((line) => line.taskKey)).toEqual([
      tasks.get("ordinary")?.key,
      tasks.get("ordinary-child")?.key,
      program?.key,
    ]);
    expect(feed().at(-1)?.text).toBe("0/29 parts done · Research release questions");
    tasks.close("part-0", { status: "done", reason: "finished", actor: "host" });
    tick();
    tasks.close("part-1", { status: "dropped", reason: "cancelled", actor: "host" });
    expect(feed().at(-1)).toMatchObject({
      taskKey: program?.key,
      kind: "warn",
      text: "1/29 parts done · 1 stopped · Research release questions",
    });
    expect(tasks.get("part-0")?.status).toBe("done");
  });
});
