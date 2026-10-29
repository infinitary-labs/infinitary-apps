import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { readsKeepingOpen } from "../scripts/contract-client.ts";
import type { TaskBoard, TaskView } from "../src/shared/tasks.ts";

/**
 * INF-1649 review R5, the captain's open-lists "Yes, for what phones and views
 * read": the scripted client is a view too, so it reads a newer home's task
 * kind its file does not list as that list's unknown, against the published
 * file alone, and still reports any other wrong value.
 */
const contract = JSON.parse(readFileSync("docs/contract.json", "utf8"));
const ajv = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
const validate = ajv.compile(contract.pushes["inf:tasks"].payload);
const openLists = contract.versionRule.openLists;

const row = (id: string, kind: string, status = "active") =>
  ({
    id,
    key: `INF-${id}`,
    projectId: "infinitary",
    parentId: null,
    kind,
    title: `Task ${id}`,
    goal: "Deliver the named effect and report its evidence.",
    priority: 2,
    status,
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 7",
    model: "claude-opus-5-5",
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 1_793_000_000_000,
    updatedAt: 1_793_000_100_000,
    startedAt: 1_793_000_050_000,
    closedAt: null,
  }) as unknown as TaskView;

const board = (tasks: TaskView[]): TaskBoard => ({
  seq: 41,
  at: 1_793_000_100_000,
  projects: [
    {
      id: "infinitary",
      key: "INF",
      name: "infinitary",
      repo: null,
      archived: false,
      counts: { needsYou: 0, waitingOnYou: 0, open: 0, active: tasks.length, doneRecent: 0 },
    },
  ],
  tasks,
  links: [],
});

describe("the scripted client reading a newer home's open lists", () => {
  it("reads a task kind its file does not list as its open list's unknown", () => {
    const pushed = board([row("1650", "inquiry"), row("1649", "question")]);
    expect(validate(pushed)).toBe(false);
    expect(readsKeepingOpen(validate, pushed, openLists)).toBe(true);
  });

  it("still reports a value outside any open list", () => {
    expect(readsKeepingOpen(validate, board([row("1650", "work", "paused")]), openLists)).toBe(
      false,
    );
    expect(readsKeepingOpen(validate, board([row("1650", "inquiry", "paused")]), openLists)).toBe(
      false,
    );
  });
});
