import { createServer, type Socket } from "node:net";
import { HERE } from "@shared/deviceNames";
import type { DeviceView } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import {
  AUTOMATIC_COMPUTER,
  PLACEMENT_DEMANDS,
  PLACEMENT_FACTS_ORDER,
  type PlacementWait,
  placementWait,
} from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { RESOURCE_ORDER, type ResourceObservation } from "@shared/resources";
import type { ComputerSignIns } from "@shared/signIns";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import {
  orderPolicyOnlyRoute,
  preparePolicyOnlyRoute,
} from "../../../tests/helpers/policyOnlyRouting";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath } from "../hostEnv";
import { thisDeviceSystem } from "../platform";
import type { RoutePreview, Router } from "../routing/router";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AutomaticPlacement } from "./automaticPlacement";
import { ComputerResourceFeed } from "./computerResourceFeed";
import { ComputerResources } from "./computerResources";
import { answerPlacementFacts } from "./placementFacts";
import type { WorkDevices } from "./workDevices";

// Each start waits out Automatic's 5 s limit on this computer's read, then
// answers; 15 s covers three times that.
vi.setConfig({ testTimeout: 15_000 });

/**
 * INF-3150, from a user's report: a project set to Automatic whose host was
 * slow to answer left ready tasks waiting with every check of this computer
 * unknown: "This computer: system or architecture unknown; a required
 * program could not be checked; project access could not be checked;
 * available models unknown; physical computer could not be identified."
 * Only the project-access check reaches the network. When it outlived
 * Automatic's limit, Automatic dropped the whole read, so the system, chip,
 * programs and physical computer it had already read counted as unknown too.
 */

/** A project host that takes connections and never answers one. */
let host: ReturnType<typeof createServer>;
const held = new Set<Socket>();
let origin = "";

beforeAll(async () => {
  host = createServer((socket) => {
    held.add(socket);
    socket.on("close", () => held.delete(socket));
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("The host has no port.");
  origin = `http://127.0.0.1:${address.port}/o/ledger.git`;
  // The app asks the login shell once at startup, never during a start.
  await captureLoginPath();
});

afterAll(async () => {
  for (const socket of held) socket.destroy();
  await new Promise<void>((resolve) => host.close(() => resolve()));
});

/** This computer's reading with room for a standard task. */
function reading(sequence: number): ResourceObservation {
  return {
    epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
    sequence,
    status: "sampled",
    sampleMs: 250,
    cpu: { logicalCpus: 10, idleFraction: 0.77 },
    memory: {
      totalBytes: 24 * 1024 ** 3,
      freeBytes: 8 * 1024 ** 3,
      purgeableBytes: 0,
      fileBackedBytes: 0,
    },
  };
}

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

describe("Automatic placement when the project host is slow to answer", () => {
  it("names only project access, keeping the rest of this computer's read", async () => {
    const home = thisDeviceSystem();
    const ledger: RepoView = {
      id: "repo-ledger",
      name: "ledger",
      path: scratchDir("infinitary-placement-facts-"),
      setupKind: "clone",
      kind: "project",
      origin,
      host: { kind: "git", name: "127.0.0.1" },
      delivery: "direct-pr",
      autonomy: false,
      rigor: null,
      runsOn: AUTOMATIC_COMPUTER,
    };
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
    });
    const feed = new ComputerResourceFeed({
      resources,
      computers: () => [{ computerId: null, label: HERE.This }],
      onComputers: () => () => {},
      onContact: () => () => {},
      emit: () => {},
    });
    const placement = new AutomaticPlacement({
      tasks,
      resources: feed,
      work,
      devices: () => [],
      router: {
        prepare: preparePolicyOnlyRoute,
        inOrder: orderPolicyOnlyRoute,
        dynamicEnabled: () => true,
        preview: () => opus,
        commit: (_taskId: string, preview: RoutePreview) => preview.result,
      } as unknown as Router,
      repo: () => ledger,
      catalog: () => [],
      running: () => false,
      home: () => home,
    });
    try {
      const record = seedTask(tasks, {
        id: "footer",
        title: "Fix the ledger footer",
        repoId: ledger.id,
        status: "queued",
      });
      const answer = await placement.choose(record, ledger, record.title, { kind: "fix" });
      const expected: PlacementWait = placementWait(
        [{ name: HERE.This, rejections: ["project-unknown"], capacity: null }],
        PLACEMENT_DEMANDS.standard,
      );
      expect(answer).toMatchObject({ wait: expected });
    } finally {
      placement.dispose();
      feed.dispose();
    }
  });
});

/** The Mac mini, paired to run work and joined as another user of this Mac. */
const macMini: DeviceView = {
  id: "mac-mini",
  kind: "mac",
  name: "Mac mini",
  pairedAt: Date.parse("2026-10-01T09:00:00Z"),
};

/**
 * An order's or an answer's way between this Mac and the Mac mini on a home
 * network. Any travel at all put the Mac mini's answer past the home's limit,
 * since its own read used to end only at that same limit.
 */
const TRAVEL_MS = 20;

/** The Mac mini's own sign-ins, as it lists them for its home: Claude, serving Opus there. */
const signedInThere: ComputerSignIns = {
  providers: [],
  accounts: [
    {
      id: "acct_claude_there",
      providerId: "anthropic-claude",
      kind: "subscription_oauth",
      label: "Claude",
      enabled: true,
      connected: true,
      pinned: false,
      createdAt: Date.parse("2026-10-01T09:05:00Z"),
    },
  ],
  quota: null,
  served: [
    {
      accountId: "acct_claude_there",
      models: [{ provider: "anthropic-claude", id: "claude-opus-5-5" }],
    },
  ],
};

/**
 * INF-3164, filed from INF-3150's fix: a computer that runs work answers
 * the home's placement ask with the same read, but nothing ended it at
 * Automatic's limit. Its project-access check has its own 5 s limit, while
 * the home's 5 s limit on the ask runs from before the ask leaves and covers
 * its travel, so a slow project host there still dropped the whole answer,
 * and every check of that computer read unknown.
 */
describe("Automatic placement when a computer that runs work finds the project host slow", () => {
  it("names only that computer's project access, keeping the rest of its answer", async () => {
    const home = thisDeviceSystem();
    const ledger: RepoView = {
      id: "repo-ledger",
      name: "ledger",
      path: scratchDir("infinitary-placement-facts-"),
      setupKind: "clone",
      kind: "project",
      origin,
      host: { kind: "git", name: "127.0.0.1" },
      delivery: "direct-pr",
      autonomy: false,
      rigor: null,
      runsOn: AUTOMATIC_COMPUTER,
    };
    const tasks = new TaskService({ db: freshDatabase(), strict: true });
    /** The Mac mini's own folder, where its git runs. */
    const there = scratchDir("infinitary-placement-facts-there-");
    let sequence = 0;
    // The connection carries each order and answer as JSON, across the
    // network between the two computers; the Mac mini answers with the code
    // its work mode runs.
    const travel = <T>(value: T): Promise<T> =>
      new Promise((resolve) =>
        setTimeout(() => resolve(JSON.parse(JSON.stringify(value))), TRAVEL_MS),
      );
    const work = {
      onWorkDevice: () => () => {},
      inReach: (id: string) => id === macMini.id,
      version: () => ({ contract: PROTOCOL_VERSION }),
      ask: async (id: string, order: string, args: unknown) => {
        if (id !== macMini.id) throw new Error(`${id} is not paired.`);
        const arrived = await travel(args);
        if (order === RESOURCE_ORDER) return travel(reading(++sequence));
        if (order === PLACEMENT_FACTS_ORDER)
          return travel(await answerPlacementFacts(arrived, there, async () => signedInThere));
        throw new Error(`The Mac mini takes no ${order} here.`);
      },
    } as unknown as WorkDevices;
    const resources = new ComputerResources({
      local: { read: async () => reading(++sequence) },
      work,
    });
    const feed = new ComputerResourceFeed({
      resources,
      computers: () => [
        { computerId: null, label: HERE.This },
        { computerId: macMini.id, label: macMini.name },
      ],
      onComputers: () => () => {},
      onContact: () => () => {},
      emit: () => {},
    });
    const placement = new AutomaticPlacement({
      tasks,
      resources: feed,
      work,
      devices: () => [macMini],
      router: {
        prepare: preparePolicyOnlyRoute,
        inOrder: orderPolicyOnlyRoute,
        dynamicEnabled: () => true,
        preview: () => opus,
        commit: (_taskId: string, preview: RoutePreview) => preview.result,
      } as unknown as Router,
      repo: () => ledger,
      catalog: () => [],
      running: () => false,
      home: () => home,
    });
    try {
      const record = seedTask(tasks, {
        id: "footer",
        title: "Fix the ledger footer",
        repoId: ledger.id,
        status: "queued",
      });
      const answer = await placement.choose(record, ledger, record.title, { kind: "fix" });
      const expected: PlacementWait = placementWait(
        [
          { name: HERE.This, rejections: ["project-unknown"], capacity: null },
          { name: macMini.name, rejections: ["project-unknown"], capacity: null },
        ],
        PLACEMENT_DEMANDS.standard,
      );
      expect(answer).toMatchObject({ wait: expected });
    } finally {
      placement.dispose();
      feed.dispose();
    }
  });
});
