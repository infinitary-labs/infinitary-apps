import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { assertInstallerEnvironment } from "./installer-environment.ts";

// INF-2759, INF-2946. The installed-update checks send production download names to
// their local feed through the hosts file. macOS's resolver (mDNSResponder) takes in a
// changed hosts file only when its watch on the file reports the write, and a HUP
// empties its cache without rereading the file, so when that report does not apply it
// keeps answering with the real site: an alpha's check waited a full minute for a
// hosts entry the resolver never took in. A check therefore restarts the resolver,
// which reads the hosts file as it starts, and waits until it answers with the entry
// before reading a feed; a wait that runs out names what the resolver answered.

type Run = (command: string, args: string[]) => string;
type Answer = { address: string; family: number };
/** Each name's distinct IPv4 addresses, sorted, or the code of the error its lookup gave. */
export type ResolverAnswers = Record<string, string[] | string>;

/** The loopback address the hosts entry gives each name; the local feed listens there. */
export const LOCAL_FEED_ADDRESS = "127.0.0.1";

/** Empty the directory cache and restart the resolver, which launchd starts again on the next lookup with the hosts file as it is now. */
function rereadHosts(run: Run): void {
  run("/usr/bin/sudo", ["/usr/bin/dscacheutil", "-flushcache"]);
  run("/usr/bin/sudo", ["/usr/bin/killall", "mDNSResponder"]);
}

/**
 * Point each name at this disposable Mac, refusing any other Mac: keep the original hosts file in `work`,
 * replace it with one that adds the entry, then make the resolver read it.
 * `replaced` runs as soon as the system file changed, so cleanup restores it even
 * when the restart fails.
 */
export function routeHostsHere(names: readonly string[], work: string, run: Run, replaced: () => void): void {
  assertInstallerEnvironment();
  copyFileSync("/etc/hosts", join(work, "original-hosts"));
  writeFileSync(join(work, "hosts"), `${readFileSync("/etc/hosts", "utf8")}\n${LOCAL_FEED_ADDRESS} ${names.join(" ")}\n`);
  run("/usr/bin/sudo", ["/bin/cp", join(work, "hosts"), "/etc/hosts"]);
  replaced();
  rereadHosts(run);
}

export function restoreHosts(work: string, run: Run): void {
  run("/usr/bin/sudo", ["/bin/cp", join(work, "original-hosts"), "/etc/hosts"]);
  rereadHosts(run);
}

/**
 * What the system resolver, the one curl and the installed app ask, answers for each
 * name now. A check polls this after `routeHostsHere`, before any read, until it
 * equals `answeredHere`; a name it cannot resolve yet is not routed either.
 */
export async function resolverAnswers(
  names: readonly string[],
  resolve: (name: string) => Promise<Answer[]> = (name) => lookup(name, { family: 4, all: true }),
): Promise<ResolverAnswers> {
  const answers: ResolverAnswers = {};
  for (const name of names) {
    try {
      answers[name] = [...new Set((await resolve(name)).map(({ address }) => address))].sort();
    } catch (error) {
      answers[name] = (error as NodeJS.ErrnoException).code ?? String(error);
    }
  }
  return answers;
}

export function answeredHere(names: readonly string[]): ResolverAnswers {
  return Object.fromEntries(names.map((name) => [name, [LOCAL_FEED_ADDRESS]]));
}
