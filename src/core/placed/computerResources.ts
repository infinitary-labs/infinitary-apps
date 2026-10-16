import { speaksResources } from "@shared/ipc";
import {
  type ComputerResourceReading,
  RESOURCE_MAX_AGE_MS,
  RESOURCE_ORDER,
  RESOURCE_READ_TIMEOUT_MS,
  type ResourceObservation,
  resourceObservationSchema,
  validResourceMemory,
} from "@shared/resources";
import type { ResourceSampler } from "./resourceSampler";
import type { WorkDevices } from "./workDevices";

export type { ComputerResourceReading } from "@shared/resources";

type UnknownReading = Extract<ComputerResourceReading, { status: "unknown" }>;

type Held = { observation: ResourceObservation; started: number };
type Pending = { result: Promise<ComputerResourceReading>; invalidate: () => void };

/**
 * The home's receiver of resource facts. Null identifies the home, on the same
 * path and freshness rules as every other computer. No placement happens here.
 */
export class ComputerResources {
  private readonly held = new Map<string | null, Held>();
  private readonly failures = new Map<
    string | null,
    { reading: UnknownReading; started: number }
  >();
  private readonly last = new Map<string | null, { epoch: string; sequence: number }>();
  private readonly pending = new Map<string | null, Pending>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(
    private readonly options: {
      local: Pick<ResourceSampler, "read">;
      work: Pick<WorkDevices, "ask" | "inReach" | "version" | "onWorkDevice">;
      now?: () => number;
    },
  ) {
    // Every connection transition invalidates both the answer and an old ask.
    // A late result from before reconnect can never populate the new epoch.
    this.unsubscribe = options.work.onWorkDevice(({ deviceId }) => {
      this.held.delete(deviceId);
      this.failures.delete(deviceId);
      this.last.delete(deviceId);
      this.pending.get(deviceId)?.invalidate();
      this.pending.delete(deviceId);
    });
  }

  read(deviceId: string | null): ComputerResourceReading {
    const unavailable = this.unavailable(deviceId);
    if (unavailable) return unavailable;
    const held = this.held.get(deviceId);
    if (!held) {
      const failed = this.failures.get(deviceId);
      if (!failed) return { status: "unknown", reason: "missing" };
      const ageMs = this.now() - failed.started;
      return ageMs < 0 || ageMs > RESOURCE_MAX_AGE_MS
        ? { status: "unknown", reason: "stale" }
        : failed.reading;
    }
    const ageMs = this.now() - held.started;
    // Age starts before the ask, conservatively including network travel and sampling.
    if (ageMs < 0 || ageMs > RESOURCE_MAX_AGE_MS) return { status: "unknown", reason: "stale" };
    if (held.observation.status === "unknown") return { status: "unknown", reason: "unavailable" };
    return { status: "fresh", observation: held.observation, ageMs };
  }

  /**
   * When the fresh reading this receiver holds for a computer was asked for,
   * on its own clock - the moment its age counts from; undefined unless fresh.
   */
  sampledAt(deviceId: string | null): number | undefined {
    return this.read(deviceId).status === "fresh" ? this.held.get(deviceId)?.started : undefined;
  }

  refresh(deviceId: string | null): Promise<ComputerResourceReading> {
    const unavailable = this.unavailable(deviceId);
    if (unavailable) return Promise.resolve(unavailable);
    const existing = this.pending.get(deviceId);
    if (existing) return existing.result;
    const started = this.now();
    let resolve!: (reading: ComputerResourceReading) => void;
    const result = new Promise<ComputerResourceReading>((done) => {
      resolve = done;
    });
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      resolve(this.failed(deviceId, "timeout", started));
    }, RESOURCE_READ_TIMEOUT_MS);
    deadline.unref();
    const pending: Pending = {
      result,
      invalidate: () => {
        expired = true;
        clearTimeout(deadline);
        resolve({ status: "unknown", reason: "out-of-reach" });
      },
    };
    this.pending.set(deviceId, pending);
    const finish = (reading: ComputerResourceReading) => {
      clearTimeout(deadline);
      if (this.pending.get(deviceId) === pending) this.pending.delete(deviceId);
      resolve(reading);
    };
    // Keep a timed-out ask single-flight until it ends or the connection changes,
    // so a silent peer cannot accumulate outstanding requests on every refresh.
    void Promise.resolve()
      .then(() => {
        if (expired || this.pending.get(deviceId) !== pending) return undefined;
        return deviceId === null
          ? this.options.local.read()
          : this.options.work.ask(deviceId, RESOURCE_ORDER, []);
      })
      .then((raw) => {
        if (expired || this.pending.get(deviceId) !== pending) return;
        const elapsed = this.now() - started;
        // The event loop may deliver an answer before an overdue timer callback.
        if (elapsed < 0 || elapsed > RESOURCE_READ_TIMEOUT_MS) {
          finish(this.failed(deviceId, "timeout", started));
          return;
        }
        const parsed = resourceObservationSchema.safeParse(raw);
        const previous = this.last.get(deviceId);
        if (
          !parsed.success ||
          (parsed.data.status === "sampled" && !validResourceMemory(parsed.data.memory)) ||
          (previous &&
            (previous.epoch !== parsed.data.epoch || previous.sequence >= parsed.data.sequence))
        ) {
          finish(this.failed(deviceId, "invalid", started));
          return;
        }
        this.last.set(deviceId, { epoch: parsed.data.epoch, sequence: parsed.data.sequence });
        this.failures.delete(deviceId);
        this.held.set(deviceId, { observation: parsed.data, started });
        finish(this.read(deviceId));
      })
      .catch(() => {
        if (expired || this.pending.get(deviceId) !== pending) return;
        finish(this.failed(deviceId, "unavailable", started));
      })
      .finally(() => {
        clearTimeout(deadline);
        if (this.pending.get(deviceId) === pending) this.pending.delete(deviceId);
      });
    return result;
  }

  dispose(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const pending of this.pending.values()) pending.invalidate();
    this.pending.clear();
    this.held.clear();
    this.failures.clear();
    this.last.clear();
  }

  /** Cached readers see the same refusal as the reader whose refresh failed. */
  private failed(
    deviceId: string | null,
    reason: UnknownReading["reason"],
    started: number,
  ): UnknownReading {
    const reading: UnknownReading = { status: "unknown", reason };
    this.held.delete(deviceId);
    this.failures.set(deviceId, { reading, started });
    return reading;
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }

  private unavailable(deviceId: string | null): ComputerResourceReading | null {
    if (this.stopped || (deviceId !== null && !this.options.work.inReach(deviceId)))
      return { status: "unknown", reason: "out-of-reach" };
    if (deviceId !== null && !speaksResources(this.options.work.version(deviceId)?.contract ?? ""))
      return { status: "unknown", reason: "unsupported" };
    return null;
  }
}
