import { expect, it } from "vitest";
import { answeredHere, LOCAL_FEED_ADDRESS, resolverAnswers } from "../scripts/installer-hosts";

// INF-2759: a release's update check pointed the download name at its local feed and
// read it a second later, but macOS still answered with the real site's addresses, so
// the read reached the real feed. The check now waits until the resolver's answers
// equal the hosts entry's. INF-2946: a later alpha's wait ran out saying only that it
// had not; the reading now names what the resolver answered, which the wait's failure
// prints. The answers are the system resolver's IPv4 readings: the download site's two
// addresses and GitHub's, as it answers before a hosts entry applies, and an entry's.
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
  const routed = answeredHere([name]);
  expect(await resolverAnswers([name], answering({ [name]: realSite }))).not.toEqual(routed);
  expect(await resolverAnswers([name], answering({ [name]: [...entry, ...realSite] }))).not.toEqual(
    routed,
  );
  expect(await resolverAnswers([name], answering({ [name]: [] }))).not.toEqual(routed);
  expect(await resolverAnswers([name], answering({}))).not.toEqual(routed);
  expect(await resolverAnswers([name], answering({ [name]: entry }))).toEqual(routed);

  const names = [name, "github.com", "raw.githubusercontent.com"];
  const allButGitHub = {
    [name]: entry,
    "github.com": realGitHub,
    "raw.githubusercontent.com": entry,
  };
  expect(await resolverAnswers(names, answering(allButGitHub))).not.toEqual(answeredHere(names));
  expect(await resolverAnswers(names, answering({ ...allButGitHub, "github.com": entry }))).toEqual(
    answeredHere(names),
  );
});

it("names what the resolver answered while a rerouted name has not reached this Mac", async () => {
  const name = "downloads.getinfinitary.com";
  expect(await resolverAnswers([name], answering({ [name]: realSite }))).toEqual({
    [name]: realSite.map(({ address }) => address).sort(),
  });
  expect(await resolverAnswers([name], answering({}))).toEqual({ [name]: "ENOTFOUND" });
});
