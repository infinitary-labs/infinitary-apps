import {
  catalogDigest,
  describeDigest,
  familyHeads,
  staleDefaults,
  vanishedFamilies,
} from "@shared/modelListing";
import { STARTER_SLOTS } from "@shared/modelSlots";

/**
 * The live catalog checks' one contract (docs/model-lists.md), shared by
 * every provider's probe - Claude's client and Pi's catalog - so each
 * asserts the same things and none fails on a mere catalog addition.
 *
 * It FAILS on what would break or quietly stale a default:
 * - a starter id the catalog no longer serves (a dead default);
 * - an id on a shipped list the catalog no longer serves (dead listed);
 * - a starter a generation behind its family, unless HELD_BACK says why;
 * - a tracked id the catalog no longer serves at all;
 * - for a hand-kept list (Claude's), a family whose newest generation the
 *   list does not name - FI3-74's shape.
 *
 * Everything else - older generations re-listed, ids nobody tracks - is the
 * DIGEST: printed for a person at every run, never a failure.
 */

export type CatalogCheckInput = {
  providerId: string;
  served: readonly string[];
  /** A shipped list every id of which must still be served. */
  shipped?: readonly string[];
  /** The list must name every family's newest generation (Claude's). */
  namesEveryHead?: boolean;
};

export type CatalogCheck = { failures: string[]; digest: string };

export function checkCatalog(input: CatalogCheckInput): CatalogCheck {
  const served = new Set(input.served);
  const failures: string[] = [];
  const deadDefaults = Object.keys(STARTER_SLOTS[input.providerId] ?? {}).filter(
    (id) => !served.has(id),
  );
  if (deadDefaults.length > 0) {
    failures.push(
      `Dead default in STARTER_SLOTS["${input.providerId}"] (no longer served): ${deadDefaults.join(", ")}`,
    );
  }
  const deadListed = (input.shipped ?? []).filter((id) => !served.has(id));
  if (deadListed.length > 0) {
    failures.push(
      `Dead id on ${input.providerId}'s shipped list (no longer served): ${deadListed.join(", ")}`,
    );
  }
  for (const stale of staleDefaults(input.providerId, input.served)) {
    if (stale.heldBack) continue;
    failures.push(
      `Default a generation behind: ${input.providerId} serves ${stale.newer} newer than the starter ${stale.id} - move STARTER_SLOTS to it, or add a HELD_BACK entry saying why not`,
    );
  }
  const vanished = vanishedFamilies(input.providerId, input.served);
  if (vanished.length > 0) {
    failures.push(
      `Tracked in TRACKED_FAMILIES["${input.providerId}"] but no longer served: ${vanished.join(", ")}`,
    );
  }
  if (input.namesEveryHead) {
    const named = new Set(input.shipped ?? []);
    const missing = familyHeads(input.providerId, input.served)
      .map((head) => head.id)
      .filter((id) => !named.has(id));
    if (missing.length > 0) {
      failures.push(
        `A family's newest generation is missing from ${input.providerId}'s shipped list: ${missing.join(", ")}`,
      );
    }
  }
  return {
    failures,
    digest: describeDigest(input.providerId, catalogDigest(input.providerId, input.served)),
  };
}
