import { z } from "zod";
import type { UpdateStatus } from "./update";
import { UPDATE_PROBLEMS } from "./updateWords";

/**
 * The first mate's computer's own update, as a paired phone or Mac reads and
 * starts it (docs/view.md, "Updating the first mate's computer"; INF-4012's
 * direction 1). A view and its home on opposite sides of a release that
 * changed how they talk only read, so these requests are answered on every
 * major, past the read-only gate (`READ_ONLY_ASKS`): their names and this
 * shape never change. A later major adds a request beside them, never in
 * their place, and only ever adds an optional field here.
 */

/** The contract change that adds the home's update requests (`home-update.md`). */
export const HOME_UPDATE = "home-update";

/**
 * Where the home's update stands, an open list: a view that meets a word it
 * does not know shows the version alone and offers nothing.
 * - `current`: nothing newer to install.
 * - `offered`: `offered` names a newer version, and Update starts it.
 * - `elsewhere`: a newer version is out, and the home installs it only at
 *   that computer (Homebrew, a password, an unconfirmed copy); `problem` says why.
 * - `starting`: the update was started and the updater has not moved yet, or the home opens its window to install it.
 * - `downloading`: `percent` says how far.
 * - `saving`: the crew's running work finishes first; `waitingFor` names each task.
 * - `restarting`: the copy is being replaced, and the home starts again.
 * - `resuming`: after the restart, `waitingFor` names each task not started again.
 * - `failed`: `problem` says what happened; Update tries again while `offered` is set.
 */
export const HOME_UPDATE_STEPS = [
  "current",
  "offered",
  "elsewhere",
  "starting",
  "downloading",
  "saving",
  "restarting",
  "resuming",
  "failed",
] as const;
export type HomeUpdateStep = (typeof HOME_UPDATE_STEPS)[number];

export const homeUpdateSchema = z.object({
  /** The Infinitary version the home runs. */
  version: z.string(),
  /** The update channel the home follows, as its own Version row names it. */
  channel: z.string(),
  /** The newer version Update installs now; null when the home offers nothing from afar. */
  offered: z.string().nullable(),
  /** One of `HOME_UPDATE_STEPS`, read as an open list. */
  step: z.string(),
  percent: z.number().min(0).max(100).optional(),
  /** Saving: each task whose running work the update waits for. Resuming: each not started again. */
  waitingFor: z.array(z.string()),
  /** What an update would stop on the home now, for the view to confirm against. */
  stops: z.object({
    /** Each task whose running work the save would wait for. */
    tasks: z.array(z.string()),
    /** How many background jobs the restart would stop. */
    jobs: z.number().int().nonnegative(),
  }),
  /** The home's own words for why it cannot update from here, or what went wrong. */
  problem: z.string().nullable(),
});
export type HomeUpdate = z.infer<typeof homeUpdateSchema>;

/** What an update would stop on the home now. */
export type HomeUpdateStops = HomeUpdate["stops"];

/**
 * The home's update status, said for a view. `fromAfar` is false where the
 * home installs only at that computer, and `why` then says so in its words.
 */
export function homeUpdateOf(
  status: UpdateStatus,
  stops: HomeUpdateStops,
  facts: { fromAfar: boolean; why?: string; starting?: boolean; problem?: string | null },
): HomeUpdate {
  const work = status.work;
  const offered =
    status.updateAvailable && status.latestVersion && facts.fromAfar && status.install
      ? status.latestVersion
      : null;
  const said = (step: HomeUpdateStep, extra: Partial<HomeUpdate> = {}): HomeUpdate => ({
    version: status.currentVersion,
    channel: status.channel,
    offered,
    step,
    waitingFor: [],
    stops,
    problem: null,
    ...extra,
  });
  if (work?.state === "saving") return said("saving", { waitingFor: work.tasks });
  if (status.phase === "downloading")
    return said("downloading", status.percent === undefined ? {} : { percent: status.percent });
  if (status.phase === "installing") return said("restarting");
  // Started, before the updater itself moves: a view reading now keeps following it.
  if (facts.starting) return said("starting");
  // A check that could not reach the releases is no failed update: the home says what it knew.
  const updateFailed = status.phase === "error" && status.problem !== UPDATE_PROBLEMS.checkFailed;
  const problem = facts.problem ?? (updateFailed ? (status.problem ?? null) : null);
  if (problem) return said("failed", { problem });
  if (work?.state === "resuming") return said("resuming", { waitingFor: work.tasks });
  if (offered) return said("offered");
  if (status.updateAvailable && status.latestVersion)
    return said("elsewhere", { problem: facts.why ?? status.problem ?? null });
  return said("current");
}

/** The update requests a view asks, by their frozen names. */
export const HOME_UPDATE_STATUS = "inf:home-update:status";
export const HOME_UPDATE_INSTALL = "inf:home-update:install";
export const HOME_UPDATE_LATER = "inf:home-update:later";
