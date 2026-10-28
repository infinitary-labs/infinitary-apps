import { currentCheckSummary } from "@shared/checkSnapshot";
import type { TaskDelivery } from "../storage/taskStore";

/**
 * The CI reading the app last recorded on a task's delivery facts, as the
 * Firstmate reads it: in `crew_status` and beside a crewmate's report.
 * The Firstmate has no tool that takes a reading of its own; the crewmate's
 * `check_change`, the host's check watch and the completion card's gate
 * record them, and a merge rechecks the checks fresh whoever asks.
 */
export type CiReadingFact = {
  overall: "green" | "red" | "pending" | "no-pr" | "merged" | "none";
  checksWords?: string;
  /** When the reading was taken, ISO 8601. */
  readAt: string;
  /** How old the reading is, in whole minutes. */
  ageMinutes: number;
  /** The change head the reading saw, when it recorded one. */
  head?: string;
};

export function ciFactOf(
  delivery: TaskDelivery | null | undefined,
  now: number,
): CiReadingFact | undefined {
  if (!delivery || (!delivery.ci && !delivery.checks) || delivery.ciAt === undefined)
    return undefined;
  const observed = currentCheckSummary(delivery);
  return {
    overall: observed?.overall ?? delivery.ci!,
    ...(observed ? { checksWords: observed.words } : {}),
    readAt: new Date(delivery.ciAt).toISOString(),
    ageMinutes: Math.max(0, Math.round((now - delivery.ciAt) / 60_000)),
    ...((delivery.checks?.headSha ?? delivery.headSha)
      ? { head: delivery.checks?.headSha ?? delivery.headSha }
      : {}),
  };
}

/** A wake's words for the reading; the merge's own recheck is named so a stale one is not trusted. */
export function ciFactWords(fact: CiReadingFact): string {
  const head = fact.head ? `, head ${fact.head.slice(0, 7)}` : "";
  return ` The app's recorded checks: ${fact.checksWords ?? fact.overall} (read ${fact.ageMinutes} min ago${head}); a merge rechecks them fresh.`;
}
