/**
 * The gate a merge passes while the host holds a merge request of the
 * approved version, and the words of the one direct merge sent in its place
 * (docs/forge.md, "A merge request GitHub holds"). `ChangeMerge` and
 * `MergeReviews` both send through it.
 */

import { englishOf, type Said, said } from "@shared/i18n/said";
import type { Forge, ForgeChange, MergeAnswer } from "../forge";
import type { MergeGuard, PrOutcome } from "./changeMerge";

/** A merge request the host holds for the approved version (`MergeAuthorization.heldMerge`). */
export type MergeHold = {
  /** How long the host has held it. */
  heldMs: number;
  /**
   * Set once the hold passed the bound (`HELD_MERGE_BOUND_MS`) and no direct
   * merge was sent yet: records that one is, before it leaves, so it is
   * never sent a second time.
   */
  dispatch?: () => void;
};

/** What the first mate hears when the merge was the direct one sent in place of a held request. */
export function directlyTold(place: string | null | undefined, heldMs: number): string {
  // i18n-exempt: served to the first mate in the merge answer, stays English
  return ` ${place ?? "The host"} had held the first merge request for ${Math.round(heldMs / 60_000)} minutes without finishing it, so the app merged the pull request directly at the approved version. Tell the captain that once; nothing else is needed.`;
}

/**
 * What the first mate hears when the pull request reads merged after the
 * one direct merge left and was not confirmed: its answer never came, or
 * the host refused it in the words of `refusal`. The read does not say who
 * merged it.
 */
export function afterDirectTold(place: string | null | undefined, refusal?: string): string {
  // i18n-exempt: named in a merge answer served to the first mate, stays English
  const host = place ?? "The host";
  const answered = refusal
    ? // i18n-exempt: served to the first mate in the merge answer, stays English
      `${host} refused it: ${refusal}${/[.!?]$/.test(refusal) ? "" : "."} The pull request reads merged now; whether the held request or someone else merged it is not known.`
    : // i18n-exempt: served to the first mate in the merge answer, stays English
      "got no answer. The pull request reads merged now; whether that merge, the held request or someone else merged it is not known.";
  // i18n-exempt: served to the first mate in the merge answer, stays English
  return ` ${host} held the first merge request without finishing it, so the app sent its direct merge once at the approved version and ${answered} Tell the captain that once; nothing else is needed.`;
}

/** The Activity line of a merge that was the direct one sent in place of a held request. */
export function directlyLine(place: string, change: string): { line: string; lineSaid: Said } {
  const lineSaid = said("mergedChangeDirectlyOn", { change, place });
  return { line: englishOf(lineSaid), lineSaid };
}

/**
 * What a merge sends while the host holds a merge request of the approved
 * version (`MergeGuard.hold`), read before the last look. No hold: the
 * ordinary merge (`{}`). A hold not yet past the bound, or whose one direct
 * merge was already sent, refused or withheld: nothing (`stopped`), and the
 * approval keeps reading. Past the bound: the host's direct merge
 * (`direct`), called once after the last look, which records it as sent and
 * answers how long the host held the request; `send` then sends it. A branch
 * that takes merges only through its merge queue gets no direct merge.
 */
export async function throughHold(
  forge: Forge,
  guard: Pick<MergeGuard, "hold"> | undefined,
  change: ForgeChange,
  way: Parameters<NonNullable<Forge["putInDirectly"]>>[2] | undefined,
): Promise<
  | { stopped: PrOutcome }
  | {
      direct?: (() => { heldMs: number }) & { send: (head: string) => Promise<MergeAnswer> };
    }
> {
  const hold = guard?.hold?.();
  if (!hold) return {};
  // i18n-exempt: named in a refusal served to the first mate, stays English
  const place = forge.place ?? "the project's host";
  const label = forge.label(change);
  const putInDirectly = forge.putInDirectly?.bind(forge);
  const dispatch = hold.dispatch;
  if (!dispatch || !way || !putInDirectly)
    return {
      stopped: {
        ok: false,
        // i18n-exempt: served to the first mate in the merge answer, stays English
        text: `Cannot merge yet: ${place} is holding an earlier merge request of ${label}, so nothing is sent while it does. The host reads that request on its own.`,
        stop: "outcome",
        mergeHeld: true,
      },
    };
  const base = change.number === undefined ? undefined : (await forge.pull?.(change.number))?.base;
  const rules = base && forge.branchRules ? await forge.branchRules(base) : [];
  if (rules.some((set) => set.rules.includes("merge_queue"))) {
    const minutes = Math.round(hold.heldMs / 60_000);
    // i18n-exempt: served to the first mate in the merge answer, stays English
    const why = `${place} has held an earlier merge request of ${label} for ${minutes} minutes without finishing it, and ${base} takes merges only through its merge queue, so the app does not send its direct merge`;
    return {
      stopped: {
        ok: false,
        text: `Cannot merge: ${why}. Nothing is sent while ${place} holds that request; the host keeps reading it.`,
        problem: why,
        mergeHeld: true,
        directWithheld: true,
      },
    };
  }
  return {
    direct: Object.assign(
      () => {
        dispatch();
        return { heldMs: hold.heldMs };
      },
      { send: (head: string) => putInDirectly(change, head, way) },
    ),
  };
}
