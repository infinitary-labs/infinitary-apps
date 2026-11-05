import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { assertInstallerEnvironment } from "./installer-environment.ts";

// INF-2759. The installed-update checks send production download names to their
// local feed through the hosts file. macOS's resolver (mDNSResponder) takes in a
// changed hosts file on its own schedule and keeps the real answers it already gave,
// and `dscacheutil -flushcache` empties only the directory cache in front of it. The
// update check reads the real feed seconds before the change, so a read right after
// it reached the real site instead of the local feed. A check therefore flushes both
// caches and waits until the resolver answers with the entry before reading a feed.

type Run = (command: string, args: string[]) => string;
type Answer = { address: string; family: number };

/** The loopback address the hosts entry gives each name; the local feed listens there. */
export const LOCAL_FEED_ADDRESS = "127.0.0.1";

/**
 * Point each name at this disposable Mac, refusing any other Mac: keep the original hosts file in `work`,
 * replace it with one that adds the entry, then empty both resolver caches.
 * `replaced` runs as soon as the system file changed, so cleanup restores it even
 * when a flush fails.
 */
export function routeHostsHere(names: readonly string[], work: string, run: Run, replaced: () => void): void {
  assertInstallerEnvironment();
  copyFileSync("/etc/hosts", join(work, "original-hosts"));
  writeFileSync(join(work, "hosts"), `${readFileSync("/etc/hosts", "utf8")}\n${LOCAL_FEED_ADDRESS} ${names.join(" ")}\n`);
  run("/usr/bin/sudo", ["/bin/cp", join(work, "hosts"), "/etc/hosts"]);
  replaced();
  run("/usr/bin/sudo", ["/usr/bin/dscacheutil", "-flushcache"]);
  run("/usr/bin/sudo", ["/usr/bin/killall", "-HUP", "mDNSResponder"]);
}

/** Put the original hosts file back. */
export function restoreHosts(work: string, run: Run): void {
  run("/usr/bin/sudo", ["/bin/cp", join(work, "original-hosts"), "/etc/hosts"]);
}

/**
 * Whether the system resolver, the one curl and the installed app ask, now answers
 * every name with only the hosts entry's address. A name it cannot resolve yet is
 * not routed either. A check polls this after `routeHostsHere`, before any read.
 */
export async function resolvesHere(
  names: readonly string[],
  resolve: (name: string) => Promise<Answer[]> = (name) => lookup(name, { family: 4, all: true }),
): Promise<boolean> {
  for (const name of names) {
    let answers: Answer[];
    try {
      answers = await resolve(name);
    } catch {
      return false;
    }
    if (answers.length === 0 || answers.some(({ address }) => address !== LOCAL_FEED_ADDRESS)) return false;
  }
  return true;
}
