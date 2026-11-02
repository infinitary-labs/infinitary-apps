import {
  type ComputerLoadReading,
  LOAD_ORDER,
  type LoadSnapshot,
  loadSnapshotSchema,
} from "@shared/load";
import { RESOURCE_MAX_AGE_MS, RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import { contractChange, listsChange } from "../connection/contractChanges";
import type { LoadLine } from "./loadLine";
import type { WorkDevices } from "./workDevices";

const HEAVY_RUN_LINE = contractChange("heavy-run-line");

/** The home's receiver of declared-run facts; it owns no queue on a second computer. */
export class ComputerLoads {
  private projection:
    | Map<string | null, { reading: ComputerLoadReading | undefined; tasks: Set<string> }>
    | undefined;

  private localTasks: Set<string> | undefined;

  /** One roster or board read shares each computer's declared-run snapshot. */
  readProjection<T>(read: () => T): T {
    if (this.projection) return read();
    this.projection = new Map();
    try {
      return read();
    } finally {
      this.projection = undefined;
      this.localTasks = undefined;
    }
  }

  private readonly held = new Map<string, { snapshot: LoadSnapshot; at: number; known: boolean }>();
  private readonly generations = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private readonly asking = new Map<string, Promise<unknown>>();
  private stopped = false;
  private localSnapshot: LoadSnapshot | undefined;

  constructor(
    private readonly options: {
      local: Pick<LoadLine, "snapshot" | "reconsider" | "taskIds">;
      work: Pick<WorkDevices, "ask" | "inReach" | "version" | "onWorkDevice">;
      overrides: (computerId: string) => string[];
      changed?: () => void;
      now?: () => number;
    },
  ) {
    this.unsubscribe = options.work.onWorkDevice(({ deviceId }) => {
      this.projection?.delete(deviceId);
      this.generations.set(deviceId, (this.generations.get(deviceId) ?? 0) + 1);
      this.asking.delete(deviceId);
      const held = this.held.get(deviceId);
      if (held) {
        held.known = false;
        options.changed?.();
      }
    });
  }

  read(computerId: string | null): ComputerLoadReading | undefined {
    if (this.projection?.has(computerId)) return this.projection.get(computerId)?.reading;
    const reading = this.readNow(computerId);
    this.projection?.set(computerId, {
      reading,
      tasks: new Set(reading?.status === "fresh" ? reading.runs.map((run) => run.taskId) : []),
    });
    return reading;
  }

  private readNow(computerId: string | null): ComputerLoadReading | undefined {
    if (computerId === null) {
      try {
        this.localSnapshot = this.options.local.snapshot();
        return { status: "fresh", ...this.localSnapshot };
      } catch {
        return { status: "unknown", runs: this.localSnapshot?.runs ?? [] };
      }
    }
    const held = this.held.get(computerId);
    if (!held) return undefined;
    const age = this.now() - held.at;
    return {
      ...held.snapshot,
      status:
        held.known &&
        this.options.work.inReach(computerId) &&
        age >= 0 &&
        age <= RESOURCE_MAX_AGE_MS
          ? "fresh"
          : "unknown",
    };
  }

  hasTask(taskId: string, computerId: string | null): boolean {
    if (computerId === null) {
      const tasks = this.localTasks ?? new Set(this.options.local.taskIds());
      if (this.projection) this.localTasks = tasks;
      return tasks.has(taskId);
    }
    const reading = this.read(computerId);
    if (this.projection) return this.projection.get(computerId)?.tasks.has(taskId) ?? false;
    return reading?.status === "fresh" && reading.runs.some((run) => run.taskId === taskId);
  }

  supports(computerId: string): boolean {
    return listsChange(this.options.work.version(computerId)?.changes, HEAVY_RUN_LINE);
  }

  /** Called by the existing two-second resource feed, not a second sampling loop. */
  async refresh(computerId: string | null): Promise<void> {
    if (this.stopped) return;
    if (computerId === null) {
      this.projection?.delete(null);
      this.localTasks = undefined;
      this.options.local.reconsider();
      return;
    }
    const { work } = this.options;
    if (!work.inReach(computerId) || !this.supports(computerId) || this.asking.has(computerId))
      return;
    const generation = this.generations.get(computerId) ?? 0;
    const at = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = work.ask(computerId, LOAD_ORDER, [
        { overrides: this.options.overrides(computerId) },
      ]);
      this.asking.set(computerId, request);
      void request.then(
        () => {
          if (this.asking.get(computerId) === request) this.asking.delete(computerId);
        },
        () => {
          if (this.asking.get(computerId) === request) this.asking.delete(computerId);
        },
      );
      const raw = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Load reading unavailable")),
            RESOURCE_READ_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
      if (this.stopped || generation !== (this.generations.get(computerId) ?? 0)) return;
      const snapshot = loadSnapshotSchema.parse(raw);
      const before = this.held.get(computerId);
      const known = this.now() - at <= RESOURCE_READ_TIMEOUT_MS;
      this.held.set(computerId, { snapshot, at, known });
      this.projection?.delete(computerId);
      if (before?.known !== known || JSON.stringify(before.snapshot) !== JSON.stringify(snapshot))
        this.options.changed?.();
    } catch {
      if (this.stopped || generation !== (this.generations.get(computerId) ?? 0)) return;
      const held = this.held.get(computerId);
      if (held?.known) {
        held.known = false;
        this.projection?.delete(computerId);
        this.options.changed?.();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.stopped = true;
    this.asking.clear();
    this.localSnapshot = undefined;
    this.localTasks = undefined;
    this.projection?.clear();
    this.unsubscribe();
    this.held.clear();
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }
}
