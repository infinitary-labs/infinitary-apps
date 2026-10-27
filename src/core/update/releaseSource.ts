import configuration from "../../../packaging/release-source.json" with { type: "json" };
import { INFINITARY_TAP, type TapNames } from "./updateChannels";

/** Build-owned destination, never a runtime environment override in a distributed app. */
export function releaseSourceFor(repository: string, downloadBase: string, releasePage: string) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid public release destination");
  }
  const base = new URL(downloadBase);
  const page = new URL(releasePage);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    page.protocol !== "https:" ||
    page.username ||
    page.password ||
    page.hash
  ) {
    throw new Error("Invalid public download address");
  }
  return {
    repository,
    downloadBase: base.href,
    feedUrl: new URL("feeds/", base).href,
    releasesUrl: page.href,
    releaseUrl: (_version: string) => page.href,
  };
}

export const releaseSource = releaseSourceFor(
  configuration.repository,
  configuration.downloadBase,
  configuration.releasePage,
);

/** The existing target/build schemas at the selected host, without cask publication. */
export const PUBLIC_RELEASE_NAMES: TapNames = {
  ...INFINITARY_TAP,
  repo: releaseSource.repository,
  downloadBase: releaseSource.downloadBase,
  releasePage: releaseSource.releasesUrl,
  stableTagPrefix: "v",
  alphaTagPrefix: "v",
};
export const publicBuildsUrl = new URL(PUBLIC_RELEASE_NAMES.buildsFile, releaseSource.feedUrl).href;
