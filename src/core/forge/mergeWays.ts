import type { MergeWays } from "@shared/batches";
import type { ForgeRuleset } from "./forge";

/**
 * The merges a project allows once its default branch's rules are counted
 * (docs/forge.md, "Batches of your own"): a rule set that lists merge
 * methods allows only those, and a linear history refuses a merge commit.
 * Read from the host's own answers; nothing is assumed allowed.
 */
export function waysUnderRules(allowed: MergeWays, rules: readonly ForgeRuleset[]): MergeWays {
  let ways = { ...allowed };
  for (const set of rules) {
    if (set.mergeMethods) {
      const methods = new Set(set.mergeMethods);
      ways = {
        squash: ways.squash && methods.has("squash"),
        rebase: ways.rebase && methods.has("rebase"),
        merge: ways.merge && methods.has("merge"),
      };
    }
    if (set.rules.includes("required_linear_history")) ways = { ...ways, merge: false };
  }
  return ways;
}
