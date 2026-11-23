import releaseIdentity from "../../packaging/release-identity.json" with { type: "json" };

/**
 * The code requirement a Mac release of Infinitary meets: Apple's chain
 * through the Developer ID intermediate, the app's identifier, a Developer ID
 * leaf - the parts of codesign's own default - and one of the teams in
 * `acceptedTeamIds`. `teamId` is the one team that signs this version.
 *
 * Squirrel.Mac installs an update only when it satisfies the running copy's
 * designated requirement, so the release gives its app bundle this one
 * (scripts/sign-release-mac.mjs). A copy whose requirement names a second team
 * accepts that team's next release; that is how releases move to another team
 * without a manual reinstall (docs/alpha.md, "Moving releases to another Apple team").
 * Imported by plain Node too, so it reads nothing but the identity file.
 */
// i18n-exempt: code-signing requirement language that codesign reads, never shown
export const RELEASE_REQUIREMENT = [
  "anchor apple generic",
  `identifier "${releaseIdentity.bundleId}"`,
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
  `(${releaseIdentity.acceptedTeamIds.map((team) => `certificate leaf[subject.OU] = "${team}"`).join(" or ")})`,
].join(" and ");

export const RELEASE_DESIGNATED_REQUIREMENT = `designated => ${RELEASE_REQUIREMENT}`;
