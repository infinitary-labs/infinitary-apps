import type { ComputerLoadReading } from "@shared/load";
import {
  type ComputerResourcesView,
  RESOURCE_DEMAND_LEASE_MS,
  RESOURCE_REFRESH_MS,
} from "@shared/resources";
import type { ComputerResources } from "./computerResources";

/**
 * One demand-leased resource source for every screen and panel of this home.
 * Read requests renew demand and return the shared cache; they never start
 * independent sampling loops. Pushes fan each completed reading out to all
 * clients. No history, settings or database writes belong on this path.
 */
export class ComputerResourceFeed {
  private demandedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly refreshing = new Map<string | null, Promise<void>>();
  private readonly started = new Map<string | null, number>();
  private readonly sampling = new Set<() => void>();
  private readonly stop: (() => void)[];
  private stopped = false;

  constructor(
    private readonly options: {
      resources: Pick<ComputerResources, "read" | "refresh" | "sampledAt">;
      /** Home first, then paired work computers; never control-only devices. */
      computers: () => { computerId: string | null; label: string }[];
      onComputers: (listener: () => void) => () => void;
      /** ComputerResources invalidates its receiver before this listener runs. */
      onContact: (listener: (contact: { deviceId: string }) => void) => () => void;
      emit: (view: ComputerResourcesView) => void;
      /** Crew work keeps observations alive even with no screen subscriber. */
      working?: () => boolean;
      load?: (computerId: string | null) => ComputerLoadReading | undefined;
      refreshLoad?: (computerId: string | null) => Promise<void>;
      now?: () => number;
    },
  ) {
    const changed = () => {
      if (!this.demanded()) return;
      // Publish missing/out-of-reach immediately, never retain an old connection's value.
      this.publish();
      this.refresh();
      if (!this.timer) this.tick();
    };
    this.stop = [
      options.onComputers(changed),
      options.onContact(({ deviceId }) => {
        this.started.delete(deviceId);
        changed();
      }),
    ];
    if (options.working?.()) this.tick();
  }

  /** A catalog read is a bounded lease, renewed while a subscriber is present. */
  read(): ComputerResourcesView {
    if (!this.stopped) {
      this.demandedUntil = this.now() + RESOURCE_DEMAND_LEASE_MS;
      if (!this.timer) this.tick();
    }
    return this.snapshot();
  }

  /** A start needs this shared round's answer, not its initial empty cache. */
  async readCurrent(): Promise<ComputerResourcesView> {
    this.read();
    await Promise.all(this.refreshing.values());
    return this.snapshot();
  }

  /**
   * Runs just before this feed asks for new readings, so whatever a listener
   * notes there happened before every sample those readings carry.
   */
  onSample(listener: () => void): () => void {
    this.sampling.add(listener);
    return () => this.sampling.delete(listener);
  }

  /** When a computer's fresh reading was asked for, on the receiver's clock; undefined unless fresh. */
  sampledAt(computerId: string | null): number | undefined {
    return this.options.resources.sampledAt(computerId);
  }

  /** Current receiver ages, without extending demand or initiating a sample. */
  snapshot(): ComputerResourcesView {
    return {
      computers: this.options.computers().map((computer) => ({
        ...computer,
        reading: this.options.resources.read(computer.computerId),
        ...(this.options.load ? { load: this.options.load(computer.computerId) } : {}),
      })),
    };
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.started.clear();
    this.sampling.clear();
    for (const stop of this.stop) stop();
  }

  private tick(): void {
    this.timer = undefined;
    if (!this.demanded()) return;
    // Re-publish ages even when a silent peer's request is still held single-flight.
    this.publish();
    this.refresh();
    this.timer = setTimeout(() => this.tick(), RESOURCE_REFRESH_MS);
    this.timer.unref();
  }

  private refresh(): void {
    const computers = this.options.computers();
    const known = new Set(computers.map(({ computerId }) => computerId));
    for (const computerId of this.started.keys()) {
      if (!known.has(computerId)) this.started.delete(computerId);
    }
    const now = this.now();
    const due = computers.filter(({ computerId }) => {
      if (this.refreshing.has(computerId)) return false;
      const started = this.started.get(computerId);
      return started === undefined || now < started || now - started >= RESOURCE_REFRESH_MS;
    });
    if (due.length === 0) return;
    for (const listener of this.sampling) listener();
    for (const { computerId } of due) {
      this.started.set(computerId, now);
      const reading = Promise.all([
        this.options.resources.refresh(computerId),
        this.options.refreshLoad?.(computerId),
      ])
        .then(() => {
          if (this.demanded()) this.publish();
        })
        .finally(() => this.refreshing.delete(computerId));
      this.refreshing.set(computerId, reading);
    }
  }

  private publish(): void {
    this.options.emit(this.snapshot());
  }

  private demanded(): boolean {
    return !this.stopped && (this.now() < this.demandedUntil || this.options.working?.() === true);
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }
}
