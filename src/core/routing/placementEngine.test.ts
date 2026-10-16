import { HERE } from "@shared/deviceNames";
import {
  PLACEMENT_HELD_WAIT,
  PLACEMENT_MODEL_WAIT,
  type PlacementWait,
  placementWait,
} from "@shared/placement";
import { describe, expect, it } from "vitest";
import {
  evaluatePlacement,
  type PlacementCandidate,
  type PlacementReservation,
  resolvePlacementRequirements,
} from "./placementEngine";
import type { RoutePreview } from "./router";

const KIB = 1024;

/**
 * FI3-1733: a new task in an Automatic project waited for "a compatible
 * computer with room to start" on a 24 GiB Mac in ordinary use. The reading
 * is that Mac's own, as Electron's process.getSystemMemoryInfo() reported it
 * in KiB (SCR-380): macOS keeps almost no page empty, and hands back cached
 * file pages and purgeable memory without compressing or swapping.
 */
const thisMac: PlacementCandidate = {
  computerId: null,
  inReach: true,
  workEnabled: true,
  system: "macos",
  chip: "arm64",
  tools: { git: "available" },
  projectAccess: "available",
  physicalComputerId: "a".repeat(64),
  resources: {
    status: "fresh",
    ageMs: 50,
    observation: {
      epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
      sequence: 1,
      status: "sampled",
      sampleMs: 250,
      cpu: { logicalCpus: 10, idleFraction: 0.77 },
      memory: {
        totalBytes: 25_165_824 * KIB,
        freeBytes: 356_672 * KIB,
        purgeableBytes: 335_184 * KIB,
        fileBackedBytes: 6_852_624 * KIB,
      },
    },
  },
  model: {
    result: {
      choice: { provider: "anthropic-claude", id: "claude-opus-5-5" },
      bucket: "high",
      rule: "R1a",
    },
    reasons: [],
    preferenceRank: 0,
    requiresReasoningWait: false,
  } satisfies RoutePreview,
};

/** A paired computer too old to report what it can run: no facts at all. */
const olderMacMini: PlacementCandidate = {
  computerId: "mac-mini",
  inReach: true,
  workEnabled: true,
  tools: {},
  projectAccess: "unknown",
  physicalComputerId: null,
  resources: { status: "unknown", reason: "missing" },
  model: null,
};

describe("evaluatePlacement on a Mac in ordinary use", () => {
  it("starts a new standard task on this Mac when the other computer cannot take work", () => {
    const decision = evaluatePlacement({
      requirements: resolvePlacementRequirements({
        home: { system: "macos", chip: "arm64" },
        workingCopy: true,
      }),
      candidates: [thisMac, olderMacMini],
      reservations: [],
    });
    expect(decision.candidates[0]?.rejections).toEqual([]);
    expect(decision.status).toBe("chosen");
    expect(decision.chosen?.computerId).toBeNull();
  });
});

/**
 * INF-25 (recreated from FI3-1762, found on FI3-1757): a wait said "room"
 * whatever refused it, so the captain looked at free memory and Firstmate
 * guessed at the cause. A wait now names the check, read from the same
 * evaluation that refused the start.
 */
describe("placementWait names the check that refused a start", () => {
  const standard = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const fresh = thisMac.resources as Extract<PlacementCandidate["resources"], { status: "fresh" }>;
  /** This Mac with its reading changed as FI3-1757 measured it during another task's commands. */
  const busy = (
    cpu: Partial<typeof fresh.observation.cpu>,
    memory: Partial<typeof fresh.observation.memory> = {},
  ): PlacementCandidate => ({
    ...thisMac,
    resources: {
      ...fresh,
      observation: {
        ...fresh.observation,
        cpu: { ...fresh.observation.cpu, ...cpu },
        memory: { ...fresh.observation.memory, ...memory },
      },
    },
  });
  /** A standard start already committed to this Mac and not yet seen running. */
  const starting = (orderId: string): PlacementReservation => ({
    orderId,
    physicalComputerId: thisMac.physicalComputerId ?? "",
    demand: standard.demand,
  });
  const waitFor = (
    candidates: PlacementCandidate[],
    reservations: PlacementReservation[] = [],
  ): PlacementWait => {
    const decision = evaluatePlacement({ requirements: standard, candidates, reservations });
    expect(decision.status).toBe("waiting");
    return placementWait(
      decision.candidates.map((row) => ({
        name: row.computerId === null ? HERE.This : "Mac mini",
        rejections: row.rejections,
        capacity: row.capacity,
      })),
      standard.demand,
    );
  };

  it("names processing capacity while another task's lint holds every core", () => {
    // FI3-1756's tries fell inside FI3-1755's lint, which read 0% idle.
    const { kind, words } = waitFor([busy({ idleFraction: 0 }), olderMacMini]);
    expect(kind).toBe("room");
    expect(words).toContain("processing capacity");
    expect(words).not.toContain("memory");
  });

  it("names memory while another task's typecheck holds this Mac's memory", () => {
    // A cold typecheck took 3.2 GiB of the memory macOS hands back.
    const { kind, words } = waitFor([busy({}, { fileBackedBytes: (6_852_624 - 3_355_443) * KIB })]);
    expect(kind).toBe("room");
    expect(words).toContain("memory");
    expect(words).not.toContain("processing capacity");
  });

  it("names the room set aside for tasks that are starting when this Mac's own reading has room", () => {
    // FI3-1741's shape: two standard starts leave 0.8 of this Mac's 4.8 GiB.
    expect(waitFor([thisMac], [starting("prepare:footer"), starting("prepare:totals")])).toEqual({
      kind: "room",
      words: PLACEMENT_HELD_WAIT,
    });
  });

  it("names each computer's own reasons when none could take it for room alone", () => {
    const stale: PlacementCandidate = {
      ...thisMac,
      resources: { status: "unknown", reason: "stale" },
    };
    const { kind, words } = waitFor([stale, olderMacMini]);
    expect(kind).toBe("other");
    expect(words).toContain(`${HERE.This}: resource reading was too old.`);
    expect(words).toContain("Mac mini: ");
  });

  it("still names the model when a computer was refused only for its model", () => {
    const noModel: PlacementCandidate = {
      ...thisMac,
      model: { ...(thisMac.model as RoutePreview), preferenceRank: Number.POSITIVE_INFINITY },
    };
    expect(waitFor([noModel])).toEqual({ kind: "model", words: PLACEMENT_MODEL_WAIT });
  });
});

describe("a computer refused for its connection", () => {
  it("is out of reach either way, marked connecting only while its connection is being made", () => {
    const evaluated = (candidate: PlacementCandidate) =>
      evaluatePlacement({
        requirements: resolvePlacementRequirements({
          home: { system: "macos", chip: "arm64" },
          workingCopy: true,
        }),
        candidates: [thisMac, candidate],
        reservations: [],
      }).candidates[1];
    const connecting = evaluated({ ...olderMacMini, inReach: false, connecting: true });
    expect(connecting?.rejections).toContain("out-of-reach");
    expect(connecting?.connecting).toBe(true);
    const gone = evaluated({ ...olderMacMini, inReach: false });
    expect(gone?.rejections).toContain("out-of-reach");
    expect(gone?.connecting).toBeUndefined();
  });

  it("reads connecting in a waiting start's words for a computer whose connection is being made", () => {
    const wait = (connecting: true | undefined) =>
      placementWait(
        [
          {
            name: "Mac mini",
            rejections: ["out-of-reach"],
            ...(connecting ? { connecting } : {}),
            capacity: null,
          },
        ],
        { cpu: 0.5, memoryBytes: 2 * 1024 ** 3 },
      ).words;
    expect(wait(true)).toContain("Mac mini: connecting.");
    expect(wait(undefined)).toContain("Mac mini: out of reach.");
  });
});
