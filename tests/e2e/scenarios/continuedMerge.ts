import type { ScriptedArgs } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

export const CONTINUED_MERGE_MARKER = "continue the earlier pull request";
export const CONTINUED_MERGE_TITLE = "Merge the continued work";
export const CONTINUED_PULL = 436;

/** INF-1246: the model declares a behavior-preserving repair, never a second merge approval. */
export function continuedMerge(
  repair: NonNullable<ScriptedArgs<"check_change">["conflictRepair"]>,
  repaired: () => void,
): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (isFirstmate || !wantsStream) return undefined;
      const { results } = sinceLastUser(body);
      if (
        latestUserTail.includes("your merge card's merge of") &&
        latestUserTail.includes("Nothing was merged")
      ) {
        if (!results.length) {
          repaired();
          return { calls: [{ name: "check_change", args: { conflictRepair: repair } }] };
        }
        return { text: "The unchanged repair is declared and its checks passed." };
      }
      if (latestUserTail.includes("The task stays open"))
        return { text: "The continued work merged; this task remains open." };
      if (!latestUserTail.includes(CONTINUED_MERGE_MARKER)) return undefined;
      if (!results.length)
        return { calls: [{ name: "check_change", args: { pull: CONTINUED_PULL } }] };
      const review = results[0]?.match(/Merge review (mr[0-9a-f]+)/)?.[1];
      if (results.length === 1 && review)
        return {
          calls: [
            {
              name: "emit_card",
              args: {
                id: "continued-merge",
                title: CONTINUED_MERGE_TITLE,
                body: "<p>The crewmate continued an earlier task’s pull request.</p><p>Merge the reviewed work and keep this task open.</p>",
                // INF-2744: the merge alone; the app writes Not now beside it.
                actions: [{ id: "merge", effect: { kind: "merge", review, after: "continue" } }],
              },
            },
          ],
        };
      return { text: "The continued pull request is ready for the captain." };
    };
}
