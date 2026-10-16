import type { DeviceChip, DeviceSystem } from "@shared/devices";
import {
  PLACEMENT_DEMANDS,
  type PlacementDemand,
  type PlacementFact,
  type PlacementProfile,
  type PlacementRejection,
  type PlacementRequirements,
  type PlacementSystem,
  placementFloorHold,
} from "@shared/placement";
import {
  RESOURCE_MAX_AGE_MS,
  resourceObservationSchema,
  validResourceMemory,
} from "@shared/resources";
import type { ComputerResourceReading } from "../placed/computerResources";
import type { RoutePreview, RouteResult } from "./router";

export type ResolvedPlacementRequirements = {
  /** Empty means unresolved or conflicting, never unrestricted. */
  systems: PlacementSystem[];
  chips: DeviceChip[];
  tools: string[];
  profile: PlacementProfile;
  demand: PlacementDemand;
};

/** Resolve declarations only. Task platform refinements intersect the project's. */
export function resolvePlacementRequirements(input: {
  project?: PlacementRequirements;
  task?: PlacementRequirements;
  home: { system?: DeviceSystem; chip?: DeviceChip };
  /** Git is a substrate requirement for a project working copy. */
  workingCopy: boolean;
}): ResolvedPlacementRequirements {
  const { project, task, home } = input;
  const intersect = <T>(base: T[] | undefined, refinement: T[] | undefined, fallback: T[]): T[] =>
    base && refinement
      ? base.filter((value) => refinement.includes(value))
      : [...(refinement ?? base ?? fallback)];
  const systems = intersect<PlacementSystem>(
    project?.systems,
    task?.systems,
    home.system === "macos" || home.system === "linux" ? [home.system] : [],
  );
  const chips = intersect(project?.chips, task?.chips, home.chip ? [home.chip] : []);
  const requestedProfile = task?.profile ?? project?.profile ?? "standard";
  // A task may request more than the project's budget, never less.
  const projectProfile = project?.profile ?? requestedProfile;
  const profile =
    PLACEMENT_DEMANDS[projectProfile].cpu > PLACEMENT_DEMANDS[requestedProfile].cpu
      ? projectProfile
      : requestedProfile;
  return {
    systems,
    chips,
    tools: [
      ...new Set([
        ...(input.workingCopy ? ["git"] : []),
        ...(project?.tools ?? []),
        ...(task?.tools ?? []),
      ]),
    ].sort(),
    profile,
    demand: { ...PLACEMENT_DEMANDS[profile] },
  };
}

export type PlacementCandidate = {
  /** Null is the home, treated equally by every filter and comparison. */
  computerId: string | null;
  inReach: boolean;
  /** Connected on an older Firstmate, so it takes no new work: not out of reach. */
  olderFirstmate?: boolean;
  /** Out of reach only because its connection is being made: still refused as out of reach, and marked so it reads connecting. */
  connecting?: boolean;
  workEnabled: boolean;
  system?: DeviceSystem;
  /** Execution architecture, not a guess about the underlying hardware. */
  chip?: DeviceChip;
  tools: Readonly<Record<string, PlacementFact>>;
  /** Access to the particular project being evaluated, not merely a forge login. */
  projectAccess: PlacementFact;
  /** Known physical sharing group. No name/address/OS heuristic may supply this. */
  physicalComputerId: string | null;
  resources: ComputerResourceReading;
  /** From this computer's own routing pool; null means no current model facts. */
  model: RoutePreview | null;
  /**
   * This computer starts a task its routing names no model for on its own
   * runtime default, as a This computer project's task starts. The caller
   * declares it; absent, a computer needs a model its own sign-ins serve.
   */
  runtimeDefault?: boolean;
};

/**
 * Pending demand not yet represented by the physical computer's observation.
 * The dispatch owner must hold it across uncertain preparation and reconcile it
 * before release. Already observed running work is not subtracted a second time.
 */
export type PlacementReservation = {
  orderId: string;
  physicalComputerId: string;
  demand: PlacementDemand;
};

export type PlacementEvaluation = {
  computerId: string | null;
  physicalComputerId: string | null;
  rejections: PlacementRejection[];
  /** Refused as out of reach only because its connection was being made. */
  connecting?: true;
  /** Exact tool identities for the typed missing-tool reasons. */
  missingTools: string[];
  resources: ComputerResourceReading;
  model: RoutePreview | null;
  capacity: PlacementDemand | null;
  reserved: PlacementDemand;
  remaining: PlacementDemand | null;
  /** Headroom in units of this task's demand; the limiting resource wins. */
  score: number | null;
};

export type PlacementDecision = {
  status: "chosen" | "waiting";
  /** Present only on chosen, since null itself names the home. */
  chosen?: { computerId: string | null; model: RoutePreview; physicalComputerId: string };
  requirements: ResolvedPlacementRequirements;
  candidates: PlacementEvaluation[];
};

/**
 * Side-effect-free admission policy. No sampling, account access, task writes or
 * starts occur here. The caller must evaluate and reserve atomically before any
 * asynchronous preparation; this result by itself grants no start permission.
 */
export function evaluatePlacement(input: {
  requirements: ResolvedPlacementRequirements;
  candidates: readonly PlacementCandidate[];
  reservations: readonly PlacementReservation[];
  /** Explicit task/parent/review/local-only binding, resolved by the existing owner. */
  boundComputer?: { computerId: string | null };
}): PlacementDecision {
  const { requirements } = input;
  const groups = new Map<string, PlacementDemand>();
  // Multiple users on one physical machine never add capacity. Use the smallest
  // fresh estimate, including a peer whose own model/project cannot serve this task.
  for (const candidate of input.candidates) {
    if (!candidate.inReach || !candidate.workEnabled || !candidate.physicalComputerId) continue;
    const capacity = capacityOf(candidate);
    if (!capacity) continue;
    const held = groups.get(candidate.physicalComputerId);
    groups.set(candidate.physicalComputerId, held ? minimum(held, capacity) : capacity);
  }
  const reservations = reservationTotals(input.reservations);
  const evaluations: PlacementEvaluation[] = input.candidates.map((candidate) => {
    const rejections: PlacementRejection[] = [];
    if (!validDemand(requirements.demand)) rejections.push("requirements-invalid");
    if (!candidate.inReach)
      rejections.push(candidate.olderFirstmate ? "older-firstmate" : "out-of-reach");
    if (!candidate.workEnabled) rejections.push("work-disabled");
    if (input.boundComputer && candidate.computerId !== input.boundComputer.computerId)
      rejections.push("bound-elsewhere");
    if (
      !candidate.system ||
      !candidate.chip ||
      !requirements.systems.length ||
      !requirements.chips.length
    )
      rejections.push("platform-unknown");
    if (candidate.system && !requirements.systems.some((system) => system === candidate.system))
      rejections.push("system-incompatible");
    if (candidate.chip && !requirements.chips.includes(candidate.chip))
      rejections.push("chip-incompatible");
    const missingTools = requirements.tools.filter((tool) => candidate.tools[tool] !== "available");
    if (missingTools.some((tool) => candidate.tools[tool] === "unavailable"))
      rejections.push("tool-unavailable");
    if (missingTools.some((tool) => !candidate.tools[tool] || candidate.tools[tool] === "unknown"))
      rejections.push("tool-unknown");
    if (candidate.projectAccess !== "available")
      rejections.push(
        candidate.projectAccess === "unknown" ? "project-unknown" : "project-unavailable",
      );
    if (!candidate.model) rejections.push("model-unknown");
    else if (
      candidate.model.result.choice
        ? !Number.isFinite(candidate.model.preferenceRank)
        : !candidate.runtimeDefault
    )
      rejections.push("model-unavailable");
    else if (candidate.model.requiresReasoningWait) rejections.push("model-floor");
    if (!candidate.physicalComputerId) rejections.push("physical-computer-unknown");
    const resourceProblem = resourceRejection(candidate.resources);
    if (resourceProblem) rejections.push(resourceProblem);
    else if (!capacityOf(candidate)) rejections.push("memory-unavailable");
    if (!reservations) rejections.push("reservations-invalid");
    const capacity = groups.get(candidate.physicalComputerId ?? "") ?? null;
    const reserved = reservations?.get(candidate.physicalComputerId ?? "") ?? {
      cpu: 0,
      memoryBytes: 0,
    };
    const remaining = capacity
      ? {
          cpu: Math.max(0, capacity.cpu - reserved.cpu),
          memoryBytes: Math.max(0, capacity.memoryBytes - reserved.memoryBytes),
        }
      : null;
    return {
      computerId: candidate.computerId,
      physicalComputerId: candidate.physicalComputerId,
      rejections,
      ...(candidate.connecting && !candidate.inReach && !candidate.olderFirstmate
        ? { connecting: true as const }
        : {}),
      missingTools,
      resources: candidate.resources,
      model: candidate.model,
      capacity,
      reserved,
      remaining,
      score: null,
    };
  });
  // Preserve the best model preference among compatible, fresh computers BEFORE
  // looking at admission space. A busy requested model waits, never silently
  // downgrades to an idle computer. Stale/unknown/incompatible computers cannot win.
  // A runtime default names no model, so it ranks after every computer that names one.
  const compatible = evaluations.filter((candidate) => candidate.rejections.length === 0);
  const rank = (candidate: PlacementEvaluation) =>
    candidate.model?.result.choice ? candidate.model.preferenceRank : Infinity;
  const preference = Math.min(...compatible.map(rank));
  for (const candidate of compatible) {
    if (rank(candidate) !== preference) candidate.rejections.push("model-preferred-elsewhere");
    if (!candidate.remaining) continue;
    if (candidate.remaining.cpu < requirements.demand.cpu) candidate.rejections.push("cpu-busy");
    if (candidate.remaining.memoryBytes < requirements.demand.memoryBytes)
      candidate.rejections.push("memory-busy");
    candidate.score = Math.min(
      candidate.remaining.cpu / requirements.demand.cpu,
      candidate.remaining.memoryBytes / requirements.demand.memoryBytes,
    );
  }
  const ranked = compatible
    .filter((candidate) => candidate.rejections.length === 0)
    .sort((a, b) => {
      const capacity = (b.score ?? 0) - (a.score ?? 0);
      if (capacity) return capacity;
      // Stable independent of input order; no home-fallback or home preference.
      const aKey = a.computerId ?? "";
      const bKey = b.computerId ?? "";
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const chosen = ranked[0];
  return {
    status: chosen ? "chosen" : "waiting",
    ...(chosen?.model && chosen.physicalComputerId
      ? {
          chosen: {
            computerId: chosen.computerId,
            model: chosen.model,
            physicalComputerId: chosen.physicalComputerId,
          },
        }
      : {}),
    requirements,
    candidates: evaluations,
  };
}

/**
 * The route a waiting decision holds on when it waits for the level its task
 * asked for (`placementFloorHold`), read from the computers refused for that
 * level alone: one with a model placed at the level first, since its reset
 * can end the wait, then one whose routing names a model, then the strongest
 * preference. Undefined when the wait is anything else.
 */
export function floorHold(candidates: readonly PlacementEvaluation[]): RouteResult | undefined {
  if (!placementFloorHold(candidates.map((row) => row.rejections))) return undefined;
  const held = candidates
    .filter((row) => row.rejections.every((reason) => reason === "model-floor"))
    .flatMap((row) => (row.model ? [row.model] : []))
    .sort(
      (a, b) =>
        Number(Boolean(a.result.emptyBucket)) - Number(Boolean(b.result.emptyBucket)) ||
        Number(!a.result.choice) - Number(!b.result.choice) ||
        a.preferenceRank - b.preferenceRank,
    );
  return held[0]?.result;
}

function resourceRejection(reading: ComputerResourceReading): PlacementRejection | null {
  if (reading.status !== "fresh")
    return reading.reason === "stale" ? "resources-stale" : "resources-unknown";
  if (!Number.isFinite(reading.ageMs) || reading.ageMs < 0 || reading.ageMs > RESOURCE_MAX_AGE_MS)
    return "resources-stale";
  if (
    !resourceObservationSchema.safeParse(reading.observation).success ||
    !validResourceMemory(reading.observation.memory)
  )
    return "resources-invalid";
  return null;
}

/** OS-specific usable-memory guidance, never a claim that a Mac reports Linux's estimate. */
function capacityOf(candidate: PlacementCandidate): PlacementDemand | null {
  const reading = candidate.resources;
  if (resourceRejection(reading) || reading.status !== "fresh") return null;
  const { cpu, memory } = reading.observation;
  const usable =
    candidate.system === "linux"
      ? memory.availableBytes
      : candidate.system === "macos"
        ? // A Mac in ordinary use keeps almost no page empty. Cached file pages
          // and purgeable memory are what it hands back without compressing or
          // swapping, so free pages alone read a Mac with room as full.
          Math.min(
            memory.totalBytes,
            memory.freeBytes + (memory.purgeableBytes ?? 0) + (memory.fileBackedBytes ?? 0),
          )
        : undefined;
  if (usable === undefined) return null;
  return {
    // Leave 20% of observed idle CPU and at least 512 MiB/10% of RAM untouched.
    cpu: cpu.logicalCpus * cpu.idleFraction * 0.8,
    memoryBytes: Math.max(
      0,
      Math.floor(usable - Math.max(512 * 1024 ** 2, memory.totalBytes * 0.1)),
    ),
  };
}

function validDemand(demand: PlacementDemand): boolean {
  return (
    Number.isFinite(demand.cpu) &&
    demand.cpu > 0 &&
    Number.isSafeInteger(demand.memoryBytes) &&
    demand.memoryBytes > 0
  );
}

function minimum(a: PlacementDemand, b: PlacementDemand): PlacementDemand {
  return { cpu: Math.min(a.cpu, b.cpu), memoryBytes: Math.min(a.memoryBytes, b.memoryBytes) };
}

function reservationTotals(
  reservations: readonly PlacementReservation[],
): Map<string, PlacementDemand> | null {
  const totals = new Map<string, PlacementDemand>();
  const orders = new Map<string, PlacementReservation>();
  for (const reservation of reservations) {
    const { orderId, physicalComputerId, demand } = reservation;
    if (!orderId || !physicalComputerId || !validDemand(demand)) return null;
    const previous = orders.get(orderId);
    if (previous) {
      // Idempotent repetitions count once; contradictory accounting fails closed.
      if (
        previous.physicalComputerId !== physicalComputerId ||
        previous.demand.cpu !== demand.cpu ||
        previous.demand.memoryBytes !== demand.memoryBytes
      )
        return null;
      continue;
    }
    orders.set(orderId, reservation);
    const held = totals.get(physicalComputerId) ?? { cpu: 0, memoryBytes: 0 };
    const sum = { cpu: held.cpu + demand.cpu, memoryBytes: held.memoryBytes + demand.memoryBytes };
    if (!Number.isFinite(sum.cpu) || !Number.isSafeInteger(sum.memoryBytes)) return null;
    totals.set(physicalComputerId, sum);
  }
  return totals;
}
