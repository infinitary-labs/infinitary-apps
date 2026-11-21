import lofi from "../../../src/renderer/src/ambient/own-samples/lofi.json" with { type: "json" };
import { type OwnStyle, ownStyleSchema } from "../../../src/shared/ambientOwn";
import type { Scenario } from "../mockProvider";

/** The person's ask for music of their own, as the approved plan words it. */
export const AMBIENT_OWN_PROMPT = "play lofi beats to code to";
/** Their ask to change it. */
export const AMBIENT_SLOWER_PROMPT = "make it slower";

/** The style the first mate writes for the ask: one the plan's first mate wrote for those words. */
export const LOFI_STYLE: OwnStyle = ownStyleSchema.parse(lofi);
/** The same style, slower. */
export const LOFI_SLOWER: OwnStyle = { ...LOFI_STYLE, bpm: 60 };

/** The first mate saves the person's own style, and saves it again slower, each with one call. */
export const ambientOwn: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || hasToolResults) return undefined;
    for (const [words, style] of [
      [AMBIENT_OWN_PROMPT, LOFI_STYLE],
      [AMBIENT_SLOWER_PROMPT, LOFI_SLOWER],
    ] as const)
      if (latestUserTail.includes(words))
        return {
          calls: [
            {
              name: "app_change",
              args: { action: "ambient-own-style", value: { save: style }, evidence: words },
            },
          ],
        };
    return undefined;
  };
