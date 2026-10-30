import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pngImage } from "../../../tests/helpers/images";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { attachmentPath, keepImages } from "../attachments";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { queryTasks, taskResolutionBody } from "./taskQuery";
import { TaskService } from "./taskService";

/**
 * The `tasks` query's by-key fetch (crew-posture rationalization Task B):
 * an answer task's deliverable is its CARD, so a builder that names it as
 * basis - or any agent that wants to read it again - fetches that one row
 * and gets the report and the card with it. A list stays the compact index
 * it has always been and carries neither in bulk.
 */
function setup() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, repos: { get: () => undefined }, now: () => 1_000 });
  const cards = new CardStore(db);
  const bodies = new Map<string, string>();
  const query = (input: Parameters<typeof queryTasks>[1]) =>
    queryTasks(
      tasks,
      input,
      () => undefined,
      (taskId) => bodies.get(taskId),
      (taskId) => cards.resolvedSince(0, 1, () => true, taskId)[0],
    );
  return { tasks, bodies, cards, query };
}

describe("the tasks query's text", () => {
  it("finds a title or goal with a curly apostrophe or quote from the plain one typed (FI3-930)", () => {
    const { tasks, query } = setup();
    tasks.create({
      id: "note",
      kind: "question",
      title: "What’s new in 0.1.28",
      prompt: "p",
      repoId: null,
    });
    tasks.create({
      id: "goal",
      title: "Other",
      goal: "Rename the “Later” group",
      prompt: "p",
      repoId: null,
    });
    const ids = (text: string) => query({ text }).rows.map((row) => row.task_id);
    expect(ids("What's new")).toEqual(["note"]);
    expect(ids('"later"')).toEqual(["goal"]);
    expect(ids("What’s new")).toEqual(["note"]);
  });
});

describe("the tasks query's backlog read", () => {
  // INF-1712: the context lists only started work, so a follow-up waiting
  // on request is placed by where it was found through this read.
  it("names an unstarted follow-up's origin and that it starts on request", () => {
    const { tasks, query } = setup();
    const origin = tasks.create({
      id: "origin",
      title: "Steady the meter",
      prompt: "p",
      repoId: null,
    });
    tasks.fileFollowup({
      id: "found",
      originId: origin.id,
      title: "Fix the gauge",
      goal: "The gauge reads true.",
      why: "It drifted while the meter was steadied.",
      prompt: "p",
    });
    const [row] = query({ text: "Fix the gauge", status: "open" }).rows;
    expect(row).toMatchObject({
      task_id: "found",
      discovered_from: [origin.key || origin.id],
      start_policy: "on-request",
    });
  });
});

describe("the tasks query's named choices", () => {
  it("reads back the reasoning effort the captain named for a task, and nothing once it is cleared (FI3-1812)", () => {
    const { tasks, query } = setup();
    tasks.create({ id: "effort", title: "Trim the log", prompt: "p", repoId: null });
    tasks.updateFields("effort", { reasoning: "xhigh" }, "firstmate");
    expect(query({ key: "effort" }).rows[0]).toMatchObject({ reasoning: "xhigh" });
    tasks.updateFields("effort", { reasoning: null }, "firstmate");
    expect(query({ key: "effort" }).rows[0]).not.toHaveProperty("reasoning");
  });
});

describe("the tasks query by key (Task B)", () => {
  it("carries the report, its summary and the newest card body", () => {
    const { tasks, bodies, query } = setup();
    const record = tasks.create({
      id: "t1",
      title: "Why the meter is idle",
      prompt: "p",
      repoId: null,
    });
    tasks.recordReport(record.id, { text: "The claim query filters on repo_id." });
    bodies.set(record.id, "<p>The claim query filters on repo_id.</p>");

    const [row] = query({ key: record.key || record.id }).rows;
    expect(row).toMatchObject({
      task_id: "t1",
      outcome: "The claim query filters on repo_id.",
      outcome_summary: "The claim query filters on repo_id.",
      card: "<p>The claim query filters on repo_id.</p>",
    });
  });

  it("lists the captain's pictures that came with the task, by name and the app's copy", () => {
    const { tasks, query } = setup();
    const record = tasks.create({ id: "pic", title: "Fix the dialog", prompt: "p", repoId: null });
    const [kept] = keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]);
    tasks.openAsk({ id: "m1", text: "fix this", attachments: kept ? [kept] : [] });
    tasks.attachAsk("m1", record.id, "tool:create_task");
    const [row] = query({ key: record.key }).rows;
    expect(row?.pictures).toEqual([{ name: "dialog.png", path: kept ? attachmentPath(kept) : "" }]);
    expect(query({}).rows[0]?.pictures).toBeUndefined();
  });

  it("retrieves full historical reports after a short closure and timeline compaction", () => {
    const { tasks, query } = setup();
    const source = tasks.create({
      id: "history",
      title: "Specification",
      prompt: "p",
      repoId: null,
    });
    const full = `Stable external pager. ${"Complete clause. ".repeat(1200)}Reduced motion.`;
    tasks.recordReport(source.id, { text: full });
    tasks.recordReport(source.id, { text: "Finished." });
    const answers = [{ name: "orientation", values: ["compact"], changed: true }];
    tasks.recordCardResolved(source.id, {
      cardId: "welcome",
      title: "Welcome",
      action: "Build compact",
      answers,
    });
    for (let i = 0; i < 550; i++) tasks.noteProgress(source.id, `Checkpoint ${i}`);
    const row = query({ key: source.key }).rows[0];
    expect(row?.reports?.map((entry) => entry.text)).toEqual([full, "Finished."]);
    expect(row?.outcome).toBe("Finished.");
    expect(row?.decisions?.[0]?.data).toMatchObject({ answers, action: "Build compact" });
    expect(query({}).rows[0]?.reports).toBeUndefined();
  });

  it("carries none of it in a list: the index stays compact", () => {
    const { tasks, bodies, query } = setup();
    const record = tasks.create({
      id: "t1",
      title: "Why the meter is idle",
      prompt: "p",
      repoId: null,
    });
    tasks.recordReport(record.id, { text: "The claim query filters on repo_id." });
    bodies.set(record.id, "<p>Found it.</p>");

    const [row] = query({ text: "meter" }).rows;
    expect(row?.task_id).toBe("t1");
    expect(row?.outcome).toBeUndefined();
    expect(row?.outcome_summary).toBeUndefined();
    expect(row?.card).toBeUndefined();
  });

  it("recovers welcome's submitted answers without mistaking unresolved prose for missing consent", () => {
    const { tasks, cards, query } = setup();
    const plan = tasks.create({
      id: "welcome",
      title: "Plan immediate welcome",
      prompt: "p",
      repoId: null,
    });
    tasks.recordReport(plan.id, { text: "Two choices unresolved: copy and race." });
    cards.upsert({
      id: "card-welcome",
      taskId: plan.id,
      author: "crewmate",
      priority: 1,
      title: "Immediate welcome",
      meta: "",
      body: "Agreement records design only, not implementation.",
      actions: [{ id: "agree", label: "Agree to this plan", default: true }],
      status: "ready",
      createdAt: 1000,
    });
    const answers = [
      { name: "copy", values: ["orientation"], changed: true },
      { name: "race", values: ["skip"], changed: true },
    ];
    cards.resolve("card-welcome", "agree", answers);
    const resolution = query({ key: plan.key }).rows[0]?.resolution;
    expect(resolution).toMatchObject({
      action: "agree",
      answers,
      card: { body: "Agreement records design only, not implementation." },
    });
    expect(query({ key: plan.key }).rows[0]?.outcome).toContain("unresolved");
    expect(query({ text: "welcome" }).rows[0]).not.toHaveProperty("resolution");
    // Lookup exposes facts; it cannot grant authorization or start anything.
    expect(tasks.get(plan.id)?.status).toBe("open");
    expect(tasks.list()).toHaveLength(1);
  });

  it("does not reuse prior answers on a later closing offer with no answers", () => {
    const { tasks, cards, query } = setup();
    const plan = tasks.create({ id: "plan", title: "Plan task cards", prompt: "p", repoId: null });
    const card = {
      id: "card-plan",
      taskId: plan.id,
      author: "crewmate" as const,
      priority: 1,
      title: "Task cards",
      meta: "",
      body: "One record by default",
      actions: [{ id: "agree", label: "Agree plan" }],
      status: "ready" as const,
      createdAt: 1000,
    };
    cards.upsert(card);
    cards.resolve(card.id, "agree", [{ name: "q2_count", values: ["many"], changed: true }]);
    expect(query({ key: plan.key }).rows[0]?.resolution?.answers).toEqual([
      { name: "q2_count", values: ["many"], changed: true },
    ]);
    cards.reopen(card.id);
    cards.resolve(card.id, "close");
    expect(query({ key: plan.key }).rows[0]?.resolution).toMatchObject({ action: "close" });
    expect(query({ key: plan.key }).rows[0]?.resolution).not.toHaveProperty("answers");
  });
});

// INF-439: the by-key view must not repeat the offer body with the submitted answers.
// Retained INF-91/INF-64 contents exercise matching, later and absent newest-card readings.
it.each(["matching", "later", "absent"] as const)(
  "shows closing bodies only where distinct, without changing the stored resolution (%s)",
  (state) => {
    const saved = JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8"))[0];
    const later = JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf64.json", "utf8")).body;
    const db = openInMemoryDatabase();
    try {
      const tasks = new TaskService({ db });
      const task = tasks.create({
        id: "plan",
        title: saved.title,
        prompt: saved.brief,
        repoId: null,
      });
      const resolution = structuredClone(saved.resolution);
      const newestBody = state === "matching" ? saved.card : state === "later" ? later : undefined;
      const [row] = queryTasks(
        tasks,
        { key: task.key },
        () => undefined,
        () => newestBody,
        () => resolution,
      ).rows;
      expect(row?.card).toBe(newestBody);
      expect(row?.resolution?.answers).toEqual(saved.resolution.answers);
      expect(row?.resolution?.action).toBe(saved.resolution.action);
      for (const part of ["card", "offer"] as const) {
        expect(taskResolutionBody(row!, part)).toBe(saved.resolution[part].body);
        if (state === "matching") expect(row?.resolution?.[part]).not.toHaveProperty("body");
        else expect(row?.resolution?.[part]?.body).toBe(saved.resolution[part].body);
      }
      expect(resolution).toEqual(saved.resolution);
    } finally {
      db.close();
    }
  },
);

describe("the tasks query's work built on a task (INF-976)", () => {
  // INF-976's incident: INF-926 built INF-797's answer and merged PR #364,
  // and INF-971 was filed again on the same basis because no read of
  // INF-797 named the closed work standing on it.
  it("names every task built on an answer by key or id, merged and dropped work included, and leaves reviews and lists out", () => {
    const { tasks, query } = setup();
    tasks.create({
      id: "answer",
      kind: "question",
      title: "Why it sat idle",
      prompt: "p",
      repoId: null,
    });
    tasks.recordReport("answer", { text: "Use the same task facts everywhere." });
    const answerKey = tasks.get("answer")?.key ?? "";
    tasks.create({
      id: "builder",
      title: "Build the plan",
      prompt: "p",
      repoId: null,
      shape: { kind: "implement", basis: answerKey },
    });
    seedDelivery(
      tasks,
      "builder",
      { prNumber: 364, changeLabel: "#364", prUrl: "https://github.com/o/r/pull/364" },
      { kind: "pr_opened", text: "PR #364" },
    );
    tasks.close("builder", { status: "done", reason: "merged", actor: "captain", text: "merged" });
    // A second filing names the basis by id, lower-cased key aside: the same task.
    tasks.create({
      id: "again",
      title: "Build the plan again",
      prompt: "p",
      repoId: null,
      shape: { kind: "implement", basis: "answer" },
    });
    tasks.close("again", { status: "dropped", reason: "cancelled", actor: "firstmate" });
    tasks.create({
      id: "review",
      title: "Review: Build the plan",
      prompt: "p",
      repoId: null,
      parentId: "answer",
      shape: { kind: "review", kind_source: "host:review", basis: "answer" },
    });
    tasks.create({ id: "other", title: "Unrelated", prompt: "p", repoId: null });

    const [row] = query({ key: answerKey.toLowerCase() }).rows;
    expect(row?.built_on_by).toEqual([
      {
        key: tasks.get("builder")?.key,
        task_id: "builder",
        title: "Build the plan",
        status: "done",
        closed_reason: "merged",
        change: { label: "#364", url: "https://github.com/o/r/pull/364" },
      },
      {
        key: tasks.get("again")?.key,
        task_id: "again",
        title: "Build the plan again",
        status: "dropped",
        closed_reason: "cancelled",
      },
    ]);
    // The list stays the compact index.
    expect(query({}).rows.find((entry) => entry.task_id === "answer")?.built_on_by).toBeUndefined();
    expect(query({ key: "other" }).rows[0]?.built_on_by).toBeUndefined();
  });
});
