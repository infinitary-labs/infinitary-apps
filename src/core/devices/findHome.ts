import { splitDialAddress } from "@shared/devices";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { findOnPath } from "../userBin";
import { ANNOUNCE_SERVICE } from "./announce";
import { readAvahiName } from "./avahi";
import { type DnsSdRun, runDnsSd, SYSTEM_DNS_SD } from "./dnsSd";
import { readBrowseLine } from "./nearby";
import { runWindowsDnsSd } from "./windowsDnsSd";

/**
 * A device's last way to its home (docs/devices.md, "Finding the home
 * again"): when no address its grant keeps answers with the home's key, it
 * listens for the computers announcing Infinitary on the local network
 * (`_infinitary._tcp`, `./announce.ts`) and answers where each can be
 * reached. It only listens and asks the system's Bonjour: it sends nothing to
 * any address, and it trusts nothing it heard - the announcement carries no
 * key, so the dial checks the home's key at each address as at any other.
 *
 * On a Mac it asks macOS's own `dns-sd` (`-B`, then `-L` for each name); on
 * Linux Avahi's `avahi-browse`, which resolves each as it hears it; on
 * Windows its own network browsing, asked as dns-sd is (`./windowsDnsSd.ts`).
 */

/** How long one look listens for announcements, and how long one name's address may take. */
const LOOK_SECONDS = 3;

/**
 * At most this many names announcing Infinitary are looked up, and this many
 * addresses dialed, in one look: each is a process (`dns-sd -L`, and an nc for
 * each dial on macOS), so a network announcing many names starts no more.
 */
export const ANNOUNCED_HOMES_MAX = 16;

/** How many names are looked up at once; the rest wait their turn, as Macs nearby does. */
const LOOKING_UP_AT_ONCE = 4;

/** What `dns-sd -L` says of one name: where it can be reached, without the name's closing dot. */
export function readReachedLine(line: string): string | null {
  const reached = / can be reached at (\S+?)\.?:(\d+) \(interface -?\d+\)/.exec(line);
  if (!reached?.[1] || !reached[2]) return null;
  const at = `${reached[1]}:${reached[2]}`;
  return splitDialAddress(at) ? at : null;
}

/**
 * What one line of `avahi-browse --parsable --resolve` says of Infinitary's
 * service: the address and port it resolved to, or null for anything else.
 */
export function readAvahiReached(line: string): string | null {
  const fields = line.trim().split(";");
  const [event, , , name, type, , , address, port] = fields;
  if (event !== "=" || type !== ANNOUNCE_SERVICE || name === undefined) return null;
  if (readAvahiName(name) === null || !address || !port) return null;
  const at = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
  return splitDialAddress(at) ? at : null;
}

/** Runs `args` to its end, handing each line to `line`; never rejects. */
function runToEnd(run: DnsSdRun, args: readonly string[], line: (text: string) => void) {
  return new Promise<void>((resolve) => {
    run(args, { line, ended: () => resolve() });
  });
}

/** Every address heard announcing Infinitary through macOS's own dns-sd, or its stand-in. */
export async function announcedWithDnsSd(run: DnsSdRun): Promise<string[]> {
  const names = new Set<string>();
  await runToEnd(run, ["-t", String(LOOK_SECONDS), "-B", ANNOUNCE_SERVICE, "local."], (text) => {
    const heard = readBrowseLine(text);
    if (heard?.kind === "add") names.add(heard.name);
  });
  const waiting = [...names].slice(0, ANNOUNCED_HOMES_MAX);
  const found: string[][] = [];
  const lookUp = async () => {
    for (let name = waiting.shift(); name !== undefined; name = waiting.shift()) {
      const at: string[] = [];
      found.push(at);
      await runToEnd(
        run,
        ["-t", String(LOOK_SECONDS), "-L", name, ANNOUNCE_SERVICE, "local."],
        (text) => {
          const reached = readReachedLine(text);
          if (reached) at.push(reached);
        },
      );
    }
  };
  await Promise.all(Array.from({ length: LOOKING_UP_AT_ONCE }, lookUp));
  return [...new Set(found.flat())].slice(0, ANNOUNCED_HOMES_MAX);
}

/** Every address heard announcing Infinitary through Avahi's avahi-browse. */
export async function announcedWithAvahi(run: DnsSdRun): Promise<string[]> {
  const found = new Set<string>();
  await runToEnd(
    run,
    ["--parsable", "--resolve", "--terminate", "--no-db-lookup", ANNOUNCE_SERVICE],
    (text) => {
      const reached = readAvahiReached(text);
      if (reached) found.add(reached);
    },
  );
  return [...found].slice(0, ANNOUNCED_HOMES_MAX);
}

/**
 * How this computer listens for its home's announcement: a development run's
 * dns-sd stand-in (`INFINITARY_DNS_SD`, `../standIns.ts`), macOS's own
 * dns-sd, Avahi's avahi-browse where a Linux computer has one, or Windows'
 * own network browsing. Undefined where it has none, so the dial has no
 * last way to try.
 */
export function homeFinder(
  dnsSdStandIn: string | undefined,
): (() => Promise<readonly string[]>) | undefined {
  const dnsSd = dnsSdStandIn || (hostPlatform() === "darwin" ? SYSTEM_DNS_SD : undefined);
  if (dnsSd) {
    const run = runDnsSd(dnsSd);
    return () => announcedWithDnsSd(run);
  }
  if (hostPlatform() === "win32") {
    const run = runWindowsDnsSd();
    return () => announcedWithDnsSd(run);
  }
  if (hostPlatform() !== "linux") return undefined;
  const avahi = findOnPath("avahi-browse", hostEnv());
  if (!avahi) return undefined;
  const run = runDnsSd(avahi);
  return () => announcedWithAvahi(run);
}
