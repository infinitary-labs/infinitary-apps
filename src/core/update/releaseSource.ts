import configuration from "../../../packaging/release-source.json" with { type: "json" };
import { INFINITARY_TAP, type TapNames } from "./updateChannels";

/** Build-owned destination, never a runtime environment override in a distributed app. */
export function releaseSourceFor(repository: string, feedBranch: string) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    !/^[a-zA-Z0-9_-]+$/.test(feedBranch)
  ) {
    throw new Error("Invalid public release destination");
  }
  return {
    repository,
    feedBranch,
    feedUrl: `https://raw.githubusercontent.com/${repository}/${feedBranch}/`,
    releasesUrl: `https://github.com/${repository}/releases`,
    releaseUrl: (version: string) =>
      `https://github.com/${repository}/releases/tag/v${encodeURIComponent(version)}`,
  };
}

export const releaseSource = releaseSourceFor(configuration.repository, configuration.feedBranch);

/** The existing target/build schemas at the selected host, without cask publication. */
export const PUBLIC_RELEASE_NAMES: TapNames = {
  ...INFINITARY_TAP,
  repo: releaseSource.repository,
  stableTagPrefix: "v",
  alphaTagPrefix: "v",
};
export const publicBuildsUrl = new URL(PUBLIC_RELEASE_NAMES.buildsFile, releaseSource.feedUrl).href;
