import { z } from "zod";
import { compareSemver } from "./semver";

/**
 * Which build of Infinitary a copy runs (docs/devices.md, "Matching the
 * home's build"): an installed release by its version and the commit its
 * source index names, or a run from source by its commit, whether tracked
 * files were edited from it, and its lockfile's digest. A computer that
 * runs work says it in its hello (`build`, `source-builds`), and the home
 * compares it with its own (`compareBuilds`).
 */
export const buildIdentitySchema = z.object({
  /** The commit the build was made from: a release's source index's, or a source run's. */
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  /** Present for a run from source: absent for an installed release. */
  source: z
    .object({
      /** Tracked files differed from `commit` when it started. */
      edited: z.boolean(),
      /** The SHA-256 of `pnpm-lock.yaml`, in hex, when it was read. */
      lockDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .optional(),
});
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

/** What one side said of itself: its contract, its version of Infinitary, and its build. */
export type BuildSide = {
  contract: string;
  app?: string | undefined;
  build?: BuildIdentity | undefined;
};

/**
 * How a computer's build stands against the home's, the one comparison
 * Settings -> Devices, the update by itself and the update card read:
 *
 * - `same`: nothing to match.
 * - otherwise the build Match brings it to (`target`): `release`, the home's
 *   installed version, delivered as today's update; or `source`, the home's
 *   commit, sent as an archive that computer builds. `than` orders two
 *   releases, or two contracts when no release can be ordered, which holds
 *   new work on a computer that is behind.
 */
export type BuildMatch =
  | { same: true }
  | { same: false; target: "release" | "source"; than?: "older" | "newer" };

/** Whether a build is a run from source that names the commit it runs. */
export function sourceCommitOf(build: BuildIdentity | undefined): string | null {
  return build?.source && build.commit ? build.commit : null;
}

const orderOf = (order: number | null): "older" | "newer" | undefined =>
  order ? (order < 0 ? "older" : "newer") : undefined;

/**
 * Compares a computer's build with the home's (`BuildMatch`). Two releases
 * compare by version as they always have. A home run from source names its
 * commit (only `pnpm dev`'s starter gives a home a build), and is matched by
 * commit, whatever the other runs. A home on a release brings a computer
 * that runs source back to that release.
 */
export function compareBuilds(home: BuildSide, other: BuildSide): BuildMatch {
  const contracts = orderOf(compareSemver(other.contract, home.contract));
  const homeCommit = sourceCommitOf(home.build);
  if (homeCommit) {
    if (sourceCommitOf(other.build) === homeCommit) return { same: true };
    return { same: false, target: "source", ...(contracts ? { than: contracts } : {}) };
  }
  if (other.build?.source)
    return { same: false, target: "release", ...(contracts ? { than: contracts } : {}) };
  const apps = other.app !== undefined && home.app !== undefined;
  if (apps ? other.app === home.app : other.contract === home.contract) return { same: true };
  const than = apps ? orderOf(compareSemver(other.app as string, home.app as string)) : contracts;
  return { same: false, target: "release", ...(than ? { than } : {}) };
}

/** A commit as Settings shows it: its first seven characters. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}
