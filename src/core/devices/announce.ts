import { type DeviceView, isPhone } from "@shared/devices";
import type { DnsSdRun } from "./dnsSd";

/**
 * How this Mac announces itself to a phone on its list (docs/devices.md,
 * "Announcing to a phone"): Bonjour's `_infinitary._tcp` in the local
 * domain, at the port the connection listens on, so the phone can find this
 * Mac again after its address moved. It carries no key and no secret: the
 * phone still proves this Mac by the pin it was paired with.
 */
export const ANNOUNCE_SERVICE = "_infinitary._tcp";

export type MacAnnouncementOptions = {
  /** dns-sd, or null where this computer cannot announce (not macOS, with no stand-in). */
  run: DnsSdRun | null;
  /** The name this Mac announces under: its own name in System Settings. */
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
 * Announces this Mac while a phone is on the list, with macOS's own
 * `dns-sd -R`, held by this app's pipe (`runDnsSdHeld`) so it ends with the
 * app however that went. With no phone left it stops, so a Mac that never had
 * a phone announces nothing, and one that ends by itself while a phone is
 * listed starts again.
 */
export class MacAnnouncement {
  private readonly options: MacAnnouncementOptions;
  private readonly later: (ms: number, fire: () => void) => () => void;
  private running: { stop: () => void } | null = null;
  /** Whether a phone is on the list now. */
  private wanted = false;
  private disposed = false;
  private retry: (() => void) | null = null;
  private retryMs = RETRY_FIRST_MS;
  /** Bumped by each start and stop, so a late name or a late end of an earlier run is ignored. */
  private turn = 0;

  constructor(options: MacAnnouncementOptions) {
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

  /** The list changed: announce while a phone is on it, and stop once none is. */
  devicesChanged(devices: readonly DeviceView[]): void {
    if (this.disposed) return;
    this.wanted = devices.some(isPhone) && this.options.run !== null;
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
        child = run(["-R", name, ANNOUNCE_SERVICE, "local.", String(this.options.port)], {
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

  /** The run ended by itself (as when mDNSResponder restarted) while a phone is listed: start another, later each time. */
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
