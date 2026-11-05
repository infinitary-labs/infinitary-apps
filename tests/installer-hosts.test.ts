import { expect, it } from "vitest";
import { LOCAL_FEED_ADDRESS, resolvesHere } from "../scripts/installer-hosts";

// INF-2759: a release's update check pointed the download name at its local feed and
// read it a second later, but macOS still answered with the real site's addresses, so
// the read reached the real feed. The check now waits for this predicate first. The
// answers are the system resolver's IPv4 readings: the download site's two addresses
// and GitHub's, as it answers before a hosts entry applies, and an entry's address.
const realSite = [
  { address: "172.67.214.47", family: 4 },
  { address: "104.21.93.194", family: 4 },
];
const realGitHub = [{ address: "140.82.114.3", family: 4 }];
const entry = [{ address: LOCAL_FEED_ADDRESS, family: 4 }];
const answering =
  (answers: Record<string, { address: string; family: number }[]>) => async (name: string) => {
    const found = answers[name];
    if (found) return found;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  };

it("keeps a check waiting until the resolver answers every rerouted name with the hosts entry alone", async () => {
  const name = "downloads.getinfinitary.com";
  expect(await resolvesHere([name], answering({ [name]: realSite }))).toBe(false);
  expect(await resolvesHere([name], answering({ [name]: [...entry, ...realSite] }))).toBe(false);
  expect(await resolvesHere([name], answering({ [name]: [] }))).toBe(false);
  expect(await resolvesHere([name], answering({}))).toBe(false);
  expect(await resolvesHere([name], answering({ [name]: entry }))).toBe(true);

  const names = [name, "github.com", "raw.githubusercontent.com"];
  const allButGitHub = {
    [name]: entry,
    "github.com": realGitHub,
    "raw.githubusercontent.com": entry,
  };
  expect(await resolvesHere(names, answering(allButGitHub))).toBe(false);
  expect(await resolvesHere(names, answering({ ...allButGitHub, "github.com": entry }))).toBe(true);
});
