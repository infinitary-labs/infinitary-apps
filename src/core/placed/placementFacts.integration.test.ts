import { createServer, type Socket } from "node:net";
import { HERE } from "@shared/deviceNames";
import {
  AUTOMATIC_COMPUTER,
  PLACEMENT_DEMANDS,
  type PlacementWait,
  placementWait,
} from "@shared/placement";
import type { RepoView } from "@shared/repos";
import type { ResourceObservation } from "@shared/resources";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath } from "../hostEnv";
import { thisDeviceSystem } from "../platform";
import type { RoutePreview, Router } from "../routing/router";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AutomaticPlacement } from "./automaticPlacement";
import { ComputerResourceFeed } from "./computerResourceFeed";
import { ComputerResources } from "./computerResources";
import type { WorkDevices } from "./workDevices";

// One start waits out Automatic's 5 s limit on this computer's read, then
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
