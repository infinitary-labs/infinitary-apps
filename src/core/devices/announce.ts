import { type DeviceView, isPhone } from "@shared/devices";
import type { DnsSdRun } from "./dnsSd";

/**
 * How this computer announces itself for a phone to join or reconnect (docs/devices.md,
 * "Announcing to a phone"): Bonjour's `_infinitary._tcp` in the local domain,
 * at the port the connection listens on, so the phone can find this computer before
 * joining or after its address moved. It carries no key and no secret: the
 * phone proves this computer by the invitation's or its saved public-key pin.
 */
export const ANNOUNCE_SERVICE = "_infinitary._tcp";

/** What macOS's own `dns-sd -R` is asked: the name, the service, the local domain and the port. */
export function dnsSdAnnounceArgs(name: string, port: number): string[] {
  return ["-R", name, ANNOUNCE_SERVICE, "local.", String(port)];
}

export type HomeAnnouncementOptions = {
  /**
   * What announces, held until stopped: a Mac's dns-sd, a Linux home's
   * avahi-publish, or null where this computer has neither (and no stand-in).
   */
  run: DnsSdRun | null;
  /** What that program is asked to announce `name` at `port`: `dnsSdAnnounceArgs` or `avahiAnnounceArgs`. */
  args: (name: string, port: number) => readonly string[];
  /** The name this computer announces under: a Mac's own name in System Settings, a Linux home's own name on the network. */
  name: () => Promise<string>;
  /** The port the connection listens on. */
  port: number;
  /** Calls `fire` after `ms`; answers how to cancel it. Tests stand in a clock. */
  later?: (ms: number, fire: () => void) => () => void;
};

/** How long after a run ended by itself the next starts, doubling up to the most. */
const RETRY_FIRST_MS = 5_000;
const RETRY_MOST_MS = 60_000;

/**
 * Announces this computer while a phone is on the list or a usable direct invitation is open,
 * with macOS's own `dns-sd -R` or Avahi's `avahi-publish`, held by this app's pipe
 * (`runDnsSdHeld`) so it ends with the app however that went. It stops when neither
 * condition holds, and a run that ends by itself restarts only while either condition still holds.
 */
export class HomeAnnouncement {
  private readonly options: HomeAnnouncementOptions;
  private readonly later: (ms: number, fire: () => void) => () => void;
  private running: { stop: () => void } | null = null;
  /** Whether a phone is listed or a usable direct invitation is open now. */
  private wanted = false;
  private disposed = false;
  private retry: (() => void) | null = null;
  private retryMs = RETRY_FIRST_MS;
  /** Bumped by each start and stop, so a late name or a late end of an earlier run is ignored. */
  private turn = 0;

  constructor(options: HomeAnnouncementOptions) {
    this.options = options;
    this.later =
      options.later ??
      ((ms, fire) => {
        const timer = setTimeout(fire, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /** Whether the announcement is running or about to run. */
  get announcing(): boolean {
    return this.running !== null;
  }

  /** Announce while a phone is listed or a usable direct invitation is open. */
  devicesChanged(devices: readonly DeviceView[], phoneMayJoin = false): void {
    if (this.disposed) return;
    this.wanted = (devices.some(isPhone) || phoneMayJoin) && this.options.run !== null;
    if (this.wanted && !this.running && !this.retry) this.start();
    if (!this.wanted) this.stop();
  }

  /** Stops announcing for good; the app is quitting. */
  dispose(): void {
    this.disposed = true;
    this.wanted = false;
    this.stop();
  }

  private start(): void {
    const run = this.options.run;
    if (!run || this.disposed) return;
    this.turn += 1;
    const turn = this.turn;
    let stopped = false;
    let child: { stop: () => void } | null = null;
    // Held at once so two changes in a row start one run; the name is read first.
    this.running = {
      stop: () => {
        stopped = true;
        child?.stop();
      },
    };
    void this.options.name().then(
      (name) => {
        if (stopped || turn !== this.turn) return;
        child = run(this.options.args(name, this.options.port), {
          line: () => {},
          ended: () => {
            if (turn !== this.turn) return;
            this.running = null;
            this.again();
          },
        });
      },
      () => {
        if (turn !== this.turn) return;
        this.running = null;
        this.again();
      },
    );
  }

  /** The run ended by itself (as when mDNSResponder restarted, or Avahi refused it) while still wanted: start another, later each time. */
  private again(): void {
    if (!this.wanted || this.disposed) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MOST_MS);
    this.retry = this.later(wait, () => {
      this.retry = null;
      if (this.wanted && !this.running) this.start();
    });
  }

  private stop(): void {
    this.turn += 1;
    this.running?.stop();
    this.running = null;
    this.retry?.();
    this.retry = null;
    this.retryMs = RETRY_FIRST_MS;
  }
}
