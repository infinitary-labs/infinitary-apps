import {
  NEARBY_LEASE_MS,
  NEARBY_OFF,
  type NearbyMac,
  type NearbyMacsState,
  type NearbyMacsView,
  nearbyMacNameSchema,
  nearbyUserSchema,
} from "@shared/nearbyMacs";
import { AVAHI_BROWSE_ARGS, readAvahiLine } from "./avahi";
import { asDeviceName } from "./computerName";
import type { DnsSdRun } from "./dnsSd";

/**
 * Macs nearby (docs/devices.md, "Macs nearby"): while Settings -> Devices
 * asks, this Mac listens for Remote Login's Bonjour announcement,
 * `_ssh._tcp`, with macOS's own dns-sd, and asks each Mac that announces
 * it for its name on this network once. A Linux home listens for the same
 * with Avahi's `avahi-browse`, which hears each computer's name on this
 * network with its announcement. It never tries an address: what it lists
 * is what answered. This computer itself, which answers too, is left out by
 * its own names. It stops once asked to, or a minute after the last ask, so
 * a window that went away leaves nothing listening.
 */

/** Remote Login's Bonjour service, in the local domain. */
const SERVICE = ["_ssh._tcp", "local."] as const;

/** Bonjour's answer when macOS does not let the asking app use the local network (TN3179). */
export const POLICY_DENIED = -65570;

/**
 * Each run of dns-sd ends by itself (`-t`), so a Firstmate that stopped
 * without a word leaves nothing listening for long: a browse after this
 * many seconds, when another starts if the list is still looked for, and a
 * Mac's name after five, when that Mac is left off.
 */
const BROWSE_SECONDS = 75;
const RESOLVE_SECONDS = 5;

/** How long a Mac the last browse announced waits for the next one to announce it again. */
const SETTLE_MS = 2_000;

/** How many Macs are asked their name at once; the rest wait their turn. */
const RESOLVING_AT_ONCE = 4;

/** At most this many Macs are listed, and asked. */
const MOST = 64;

/** A line of `dns-sd -B`: one Mac announced on one interface, or gone from it. */
export type BrowseLine =
  | { kind: "add" | "remove"; name: string; interfaceIndex: number }
  | { kind: "error"; code: number };

/** What one line of `dns-sd -B` or `-L` says, or null for a header or a note. */
export function readBrowseLine(line: string): BrowseLine | null {
  const error =
    /^\s*(?:\d{1,2}:\d{2}:\d{2}\.\d{3}\s+)?(?:Error code|DNSService call failed) (-?\d+)/.exec(
      line,
    );
  if (error) return { kind: "error", code: Number(error[1]) };
  const seen =
    /^\s*\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+(-?\d+)\s+\S+\s+\S+\s+(.+)$/.exec(
      line,
    );
  if (!seen?.[1] || !seen[2] || !seen[3]) return null;
  return {
    kind: seen[1] === "Add" ? "add" : "remove",
    name: seen[3],
    interfaceIndex: Number(seen[2]),
  };
}

/** The name on this network a line of `dns-sd -L` gives, without its closing dot. */
export function readResolveLine(line: string): string | null {
  const reached = / can be reached at (\S+):\d+ \(interface -?\d+\)/.exec(line);
  if (!reached?.[1]) return null;
  const parsed = nearbyMacNameSchema.safeParse(reached[1].replace(/\.$/, ""));
  return parsed.success ? parsed.data : null;
}

export type NearbyMacsOptions = {
  /** dns-sd, or null where this Mac cannot look (not macOS, with no stand-in). */
  run: DnsSdRun | null;
  /** Avahi's `avahi-browse`, where this computer looks with it in place of dns-sd (Linux). */
  avahi?: DnsSdRun | null;
  /** This Mac's own names on the network (`ownNetworkNames`). */
  ownNames: () => Promise<readonly string[]>;
  /** The user Firstmate runs as here. */
  user: string;
  /** Told the whole view whenever it reads differently. */
  changed: (view: NearbyMacsView) => void;
  /** Calls `fire` after `ms`; answers how to cancel it. Tests stand in a clock. */
  later?: (ms: number, fire: () => void) => () => void;
};

export class NearbyMacs {
  private readonly options: NearbyMacsOptions;
  private readonly user: string | null;
  private readonly later: (ms: number, fire: () => void) => () => void;
  private state: NearbyMacsState = "off";
  private browse: { stop: () => void } | null = null;
  private lease: (() => void) | null = null;
  /** Each name the browse running now announced, with the interfaces it is announced on. */
  private readonly announced = new Map<string, Set<number>>();
  /** Names the browse before announced, kept while the next one settles. */
  private readonly previous = new Set<string>();
  private settling: (() => void) | null = null;
  /** Each name answered with its name on this network, this Mac's own included. */
  private readonly reached = new Map<string, string>();
  /** Each name being asked now, by how to end that ask. */
  private readonly resolving = new Map<string, () => void>();
  private readonly waiting: string[] = [];
  /** This Mac's own names, lowercase, once read for the current look; nothing is listed before. */
  private own: Set<string> | null = null;
  private said = JSON.stringify(NEARBY_OFF);
  /** Bumped by each start and stop, so a late answer from an earlier look is ignored. */
  private look = 0;

  constructor(options: NearbyMacsOptions) {
    this.options = options;
    const user = nearbyUserSchema.safeParse(options.user);
    this.user = user.success ? user.data : null;
    this.later =
      options.later ??
      ((ms, fire) => {
        const timer = setTimeout(fire, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /** What Settings -> Devices draws now. */
  view(): NearbyMacsView {
    if (this.state === "off") return NEARBY_OFF;
    const macs: NearbyMac[] = [];
    for (const [name, at] of this.own ? this.reached : []) {
      if (!this.announced.has(name) && !this.previous.has(name)) continue;
      if (this.own?.has(at.toLowerCase())) continue;
      const shown = asDeviceName(name);
      if (shown) macs.push({ name: shown, at });
    }
    return { state: this.state, user: this.user, macs: macs.slice(0, MOST) };
  }

  /**
   * The aside is open (`true`): look, or keep looking for another minute.
   * It closed (`false`): stop now.
   */
  ask(watching: boolean): NearbyMacsView {
    if (!watching) {
      this.stop();
      return this.view();
    }
    this.lease?.();
    this.lease = this.later(NEARBY_LEASE_MS, () => this.stop());
    if (this.state === "off") this.start();
    return this.view();
  }

  /** Stops looking; the app is quitting. */
  dispose(): void {
    this.stop();
  }

  private start(): void {
    this.look += 1;
    const look = this.look;
    if (!this.options.run && !this.options.avahi) {
      this.state = "off";
      return;
    }
    this.state = "looking";
    void this.options.ownNames().then(
      (names) => {
        if (look !== this.look) return;
        this.own = new Set(names.map((name) => name.toLowerCase()));
        this.tell();
      },
      () => {
        if (look !== this.look) return;
        this.own = new Set();
        this.tell();
      },
    );
    this.browseOnce(look);
    this.tell();
  }

  private browseOnce(look: number): void {
    const run = this.options.run;
    if (!run) {
      if (this.options.avahi) this.browseAvahi(look, this.options.avahi);
      return;
    }
    this.browse = run(["-t", String(BROWSE_SECONDS), "-B", ...SERVICE], {
      line: (text) => {
        if (look === this.look) this.heard(readBrowseLine(text));
      },
      ended: (finished) => {
        if (look !== this.look) return;
        this.browse = null;
        if (finished) {
          this.again(look);
          return;
        }
        // It stopped some other way: whatever it found may be gone without a word.
        this.state = "failed";
        this.tell();
      },
    });
  }

  /**
   * One browse with Avahi, which hears each computer's name on this network
   * with its announcement, so none is asked again. It runs until stopped, so
   * it is stopped after a dns-sd browse's time and another starts, as dns-sd
   * does; one that ends by itself could not look, as when Avahi's daemon is
   * not running.
   */
  private browseAvahi(look: number, avahi: DnsSdRun): void {
    // Each interface and protocol a computer is heard on, as dns-sd numbers its interfaces.
    const wheres = new Map<string, number>();
    let cancel: (() => void) | null = null;
    const run = avahi(AVAHI_BROWSE_ARGS, {
      line: (text) => {
        if (look !== this.look) return;
        const line = readAvahiLine(text);
        if (!line) return;
        if (!wheres.has(line.where)) wheres.set(line.where, wheres.size);
        const interfaceIndex = wheres.get(line.where) ?? 0;
        if (line.kind !== "reached") {
          this.heard({ kind: line.kind, name: line.name, interfaceIndex });
          return;
        }
        const at = nearbyMacNameSchema.safeParse(line.at);
        if (!at.success || !this.announced.has(line.name) || this.reached.has(line.name)) return;
        this.reached.set(line.name, at.data);
        this.tell();
      },
      ended: () => {
        if (look !== this.look) return;
        cancel?.();
        this.browse = null;
        this.state = "failed";
        this.tell();
      },
    });
    cancel = this.later(BROWSE_SECONDS * 1000, () => {
      if (look !== this.look) return;
      run.stop();
      this.browse = null;
      this.again(look);
    });
    this.browse = {
      stop: () => {
        cancel?.();
        run.stop();
      },
    };
  }

  /**
   * The browse ran its time while the list is still looked for: another
   * starts, and a Mac the last one announced stays until this one has had
   * time to announce it again.
   */
  private again(look: number): void {
    for (const name of this.announced.keys()) this.previous.add(name);
    this.announced.clear();
    this.settling?.();
    this.settling = this.later(SETTLE_MS, () => {
      if (look !== this.look) return;
      this.settling = null;
      for (const name of this.previous) this.reached.delete(name);
      this.previous.clear();
      this.tell();
    });
    this.browseOnce(look);
  }

  private stop(): void {
    this.look += 1;
    this.lease?.();
    this.lease = null;
    this.settling?.();
    this.settling = null;
    this.browse?.stop();
    this.browse = null;
    for (const end of [...this.resolving.values()]) end();
    this.resolving.clear();
    this.waiting.length = 0;
    this.announced.clear();
    this.previous.clear();
    this.reached.clear();
    this.own = null;
    this.state = "off";
    this.tell();
  }

  private heard(line: BrowseLine | null): void {
    if (!line) return;
    if (line.kind === "error") {
      this.state = line.code === POLICY_DENIED ? "not-allowed" : "failed";
      this.tell();
      return;
    }
    if (line.kind === "add") {
      const on = this.announced.get(line.name);
      if (on) {
        on.add(line.interfaceIndex);
        return;
      }
      if (this.announced.size >= MOST) return;
      this.announced.set(line.name, new Set([line.interfaceIndex]));
      this.previous.delete(line.name);
      // A Mac answering means macOS lets this app look now.
      this.state = "looking";
      this.resolve(line.name);
      this.tell();
      return;
    }
    const on = this.announced.get(line.name);
    on?.delete(line.interfaceIndex);
    if (!on || on.size > 0) return;
    this.announced.delete(line.name);
    this.reached.delete(line.name);
    this.resolving.get(line.name)?.();
    this.tell();
  }

  private resolve(name: string): void {
    const run = this.options.run;
    if (!run || this.reached.has(name) || this.resolving.has(name)) return;
    if (this.resolving.size >= RESOLVING_AT_ONCE) {
      if (!this.waiting.includes(name)) this.waiting.push(name);
      return;
    }
    const look = this.look;
    let done = false;
    let running: { stop: () => void } | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      running?.stop();
      this.resolving.delete(name);
      if (look !== this.look) return;
      for (let next = this.waiting.shift(); next !== undefined; next = this.waiting.shift()) {
        if (!this.announced.has(next)) continue;
        this.resolve(next);
        return;
      }
    };
    // One that has not answered when its run ends by itself is left off.
    running = run(["-t", String(RESOLVE_SECONDS), "-L", name, ...SERVICE], {
      line: (text) => {
        if (done || look !== this.look) return;
        const error = readBrowseLine(text);
        if (error?.kind === "error") {
          if (error.code === POLICY_DENIED) {
            this.state = "not-allowed";
            this.tell();
          }
          finish();
          return;
        }
        const at = readResolveLine(text);
        if (!at) return;
        if (this.announced.has(name)) this.reached.set(name, at);
        finish();
        this.tell();
      },
      ended: finish,
    });
    if (done) {
      running.stop();
      return;
    }
    this.resolving.set(name, finish);
  }

  private tell(): void {
    const view = this.view();
    const said = JSON.stringify(view);
    if (said === this.said) return;
    this.said = said;
    this.options.changed(view);
  }
}
