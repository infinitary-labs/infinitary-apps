import { type MergeWay, type MergeWays, mergeWayFor } from "@shared/batches";
import { type Forge, type ForgeChange, ForgeError, type ForgeRuleset } from "./forge";

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

/**
 * The merge a merge card's click sends for one change (docs/forge.md, "A
 * requested merge"), read from where the project lives right before it goes
 * out: a squash where the project allows one, otherwise a rebase merge, then
 * a merge commit (`mergeWayFor`). Undefined for a host with no merges of its
 * own to read, such as a plain push to the default branch. Throws a refusal,
 * with nothing sent, naming the project's settings when it allows none.
 */
export async function wayToSend(
  forge: Pick<Forge, "mergeWays" | "place" | "label">,
  change: ForgeChange,
): Promise<MergeWay | undefined> {
  if (!forge.mergeWays) return undefined;
  const way = mergeWayFor(await forge.mergeWays(), 1);
  if (way) return way;
  throw new ForgeError(
    "refused",
    `this project's settings${forge.place ? ` on ${forge.place}` : ""} allow none of a squash, a rebase merge or a merge commit, so ${forge.label(change)} was not sent; allow one of them there, then merge again`,
    true,
  );
}
