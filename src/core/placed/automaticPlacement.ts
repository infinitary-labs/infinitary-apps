import { randomUUID } from "node:crypto";
import { HERE } from "@shared/deviceNames";
import type { DeviceView } from "@shared/devices";
import { deviceLabel, deviceRunsWork } from "@shared/devices";
import { speaksSince } from "@shared/ipc";
import {
  PLACEMENT_FACT_MAX_AGE_MS,
  PLACEMENT_FACTS_ORDER,
  PLACEMENT_FACTS_SINCE,
  type PlacementFacts,
  type PlacementSnapshot,
  type PlacementWait,
  placementFactsAnswerSchema,
  placementReason,
  placementWait,
} from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { RESOURCE_READ_TIMEOUT_MS } from "@shared/resources";
import type { WorkShape } from "@shared/routingPolicy";
import { narrowServedThere } from "../models/piAccountLists";
import { thisDeviceSystem } from "../platform";
import type { QuotaCatalogModel } from "../quota/auth";
import { actualComputerPool } from "../routing/computerPool";
import {
  evaluatePlacement,
  floorHold,
  type PlacementCandidate,
  resolvePlacementRequirements,
} from "../routing/placementEngine";
import type { RouteResult, Router } from "../routing/router";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import type { ComputerResourceFeed } from "./computerResourceFeed";
import { withoutSignIn } from "./placedCopies";
import { readPlacementFacts } from "./placementFacts";
import type { WorkDevices } from "./workDevices";

type Facts = {
  facts: PlacementFacts;
  pool?: ReturnType<typeof actualComputerPool>;
  started: number;
  generation: number;
};
type Read = { result: Promise<Facts | null>; started: number };

/** Where a new Automatic task starts, with what routing chose for it there. */
export type AutomaticChoice = {
  computerId: string | null;
  routed?: RouteResult;
  accountId?: string;
};

/**
 * Why a new Automatic task waits, once every computer was compared. `held` is
 * the route of a wait for the level the task asked for (`floorHold`), which
 * the supervisor holds on that level's reset as it holds a This computer start.
 */
export type AutomaticWait = { wait: PlacementWait; held?: RouteResult };

/** The one start-time admission owner. Resource demand uses the screen/panel feed,
 * not a second sampler. Fresh compatibility is transient; only commitments persist.
 */
export class AutomaticPlacement {
  private readonly generations = new Map<string, number>();
  private readonly reads = new Map<string, Read>();
  private readonly runningSince = new Map<string, number>();
  private readonly stop: (() => void)[];

  constructor(
    private readonly options: {
      tasks: TaskService;
      resources: ComputerResourceFeed;
      work: WorkDevices;
      devices: () => readonly DeviceView[];
      /** Whether a computer is connected on an older Firstmate and takes no new work. */
      takesNoWorkUntilUpdated?: (deviceId: string) => boolean;
      /** Whether a computer is out of reach only because its connection is being made. */
      connecting?: (deviceId: string) => boolean;
      router: Router;
      repo: (id: string) => RepoView | undefined;
      catalog: () => readonly QuotaCatalogModel[];
      /** This Mac's rail, which narrows a computer's Codex and Grok lists (`narrowServedThere`). */
      protectedIds?: (providerId: string) => readonly string[];
      /** The resource receiver's clock: a witness is compared with when its samples began. */
      now?: () => number;
      /** Evidence that the conversation is running, including one reconciled after restart. */
      running: (task: TaskRecord) => boolean;
      localFacts?: typeof readPlacementFacts;
      /** Re-read inherited choices after asynchronous compatibility reads. */
      eligible?: (record: TaskRecord) => boolean;
    },
  ) {
    this.stop = [
      options.work.onWorkDevice(({ deviceId }) => {
        this.generations.set(deviceId, (this.generations.get(deviceId) ?? 0) + 1);
        for (const key of this.reads.keys())
          if (key.startsWith(`${deviceId}\n`)) this.reads.delete(key);
        for (const record of options.tasks.pendingPlacements())
          if (record.deviceId === deviceId) this.runningSince.delete(record.id);
      }),
      // Witnessed before every sample, so the next reading can free a running
      // task's room, however long since the last start (FI3-1757).
      options.resources.onSample(() => this.witness()),
    ];
  }

  dispose(): void {
    for (const stop of this.stop) stop();
    this.reads.clear();
    this.runningSince.clear();
  }

  /**
   * The chosen computer never changes, including when the first answer was lost.
   * A wait carries its words when every computer was compared and none chosen,
   * and the held route when it waits for the level its task asked for.
   */
  async choose(
    record: TaskRecord,
    repo: RepoView,
    prompt: string,
    shape: WorkShape,
    options: { ignoreAsk?: boolean } = {},
  ): Promise<AutomaticChoice | AutomaticWait | undefined> {
    const existing = this.options.tasks.get(record.id)?.placement;
    if (existing && existing.reservation !== "ended") {
      // Reconcile the SAME preparation. Saved readings are never scheduling inputs.
      const id = existing.snapshot.computerId;
      const facts = await this.facts(
        id,
        repo,
        existing.snapshot.requirements.tools ?? [],
        existing.snapshot.origin,
      );
      if (
        !facts ||
        facts.facts.physicalComputerId !== existing.snapshot.physicalComputerId ||
        this.now() - facts.started > PLACEMENT_FACT_MAX_AGE_MS ||
        this.now() < facts.started ||
        (id &&
          (!this.options.work.inReach(id) ||
            facts.generation !== (this.generations.get(id) ?? 0))) ||
        (id && !facts.pool)
      )
        return undefined;
      if (!this.stillCurrent(record, repo)) return undefined;
      // Routing was disabled after commitment: its existing default owner takes
      // the turn, but neither the computer nor preparation order moves.
      if (!this.options.router.dynamicEnabled()) return { computerId: id };
      const preview = this.options.router.preview(
        prompt,
        shape,
        facts.pool ? { pool: facts.pool } : {},
      );
      // Only the home starts on its runtime default when routing names no model.
      if (
        !preview ||
        (!preview.result.choice && id !== null) ||
        (preview.requiresReasoningWait && !options.ignoreAsk)
      )
        return undefined;
      const choice = preview.result.choice;
      return {
        computerId: id,
        routed: this.options.router.commit(record.id, preview),
        ...(choice
          ? { accountId: facts.pool?.modelAccounts.get(`${choice.provider}/${choice.id}`) }
          : {}),
      };
    }
    const requirements = resolvePlacementRequirements({
      project: repo.placementRequirements,
      task: shape.placement_requirements,
      home: thisDeviceSystem(),
      workingCopy: true,
    });
    const resourceRound = this.options.resources.readCurrent(); // The same round that views use.
    const computers = [
      { computerId: null as string | null, name: HERE.This, inReach: true },
      ...this.options
        .devices()
        .filter((device) => deviceRunsWork(device.kind))
        .map((device) => ({
          computerId: device.id,
          name: deviceLabel(device),
          inReach: this.options.work.inReach(device.id),
        })),
    ];
    const origin = repo.origin ? withoutSignIn(repo.origin) : undefined;
    const facts = await Promise.all(
      computers.map((computer) =>
        computer.inReach ? this.facts(computer.computerId, repo, requirements.tools, origin) : null,
      ),
    );
    await resourceRound;
    if (existing) {
      const bound =
        facts[
          computers.findIndex((computer) => computer.computerId === existing.snapshot.computerId)
        ];
      if (bound?.facts.physicalComputerId !== existing.snapshot.physicalComputerId)
        return undefined;
    }
    if (!this.stillCurrent(record, repo)) return undefined;
    let now = this.now();
    const live = this.options.resources.snapshot();
    this.reconcile();
    const candidates: PlacementCandidate[] = computers.map((computer, index) => {
      const read = facts[index];
      const valid =
        read &&
        now >= read.started &&
        now - read.started <= PLACEMENT_FACT_MAX_AGE_MS &&
        (computer.computerId === null ||
          (this.options.work.inReach(computer.computerId) &&
            read.generation === (this.generations.get(computer.computerId) ?? 0)));
      const model =
        valid && (computer.computerId === null || read.pool)
          ? (this.options.router.preview(prompt, shape, read.pool ? { pool: read.pool } : {}) ??
            null)
          : null;
      // An explicit start_now already owns acceptance of the existing fallback.
      if (model && options.ignoreAsk) model.requiresReasoningWait = false;
      return {
        computerId: computer.computerId,
        inReach: computer.computerId === null || this.options.work.inReach(computer.computerId),
        ...(computer.computerId !== null &&
        this.options.takesNoWorkUntilUpdated?.(computer.computerId)
          ? { olderFirstmate: true }
          : {}),
        ...(computer.computerId !== null && this.options.connecting?.(computer.computerId)
          ? { connecting: true }
          : {}),
        workEnabled: true,
        ...(valid ? { system: read.facts.system, chip: read.facts.chip } : {}),
        physicalComputerId: valid ? read.facts.physicalComputerId : null,
        tools: valid ? read.facts.tools : {},
        projectAccess: valid ? read.facts.projectAccess : "unknown",
        resources: live.computers.find((row) => row.computerId === computer.computerId)
          ?.reading ?? { status: "unknown", reason: "missing" },
        model,
        // The home starts a task with no routed model on its runtime default;
        // a computer that runs work refuses one (`CrewSupervisor.startTask`).
        runtimeDefault: computer.computerId === null,
      };
    });
    let routed: RouteResult | undefined;
    let wait: AutomaticWait | undefined;
    let onDefault: { computerId: string | null; name: string } | undefined;
    const committed = this.options.tasks.commitPlacement(record.id, (pending) => {
      now = this.now();
      const atCommit = this.options.resources.snapshot();
      for (const [index, candidate] of candidates.entries()) {
        candidate.resources = atCommit.computers.find(
          (row) => row.computerId === candidate.computerId,
        )?.reading ?? { status: "unknown", reason: "missing" };
        const read = facts[index];
        if (!read || now < read.started || now - read.started > PLACEMENT_FACT_MAX_AGE_MS) {
          candidate.physicalComputerId = null;
          candidate.projectAccess = "unknown";
          candidate.model = null;
        }
      }
      const decision = evaluatePlacement({
        requirements,
        candidates,
        reservations: pending.flatMap((task) =>
          task.placement
            ? [
                {
                  orderId: task.placement.snapshot.orderId,
                  physicalComputerId: task.placement.snapshot.physicalComputerId,
                  demand: task.placement.snapshot.demand,
                },
              ]
            : [],
        ),
        ...(existing ? { boundComputer: { computerId: existing.snapshot.computerId } } : {}),
      });
      const chosen = decision.chosen;
      const nameOf = (id: string | null) =>
        computers.find((row) => row.computerId === id)?.name ?? "The other computer";
      if (!chosen) {
        const held = floorHold(decision.candidates);
        wait = {
          wait: placementWait(
            decision.candidates.map((row) => ({
              name: nameOf(row.computerId),
              rejections: row.rejections,
              ...(row.connecting ? { connecting: true as const } : {}),
              capacity: row.capacity,
            })),
            requirements.demand,
          ),
          ...(held ? { held } : {}),
        };
        return undefined;
      }
      routed = this.options.router.commit(record.id, chosen.model);
      const model = chosen.model.result.choice;
      // A commitment names its model. The runtime default names none, so that
      // start takes the existing unrouted start there, the way it would with
      // routing off, and holds no reservation.
      if (!model) {
        onDefault = { computerId: chosen.computerId, name: nameOf(chosen.computerId) };
        return undefined;
      }
      // The chosen candidate is retained even for a fleet exceeding the explanation cap.
      const rows = [...decision.candidates]
        .sort(
          (a, b) =>
            Number(b.computerId === chosen.computerId) - Number(a.computerId === chosen.computerId),
        )
        .slice(0, 64);
      const snapshot: PlacementSnapshot = {
        version: 1,
        at: Date.now(),
        computerId: chosen.computerId,
        computerName: nameOf(chosen.computerId),
        physicalComputerId: chosen.physicalComputerId,
        orderId: `prepare:${randomUUID()}`,
        ...(origin ? { origin } : {}),
        demand: requirements.demand,
        model,
        acceptedFallback: options.ignoreAsk === true,
        requirements: {
          systems: requirements.systems,
          chips: requirements.chips,
          tools: requirements.tools,
          profile: requirements.profile,
        },
        candidateCount: decision.candidates.length,
        candidates: rows.map((row) => {
          const read =
            facts[computers.findIndex((computer) => computer.computerId === row.computerId)];
          return {
            computerId: row.computerId,
            name: nameOf(row.computerId),
            physicalComputerId: row.physicalComputerId,
            rejections: row.rejections,
            ...(row.connecting ? { connecting: true as const } : {}),
            missingTools: row.missingTools,
            reading: row.resources,
            factsAgeMs: read ? Math.max(0, now - read.started) : null,
            capacity: row.capacity,
            reserved: row.reserved,
            remaining: row.remaining,
            model: row.model?.result.choice ?? null,
            preferenceRank: Number.isFinite(row.model?.preferenceRank)
              ? (row.model?.preferenceRank ?? null)
              : null,
          };
        }),
      };
      return snapshot;
    });
    if (onDefault && routed) {
      this.options.tasks.note(record.id, placementReason({ computerName: onDefault.name }), {
        news: true,
        feed: true,
      });
      return { computerId: onDefault.computerId, routed };
    }
    if (!committed || !routed) return wait;
    const pool =
      facts[computers.findIndex((row) => row.computerId === committed.snapshot.computerId)]?.pool;
    return {
      computerId: committed.snapshot.computerId,
      ...(routed ? { routed } : {}),
      accountId: pool?.modelAccounts.get(
        `${committed.snapshot.model.provider}/${committed.snapshot.model.id}`,
      ),
    };
  }

  /** A sample begun after running was confirmed includes demand; never subtract it twice.
   * After restart/reconnect running must be witnessed again, then a NEW sample must follow.
   * A sample's start is the receiver's own, never rebuilt from its age and a second clock read.
   */
  reconcile(): void {
    const now = this.now();
    for (const task of this.options.tasks.pendingPlacements()) {
      const placement = task.placement;
      if (!placement || !this.options.running(task)) {
        this.runningSince.delete(task.id);
        continue;
      }
      const since = this.runningSince.get(task.id);
      if (since === undefined) {
        this.runningSince.set(task.id, now);
        continue;
      }
      const began = this.options.resources.sampledAt(placement.snapshot.computerId);
      // A witness taken just before a sample was asked for counts for that sample.
      if (began !== undefined && began >= since) {
        this.options.tasks.releasePlacement(task.id, placement.snapshot.orderId, "observed");
        this.runningSince.delete(task.id);
      }
    }
  }

  /** Notes each pending task running now, before a sample that will include it. */
  private witness(): void {
    const now = this.now();
    for (const task of this.options.tasks.pendingPlacements()) {
      if (!this.options.running(task)) this.runningSince.delete(task.id);
      else if (!this.runningSince.has(task.id)) this.runningSince.set(task.id, now);
    }
  }

  /** Late facts never overrule a changed task, parent choice or project. */
  private stillCurrent(record: TaskRecord, repo: RepoView): boolean {
    const current = this.options.tasks.get(record.id);
    if (
      !current ||
      current.status !== "open" ||
      current.branch ||
      current.sessionFile ||
      current.repoId !== record.repoId ||
      current.parentId !== record.parentId ||
      current.prompt !== record.prompt ||
      JSON.stringify(current.intent) !== JSON.stringify(record.intent) ||
      JSON.stringify(current.shape) !== JSON.stringify(record.shape) ||
      this.options.eligible?.(current) === false
    )
      return false;
    const latest = this.options.repo(repo.id);
    return Boolean(
      latest &&
        JSON.stringify([
          latest.path,
          latest.origin,
          latest.runsOn,
          latest.placementRequirements,
        ]) === JSON.stringify([repo.path, repo.origin, repo.runsOn, repo.placementRequirements]),
    );
  }

  private facts(
    id: string | null,
    repo: RepoView,
    tools: string[],
    origin?: string,
  ): Promise<Facts | null> {
    if (id && !speaksSince(this.options.work.version(id)?.contract ?? "", PLACEMENT_FACTS_SINCE))
      return Promise.resolve(null);
    const key = `${id ?? "home"}\n${JSON.stringify({ origin, tools, cwd: id === null ? repo.path : undefined })}`;
    const previous = this.reads.get(key);
    if (previous && this.now() - previous.started < 2_000) return previous.result;
    const started = this.now();
    const generation = id ? (this.generations.get(id) ?? 0) : 0;
    const request = { tools, ...(origin ? { origin } : {}) };
    const reading = id
      ? this.options.work.ask(id, PLACEMENT_FACTS_ORDER, [request]).then((raw) => {
          const answer = placementFactsAnswerSchema.parse(raw);
          return {
            facts: answer,
            pool: actualComputerPool(
              id,
              this.options.protectedIds
                ? narrowServedThere(answer.signIns, this.options.protectedIds)
                : answer.signIns,
              this.options.catalog(),
              Date.now(),
            ),
            started,
            generation,
          };
        })
      : (this.options.localFacts ?? readPlacementFacts)(request, repo.path).then((facts) => ({
          facts,
          started,
          generation,
        }));
    // Keep the ask single-flight even when it times out. A reconnect invalidates it.
    let done!: (value: Facts | null) => void;
    const result = new Promise<Facts | null>((resolve) => {
      done = resolve;
    });
    const timer = setTimeout(() => done(null), RESOURCE_READ_TIMEOUT_MS);
    timer.unref();
    const held = { result, started: Infinity };
    this.reads.set(key, held);
    void reading
      .then(
        (value) => done(value),
        () => done(null),
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.reads.get(key) === held) held.started = started;
      });
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
}
