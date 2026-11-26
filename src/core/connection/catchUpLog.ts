import { BlockList, isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { isLoopback } from "./addresses";
import { type ReplayEntry, replayBytes } from "./journal";

/**
 * The home's line for each phone that comes back (docs/connection.md, "The
 * catch-up log"): whether it was sent the updates it missed or read
 * everything again, why, the bytes sent and the weight they were measured
 * against, the route it came by, how long it took from its hello until
 * it answered for the whole catch-up, and how long the phone itself says it
 * took to show it. It names no address and no content.
 */

/** Why a phone replayed or reloaded. */
export type CatchUpWhy =
  /** Its hello named no place: a first connection, or one that held nothing. */
  | "first"
  /** Its place is from another run of the home: a restart, or a pause in listening. */
  | "restart"
  /** Its place is older than the oldest update the home still keeps. */
  | "kept-too-short"
  /** Its place is newer than the home's newest update. */
  | "ahead"
  /** The updates it missed weigh more than what a reload reads first. */
  | "heavier"
  /** The updates it missed weigh no more than what a reload reads first. */
  | "lighter"
  /** What a reload reads first has not been weighed in this run, so it replays. */
  | "unweighed";

/**
 * How the phone reached the home, read off its socket and never written as
 * an address: from a network this computer is on, through a private network
 * service's shared range (such as Tailscale), from this computer itself (a
 * relay here, or a test), or by any other route.
 */
export type CatchUpRoute = "same-network" | "private-network" | "this-computer" | "another-route";

export type PhoneCatchUp = {
  kind: "replay" | "reload";
  why: CatchUpWhy;
  /** How many updates it missed, or null when the home no longer keeps them. */
  missedUpdates: number | null;
  /** What those updates weigh as a replay would send them, or null when not kept. */
  missedBytes: number | null;
  /** What a reload reads first, as weighed in this run, or null while unweighed. */
  reloadWeight: number | null;
  /** What the home wrote for this catch-up: the welcome, then the replay or the reload's reads. */
  sentBytes: number;
  route: CatchUpRoute;
  /** From its hello until it answered for every byte of the catch-up, or until it went. */
  ms: number;
  /** False when the connection went before the phone answered for the whole catch-up. */
  acknowledged: boolean;
  /**
   * From its hello until its catch-up showed, by the phone's own clock
   * (`CATCH_UP_SHOWN`); absent when the phone did not say before the line was told.
   */
  shownMs?: number;
  /** The version of the app its hello said it runs. */
  appVersion?: string;
};

/** Why a catch-up is what it is, from why its place was lost and the two weights. */
export function catchUpWhy(
  lost: "no-place" | "another-epoch" | "ahead" | "older" | null,
  missedBytes: number | null,
  reloadWeight: number | undefined,
): CatchUpWhy {
  if (lost === "no-place") return "first";
  if (lost === "another-epoch") return "restart";
  if (lost === "older") return "kept-too-short";
  if (lost === "ahead") return "ahead";
  if (reloadWeight === undefined) return "unweighed";
  return (missedBytes ?? 0) > reloadWeight ? "heavier" : "lighter";
}

/** The shared range a private network service hands out, as `addresses.ts` reads it. */
const SHARED_RANGE = new BlockList();
SHARED_RANGE.addSubnet("100.64.0.0", 10, "ipv4");

/** The route a socket's remote address came by; the address itself goes no further. */
export function routeOf(
  remote: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): CatchUpRoute {
  if (!remote) return "another-route";
  const plain = remote
    .toLowerCase()
    .replace(/%.*$/, "")
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (isLoopback(plain)) return "this-computer";
  const family = isIP(plain);
  if (family === 0) return "another-route";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (SHARED_RANGE.check(plain, type)) return "private-network";
  for (const entry of Object.values(interfaces).flat()) {
    if (!entry || entry.internal || !entry.cidr) continue;
    const own = isIP(entry.address);
    if (own !== family) continue;
    const [network, prefix] = entry.cidr.split("/");
    if (!network || prefix === undefined) continue;
    const subnet = new BlockList();
    subnet.addSubnet(network, Number(prefix), type);
    if (subnet.check(plain, type)) return "same-network";
  }
  return "another-route";
}

// i18n-exempt: a line in the home's own log, never shown in the app
const WHY_WORDS: Record<CatchUpWhy, string> = {
  first: "no place held",
  restart: "the home restarted",
  "kept-too-short": "kept updates too short",
  ahead: "place ahead of the home",
  heavier: "missed updates heavier",
  lighter: "missed updates lighter",
  unweighed: "reload not weighed yet",
};

/** The one line the home logs for a phone's catch-up: plain words, no address, no content. */
export function describeCatchUp(catchUp: PhoneCatchUp): string {
  const { kind, why, missedUpdates, missedBytes, reloadWeight, sentBytes, route, ms } = catchUp;
  // i18n-exempt: a line in the home's own log, never shown in the app
  return [
    `phone catch-up: ${kind === "replay" ? "sent missed updates" : "read everything again"} (${WHY_WORDS[why]})`,
    `sent ${sentBytes} bytes`,
    `${missedUpdates === null ? "missed updates not kept" : `missed updates (${missedUpdates}) weigh ${missedBytes ?? 0} bytes`} against ${reloadWeight === null ? "a reload not weighed yet" : `a reload weight of ${reloadWeight} bytes`}`,
    `route ${route}`,
    catchUp.acknowledged
      ? `acknowledged ${ms} ms after its hello`
      : `went ${ms} ms after its hello, before acknowledging it all`,
    ...(catchUp.shownMs !== undefined ? [`shown ${catchUp.shownMs} ms after its hello`] : []),
    ...(catchUp.appVersion ? [`app ${catchUp.appVersion}`] : []),
  ].join("; ");
}

/**
 * One phone's catch-up while it goes: the bytes written for it and, for a
 * reload, the reads it still waits on. The line is told once: when the
 * phone has answered for it all and, for a phone that says when its
 * catch-up showed, once it has said so; or when the connection goes.
 */
export class CatchUpWatch {
  private sentBytes = 0;
  private told = false;
  private readonly reads: Set<string>;
  /** The home's side, kept from the first `end` until the line is told. */
  private ended: { acknowledged: boolean; ms: number } | undefined;
  private shownMs: number | undefined;

  constructor(
    private readonly start: Omit<PhoneCatchUp, "sentBytes" | "ms" | "acknowledged">,
    private readonly startedAt: number,
    /** The reads a reload waits on; none for a replay. */
    reads: readonly string[],
    private readonly now: () => number,
    private readonly tell: (catchUp: PhoneCatchUp) => void,
    /** The phone listed `CATCH_UP_SHOWN`, so the line waits for its own time. */
    private readonly saysShown = false,
  ) {
    this.reads = new Set(reads);
  }

  /** The reads it still waits on before the home has written the whole catch-up. */
  get waiting(): boolean {
    return this.reads.size > 0;
  }

  /** A frame written for the catch-up. */
  sent(text: string): void {
    if (!this.told) this.sentBytes += Buffer.byteLength(text);
  }

  /** An answer written to the phone; true when it was the last read the catch-up waited on. */
  answered(channel: string, text: string): boolean {
    if (this.told || !this.reads.delete(channel)) return false;
    this.sent(text);
    return this.reads.size === 0;
  }

  /** The home's side ended: the phone answered for every byte, or the connection went first. */
  end(acknowledged: boolean): void {
    if (this.told || this.ended) return;
    this.ended = { acknowledged, ms: Math.max(0, this.now() - this.startedAt) };
    if (!acknowledged || !this.saysShown || this.shownMs !== undefined) this.tellOnce();
  }

  /** The phone said its catch-up showed `ms` after its hello; only its first word counts. */
  shown(ms: number): void {
    if (this.told || this.shownMs !== undefined) return;
    this.shownMs = ms;
    if (this.ended) this.tellOnce();
  }

  /** The connection went: the line is told with what it has. */
  gone(): void {
    if (this.ended) this.tellOnce();
    else this.end(false);
  }

  private tellOnce(): void {
    if (this.told || !this.ended) return;
    this.told = true;
    this.tell({
      ...this.start,
      sentBytes: this.sentBytes,
      ...this.ended,
      ...(this.shownMs !== undefined ? { shownMs: this.shownMs } : {}),
    });
  }
}

/**
 * Starts watching a phone's catch-up at its welcome: `replay` is what a
 * replay would send (null when its place was lost), `replaying` whether the
 * home chose it, and `weight` what a reload reads first, as weighed now.
 */
export function watchCatchUp(at: {
  lost: Parameters<typeof catchUpWhy>[0];
  replay: readonly ReplayEntry[] | null;
  replaying: boolean;
  weight: number | undefined;
  remote: string | undefined;
  appVersion: string | undefined;
  helloAt: number;
  /** What a reload reads first: a reload's catch-up is written once each is answered. */
  reads: readonly string[];
  /** The phone's hello listed `CATCH_UP_SHOWN`. */
  saysShown?: boolean;
  tell: (catchUp: PhoneCatchUp) => void;
  now?: () => number;
}): CatchUpWatch {
  const missedBytes = at.replay ? replayBytes(at.replay) : null;
  return new CatchUpWatch(
    {
      kind: at.replaying ? "replay" : "reload",
      why: catchUpWhy(at.lost, missedBytes, at.weight),
      missedUpdates: at.replay ? at.replay.length : null,
      missedBytes,
      reloadWeight: at.weight ?? null,
      route: routeOf(at.remote),
      ...(at.appVersion ? { appVersion: at.appVersion } : {}),
    },
    at.helloAt,
    at.replaying ? [] : at.reads,
    at.now ?? Date.now,
    at.tell,
    at.saysShown ?? false,
  );
}
