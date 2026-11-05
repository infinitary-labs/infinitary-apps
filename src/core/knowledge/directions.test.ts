import { openInMemoryDatabase } from "@core/storage/db";
import { describe, expect, it } from "vitest";
import type { KnowledgeActor } from "./access";
import { KnowledgeService } from "./knowledgeService";

/**
 * Standing directions as the knowledge owner keeps them (docs/knowledge.md,
 * "Carrying the active directions" and "The browser"): only the older
 * record's active preferences cross, once, and a quit between the two
 * databases retries the same rows without a second history line; a
 * conflicting destination stops startup and removes nothing. The browser
 * pages the current set, the captain's instructions first, and reads one
 * direction only where its project still exists and the reader may see it.
 */

const HARBOR = { id: "repo-harbor", name: "harbor", path: "/projects/harbor" };
const DOCK = { id: "repo-dock", name: "dock", path: "/projects/dock" };

type Note = {
  id: string;
  kind: string;
  scope: string;
  origin: string;
  text: string;
  status: string;
  at: number;
};

/** The notes a stopped profile still holds: three active preferences and two that never cross. */
const NOTES: Note[] = [
  {
    id: "keep-harbor-green",
    kind: "preference",
    scope: HARBOR.id,
    origin: "captain-turn",
    text: "Keep harbor's main check green before any release.",
    status: "active",
    at: 300,
  },
  {
    id: "suggest-small-prs",
    kind: "preference",
    scope: HARBOR.id,
    origin: "agent",
    text: "Prefer small pull requests in harbor.",
    status: "active",
    at: 400,
  },
  {
    id: "mornings",
    kind: "preference",
    scope: "captain",
    origin: "captain-turn",
    text: "Plan reviews for the morning.",
    status: "active",
    at: 200,
  },
  {
    id: "old-rule",
    kind: "preference",
    scope: "captain",
    origin: "captain-turn",
    text: "A rule the captain retired.",
    status: "retired",
    at: 50,
  },
  {
    id: "a-fact",
    kind: "fact",
    scope: "captain",
    origin: "captain-turn",
    text: "The captain works on a Mac.",
    status: "active",
    at: 60,
  },
];

function notesDatabase(notes: readonly Note[]) {
  const db = openInMemoryDatabase();
  for (const note of notes) {
    db.prepare(`INSERT INTO memories (id, kind, scope, origin, content, status, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      note.id,
      note.kind,
      note.scope,
      note.origin,
      note.text,
      note.status,
      note.at,
      note.at + 1,
    );
  }
  return db;
}

const notesTables = (db: ReturnType<typeof openInMemoryDatabase>) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('memories', 'memory_revisions') ORDER BY name",
    )
    .all();

function fixture() {
  const projects = [HARBOR, DOCK];
  let clock = 1_792_000_000_000;
  const knowledge = new KnowledgeService({
    projects: {
      get: (id) => projects.find((project) => project.id === id),
      list: () => projects,
    },
    now: () => (clock += 1000),
  });
  const removeProject = (id: string) => {
    projects.splice(
      projects.findIndex((project) => project.id === id),
      1,
    );
  };
  return { knowledge, removeProject };
}

const FIRSTMATE: KnowledgeActor = { kind: "firstmate", origin: "agent", canCreate: false };
const crewOn = (repoId: string): KnowledgeActor => ({ kind: "crewmate", taskId: "t1", repoId });

describe("carrying the older record's directions", () => {
  it("carries each active preference once, and a retry after a quit adds no second history line", () => {
    const { knowledge } = fixture();
    const first = notesDatabase(NOTES);
    knowledge.directions.carry(first);
    expect(notesTables(first)).toEqual([]);
    const carried = () =>
      knowledge.directions
        .standing(FIRSTMATE)
        .map(({ id, scope, origin, revision, updatedAt }) => ({
          id,
          scope,
          origin,
          revision,
          updatedAt,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const once = carried();
    expect(once).toEqual([
      {
        id: "keep-harbor-green",
        scope: HARBOR.id,
        origin: "captain-turn",
        revision: 1,
        updatedAt: 301,
      },
      { id: "mornings", scope: "captain", origin: "captain-turn", revision: 1, updatedAt: 201 },
      { id: "suggest-small-prs", scope: HARBOR.id, origin: "agent", revision: 1, updatedAt: 401 },
    ]);
    // The app quit after the knowledge write and before the old tables went.
    const retried = notesDatabase(NOTES);
    knowledge.directions.carry(retried);
    expect(notesTables(retried)).toEqual([]);
    expect(carried()).toEqual(once);
    const read = knowledge.directions.read({ id: "mornings" });
    expect(read.state === "ready" && read.direction.history).toEqual([
      {
        revision: 1,
        text: "Plan reviews for the morning.",
        origin: "captain-turn",
        scope: "captain",
        op: "publish",
        evidence: "Carried from the active direction at notes retirement.",
        at: 201,
      },
    ]);
  });

  it("stops at a conflicting direction and removes nothing on either side", () => {
    const { knowledge } = fixture();
    knowledge.directions.carry(notesDatabase(NOTES));
    const before = knowledge.directions.standing(FIRSTMATE);
    const conflicting = notesDatabase(
      NOTES.map((note) =>
        note.id === "mornings" ? { ...note, text: "Plan reviews for the evening." } : note,
      ),
    );
    expect(() => knowledge.directions.carry(conflicting)).toThrow(
      "A standing direction conflicts with Knowledge. No original direction was removed.",
    );
    expect(notesTables(conflicting)).toEqual([{ name: "memories" }, { name: "memory_revisions" }]);
    expect(knowledge.directions.standing(FIRSTMATE)).toEqual(before);
  });

  it("leaves a record with no notes tables alone", () => {
    const { knowledge } = fixture();
    const db = notesDatabase([]);
    knowledge.directions.carry(db);
    expect(notesTables(db)).toEqual([]);
    knowledge.directions.carry(db);
    expect(knowledge.directions.standing(FIRSTMATE)).toEqual([]);
  });
});

describe("the browser's directions", () => {
  it("pages the captain's instructions first, newest first, narrowed by scope and words", () => {
    const { knowledge } = fixture();
    knowledge.directions.carry(notesDatabase(NOTES));
    knowledge.directions.change({
      op: "add",
      id: "dock-tests",
      scope: DOCK.id,
      text: "Run dock's journeys before every merge.",
      reason: "The captain asked.",
    });
    const ids = (args: Parameters<KnowledgeService["directions"]["page"]>[0]) => {
      const page = knowledge.directions.page(args);
      if (page.state !== "ready") throw new Error(page.state);
      return { scope: page.scope, total: page.total, ids: page.rows.map((row) => row.id) };
    };
    expect(ids({ scope: "all" })).toEqual({
      scope: "all",
      total: 4,
      ids: ["dock-tests", "keep-harbor-green", "mornings", "suggest-small-prs"],
    });
    expect(ids({ scope: HARBOR.id })).toEqual({
      scope: HARBOR.id,
      total: 2,
      ids: ["keep-harbor-green", "suggest-small-prs"],
    });
    expect(ids({ scope: "captain" })).toEqual({ scope: "captain", total: 1, ids: ["mornings"] });
    expect(ids({ scope: "all", query: "  KEEP " })).toEqual({
      scope: "all",
      total: 1,
      ids: ["keep-harbor-green"],
    });
    const harbor = knowledge.directions.page({ scope: HARBOR.id });
    expect(
      harbor.state === "ready" && harbor.rows.map((row) => [row.scopeName, row.authority]),
    ).toEqual([
      ["harbor", "instruction"],
      ["harbor", "advice"],
    ]);
    const captain = knowledge.directions.page({ scope: "captain" });
    expect(captain.state === "ready" && captain.rows[0]?.scopeName).toBe(
      "Everywhere, first mate only",
    );
    const counted = knowledge.window.collections();
    expect(
      counted.state === "ready" &&
        counted.collections.map(({ scope, directions }) => [scope, directions]),
    ).toEqual([
      ["captain", 1],
      [DOCK.id, 1],
      [HARBOR.id, 2],
    ]);
    expect(() => knowledge.directions.page({ scope: "repo-gone" })).toThrow(
      "This project is not available.",
    );
  });

  it("reads one direction only where its project remains and the reader may see it", () => {
    const { knowledge, removeProject } = fixture();
    knowledge.directions.carry(notesDatabase(NOTES));
    expect(knowledge.directions.read({ id: "keep-harbor-green" }, crewOn(HARBOR.id)).state).toBe(
      "ready",
    );
    expect(knowledge.directions.read({ id: "keep-harbor-green" }, crewOn(DOCK.id))).toEqual({
      state: "missing",
    });
    expect(knowledge.directions.read({ id: "mornings" }, crewOn(HARBOR.id))).toEqual({
      state: "missing",
    });
    expect(knowledge.directions.read({ id: "nothing" })).toEqual({ state: "missing" });
    removeProject(HARBOR.id);
    expect(knowledge.directions.read({ id: "keep-harbor-green" })).toEqual({ state: "missing" });
    const all = knowledge.directions.page({ scope: "all" });
    expect(all.state === "ready" && all.rows.map((row) => row.id)).toEqual(["mornings"]);
    expect(knowledge.directions.standing(crewOn(HARBOR.id))).toEqual([]);
  });
});
