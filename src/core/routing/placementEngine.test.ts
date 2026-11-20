import { HERE } from "@shared/deviceNames";
import {
  PLACEMENT_HELD_WAIT,
  PLACEMENT_MODEL_WAIT,
  type PlacementRequirements,
  type PlacementWait,
  placementNamedModelWait,
  placementWait,
} from "@shared/placement";
import { describe, expect, it } from "vitest";
import { memoryUsedBytes } from "../placed/memoryUsed";
import {
  evaluatePlacement,
  floorHold,
  leftOutComputers,
  type PlacementCandidate,
  type PlacementReservation,
  resolvePlacementRequirements,
} from "./placementEngine";
import type { RoutePreview, RouteResult } from "./router";

/** INF-396: a hand-built reading takes its figure from the core function, never a typed number. */
function figured(candidate: PlacementCandidate): PlacementCandidate {
  const reading = candidate.resources;
  if (reading.status !== "fresh") return candidate;
  const used = memoryUsedBytes(reading.observation.memory);
  if (used === undefined) return candidate;
  return { ...candidate, resources: { ...reading, memoryUsedBytes: used } };
}

const KIB = 1024;

/**
 * FI3-1733: a new task in an Automatic project waited for "a compatible
 * computer with room to start" on a 24 GiB Mac in ordinary use. The reading
 * is that Mac's own, as Electron's process.getSystemMemoryInfo() reported it
 * in KiB (SCR-380): macOS keeps almost no page empty, and hands back cached
 * file pages and purgeable memory without compressing or swapping.
 */
const thisMac: PlacementCandidate = figured({
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
});

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
 * INF-1456: a person added an Intel Mac mini beside their Apple-silicon
 * MacBook and expected Automatic to use it. Their project declared no
 * computer requirements, so the chip was filled from the MacBook's own and
 * the mini was refused at every start, with nothing said but one line in
 * Task Details. The comparison now says which added computer it left out and
 * why, and the project change that lets it in.
 */
describe("leftOutComputers on a project that declares no computer requirements", () => {
  const intelMini: PlacementCandidate = {
    ...thisMac,
    computerId: "mac-mini",
    chip: "x64",
    physicalComputerId: "b".repeat(64),
  };
  const compare = (project?: PlacementRequirements, mini = intelMini) => {
    const requirements = resolvePlacementRequirements({
      ...(project ? { project } : {}),
      home: { system: "macos", chip: "arm64" },
      workingCopy: true,
    });
    const candidates = [thisMac, mini];
    const decision = evaluatePlacement({ requirements, candidates, reservations: [] });
    return {
      decision,
      leftOut: leftOutComputers({
        project,
        requirements,
        candidates,
        evaluations: decision.candidates,
      }),
    };
  };

  it("leaves the Intel Mac mini out for this Mac's inherited chip, with both chips as the way in", () => {
    const { decision, leftOut } = compare();
    expect(decision.chosen?.computerId).toBeNull();
    expect(leftOut).toEqual([
      {
        computerId: "mac-mini",
        system: "macos",
        chip: "x64",
        reasons: [{ kind: "chip", runs: "x64", heldTo: ["arm64"], heldOn: "macos" }],
        widened: { chips: ["arm64", "x64"] },
      },
    ]);
  });

  it("compares the mini equally once the project takes that change", () => {
    const widened = compare().leftOut[0]?.widened;
    const { decision, leftOut } = compare(widened);
    expect(
      decision.candidates.find((row) => row.computerId === "mac-mini")?.rejections,
    ).not.toContain("chip-incompatible");
    expect(leftOut).toEqual([]);
  });

  it("says nothing about a chip the project declared", () => {
    expect(compare({ chips: ["arm64"] }).leftOut).toEqual([]);
  });

  it("names a missing program, with no project change to offer", () => {
    const { leftOut } = compare(
      { chips: ["arm64", "x64"] },
      { ...intelMini, tools: { git: "unavailable" } },
    );
    expect(leftOut).toEqual([
      {
        computerId: "mac-mini",
        system: "macos",
        chip: "x64",
        reasons: [{ kind: "programs", missing: ["git"] }],
      },
    ]);
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
  ): PlacementCandidate =>
    figured({
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
  it("is out of reach either way, carrying its reach as it came", () => {
    const evaluated = (candidate: PlacementCandidate) =>
      evaluatePlacement({
        requirements: resolvePlacementRequirements({
          home: { system: "macos", chip: "arm64" },
          workingCopy: true,
        }),
        candidates: [thisMac, candidate],
        reservations: [],
      }).candidates[1];
    const connecting = evaluated({ ...olderMacMini, inReach: false, reach: "connecting" });
    expect(connecting?.rejections).toContain("out-of-reach");
    expect(connecting?.reach).toBe("connecting");
    const gone = evaluated({ ...olderMacMini, inReach: false, reach: "reconnecting" });
    expect(gone?.rejections).toContain("out-of-reach");
    expect(gone?.reach).toBe("reconnecting");
  });

  it("reads connecting in a waiting start's words for a computer whose connection is being made", () => {
    const wait = (connecting: true | undefined) =>
      placementWait(
        [
          {
            name: "Mac mini",
            rejections: ["out-of-reach"],
            ...(connecting ? { reach: "connecting" as const } : {}),
            capacity: null,
          },
        ],
        { cpu: 0.5, memoryBytes: 2 * 1024 ** 3 },
      ).words;
    expect(wait(true)).toContain("Mac mini: connecting.");
    expect(wait(undefined)).toContain("Mac mini: out of reach.");
  });
});

/**
 * INF-213, the build approved on INF-212: count a Mac's inactive memory while
 * macOS reports normal pressure, and none once it warns. The page counts are
 * the real 4:10:05 PM reading of this MacBook (16 KiB pages, 24 GiB installed).
 */
const MACBOOK_PAGE = 16_384;
const MACBOOK_TOTAL = 24 * 1024 ** 3;
describe("evaluatePlacement counts inactive memory until macOS warns", () => {
  const standard = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const pages = {
    free: 15_979,
    speculative: 13_408,
    inactive: 553_134,
    purgeable: 18_976,
    fileBacked: 265_899,
  };
  const bytes = (count: number) => count * MACBOOK_PAGE;
  const macBook = (pressure: "normal" | "warning" | "critical" | undefined): PlacementCandidate =>
    figured({
      ...thisMac,
      resources: {
        status: "fresh",
        ageMs: 50,
        observation: {
          ...(thisMac.resources as Extract<PlacementCandidate["resources"], { status: "fresh" }>)
            .observation,
          memory: {
            totalBytes: MACBOOK_TOTAL,
            freeBytes: bytes(pages.free),
            purgeableBytes: bytes(pages.purgeable),
            fileBackedBytes: bytes(pages.fileBacked),
            ...(pressure
              ? {
                  inactiveBytes: bytes(pages.inactive),
                  speculativeBytes: bytes(pages.speculative),
                  memoryPressure: pressure,
                }
              : {}),
          },
        },
      },
    });
  const room = (candidate: PlacementCandidate) => {
    const decision = evaluatePlacement({
      requirements: standard,
      candidates: [candidate],
      reservations: [],
    });
    return decision.candidates[0];
  };
  const tasks = (memoryBytes: number) => memoryBytes / standard.demand.memoryBytes;

  it("fits about 3.2 standard tasks at normal pressure, against 1.1 without the new facts", () => {
    const normal = room(macBook("normal"));
    const today = room(macBook(undefined));
    expect(normal?.rejections).toEqual([]);
    expect(today?.rejections).toEqual([]);
    expect(tasks(normal?.remaining?.memoryBytes ?? 0)).toBeGreaterThan(3.1);
    expect(tasks(normal?.remaining?.memoryBytes ?? 0)).toBeLessThan(3.3);
    expect(tasks(today?.remaining?.memoryBytes ?? 0)).toBeGreaterThan(1);
    expect(tasks(today?.remaining?.memoryBytes ?? 0)).toBeLessThan(1.2);
    expect(normal?.remaining?.memoryBytes).toBeGreaterThan(today?.remaining?.memoryBytes ?? 0);
  });

  it("has no memory room at warning, and the wait still names spare memory", () => {
    const warned = room(macBook("warning"));
    expect(warned?.rejections).toEqual(["memory-busy"]);
    expect(warned?.remaining?.memoryBytes).toBe(0);
    const decision = evaluatePlacement({
      requirements: standard,
      candidates: [macBook("warning")],
      reservations: [],
    });
    expect(decision.status).toBe("waiting");
    const words = placementWait(
      decision.candidates.map((row) => ({
        name: HERE.This,
        rejections: row.rejections,
        capacity: row.capacity,
      })),
      standard.demand,
    ).words;
    expect(words).toContain("spare memory");
    expect(words).not.toContain("processing capacity");
  });

  it("has no memory room at critical pressure", () => {
    expect(room(macBook("critical"))?.remaining?.memoryBytes).toBe(0);
    expect(room(macBook("critical"))?.rejections).toEqual(["memory-busy"]);
  });
});

/**
 * Kun's Mac mini at 4:31 PM, pressure normal, 64 GiB. The plan's 4:08 PM
 * vm_stat stopped before file-backed pages. On this complete reading, free,
 * purgeable and cached files already exceed free, speculative and inactive,
 * so the new rule must not read less room than today.
 */
describe("evaluatePlacement does not shrink the Mac mini's room", () => {
  const page = 16_384;
  const reading = {
    free: 1_619_854,
    speculative: 104_548,
    inactive: 984_027,
    purgeable: 12_179,
    fileBacked: 1_101_024,
  };
  const bytes = (count: number) => count * page;
  const mini = (withFacts: boolean): PlacementCandidate =>
    figured({
      ...thisMac,
      computerId: "mac-mini",
      resources: {
        status: "fresh",
        ageMs: 40,
        observation: {
          ...(thisMac.resources as Extract<PlacementCandidate["resources"], { status: "fresh" }>)
            .observation,
          memory: {
            totalBytes: 68_719_476_736,
            freeBytes: bytes(reading.free),
            purgeableBytes: bytes(reading.purgeable),
            fileBackedBytes: bytes(reading.fileBacked),
            ...(withFacts
              ? {
                  inactiveBytes: bytes(reading.inactive),
                  speculativeBytes: bytes(reading.speculative),
                  memoryPressure: "normal" as const,
                }
              : {}),
          },
        },
      },
    });
  const memoryOf = (candidate: PlacementCandidate) =>
    evaluatePlacement({
      requirements: resolvePlacementRequirements({
        home: { system: "macos", chip: "arm64" },
        workingCopy: true,
      }),
      candidates: [candidate],
      reservations: [],
    }).candidates[0]?.remaining?.memoryBytes;

  it("reads no less room than today's sum on the same reading", () => {
    const today = memoryOf(mini(false));
    const counted = memoryOf(mini(true));
    expect(today).toBeGreaterThan(0);
    expect(counted).toBeGreaterThanOrEqual(today ?? 0);
  });
});

/**
 * INF-396: Automatic's room starts from the figure on the reading. A missing
 * figure is refused, and a figure above installed memory is not a reading.
 */
describe("evaluatePlacement reads the one memory figure", () => {
  const requirements = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const evaluated = (candidate: PlacementCandidate) =>
    evaluatePlacement({ requirements, candidates: [candidate], reservations: [] }).candidates[0];
  const fresh = thisMac.resources as Extract<PlacementCandidate["resources"], { status: "fresh" }>;

  it("takes room from the stamped figure, not a second sum of the raw counts", () => {
    expect(evaluated(thisMac)?.remaining?.memoryBytes).toBeGreaterThan(0);
    const full = evaluated({
      ...thisMac,
      resources: { ...fresh, memoryUsedBytes: fresh.observation.memory.totalBytes },
    });
    expect(full?.rejections).toEqual(["memory-busy"]);
    expect(full?.remaining?.memoryBytes).toBe(0);
  });

  it("refuses a fresh reading that has no figure", () => {
    const { memoryUsedBytes: _dropped, ...resources } = fresh;
    expect(evaluated({ ...thisMac, resources })?.rejections).toContain("memory-unavailable");
  });

  it("refuses a figure above installed memory", () => {
    expect(
      evaluated({
        ...thisMac,
        resources: { ...fresh, memoryUsedBytes: fresh.observation.memory.totalBytes + 1 },
      })?.rejections,
    ).toContain("resources-invalid");
  });
});

/** INF-1870 approved: model-first, Automatic-only locality, never an admission bypass. */
describe("the basis computer's soft preference", () => {
  const requirements = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const remote: PlacementCandidate = {
    ...thisMac,
    computerId: "mac-mini",
    physicalComputerId: "b".repeat(64),
  };
  const pending = (computer: PlacementCandidate, times = 1): PlacementReservation[] => [
    {
      orderId: "preparing",
      physicalComputerId: computer.physicalComputerId!,
      demand: {
        cpu: requirements.demand.cpu * times,
        memoryBytes: requirements.demand.memoryBytes * times,
      },
    },
  ];

  it.each([thisMac, remote])(
    "prefers $computerId to a computer with more room, without rejecting that computer",
    (basis) => {
      const input = { requirements, candidates: [remote, thisMac], reservations: pending(basis) };
      const ordinary = evaluatePlacement(input);
      expect(ordinary.chosen?.computerId).not.toBe(basis.computerId);
      const beside = evaluatePlacement({
        ...input,
        basisComputer: { computerId: basis.computerId },
      });
      expect(beside.chosen?.computerId).toBe(basis.computerId);
      expect(beside.basisPreferred).toBe(true);
      expect(beside.candidates.every((candidate) => candidate.rejections.length === 0)).toBe(true);
    },
  );

  it.each([
    { inReach: false },
    { workEnabled: false },
    { system: "linux" as const },
    { chip: "x64" as const },
    { tools: { git: "unavailable" as const } },
    { projectAccess: "unknown" as const },
    { resources: { status: "unknown" as const, reason: "missing" as const } },
    { resources: { status: "unknown" as const, reason: "stale" as const } },
    { model: null },
    { model: { ...thisMac.model!, requiresReasoningWait: true } },
  ])("falls back without a locality wait when the basis cannot qualify: %j", (over) => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [thisMac, { ...remote, ...over }],
      reservations: [],
      basisComputer: { computerId: remote.computerId },
    });
    expect(decision.chosen?.computerId).toBeNull();
    expect(decision.basisPreferred).toBe(false);
  });

  it("keeps model preference elsewhere, including its existing wait when busy", () => {
    const lesser = { ...thisMac, model: { ...thisMac.model!, preferenceRank: 1 } };
    const input = {
      requirements,
      candidates: [lesser, remote],
      basisComputer: { computerId: null },
    };
    expect(evaluatePlacement({ ...input, reservations: [] }).chosen?.computerId).toBe(
      remote.computerId,
    );
    const busy = evaluatePlacement({ ...input, reservations: pending(remote, 3) });
    expect(busy.status).toBe("waiting");
    expect(busy.candidates.find((row) => row.computerId === null)?.rejections).toContain(
      "model-preferred-elsewhere",
    );
  });

  it("falls back from insufficient room but never from an explicit binding", () => {
    const input = {
      requirements,
      candidates: [thisMac, remote],
      reservations: pending(remote, 3),
      basisComputer: { computerId: remote.computerId },
    };
    expect(evaluatePlacement(input).chosen?.computerId).toBeNull();
    expect(
      evaluatePlacement({ ...input, boundComputer: { computerId: remote.computerId } }).status,
    ).toBe("waiting");
    expect(
      evaluatePlacement({ ...input, reservations: [], boundComputer: { computerId: null } }).chosen
        ?.computerId,
    ).toBeNull();
  });

  it("preserves ordinary stable tie-breaking when the basis is absent or excluded", () => {
    for (const candidates of [
      [thisMac, remote],
      [remote, thisMac],
    ]) {
      const input = { requirements, candidates, reservations: [] };
      const ordinary = evaluatePlacement(input);
      const excluded = evaluatePlacement({ ...input, basisComputer: { computerId: "removed" } });
      expect(ordinary.chosen?.computerId).toBeNull();
      expect(excluded).toEqual(ordinary);
      expect(ordinary.basisPreferred).toBe(false);
    }
  });

  it("falls back from exhausted processor reservations without bypassing admission", () => {
    if (remote.resources.status !== "fresh") throw new Error("The captured reading is missing.");
    const decision = evaluatePlacement({
      requirements,
      candidates: [thisMac, remote],
      basisComputer: { computerId: remote.computerId },
      reservations: [
        {
          orderId: "processor-start",
          physicalComputerId: remote.physicalComputerId ?? "",
          demand: {
            cpu: remote.resources.observation.cpu.logicalCpus,
            memoryBytes: requirements.demand.memoryBytes,
          },
        },
      ],
    });
    expect(decision.chosen?.computerId).toBeNull();
    expect(
      decision.candidates.find((row) => row.computerId === remote.computerId)?.rejections,
    ).toEqual(["cpu-busy"]);
  });
});

// INF-1729, direction A: the decision model picks among the computers that
// can run the task, reading the captain's standing directions; the app keeps
// every hard fact and falls back to the ordinary rules.
describe("the decision model's pick", () => {
  const requirements = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const macMini: PlacementCandidate = {
    ...thisMac,
    computerId: "mac-mini",
    physicalComputerId: "b".repeat(64),
  };
  const fill = (computer: PlacementCandidate): PlacementReservation[] => [
    {
      orderId: "preparing",
      physicalComputerId: computer.physicalComputerId ?? "",
      demand: {
        cpu: requirements.demand.cpu * 3,
        memoryBytes: requirements.demand.memoryBytes * 3,
      },
    },
  ];
  const base = { requirements, candidates: [thisMac, macMini] };

  it("starts on the picked computer over the ordinary winner and its better model", () => {
    const lesser = { ...macMini, model: { ...thisMac.model!, preferenceRank: 1 } };
    const decision = evaluatePlacement({
      requirements,
      candidates: [thisMac, lesser],
      reservations: [],
      pick: { computerId: "mac-mini", mode: "start" },
    });
    expect(decision.chosen?.computerId).toBe("mac-mini");
    expect(decision.picked).toBe("start");
    expect(decision.basisPreferred).toBe(false);
  });

  it("starts on a busy picked computer, as naming it does", () => {
    const decision = evaluatePlacement({
      ...base,
      reservations: fill(macMini),
      pick: { computerId: "mac-mini", mode: "start" },
    });
    expect(decision.chosen?.computerId).toBe("mac-mini");
  });

  it("waits for room on a busy picked computer, and starts there once it has room", () => {
    const pick = { computerId: "mac-mini", mode: "wait" as const };
    const busy = evaluatePlacement({ ...base, reservations: fill(macMini), pick });
    expect(busy.status).toBe("waiting");
    expect(busy.picked).toBe("wait");
    const room = evaluatePlacement({ ...base, reservations: [], pick });
    expect(room.chosen?.computerId).toBe("mac-mini");
  });

  it("waits for a picked computer that is out of reach", () => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [thisMac, { ...macMini, inReach: false, model: null }],
      reservations: [],
      pick: { computerId: "mac-mini", mode: "wait" },
    });
    expect(decision.status).toBe("waiting");
    expect(decision.picked).toBe("wait");
  });

  it.each([
    { tools: { git: "unavailable" as const } },
    { projectAccess: "unavailable" as const },
    { model: { ...thisMac.model!, requiresReasoningWait: true } },
    { inReach: false, model: null },
  ])("falls back to the ordinary rules when a start pick is no longer possible: %j", (over) => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [thisMac, { ...macMini, ...over }],
      reservations: [],
      pick: { computerId: "mac-mini", mode: "start" },
    });
    expect(decision.chosen?.computerId).toBeNull();
    expect(decision.picked).toBeUndefined();
  });

  it("never passes an explicit binding", () => {
    const decision = evaluatePlacement({
      ...base,
      reservations: [],
      boundComputer: { computerId: null },
      pick: { computerId: "mac-mini", mode: "start" },
    });
    expect(decision.chosen?.computerId).toBeNull();
  });
});

/**
 * A premium ask whose brief carries pictures, on Automatic, when no computer
 * can serve premium now: its held route names the pictures, so Task Details
 * says no premium model reads them and the first mate hears no reset starts
 * it, only when no computer's reset can start it.
 */
describe("the route a premium ask with pictures holds on", () => {
  const requirements = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const lower = { provider: "openrouter", id: "google/gemini-3.5-flash" };
  // The Mac mini's premium model reads pictures but has spent its allowance.
  const readerSpent: RouteResult = {
    choice: lower,
    bucket: "premium",
    servedBucket: "medium",
    rule: "R1a",
  };
  // Every premium model on this computer reads text only.
  const textOnly: RouteResult = { ...readerSpent, picturesUnread: true };
  // No model is placed at premium on this computer.
  const empty: RouteResult = { ...readerSpent, emptyBucket: true };
  const on = (computer: PlacementCandidate, result: RouteResult, preferenceRank: number) => ({
    ...computer,
    model: { ...thisMac.model!, result, preferenceRank, requiresReasoningWait: true },
  });
  const macMini: PlacementCandidate = {
    ...thisMac,
    computerId: "mac-mini",
    physicalComputerId: "b".repeat(64),
  };
  const held = (candidates: PlacementCandidate[]) =>
    floorHold(evaluatePlacement({ requirements, candidates, reservations: [] }).candidates);

  it("holds on the computer whose reset can start it, then on the pictures before an empty level", () => {
    expect(held([on(thisMac, textOnly, 0), on(macMini, readerSpent, 1)])).toBe(readerSpent);
    expect(held([on(macMini, empty, 0), on(thisMac, textOnly, 1)])).toBe(textOnly);
  });
});

// INF-1389: the captain named Fable for a task, and Automatic started it on a
// Mac mini with no Fable sign-in, on another model, with the routing record's
// "requested pin ... is not available; ignoring it" as the only trace. A named
// model now runs only on a computer that serves it, or the task waits.
describe("a model the captain named", () => {
  const requirements = resolvePlacementRequirements({
    home: { system: "macos", chip: "arm64" },
    workingCopy: true,
  });
  const fable = "claude-fable-5-2";
  const opus = thisMac.model as RoutePreview;
  const serves: RoutePreview = {
    ...opus,
    result: {
      choice: { provider: "anthropic-claude", id: fable },
      bucket: "premium",
      rule: "R0",
    },
    named: { model: fable, served: true },
  };
  const substitutes: RoutePreview = {
    ...opus,
    preferenceRank: 1,
    named: { model: fable, served: false },
  };
  const macMini: PlacementCandidate = {
    ...thisMac,
    computerId: "mac-mini",
    physicalComputerId: "b".repeat(64),
    model: substitutes,
  };

  it("never starts on a computer that would run another model, even when the decision model picks it", () => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [{ ...thisMac, model: serves }, macMini],
      reservations: [],
      pick: { computerId: "mac-mini", mode: "start" },
    });
    expect(decision.chosen?.computerId).toBeNull();
    expect(decision.picked).toBeUndefined();
    expect(decision.candidates[1]?.rejections).toEqual(["model-unavailable"]);
  });

  it("waits for room where it is served rather than starting elsewhere", () => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [{ ...thisMac, model: serves }, macMini],
      reservations: [
        {
          orderId: "preparing",
          physicalComputerId: thisMac.physicalComputerId ?? "",
          demand: {
            cpu: requirements.demand.cpu * 3,
            memoryBytes: requirements.demand.memoryBytes * 3,
          },
        },
      ],
    });
    expect(decision.status).toBe("waiting");
    expect(
      placementWait(
        decision.candidates.map((row) => ({ name: "", ...row })),
        requirements.demand,
        fable,
      ).kind,
    ).toBe("room");
  });

  it("waits, naming the model, when no computer serves it", () => {
    const decision = evaluatePlacement({
      requirements,
      candidates: [{ ...thisMac, model: substitutes }, macMini],
      reservations: [],
    });
    expect(decision.status).toBe("waiting");
    expect(decision.candidates.map((row) => row.rejections)).toEqual([
      ["model-unavailable"],
      ["model-unavailable"],
    ]);
    const wait = placementWait(
      decision.candidates.map((row) => ({ name: "", ...row })),
      requirements.demand,
      fable,
    );
    expect(wait).toEqual({ kind: "model", words: placementNamedModelWait(fable) });
  });
});
