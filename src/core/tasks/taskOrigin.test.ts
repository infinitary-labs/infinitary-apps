import { describe, expect, it } from "vitest";
import type { AskAttachedVia } from "../storage/askStore";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * The line under a card's title (INF-2326, the captain's words on INF-2299
 * and INF-2326: "Give the You asked line the nearest-starting-message rule,
 * with automations, follow-ups, chain names and recorded clicks" and "when
 * it comes from an automation, it should just say it's ran by an automation
 * and name which one"). Each chain below has the shape of one of the six
 * real cards INF-2299 replayed; the walk reads saved messages and origins
 * through the task graph, nearest first.
 */

function setup() {
  const db = openInMemoryDatabase();
  let now = 1_000;
  const tasks = new TaskService({ db, strict: true, now: () => now });
  const said = (
    id: string,
    text: string,
    taskId: string,
    via: AskAttachedVia,
    starts?: boolean,
  ) => {
    now += 1;
    tasks.capture.openAsk({ id, text, at: now });
    now += 1;
    tasks.capture.attachAsk(id, taskId, via, starts);
    tasks.capture.closeAsk(id, "closed");
  };
  return { tasks, said, tick: () => (now += 1) };
}

describe("where a card's work came from", () => {
  it("skips a part's own later steer and reads the message that started its parent", () => {
    // INF-2229's card quoted a 2:17 PM steer instead of the message that started the work.
    const { tasks, said } = setup();
    seedTask(tasks, { id: "assess", title: "Assess the journey checks", status: "idle" });
    said(
      "start",
      "recently we removed journey checks and phone checks from our PR checks. i want an assessment",
      "assess",
      "tool:spawn_crewmate",
      true,
    );
    seedTask(tasks, {
      id: "compare",
      title: "Compare failures",
      status: "idle",
      parentId: "assess",
    });
    said("steer", "also look at the phone lane", "compare", "tool:steer_crewmate");
    expect(tasks.capture.originAbout("compare")).toMatchObject({
      kind: "asked",
      text: expect.stringContaining("i want an assessment"),
      through: 1,
    });
  });

  it("never quotes a merge or interruption, and names how many tasks the source sits behind", () => {
    // The saved-story card quoted an unrelated merge click; its start sat four tasks away.
    const { tasks, said } = setup();
    seedTask(tasks, { id: "start", title: "Show saved stories", status: "completed" });
    said(
      "why",
      "hmm we already have a 'merged on its own' card but this is not it",
      "start",
      "tool:create_task",
      true,
    );
    seedTask(tasks, {
      id: "plan",
      title: "Plan the story",
      status: "completed",
      parentId: "start",
    });
    const plan = tasks.get("plan");
    seedTask(tasks, {
      id: "build",
      title: "Build the story",
      status: "completed",
      shape: { kind: "implement", basis: plan?.key },
    });
    seedTask(tasks, { id: "fix", title: "Fix the story", status: "completed", parentId: "build" });
    seedTask(tasks, { id: "again", title: "Fix the story again", status: "idle" });
    tasks.graph.link("fix", "again", "replaced-by", "firstmate");
    said("merge", "merge it", "again", "tool:settle_task");
    said("stop", "stop that", "again", "tool:interrupt_crewmate");
    expect(tasks.capture.originAbout("again")).toMatchObject({
      kind: "asked",
      text: expect.stringContaining("merged on its own"),
      through: 4,
    });
  });

  it("says an automation filed the work and keeps its name once the automation is gone", () => {
    // A nightly audit's card had no line at all.
    const { tasks } = setup();
    seedTask(tasks, { id: "audit", title: "Check package versions", status: "idle" });
    tasks.capture.saveOrigin("audit", {
      kind: "automation",
      ruleId: "r-night",
      name: "Nightly product audit",
    });
    // A later origin adds nothing: the first one saved stands.
    expect(tasks.capture.saveOrigin("audit", { kind: "report", taskId: "audit" })).toBe(false);
    expect(tasks.capture.originAbout("audit")).toEqual({
      kind: "automation",
      at: expect.any(Number),
      name: "Nightly product audit",
      through: 0,
    });
    seedTask(tasks, {
      id: "part",
      title: "Read the changelogs",
      status: "idle",
      parentId: "audit",
    });
    expect(tasks.capture.originAbout("part")).toMatchObject({ kind: "automation", through: 1 });
  });

  it("reads a click the work was filed from, with the button's words and what the captain wrote", () => {
    // INF-2326's own cards: the captain's click on INF-2299's card, with what they wrote.
    const { tasks, said } = setup();
    seedTask(tasks, { id: "file", title: "File card improvements", status: "idle" });
    tasks.capture.saveOrigin("file", {
      kind: "chose",
      cardId: "card-plan",
      card: "Plan for clearer cards",
      choice: "File the picked improvements",
      written: "when it comes from an automation, it should just say it's ran by an automation",
    });
    // A message that came later and swept several tasks is never the source.
    seedTask(tasks, { id: "other", title: "Another task", status: "idle" });
    said("sweep", "how are these going?", "file", "tool:steer_crewmate");
    said("sweep2", "and these?", "other", "tool:steer_crewmate");
    expect(tasks.capture.originAbout("file")).toMatchObject({
      kind: "chose",
      choice: "File the picked improvements",
      text: expect.stringContaining("ran by an automation"),
      through: 0,
    });
  });

  it("follows a report the work was filed after to the reporting task's own origin", () => {
    const { tasks, said } = setup();
    seedTask(tasks, { id: "alpha", title: "Cut tonight's alpha", status: "completed" });
    said(
      "cut",
      "cut an alpha tonight and tell me what is slow",
      "alpha",
      "tool:spawn_crewmate",
      true,
    );
    seedTask(tasks, { id: "slow", title: "Fix the slow journey", status: "idle" });
    tasks.capture.saveOrigin("slow", { kind: "report", taskId: "alpha" });
    expect(tasks.capture.originAbout("slow")).toMatchObject({
      kind: "asked",
      text: "cut an alpha tonight and tell me what is slow",
      through: 1,
    });
  });

  it("quotes the words a report passed on, counting back to the task they were typed on", () => {
    // INF-3202 replays INF-3192's line, which read "You asked · 1:57 PM ·
    // through 2 tasks" with INF-3106's first message. The captain had typed
    // message 4280 under INF-3106's plan card at 5:53 PM; its crewmate passed
    // it on, and INF-3188 was filed from that report, INF-3192 after
    // INF-3188's own report.
    const { tasks } = setup();
    const started = 1_794_175_020_000; // 1:57 PM, the day of message 4280
    const typed = 1_794_189_223_422; // message 4280, 5:53 PM
    const first =
      "two pieces of feedback for ios infinitary app. let's plan them in parallel, and don't constrain the solution to exactly what the user asked. understand their pain point and design a thoughtful solution for each: 1) Keyboard trap: replying to a card";
    const relayed =
      "ask first mate to separately investigate and fix this stale picture problem. that was super confusing";
    seedTask(tasks, { id: "inf-3106", title: "Plan the keyboard trap fix", status: "idle" });
    tasks.capture.openAsk({ id: "m-first", text: first, at: started });
    tasks.capture.attachAsk("m-first", "inf-3106", "tool:spawn_crewmate", true);
    tasks.capture.closeAsk("m-first", "closed");
    seedTask(tasks, { id: "inf-3188", title: "Fix stale card pictures", status: "completed" });
    expect(
      tasks.capture.saveOrigin("inf-3188", {
        kind: "report",
        taskId: "inf-3106",
        words: { text: relayed, at: typed },
      }),
    ).toBe(true);
    seedTask(tasks, {
      id: "inf-3192",
      title: "Show the captain when a card's pictures did not change",
      status: "idle",
    });
    tasks.capture.saveOrigin("inf-3192", { kind: "report", taskId: "inf-3188" });
    expect(tasks.capture.originAbout("inf-3192")).toEqual({
      kind: "asked",
      at: typed,
      text: relayed,
      through: 2,
    });
    expect(tasks.capture.originAbout("inf-3188")).toMatchObject({ at: typed, through: 1 });
    // The timeline says the report passed the captain's words on.
    expect(tasks.timeline("inf-3188").at(-1)?.text).toBe(
      `Filed after ${tasks.get("inf-3106")?.key}'s report, which passed on your words`,
    );
    // A report that named no words still leads on to the reporting task's own origin.
    seedTask(tasks, { id: "inf-3187", title: "Plan the stale picture fix", status: "idle" });
    tasks.capture.saveOrigin("inf-3187", { kind: "report", taskId: "inf-3106" });
    expect(tasks.capture.originAbout("inf-3187")).toEqual({
      kind: "asked",
      at: started,
      text: first,
      through: 1,
    });
  });

  it("falls back to a message aimed at this work alone, then to the nearest task it came from", () => {
    // INF-2112's card had no line: its work came from a task nobody asked for in words.
    const { tasks, said } = setup();
    seedTask(tasks, {
      id: "alpha",
      title: "Cut tonight's alpha and report slow and new failures",
      status: "completed",
    });
    seedTask(tasks, {
      id: "slow",
      title: "Fix the slow journey",
      status: "idle",
      parentId: "alpha",
    });
    const alpha = tasks.get("alpha");
    expect(tasks.capture.originAbout("slow")).toEqual({
      kind: "from",
      at: alpha?.createdAt,
      key: alpha?.key,
      title: "Cut tonight's alpha and report slow and new failures",
    });
    said("note", "keep the timeout as it is", "slow", "tool:steer_crewmate");
    expect(tasks.capture.originAbout("slow")).toMatchObject({
      kind: "said",
      text: "keep the timeout as it is",
      through: 0,
    });
  });
});
