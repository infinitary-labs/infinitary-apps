import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deliverableOf,
  readBoundaryCorpus,
  readSpawnCorpus,
  score,
} from "../scripts/score-kind-classifier.ts";
import { KINDS_BY_DELIVERABLE } from "../src/shared/routingPolicy";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The kind classifier's corpus is every spawn_crewmate a recorded Firstmate
 * session made. Since contract v4.12 (primitives P7) a spawn's work-shape
 * facts and waits ride its `shape` and `start_after` groups; the words the
 * classifier reads - title, goal, user_words, constraints - stay flat, so a
 * grouped spawn enters the corpus exactly as a flat one does.
 */

function spawnEntry(args: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "spawn_crewmate", arguments: args }],
    },
  });
}

describe("the kind classifier's spawn corpus", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a grouped spawn exactly as a flat one", () => {
    dir = scratchDir("infinitary-kind-corpus-");
    const words = {
      goal: "The meter test is really fixed",
      constraints: [{ kind: "tests-required" }],
    };
    const flatDir = join(dir, "flat-real", "firstmate", "sessions");
    const groupedDir = join(dir, "grouped-real", "firstmate", "sessions");
    mkdirSync(flatDir, { recursive: true });
    mkdirSync(groupedDir, { recursive: true });
    writeFileSync(
      join(flatDir, "s.jsonl"),
      spawnEntry({
        title: "Fix the meter",
        user_words: "fix the meter test, flat",
        ...words,
        escalate_from: "FM3K-1",
        after_task: "FM3K-2",
      }),
    );
    writeFileSync(
      join(groupedDir, "s.jsonl"),
      spawnEntry({
        title: "Fix the meter",
        user_words: "fix the meter test, grouped",
        ...words,
        shape: { escalate_from: "FM3K-1" },
        start_after: { after_task: "FM3K-2" },
      }),
    );

    const corpus = readSpawnCorpus(dir);
    expect(corpus.map((spawn) => [spawn.fixture, spawn.userWords])).toEqual([
      ["flat-real", "fix the meter test, flat"],
      ["grouped-real", "fix the meter test, grouped"],
    ]);
    for (const spawn of corpus) {
      expect(spawn.goal).toBe(words.goal);
      expect(spawn.constraints).toBe("tests-required");
    }
  });

  it("reads a Claude-served session's spawns beside a Pi session's (W1 S11)", () => {
    dir = scratchDir("infinitary-kind-corpus-");
    // The recorded Claude-served session, as a real export would carry it.
    cpSync(
      join(__dirname, "fixtures", "replay", "sep26-claude", "firstmate", "claude"),
      join(dir, "claude-real", "firstmate", "claude"),
      { recursive: true },
    );
    const piDir = join(dir, "pi-real", "firstmate", "sessions");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "s.jsonl"),
      spawnEntry({
        title: "Fix the meter",
        goal: "The meter test is really fixed",
        user_words: "fix the meter test",
      }),
    );

    const corpus = readSpawnCorpus(dir);
    expect(corpus.map((spawn) => [spawn.fixture, spawn.title, spawn.userWords])).toEqual([
      [
        "claude-real",
        "Fix the flaky sign-in test",
        "Can you fix the flaky sign-in test? It fails about one run in five.",
      ],
      [
        "claude-real",
        "Fix the settings page typo",
        "Also have someone fix the typo on the settings page.",
      ],
      ["pi-real", "Fix the meter", "fix the meter test"],
    ]);
  });
});

describe("the explicit retrieval boundary corpus", () => {
  it("keeps task excerpts and synthetic contrasts distinguishable, with word-bound labels", () => {
    const { spawns, labels } = readBoundaryCorpus(
      join(__dirname, "fixtures/kind-classifier/retrieval-boundary.jsonl"),
    );
    expect(spawns).toHaveLength(27);
    expect(spawns.filter((row) => row.provenance?.kind === "task-excerpt")).toHaveLength(4);
    expect(spawns.filter((row) => row.provenance?.kind === "synthetic")).toHaveLength(23);
    expect(labels.size).toBe(spawns.length);
    // INF-1430 moved two explanations read from what is here to retrieval.
    expect([...labels.values()].filter((row) => row.kind === "retrieval")).toHaveLength(15);
  });

  it("scores an investigation sent low as under-routing, not successful retrieval", () => {
    const result = score([
      {
        key: "mixed",
        fixture: "synthetic",
        title: "Look up and diagnose",
        goal: "Read and explain a failure",
        userWords: "why did this fail",
        label: "research",
        labelTier: "high",
        kind: "retrieval",
        source: "classifier:test",
        tier: "low",
        rule: "R10",
      },
    ]);
    expect(result).toMatchObject({
      agreement: 0,
      tier_agreement: 0,
      under_routed: 1,
      over_routed: 0,
    });
  });
});

// INF-1430 piece 1: the 155 delegated answers INF-1383 labelled, scored for
// the fast lane's bar (at most 5 deep routed low, at least 30 quick).
describe("the quick and deep answers corpus", () => {
  const { spawns, labels } = readBoundaryCorpus(
    join(__dirname, "fixtures/kind-classifier/answer-lanes.jsonl"),
  );

  it("holds every labelled answer, each an answer offered only the answer branch", () => {
    expect(spawns).toHaveLength(155);
    expect(spawns.filter((row) => row.lane === "quick")).toHaveLength(44);
    expect(spawns.filter((row) => row.lane === "deep")).toHaveLength(111);
    for (const spawn of spawns) {
      expect(deliverableOf(spawn.constraints)).toBe("answer");
      expect(KINDS_BY_DELIVERABLE.answer).toContain(labels.get(spawn.key)?.kind);
    }
    // A deep answer is never retrieval; a quick one is unless it needed the web.
    const retrieval = spawns.filter((row) => labels.get(row.key)?.kind === "retrieval");
    expect(retrieval.every((row) => row.lane === "quick")).toBe(true);
    expect(retrieval).toHaveLength(43);
  });

  it("tallies each lane's tiers, the numbers the bar reads", () => {
    const row = (lane: "quick" | "deep", tier: string) => ({
      key: `${lane}-${tier}`,
      fixture: "f",
      title: "t",
      goal: "g",
      userWords: "w",
      lane,
      kind: tier === "low" ? "retrieval" : "research",
      source: "classifier:test",
      tier,
      rule: tier === "low" ? "R10" : "R2",
    });
    expect(score([row("quick", "low"), row("quick", "high"), row("deep", "low")]).lanes).toEqual({
      quick: { low: 1, high: 1 },
      deep: { low: 1 },
    });
  });
});
