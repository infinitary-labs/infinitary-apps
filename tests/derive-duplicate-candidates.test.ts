import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CardStore } from "@core/storage/cardStore";
import { openDatabase } from "@core/storage/db";
import type { Card } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveDuplicateCandidates,
  deriveFromTables,
  main,
  parseArgs,
} from "../scripts/derive-duplicate-candidates.ts";
import { emptyTables, readRecordedTables } from "../scripts/recorded-tables.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * WI-20: weak duplicate-card candidates from the tables alone. Proven on the
 * independently authored mixed-fleet recording (one matching pair) and on a database built with the app's own migrations and
 * card store, so the schema under test is the real one. It never writes:
 * not the stamp, not anything.
 */

const MIN = 60_000;
const MIXED_FLEET = fileURLToPath(
  new URL("./fixtures/replay/fleet-mixed/tables.json", import.meta.url),
);

function row(id: string, taskId: string | null, title: string, createdAt: number, extra = {}) {
  return {
    id,
    task_id: taskId,
    kind: "note",
    title,
    body: `<p>${title}</p>`,
    created_at: createdAt,
    resolved_at: null,
    chosen_action: null,
    ...extra,
  };
}

describe("duplicate candidates from the mixed fleet replay", () => {
  it("yields the one known repeat pair, weak and unconfirmed, and no plan-vs-settle pair", () => {
    const candidates = deriveFromTables(readRecordedTables(MIXED_FLEET));
    // The same-title pressure notes arrived 57 seconds apart.
    // The plan and settle decision never pair even though they share a title.
    expect(
      candidates.map((candidate) => [
        candidate.task_id,
        candidate.first.card_id,
        candidate.second.card_id,
      ]),
    ).toEqual([["8c200003", "card-greenhouse-repeat-1", "card-fm-greenhouse-repeat"]]);
    const [pair] = candidates;
    expect(pair?.first.title).toBe("North manifold pressure is stable");
    expect(pair?.similarity).toBe(1);
    expect(pair?.label).toEqual({
      kind: "duplicate_card",
      weak: true,
      confirmed: false,
      confidence: "unconfirmed",
    });
    expect(pair?.captain_stamped).toBe(false);
    expect(pair?.first.author).toBe("other");
    expect(pair?.second.author).toBe("firstmate");
  });
});

describe("the derivation", () => {
  it("pairs only same-task cards inside the window above the threshold", () => {
    const tables = emptyTables();
    tables.cards = [
      row("a", "t1", "Delivered keeps its worktree", 0),
      row("b", "t1", "Delivered keeps its worktree", 10 * MIN),
      row("c", "t2", "Delivered keeps its worktree", 11 * MIN),
      row("d", "t1", "Delivered keeps its worktree", 3 * 60 * MIN),
      row("e", null, "Delivered keeps its worktree", 12 * MIN),
      row("f", "t1", "Quota meter leaks a timer", 13 * MIN),
    ];
    expect(deriveFromTables(tables).map((candidate) => candidate.id)).toEqual(["pair:a|b"]);
    expect(deriveFromTables(tables, { windowMs: 5 * MIN })).toEqual([]);
  });

  it("never pairs a card that offers a settle verb, and still pairs the cards around it", () => {
    const decision = (actions: { id: string }[]) => ({
      kind: "decision",
      actions_json: JSON.stringify(actions.map((action) => ({ ...action, label: action.id }))),
    });
    const tables = emptyTables();
    tables.cards = [
      row("plan", "t1", "Ship the quota meter fix", 0, decision([{ id: "approve" }])),
      row("settle", "t1", "Ship the quota meter fix", 21 * MIN, decision([{ id: "merge-pr" }])),
      row("again", "t1", "Ship the quota meter fix", 22 * MIN),
    ];
    for (const verb of ["land", "keep", "discard"]) {
      tables.cards.push(
        row(`plan-${verb}`, `t-${verb}`, "Land the flaky test fix", 0, decision([{ id: "go" }])),
        row(
          `settle-${verb}`,
          `t-${verb}`,
          "Land the flaky test fix",
          MIN,
          decision([{ id: verb }]),
        ),
      );
    }
    expect(deriveFromTables(tables).map((candidate) => candidate.id)).toEqual(["pair:plan|again"]);
  });

  it("observes a captain stamp without treating the pair as confirmed", () => {
    const tables = emptyTables();
    tables.cards = [
      row("a", "t1", "Delivered keeps its worktree", 0),
      row("b", "t1", "Delivered keeps its worktree", MIN, { duplicate_of: "a" }),
    ];
    const [candidate] = deriveFromTables(tables);
    expect(candidate?.captain_stamped).toBe(true);
    expect(candidate?.label.confirmed).toBe(false);
  });
});

describe("reading a real database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = scratchDir("infinitary-dupes-");
    dbPath = join(dir, "firstmate.db");
    const db = openDatabase(dir);
    const cards = new CardStore(db);
    const card = (id: string, title: string, createdAt: number): Card => ({
      id,
      taskId: "t1",
      author: "crewmate",
      priority: 30,
      title,
      meta: "crewmate 1",
      body: "<p>closeRecord keeps the worktree for delivered rows.</p>",
      actions: [],
      status: "ready",
      createdAt,
    });
    cards.upsert(card("card-t1-1", "Delivered keeps its worktree", 1_000));
    cards.upsert(card("card-fm-1", "Delivered keeps its worktree", 2 * MIN));
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the migrated schema and never writes to it", () => {
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const result = deriveDuplicateCandidates(dbPath);
    expect(result.cardCount).toBe(2);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "pair:card-t1-1|card-fm-1",
    ]);
    expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(before);
  });

  it("writes JSONL from the CLI and exits non-zero on a missing database or a bad argument", () => {
    const out = join(dir, "candidates.jsonl");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(main(["--db", dbPath, "--out", out])).toBe(0);
      expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
      expect(main(["--db", join(dir, "missing.db")])).toBe(1);
      expect(main(["--threshold", "2"])).toBe(2);
      expect(main(["--nope"])).toBe(2);
    } finally {
      stderr.mockRestore();
    }
  });

  it("defaults the database under --user-data", () => {
    expect(parseArgs(["--user-data", dir]).dbPath).toBe(dbPath);
    writeFileSync(join(dir, "tables.json"), "{}");
    expect(parseArgs(["--db", join(dir, "tables.json")]).dbPath).toBe(join(dir, "tables.json"));
  });
});
