/**
 * The Apple team that signs a release, and whether the channel's subscribers
 * would take an update that team signs (docs/alpha.md, "Moving releases to
 * another Apple team"). release.yml's resolve job runs it from the workflow's
 * own commit and reads the source and past releases from git, so a stable
 * promoting an alpha an earlier team signed still signs with that team's
 * material: the alpha's own electron-builder.yml names that team's identity.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { compareSemver } from "../src/shared/semver.ts";

/**
 * Every team a release may be signed by: its Developer ID certificate's name,
 * and the prefix of the release environments' secrets that hold its
 * certificate and App Store Connect key.
 */
export const SIGNING_TEAMS: Readonly<Record<string, { identity: string; secrets: string }>> = {
  "9T2J7MNUP9": { identity: "Developer ID Application: Kun Chen (9T2J7MNUP9)", secrets: "" },
  Y44V95NP6K: {
    identity: "Developer ID Application: Infinitary Labs, Inc. (Y44V95NP6K)",
    secrets: "COMPANY_",
  },
};

export type ReleaseIdentity = { teamId: string; acceptedTeamIds?: string[] };

/** The teams an installed copy of a release takes updates from (src/shared/releaseRequirement.ts). */
export function acceptedTeams(identity: ReleaseIdentity): string[] {
  return identity.acceptedTeamIds ?? [identity.teamId];
}

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-alpha\.[1-9]\d*)?$/;

/**
 * The version the channel's subscribers have now, other than `version`: a
 * stable's newest stable, or an alpha's newest release of either channel,
 * since an alpha subscriber also takes a promoted stable. Null in a history
 * that has published nothing.
 */
export function currentRelease(tags: string[], channel: string, version: string): string | null {
  const versions = tags
    .filter((tag) => RELEASE_TAG.test(tag))
    .map((tag) => tag.slice(1))
    .filter((candidate) => candidate !== version && (channel === "alpha" || !candidate.includes("-")));
  versions.sort((a, b) => compareSemver(a, b) ?? 0);
  return versions.at(-1) ?? null;
}

export type SigningTeam = { team: string; identity: string; secrets: string };

/**
 * The source's team and its material, or an error naming why the release
 * would strand the channel's subscribers.
 */
export function signingTeam(
  source: ReleaseIdentity,
  current: { version: string; identity: ReleaseIdentity } | null,
  channel: string,
): SigningTeam {
  const team = source.teamId;
  const known = SIGNING_TEAMS[team];
  if (!known) {
    throw new Error(`The source is signed by team ${team}, and the workflow keeps no signing material for it.`);
  }
  if (current && !acceptedTeams(current.identity).includes(team)) {
    const subscribers = channel === "alpha" ? "Alpha" : "Stable";
    throw new Error(
      `${subscribers} subscribers have ${current.version}, which installs only updates signed by team ${acceptedTeams(current.identity).join(" or ")}, ` +
        `and team ${team} signs this release. Ship a ${channel} that accepts both teams first (docs/alpha.md, "Moving releases to another Apple team").`,
    );
  }
  return { team, ...known };
}

function identityAt(ref: string): ReleaseIdentity {
  return JSON.parse(
    execFileSync("git", ["show", `${ref}:packaging/release-identity.json`], { encoding: "utf8" }),
  ) as ReleaseIdentity;
}

function main(env: NodeJS.ProcessEnv) {
  const source = env.SOURCE_COMMIT ?? "";
  const channel = env.CHANNEL ?? "";
  const version = env.VERSION ?? "";
  if (!/^[0-9a-f]{40}$/.test(source) || !["alpha", "stable"].includes(channel) || !version) {
    throw new Error("Give SOURCE_COMMIT, CHANNEL and VERSION.");
  }
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n");
  const currentVersion = currentRelease(tags, channel, version);
  const current = currentVersion ? { version: currentVersion, identity: identityAt(`v${currentVersion}`) } : null;
  const signing = signingTeam(identityAt(source), current, channel);
  const lines = `team_id=${signing.team}\nsign_identity=${signing.identity}\nsigning_secrets=${signing.secrets}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  console.error(`Team ${signing.team} signs ${version}${current ? `; ${channel} subscribers on ${current.version} accept it` : ""}.`);
}

if (import.meta.main) {
  try {
    main(process.env);
  } catch (error: unknown) {
    console.error(`::error title=Release signing team::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
