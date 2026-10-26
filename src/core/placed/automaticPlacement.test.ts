import { HERE } from "@shared/deviceNames";
import type { ComputerReach, DeviceView } from "@shared/devices";
import {
  AUTOMATIC_COMPUTER,
  PLACEMENT_FACTS_SINCE,
  PLACEMENT_HELD_WAIT,
  type PlacementFacts,
  placementCandidateLines,
} from "@shared/placement";
import type { RepoView } from "@shared/repos";
import type { ResourceObservation } from "@shared/resources";
import type { WorkShape } from "@shared/routingPolicy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import type { RoutePreview, Router } from "../routing/router";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AutomaticPlacement } from "./automaticPlacement";
import { ComputerResourceFeed } from "./computerResourceFeed";
import { ComputerResources } from "./computerResources";
import { memoryUsedBytes } from "./memoryUsed";
import type { WorkDevices } from "./workDevices";

/**
 * INF-25 (recreated from FI3-1762, found on FI3-1757): each Automatic start
 * sets aside a standard task's half core and 2 GiB on the computer it chose,
 * until a reading taken after that task was seen running includes it. The
 * app saw a task running only while choosing a computer for another one, so
 * the first start after a quiet spell still counted every recent start: at
 * 1:03 AM FI3-1741 waited for memory beside two tasks that had run for two
 * and a half minutes, and started 1.7 s later once their room was freed.
 */

const KIB = 1024;
const MAC = "a".repeat(64);
const EPOCH = "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64";

/**
 * This Mac's reading, as Electron reported it on a 24 GiB Mac in ordinary
 * use (FI3-1733, SCR-380): room for 6.2 cores and 4.8 GiB once 20% of idle
 * CPU and 2.4 GiB are kept back. Two standard starts' room leaves 0.8 GiB.
 */
function reading(sequence: number): ResourceObservation {
  return {
    epoch: EPOCH,
    sequence,
    status: "sampled",
    sampleMs: 250,
    cpu: { logicalCpus: 10, idleFraction: 0.77 },
    memory: {
      totalBytes: 25_165_824 * KIB,
      freeBytes: 356_672 * KIB,
      purgeableBytes: 335_184 * KIB,
      fileBackedBytes: 6_852_624 * KIB,
    },
  };
}

/** What this Mac reads about itself for a project it can clone. */
const facts: PlacementFacts = {
  system: "macos",
  chip: "arm64",
  physicalComputerId: MAC,
  tools: { git: "available" },
  projectAccess: "available",
};

/** A project that lives on GitHub, set to Automatic, declared for the Mac above. */
const ledger: RepoView = {
  id: "repo-ledger",
  name: "ledger",
  path: "/projects/ledger",
  setupKind: "clone",
  kind: "project",
  origin: "https://github.com/o/ledger.git",
  host: { kind: "github", name: "github.com" },
  delivery: "direct-pr",
  autonomy: false,
  rigor: null,
  runsOn: AUTOMATIC_COMPUTER,
  placementRequirements: { systems: ["macos"], chips: ["arm64"] },
};

const opus: RoutePreview = {
  result: {
    choice: { provider: "anthropic-claude", id: "claude-opus-5-5" },
    bucket: "high",
    rule: "R1a",
  },
  reasons: [],
  preferenceRank: 0,
  requiresReasoningWait: false,
};

/** Another Mac paired with this one to run work, out of reach. */
const macMini: DeviceView = {
  id: "mac-mini",
  kind: "mac",
  name: "Mac mini",
  pairedAt: Date.parse("2026-10-01T09:00:00Z"),
};

/**
 * One clock for the feed, its receiver and placement, moved by the fake
 * timers: by default it reads the same until they move it on. `more` names
 * the rest of placement's world, such as another computer and its reach.
 */
function world(
  now: () => number = () => Date.now(),
  more: Partial<ConstructorParameters<typeof AutomaticPlacement>[0]> = {},
) {
  const tasks = new TaskService({ db: freshDatabase(), strict: true });
  const work = {
    onWorkDevice: () => () => {},
    inReach: () => false,
    version: () => undefined,
    ask: () => Promise.reject(new Error("No other computer is paired.")),
  } as unknown as WorkDevices;
  let sequence = 0;
  const resources = new ComputerResources({
    local: { read: async () => reading(++sequence) },
    work,
    now,
  });
  const feed = new ComputerResourceFeed({
    resources,
    computers: () => [{ computerId: null, label: HERE.This }],
    onComputers: () => () => {},
    onContact: () => () => {},
    emit: () => {},
    now,
  });
  const router = {
    dynamicEnabled: () => true,
    preview: () => opus,
    commit: (_taskId: string, preview: RoutePreview) => preview.result,
  } as unknown as Router;
  const running = new Set<string>();
  const placement = new AutomaticPlacement({
    tasks,
    resources: feed,
    work,
    devices: () => [],
    router,
    repo: () => ledger,
    catalog: () => [],
    now,
    running: (task) => running.has(task.id),
    localFacts: async () => facts,
    home: () => ({ system: facts.system, chip: facts.chip }),
    ...more,
  });
  const task = (id: string, title: string) =>
    seedTask(tasks, { id, title, repoId: ledger.id, status: "queued" });
  const start = (
    record: ReturnType<typeof task>,
    shape: WorkShape = { kind: "fix" },
    project: RepoView = ledger,
  ) => placement.choose(record, project, record.title, shape);
  return {
    tasks,
    running,
    task,
    start,
    dispose: () => {
      placement.dispose();
      feed.dispose();
    },
  };
}

describe("AutomaticPlacement's room set aside for starting tasks", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the first task after a quiet spell beside two tasks that are running and measured", async () => {
    const w = world();
    try {
      const footer = w.task("footer", "Fix the ledger footer");
      const totals = w.task("totals", "Fix the ledger totals");
      expect(await w.start(footer)).toMatchObject({ computerId: null });
      // The second starts while the first still prepares: its room counts.
      expect(await w.start(totals)).toMatchObject({ computerId: null });
      w.running.add(footer.id);
      w.running.add(totals.id);

      // Two and a half minutes on, with nothing else starting meanwhile.
      await vi.advanceTimersByTimeAsync(150_000);
      const header = w.task("header", "Fix the ledger header");
      expect(await w.start(header)).toMatchObject({ computerId: null });
      expect(w.tasks.get(footer.id)?.placement?.reservation).toBe("observed");
      expect(w.tasks.get(totals.id)?.placement?.reservation).toBe("observed");
      expect(w.tasks.get(header.id)?.placement?.reservation).toBe("pending");
      // INF-396: the placement record saves the figure already on the reading.
      const saved = w.tasks
        .get(footer.id)
        ?.placement?.snapshot.candidates.find((row) => row.computerId === null)?.reading;
      expect(saved?.status).toBe("fresh");
      if (saved?.status === "fresh") {
        expect(saved.memoryUsedBytes).toBe(memoryUsedBytes(saved.observation.memory));
      }
    } finally {
      w.dispose();
    }
  });

  // A running task is seen just before the reading that frees its room is
  // asked for: at the same moment by a clock that has not moved, or a moment
  // before by one that moves on every read.
  it.each([
    ["a clock that reads the same within a moment", () => () => Date.now()],
    [
      "a clock that moves on with every read",
      () => {
        let reads = 0;
        return () => Date.now() + ++reads;
      },
    ],
  ])("frees the room of tasks that began running in a quiet spell on %s", async (_name, clock) => {
    const w = world(clock());
    try {
      const footer = w.task("footer", "Fix the ledger footer");
      const totals = w.task("totals", "Fix the ledger totals");
      await w.start(footer);
      await w.start(totals);
      // Their working copies took long enough that the readings had stopped.
      await vi.advanceTimersByTimeAsync(150_000);
      w.running.add(footer.id);
      w.running.add(totals.id);
      const header = w.task("header", "Fix the ledger header");
      expect(await w.start(header)).toMatchObject({ computerId: null });
      expect(w.tasks.get(footer.id)?.placement?.reservation).toBe("observed");
      expect(w.tasks.get(totals.id)?.placement?.reservation).toBe("observed");
    } finally {
      w.dispose();
    }
  });

  it("keeps the room of tasks that have not started running, and says that is why it waits", async () => {
    const w = world();
    try {
      const footer = w.task("footer", "Fix the ledger footer");
      const totals = w.task("totals", "Fix the ledger totals");
      await w.start(footer);
      await w.start(totals);

      await vi.advanceTimersByTimeAsync(150_000);
      const header = w.task("header", "Fix the ledger header");
      expect(await w.start(header)).toEqual({ wait: { kind: "room", words: PLACEMENT_HELD_WAIT } });
      expect(w.tasks.get(footer.id)?.placement?.reservation).toBe("pending");
      expect(w.tasks.get(totals.id)?.placement?.reservation).toBe("pending");
      expect(w.tasks.get(header.id)?.placement).toBeNull();
    } finally {
      w.dispose();
    }
  });
});

/**
 * INF-464, the captain's pick on INF-460: placement carries the core's one
 * reach value (`reachFrom`) as it is, with no connecting flag made from it.
 * A computer whose connection is being made reads connecting; one this Mac
 * tries again after a drop reads out of reach.
 */
describe("AutomaticPlacement's words for a computer out of reach", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reaches = [
    ["connecting", "connecting"],
    ["reconnecting", "out of reach"],
  ] as const satisfies readonly (readonly [ComputerReach, string])[];

  it.each(reaches)(
    "saves a %s computer's reach as it is on the start's explanation, which reads %s",
    async (reach, words) => {
      const w = world(undefined, { devices: () => [macMini], reachOf: () => reach });
      try {
        const footer = w.task("footer", "Fix the ledger footer");
        expect(await w.start(footer)).toMatchObject({ computerId: null });
        const snapshot = w.tasks.get(footer.id)?.placement?.snapshot;
        if (!snapshot) throw new Error("The start saved no explanation.");
        expect(snapshot.candidates.find((row) => row.computerId === macMini.id)?.reach).toBe(reach);
        expect(
          placementCandidateLines(snapshot).find((line) => line.startsWith("Mac mini: ")),
        ).toMatch(new RegExp(`^Mac mini: ${words}; `));
      } finally {
        w.dispose();
      }
    },
  );

  it.each(reaches)("names a %s computer %s in a waiting start's words", async (reach, words) => {
    const w = world(undefined, {
      devices: () => [macMini],
      reachOf: () => reach,
      // This Mac cannot clone the project, so the start waits for a computer.
      localFacts: async () => ({ ...facts, projectAccess: "unavailable" }),
    });
    try {
      const footer = w.task("footer", "Fix the ledger footer");
      const waited = await w.start(footer);
      expect(waited).toMatchObject({ wait: { kind: "other" } });
      expect(waited && "wait" in waited ? waited.wait.words : "").toContain(
        `${HERE.This}: project unavailable. Mac mini: ${words}; `,
      );
    } finally {
      w.dispose();
    }
  });
});

/**
 * INF-720, the captain's Fix 4: INF-653 and INF-665 needed Linux, and no
 * computer paired with this one runs it, so each waited hours on "different
 * required system" until the first mate happened to look. A wait says so as
 * a fact of its own only when every computer's system is known and none runs
 * it: a paired computer that runs it can end the wait, in reach or not.
 */
describe("AutomaticPlacement's wait for a system no computer runs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A project whose tasks may declare either system. */
  const either: RepoView = {
    ...ledger,
    placementRequirements: { systems: ["macos", "linux"], chips: ["arm64"] },
  };
  /** A task that compares test failures on Linux, as INF-653 did. */
  const onLinux: WorkShape = { kind: "fix", placement_requirements: { systems: ["linux"] } };

  it("says no computer runs Linux while this computer and the Mac mini both run macOS", async () => {
    const w = world(undefined, {
      devices: () => [{ ...macMini, system: "macos" }],
      repo: () => either,
    });
    try {
      const compare = w.task("compare", "Compare the Linux test failures on main");
      expect(await w.start(compare, onLinux, either)).toMatchObject({
        wait: { kind: "other" },
        unserved: {
          required: ["linux"],
          computers: [
            { name: HERE.This, system: "macos" },
            { name: "Mac mini", system: "macos" },
          ],
        },
      });
      expect(w.tasks.get(compare.id)?.placement).toBeNull();
    } finally {
      w.dispose();
    }
  });

  it.each([
    ["runs Linux and is out of reach", { ...macMini, kind: "work", system: "linux" }],
    ["never said what it runs", macMini],
  ] as const satisfies readonly (readonly [string, DeviceView])[])(
    "says nothing of it while a paired computer %s",
    async (_name, device) => {
      const w = world(undefined, { devices: () => [device], repo: () => either });
      try {
        const compare = w.task("compare", "Compare the Linux test failures on main");
        const waited = await w.start(compare, onLinux, either);
        expect(waited).toMatchObject({ wait: { kind: "other" } });
        expect(waited && "unserved" in waited).toBe(false);
      } finally {
        w.dispose();
      }
    },
  );
});

/**
 * INF-1456: a person added an Intel Mac mini beside their Apple-silicon
 * MacBook, and Automatic never used it for a project that declared no
 * computer requirements: the chip was filled from the MacBook's own, and
 * only Task Details said "different required architecture". The start now
 * names the computer it left out, why, and the project change that lets it
 * in, whichever computer took the task.
 */
describe("AutomaticPlacement's word on an added computer it leaves out", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-14T08:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The project in the report: Automatic, with no computer requirements. */
  const scheduler: RepoView = { ...ledger, placementRequirements: undefined };
  /** What the Intel Mac mini answers about itself for that project. */
  const intelMini = {
    system: "macos",
    chip: "x64",
    physicalComputerId: "b".repeat(64),
    tools: { git: "available" },
    projectAccess: "available",
    signIns: null,
  } as const;

  it("starts here and names the Intel Mac mini, held to this computer's Apple silicon", async () => {
    const w = world(undefined, {
      devices: () => [{ ...macMini, kind: "work", system: "macos", chip: "x64" }],
      repo: () => scheduler,
      work: {
        onWorkDevice: () => () => {},
        inReach: () => true,
        version: () => ({ contract: PLACEMENT_FACTS_SINCE }),
        ask: async () => intelMini,
      } as unknown as WorkDevices,
    });
    try {
      const rotate = w.task("rotate", "Remove and rotate scheduler mail credentials");
      expect(await w.start(rotate, { kind: "fix" }, scheduler)).toMatchObject({
        computerId: null,
        leftOut: [
          {
            computerId: macMini.id,
            name: "Mac mini",
            took: HERE.This,
            reasons: [{ kind: "chip", runs: "x64", heldTo: ["arm64"] }],
            widened: { chips: ["arm64", "x64"] },
          },
        ],
      });
      const snapshot = w.tasks.get(rotate.id)?.placement?.snapshot;
      if (!snapshot) throw new Error("The start saved no explanation.");
      expect(
        placementCandidateLines(snapshot).find((line) => line.startsWith("Mac mini: ")),
      ).toMatch(
        new RegExp(
          `^Mac mini: Intel, while this task was held to Apple silicon, inherited from ${HERE.this}[;.]`,
        ),
      );
    } finally {
      w.dispose();
    }
  });
});
