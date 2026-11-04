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
    tasks.openAsk({ id, text, at: now });
    now += 1;
    tasks.attachAsk(id, taskId, via, starts);
    tasks.closeAsk(id, "closed");
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
    expect(tasks.originAbout("compare")).toMatchObject({
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
    tasks.link("fix", "again", "replaced-by", "firstmate");
    said("merge", "merge it", "again", "tool:settle_task");
    said("stop", "stop that", "again", "tool:interrupt_crewmate");
    expect(tasks.originAbout("again")).toMatchObject({
      kind: "asked",
      text: expect.stringContaining("merged on its own"),
      through: 4,
    });
  });

  it("says an automation filed the work and keeps its name once the automation is gone", () => {
    // A nightly audit's card had no line at all.
    const { tasks } = setup();
    seedTask(tasks, { id: "audit", title: "Check package versions", status: "idle" });
    tasks.saveOrigin("audit", {
      kind: "automation",
      ruleId: "r-night",
      name: "Nightly product audit",
    });
    // A later origin adds nothing: the first one saved stands.
    expect(tasks.saveOrigin("audit", { kind: "report", taskId: "audit" })).toBe(false);
    expect(tasks.originAbout("audit")).toEqual({
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
    expect(tasks.originAbout("part")).toMatchObject({ kind: "automation", through: 1 });
  });

  it("reads a click the work was filed from, with the button's words and what the captain wrote", () => {
    // INF-2326's own cards: the captain's click on INF-2299's card, with what they wrote.
    const { tasks, said } = setup();
    seedTask(tasks, { id: "file", title: "File card improvements", status: "idle" });
    tasks.saveOrigin("file", {
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
    expect(tasks.originAbout("file")).toMatchObject({
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
    tasks.saveOrigin("slow", { kind: "report", taskId: "alpha" });
    expect(tasks.originAbout("slow")).toMatchObject({
      kind: "asked",
      text: "cut an alpha tonight and tell me what is slow",
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
    expect(tasks.originAbout("slow")).toEqual({
      kind: "from",
      at: alpha?.createdAt,
      key: alpha?.key,
      title: "Cut tonight's alpha and report slow and new failures",
    });
    said("note", "keep the timeout as it is", "slow", "tool:steer_crewmate");
    expect(tasks.originAbout("slow")).toMatchObject({
      kind: "said",
      text: "keep the timeout as it is",
      through: 0,
    });
  });
});
