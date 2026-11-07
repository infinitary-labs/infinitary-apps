import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Card } from "@shared/cards";
import { describe, expect, it } from "vitest";
import {
  assertIsolatedStateDir,
  captainMove,
  protectedStateDirs,
} from "../scripts/bench/policy.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The headless attempt driver's policy (scripts/bench/): where an attempt may never boot, and what
 * the scripted captain does with a card - read from its typed actions only.
 */

function card(fields: Partial<Card>): Card {
  return {
    id: "c1",
    author: "firstmate",
    priority: 0,
    title: "A card",
    meta: "",
    body: "<p>body</p>",
    actions: [],
    status: "ready",
    createdAt: 1,
    ...fields,
  };
}

describe("the state directory guard", () => {
  const home = "/Users/someone";
  const [release, dev] = protectedStateDirs(home) as [string, string];

  it("refuses the app's own data, anything inside it, and anything holding it", () => {
    for (const target of [release, dev, join(release, "attempt"), join(release, "..")]) {
      expect(() => assertIsolatedStateDir(target, home)).toThrow(/overlaps the app's data/);
    }
  });

  // The Infinitary rename (FI3-1780 step 10): the captain's data lives under
  // Infinitary's folders, and Firstmate 3000's stay on disk as the recovery copy.
  it("refuses the app's folders under both names", () => {
    expect(protectedStateDirs(home).map((dir) => basename(dir))).toEqual([
      "infinitary",
      "infinitary-dev",
      "firstmate-3000",
      "firstmate-3000-dev",
    ]);
    for (const target of protectedStateDirs(home)) {
      expect(() => assertIsolatedStateDir(target, home)).toThrow(/overlaps the app's data/);
    }
  });

  it("refuses a directory that already holds something", () => {
    const used = scratchDir("infinitary-bench-policy-");
    writeFileSync(join(used, "firstmate.db"), "");
    expect(() => assertIsolatedStateDir(used, home)).toThrow(/starts empty/);
  });

  it("accepts a new or empty directory elsewhere", () => {
    const root = scratchDir("infinitary-bench-policy-");
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() => assertIsolatedStateDir(join(root, "new"), home)).not.toThrow();
    expect(() => assertIsolatedStateDir(empty, home)).not.toThrow();
  });
});

describe("the scripted captain", () => {
  it("takes a card offering to land the work as the finish line, never a click", () => {
    const move = captainMove(
      card({
        author: "crewmate",
        actions: [
          { id: "land", label: "Put it in", effect: { kind: "merge", after: "close" } },
          { id: "later", label: "Later" },
        ],
      }),
    );
    expect(move).toEqual({ kind: "ready" });
  });

  it("stops on the host's own attention card", () => {
    const stall = card({
      author: "host",
      actions: [{ id: "go", label: "Carry on", effect: { kind: "host", op: "continue-task" } }],
    });
    expect(captainMove(stall)).toEqual({ kind: "host" });
  });

  it("answers a decision with the step its emitter proposed", () => {
    const plan = card({
      actions: [
        { id: "other", label: "Another way" },
        { id: "go", label: "Go ahead", default: true },
      ],
    });
    expect(captainMove(plan)).toEqual({ kind: "answer", actionId: "go", label: "Go ahead" });
  });

  it("without a proposed step, answers with the first choice that destroys nothing", () => {
    const decision = card({
      actions: [
        { id: "drop", label: "Throw it away", danger: true },
        { id: "settings", label: "Open settings", effect: { kind: "open", target: "settings" } },
        { id: "keep", label: "Keep going" },
      ],
    });
    expect(captainMove(decision)).toEqual({
      kind: "answer",
      actionId: "keep",
      label: "Keep going",
    });
  });

  it("leaves notes, streaming cards and cards off the stage alone", () => {
    const action = { id: "go", label: "Go", default: true };
    expect(captainMove(card({}))).toEqual({ kind: "none" });
    expect(captainMove(card({ status: "streaming", actions: [action] }))).toEqual({ kind: "none" });
    expect(captainMove(card({ awaiting: "answer", actions: [action] }))).toEqual({ kind: "none" });
  });
});
