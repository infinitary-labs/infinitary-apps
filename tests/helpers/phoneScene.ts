import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claimLink } from "@core/devices/dial";
import { hostEnv } from "@core/hostEnv";
import type { Core } from "@core/index";
import { armWatch } from "@core/orchestrator/checkWatch";
import { openDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { seedTask, type TaskSeed } from "@core/tasks/seedTask";
import { DEVICE_SETUP_ACTIONS, deviceSetupCardId } from "@shared/deviceSetup";
import {
  layoutProgram,
  programProgress,
  programsOf,
  runningParts,
} from "../../src/renderer/src/character/crew/constellation";
import { partsCountWords } from "../../src/renderer/src/character/crew/programWords";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "../e2e/mockProvider";
import { seedDelivery } from "./taskDelivery";

/** INF-1066: actual task, routing, graph and pairing readings for the native scene.
 * No provider, account or external computer is contacted. A paired but absent helper stays unknown.
 * The native test owns setup/cleanup; every fixture invocation uses its own task ids.
 */
export function phoneSceneFixture(core: Core, userData: string, ready: () => Promise<void>) {
  const tasks = core.services.tasks;
  let generation = 0;
  let ids: string[] = [];
  let computer: string | undefined;
  let liveParts: string[] = [];
  let waitingCard: string | undefined;
  const cleanup = () => {
    if (waitingCard)
      core.services.supervisor.closeCard(waitingCard, { kind: "firstmate" }, "Scene fixture");
    waitingCard = undefined;
    for (const id of [...ids].reverse()) {
      core.services.jobs.killForOwner(id);
      const task = tasks.get(id);
      if (task && task.status !== "done" && task.status !== "dropped")
        tasks.close(id, { status: "dropped", reason: "cancelled", actor: "host" });
    }
    ids = [];
    liveParts = [];
    if (computer) core.services.devices.remove(computer);
    computer = undefined;
  };
  return {
    cleanup,
    async finishParts() {
      for (const id of liveParts)
        tasks.close(id, { status: "done", reason: "answered", actor: "host" });
      liveParts = [];
      return {
        board: await core.dispatch("inf:tasks:board", []),
        computers: await core.dispatch("inf:computers:presence", []),
      };
    },
    async create() {
      cleanup();
      const prefix = `phone-scene-${++generation}`;
      const invitation = await core.dispatch("inf:devices:invite", [{ kind: "mac" }]);
      await ready();
      const grant = await claimLink(invitation.link, {
        kind: "mac",
        name: "Scene Mac",
        user: { name: "scene", uid: 502 },
      });
      computer = grant.deviceId;
      // Pairing really raises its setup card. This fixture explicitly defers it so the empty stage is visible.
      const deferredSetup = deviceSetupCardId(computer);
      const deferred = await core.dispatch("inf:cards:act", [
        deferredSetup,
        DEVICE_SETUP_ACTIONS.notNow,
        "chrome",
      ]);
      if (deferred.refusal) throw new Error(deferred.refusal);
      const ledgerDB = openDatabase(userData);
      const ledger = new DecisionStore(ledgerDB);
      const add = (name: string, title: string, patch: Partial<TaskSeed> = {}) => {
        const id = `${prefix}-${name}`;
        const worktreeDir = join(userData, "scene-workspaces", id);
        mkdirSync(worktreeDir, { recursive: true });
        seedTask(tasks, {
          id,
          title,
          status: "idle",
          startPolicy: "on-request",
          worktreeDir,
          model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
          outcome: "Ready for the native scene review.",
          ...patch,
        });
        ids.push(id);
        return id;
      };
      try {
        const markerParts = Array.from({ length: 8 }, (_, i) => `Read harbour approach ${i + 1}`);
        const program = add("program", "Review the harbour route", {
          status: "queued",
          shape: {
            kind: "unclear",
            program: {
              script: 'return task("Read the harbour route.");',
              bound: markerParts.length + 5,
            },
          },
        });
        const first = add("soundings", "Read the harbour soundings", { parentId: program });
        const second = add("tides", "Compare the harbour tides", { parentId: program });
        tasks.link(first, second, "blocks", "host");
        const planned = add("planned", "Summarize the route", {
          parentId: program,
          status: "queued",
        });
        const finished = add("finished", "Find the harbour chart", { parentId: program });
        tasks.close(finished, { status: "done", reason: "answered", actor: "host" });
        const parallel = markerParts.map((title, i) =>
          add(`approach-${i}`, title, { parentId: program }),
        );
        const crew = [first, second, ...parallel];
        // Cross both desktop orbits, retaining every glyph at its readable size.
        for (let i = 0; i < 21; i++) crew.push(add(`crew-${i}`, `Check harbour marker ${i + 1}`));
        // INF-1543: one crewmate waits on the captain's decision, so the scene draws its beacon.
        // The card is put aside: a card on the stack takes the phone's stage in place of the scene.
        const waiting = crew[crew.length - 1] as string;
        waitingCard = core.services.supervisor.addFirstmateCard({
          taskId: waiting,
          title: "Which harbour marker comes first?",
          body: "<p>The marker check is ready for your choice.</p>",
          actions: [
            { id: "north", label: "North marker", default: true },
            { id: "south", label: "South marker" },
          ],
        });
        core.services.supervisor.setCardMinimized(waitingCard, true);
        // INF-1777: one crewmate waits on a real background command and one on its watched checks,
        // so the scene draws both banked looks inside the wait ring.
        const job = crew[crew.length - 3] as string;
        const jobDir = join(userData, "scene-workspaces", job);
        await core.services.jobs.run({
          ownerId: job,
          command: "sleep 600",
          cwd: jobDir,
          background: true,
        });
        const checks = crew[crew.length - 2] as string;
        // The durable watch reads a real head. Its first read is put past the scene's life: a read finds no forge,
        // ends the watch and takes the crewmate out of its checks wait while a part is still reading the scene.
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: join(userData, "scene-workspaces", checks),
            env: hostEnv({ HOME: userData, GIT_CONFIG_GLOBAL: "/dev/null" }),
            encoding: "utf8",
            stdio: "pipe",
          }).trim();
        git("init", "--initial-branch=main");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@localhost",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "chore: seed checks",
        );
        const head = git("rev-parse", "HEAD");
        seedDelivery(tasks, checks, {
          mode: "direct-pr",
          prNumber: 57,
          headSha: head,
          ci: "pending",
          ciWatch: {
            ...armWatch(undefined, head, Date.now()),
            nextAt: Date.now() + 24 * 60 * 60_000,
          },
        });
        const remote = add("remote", "Read the offshore chart", { deviceId: computer });
        const remotePart = add("remote-part", "Verify the offshore tide", {
          deviceId: computer,
          parentId: program,
        });
        const review = add("review", "Review the harbour soundings", {
          parentId: first,
          shape: { kind: "review", kind_source: "host:review" },
        });
        const tiers = ["low", "medium", "high", "premium"] as const;
        for (const [index, id] of [...crew, remote, remotePart, review].entries()) {
          const tier = tiers[index % tiers.length] ?? tiers[0];
          ledger.recordRouting({
            taskId: id,
            provider: MOCK_PROVIDER_ID,
            model: MOCK_MODEL_ID,
            bucket: tier,
            rule: "R0",
            served: tier,
            reasons: [],
          });
          // A real task event delivers the latest public view to already-joined clients.
          tasks.noteProgress(id, "Ready for the native scene review.");
        }
        const board = await core.dispatch("inf:tasks:board", []);
        const progress = programProgress(board.tasks, program);
        liveParts = progress.running.map((task) => task.id);
        const reading = programsOf(board.tasks, board.links).find(
          (reading) => reading.id === program,
        );
        if (!reading) throw new Error("The published board did not include the running program");
        const desktopLayouts = ["home", computer].map((computerID) => {
          const local = new Set(
            progress.running
              .filter((task) => (task.executionDeviceId ?? "home") === computerID)
              .map((task) => task.id),
          );
          const nodes = runningParts(reading.parts.filter((part) => local.has(part.id)));
          return {
            computerID,
            places: Object.fromEntries(
              layoutProgram(nodes, { x: 0, y: 0 }, Number.POSITIVE_INFINITY),
            ),
          };
        });
        return {
          program,
          desktopLayouts,
          programWords: partsCountWords(progress.finished, liveParts.length, progress.waiting),
          deferredSetup,
          first,
          second,
          planned,
          finished,
          remote,
          remotePart,
          review,
          waiting,
          job,
          checks,
          crew,
          ordinary: crew.filter((id) => !liveParts.includes(id)),
          computer,
          board,
          computers: await core.dispatch("inf:computers:presence", []),
          conversation: await core.dispatch("inf:conversation:state", []),
        };
      } finally {
        ledgerDB.close();
      }
    },
  };
}
