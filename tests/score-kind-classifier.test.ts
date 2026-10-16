import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundaryCorpus, readSpawnCorpus, score } from "../scripts/score-kind-classifier.ts";
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
    expect([...labels.values()].filter((row) => row.kind === "retrieval")).toHaveLength(13);
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
