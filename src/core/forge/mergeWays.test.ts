import { keepsCommits, type MergeWays, mergeWayFor } from "@shared/batches";
import { describe, expect, it } from "vitest";
import type { ForgeRuleset } from "./forge";
import { waysUnderRules } from "./mergeWays";

// Intent: the captain's approved plan for batches of their own, piece 1: "the merge-way
// choice from host facts". A batch keeps one commit for each change, so the merges a
// project allows are read from its settings and its default branch's rules, never assumed.

/** GitHub's default for a new project: every merge button on. */
const EVERY_WAY: MergeWays = { squash: true, rebase: true, merge: true };

/** A rule set as GitHub answers it for the default branch, with this sign-in unable to skip it. */
const ruleSet = (fields: Partial<ForgeRuleset>): ForgeRuleset => ({
  id: 4410,
  name: "Protect main",
  bypass: "never",
  rules: [],
  ...fields,
});

describe("the merges a project allows under its default branch's rules", () => {
  it("leaves the project's own settings as they are where no rule narrows them", () => {
    expect(waysUnderRules(EVERY_WAY, [])).toEqual(EVERY_WAY);
    expect(
      waysUnderRules(EVERY_WAY, [ruleSet({ rules: ["deletion", "non_fast_forward"] })]),
    ).toEqual(EVERY_WAY);
  });

  it("allows only the methods a rule set lists", () => {
    const ways = waysUnderRules(EVERY_WAY, [
      ruleSet({ rules: ["pull_request"], mergeMethods: ["squash", "rebase"] }),
    ]);
    expect(ways).toEqual({ squash: true, rebase: true, merge: false });
    expect(mergeWayFor(ways, 3)).toBe("rebase");
  });

  it("refuses a merge commit under a linear history, so a batch of several merges by rebase", () => {
    const ways = waysUnderRules(EVERY_WAY, [ruleSet({ rules: ["required_linear_history"] })]);
    expect(ways).toEqual({ squash: true, rebase: true, merge: false });
    expect(mergeWayFor(ways, 2)).toBe("rebase");
  });

  it("never allows what the project's own settings turn off, whatever a rule lists", () => {
    const squashOnly: MergeWays = { squash: true, rebase: false, merge: false };
    const ways = waysUnderRules(squashOnly, [
      ruleSet({ rules: ["pull_request"], mergeMethods: ["squash", "rebase", "merge"] }),
    ]);
    expect(ways).toEqual(squashOnly);
    expect(keepsCommits(ways)).toBe(false);
  });

  it("counts every rule set that holds the branch: what one allows another may refuse", () => {
    const ways = waysUnderRules(EVERY_WAY, [
      ruleSet({ rules: ["pull_request"], mergeMethods: ["rebase", "merge"] }),
      ruleSet({ id: 4411, name: "Linear history", rules: ["required_linear_history"] }),
    ]);
    expect(ways).toEqual({ squash: false, rebase: true, merge: false });
    // A batch of one has no squash to take here, so it merges by rebase as well.
    expect(mergeWayFor(ways, 1)).toBe("rebase");
  });

  it("leaves no way for a batch of several where the rules allow a squash alone", () => {
    const ways = waysUnderRules(EVERY_WAY, [
      ruleSet({ rules: ["pull_request"], mergeMethods: ["squash"] }),
    ]);
    expect(keepsCommits(ways)).toBe(false);
    expect(mergeWayFor(ways, 2)).toBeUndefined();
  });
});
