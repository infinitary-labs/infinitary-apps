import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import type { AccountView } from "@shared/accounts";
import type { ChangePresentationDraft } from "@shared/changePresentation";
import {
  deviceForgeGateRef,
  deviceForgeSignInCardId,
  deviceForgeWaitLine,
  noSignInsWaitLine,
} from "@shared/deviceSetup";
import type { DeviceView } from "@shared/devices";
import { GOOGLE_DATA_KEPT, NOTICE_ACCEPTED } from "@shared/integrations";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { outsideDataDeletedNote } from "@shared/savedOutsideData";
import type { ComputerForges } from "@shared/signIns";
import {
  type PlacedEventRecord,
  type PlacedSpec,
  placedTaskFolders,
  workOrders,
} from "@shared/work";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { projectFontBytes } from "../../../tests/helpers/fontFixture";
import { startGoogleStandIn } from "../../../tests/helpers/googleStandIn";
import { pngImage } from "../../../tests/helpers/images";
import { allowIntegrationReads } from "../../../tests/helpers/integrationApprovals";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import { type PlacedHome, startPlacedHome } from "../../../tests/helpers/placedHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import type { ContractWorld } from "../../../tests/helpers/sessionContract";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { moveWorkFolder, olderWorkFolder } from "../../../tests/helpers/workFolderMove";
import { attachmentPath, keepImages } from "../attachments";
import { renderIntegrationReply } from "../axi/integrationCommands";
import type { IntegrationReply } from "../axi/protocol";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { Computers } from "../devices/computers";
import { DevicePairing } from "../devices/pairing";
import { pathsOf } from "../folderMove/due";
import { rewriteDatabases } from "../folderMove/rewrite";
import { createForgeResolver, type Forge } from "../forge";
import type { ComputerAccounts } from "../helper/accounts";
import { ComputerBrowsers } from "../helper/browsers";
import { cleanUp } from "../helper/cleanUp";
import type { HeldForges } from "../helper/forges";
import { removeFromHome } from "../helper/fromHome";
import { joinHome } from "../helper/join";
import { PlacedTasks } from "../helper/placedTasks";
import { type HelperRun, startHelper } from "../helper/run";
import { SessionHost } from "../helper/sessionHost";
import { startSignIns } from "../helper/signIns";
import { WorkingCopies } from "../helper/workingCopies";
import * as hostEnvironment from "../hostEnv";
import { CREWMATE_INTEGRATIONS_LINE, INTEGRATIONS_COMMAND } from "../integrations";
import { READ_HOUR_MS } from "../integrations/outsideReads";
import { JobManager } from "../jobs/jobManager";
import { createCrewmateTranscriptResolver } from "../observe/transcriptSource";
import { crewmateRenewedNote, crewmateRestartText } from "../orchestrator/crewSession";
import { QUIET_CARD_MS, UNHEARD_END_NOTE } from "../orchestrator/crewSupervisor";
import { JOB_BOUND_MS } from "../orchestrator/idleLadder";
import { renderWake, unnamedBackgroundWork } from "../orchestrator/wakes";
import { initOverflowDir, type MessageFile, withPastedFiles } from "../overflow";
import {
  crewmateCardPicturesDir,
  crewmatePlacedDir,
  crewmateSessionsDir,
  crewmateTempDir,
} from "../paths";
import type { AccountVault } from "../pi/accountVault";
import { backgroundJobReceipt } from "../pi/bashWords";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import { crewmateComputersNote } from "../pi/piResources";
import { createPiSessionFactory } from "../pi/sessionFactory";
import type { ModelRuntime } from "../pi/types";
import { Router } from "../routing/router";
import { answeredReadText } from "../session/openReads";
import type { CrewmateTool } from "../session/tools";
import { forkChildProcess } from "../sql/forkChildProcess";
import { SettingsStore } from "../storage/settingsStore";
import { CrewTranscripts } from "../tasks/crewTranscript";
import { handoverFileName } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { TaskTimeline } from "../tasks/taskTimeline";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { git } from "../workspace/git";
import { ProjectChanges } from "../workspace/projectChanges";
import { checkedOutRefFor, keptRefFor, WorkspaceService } from "../workspace/workspaceService";
import { NO_PLACED_TASK } from "./placedWork";

/**
 * A task whose crewmate runs on a computer that runs work, end to end from
 * the home's side (docs/helper.md, "Holding a conversation"): the real
 * supervisor and task record over a real database, `PlacedSessions` behind
 * the real connection and pairing, and the helper as the work mode composes
 * it holding a real Pi conversation against a local stub of the model's API,
 * or a real Claude session on a scripted client (`scriptedClaudeWorld`).
 * A home restart is a new home over the same folder and port; a computer
 * restart is a new helper over the same folder.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

const PROVIDER = "fm-placed";
/** The task commands' launcher (`resources/axi-bin`), which a granted shell finds on its path. */
const AXI_BIN_DIR = resolve(__dirname, "../../../resources/axi-bin");
const MODEL = "stub-1";
const BUILDER = { name: "builder", uid: 502 };

let api: StubApi;
let runtime: ModelRuntime;

beforeAll(async () => {
  api = await startStubApi(() => true);
  runtime = await piStubRuntime(api.url, { provider: PROVIDER, id: MODEL });
});

afterAll(async () => {
  await api.close();
});

/** What the model does on one request: call tools, answer, or answer once a test lets it. */
type Step = ({ tools: { name: string; args: Record<string, unknown> }[] } | { text: string }) & {
  held?: Promise<void>;
};

/**
 * The model, one step per request from now on; past the last step it
 * answers "Done.". A model that reads what it was told picks each step from
 * the request instead.
 */
function model(steps: Step[] | ((request: StubRequest, index: number) => Step)): void {
  const first = api.requests.length;
  api.answer((request: StubRequest, res: ServerResponse) => {
    const index = request.n - first - 1;
    const step =
      typeof steps === "function" ? steps(request, index) : (steps[index] ?? { text: "Done." });
    beginAnthropicStream(res, 100, request.n);
    const answer = () => {
      if ("text" in step) {
        writeAnthropicText(res, 0, step.text);
        finishAnthropicStream(res, "end_turn", 3);
        return;
      }
      for (const [index, tool] of step.tools.entries())
        writeAnthropicToolUse(res, index, {
          id: `toolu_${request.n}_${index}`,
          name: tool.name,
          args: tool.args,
        });
      finishAnthropicStream(res, "tool_use", 5);
    };
    if (step.held) void step.held.then(answer);
    else answer();
  });
}

/** A gate a model step waits at. */
function gate(): { held: Promise<void>; open: () => void } {
  let open!: () => void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
}

/**
 * Holds the home's next read of a computer - the models it serves, or its
 * own sign-ins - until the case releases it: a wait a queued task's start
 * makes on that computer before it claims the task.
 */
function holdNext(placed: PlacedHome["placed"], read: "served" | "signInsOf") {
  const reached = gate();
  const release = gate();
  const real = placed[read].bind(placed) as (machine: string) => Promise<unknown>;
  const spy = vi.spyOn(placed, read) as unknown as MockInstance<
    (machine: string) => Promise<unknown>
  >;
  spy.mockImplementationOnce(async (machine) => {
    reached.open();
    await release.held;
    return real(machine);
  });
  return { reached: reached.held, release: release.open };
}

/** The words of every user turn a request carried. */
function said(request: StubRequest | undefined): string {
  return JSON.stringify(request?.body.messages ?? []);
}

const stops: (() => Promise<void> | void)[] = [];

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
/** Computers a test calls out of reach only because their connection is being made. */
const connectingNow = new Set<string>();

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  ahead = 0;
  vi.unstubAllEnvs();
});

/** Where each project lives, as the home finds it for the project's folder. */
type ForgeFor = NonNullable<Parameters<typeof startPlacedHome>[0]["forgeFor"]>;

/** The home over its folder, with this file's clock, on real Pi's control plane. */
function startHome(
  userData: string,
  port: number,
  pairing: () => DevicePairing,
  forgeFor?: ForgeFor,
  extra: Pick<
    Parameters<typeof startPlacedHome>[0],
    "routing" | "runsForAnotherFirstmate" | "github" | "google"
  > & {
    /** A task that moves home runs its conversation here on real Pi. */
    runsHere?: boolean;
    claude?: ContractWorld;
    scheduleCopy?: Parameters<typeof startPlacedHome>[0]["scheduleCopy"];
  } = {},
): PlacedHome {
  const home = startPlacedHome({
    userData,
    port,
    pairing,
    now,
    scheduleCopy: extra.scheduleCopy,
    // A home whose crew runs on Claude binds every task to Claude there.
    binding: extra.claude?.binding ?? { backend: "pi", runtime },
    profiles: {
      pi: createPiSessionFactory({ agentDir: join(userData, "pi-agent") }).controlProfile,
      ...(extra.claude ? { claude: extra.claude.factory.controlProfile } : {}),
    },
    ...(forgeFor ? { forgeFor } : {}),
    reachOf: (deviceId) => (connectingNow.has(deviceId) ? "connecting" : "out-of-reach"),
    ...(extra.routing ? { routing: extra.routing } : {}),
    ...(extra.runsForAnotherFirstmate
      ? { runsForAnotherFirstmate: extra.runsForAnotherFirstmate }
      : {}),
    ...(extra.github ? { github: extra.github } : {}),
    ...(extra.google ? { google: extra.google } : {}),
    ...(extra.runsHere
      ? { here: createPiSessionFactory({ agentDir: join(userData, "pi-agent") }) }
      : {}),
    log: (line) => process.env.PLACED_DEBUG && process.stderr.write(`[home] ${line}\n`),
  });
  stops.push(home.quit);
  return home;
}

/**
 * The computer's own sign-ins as it lists them for its home, answered by the
 * real sign-in host over the account rows it holds and the models each
 * serves there; nothing is signed in.
 */
function signedInTo(
  accounts: AccountView[],
  forgesView?: () => ComputerForges,
  served: ServedThere[] = [],
) {
  const held = {
    vault: {
      views: async () => accounts,
      swept: async () => {},
      onCutOffChange: () => () => true,
      customViews: () => [],
      // Only an account it holds serves anything there, as its vault lists them.
      availableModelsByAccount: () =>
        served.flatMap((row) => {
          const account = accounts.find((entry) => entry.id === row.accountId);
          return account
            ? [{ ...row, accountLabel: row.accountId, providerId: account.providerId }]
            : [];
        }),
    } as unknown as AccountVault,
    providers: () => [],
    allowance: () => null,
    readAllowance: async () => null,
    close: () => {},
  } satisfies ComputerAccounts;
  const forges = {
    view: () => forgesView?.() ?? { signIns: [], hosts: [] },
    start: async () => {},
    cancel: () => {},
    signOut: () => {},
    checkHealth: async () => {},
    close: () => {},
  } satisfies HeldForges;
  return (start: Parameters<typeof startSignIns>[0]) =>
    startSignIns({ ...start, accounts: async () => held, forges: () => forges });
}

/** A home and a computer joined to it as another user, running work with real Pi. */
async function world(
  forgeFor?: ForgeFor,
  options: {
    remoteLogin?: string;
    /** This Mac's own subscriptions, for a home that routes. */
    routing?: Parameters<typeof startPlacedHome>[0]["routing"];
    /** The accounts the computer lists as its own sign-ins. */
    signedInTo?: AccountView[];
    /** The models each of those accounts serves there, as that computer reads them. */
    served?: ServedThere[];
    /** The computer's own sign-ins where projects live, as it lists them. */
    forges?: () => ComputerForges;
    /** Whether the computer's clone is refused by GitHub for want of its own sign-in there. */
    refuseClone?: () => boolean;
    /** What the computer's conversations run on; this file's stub unless named. */
    runtime?: ModelRuntime;
    /**
     * Claude's factory on a scripted client (`scriptedClaudeWorld`), which the
     * computer's Claude conversations run on, and every task's crew binds to.
     */
    claude?: ContractWorld;
    scheduleCopy?: Parameters<typeof startPlacedHome>[0]["scheduleCopy"];
    /** Whether Firstmate there runs work for another Firstmate now, as the home's SSH connection found. */
    runsForAnotherFirstmate?: (deviceId: string) => boolean;
    /**
     * Its work starts in Firstmate 3000's folder, as a computer's does
     * before its first update to Infinitary (`moveComputer`).
     */
    inOlderFolder?: boolean;
    /**
     * Its crewmates' long commands are background jobs there, kept as the
     * work mode keeps them (`startConversations`); otherwise Pi's own bash.
     * `counted`: it tells the home how many run but names none, as a
     * computer built before `background-job-named` does.
     */
    jobs?: boolean | "counted";
    /** The contract the computer's hello names; this build's own unless a test stands in an older one. */
    protocolVersion?: string;
    /** The contract changes the computer's hello lists; this build's own unless a test stands in an older one. */
    changes?: readonly string[];
    tools?: readonly CrewmateTool[];
    /** The home's github.com sign-in, whose integrations its crew there reaches through its task channel. */
    github?: Parameters<typeof startPlacedHome>[0]["github"];
    /** Google's stand-in, which the home's integrations reach. */
    google?: Parameters<typeof startPlacedHome>[0]["google"];
    /** A task that moves home runs its conversation here on real Pi. */
    runsHere?: boolean;
    /**
     * The computer's task channel, as the work mode opens it
     * (`ComputerBrowsers`), over the command process bundled at this path;
     * otherwise it keeps none, and its roster says so.
     */
    taskChannel?: string;
  } = {},
) {
  const userData = scratchDir("infinitary-placed-home-");
  let pairing: DevicePairing | undefined;
  const pairingNow = () => {
    pairing ??= new DevicePairing({
      dir: join(userData, "devices"),
      onProblem: () => {},
      interfaces: () => ({}),
      ownUid: 501,
    });
    return pairing;
  };
  stops.push(() => pairing?.dispose());
  const port = await claimedPort();
  let home = startHome(userData, port, pairingNow, forgeFor, options);
  await home.listen();
  const { link } = pairingNow().invite(
    { kind: "work", at: `127.0.0.1:${port}` },
    // Added by its address, as the home does over Remote Login.
    options.remoteLogin ? { remoteLogin: options.remoteLogin } : {},
  );
  await home.settled();
  // The application-data folder that holds both apps' folders, for a computer
  // whose work starts in Firstmate 3000's.
  const appData = options.inOlderFolder ? scratchDir("infinitary-placed-app-data-") : undefined;
  let dataDir = appData ? olderWorkFolder(appData) : scratchDir("infinitary-placed-computer-");
  if (appData) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;

  let run: HelperRun | undefined;
  /** The computer refuses to open a conversation, as one with no sign-in for its provider does. */
  let refusing = false;
  /** The contract the running computer's hello names. */
  let protocolVersion = options.protocolVersion;
  /** The contract changes the running computer's hello lists. */
  let changes = options.changes;
  /** Every binding the home asked the computer to resolve with its own sign-ins. */
  const bound: PlacedSpec["binding"][] = [];
  const startComputer = (
    tools: readonly CrewmateTool[] | undefined = options.tools,
    version = protocolVersion,
  ) => {
    const started = startHelper({
      dataDir,
      say: () => {},
      retryMs: [20],
      ...(version ? { protocolVersion: version } : {}),
      ...(changes ? { changes } : {}),
      ...(options.signedInTo
        ? { signIns: signedInTo(options.signedInTo, options.forges, options.served) }
        : {}),
      // Removed, it removes what Firstmate set up here; no agent was set up.
      cleanUp: () => cleanUp({ dataDir, background: null }),
      conversations: async ({ dataDir: dir, ask, tell, homeChanges }) => {
        const copies = new WorkingCopies(dir, { pool: false });
        if (options.refuseClone) {
          // GitHub refuses the clone for want of this computer's own sign-in,
          // as its git would say it (`forgeAuthRequired`).
          const prepare = copies.prepare.bind(copies);
          copies.prepare = async (task, project, seed) => {
            if (options.refuseClone?.())
              throw new ForgeAuthRequiredError("GitHub requires sign-in to fetch this project.");
            return prepare(task, project, seed);
          };
        }
        const tasks = new PlacedTasks(dir, copies.worktreesDir);
        let host: SessionHost | undefined;
        const jobs = options.jobs
          ? new JobManager({
              rows: tasks.jobRows,
              onChange: () => host?.jobsChanged(),
              onExit: (exit) => host?.jobExit(exit),
              belowUi: false,
            })
          : undefined;
        // Its task channel, as `startConversations` opens it; no page opens here.
        const entry = options.taskChannel;
        const channel = entry
          ? await ComputerBrowsers.open({
              host: {
                open: async () => {
                  throw new Error("No page opens on this computer here.");
                },
              },
              spawner: forkChildProcess(entry),
              binDir: AXI_BIN_DIR,
              version: "9.9.9-test",
              keysDir: join(dir, "task-channel"),
              evidenceDir: (task) => tasks.folders(task).evidence,
              ...(jobs ? { answering: (shell: string) => jobs.answering(shell) } : {}),
              tell,
              ask,
              log: (line) =>
                process.env.PLACED_DEBUG && process.stderr.write(`[channel] ${line}\n`),
            })
          : undefined;
        host = new SessionHost({
          tasks,
          copies,
          ask,
          ...(homeChanges ? { homeChanges } : {}),
          factories: {
            pi: createPiSessionFactory({
              agentDir: join(dir, "pi-agent"),
              ...(jobs ? { runBash: (input) => jobs.run(input) } : {}),
            }),
            ...(options.claude ? { claude: options.claude.factory } : {}),
          },
          ...(jobs
            ? {
                runningJobCount: (task: string) => jobs.runningJobCount(task),
                ...(options.jobs === "counted"
                  ? {}
                  : { oldestRunningJob: (task: string) => jobs.oldestRunningJob(task) }),
                killJobs: (task: string) => jobs.killForOwner(task),
              }
            : {}),
          bind: async (binding) => {
            bound.push(binding);
            if (refusing) throw new Error(`This computer has no sign-in for ${PROVIDER} here.`);
            if (binding.backend === "claude" && options.claude) return options.claude.binding;
            return { backend: "pi", runtime: options.runtime ?? runtime };
          },
          ...(tools ? { tools } : {}),
          ...(channel
            ? {
                commands: {
                  grant: (task, granted) => channel.grant(task, granted),
                  close: (task) => channel.close(task),
                },
              }
            : {}),
          log: (line) => process.env.PLACED_DEBUG && process.stderr.write(`[computer] ${line}\n`),
        });
        const held = host;
        return {
          host: held,
          close: async () => {
            await held.close();
            channel?.closeAll();
            jobs?.disposeAll();
          },
        };
      },
    });
    if (!started.ok) throw new Error(started.reason);
    run = started.run;
  };
  stops.push(() => run?.stop());
  startComputer();

  /** Resolves once the computer is in reach and its roster read. */
  const inReach = async (taskId = "none") => {
    await expect.poll(() => home.placed.ready(deviceId, taskId)).toBe(true);
  };
  if (options.protocolVersion && options.protocolVersion !== PROTOCOL_VERSION)
    await expect.poll(() => home.devices.version(deviceId)?.contract).toBe(options.protocolVersion);
  else await inReach();
  return {
    deviceId,
    /** The computer's work folder now: Infinitary's once `moveComputer` moved it. */
    get dataDir() {
      return dataDir;
    },
    home: () => home,
    pairing: pairingNow,
    /** Whether the computer's own process still runs. */
    running: () => run,
    inReach,
    /** A queued task placed on the computer, started now that it is in reach. */
    start: async (id: string, prompt = "Fix the footer.", repoId?: string) => {
      seedTask(home.tasks, {
        id,
        title: "website",
        prompt,
        status: "queued",
        deviceId,
        ...(repoId ? { repoId } : {}),
      });
      await home.supervisor.dispatchQueuedTask(id);
      expect(home.tasks.get(id)?.status).toBe("active");
    },
    /**
     * Firstmate on the home quits and starts again over the same folder and
     * port, after `whileStopped` runs on what it left; `beforeListen` sees
     * the new home before the computer can reach it.
     */
    restartHome: async (
      whileStopped?: () => void | Promise<void>,
      beforeListen?: (home: PlacedHome) => void,
    ) => {
      await home.quit();
      pairing?.dispose();
      pairing = undefined;
      await whileStopped?.();
      home = startHome(userData, port, pairingNow, forgeFor, options);
      beforeListen?.(home);
      await home.listen();
    },
    /**
     * The computer's own process quits, and starts again from the same
     * folder; updated, with the crewmate tools its new version binds.
     */
    restartComputer: async (updated?: {
      tools?: readonly CrewmateTool[];
      protocolVersion?: string;
      /** The contract changes its new version lists. */
      changes?: readonly string[];
    }) => {
      if (updated?.protocolVersion) protocolVersion = updated.protocolVersion;
      if (updated?.changes) changes = updated.changes;
      await run?.stop();
      startComputer(updated?.tools);
    },
    /** The computer's own process quits, as when nobody is logged in there. */
    stopComputer: async () => {
      await run?.stop();
    },
    /**
     * The computer's first update to Infinitary: its work stops, the
     * one-time move brings Firstmate 3000's folder into Infinitary's, and its
     * work runs again from there (docs/helper.md, "Under the other name"),
     * after `moved` runs on the work folder the move made.
     */
    moveComputer: async (moved?: (work: string) => void) => {
      if (!appData) throw new Error("This computer's work is in no older folder.");
      await run?.stop();
      dataDir = await moveWorkFolder(appData);
      moved?.(dataDir);
      startComputer();
    },
    /** The computer's folder for a task. */
    folders: (taskId: string) =>
      placedTaskFolders(join(dataDir, "tasks"), taskId, join(dataDir, "worktrees")),
    /** Every binding the home asked the computer to resolve, oldest first. */
    bound,
    /** Whether the computer refuses to open a conversation from now on. */
    refuseOpens: (on: boolean) => {
      refusing = on;
    },
    /** What the computer holds: a folder per task, and a working copy per task. */
    holds: () => ({
      tasks: listed(join(dataDir, "tasks")),
      workingCopies: listed(join(dataDir, "worktrees")),
    }),
  };
}

/** This Mac signed in to Codex alone, with allowance to spare, and the catalog it lists. */
const THIS_MAC_ON_CODEX = {
  available: [{ provider: "openai-codex", id: "gpt-6-sol" }],
  catalog: [
    { provider: "codex", id: "gpt-6-sol", label: "GPT-6 Sol", effectivePercentRemaining: 90 },
  ],
  catalogModels: [
    { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
    { provider: "xai", id: "grok-stub", name: "Grok stub" },
  ],
};

/** The models one account on a computer serves, as that computer's own runtime lists them. */
type ServedThere = { accountId: string; models: { provider: string; id: string; name?: string }[] };

/** What the computer's Grok account serves there: the one model its runtime defines. */
const GROK_THERE: ServedThere[] = [
  {
    accountId: "acct_grok_there",
    models: [{ provider: "xai", id: "grok-stub", name: "Grok stub" }],
  },
];

/** The Codex model the starter map places at medium, which routing takes first. */
const CODEX_MEDIUM_STARTER = Object.entries(STARTER_SLOTS["openai-codex"] ?? {}).find(([, slots]) =>
  slots.includes("medium"),
)?.[0] as string;

/** The Claude models this build's provider-wide catalog lists, as `createServices` hands `catalogModels`. */
const CLAUDE_CATALOG = CLAUDE_MODELS.map((model) => ({
  provider: CLAUDE_PROVIDER_ID,
  id: model.id,
  name: model.name,
}));

/**
 * This Mac signed in to Codex, whose catalog lists the starter map's medium
 * model beside GPT-6 Sol, a Codex model the starter map places nowhere.
 */
const THIS_MAC_ON_NEWER_CODEX = {
  available: [
    { provider: "openai-codex", id: CODEX_MEDIUM_STARTER },
    { provider: "openai-codex", id: "gpt-6-sol" },
  ],
  catalog: [
    {
      provider: "codex",
      id: CODEX_MEDIUM_STARTER,
      label: CODEX_MEDIUM_STARTER,
      effectivePercentRemaining: 90,
    },
    { provider: "codex", id: "gpt-6-sol", label: "GPT-6 Sol", effectivePercentRemaining: 90 },
  ],
  catalogModels: [
    { provider: "openai-codex", id: CODEX_MEDIUM_STARTER, name: CODEX_MEDIUM_STARTER },
    { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
  ],
};

/**
 * A computer with two Codex accounts: the pinned one serves GPT-6 Sol alone,
 * and only the other serves the starter map's medium model that routing takes.
 */
const TWO_CODEX_THERE = {
  routing: THIS_MAC_ON_NEWER_CODEX,
  signedInTo: [
    computerAccount("acct_codex_pinned", "openai-codex", { pinned: true }),
    computerAccount("acct_codex_other", "openai-codex"),
  ],
  served: [
    {
      accountId: "acct_codex_pinned",
      models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
    },
    {
      accountId: "acct_codex_other",
      models: [
        { provider: "openai-codex", id: CODEX_MEDIUM_STARTER, name: CODEX_MEDIUM_STARTER },
        { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
      ],
    },
  ],
};

/**
 * OpenRouter's list as Pi reads it on a computer signed in to it: more than
 * four hundred models (405 on 2026-10-09, Pi's own list merged with pi.dev's),
 * of which the board lists only OpenRouter's own aliases.
 */
function openRouterList(listed: readonly string[]): ServedThere["models"] {
  const others = Array.from({ length: 450 }, (_, n) => `vendor-${n}/model-${n}`);
  return [...listed, ...others].map((id) => ({ provider: "openrouter", id, name: id }));
}

/** An account row as a computer lists it: signed in and serving unless a test says otherwise. */
function computerAccount(
  id: string,
  providerId: string,
  extra: Partial<AccountView> = {},
): AccountView {
  return {
    id,
    providerId,
    kind: "subscription_oauth",
    label: id,
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: 1,
    ...extra,
  };
}

/** The reasons a task's routing decisions recorded, oldest first. */
function routingReasons(home: PlacedHome, taskId: string): string[] {
  const rows = home.db
    .prepare("SELECT reasons_json FROM decisions WHERE kind = 'routing' AND task_id = ?")
    .all(taskId) as { reasons_json: string }[];
  return rows.flatMap((row) => JSON.parse(row.reasons_json) as string[]);
}

/** The folders under `dir`, none when it is absent. */
function listed(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** The crewmate tools a newer version binds, with one of them described in other words. */
function reworded(name: string): CrewmateTool[] {
  return CREWMATE_TOOLS.map((tool: CrewmateTool): CrewmateTool => {
    if (tool.name !== name) return tool;
    const description = `${tool.description} Updated.`;
    return {
      ...tool,
      description,
      bind: (delegate) => {
        const bound = tool.bind(delegate);
        return bound && { ...bound, description };
      },
    };
  });
}

/** The timeline kinds a task's record holds, oldest first. */
function kinds(home: PlacedHome, taskId: string): string[] {
  return home.tasks.timeline(taskId).map((event) => event.kind);
}

it("carries only the opt-in to the running computer, which reads its own local files", async () => {
  const at = await world();
  const computerHome = scratchDir("fm-personal-computer-home-");
  writeFileSync(join(computerHome, "AGENTS.md"), "Computer user's local style.");
  const skill = join(computerHome, ".agents", "skills", "computer-rivets");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: computer-rivets\ndescription: Computer rivet rules.\n---\nCount here.",
  );
  const sent = vi.spyOn(at.home().devices, "ask");
  new SettingsStore(at.home().db).setPersonalResourcesEnabled(true);
  vi.stubEnv("HOME", computerHome);
  model([
    { tools: [{ name: "report", args: { text: "Local resources served.", summary: "Served." } }] },
    { text: "Reported." },
  ]);
  const first = api.requests.length;
  await at.start("t-personal");
  await expect
    .poll(() => at.home().tasks.get("t-personal")?.outcome)
    .toBe("Local resources served.");
  const system = JSON.stringify(api.requests[first]?.body.system);
  expect(system).toContain("Computer user's local style.");
  expect(system).toContain("Computer rivet rules.");
  const open = sent.mock.calls.find((call) => call[1] === "inf:session:open");
  expect(open).toBeDefined();
  const [order] = workOrders["inf:session:open"].request.parse(open?.[2]);
  expect(order?.spec.personalResources).toBe(true);
  expect(order?.spec.instructions).not.toContain("Computer user's local style.");
  expect(order?.spec.instructions).not.toContain(computerHome);
  sent.mockRestore();
  const record = at.home().tasks.get("t-personal")?.sessionFile;
  expect(record).toBeTruthy();
  await expect
    .poll(() => (record ? readFileSync(record, "utf8") : ""))
    .toContain("personal-resources");
  console.info("Placed resources:", system.slice(system.indexOf("Personal instructions from")));
});

describe("a task that runs on a computer that runs work", () => {
  // Intent: the captain's accepted INF-311 plan, window 1: the effect survives but its answer does not.
  it("does not repeat a begun change after a home restart without its answer (INF-312)", async () => {
    const at = await world();
    const slow = gate();
    model([{ held: slow.held, text: "Finished after recovery." }]);
    await at.start("t-begun");
    // The restart cuts a real held turn, not dispatch's initial idle state.
    await expect.poll(() => api.openRequests()).toBe(1);
    const request = { task: "t-begun", callId: "progress-cut", text: "Progress before the cut." };
    const dir = crewmatePlacedDir(at.home().paths, request.task);
    const progress = at.home().tasks.noteProgress.bind(at.home().tasks);
    const effect = vi.spyOn(at.home().tasks, "noteProgress").mockImplementation((...args) => {
      // The persisted mark is already readable at the effect's owner.
      expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).toContain(
        JSON.stringify(request.callId),
      );
      return progress(...args);
    });
    await at.home().placed.answer(at.deviceId, "inf:work:progress", request);
    expect(effect).toHaveBeenCalledTimes(1);
    effect.mockRestore();
    expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).toContain(
      JSON.stringify(request.callId),
    );
    expect(
      at
        .home()
        .tasks.timeline(request.task)
        .filter((event) => event.kind === "progress"),
    ).toHaveLength(1);
    // Model the exact cut: the change happened, but calls.jsonl never kept its answer.
    await at.restartHome(() => {
      writeFileSync(join(dir, "calls.jsonl"), "");
      // A report that began, but never answered, must not enter adoption's replay list.
      writeFileSync(
        join(dir, "begun.jsonl"),
        `${readFileSync(join(dir, "begun.jsonl"), "utf8")}\n${JSON.stringify("report-cut")}\n${JSON.stringify("card-cut")}\n${JSON.stringify("reply-cut")}\n`,
      );
    });
    await at.inReach(request.task);
    const home = at.home();
    const before = home.tasks
      .timeline(request.task)
      .filter((event) => event.kind === "progress").length;
    for (let repeat = 0; repeat < 2; repeat++)
      await expect(home.placed.answer(at.deviceId, "inf:work:progress", request)).rejects.toThrow(
        "stopped while recording your progress",
      );
    expect(
      home.tasks.timeline(request.task).filter((event) => event.kind === "progress"),
    ).toHaveLength(before);
    const kept = readFileSync(join(dir, "calls.jsonl"), "utf8");
    expect(kept.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(kept)).toMatchObject({
      callId: request.callId,
      error: expect.stringContaining("Read your task with tasks"),
    });
    expect(JSON.parse(kept).report).toBeUndefined();
    expect(JSON.parse(kept).error).toContain("Read your task with tasks before continuing");
    expect(JSON.parse(kept).error).not.toContain("timeline with tasks");
    expect(JSON.parse(kept).error).not.toMatch(/inf:work:|the destination/);
    await expect(
      home.placed.answer(at.deviceId, "inf:work:report", {
        task: request.task,
        callId: "report-cut",
        text: "Must not replay this report.",
      }),
    ).rejects.toThrow("the report may already be recorded");
    await expect(
      home.placed.answer(at.deviceId, "inf:work:card", {
        task: request.task,
        callId: "card-cut",
        card: {
          title: "Recovery check",
          body: "<p>Check before showing it again.</p>",
          actions: [],
        },
      }),
    ).rejects.toThrow("stopped while showing this card, so it may already be up");
    await expect(
      home.placed.answer(at.deviceId, "inf:work:reply", {
        task: request.task,
        callId: "reply-cut",
        cardId: "card-t-begun",
        text: "Already posted?",
      }),
    ).rejects.toThrow("cannot confirm whether the reply was posted");
    // Reads still run on another ask, rather than acquiring a begun mark.
    const read = { task: request.task, callId: "read-cut", input: {} };
    await home.placed.answer(at.deviceId, "inf:work:tasks", read);
    expect(readFileSync(join(dir, "begun.jsonl"), "utf8")).not.toContain("read-cut");
    expect(home.tasks.get(request.task)?.outcome).toBeNull();
    slow.open();
    // Idle can also describe adoption; the saved outcome witnesses this turn's completion.
    await expect.poll(() => home.tasks.get(request.task)?.outcome).toBe("Finished after recovery.");
    expect(home.tasks.get(request.task)?.activity).toBe("idle");
    console.info("Window 1 recovery:", kept.trim(), "progress count unchanged:", before);
  });

  it("leaves no begun mark when the task conversation is not ready (INF-312)", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-not-ready",
      title: "Not open",
      status: "running",
      deviceId: at.deviceId,
    });
    await expect(
      home.placed.answer(at.deviceId, "inf:work:progress", {
        task: "t-not-ready",
        callId: "not-ready",
        text: "Not yet.",
      }),
    ).rejects.toThrow("not open");
    expect(existsSync(join(crewmatePlacedDir(home.paths, "t-not-ready"), "begun.jsonl"))).toBe(
      false,
    );
  });

  // INF-40: the captain saw Working beside an empty Crewmate tab on a placed task.
  it("copies completed steps into the Crewmate tab before the placed turn ends", async () => {
    const at = await world();
    const held = gate();
    const next = gate();
    const copying = gate();
    const firstCopy = gate();
    const trailingCopy = gate();
    const home = at.home();
    const ask = home.devices.ask.bind(home.devices);
    let copies = 0;
    const sent = vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") {
        copies += 1;
        if (copies === 1) {
          firstCopy.open();
          await copying.held;
        } else if (copies === 2) trailingCopy.open();
      }
      return answer;
    });
    const progress = (text: string) => ({ tools: [{ name: "note_progress", args: { text } }] });
    model([
      progress("Reading the footer on Mac mini."),
      { ...progress("Checking the footer."), held: next.held },
      progress("The footer checks passed."),
      { held: held.held, text: "The footer is fixed." },
    ]);
    try {
      await at.start("t-live");
      await firstCopy.held;
      next.open();
      // The live transfer must not hold up event delivery or pile up one transfer per step.
      await expect
        .poll(() => kinds(home, "t-live").filter((kind) => kind === "progress").length)
        .toBe(3);
      expect(copies).toBe(1);
      // Review F3: a backwards clock adjustment cannot postpone the trailing transfer by a minute.
      ahead -= 60_000;
      copying.open();
      await expect.poll(() => api.openRequests()).toBe(1);
      const recordDirOf = (id: string) => crewmateSessionsDir(home.paths, id);
      const resolve = createCrewmateTranscriptResolver({
        recordDirOf,
        backendOf: () => undefined,
        configDirOf: () => undefined,
      });
      const reader = new CrewTranscripts({
        recordDirOf,
        currentSession: (task) => resolve(task).path,
      });
      const read = () => {
        const task = home.tasks.get("t-live");
        if (!task) throw new Error("The placed task is missing.");
        return reader.of(task, home.tasks.timeline(task.id), false);
      };
      await trailingCopy.held;
      await expect.poll(() => read().lines.filter((line) => line.kind === "plan").length).toBe(3);
      expect(copies).toBe(2);
      expect(home.tasks.get("t-live")?.activity).toBe("running");
      expect(api.openRequests()).toBe(1);
      held.open();
      await expect.poll(() => home.tasks.get("t-live")?.activity).toBe("idle");
      expect(read().lines).toContainEqual(
        expect.objectContaining({ kind: "said", text: "The footer is fixed." }),
      );
      const [file] = readdirSync(at.folders("t-live").sessions);
      expect(file).toBeDefined();
      expect(readFileSync(join(recordDirOf("t-live"), file ?? ""), "utf8")).toBe(
        readFileSync(join(at.folders("t-live").sessions, file ?? ""), "utf8"),
      );
    } finally {
      next.open();
      copying.open();
      held.open();
      sent.mockRestore();
    }
  });
  it("carries captain-message pictures and text into the started task's hand-over folder without a helper task", async () => {
    // INF-1389 friction 3: an attached screenshot must follow its task, not need a helper task.
    const vision = await piStubRuntime(api.url, {
      provider: PROVIDER,
      id: MODEL,
      input: ["text", "image"],
    });
    const at = await world(undefined, { runtime: vision });
    const home = at.home();
    const task = "t-message-files";
    const attachments = keepImages("captain-message-files", [{ ...pngImage, name: "dialog.png" }]);
    initOverflowDir(scratchDir("infinitary-message-files-"));
    const messageFiles: MessageFile[] = [];
    const content =
      "Date,Observation\r\n2026-10-25,Dialog cannot open\r\n".repeat(100) +
      "End of complete attachment.\r\n";
    const text = withPastedFiles(
      "Fix this dialog",
      [
        { name: "notes.csv", text: content },
        { name: "empty.txt", text: "" },
      ],
      messageFiles,
    );
    seedTask(home.tasks, {
      id: task,
      title: "Fix the dialog",
      prompt: text,
      status: "queued",
      deviceId: at.deviceId,
    });
    home.tasks.openAsk({ id: "message-files", text, attachments, messageFiles });
    home.tasks.attachAsk("message-files", task, "tool:create_task");
    // Read the durable references again at dispatch, not the initial input objects.
    expect(home.tasks.getAsk("message-files")?.messageFiles).toEqual(messageFiles);
    const dir = join(at.folders(task).temp, "handover");
    const picture = attachments[0];
    const file = messageFiles[0];
    const empty = messageFiles[1];
    if (!picture || !file || !empty) throw new Error("No attachment references");
    const imagePath = join(dir, handoverFileName(picture.name, picture.sha256));
    const textPath = join(dir, handoverFileName(file.name, file.sha256));
    const emptyPath = join(dir, handoverFileName(empty.name, empty.sha256));
    model([
      {
        tools: [
          { name: "read", args: { path: imagePath } },
          { name: "read", args: { path: textPath } },
        ],
      },
      { text: "Opened the picture and the complete text file from my hand-over folder." },
    ]);
    const requests = api.requests.length;
    await home.supervisor.dispatchQueuedTask(task);
    expect(home.tasks.get(task)?.gate, JSON.stringify(home.tasks.timeline(task))).toBeNull();
    expect(home.tasks.get(task)?.status).toBe("active");
    await expect.poll(() => home.tasks.get(task)?.activity).toBe("idle");
    expect(JSON.stringify(api.requests.at(-1))).toContain("End of complete attachment.");
    expect(readFileSync(emptyPath).length).toBe(0);
    expect(readFileSync(imagePath)).toEqual(readFileSync(attachmentPath(picture)));
    expect(readFileSync(textPath).equals(Buffer.from(content))).toBe(true);
    for (const path of [imagePath, textPath, emptyPath])
      expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const request = JSON.stringify(api.requests.slice(requests));
    expect(request).toContain(imagePath);
    expect(request).toContain(textPath);
    expect(
      home.tasks
        .list()
        .filter((entry) => entry.kind === "work")
        .map((entry) => entry.id),
    ).toEqual([task]);
    console.log(
      "INF-1389 attachment delivery proof",
      JSON.stringify({
        files: [imagePath, textPath, emptyPath].map((path) => ({
          path,
          bytes: statSync(path).size,
          mode: statSync(path).mode & 0o777,
        })),
        directoryMode: statSync(dir).mode & 0o777,
        completeBytesMatch: true,
        destinationPathsInBrief: true,
        workTasks: [task],
      }),
    );
  });

  // INF-2225, INF-2214's approved shared cards: a computer from before shared
  // cards would read a write on someone else's card as its own card shown,
  // so the home refuses it before anything is saved.
  it("refuses a write on someone else's card from a computer before shared cards, saving nothing", async () => {
    const at = await world(undefined, {
      changes: CONTRACT_CHANGES.names.filter((change) => change !== "shared-cards"),
    });
    const home = at.home();
    // Its hello has arrived; a list with no names is sent as none at all.
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    expect(home.devices.version(at.deviceId)?.changes ?? []).not.toContain("shared-cards");
    expect(home.placed.takesSharedCards(at.deviceId)).toBe(false);
    model([{ text: "Looking for the remover." }]);
    await at.start("t-old-cards", "Find the job host remover's path.");
    await expect.poll(() => home.tasks.get("t-old-cards")?.activity).toBe("idle");
    const id = home.supervisor.addFirstmateCard({
      title: "Remove the job host",
      body: "<p>Run the remover on the shell PC.</p>",
      actions: [],
    });
    const answer = await home.placed.answer(at.deviceId, "inf:work:card", {
      task: "t-old-cards",
      callId: "old-shared-write",
      card: {
        id,
        title: "Remove the job host",
        body: "<p>Run C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd on the shell PC.</p>",
        actions: [],
        reply: "It is at C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd.",
      },
    });
    expect(answer).toMatchObject({
      refused: { reason: "other", why: expect.stringContaining("runs an older Infinitary") },
    });
    expect(home.supervisor.cardThread(id).messages).toEqual([]);
    const cards = home.supervisor.cardsSnapshot();
    expect(cards.find((card) => card.id === id)?.body).toBe(
      "<p>Run the remover on the shell PC.</p>",
    );
    expect(cards.filter((card) => card.taskId === "t-old-cards")).toEqual([]);
  });

  // INF-1555 F12: both declaration and offer semantics are required before remote work begins.
  it("keeps a direct-pr change queued until its computer runs this contract major", async () => {
    // The check tool's declarations and merge offers are part of this major (major-13.md).
    const previous = `${Number(PROTOCOL_VERSION.split(".")[0]) - 1}.0.0`;
    const at = await world(undefined, { protocolVersion: previous });
    const home = at.home();
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(previous);
    expect(home.placed.takesCheckDeclarations(at.deviceId)).toBe(false);

    const { repo } = await home.repos.setup({ kind: "init", name: "check-declarations" });
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    seedTask(home.tasks, {
      id: "t-old-check-tool",
      title: "Fix the project checks",
      status: "queued",
      repoId: repo.id,
      deviceId: at.deviceId,
      shape: { kind: "fix", kind_source: "host:test", deliverable: "change", rigor_ask: "quick" },
    });
    const requests = api.requests.length;
    await home.supervisor.dispatchQueuedTask("t-old-check-tool");
    expect(home.tasks.get("t-old-check-tool")).toMatchObject({ status: "open", activity: null });
    expect(home.placed.ready(at.deviceId, "t-old-check-tool")).toBe(false);
    expect(api.requests).toHaveLength(requests);
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => home.placed.takesCheckDeclarations(at.deviceId)).toBe(true);
  });

  it.each(["10.1.0", "11.0.0"])(
    "keeps an attachment task queued on an older contract %s",
    async (protocolVersion) => {
      // INF-1389 friction 3: no silent path-only fallback on an older computer.
      const at = await world(undefined, {
        protocolVersion,
      });
      const home = at.home();
      initOverflowDir(scratchDir("infinitary-attachment-update-"));
      const messageFiles: MessageFile[] = [];
      const text = withPastedFiles("Read this", [{ name: "empty.txt", text: "" }], messageFiles);
      seedTask(home.tasks, {
        id: "t-old-attachments",
        title: "Read attached file",
        prompt: text,
        status: "queued",
        deviceId: at.deviceId,
      });
      home.tasks.openAsk({ id: "old-attachments", text, messageFiles });
      home.tasks.attachAsk("old-attachments", "t-old-attachments", "tool:create_task");
      const requests = api.requests.length;
      await home.supervisor.dispatchQueuedTask("t-old-attachments");
      expect(home.tasks.get("t-old-attachments")).toMatchObject({ status: "open", activity: null });
      expect(home.devices.version(at.deviceId)?.contract).toBe(protocolVersion);
      expect(home.placed.ready(at.deviceId, "t-old-attachments")).toBe(false);
      expect(home.placed.takesHandover(at.deviceId)).toBe(false);
      expect(api.requests.length).toBe(requests);
      await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
      await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
      await at.inReach("t-old-attachments");
      model([{ text: "Read the attached file." }]);
      await home.supervisor.dispatchQueuedTask("t-old-attachments");
      await expect
        .poll(() => home.tasks.get("t-old-attachments")?.outcome)
        .toBe("Read the attached file.");
      const files = readdirSync(join(at.folders("t-old-attachments").temp, "handover"));
      expect(files).toHaveLength(1);
      expect(
        statSync(join(at.folders("t-old-attachments").temp, "handover", files[0] ?? "missing"))
          .size,
      ).toBe(0);
    },
  );

  it("hands a file one task there reports to another task there, and never puts its content anywhere else", async () => {
    // INF-992, direction B: "a second task can hand files to the waiting
    // task"; the captain's words on it: "make sure file content never gets
    // printed or leaked because it's possible the file can contain secrets".
    const at = await world();
    const secret = `client_secret=${createHash("sha256").update("INF-992").digest("hex")}`;
    const found = join(scratchDir("infinitary-placed-found-"), "client secret.json");
    writeFileSync(found, `{"installed":{"${secret}"}}\n`);
    model([{ text: "Waiting for the client file." }]);
    await at.start("t-wait", "Build with the Google client file.");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-wait")?.activity).toBe("idle");
    model([
      { tools: [{ name: "report", args: { text: "Found the client file.", files: [found] } }] },
      { text: "Reported." },
    ]);
    const requests = api.requests.length;
    await at.start("t-find", "Find the Google client file.");
    await expect.poll(() => home.tasks.get("t-find")?.activity).toBe("idle");
    // The home holds it whole, and its report names it by kept name and size alone.
    const sha256 = createHash("sha256").update(readFileSync(found)).digest("hex");
    const kept = `${sha256.slice(0, 16)}-client_secret.json`;
    const atHome = join(home.paths.crewmatesDir, "t-find", "handover-out", kept);
    expect(readFileSync(atHome)).toEqual(readFileSync(found));
    expect(statSync(atHome).mode & 0o777).toBe(0o600);
    expect(home.tasks.get("t-find")?.outcome).toContain(
      `Files handed on, kept for steer_crewmate files_from ${home.tasks.get("t-find")?.key}: ${kept}`,
    );
    // The first mate's steer hands it to the waiting task, in its hand-over folder there.
    model([{ text: "Using it." }]);
    const words = await home.supervisor.handFiles("t-find", "t-wait");
    const delivered = join(at.folders("t-wait").temp, "handover", kept);
    expect(words).toContain(delivered);
    expect(readFileSync(delivered)).toEqual(readFileSync(found));
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
    // Nothing but the handed copies holds its content: no record, transcript,
    // feed line, journal or model request on either computer.
    const holders = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((name) => {
        const path = join(dir, name);
        return lstatSync(path).isFile() && readFileSync(path).includes(secret) ? [path] : [];
      });
    expect(holders(home.paths.crewmatesDir)).toEqual([atHome]);
    expect(holders(dirname(home.paths.crewmatesDir)).filter((path) => path !== atHome)).toEqual([]);
    expect(holders(at.dataDir).sort()).toEqual(
      [join(at.folders("t-find").temp, "handover-out", kept), delivered].sort(),
    );
    expect(JSON.stringify(api.requests.slice(requests))).not.toContain(secret);
    expect(words).not.toContain(secret);
  });

  // INF-1484 E1: on-ask history must survive the real placed session's work-request parser.
  // Real paired connection, SessionHost, home dispatcher and SQLite; only model words are scripted.
  it("carries an explicit timeline field through a placed session without expanding ordinary reads", async () => {
    const at = await world();
    const home = at.home();
    const target = seedTask(home.tasks, {
      id: "timeline-target",
      title: "Read the saved practice release checks",
      status: "queued",
      startPolicy: "on-request",
      intent: {
        goal: "The earlier check remains readable.",
        userWords: "read the saved practice release checks",
      },
    });
    home.tasks.recordReport(target.id, {
      text: "The Mac check stopped the practice release. The saved work is unchanged.",
    });
    const expected = new TaskTimeline({ tasks: home.tasks }).sources(target.id);
    expect(expected.length).toBeGreaterThan(0);
    const outcome = "The placed history read is complete.";
    model([
      { tools: [{ name: "tasks", args: { key: target.key } }] },
      { tools: [{ name: "tasks", args: { key: target.key, field: "timeline" } }] },
      { tools: [{ name: "report", args: { text: outcome } }] },
      { text: "Reported." },
    ]);
    await at.start("t-first");
    await expect.poll(() => home.tasks.get("t-first")?.outcome).toBe(outcome);
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-first"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { channel: string; answer?: { rows: Record<string, unknown>[] } },
      );
    const replies = calls
      .filter((call) => call.channel === "inf:work:tasks")
      .map((call) => call.answer);
    expect(replies).toHaveLength(2);
    expect(replies[0]?.rows[0]).toMatchObject({ task_id: target.id, key: target.key });
    expect(replies[0]?.rows[0]).not.toHaveProperty("timeline");
    expect(replies[1]?.rows[0]?.timeline).toEqual(expected);
    console.info("Placed on-ask history replies", JSON.stringify({ task: target.key, replies }));
  });

  it("starts there, does each callback once here, and keeps its report and a copy of its record", async () => {
    const at = await world();
    model([
      { tools: [{ name: "note_progress", args: { text: "Started on the footer." } }] },
      { tools: [{ name: "report", args: { text: "The footer is fixed.", summary: "Fixed." } }] },
      { text: "Reported." },
    ]);
    const requests = api.requests.length;
    await at.start("t-first");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-first")?.outcome).toBe("The footer is fixed.");
    expect(home.tasks.get("t-first")).toMatchObject({
      deviceId: at.deviceId,
      activity: "idle",
      worktreeDir: "",
      sessionFile: expect.stringContaining(at.folders("t-first").sessions),
    });
    // Its brief reached the model there, as a crewmate told that computer's folders.
    const brief = api.requests[requests];
    expect(said(brief)).toContain("Fix the footer.");
    expect(JSON.stringify(brief?.body.system)).toContain(at.folders("t-first").evidence);
    // It is told which computer it is on (INF-567: "hmm this is because we
    // set this up on my macbook?"), so a folder path from the home reads as
    // naming nothing there.
    expect(JSON.stringify(brief?.body.system)).toContain(
      JSON.stringify(
        crewmateComputersNote({
          here: "Builder",
          workers: [{ name: "Builder", sameComputer: true }],
        }),
      ).slice(1, -1),
    );
    // Each callback had its effect here once, and the brief left the lane.
    expect(kinds(home, "t-first").filter((kind) => kind === "progress")).toHaveLength(1);
    expect(home.inbox.allFor("t-first")).toEqual([]);
    expect(home.inbox.inFlight("t-first")).toEqual([]);
    expect(api.requests.length - requests).toBe(3);
    // The crew's events reached the feed as any crewmate's do, named by where it runs.
    expect(home.events).toContainEqual(
      expect.objectContaining({ type: "task_started", taskId: "t-first", machineId: at.deviceId }),
    );
    expect(home.events).toContainEqual(
      expect.objectContaining({ type: "tool_start", taskId: "t-first", toolName: "report" }),
    );
    // A copy of its record is here, the same bytes as there.
    const there = at.folders("t-first").sessions;
    const [file] = readdirSync(there);
    expect(file).toBeDefined();
    const copy = join(crewmateSessionsDir(home.paths, "t-first"), file ?? "");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(there, file ?? ""), "utf8"));
    // Every callback's answer is kept here, by its id.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-first"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { channel: string });
    expect(calls.map((call) => call.channel)).toEqual(["inf:work:progress", "inf:work:report"]);
  });

  it("keeps the captain's reply waiting after a still-working line from that computer, as it does here (INF-1623)", async () => {
    // INF-1595's exchange: the crewmate there said what it was checking,
    // marked as still working, and the mark was lost on the way home, so
    // that line ended the captain's wait.
    const at = await world();
    const home = at.home();
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              id: "retire-plan",
              title: "Retire a closed task's working copy",
              body: "<p>I retire the copy once its task closes.</p>",
            },
          },
        ],
      },
      { text: "The card is up." },
    ]);
    await at.start("t-interim");
    await expect.poll(() => home.cards().find((card) => card.taskId === "t-interim")).toBeTruthy();
    const card = home.cards().find((card) => card.taskId === "t-interim");
    if (!card) throw new Error("No card from t-interim");
    await expect.poll(() => home.tasks.get("t-interim")?.activity).toBe("idle");
    model([
      {
        tools: [
          {
            name: "reply",
            args: {
              card_id: card.id,
              text: "Checking how this change meets the warm pool of ready working copies before I answer.",
              interim: true,
            },
          },
        ],
      },
      { text: "Checking." },
    ]);
    const requests = api.requests.length;
    home.supervisor.replyToCard(
      card.id,
      "wait - do you mean worktrees? aren't we supposed to keep warm worktrees?",
    );
    await expect.poll(() => api.requests.length).toBe(requests + 2);
    await expect.poll(() => home.tasks.get("t-interim")?.activity).toBe("idle");
    expect(JSON.stringify(api.requests.at(-1)?.body)).toContain(
      "still waits for your answer when the work is done",
    );
    expect(home.cards().find((shown) => shown.id === card.id)?.awaiting).toBe("answer");
  });

  it("holds the task out of reach while the connection is gone, and catches up exactly once it is back", async () => {
    const at = await world();
    const slow = gate();
    model([
      { held: slow.held, text: "The footer is fixed after a wait." },
      { text: "The footer is blue now." },
    ]);
    const requests = api.requests.length;
    await at.start("t-drop");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    // The Tasks row says it is out of reach; while its connection is being
    // made it says connecting instead, with no warn mark (INF-49).
    const dropped = home.tasks.get("t-drop");
    if (!dropped) throw new Error("no task");
    expect(home.supervisor.taskPlace(dropped)).toMatchObject({ reach: "out-of-reach" });
    connectingNow.add(at.deviceId);
    const connectingPlace = home.supervisor.taskPlace(dropped);
    connectingNow.clear();
    // Protocol 9 carries only the core reach reading.
    expect(connectingPlace).toMatchObject({ reach: "connecting" });

    // Out of reach: words wait on its lane, nothing calls it stuck, and after
    // a minute the feed says so once.
    expect(await home.supervisor.steerCrewmate("t-drop", "Make it blue too.")).toBe(
      "recorded-held",
    );
    const before = kinds(home, "t-drop").length;
    home.supervisor.checkQuietTasks(now() + 3 * 60 * 60 * 1000);
    expect(kinds(home, "t-drop").slice(before)).not.toContain("note");
    const lines = () =>
      home.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
    // While its connection is still being made the line is held, not said as out of reach.
    connectingNow.add(at.deviceId);
    home.placed.tick(now() + 61_000);
    expect(lines().filter((line) => line.includes("out of reach"))).toEqual([]);
    connectingNow.clear();
    home.placed.tick(now() + 61_000);
    home.placed.tick(now() + 120_000);
    expect(lines().filter((line) => line.includes("out of reach"))).toEqual([
      "Mac mini is out of reach. Its work on website catches up here when it is back.",
    ]);

    // The turn goes on there and ends while the home cannot hear it.
    slow.open();
    await expect.poll(() => api.openRequests()).toBe(0);
    expect(home.tasks.get("t-drop")?.activity).toBe("running");

    await home.listen();
    await expect.poll(() => home.tasks.get("t-drop")?.outcome).toBe("The footer is blue now.");
    // Caught up exactly: the first turn's end, then the held words as the next turn, each once.
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Make it blue too.");
    expect(home.inbox.allFor("t-drop")).toEqual([]);
    expect(lines()).toContain("Mac mini is back. Its work on website caught up.");
  });

  it("never says the work of a computer that runs work for another Firstmate now catches up when it is back", async () => {
    let left = false;
    const at = await world(undefined, { runsForAnotherFirstmate: () => left });
    model([{ text: "Waiting for review." }]);
    await at.start("t-left");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-left")?.activity).toBe("idle");

    // It left this Firstmate for another one, and this Mac's SSH connection found that.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    left = true;
    home.placed.tick(now() + 61_000);
    home.placed.tick(now() + 120_000);
    const lines = home.events.flatMap((event) =>
      event.type === "firstmate_note" && event.text.startsWith("Mac mini") ? [event.text] : [],
    );
    expect(lines).toEqual([
      "Mac mini runs work for another first mate now. Its work on website stops when you remove it here.",
    ]);
  });

  it("never nudges, wakes about or calls stuck an idle task whose computer is out of reach", async () => {
    const at = await world();
    model([{ text: "Waiting for review." }]);
    await at.start("t-idle");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-idle")?.activity).toBe("idle");
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const wakes = home.wakes.length;
    // Hours of its idle clock pass while that computer is gone.
    for (const hours of [1, 2, 3]) home.supervisor.reconcileIdle(now() + hours * 60 * 60 * 1000);
    expect(home.inbox.allFor("t-idle")).toEqual([]);
    expect(home.wakes.slice(wakes)).toEqual([]);
    expect(home.tasks.get("t-idle")?.recoveryRung ?? 0).toBe(0);
  });

  it("INF-2214 keeps a remote requested answer through a home restart and later progress, with one notification", async () => {
    const at = await world();
    const slow = gate();
    model([{ held: slow.held, text: "Still checking the remover." }, { text: "Checks finished." }]);
    const taskId = "t-path-response";
    await at.start(taskId, "Find the remover path.");
    await expect.poll(() => api.openRequests()).toBe(1);
    await at
      .home()
      .supervisor.steerCrewmate(
        taskId,
        "What is the full path to setup/shell-pc/shell-pc-job-host-remove.cmd?",
        "firstmate",
        { response: { mode: "expected" } },
      );
    const request = at.home().inbox.pendingResponses(taskId)[0]!;
    const text = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
    const submitted = {
      task: taskId,
      callId: "path-response",
      text,
      declared: {
        responses: [
          { requestId: request.id, responseId: "remote-path-answer", status: "answered" as const },
        ],
      },
    };
    await at.home().placed.answer(at.deviceId, "inf:work:report", submitted);
    const saved = at.home().inbox.savedResponse("remote-path-answer")!;
    expect(saved.text).toBe(text);
    expect(at.home().inbox.get(saved.wakeId)?.facts).toMatchObject({
      kind: "requested-response",
      contributorTask: taskId,
      excerpt: text,
    });
    await at.home().placed.answer(at.deviceId, "inf:work:report", {
      task: taskId,
      callId: "later-progress",
      text: "The checks are still running.",
    });
    await at.restartHome();
    await at.inReach(taskId);
    expect(at.home().inbox.savedResponse("remote-path-answer")).toEqual(saved);
    await at.home().placed.answer(at.deviceId, "inf:work:report", submitted);
    expect(
      at
        .home()
        .inbox.allFor("firstmate")
        .filter((row) => row.facts?.kind === "requested-response"),
    ).toHaveLength(1);
    slow.open();
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    expect(at.home().inbox.savedResponse("remote-path-answer")?.text).toBe(text);
    expect(
      at
        .home()
        .inbox.allFor("firstmate")
        .filter((row) => row.facts?.kind === "response-missing"),
    ).toEqual([]);
  });

  it("follows a turn a home restart left running there, with no second prompt, and keeps the report it already gave", async () => {
    const at = await world();
    const slow = gate();
    model([
      { tools: [{ name: "report", args: { text: "Reported before the restart." } }] },
      { held: slow.held, text: "Still finishing." },
    ]);
    const requests = api.requests.length;
    await at.start("t-restart");
    // The report is answered here, and the turn goes on there.
    await expect
      .poll(() => existsSync(join(crewmatePlacedDir(at.home().paths, "t-restart"), "calls.jsonl")))
      .toBe(true);
    await expect.poll(() => api.openRequests()).toBe(1);

    await at.restartHome();
    const home = at.home();
    // The restart did not mark it interrupted: the turn there is followed here.
    await expect.poll(() => home.tasks.get("t-restart")?.activity).toBe("running");
    await expect.poll(() => home.placed.ready(at.deviceId, "t-restart")).toBe(true);

    slow.open();
    await expect.poll(() => home.tasks.get("t-restart")?.activity).toBe("idle");
    expect(home.tasks.get("t-restart")?.outcome).toBe("Reported before the restart.");
    // One brief, asked of the model once: no turn ran twice.
    expect(api.requests.length - requests).toBe(2);
    expect(home.inbox.inFlight("t-restart")).toEqual([]);
    expect(home.inbox.allFor("t-restart")).toEqual([]);
  });

  // Captain's INF-352 W1: the helper owns the ending of a continuation its restart cut off.
  it.each(["copy-loop", "home-turn"] as const)(
    "ends a Claude continuation after a helper restart: %s",
    async (check) => {
      const scheduled = new Set<{ due: number; run: () => void }>();
      const heldCall = gate();
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, {
        claude,
        scheduleCopy: (ms, run) => {
          const timer = { due: now() + ms, run };
          scheduled.add(timer);
          return () => {
            scheduled.delete(timer);
          };
        },
      });
      const home = at.home();
      const ask = home.devices.ask.bind(home.devices);
      let copies = 0;
      let copying = 0;
      const sent = vi
        .spyOn(home.devices, "ask")
        .mockImplementation(async (device, channel, args) => {
          if (channel === "inf:session:copy") copying += 1;
          try {
            const answer = await ask(device, channel, args);
            if (channel === "inf:session:copy") copies += 1;
            return answer;
          } finally {
            if (channel === "inf:session:copy") copying -= 1;
          }
        });
      const fireNext = () => {
        const timer = scheduled.values().next().value;
        if (!timer) return;
        scheduled.delete(timer);
        ahead += Math.max(0, timer.due - now());
        timer.run();
      };
      const taskId = "t-continuation-restart";
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        claude.answer({ tool: "note_progress", answer: "Not reached while held." });
        claude.continueTurn();
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("running");
        await expect
          .poll(() =>
            home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
          )
          .toBe(true);
        const before = copies;
        await expect
          .poll(() => {
            fireNext();
            return copies;
          })
          .toBeGreaterThan(before);
        await at.restartComputer();
        await at.inReach(taskId);
        if (check === "home-turn") {
          await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
          const failure = home.wakes.find((wake) => wake.facts?.kind === "turn-failed");
          const computer = at
            .pairing()
            .list()
            .find((device) => device.id === at.deviceId);
          expect(computer).toBeDefined();
          expect(failure?.facts).toMatchObject({
            error: `${computer?.name} quit before this turn finished.`,
          });
        } else {
          await expect
            .poll(async () => {
              fireNext();
              await new Promise<void>((resolve) => setImmediate(resolve));
              return scheduled.size === 0 && copying === 0;
            })
            .toBe(true);
        }
      } finally {
        claude.endClient();
        heldCall.open();
        sent.mockRestore();
      }
    },
  );

  // INF-2332, FIRS-6: a Claude crewmate carried on by itself on the Mac mini
  // while the home was away, and its report waited for the home. The home came
  // back with updated instructions, the Mac mini closed that conversation for
  // them, the report was lost and the task showed working for a day. Now the
  // computer keeps the turn - a carried-on one, or a prompt's - and the home
  // asks again once it ends, so the conversation starts over for the new
  // instructions as INF-296 carries one: the record names it, the timeline
  // says why, and the next turn hears its brief and earlier transcript.
  it.each(["carried-on", "prompt"] as const)(
    "keeps a %s turn through the home's return with new instructions, so its report arrives and the task leaves working with no stop, then starts over for them once it ends (INF-2332, FIRS-6)",
    async (turn) => {
      const claude = await scriptedClaudeWorld();
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const taskId = `t-firs6-${turn}`;
      const reported = "All 29 tests passed.";
      const told = (type: string, tool?: string) =>
        new PlacedTasks(at.dataDir)
          .outbox(taskId, 0)
          .some(
            ({ event }) =>
              event.type === type &&
              (tool === undefined || ("toolName" in event && event.toolName === tool)),
          );
      const report = { tool: "report" as const, args: { text: reported }, answer: "Reported." };
      try {
        // The home stops answering the report, as one out of reach does.
        let waiting: { mockRestore(): void; mock: { calls: unknown[][] } } | undefined;
        const holdReports = () => {
          const away = at.home();
          const answer = away.placed.answer.bind(away.placed);
          waiting = vi
            .spyOn(away.placed, "answer")
            .mockImplementation(((device, channel, request) =>
              channel === "inf:work:report"
                ? new Promise(() => {})
                : answer(device, channel, request)) as typeof away.placed.answer);
        };
        if (turn === "carried-on") {
          claude.answer({ text: "Running 29 tests; I will check back in 30 minutes." });
          await at.start(taskId);
          await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
          // The tests finish, the crewmate carries on by itself there and
          // calls report, which waits.
          holdReports();
          claude.answer(report);
          claude.continueTurn();
        } else {
          holdReports();
          claude.answer(report);
          await at.start(taskId, "Run the 29 tests and report them.");
        }
        await expect.poll(() => told("tool_start", "report")).toBe(true);
        await expect
          .poll(() => waiting?.mock.calls.some(([, channel]) => channel === "inf:work:report"))
          .toBe(true);
        const earlier = at.home().tasks.get(taskId)?.sessionFile ?? "";
        expect(earlier).not.toBe("");
        const opens: PlacedSpec[] = [];
        await at.restartHome(
          () => {
            waiting?.mockRestore();
          },
          (home) => {
            // The home comes back updated: the instructions it opens with changed.
            const ask = home.devices.ask.bind(home.devices);
            vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
              if (channel !== "inf:session:open") return ask(device, channel, args);
              const [open] = args as [{ spec: PlacedSpec }];
              const updated = open.spec.instructions.endsWith(" Updated.")
                ? open.spec.instructions
                : `${open.spec.instructions} Updated.`;
              const spec = { ...open.spec, instructions: updated };
              opens.push(spec);
              return ask(device, channel, [{ ...open, spec }]);
            });
          },
        );
        const home = at.home();
        await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe(reported);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        if (turn === "carried-on") expect(told("continuation_ended")).toBe(true);
        expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
        expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);

        // The turn over, the home asked again: the conversation started over
        // for the new instructions, and the home heard it.
        await expect.poll(() => opens.length).toBeGreaterThan(1);
        await expect.poll(() => home.tasks.get(taskId)?.sessionFile).not.toBe(earlier);
        const renewal = { from: earlier, changed: ["prompt" as const] };
        expect(
          home.tasks
            .timeline(taskId)
            .filter(
              (event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal),
            ),
        ).toHaveLength(1);
        const asked = claude.served().length;
        claude.answer({ text: "Carrying on." });
        await home.supervisor.steerCrewmate(taskId, "Now the header.");
        await expect.poll(() => claude.served().length).toBeGreaterThan(asked);
        const said = claude.served().at(-1)?.said ?? "";
        expect(said).toContain(join(at.folders(taskId).sessions, `${earlier}.jsonl`));
        expect(said).toContain("Now the header.");
        expect(claude.served().at(-1)?.system).toContain("Updated.");
        // The open owed during the turn went again only once it ended, so no
        // answer read to the supervisor as its computer reopening mid-turn,
        // and the steer after it stopped no recovery.
        const recovery = home.tasks
          .timeline(taskId)
          .map((event) => (event.data?.restartOutcome as { outcome?: string } | undefined)?.outcome)
          .filter((outcome) => outcome !== undefined);
        expect(
          recovery.filter((outcome) => outcome === "waiting" || outcome === "stopped"),
        ).toEqual([]);
      } finally {
        claude.endClient();
      }
    },
  );

  // INF-2332: whether a turn is working comes from the live session on the
  // computer that runs it. A turn whose end never reaches the home ends here
  // as interrupted once that computer says it is not working with every event
  // in - when the computer comes back, after twenty quiet minutes, or right
  // after a stop - and the idle ladder takes the task from there.
  it.each(["return", "quiet", "stop"] as const)(
    "ends a turn whose end never arrived once its computer says it is not working: %s (INF-2332)",
    async (trigger) => {
      const claude = await scriptedClaudeWorld();
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const home = at.home();
      const taskId = `t-unheard-${trigger}`;
      // The end of the crewmate's carried-on turn is lost on its way home,
      // while every other event arrives, as FIRS-6's end never did.
      const answer = home.placed.answer.bind(home.placed);
      /** Whether the home has taken the events up to the one in place of the lost end. */
      let tookLostEnd = false;
      const lost = vi.spyOn(home.placed, "answer").mockImplementation(((
        device,
        channel,
        request,
      ) => {
        if (channel !== "inf:work:events") return answer(device, channel, request);
        const { events, ...rest } = request as { task: string; events: PlacedEventRecord[] };
        const losing = events.some(({ event }) => event.type === "continuation_ended");
        const taken = answer(device, channel, {
          ...rest,
          events: events.map((record) =>
            record.event.type === "continuation_ended"
              ? { ...record, event: { type: "request_started" } }
              : record,
          ),
        } as never);
        return losing
          ? taken.then((answered) => {
              tookLostEnd = true;
              return answered;
            })
          : taken;
      }) as typeof home.placed.answer);
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        const wakes = home.wakes.length;
        claude.answer({ text: "The check is done." });
        claude.continueTurn();
        // The home took every event of the carried-on turn but its end: the
        // roster it read before the turn says nothing of these events.
        await expect.poll(() => tookLostEnd).toBe(true);
        // The computer is done, but the home never heard it.
        expect(home.tasks.get(taskId)?.activity).toBe("running");
        if (trigger === "return") {
          await at.stopComputer();
          await at.restartComputer();
          await at.inReach(taskId);
        } else if (trigger === "quiet") {
          home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
        } else {
          await home.supervisor.interruptCrewmate(taskId, "interrupt");
        }
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        expect(home.tasks.timeline(taskId).map((event) => event.text)).toContain(UNHEARD_END_NOTE);
        // Ended as interrupted, never as a failure the first mate is woken for.
        expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
        expect(
          home.wakes
            .slice(wakes)
            .some(
              (wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed",
            ),
        ).toBe(false);
        // The captain's "Ask first, then alert": an answer that the turn is
        // over raises no quiet alert.
        expect(home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet")).toBe(false);
        expect(
          home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
        ).toBe(false);
      } finally {
        lost.mockRestore();
        claude.endClient();
      }
    },
  );

  // INF-2332 leaves alone: a turn that is really running is never stopped.
  // The captain's "Ask first, then alert": the twenty-minute pass asks the
  // computer first, and raises the quiet alert only on its answer that the
  // turn still works, or on no answer.
  it.each(["working", "no answer"] as const)(
    "keeps a quiet turn its crewmate really carries on by itself, alerting only after the computer's answer (%s), and its words arrive when it ends (INF-2332)",
    async (answer) => {
      const heldCall = gate();
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const home = at.home();
      const taskId = "t-really-running";
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        claude.answer({
          tool: "note_progress",
          args: { text: "Reading the results." },
          answer: "The check passed.",
        });
        claude.continueTurn();
        await expect
          .poll(() =>
            home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
          )
          .toBe(true);
        const wakes = home.wakes.length;
        const alerted = () =>
          home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet") &&
          home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck"));
        // The computer's answer is held until the home has looked.
        const roster = gate();
        const ask = home.devices.ask.bind(home.devices);
        const asked = vi
          .spyOn(home.devices, "ask")
          .mockImplementation(async (device, channel, args) => {
            if (channel !== "inf:session:roster") return ask(device, channel, args);
            await roster.held;
            if (answer === "no answer") throw new Error("The computer did not answer.");
            return ask(device, channel, args);
          });
        home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
        await expect
          .poll(() => asked.mock.calls.some(([, channel]) => channel === "inf:session:roster"))
          .toBe(true);
        expect(alerted()).toBe(false);
        roster.open();
        await expect.poll(alerted).toBe(true);
        asked.mockRestore();
        expect(home.tasks.get(taskId)?.activity).toBe("running");
        heldCall.open();
        await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The check passed.");
        expect(home.tasks.timeline(taskId).map((event) => event.text)).not.toContain(
          UNHEARD_END_NOTE,
        );
      } finally {
        claude.endClient();
        heldCall.open();
      }
    },
  );

  // INF-2603, the captain's approved direction B: "Name the wait and settle
  // the app's own calls". A read the crewmate there asked its home and the
  // home never answered (INF-2550's 13 hours inside one github_read) is
  // answered "ask again" at the twenty-minute check on the computer that runs
  // the turn, so the turn goes on and reads the steer queued behind it.
  it("answers a read the home never answered at the twenty-minute check, and the steer behind it reaches the carried-on turn (INF-2603)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-lost-read";
    // The home never answers the crewmate's task read: lost on the way.
    const answer = home.placed.answer.bind(home.placed);
    let readAsked = false;
    const lost = vi.spyOn(home.placed, "answer").mockImplementation(((device, channel, request) => {
      if (channel !== "inf:work:tasks") return answer(device, channel, request);
      readAsked = true;
      return new Promise(() => {});
    }) as typeof home.placed.answer);
    claude.answer({ text: "The background check started." });
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      claude.answer({ tool: "tasks", args: { status: "open" }, answer: "Done reading." });
      claude.continueTurn();
      await expect.poll(() => readAsked).toBe(true);
      // INF-2558: a steer reaches the turn the crewmate carries on by itself.
      await home.supervisor.steerCrewmate(taskId, "Check the header too.");
      const asked = claude.served().length;
      home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Done reading.");
      // The turn goes on with the answer, and reads the steer in that same request.
      const answered = answeredReadText("tasks", QUIET_CARD_MS).split(":")[0] ?? "";
      const goesOn = claude
        .served()
        .slice(asked)
        .find((served) => served.said.includes(answered));
      expect(goesOn?.said).toContain("Check the header too.");
      // The home named what it did on the timeline, and raised no quiet alert for it.
      expect(home.tasks.timeline(taskId).map((event) => event.text)).toContainEqual(
        expect.stringContaining('answered tasks "ask again" for the crewmate'),
      );
      expect(
        home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
      ).toBe(false);
    } finally {
      lost.mockRestore();
      claude.endClient();
    }
  });

  // The captain's "Ask first, then alert": the alert is held back only when
  // the computer's answer ends the turn here. An answer that it is not
  // working while the home is still behind its events ends nothing yet, so
  // the twenty-minute alert goes as before.
  it("raises the quiet alert at twenty minutes when the computer's answer ends nothing here (INF-2332)", async () => {
    const heldCall = gate();
    const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-answer-ends-nothing";
    claude.answer({ text: "The background check started." });
    const events = gate();
    let holding = false;
    const answer = home.placed.answer.bind(home.placed);
    const held = vi.spyOn(home.placed, "answer").mockImplementation((async (
      device,
      channel,
      request,
    ) => {
      if (holding && channel === "inf:work:events") await events.held;
      return answer(device, channel, request);
    }) as typeof home.placed.answer);
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      claude.answer({
        tool: "note_progress",
        args: { text: "Reading the results." },
        answer: "The check passed.",
      });
      claude.continueTurn();
      await expect
        .poll(() =>
          home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
        )
        .toBe(true);
      // The turn ends there, but its last events have not reached the home.
      holding = true;
      heldCall.open();
      await expect
        .poll(() =>
          new PlacedTasks(at.dataDir)
            .outbox(taskId, 0)
            .some(({ event }) => event.type === "continuation_ended"),
        )
        .toBe(true);
      expect(home.tasks.get(taskId)?.activity).toBe("running");
      const wakes = home.wakes.length;
      const asked = vi.spyOn(home.devices, "ask");
      home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
      await expect
        .poll(() => asked.mock.calls.some(([, channel]) => channel === "inf:session:roster"))
        .toBe(true);
      asked.mockRestore();
      await expect
        .poll(
          () =>
            home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet") &&
            home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
        )
        .toBe(true);
      // Its events arrive, and the turn ends as it really did.
      events.open();
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The check passed.");
      expect(home.tasks.timeline(taskId).map((event) => event.text)).not.toContain(
        UNHEARD_END_NOTE,
      );
    } finally {
      events.open();
      held.mockRestore();
      claude.endClient();
      heldCall.open();
    }
  });

  it("gives a crewmate prepare_change after its computer restarts with that tool available (INF-398, INF-416 L)", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), {
      tools: CREWMATE_TOOLS.filter((tool) => tool.name !== "prepare_change"),
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Started on the footer." }, { text: "The header is next." }]);
    await at.start("t-contract", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-contract")?.activity).toBe("idle");
    const opened = api.requests.at(-1)?.body.tools?.map((tool) => tool.name) ?? [];
    expect(opened).toContain("open_change");
    expect(opened).not.toContain("prepare_change");
    expect(home.placed.takesChangePresentations(at.deviceId)).toBe(true);

    await at.restartComputer({ tools: CREWMATE_TOOLS, protocolVersion: PROTOCOL_VERSION });
    // The old connection can still be in reach when the restart returns.
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-contract");
    expect(home.placed.takesChangePresentations(at.deviceId)).toBe(true);
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-contract", "Fix the header too.");
    await expect.poll(() => home.tasks.get("t-contract")?.outcome).toBe("The header is next.");
    const served = api.requests.at(-1)?.body.tools?.map((tool) => tool.name) ?? [];
    expect(api.requests.length).toBeGreaterThan(requests);
    expect(served).toContain("prepare_change");
    expect(served).toContain("open_change");
    expect(said(api.requests.at(-1))).toContain("Fix the header too.");
  });

  it("fails a turn the computer's restart cut off, and its lane runs the words there again", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-computer");
    await expect.poll(() => api.openRequests()).toBe(1);

    await at.restartComputer();
    const home = at.home();
    // That turn failed here, saying why; its brief waits on the lane for the honest retry.
    await expect.poll(() => home.tasks.get("t-computer")?.activity).toBe("idle");
    // The Firstmate hears it as the honest retry's first failure, in words a person reads.
    expect(home.wakes.map((wake) => wake.facts?.kind)).toContain("outage-failed");
    expect(JSON.stringify(home.wakes)).toContain("Mac mini quit before this turn finished");
    expect(home.inbox.allFor("t-computer")).toHaveLength(1);

    // The lane runs it again there, in the conversation reopened from its record.
    never.open();
    ahead = 10 * 60_000;
    await home.supervisor.sweepInbox(now());
    await expect
      .poll(() => home.tasks.get("t-computer")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Fix the footer.");
  });

  // INF-721 friction 9: the captain asked three times to pause and resume
  // the crew around an update, and two turns still failed; the update now
  // pauses the crew on that computer and carries it on by itself.
  it("pauses a turn running on a computer for its update and carries it on once it is back, with no failed turn (INF-721 friction 9)", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-update");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    const wakes = home.wakes.length;
    const computer = at
      .pairing()
      .list()
      .find((device) => device.id === at.deviceId)?.name;
    expect(computer).toBeDefined();

    // The update pauses its crew first: the turn there stops before it restarts.
    await home.supervisor.pauseForUpdate(at.deviceId);
    await expect.poll(() => home.tasks.get("t-update")?.activity).toBe("idle");
    expect(api.openRequests()).toBe(0);
    await at.restartComputer();
    await at.inReach("t-update");
    // Back and caught up, it waits for the update to be over.
    expect(api.requests.length - requests).toBe(1);
    home.supervisor.resumeAfterUpdate(at.deviceId);

    await expect
      .poll(() => home.tasks.get("t-update")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain(
      renderWake({ facts: { kind: "turn-resumed", stopped: "update", computer } }),
    );
    // No turn failed, and the Firstmate heard only the crewmate's report.
    expect(home.tasks.timeline("t-update").some((event) => event.kind === "failed")).toBe(false);
    expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(home.wakes.slice(wakes).map((wake) => wake.facts?.kind)).not.toEqual(
      expect.arrayContaining(["turn-failed", "outage-failed"]),
    );
    expect(JSON.stringify(home.wakes)).not.toContain("quit before this turn finished");
    expect(home.inbox.allFor("t-update")).toEqual([]);
    never.open();
  });

  // INF-721 friction 9: a computer updated over Remote Login while out of
  // reach of its connection cannot be asked to stop its turn first; the
  // turn the update cut there is a pause too, and its words go again.
  it("reads a turn its computer's update cut out of reach as a pause, and sends its words again once the update is over (INF-721 friction 9)", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-update-away");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    const wakes = home.wakes.length;

    await at.stopComputer();
    await home.supervisor.pauseForUpdate(at.deviceId);
    await at.restartComputer();
    await at.inReach("t-update-away");
    await expect.poll(() => home.tasks.get("t-update-away")?.activity).toBe("idle");
    // Its words wait on the lane for the update to be over.
    expect(home.inbox.allFor("t-update-away").map((row) => row.facts?.kind)).toContain(
      "turn-resumed",
    );
    expect(api.requests.length - requests).toBe(1);
    home.supervisor.resumeAfterUpdate(at.deviceId);

    await expect
      .poll(() => home.tasks.get("t-update-away")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Fix the footer.");
    expect(home.tasks.timeline("t-update-away").some((event) => event.kind === "failed")).toBe(
      false,
    );
    expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(
      home.wakes
        .slice(wakes)
        .some((wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed"),
    ).toBe(false);
    expect(home.inbox.allFor("t-update-away")).toEqual([]);
    never.open();
  });

  // INF-721 friction 9: the turns that failed were Claude clients' own
  // continuations, which a computer's restart cuts with no message to send
  // again; paused for the update, each is carried on once it is back.
  it("pauses a Claude continuation running on a computer for its update and carries it on after, with no failed turn (INF-721 friction 9)", async () => {
    const heldCall = gate();
    const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-continuation-update";
    const computer = at
      .pairing()
      .list()
      .find((device) => device.id === at.deviceId)?.name;
    claude.answer({ text: "The background check started." });
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      const wakes = home.wakes.length;
      claude.answer({ tool: "note_progress", answer: "Not reached while held." });
      claude.continueTurn();
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("running");
      await expect
        .poll(() =>
          home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
        )
        .toBe(true);

      await home.supervisor.pauseForUpdate(at.deviceId);
      await at.restartComputer();
      await at.inReach(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      heldCall.open();
      claude.answer({ text: "Carried on after the update." });
      home.supervisor.resumeAfterUpdate(at.deviceId);

      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Carried on after the update.");
      expect(claude.served().at(-1)?.said).toContain(
        renderWake({ facts: { kind: "turn-resumed", stopped: "update", computer } }),
      );
      expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
      expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
      expect(
        home.wakes
          .slice(wakes)
          .some(
            (wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed",
          ),
      ).toBe(false);
      expect(home.inbox.allFor(taskId)).toEqual([]);
    } finally {
      claude.endClient();
      heldCall.open();
    }
  });

  // INF-1536: INF-1534's Pi crewmate there, whose Gmail read became a
  // background job, was asked when it would look again at "background work
  // in the Claude client".
  describe("words about a Pi crewmate's background job there (INF-1536)", () => {
    /** Its crewmate ends a turn with `sleep 600` running as a job there; the check-back ask it got. */
    async function endTurnWithJob(at: Awaited<ReturnType<typeof world>>, taskId: string) {
      const answered = "I pick up its result when it ends.";
      model([
        {
          tools: [
            {
              name: "bash",
              args: { command: "sleep 600", background: true, description: "Run the long suite" },
            },
          ],
        },
        { text: "The suite runs as a background job; I will pick up its result." },
        { text: answered },
      ]);
      const requests = api.requests.length;
      await at.start(taskId);
      await expect.poll(() => at.home().tasks.get(taskId)?.outcome).toBe(answered);
      // The check-back ask is the newest thing its turn after the job's receipt was told.
      const ask = JSON.stringify(api.requests[requests + 2]?.body.messages?.at(-1) ?? null);
      expect(ask).toContain("Report again with check_back");
      return ask;
    }

    /** The words of a job's command in a steer, as its JSON request carries them. */
    const quoted = (command: string) => JSON.stringify(`: "${command}".`).slice(1, -1);

    it("names the job's command in the check-back ask, the crew line and the job bound's wake", async () => {
      const at = await world(undefined, { jobs: true });
      const ask = await endTurnWithJob(at, "t-job-named");
      const home = at.home();
      expect(ask).toContain(quoted("sleep 600"));
      expect(home.supervisor.crewStatus("t-job-named")[0]?.job).toMatch(/: sleep 600$/);
      // Past the bound, the first mate hears of the same job.
      const wakes = home.wakes.length;
      home.supervisor.reconcileIdle(now() + JOB_BOUND_MS);
      expect(
        home.wakes.slice(wakes).find((wake) => wake.facts?.kind === "job-bound")?.facts,
      ).toMatchObject({ kind: "job-bound", command: "sleep 600" });
    });

    it("names the computer, never the Claude client, when that computer counts its jobs but names none", async () => {
      const at = await world(undefined, { jobs: "counted" });
      const computer = at
        .pairing()
        .list()
        .find((device) => device.id === at.deviceId)?.name;
      expect(computer).toBeDefined();
      const ask = await endTurnWithJob(at, "t-job-counted");
      expect(ask).toContain(quoted(unnamedBackgroundWork(computer)));
      expect(ask).not.toContain(unnamedBackgroundWork());
    });
  });

  // INF-367: a computer's restart reports each background job it cut off
  // once to its task, so an idle crewmate never waits for an exit that
  // cannot arrive.
  it("tells a crewmate waiting on a background job, as its next turn and once, that its computer's restart stopped the job (INF-367)", async () => {
    const at = await world(undefined, { jobs: true });
    const waiting = "The suite runs as a background job; I will pick up its result.";
    const answered = "I pick up its result when it ends.";
    model([
      {
        tools: [
          {
            name: "bash",
            args: { command: "sleep 600", background: true, description: "Run the long suite" },
          },
        ],
      },
      { text: waiting },
      // Its turn ended with the job running: the one check-back ask (INF-1244).
      { text: answered },
      { text: "Running the suite again." },
    ]);
    const requests = api.requests.length;
    await at.start("t-job");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe(answered);
    const job = /background job ([0-9a-f]{8})/.exec(said(api.requests[requests + 1]))?.[1];
    expect(job).toBeDefined();
    expect(said(api.requests[requests + 2])).toContain("Report again with check_back");

    // The computer restarts while the crewmate waits: the job ends with that run.
    await at.restartComputer();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe("Running the suite again.");
    const heard = said(api.requests.at(-1));
    expect(heard).toContain(`background job ${job} did not finish`);
    expect(heard).toContain(JSON.stringify('"sleep 600" was stopped').slice(1, -1));
    expect(api.requests.length - requests).toBe(4);
    // Once: nothing is left there to tell again, and its lane is empty.
    expect(existsSync(join(at.folders("t-job").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-job")).toEqual([]);
    await at.restartComputer();
    await at.inReach("t-job");
    expect(api.requests.length - requests).toBe(4);
  });

  // INF-379: a Claude crewmate's background work runs inside its client,
  // which the computer's restart ends; as for a background job, the next
  // start tells its task once, so the crewmate never waits on work that ended.
  it("tells a Claude crewmate waiting on its background work, as its next turn and once, that its computer's restart stopped it (INF-379)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const waiting = "The suite runs in the background; I will pick up its result.";
    claude.answer({ text: waiting });
    await at.start("t-claude-job");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-claude-job")?.outcome).toBe(waiting);
    // The client lists what it runs in the background, as the real one
    // does, and the home shows the task at work on it.
    claude.listBackgroundTasks([{ id: "bybac1mss", description: "Run the long suite" }]);
    const posture = () => {
      const record = home.tasks.get("t-claude-job");
      if (!record) throw new Error("No task t-claude-job.");
      return home.supervisor.workPosture(record);
    };
    await expect.poll(posture).toEqual({ state: "active", reason: "job" });
    const asked = claude.served().length;

    // The computer restarts while the crewmate waits: the client ends with that run.
    claude.answer({ text: "Running the suite again." });
    await at.restartComputer();
    await expect
      .poll(() => home.tasks.get("t-claude-job")?.outcome)
      .toBe("Running the suite again.");
    expect(claude.served().length - asked).toBe(1);
    const heard = claude.served().at(-1)?.said ?? "";
    expect(heard).toContain(
      '[job] background job bybac1mss did not finish: "Run the long suite" was stopped',
    );
    // Once: nothing is left there to tell again, and its lane is empty.
    expect(existsSync(join(at.folders("t-claude-job").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-claude-job")).toEqual([]);
    await at.restartComputer();
    await at.inReach("t-claude-job");
    expect(claude.served().length - asked).toBe(1);
  });

  // INF-405: the home's quit lets go of each conversation it holds there,
  // and an idle Claude client ends with its background work while that
  // computer runs on; the crewmate is told once, as its next turn, when the
  // home is back.
  it("tells a Claude crewmate once, as its next turn, that its background work there ended when the home's restart let go of its client (INF-405)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const waiting = "The suite runs in the background; I will pick up its result.";
    claude.answer({ text: waiting });
    await at.start("t-claude-let-go");
    const before = at.home();
    await expect.poll(() => before.tasks.get("t-claude-let-go")?.outcome).toBe(waiting);
    claude.listBackgroundTasks([{ id: "bybac1mss", description: "Run the long suite" }]);
    await expect
      .poll(() => {
        const record = before.tasks.get("t-claude-let-go");
        return record && before.supervisor.workPosture(record);
      })
      .toEqual({ state: "active", reason: "job" });
    const asked = claude.served().length;

    // The home restarts while the crewmate waits; that computer runs on.
    claude.answer({ text: "Running the suite again." });
    await at.restartHome();
    const home = at.home();
    await expect
      .poll(() => home.tasks.get("t-claude-let-go")?.outcome)
      .toBe("Running the suite again.");
    expect(claude.served().length - asked).toBe(1);
    expect(claude.served().at(-1)?.said).toContain(
      '[job] background job bybac1mss did not finish: "Run the long suite" was stopped',
    );
    // Once: nothing is left there to tell again, its lane is empty, and
    // another restart of either tells it nothing more.
    expect(existsSync(join(at.folders("t-claude-let-go").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-claude-let-go")).toEqual([]);
    await at.restartHome();
    await at.inReach("t-claude-let-go");
    await at.restartComputer();
    await at.inReach("t-claude-let-go");
    expect(claude.served().length - asked).toBe(1);
  });

  it("tells a Claude crewmate its brief and where its earlier conversation is when that computer's update starts it over, and only once (INF-296)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    claude.answer({ text: "Looking at the footer." });
    await at.start("t-renew");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-renew")?.activity).toBe("idle");
    const earlier = home.tasks.get("t-renew")?.sessionFile ?? "";
    expect(earlier).not.toBe("");
    // INF-1295/F1: identity follows the resume token, not a placed proxy's construction id.
    const initialSessions = home.tasks.sessions("t-renew");
    expect(initialSessions).toMatchObject([
      { conversation: earlier, device_id: at.deviceId, began: "start", current: true },
    ]);
    const briefed = home.tasks
      .timeline("t-renew")
      .filter((event) => event.kind === "briefed")
      .at(-1);
    const brief = briefed ? home.tasks.servedBrief(briefed) : "";
    expect(brief).toContain("Fix the footer.");

    // Its update describes a tool the conversation had in other words, which
    // Claude's client would serve in the old ones: reopened there, it starts over.
    await at.restartComputer({ tools: reworded("report") });
    // The record names the new conversation before any turn of it, and the timeline says why.
    await expect.poll(() => home.tasks.get("t-renew")?.sessionFile).not.toBe(earlier);
    const renewed = home.tasks.get("t-renew")?.sessionFile;
    const renewedSessions = home.tasks.sessions("t-renew");
    expect(renewedSessions).toHaveLength(2);
    expect(renewedSessions).toMatchObject([
      {
        conversation: earlier,
        file: join(at.folders("t-renew").sessions, `${earlier}.jsonl`),
        device_id: at.deviceId,
        began: "start",
        current: false,
      },
      {
        conversation: renewed,
        file: join(at.folders("t-renew").sessions, `${renewed}.jsonl`),
        device_id: at.deviceId,
        began: "renewal",
        current: true,
      },
    ]);
    const renewal = { from: earlier, changed: ["prompt" as const] };
    const moved = () =>
      home.tasks
        .timeline("t-renew")
        .filter((event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal));
    expect(moved()).toHaveLength(1);
    expect(moved()[0]?.data).toMatchObject({ conversation: renewal });

    // Its next prompt says why, its brief, and where the transcript of its
    // earlier conversation is saved on that computer, which holds it there.
    const transcript = join(at.folders("t-renew").sessions, `${earlier}.jsonl`);
    expect(readFileSync(transcript, "utf8")).toContain("Fix the footer.");
    const told = crewmateRestartText({
      restart: renewal,
      taskKey: home.tasks.get("t-renew")?.key ?? "",
      brief,
      earlier: transcript,
    });
    const asked = claude.served().length;
    await home.supervisor.steerCrewmate("t-renew", "Make it blue too.");
    await expect.poll(() => claude.served().length).toBe(asked + 1);
    expect(claude.served().at(-1)?.said).toBe(`${told}\n\nMake it blue too.`);
    await expect.poll(() => home.tasks.get("t-renew")?.activity).toBe("idle");

    const completedSessions = home.tasks.sessions("t-renew");
    // The serving model becomes known on its first completed turn, before the home restarts.
    expect(completedSessions[1]?.provider).toBe(CLAUDE_PROVIDER_ID);
    // A home restart while that computer still holds it: the same conversation, said nothing again.
    await at.restartHome();
    const after = at.home();
    await after.supervisor.steerCrewmate("t-renew", "And the header.");
    await expect.poll(() => claude.served().length).toBe(asked + 2);
    const since = claude.served().at(-1)?.said ?? "";
    expect(since).toContain("And the header.");
    // What it was told stands once, in the conversation it goes on with.
    expect(since.split(told)).toHaveLength(2);
    expect(after.tasks.get("t-renew")?.sessionFile).toBe(renewed);
    const restartedSessions = after.tasks.sessions("t-renew");
    expect(restartedSessions).toHaveLength(2);
    expect(restartedSessions.filter((session) => session.current)).toHaveLength(1);
    expect(restartedSessions.map(({ last_at: _last, ...row }) => row)).toEqual(
      completedSessions.map(({ last_at: _last, ...row }) => row),
    );
    console.info(
      "INF-1295 remote Claude association lifecycle",
      JSON.stringify({ initialSessions, renewedSessions, completedSessions, restartedSessions }),
    );
    expect(
      after.tasks
        .timeline("t-renew")
        .filter((event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal)),
    ).toHaveLength(1);
  });

  // INF-284: after its update moves Firstmate 3000's folder into
  // Infinitary's, a conversation held there must go on in the new folder,
  // never in the older one the move keeps as its recovery copy.
  // Protocol 9 requires the home and work computer to update together.
  it("goes on from the migrated record after both computers update (INF-416 L)", async () => {
    const at = await world(undefined, { inOlderFolder: true });
    model([
      { text: "Started on the footer." },
      {
        tools: [{ name: "report", args: { text: "The header is fixed too.", summary: "Fixed." } }],
      },
      { text: "Reported." },
      {
        tools: [{ name: "report", args: { text: "The footer still holds.", summary: "Held." } }],
      },
      { text: "Reported." },
    ]);
    await at.start("t-moved");
    await expect.poll(() => at.home().tasks.get("t-moved")?.activity).toBe("idle");
    const older = at.folders("t-moved");
    const before = at.home().tasks.get("t-moved")?.sessionFile ?? "";
    expect(before.startsWith(`${older.sessions}/`)).toBe(true);
    const kept = readFileSync(before, "utf8");
    const initialSessions = at.home().tasks.sessions("t-moved");
    expect(initialSessions).toHaveLength(1);

    await at.stopComputer();
    await at.restartHome(() => at.moveComputer());
    await at.inReach("t-moved");
    const requests = api.requests.length;
    await at.home().supervisor.steerCrewmate("t-moved", "Fix the header too.");
    await expect
      .poll(() => at.home().tasks.get("t-moved")?.outcome)
      .toBe("The header is fixed too.");

    // It resumed from its record's copy in the new folder and wrote this turn there.
    const moved = at.folders("t-moved");
    const file = join(moved.sessions, relative(older.sessions, before));
    const now = readFileSync(file, "utf8");
    expect(now.startsWith(kept)).toBe(true);
    expect(now).toContain("Fix the header too.");
    // The older folder's record is as the move left it.
    expect(readFileSync(before, "utf8")).toBe(kept);
    // The task's record names the file there now, and this Mac's copy has the turn.
    await expect.poll(() => at.home().tasks.get("t-moved")?.sessionFile).toBe(file);
    const copy = join(
      crewmateSessionsDir(at.home().paths, "t-moved"),
      relative(moved.sessions, file),
    );
    await expect.poll(() => readFileSync(copy, "utf8")).toBe(readFileSync(file, "utf8"));
    // It was told its folders in the new folder, none in the older one.
    const system = JSON.stringify(api.requests[requests]?.body.system);
    expect(system).toContain(moved.evidence);
    expect(system).toContain(moved.cardBodies);
    expect(system).toContain(moved.temp);
    expect(system).not.toContain(`${join(older.root, "..", "..", "..")}/`);
    expect(said(api.requests[requests])).not.toContain("Your working copy was");

    // That computer restarts again: its conversation opens there with the
    // same paths mapped, and its crewmate is not told a second time.
    await at.restartComputer();
    await at.inReach("t-moved");
    await at.home().supervisor.steerCrewmate("t-moved", "Check the footer again.");
    await expect
      .poll(() => at.home().tasks.get("t-moved")?.outcome)
      .toBe("The footer still holds.");
    const asked = ["Fix the footer.", "Fix the header too.", "Check the footer again."];
    for (const text of asked) {
      expect(said(api.requests.at(-1))).toContain(text);
      expect(readFileSync(file, "utf8")).toContain(text);
    }
    expect(readFileSync(before, "utf8")).toBe(kept);
    const restartedSessions = at.home().tasks.sessions("t-moved");
    expect(restartedSessions).toHaveLength(1);
    expect(restartedSessions[0]).toMatchObject({
      conversation: initialSessions[0]?.conversation,
      file,
      device_id: at.deviceId,
      began: "start",
      current: true,
    });
    console.info(
      "INF-1295 remote Pi association continuity",
      JSON.stringify({ initialSessions, restartedSessions }),
    );
  });

  // INF-378's two divergent-record cases now belong to pi/placedMigration.test.ts.

  it("closes the conversation there when its record closes, now or once the computer is back", async () => {
    const at = await world();
    model([{ text: "Done here." }, { text: "Done there." }]);
    await at.start("t-close-now");
    await at.start("t-close-later");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-close-later")?.activity).toBe("idle");
    const roster = async () =>
      (await home.devices.ask(at.deviceId, "inf:session:roster", [])) as {
        tasks: { task: string; closed: boolean }[];
      };

    await home.supervisor.interruptCrewmate("t-close-now", "cancel");
    await expect
      .poll(async () => (await roster()).tasks.find((task) => task.task === "t-close-now")?.closed)
      .toBe(true);

    await home.drop();
    await home.supervisor.interruptCrewmate("t-close-later", "cancel");
    await home.listen();
    await expect
      .poll(
        async () => (await roster()).tasks.find((task) => task.task === "t-close-later")?.closed,
      )
      .toBe(true);
  });

  it("keeps a card's demo recording once its last piece arrives, and never a piece past its end", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-demo",
      title: "Shows a demo",
      status: "running",
      deviceId: at.deviceId,
    });
    const id = `t-demo-${"e".repeat(32)}`;
    const recording = Buffer.from(Array.from({ length: 10 }, (_, at) => at));
    const kept = join(crewmateCardPicturesDir(home.paths, "t-demo"), `${id}.mp4`);
    const piece = (callId: string, offset: number, bytes: Buffer, size = recording.length) =>
      home.placed.answer(at.deviceId, "inf:work:media", {
        task: "t-demo",
        callId,
        id,
        extension: "mp4",
        offset,
        size,
        data: bytes.toString("base64"),
      });
    await piece("call-1", 0, recording.subarray(0, 6));
    // Part of it is no recording a card may name yet.
    expect(existsSync(kept)).toBe(false);
    await piece("call-2", 6, recording.subarray(6));
    expect(readFileSync(kept)).toEqual(recording);
    await expect(piece("call-3", 8, recording.subarray(0, 4))).rejects.toThrow(
      /past the recording's end/,
    );
    // Another task's recording is not this task's to keep.
    await expect(
      home.placed.answer(at.deviceId, "inf:work:media", {
        task: "t-demo",
        callId: "call-4",
        id: `t-other-${"e".repeat(32)}`,
        extension: "mp4",
        offset: 0,
        size: 1,
        data: "AA==",
      }),
    ).rejects.toThrow(/not this task's/);
  });

  it("keeps a project font a card's preview names where this Mac's frames load it, and only this task's", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-font",
      title: "Shows a preview",
      status: "running",
      deviceId: at.deviceId,
    });
    const id = `t-font-${"a".repeat(32)}`;
    const font = projectFontBytes();
    await home.placed.answer(at.deviceId, "inf:work:typeface", {
      task: "t-font",
      callId: "call-1",
      id,
      extension: "woff2",
      data: font.toString("base64"),
    });
    const kept = join(crewmateCardPicturesDir(home.paths, "t-font"), `${id}.woff2`);
    expect(readFileSync(kept)).toEqual(font);
    // A copy damaged in place is replaced whole when the same font arrives again.
    writeFileSync(kept, Buffer.alloc(font.length));
    await home.placed.answer(at.deviceId, "inf:work:typeface", {
      task: "t-font",
      callId: "call-1b",
      id,
      extension: "woff2",
      data: font.toString("base64"),
    });
    expect(readFileSync(kept)).toEqual(font);
    await expect(
      home.placed.answer(at.deviceId, "inf:work:typeface", {
        task: "t-font",
        callId: "call-2",
        id: `t-other-${"a".repeat(32)}`,
        extension: "woff2",
        data: font.toString("base64"),
      }),
    ).rejects.toThrow(/not this task's/);
  });

  it("carries measured remote lines into the offered completion card (INF-1235)", async () => {
    // Captain chose “Fix remote-task line counts”: real git and the paired connection,
    // ending at the host-authored completion strip, with no provider sign-in or network git.
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { rigor: "quick", delivery: "direct-pr" });
    model([{ text: "Ready for the footer." }]);
    await at.start("t-lines", "Describe the website footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-lines")?.activity).toBe("idle");
    const dir = at.folders("t-lines").work;
    writeFileSync(join(dir, "README.md"), "# website\nA footer for the website.\n");
    const first = await commit(dir, "fix: describe the footer");
    const reading = await home.placed.revision(at.deviceId, "t-lines", first);
    expect(reading).toMatchObject({
      headSha: first,
      changeLines: { base: project.main, added: 1, deleted: 0 },
    });
    seedDelivery(home.tasks, "t-lines", { headSha: first, ci: "green", ciAt: Date.now() });
    await home.placed.answer(at.deviceId, "inf:work:card", {
      task: "t-lines",
      callId: "line-card",
      card: {
        id: "done",
        title: "The website footer is ready",
        body: "<h2>Why</h2><p>Describe the website footer.</p><h2>What changed</h2><p>I described the footer.</p><h2>Before</h2><p>The description named only the website.</p><h2>After</h2><p>The description includes the footer.</p>",
        requiredActions: [],
        actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
      },
    });
    await expect
      .poll(() => home.cards().find((card) => card.taskId === "t-lines")?.body)
      .toContain("+1 added · −0 deleted");
    expect(home.tasks.get("t-lines")?.delivery?.changeLines).toMatchObject({
      head: first,
      base: project.main,
      added: 1,
      deleted: 0,
    });
    console.info("Remote revision response:", JSON.stringify(reading));
    console.info(
      "Persisted completion measurement:",
      JSON.stringify(home.tasks.get("t-lines")?.delivery?.changeLines),
    );
    console.info("Completion strip:", home.cards().find((card) => card.taskId === "t-lines")?.body);
  });

  it("refuses what a computer asks about a task this Mac does not run there", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, { id: "t-here", title: "Runs here", status: "running" });
    seedTask(home.tasks, {
      id: "t-elsewhere",
      title: "Runs on another computer",
      status: "running",
      deviceId: "another-mac",
    });
    for (const task of ["t-here", "t-elsewhere", "t-missing"])
      await expect(
        home.placed.answer(at.deviceId, "inf:work:report", {
          task,
          callId: "call-1",
          text: "Not yours.",
        }),
      ).rejects.toThrow(NO_PLACED_TASK);
  });

  it("prepares a story on the home after transferring the work computer's inspected pictures, without showing a card or uploading (INF-92)", async () => {
    const project = await gitProject();
    const upload = vi.fn(async () => {
      throw new Error("Preparation uploads nothing");
    });
    const destination = async () => ({
      host: "github.com",
      projectId: 1,
      fullName: "octo/website",
      visibility: "private" as const,
    });
    const at = await world(() =>
      Object.assign(project.forge(Buffer.alloc(0)), {
        kind: "github" as const,
        host: "github.com",
        storyDestination: destination,
        changeFor: async () => null,
        attachments: { destination, upload },
      }),
    );
    const home = at.home();
    expect(
      home.placed.takesChangePresentations(at.deviceId),
      JSON.stringify(home.devices.version(at.deviceId)),
    ).toBe(true);
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Ready to prepare." }]);
    await at.start("t-story", "Prepare the inspected change story.", repo.id);
    await expect.poll(() => home.tasks.get("t-story")?.activity).toBe("idle");
    const source = readFileSync("release-notes/pictures/action-reply-line-dark.webp");
    const evidence = at.folders("t-story").evidence;
    mkdirSync(evidence, { recursive: true });
    const picture = join(evidence, "reply.webp");
    writeFileSync(picture, source);
    const risk = Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: `The ${dimension} assessment for this fixture.` },
      ]),
    ) as RiskDeclaration;
    model([
      {
        tools: [
          {
            name: "prepare_change",
            args: {
              story: {
                title: "fix: show the selected evidence",
                publishable: true,
                base: project.main,
                head: project.main,
                why: ["The pull request and card should show the same evidence."],
                whatChanged: ["The task retains the selected picture."],
                before: ["The description had text alone."],
                after: ["The description has a picture."],
                views: [
                  {
                    id: "reply",
                    kind: "new",
                    caption: "The reply",
                    before: [],
                    after: [
                      {
                        path: picture,
                        alt: "The task reply in the dark appearance",
                        inspected: true,
                        captureHead: project.main,
                      },
                    ],
                  },
                ],
                checked: [{ check: "Selected picture", result: "The retained image is readable." }],
                verification: ["Opened the selected picture."],
                risk,
                requiredActions: [],
                unfinished: [],
              },
            },
          },
        ],
      },
      { text: "The story is prepared." },
    ]);
    await home.supervisor.steerCrewmate("t-story", "Prepare the selected story now.");
    await expect.poll(() => home.tasks.get("t-story")?.outcome).toBe("The story is prepared.");
    expect(
      home.tasks.changePresentation("t-story")?.revisions.length,
      said(api.requests.at(-1)),
    ).toBe(1);
    const story = home.tasks.changePresentation("t-story")?.revisions[0];
    const asset = story?.assets[0];
    if (!asset) throw new Error("No retained picture reached home");
    expect(readFileSync(join(crewmateCardPicturesDir(home.paths, "t-story"), asset.file))).toEqual(
      source,
    );
    expect(story?.head).toBe(project.main);
    expect(story?.version).toBe(2);
    expect(story?.checked).toHaveLength(1);
    // INF-169 F13: only the home retains prepared copies after transfer.
    expect(readdirSync(at.folders("t-story").cards)).toEqual([]);
    expect(readFileSync(picture)).toEqual(source);
    expect(home.tasks.changePresentation("t-story")?.receipts[0]?.state).toBe("prepared");
    expect(upload).not.toHaveBeenCalled();
    expect(home.cards()).toEqual([]);
  });

  it("works in a working copy cloned there, opens its change from here once its branch is home, and takes its kept work home before that computer deletes the copy", async () => {
    const project = await gitProject();
    // Files copied byte for byte from a real phone-logs artifact.
    const artifact = readFileSync("tests/fixtures/forge/phone-logs-sample.zip");
    const at = await world(() => project.forge(artifact));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Started on the footer." }]);
    const requests = api.requests.length;
    await at.start("t-copy", "Make the footer blue.", repo.id);

    // The computer cloned the project and made the task's working copy there.
    const work = at.folders("t-copy").work;
    await expect.poll(() => home.tasks.get("t-copy")?.activity).toBe("idle");
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(project.main);
    expect(await git(work, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-t-copy");
    expect(home.tasks.get("t-copy")).toMatchObject({
      branch: "fm/task-t-copy",
      worktreeDir: "",
      workspaceState: "present",
    });
    expect(feed(home)).toContain("Mac mini cloned home.");
    expect(home.tasks.timeline("t-copy").map((event) => event.text)).toContain(
      "a new working copy was made on Mac mini, starting from the latest origin/main",
    );
    // Its first turn ran there, in that working copy.
    expect(JSON.stringify(api.requests[requests]?.body.system)).toContain(work);

    // The crewmate's work there: one commit, and an edit not yet committed.
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    writeFileSync(join(work, "notes.txt"), "still thinking\n");
    // INF-1965 adds the saved-story prerequisite without changing who sends the branch up.
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story: footerStory(project.main, tip) } }] },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", presentation: 1 } }] },
      {
        tools: [
          { name: "download_artifact", args: { runId: 41, artifactId: 9 } },
          // INF-1932: only the files it needs, saved beside the whole archive.
          { name: "download_artifact", args: { runId: 41, artifactId: 9, files: ["ipad/rest/"] } },
        ],
      },
      { text: "Opened, and read the artifact." },
    ];
    model(publication);
    const opening = api.requests.length;
    await home.supervisor.steerCrewmate("t-copy", "Open the change.");
    await expect.poll(() => api.requests.length - opening).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-copy")?.activity).toBe("idle");

    // open_change ran here: the branch came home over the connection, and
    // this Mac sent it up to where the project lives.
    expect(await git(project.home, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(said(api.requests.at(-2))).toContain("Opened the pushed branch fm/task-t-copy");
    expect(home.tasks.changePresentation("t-copy")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
    // download_artifact downloaded here and wrote the file there, never here.
    const written = join(work, ".infinitary-artifacts", "run-41", "artifact-9.zip");
    expect(readFileSync(written).equals(artifact)).toBe(true);
    expect(said(api.requests.at(-1))).toContain(
      createHash("sha256").update(artifact).digest("hex"),
    );
    // The selection too: downloaded in parts here, written there beside it.
    const selected = readdirSync(join(work, ".infinitary-artifacts", "run-41")).find((name) =>
      /^artifact-9-[0-9a-f]{12}\.zip$/.test(name),
    );
    const part = readFileSync(join(work, ".infinitary-artifacts", "run-41", selected ?? "none"));
    expect(selected).toBe(
      `artifact-9-${createHash("sha256").update(part).digest("hex").slice(0, 12)}.zip`,
    );
    expect(part.length).toBeLessThan(artifact.length);
    expect(part.includes("ipad/rest/1-plutil.log")).toBe(true);
    expect(part.includes("12-xcrun.log")).toBe(false);
    expect(said(api.requests.at(-1))).toContain(`.infinitary-artifacts/run-41/${selected}`);
    expect(existsSync(join(project.home, ".infinitary-artifacts"))).toBe(false);

    // The task closes: its work is kept there, comes home, and only then is
    // the working copy deleted there.
    await home.supervisor.interruptCrewmate("t-copy", "cancel");
    await expect.poll(() => home.tasks.get("t-copy")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-copy")]);
    expect(await git(project.home, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(await git(project.home, ["branch", "--list", "fm/task-t-copy"])).toBe("");
    expect(home.tasks.timeline("t-copy").at(-1)?.text).toBe(
      "working copy on Mac mini removed - its 1 commit not in yet and uncommitted edits saved here first",
    );
  });

  // Review INF-2546 R2, under the captain's "Fix it in this change" for
  // delivering an independent story from a computer that runs work: a
  // crewmate there that checks out another branch prepares that branch's
  // story and opens it from here, as one on this Mac does. The branch comes
  // home to the task's own ref for it, so this Mac's branch of the same name
  // never moves, and the task's own story stays empty.
  it("prepares and opens the story of another branch the crewmate checked out there, bringing that branch home to the task's own ref for it", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.from("")));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    // This Mac's own branch of that name, at main, which nothing here may move.
    await git(project.home, ["branch", "reading-fix", project.main]);
    model([{ text: "Started on the reading fix." }]);
    await at.start("t-other", "Deliver the reading fix on its own branch.", repo.id);
    const work = at.folders("t-other").work;
    await expect.poll(() => home.tasks.get("t-other")?.activity).toBe("idle");
    // The crewmate checks out another branch there and commits the fix on it.
    await git(work, ["checkout", "--quiet", "-b", "reading-fix"]);
    writeFileSync(join(work, "reading.txt"), "on time\n");
    const tip = await commit(work, "fix: read the meter on time");
    const story = { ...footerStory(project.main, tip), title: "fix: read the meter on time" };
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story } }] },
      {
        tools: [
          {
            name: "open_change",
            args: { title: "fix: read the meter on time", branch: "reading-fix", presentation: 1 },
          },
        ],
      },
      { text: "Opened the reading fix with its own story." },
    ];
    model(publication);
    const opening = api.requests.length;
    await home.supervisor.steerCrewmate("t-other", "Open the reading fix.");
    await expect.poll(() => api.requests.length - opening).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-other")?.activity).toBe("idle");

    // The story is that branch's, at the commit checked out there.
    expect(said(api.requests.at(-2))).toContain("Prepared presentation 1 for");
    expect(home.tasks.changePresentation("t-other", "reading-fix")?.revisions[0]?.head).toBe(tip);
    expect(
      home.tasks.changePresentation("t-other", home.tasks.get("t-other")?.branch),
    ).toBeUndefined();
    // open_change ran here from the task's own ref for the branch, and sent it up.
    expect(said(api.requests.at(-1))).toContain("for reading-fix");
    expect(await git(project.home, ["rev-parse", checkedOutRefFor("t-other")])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/reading-fix"])).toBe(tip);
    expect(await git(project.home, ["rev-parse", "refs/heads/reading-fix"])).toBe(project.main);
    expect(home.tasks.changePresentation("t-other", "reading-fix")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
  });

  // INF-1713, and review INF-1772 R11: a move's copies are retired through
  // the real working copies on both sides, a computer the task ran on takes
  // it again, and what the copy it left asks after is refused here.
  it("moves a started task home and there again with its work, removing each copy it left, and refuses what a copy it left asks after", async () => {
    const project = await gitProject();
    // The computer is signed in to the account that serves the task's model, so it can take it back.
    const at = await world(() => project.forge(Buffer.from("")), {
      runsHere: true,
      signedInTo: [computerAccount("acct_placed_there", PROVIDER)],
      served: [{ accountId: "acct_placed_there", models: [{ provider: PROVIDER, id: MODEL }] }],
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-move", "Make the footer blue.", repo.id);
    const there = at.folders("t-move").work;
    await expect.poll(() => home.tasks.get("t-move")?.activity).toBe("idle");
    writeFileSync(join(there, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(there, "feat: a blue footer");
    writeFileSync(join(there, "notes.txt"), "still thinking\n");
    const settled = async () => {
      await expect
        .poll(() => home.tasks.get("t-move")?.shape?.computer_move, { timeout: 15_000 })
        .toBeUndefined();
    };

    // Home: the work arrives in a working copy here, and the copy there goes.
    expect(
      await home.supervisor.requestComputerMove("t-move", RUNS_ON_THIS_MAC, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    const here = home.tasks.get("t-move")?.worktreeDir ?? "";
    expect(home.tasks.get("t-move")?.deviceId ?? null).toBeNull();
    expect(await git(here, ["rev-parse", "HEAD"])).toBe(tip);
    expect(readFileSync(join(here, "notes.txt"), "utf8")).toBe("still thinking\n");
    await expect.poll(() => existsSync(there)).toBe(false);
    expect(at.holds().workingCopies).not.toContain("t-move");
    // The conversation it left there is closed: what it asks after is not this Mac's to answer.
    await expect(
      home.placed.answer(at.deviceId, "inf:work:report", {
        task: "t-move",
        callId: "call-stale",
        text: "Done there.",
      }),
    ).rejects.toThrow(NO_PLACED_TASK);

    // There again: the computer it ran on takes it, from a bundle, since the
    // project's origin is a folder of this Mac; the copy here goes.
    writeFileSync(join(here, "notes.txt"), "thought it through\n");
    expect(
      await home.supervisor.requestComputerMove("t-move", at.deviceId, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    expect(home.tasks.get("t-move")?.deviceId).toBe(at.deviceId);
    const again = at.folders("t-move").work;
    expect(await git(again, ["rev-parse", "HEAD"])).toBe(tip);
    expect(readFileSync(join(again, "notes.txt"), "utf8")).toBe("thought it through\n");
    // Review INF-1772 round 2 R12: it never clones this Mac's folder there.
    expect(listed(join(at.dataDir, "repos"))).toContain(`local-${repo.id}`);
    await expect.poll(() => existsSync(here)).toBe(false);

    // Home once more: the copy there, in a repository that began empty, goes too.
    expect(
      await home.supervisor.requestComputerMove("t-move", RUNS_ON_THIS_MAC, "captain"),
    ).toMatchObject({ ok: true });
    await settled();
    expect(home.tasks.get("t-move")?.deviceId ?? null).toBeNull();
    const last = home.tasks.get("t-move")?.worktreeDir ?? "";
    expect(readFileSync(join(last, "notes.txt"), "utf8")).toBe("thought it through\n");
    await expect.poll(() => existsSync(again)).toBe(false);
    expect(at.holds().workingCopies).not.toContain("t-move");
    expect(home.tasks.timeline("t-move").at(-1)?.text).toBe(
      "the working copy it left on Mac mini was removed",
    );
  });

  it("INF-203 F1: the real home accepts a clean placed run and effect request, but refuses dirty placed work", async () => {
    const project = await gitProject();
    const at = await world((repo) => project.forge(Buffer.alloc(0), repo?.path));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr", rigor: "reviewed" });
    model([{ text: "The clean checkout will be validated." }]);
    await at.start(
      "t-validation",
      "Check this placed checkout's committed version and clean status.",
      repo.id,
    );
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    expect(home.tasks.get("t-validation")?.worktreeDir).toBe("");
    const work = at.folders("t-validation").work;
    const head = await git(work, ["rev-parse", "HEAD"]);
    const scenario = {
      id: "checkout",
      source: "Check the placed checkout's version and clean status.",
      importance: "required",
      action: "Read HEAD and git status on the work computer.",
      expected: "One committed version with no edits.",
      adverse: "Uncommitted work must be refused.",
      environment: "Disposable paired helper",
      signal: "Git's actual readings.",
      boundary:
        "The actual placed working copy and home report path, not a physical second computer.",
    };
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "Recorded the checkout scenario.",
              validation: {
                kind: "plan",
                previousRevision: 0,
                reason: scenario.source,
                scenarios: [scenario],
              },
            },
          },
        ],
      },
      { text: "The checkout scenario is recorded." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Record the scenario before reading its result.",
    );
    await expect
      .poll(() => home.tasks.get("t-validation")?.delivery?.liveValidation?.scenarioRevision)
      .toBe(1);
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    const observed = JSON.stringify({
      head: await git(work, ["rev-parse", "HEAD"]),
      status: await git(work, ["status", "--porcelain"]),
    });
    const file = join(at.folders("t-validation").evidence, "checkout.json");
    mkdirSync(at.folders("t-validation").evidence, { recursive: true });
    writeFileSync(file, observed);
    const run = {
      kind: "run",
      id: "checkout-clean",
      head,
      scenarioRevision: 1,
      completion: "complete",
      verdict: "go",
      reason: "The actual placed checkout was clean at this committed version.",
      observations: [
        {
          scenario: "checkout",
          result: "pass",
          live: true,
          actual: observed,
          evidence: ["checkout"],
          standIns: [],
          unproven: [],
          attempted: [],
        },
      ],
      evidence: [
        {
          id: "checkout",
          path: file,
          description: "HEAD and git status from the actual placed working copy.",
        },
      ],
    };
    const effect = {
      kind: "request",
      request: {
        kind: "effect",
        id: "clean-reproduction",
        head,
        scenario: "checkout",
        action: "Publish the exact pre-change reproduction.",
        destination: "Disposable fixture",
        audience: "Fixture collaborators",
        visibility: "others",
        persistent: true,
        purpose: "Reproduce the clean-checkout condition",
        lastingEffects: "A retained fixture record",
        cleanup: "Delete the fixture afterward",
        access: "Disposable fixture only",
        preChange: true,
        prerequisitePublication: false,
      },
    };
    model([
      {
        tools: [
          { name: "report", args: { text: "The placed checkout was exercised.", validation: run } },
        ],
      },
      {
        tools: [
          {
            name: "report",
            args: { text: "The pre-change reproduction needs an answer.", validation: effect },
          },
        ],
      },
      { text: "The home has the proof and unanswered request." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Record the observed run and request, not approval.",
    );
    await expect
      .poll(() => home.tasks.get("t-validation")?.delivery?.liveValidation?.permissions[0]?.state)
      .toBe("requested");
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    const kept = home.tasks.get("t-validation")?.delivery?.liveValidation?.runs[0];
    expect(kept).toMatchObject({ head, deviceId: at.deviceId, verdict: "go" });
    expect(
      readFileSync(
        join(crewmateCardPicturesDir(home.paths, "t-validation"), kept!.evidence[0]!.file),
        "utf8",
      ),
    ).toBe(observed);
    expect(kept!.evidence[0]!.text).toBeUndefined();
    writeFileSync(join(work, "uncommitted.txt"), "Not the approved version.");
    model([
      {
        tools: [
          {
            name: "report",
            args: {
              text: "Attempt the dirty checkout report.",
              validation: { ...run, id: "dirty" },
            },
          },
        ],
      },
      { text: "The dirty report was refused." },
    ]);
    await home.supervisor.steerCrewmate(
      "t-validation",
      "Check whether a dirty checkout can record the same proof.",
    );
    await expect.poll(() => home.tasks.get("t-validation")?.activity).toBe("idle");
    expect(said(api.requests.at(-1))).toContain("Commit the current work before validation");
    expect(home.tasks.get("t-validation")?.delivery?.liveValidation?.runs).toHaveLength(1);
    console.log(
      "INF-203 placed home proof",
      JSON.stringify({ head, kept: kept!.evidence, observed, dirtyRefused: true }),
    );
  });

  // INF-97: INF-40 started on the Mac mini before its home moved Firstmate
  // 3000's folder into Infinitary's. A reviewed open_change read the branch
  // in the older folder's copy of the project, which never received it:
  // "git -C .../firstmate-3000/fleet/infinitary rev-parse fm/task-68b12f57
  // ... unknown revision". The move now rewrites the task's record of this
  // Mac's project folder, and the open still reads the project's folder now.
  it("opens a reviewed change from the project's folder once the home's folder has moved, never from the older copy (INF-97)", async () => {
    const project = await gitProject();
    const at = await world((repo) => project.forge(Buffer.alloc(0), repo?.path));
    const { repo } = await adoptHere(at.home().repos, project.home);
    at.home().repos.configure(repo.id, { delivery: "direct-pr", rigor: "reviewed" });
    model([{ text: "Started on the footer." }]);
    await at.start("t-moved", "Make the footer blue.", repo.id);
    await expect.poll(() => at.home().tasks.get("t-moved")?.activity).toBe("idle");
    const work = at.folders("t-moved").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    // INF-125 adds an explicit proof prerequisite; INF-97 still owns the real moved-folder/git boundary below.
    seedDelivery(at.home().tasks, "t-moved", {
      reviewVerdict: "pass",
      reviewSha: tip,
      validationHead: tip,
      liveValidation: noSurfaceProof(
        tip,
        "fixture-reviewer",
        "INF-97 is a git-publication fixture with no running application; footer.html is unserved branch content, not a claimed UI result.",
      ),
    });

    const moved = await moveProjectFolder(at, repo.path);
    const home = at.home();
    // The project and the task's record of it both name the new folder.
    expect(home.repos.get(repo.id)?.path).toBe(moved);
    expect(home.tasks.get("t-moved")?.repoDir).toBe(moved);
    // INF-1965: the moved project keeps the same saved-story prerequisite as any plain branch.
    const publication: Step[] = [
      { tools: [{ name: "prepare_change", args: { story: footerStory(project.main, tip) } }] },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", presentation: 1 } }] },
      { text: "Opened." },
    ];
    model(publication);
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-moved", "Open the change.");
    await expect.poll(() => api.requests.length - requests).toBe(publication.length);
    await expect.poll(() => home.tasks.get("t-moved")?.activity).toBe("idle");

    expect(said(api.requests.at(-1))).toContain("Opened the pushed branch fm/task-t-moved");
    expect(home.tasks.changePresentation("t-moved")?.completion).toMatchObject({
      revision: 1,
      head: tip,
    });
    // The branch came home into the project's folder and went up from there.
    expect(await git(moved, ["rev-parse", "refs/heads/fm/task-t-moved"])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/fm/task-t-moved"])).toBe(tip);
    // The older copy stays as the move left it.
    expect(await git(repo.path, ["branch", "--list", "fm/task-t-moved"])).toBe("");
  });

  it("merges a task's branch from that computer into the project's folder once the home's folder has moved (INF-97)", async () => {
    const project = await gitProject();
    const at = await world();
    const { repo } = await adoptHere(at.home().repos, project.home);
    at.home().repos.configure(repo.id, { delivery: "local-only" });
    model([{ text: "Started on the footer." }]);
    await at.start("t-land", "Make the footer blue.", repo.id);
    await expect.poll(() => at.home().tasks.get("t-land")?.activity).toBe("idle");
    const work = at.folders("t-land").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");

    const moved = await moveProjectFolder(at, repo.path);
    const home = at.home();
    expect(home.tasks.get("t-land")?.repoDir).toBe(moved);
    await at.inReach("t-land");
    const landed = await home.supervisor.settleTaskDetailed(
      "t-land",
      "land",
      undefined,
      undefined,
      "captain",
    );

    expect(landed.text).toBe('Merged "website" into main.');
    expect(await git(moved, ["rev-parse", "main"])).toBe(tip);
    expect(await git(repo.path, ["rev-parse", "main"])).toBe(project.main);
  });

  // INF-572, the captain's approved plan: a project's folder deleted on this
  // Mac does not stop a task bound for the computer that runs work, which
  // clones its own; its branch cannot come home into the missing folder, so
  // its merge is refused naming the folder, and the folder's repair is filed.
  it("starts a task there while this Mac's folder is missing, and refuses its branch coming home into it (INF-572)", async () => {
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "local-only" });
    // Every start reads the folder's address first, as the app wires it.
    const changes = new ProjectChanges({
      repos: home.repos,
      devices: () => [],
      raiseCard: () => {},
      tell: () => {},
    });
    home.supervisor.setProjectChange({
      apply: () => {},
      decline: () => {},
      inspect: (repoId) => changes.inspect(repoId),
    });
    rmSync(project.home, { recursive: true, force: true });

    model([{ text: "Started on the footer." }]);
    await at.start("t-gone", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(project.main);
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    await commit(work, "feat: a blue footer");

    const landed = await home.supervisor.settleTaskDetailed(
      "t-gone",
      "land",
      undefined,
      undefined,
      "captain",
    );
    const repair = home.tasks
      .list()
      .find((row) => row.repoId === repo.id && row.shape?.in_place !== undefined);
    if (!repair) throw new Error("no repair task was filed");
    expect(repair.shape?.in_place).toMatchObject({ cause: "missing", noticed: "branch-home" });
    expect(landed.text).toContain(
      `Your project's folder ${project.home} is missing, so nothing can be merged into it.`,
    );
    expect(home.tasks.get("t-gone")?.status).toBe("active");
    expect(existsSync(project.home)).toBe(false);
  });

  // INF-45: read_workflow's description promises a short read and a run
  // watch for runId alone, and the release crewmate on the Mac mini was
  // refused it ("Rejected inf:work:read-workflow: malformed request").
  it("reads a run there by its number alone, watches it here, and wakes the crewmate there when it ends (INF-45)", async () => {
    const project = await gitProject();
    // Infinitary's first alpha release run and two of its jobs, as GitHub
    // listed them while its checks still ran and once it passed.
    const runId = 38849548350;
    let finished = false;
    const release = {
      run: async (id: number) => ({
        id,
        name: "release",
        headSha: project.main,
        branch: "main",
        attempt: 1,
        status: finished ? "completed" : "in_progress",
        conclusion: finished ? "success" : null,
        url: `https://github.com/infinitary-labs/infinitary/actions/runs/${id}`,
      }),
      jobs: async () => ({
        jobs: [
          {
            id: 116807503003,
            name: "Resolve the source commit and version",
            status: "completed",
            conclusion: "success",
            failedAt: null,
          },
          {
            id: 116807634269,
            name: "verify / linux-checks",
            status: finished ? "completed" : "in_progress",
            conclusion: finished ? "success" : null,
            failedAt: null,
          },
        ],
        total: 2,
        complete: true,
      }),
      jobLog: async () => {
        throw new Error("No job log was asked for.");
      },
      download: async () => {
        throw new Error("No artifact was asked for.");
      },
    };
    const at = await world(() =>
      Object.assign(project.forge(Buffer.alloc(0)), { workflows: release }),
    );
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([
      { tools: [{ name: "read_workflow", args: { runId } }] },
      { text: "Waiting for the release run." },
      { text: "The release passed." },
    ]);
    const requests = api.requests.length;
    await at.start("t-run", "Watch the release.", repo.id);
    await expect.poll(() => api.requests.length - requests).toBe(2);
    await expect.poll(() => home.tasks.get("t-run")?.activity).toBe("idle");

    // The home read the run with its own forge, and its short read reached the crewmate there.
    const read = said(api.requests.at(-1));
    expect(read).toContain("state: in_progress");
    expect(read).toContain("116807634269 verify / linux-checks — in_progress");
    expect(read).toContain("The app watches this run every minute");
    expect(home.tasks.get("t-run")?.delivery?.runWatches).toEqual([
      expect.objectContaining({ runId, name: "release", failureSeen: false }),
    ]);

    // The run ends; the home's next minute reads it and wakes the crewmate there once.
    finished = true;
    await home.supervisor.pollCheckWatches(now() + 61_000);
    await expect.poll(() => api.requests.length - requests).toBe(3);
    expect(said(api.requests.at(-1))).toContain("release (run 38849548350, attempt 1) passed.");
    await expect.poll(() => home.tasks.get("t-run")?.activity).toBe("idle");
    expect(home.tasks.get("t-run")?.delivery?.runWatches).toEqual([]);
  });

  it("keeps a closed task's working copy there while that computer is out of reach, and brings its work home once it is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-away", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-away")?.activity).toBe("idle");
    const work = at.folders("t-away").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");

    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.interruptCrewmate("t-away", "cancel");
    expect(home.tasks.get("t-away")?.status).toBe("dropped");
    // Nothing is deleted there, and nothing is counted as gone here.
    expect(existsSync(work)).toBe(true);
    expect(home.tasks.get("t-away")?.workspaceState).toBe("present");

    await home.listen();
    await expect.poll(() => home.tasks.get("t-away")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-away")]);
    expect(await git(project.home, ["show", `${kept}:footer.html`])).toBe("<footer></footer>");
  });

  // DOP-121: on Kun's Mac mini 34 closed tasks' working copies stayed for
  // good. Each checkout had left its task's branch, as a reviewer's does,
  // and a version that read no branch for such a checkout had kept it.
  it("retires a closed task's working copy there that an earlier version kept without its branch's commits, keeping them here first", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-review", "Review the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-review")?.activity).toBe("idle");
    const work = at.folders("t-review").work;
    // A commit on its branch, then the version it reviews checked out, with a note of its own.
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    const onBranch = await commit(work, "feat: add the footer");
    await git(work, ["checkout", "--quiet", "--detach", project.main]);
    writeFileSync(join(work, "notes.txt"), "what the review found\n");
    const checkedOut = await commit(work, "docs: note what the review found");

    // It closes while that computer is out of reach, which then stops.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.interruptCrewmate("t-review", "cancel");
    await at.stopComputer();
    // The keep that version answered: the checkout alone, saved there and remembered.
    const clone = await git(work, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const older = await new WorkspaceService(
      {
        worktreesDir: join(at.dataDir, "worktrees"),
        worktreeTrashDir: join(at.dataDir, "worktree-trash"),
        worktreePoolDir: join(at.dataDir, "worktree-pool"),
        defaultWorkspaceDir: join(at.dataDir, "default-workspace"),
      },
      { pool: false },
    ).keepUnlandedWork({ taskId: "t-review", cwd: work, branch: "", repoDir: clone });
    if (!older) throw new Error("expected the older kept work");
    new PlacedTasks(at.dataDir, join(at.dataDir, "worktrees")).applied(
      "t-review",
      "keep:t-review",
      { kept: older },
    );

    await at.restartComputer();
    await home.listen();
    await expect.poll(() => home.tasks.get("t-review")?.workspaceState).toBe("removed");
    expect(existsSync(work)).toBe(false);
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-review")]);
    for (const commit of [onBranch, checkedOut, older.sha])
      await git(project.home, ["merge-base", "--is-ancestor", commit, kept]);
    await expect(
      git(clone, ["rev-parse", "--verify", "--quiet", "refs/heads/fm/task-t-review"]),
    ).rejects.toThrow();
  });

  it("asks that computer what a task's working copy holds before discarding it, and holds the discard while nobody can tell", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started." }]);
    await at.start("t-discard", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-discard")?.activity).toBe("idle");
    const work = at.folders("t-discard").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    await commit(work, "feat: add the footer");

    const refused = await home.supervisor.settleTaskDetailed("t-discard", "discard");
    expect(refused.refusal?.refused).toBe("unlanded-work");
    expect(refused.text).toContain("1 commit that were never merged");

    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const held = await home.supervisor.settleTaskDetailed("t-discard", "discard");
    expect(held.refusal?.refused).toBe("unlanded-work");
    expect(held.text).toContain("out of reach, so nobody can tell");
    expect(home.tasks.get("t-discard")?.status).toBe("active");
  });

  it("takes its model among the subscriptions that computer is signed in to, on its own account there, never this Mac's", async () => {
    const grok = await piStubRuntime(api.url, { provider: "xai", id: "grok-stub" });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      // The computer is signed in to Grok alone, which this Mac is not.
      signedInTo: [
        computerAccount("acct_codex_off", "openai-codex", { enabled: false }),
        computerAccount("acct_grok_there", "xai"),
      ],
      served: GROK_THERE,
      runtime: grok,
    });
    const home = at.home();
    const requests = api.requests.length;
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-routed");
    await expect.poll(() => home.tasks.get("t-routed")?.outcome).toBe("The footer is fixed.");
    // Routed among that computer's own sign-ins, with the record saying so.
    const [routed] = home.decisions.routing({ taskIds: ["t-routed"], chosen: true });
    expect(routed).toMatchObject({ provider: "xai", model: "grok-stub" });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-routed")).toContain(
      `routed among ${who}'s own sign-ins (xai): 1 model`,
    );
    // The computer was asked to bind its own account for that provider,
    // and no account of this Mac's serves the task.
    expect(at.bound).toEqual([{ backend: "pi", provider: "xai", accountId: "acct_grok_there" }]);
    expect(home.tasks.get("t-routed")?.accountId).toBeNull();
    expect(
      home.tasks.timeline("t-routed").find((event) => event.kind === "dispatched")?.text,
    ).toContain("xai/grok-stub");
    // Its brief reached the model there.
    expect(said(api.requests[requests])).toContain("Fix the footer.");
  });

  it("takes only a model that computer's own sign-in serves there, never one only this Mac's catalog lists (INF-146)", async () => {
    // This Mac's catalog lists the starter map's medium Codex model; the
    // computer's Codex account serves GPT-6 Sol alone, as Automatic reads it.
    const sol = await piStubRuntime(api.url, { provider: "openai-codex", id: "gpt-6-sol" });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_NEWER_CODEX,
      signedInTo: [computerAccount("acct_codex_there", "openai-codex")],
      served: [
        {
          accountId: "acct_codex_there",
          models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
        },
      ],
      runtime: sol,
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-served",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await home.supervisor.dispatchQueuedTask("t-served");
    const [routed] = home.decisions.routing({ taskIds: ["t-served"], chosen: true });
    expect(routed).toMatchObject({ provider: "openai-codex", model: "gpt-6-sol" });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-served")).toContain(
      `routed among ${who}'s own sign-ins (openai-codex): 1 model`,
    );
    await expect.poll(() => home.tasks.get("t-served")?.outcome).toBe("The footer is fixed.");
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_there" },
    ]);
  });

  it("binds the account there that serves its model, not the provider's pinned one that does not (INF-146)", async () => {
    const starter = await piStubRuntime(api.url, {
      provider: "openai-codex",
      id: CODEX_MEDIUM_STARTER,
    });
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime: starter });
    const home = at.home();
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-account");
    await expect.poll(() => home.tasks.get("t-account")?.outcome).toBe("The footer is fixed.");
    const [routed] = home.decisions.routing({ taskIds: ["t-account"], chosen: true });
    expect(routed).toMatchObject({ provider: "openai-codex", model: CODEX_MEDIUM_STARTER });
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_other" },
    ]);
  });

  it("starts on a model or basis the captain named while it waited for that computer's subscriptions (INF-83)", async () => {
    // That computer serves its medium starter, which routing takes unless the
    // captain names GPT-6 Sol, and its conversations can run either.
    const runtime = await piStubRuntime(
      api.url,
      { provider: "openai-codex", id: CODEX_MEDIUM_STARTER },
      ["gpt-6-sol"],
    );
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime });
    const home = at.home();
    const decide = vi.spyOn(Router.prototype, "decide");
    /** Holds the start's next read of that computer's subscriptions, its last wait before routing. */
    const holdServed = () => {
      const reached = gate();
      const release = gate();
      const served = home.placed.served.bind(home.placed);
      vi.spyOn(home.placed, "served").mockImplementationOnce(async (machine) => {
        reached.open();
        await release.held;
        return served(machine);
      });
      return { reached: reached.held, release: release.open };
    };
    const queued = (id: string) =>
      seedTask(home.tasks, {
        id,
        title: "website",
        prompt: "Fix the footer.",
        status: "queued",
        deviceId: at.deviceId,
      });

    // A model named while it waits starts it on that model there.
    queued("t-model");
    const named = holdServed();
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    const starting = home.supervisor.dispatchQueuedTask("t-model");
    await named.reached;
    home.tasks.updateFields("t-model", { model: "gpt-6-sol" }, "firstmate");
    named.release();
    await starting;
    await expect.poll(() => home.tasks.get("t-model")?.outcome).toBe("The footer is fixed.");
    expect(home.tasks.get("t-model")?.model).toBe("openai-codex/gpt-6-sol");

    // A basis named while it waits is the one its tier is read from, verified.
    const spec = home.tasks.create({
      id: "t-spec",
      title: "Footer spec",
      prompt: "p",
      repoId: null,
      startPolicy: "on-request",
    });
    home.tasks.recordReport(spec.id, { text: "The footer reads the year from the clock." });
    queued("t-basis");
    const grounded = holdServed();
    model([{ tools: [{ name: "report", args: { text: "The footer is grounded." } }] }]);
    const basisStart = home.supervisor.dispatchQueuedTask("t-basis");
    await grounded.reached;
    home.tasks.updateFields("t-basis", { basis: spec.key }, "firstmate");
    grounded.release();
    await basisStart;
    await expect.poll(() => home.tasks.get("t-basis")?.outcome).toBe("The footer is grounded.");
    const asked = decide.mock.calls.filter(([taskId]) => taskId === "t-basis");
    expect(asked.at(-1)?.[2]).toMatchObject({ basis: spec.key, basis_verified: true });
  });

  it("binds the same account there again when it resumes after both computers restart, not the provider's pinned one (INF-146)", async () => {
    const starter = await piStubRuntime(api.url, {
      provider: "openai-codex",
      id: CODEX_MEDIUM_STARTER,
    });
    const at = await world(undefined, { ...TWO_CODEX_THERE, runtime: starter });
    // One turn before the restarts, and the steered one after them.
    model([
      { text: "Started on the footer." },
      { tools: [{ name: "report", args: { text: "The header is fixed too." } }] },
    ]);
    await at.start("t-resumed");
    await expect.poll(() => at.home().tasks.get("t-resumed")?.activity).toBe("idle");
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openai-codex", accountId: "acct_codex_other" },
    ]);

    // Neither side holds the conversation any more: this Mac resumes it from
    // its record, and the computer opens it again with the binding it names.
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach("t-resumed");
    await at.home().supervisor.steerCrewmate("t-resumed", "Fix the header too.");
    await expect
      .poll(() => at.home().tasks.get("t-resumed")?.outcome)
      .toBe("The header is fixed too.");
    // A resumed conversation names no model, only the account it is bound to.
    expect(at.bound.map((binding) => binding.accountId)).toEqual([
      "acct_codex_other",
      "acct_codex_other",
    ]);
  });

  it("takes this Mac's Claude catalog for a Claude account there that lists no models, as a computer on protocol 2.6.0 through 8.1.0 says (INF-146)", async () => {
    const at = await world(undefined, {
      routing: {
        ...THIS_MAC_ON_CODEX,
        catalogModels: [...THIS_MAC_ON_CODEX.catalogModels, ...CLAUDE_CATALOG],
      },
      signedInTo: [computerAccount("acct_claude_there", CLAUDE_PROVIDER_ID)],
      // Its vault lists the signed-in Claude account with no models at all.
      served: [{ accountId: "acct_claude_there", models: [] }],
    });
    // What a task set to run there routes among, and the account each model binds.
    const pool = await at.home().placed.served(at.deviceId);
    expect(pool.available).toEqual(CLAUDE_CATALOG.map(({ provider, id }) => ({ provider, id })));
    expect(
      CLAUDE_CATALOG.map((model) => pool.modelAccounts?.get(`${model.provider}/${model.id}`)),
    ).toEqual(CLAUDE_CATALOG.map(() => "acct_claude_there"));
  });

  it("starts a task on a computer signed in only to OpenRouter, on one of that account's OpenRouter models there (FI3-1355)", async () => {
    // OpenRouter is the one subscription this Mac's catalog does not list:
    // the computer's own list is what its tasks route among.
    const alias = "~anthropic/claude-sonnet-latest";
    const openrouter = await piStubRuntime(api.url, { provider: "openrouter", id: alias });
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_or_there", "openrouter", { kind: "api_key" })],
      served: [{ accountId: "acct_or_there", models: openRouterList([alias]) }],
      runtime: openrouter,
    });
    const home = at.home();
    const requests = api.requests.length;
    model([{ tools: [{ name: "report", args: { text: "The footer is fixed." } }] }]);
    await at.start("t-openrouter");
    await expect.poll(() => home.tasks.get("t-openrouter")?.outcome).toBe("The footer is fixed.");
    // Routed among that computer's OpenRouter models, none of them this Mac's.
    const [routed] = home.decisions.routing({ taskIds: ["t-openrouter"], chosen: true });
    expect(routed).toMatchObject({ provider: "openrouter", model: alias });
    const who = home.placed.placeOf(at.deviceId).who;
    expect(routingReasons(home, "t-openrouter")).toContain(
      `routed among ${who}'s own sign-ins (openrouter): 451 models`,
    );
    // The computer bound its own OpenRouter account, and its brief reached the model there.
    expect(at.bound).toEqual([
      { backend: "pi", provider: "openrouter", accountId: "acct_or_there" },
    ]);
    expect(home.tasks.get("t-openrouter")?.accountId).toBeNull();
    expect(said(api.requests[requests])).toContain("Fix the footer.");
  });

  it("does not start a task whose computer is signed in to no subscription that can take it, and makes nothing there", async () => {
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      // Its only account is switched off there.
      signedInTo: [computerAccount("acct_grok_off", "xai", { enabled: false })],
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-bare",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-bare");
    const who = home.placed.placeOf(at.deviceId).who;
    expect(home.tasks.get("t-bare")).toMatchObject({
      status: "open",
      gate: {
        kind: "captain",
        ref: "dispatch-failed",
        reason: `${who} has no subscription of its own that can take this task now. Sign it in to one in Settings → Intelligence.`,
      },
    });
    // Neither this Mac's Codex nor anything else was chosen in its place.
    expect(home.decisions.routing({ taskIds: ["t-bare"], chosen: true })).toEqual([]);
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("waits for a computer with no sign-ins yet, says so once, and starts by itself once it has one (FI3-1350)", async () => {
    // The computer lists no account at all; one appears once the captain signs it in there.
    const accounts: AccountView[] = [];
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: accounts,
      served: GROK_THERE,
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-none",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    const { label } = home.placed.placeOf(at.deviceId);
    await home.supervisor.dispatchQueuedTask("t-none");
    // Queued work with no gate: nothing to press, nothing tried there.
    expect(home.tasks.get("t-none")).toMatchObject({ status: "open", gate: null });
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const waits = () =>
      feed(home).filter((line) => line === noSignInsWaitLine(label, "website's next task"));
    expect(waits()).toHaveLength(1);
    // Tried again at the next sweep, it still waits, and the feed says nothing twice.
    await home.supervisor.sweepGates(now());
    expect(home.tasks.get("t-none")?.status).toBe("open");
    expect(waits()).toHaveLength(1);
    expect(await home.supervisor.startQueuedNow("t-none", "captain")).toContain(
      "has no sign-ins yet",
    );

    // Signed in there: the computer says so, and the task starts by itself.
    model([{ text: "Done." }]);
    accounts.push(computerAccount("acct_grok_there", "xai"));
    await home.signIns.refresh(at.deviceId);
    await expect.poll(() => home.tasks.get("t-none")?.status).toBe("active");
    await expect
      .poll(() => at.bound)
      .toEqual([{ backend: "pi", provider: "xai", accountId: "acct_grok_there" }]);
    await expect
      .poll(() => feed(home))
      .toContain(`website's next task started ${home.placed.placeOf(at.deviceId).where}.`);
  });

  it("holds a task for a GitHub project until its computer has its own GitHub sign-in, with the card and one feed line, and starts it once it does (FI3-1350)", async () => {
    const forges: ComputerForges = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      forges: () => forges,
    });
    const home = at.home();
    // A project that lives on GitHub, adopted here from a clone whose origin names it.
    const project = await gitProject();
    await git(project.home, ["remote", "set-url", "origin", "https://github.com/octo/website.git"]);
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-github",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    await home.supervisor.dispatchQueuedTask("t-github");
    const place = home.placed.placeOf(at.deviceId);
    const ref = deviceForgeGateRef("github.com", at.deviceId);
    expect(home.tasks.get("t-github")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref },
    });
    // Nothing was tried there: no clone, no conversation.
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
    expect(
      feed(home).filter(
        (line) => line === deviceForgeWaitLine(`${repo.name}'s next task`, place.who),
      ),
    ).toHaveLength(1);
    const cardId = deviceForgeSignInCardId("github.com", at.deviceId);
    await expect
      .poll(() => home.cards().find((card) => card.id === cardId))
      .toMatchObject({
        author: "host",
        title: `Sign in to GitHub ${place.where}`,
        actions: [
          expect.objectContaining({
            effect: {
              kind: "open",
              target: "projects",
              forgeSignInOn: { deviceId: at.deviceId, host: "github.com" },
            },
          }),
        ],
      });

    // The captain signed it in there: the computer says so, the card comes
    // down, and the task starts by itself, cloning with that sign-in.
    model([{ text: "Done." }]);
    forges.signIns.push({
      host: "github.com",
      name: "GitHub",
      login: "octo",
      state: "ok",
      since: 1,
    });
    await git(project.home, ["remote", "set-url", "origin", project.origin]);
    await home.signIns.refresh(at.deviceId);
    await expect.poll(() => home.tasks.get("t-github")?.status).toBe("active");
    await expect.poll(() => home.cards().some((card) => card.id === cardId)).toBe(false);
    await expect.poll(() => at.holds().workingCopies).toEqual(["t-github"]);
  });

  it("holds a task whose clone GitHub refused on its computer, typed, for that computer's own sign-in (FI3-1350)", async () => {
    let refuse = true;
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      // It offers no GitHub sign-in from here, so nothing holds it before the clone.
      refuseClone: () => refuse,
    });
    const home = at.home();
    const project = await gitProject();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-refused",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    await home.supervisor.dispatchQueuedTask("t-refused");
    const place = home.placed.placeOf(at.deviceId);
    expect(home.tasks.get("t-refused")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      gate: { kind: "captain", ref: deviceForgeGateRef("github.com", at.deviceId) },
    });
    // Nothing was cloned there; the task's own folder there is a failed start's, cleaned later.
    expect(at.holds().workingCopies).toEqual([]);
    expect(feed(home)).toContain(deviceForgeWaitLine(`${repo.name}'s next task`, place.who));
    await expect
      .poll(() =>
        home.cards().some((card) => card.id === deviceForgeSignInCardId("github.com", at.deviceId)),
      )
      .toBe(true);
    // Lifted once that computer reports the sign-in: the clone goes through.
    model([{ text: "Done." }]);
    refuse = false;
    await home.supervisor.resumeDeviceForgeSignInTasks(at.deviceId, "github.com");
    await expect.poll(() => home.tasks.get("t-refused")?.status).toBe("active");
    expect(at.holds().workingCopies).toEqual(["t-refused"]);
  });

  it("starts nothing for a task whose computer takes no work, and never runs it here", async () => {
    const at = await world();
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-waits",
      title: "website",
      status: "queued",
      deviceId: "a-mac-on-another-version",
    });
    await home.supervisor.dispatchQueuedTask("t-waits");
    expect(home.tasks.get("t-waits")?.status).toBe("open");
    expect(home.placed.ready("a-mac-on-another-version", "t-waits")).toBe(false);
  });
});

/**
 * A project's Runs on (docs/helper.md, "Runs on"): the project's next task
 * starts on the computer it names, waits while that computer is out of
 * reach and says so once, and never runs here instead; moving the project
 * leaves a started task where it is.
 */
// INF-795: "A crewmate on a computer that runs work gets
// infinitary-integrations-axi, whose list, show and call are forwarded to the
// home ... so no sign-in leaves the home." The command runs in the
// crewmate's shell there through the real launcher, command process and
// task channel, and each call crosses the real connection to this Mac's
// own integrations, over a stand-in GitHub.
describe("the integrations command on a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  beforeEach(() => {
    // INF-1038: this computer has only its fixture's tools, not the runner's
    // task commands. hostEnv also appends installer directories, so replacing
    // process.env.PATH alone does not isolate it. Keep git for working copies;
    // withTaskShell still adds the real command path when the task is granted it.
    const bin = scratchDir("infinitary-placed-host-bin-");
    symlinkSync("/usr/bin/git", join(bin, "git"));
    const inheritedHostEnv = hostEnvironment.hostEnv;
    const environment = vi.spyOn(hostEnvironment, "hostEnv").mockImplementation((extra) => ({
      ...inheritedHostEnv(extra),
      PATH: bin,
    }));
    stops.push(() => {
      environment.mockRestore();
    });
  });

  it("lists, shows and calls this Mac's integrations from the crewmate's shell there, with the sign-in and the ask kept here", async () => {
    const github = await standInGitHub();
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      github: { apiBaseUrl: github.base, token: GITHUB_TOKEN, login: "octo" },
    });
    const issue = {
      method: "POST",
      path: "/repos/acme/site/issues",
      body: JSON.stringify({ title: "The footer overlaps on phones" }),
    };
    model([
      { tools: [shellCommand("infinitary-integrations-axi")] },
      { tools: [shellCommand("infinitary-integrations-axi show GitHub")] },
      { tools: [shellCommand(`infinitary-integrations-axi call GitHub read '{"path":"/user"}'`)] },
      {
        tools: [
          shellCommand(
            `infinitary-integrations-axi call GitHub write '${JSON.stringify(issue)}' --reason 'File the footer bug you asked me to report.'`,
          ),
        ],
      },
      { text: "The issue waits for the captain." },
    ]);
    // INF-950: this transport journey explicitly starts with the read always allowed.
    at.home().integrations?.setRule("github", "read", true);
    const requests = api.requests.length;
    await at.start("t-reach");
    const home = at.home();
    await expect
      .poll(() => home.tasks.get("t-reach")?.outcome)
      .toBe("The issue waits for the captain.");
    // Its instructions there name the command.
    expect(systemOf(api.requests[requests])).toContain(CREWMATE_INTEGRATIONS_LINE);

    // List and show answer what this Mac has connected.
    const listed = shellAnswer(api.requests[requests + 1]);
    expect(listed.exit).toBe(0);
    expect(listed.output).toContain("GitHub");
    expect(listed.output).toContain("octo");
    const shown = shellAnswer(api.requests[requests + 2]);
    expect(shown.exit).toBe(0);
    expect(shown.output).toContain("read");
    expect(shown.output).toContain("write");

    // A read runs here, through this Mac's sign-in, and its answer reaches the shell there.
    const read = shellAnswer(api.requests[requests + 3]);
    expect(read.exit).toBe(0);
    expect(read.output).toContain('"login": "octo"');
    expect(github.seen).toEqual([{ method: "GET", path: "/user", auth: `Bearer ${GITHUB_TOKEN}` }]);

    // A change is kept here as the captain's ask; nothing is sent, so the
    // command exits 1 and still names the ask (the captain's INF-824 choice:
    // "Return exit 1: the change was not sent.").
    const write = shellAnswer(api.requests[requests + 4]);
    expect(write.exit).toBe(1);
    expect(write.output).toContain("REFUSED");
    expect(write.output).toContain("Not run");
    const kept = home.tasks.get("t-reach")?.delivery?.writeAsks?.[0];
    expect(write.output).toContain(`approval card for ask ${kept?.id}`);
    expect(home.tasks.get("t-reach")?.delivery?.writeAsks).toEqual([
      expect.objectContaining({
        kind: "integration",
        action: "write",
        input: JSON.stringify(issue),
        reason: "File the footer bug you asked me to report.",
      }),
    ]);
    expect(github.seen).toHaveLength(1);
    const approval = home.supervisor.cardsSnapshot().find((card) => card.taskId === "t-reach");
    expect(approval).toMatchObject({
      author: "host",
      actions: expect.arrayContaining([
        expect.objectContaining({ label: "Only this time", default: true }),
      ]),
    });
    // The call is kept by its id, so one asked again after a drop is answered once.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-reach"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { channel: string }).channel);
    expect(calls.filter((channel) => channel === "inf:work:use-integration")).toHaveLength(2);

    if (!approval) throw new Error("The host approval card is missing");
    model([{ text: "The issue request was refused." }]);
    home.supervisor.act(approval.id, "once");
    await expect
      .poll(() => home.tasks.get("t-reach")?.outcome)
      .toBe("The issue request was refused.");
    expect(github.seen.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(home.tasks.get("t-reach")?.delivery?.writeAsks?.[0]?.outcome).toMatchObject({
      kind: "refused",
    });
    // Repeating the already-resolved choice never repeats the request.
    home.supervisor.act(approval.id, "once");
    expect(github.seen.filter((request) => request.method === "POST")).toHaveLength(1);

    // Nothing of the sign-in is on that computer, while the answer it read is in its record there.
    expect(filesHolding(at.dataDir, GITHUB_TOKEN)).toEqual([]);
    expect(filesHolding(at.dataDir, "The Octocat")).toContainEqual(
      expect.stringMatching(/^tasks\/t-reach\/sessions\//),
    );
  });

  it("starts no integrations work on an older major and supplies the command after updating", async () => {
    // An installed command must not supply a missing command on the older
    // computer, even on CI runners that have no task commands of their own.
    const installed = scratchDir("infinitary-installed-task-command-");
    writeFileSync(
      join(installed, "infinitary-integrations-axi"),
      "#!/bin/sh\nprintf 'runner-installed command reached\\n'\nexit 0\n",
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${installed}:${process.env.PATH ?? ""}`);
    const github = await standInGitHub();
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      github: { apiBaseUrl: github.base, token: GITHUB_TOKEN, login: "octo" },
      protocolVersion: "11.0.0",
    });
    model([
      { tools: [shellCommand("infinitary-integrations-axi")] },
      { text: "No integrations here." },
    ]);
    const home = at.home();
    const requests = api.requests.length;
    seedTask(home.tasks, {
      id: "t-older",
      title: "Use integrations",
      prompt: "List integrations",
      status: "queued",
      deviceId: at.deviceId,
    });
    await home.supervisor.dispatchQueuedTask("t-older");
    expect(home.tasks.get("t-older")?.status).toBe("open");
    expect(home.placed.takesIntegrations(at.deviceId)).toBe(false);
    expect(api.requests.length).toBe(requests);
    expect(github.seen).toEqual([]);
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-older");
    await home.supervisor.dispatchQueuedTask("t-older");
    await expect.poll(() => home.tasks.get("t-older")?.outcome).toBe("No integrations here.");
    expect(systemOf(api.requests[requests])).toContain(CREWMATE_INTEGRATIONS_LINE);
    expect(shellAnswer(api.requests[requests + 1]).exit).toBe(0);
    expect(JSON.stringify(api.requests)).not.toContain("runner-installed command reached");
  });
});

describe("Gmail and Calendar content on a computer that runs work", () => {
  // INF-1094: "Gmail and Calendar content a crewmate read on another
  // computer that runs work is replaced with the same note after 30 days
  // and when the captain uses Delete Gmail and Calendar content, and the
  // row's answer counts those conversations." The captain's INF-952
  // answers hold there too: the passage is replaced and the conversation
  // stays, 30 days after it was read.
  const NOTE = outsideDataDeletedNote("Gmail and Calendar content");
  const DAY = 24 * 60 * 60 * 1000;
  const LENA = {
    from: "Lena Ortiz <lena@ortiz-studio.com>",
    subject: "Invoice 2214 for the October shoot",
    text: "Hi Ada,\n\nThe invoice for the October shoot is attached. Payment is due by Nov 4.\n\nThanks,\nLena",
  };
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  /** A computer that runs work, with this Mac signed in to Google's stand-in and its reads allowed. */
  async function withGoogle(changes?: readonly string[]) {
    const google = await startGoogleStandIn();
    stops.push(() => google.close());
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      google: { base: google.base },
      ...(changes ? { changes } : {}),
    });
    const home = at.home();
    const integrations = home.integrations;
    const outsideData = home.outsideData;
    if (!integrations || !outsideData) throw new Error("The home composes Google here.");
    await integrations.signIn("google", NOTICE_ACCEPTED);
    // INF-950: content retention starts after the captain has allowed these reads.
    allowIntegrationReads(integrations);
    return { google, at, home, outsideData };
  }

  /**
   * A crewmate on the computer runs one integrations command from its shell
   * there, through this Mac's Google sign-in, and reports what it heard as
   * its outcome; answers what it heard.
   */
  async function runThere(
    at: Awaited<ReturnType<typeof world>>,
    taskId: string,
    command: string,
  ): Promise<string> {
    const home = at.home();
    // INF-1534: on a loaded Mac the call can outlast the shell's limit. The
    // crewmate then collects its answer as the product tells it to, as the
    // journeys' stand-ins do (INF-1141): after `running` or `BUSY` it runs
    // the bare command, which gets the kept answer, and after a background
    // job's receipt it ends each turn until the job's end, which names the
    // job and carries the command's output. Whatever else it hears is the
    // answer it reports on, checked by the caller.
    let read: string | undefined;
    let job: string | undefined;
    const waiting = { text: "Waiting for the answer." };
    model((request, index) => {
      if (index === 0) return { tools: [shellCommand(command)] };
      if (read !== undefined) return { text: "Done." };
      const heard = lastHeard(request);
      if (job !== undefined) {
        if (!heard.includes(job)) return waiting;
        job = undefined;
      } else {
        job = jobOf(heard);
        if (job !== undefined) return waiting;
      }
      if (heard.includes(READ_RUNNING) || heard.includes(READ_BUSY))
        return { tools: [shellCommand(INTEGRATIONS_COMMAND)] };
      read = heard;
      return { text: "Lena's message is answered." };
    });
    await at.start(taskId, "Answer Lena.");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Lena's message is answered.");
    return read ?? "";
  }

  /**
   * A crewmate on the computer reads Lena's message through this Mac's
   * Google sign-in, from its shell there, and its turn ends.
   */
  async function readThere(changes?: readonly string[]) {
    const { google, at, home, outsideData } = await withGoogle(changes);
    const id = google.deliver(LENA);
    const read = await runThere(
      at,
      "t-lena",
      `${INTEGRATIONS_COMMAND} call Google read_message '${JSON.stringify({ id })}'`,
    );
    // It read the message there, and its record there and this Mac's copy hold it.
    expect(read).toContain(LENA.subject);
    const there = at.folders("t-lena").sessions;
    const here = crewmateSessionsDir(home.paths, "t-lena");
    const calls = join(crewmatePlacedDir(home.paths, "t-lena"), "calls.jsonl");
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    await expect.poll(() => filesHolding(here, LENA.subject)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).toContain(LENA.subject);
    return { at, home, outsideData, there, here, calls };
  }

  // INF-2466, the captain's approved plan: a crewmate saves a Gmail
  // attachment "into the task's hand-over folder, kept until day 30 or the
  // task closes", and Delete Gmail and Calendar content removes it at once.
  it("saves an attachment into the task's hand-over folder there byte for byte, and the captain's delete removes it there", async () => {
    const { google, at, home, outsideData } = await withGoogle();
    const pdf = randomBytes(48_211);
    const id = google.deliver({
      ...LENA,
      attachment: {
        name: "invoice-2214.pdf",
        type: "application/pdf",
        size: pdf.length,
        bytes: pdf,
      },
    });
    const heard = await runThere(
      at,
      "t-lena",
      `${INTEGRATIONS_COMMAND} call Google save_attachment '${JSON.stringify({ id, part: "1" })}'`,
    );
    const handover = join(at.folders("t-lena").temp, "handover");
    const [saved] = readdirSync(handover).filter((name) => name.endsWith("invoice-2214.pdf"));
    const path = join(handover, saved ?? "missing");
    expect(readFileSync(path).equals(pdf)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The crewmate heard its path there, never its bytes.
    expect(heard).toContain(path);
    expect(heard).not.toContain(pdf.subarray(0, 64).toString("base64url"));
    // Nothing of it stays on this Mac.
    expect(
      existsSync(join(crewmateTempDir(home.paths, "t-lena"), "handover", saved ?? "missing")),
    ).toBe(false);

    await outsideData.deleteNow();
    expect(existsSync(path)).toBe(false);
  });

  it("replaces what it read there and in this Mac's copy on the captain's delete, counts it, and its next turn reads the note", async () => {
    const { at, home, outsideData, there, here, calls } = await readThere();

    expect(await outsideData.deleteNow()).toEqual({ conversations: 1, waiting: 0 });
    // Replaced on the computer, in this Mac's copy of its record and in the
    // calls this Mac answered, with the conversation kept around it.
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
    expect(filesHolding(dirname(here), LENA.subject)).toEqual([]);
    expect(filesHolding(here, NOTE)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).not.toContain(LENA.subject);
    expect(filesHolding(here, "Lena's message is answered.")).not.toEqual([]);

    // Its next turn there carries the note, never the message.
    model([{ text: "Lena's invoice is answered." }]);
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-lena", "What did Lena ask for?");
    await expect.poll(() => home.tasks.get("t-lena")?.outcome).toBe("Lena's invoice is answered.");
    const next = said(api.requests[requests]);
    expect(next).toContain("What did Lena ask for?");
    expect(next).toContain(NOTE);
    expect(next).not.toContain(LENA.subject);
    // This Mac's copy follows that turn as written there, file for file.
    await expect.poll(() => sameFiles(here, there)).toEqual({ missing: [], differing: [] });
    expect(filesHolding(at.dataDir, LENA.subject)).toEqual([]);
  });

  it("goes on its own 30 days after it was read, there too", async () => {
    const { outsideData, there, here } = await readThere();
    const kept = GOOGLE_DATA_KEPT.days * DAY;
    ahead = kept - DAY;
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    // The ledger counts in hours: its words go within the hour after they are due.
    ahead = kept + READ_HOUR_MS;
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
    expect(filesHolding(dirname(here), LENA.subject)).toEqual([]);
  });

  it("counts a computer on an older major as unreachable until updated, then replaces its content", async () => {
    const { at, home, outsideData, there, calls } = await readThere();
    await at.restartComputer({ protocolVersion: "11.0.0" });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe("11.0.0");

    expect(await outsideData.deleteNow()).toEqual({
      conversations: 0,
      waiting: 0,
      elsewhere: [{ computer: "Mac mini", conversations: 1, until: "reach" }],
    });
    // Nothing was asked of that computer; the calls this Mac answered are its own to replace.
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).not.toContain(LENA.subject);

    // Updated, it is replaced there at the next sweep.
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-lena");
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
  });
});

/** The files under `copy` that `source` holds differently or not at all, by their path in `source`. */
function sameFiles(copy: string, source: string): { missing: string[]; differing: string[] } {
  const missing: string[] = [];
  const differing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(source, path);
        const copied = join(copy, name);
        if (!existsSync(copied)) missing.push(name);
        else if (!readFileSync(copied).equals(readFileSync(path))) differing.push(name);
      }
    }
  };
  walk(source);
  return { missing, differing };
}

/** The invented token this Mac's github.com sign-in holds in these cases. */
const GITHUB_TOKEN = "gho_fixture_owned_by_app";

/**
 * A stand-in GitHub API: `/user` answers as GitHub's does for the signed-in
 * account (trimmed), and every other path is Not Found. Every request is recorded.
 */
async function standInGitHub() {
  const seen: { method: string; path: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
    const found = req.method === "GET" && req.url === "/user";
    res.writeHead(found ? 200 : 404, {
      "Content-Type": "application/json",
      "x-github-request-id": "REQ-1",
      "x-ratelimit-remaining": "4999",
    });
    res.end(
      JSON.stringify(
        found
          ? {
              login: "octo",
              id: 583231,
              node_id: "MDQ6VXNlcjU4MzIzMQ==",
              type: "User",
              html_url: "https://github.com/octo",
              name: "The Octocat",
              public_repos: 8,
            }
          : { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The model runs one command in its shell, in the foreground. */
function shellCommand(command: string) {
  return { name: "bash", args: { command, description: "Reach the integrations" } };
}

/** The crewmate's instructions as a request carried them. */
function systemOf(request: StubRequest | undefined): string {
  return (request?.body.system ?? []).map((block) => block.text ?? "").join("\n");
}

/** What the shell answered the model's last command, as its next request carries it. */
function shellAnswer(request: StubRequest | undefined): { exit: number; output: string } {
  const content = request?.body.messages?.at(-1)?.content;
  const result = Array.isArray(content)
    ? (content as { type?: string; content?: unknown }[]).findLast(
        (block) => block.type === "tool_result",
      )?.content
    : undefined;
  const [first = "", ...rest] = textOf(result).split("\n");
  return { exit: Number(/^exit (\d+)$/.exec(first)?.[1] ?? Number.NaN), output: rest.join("\n") };
}

/** What the model's request told it last: the shell's answer to its command, or a wake's words. */
function lastHeard(request: StubRequest): string {
  const content = request.body.messages?.at(-1)?.content;
  if (!Array.isArray(content)) return textOf(content);
  return (content as { type?: string; text?: string; content?: unknown }[])
    .map((block) => (block.type === "tool_result" ? textOf(block.content) : (block.text ?? "")))
    .join("\n");
}

/** A message's or tool result's content as its text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { text?: string }[]).map((block) => block.text ?? "").join("");
}

/** The job a shell's answer is the receipt for, read in the bash tool's own words; none when it finished. */
function jobOf(heard: string): string | undefined {
  const [before = "", after = ""] = backgroundJobReceipt("\0").split("\0");
  const end = heard.startsWith(before) ? heard.indexOf(after, before.length) : -1;
  return end < 0 ? undefined : heard.slice(before.length, end);
}

/** What an integration's `call` prints when its answer is kept past the shell's limit. */
const READ_RUNNING = renderIntegrationReply(
  "call",
  { kind: "running", command: "call" },
  [],
).trimEnd();

/** Why the next command was not run while that kept answer is still coming. */
const READ_BUSY = refusalOf({ kind: "busy", command: "call" });

/** The words the integrations command refuses a reply with. */
function refusalOf(reply: IntegrationReply): string {
  try {
    renderIntegrationReply(INTEGRATIONS_COMMAND, reply, []);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`The integrations command prints a ${reply.kind} reply rather than refusing it.`);
}

/** Every file under `root` whose bytes hold `text`. */
function filesHolding(root: string, text: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && readFileSync(path).includes(text))
        found.push(relative(root, path));
    }
  };
  walk(root);
  return found;
}

describe("a project that runs on a computer that runs work", () => {
  it("waits for that computer, says so once and again after a day, and starts its next task there once it is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    // Out of reach: the task waits as queued work, placed there, and the
    // feed says so once however often the sweep looks.
    seedTask(home.tasks, { id: "t-next", title: "footer", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-next");
    await home.supervisor.dispatchQueuedTask("t-next");
    expect(home.tasks.get("t-next")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      worktreeDir: "",
    });
    const waits = () => feed(home).filter((line) => line.includes("next task"));
    expect(waits()).toEqual([
      "home's next task waits for Builder. It never runs on this computer instead.",
    ]);
    expect(await home.supervisor.startQueuedNow("t-next")).toBe(
      `${home.tasks.get("t-next")?.key} "footer" waits for Builder, which is out of reach. It never runs on this computer instead.`,
    );
    expect(home.tasks.get("t-next")?.status).toBe("open");

    // A day later the feed says it once more, with the way to run it here.
    ahead += 24 * 60 * 60 * 1000;
    await home.supervisor.dispatchQueuedTask("t-next");
    await home.supervisor.dispatchQueuedTask("t-next");
    expect(waits().slice(1)).toEqual([
      "Running as Builder has been out of reach for a day. home's next task still waits.",
    ]);
    expect(feed(home)).toContain("To run it here instead, set home to run on this computer.");

    // Back: it starts there, in a working copy that computer made, and its
    // cards name where it runs.
    model([
      { tools: [{ name: "emit_card", args: { title: "Footer started", body: "<p>On it.</p>" } }] },
      { text: "Started on the footer." },
    ]);
    await home.listen();
    await at.inReach("t-next");
    // Its coming back runs the ready sweep, which starts the task.
    await home.supervisor.dispatchQueuedTask("t-next");
    await expect.poll(() => home.tasks.get("t-next")?.branch).toBe("fm/task-t-next");
    expect(home.tasks.get("t-next")).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      branch: "fm/task-t-next",
      worktreeDir: "",
    });
    expect(waits().at(-1)).toBe("home's next task started as Builder.");
    // Where it runs rides beside the task's title, never inside it, so a
    // long title gives way and the place stays whole.
    await expect
      .poll(() => home.cards().find((card) => card.title === "Footer started"))
      .toMatchObject({ meta: "footer", place: "as Builder" });
    expect(await git(at.folders("t-next").work, ["symbolic-ref", "--short", "HEAD"])).toBe(
      "fm/task-t-next",
    );

    // Moved back here: the started task stays there, and the next one starts here.
    home.repos.setRunsOn(repo.id, null);
    seedTask(home.tasks, { id: "t-after", title: "header", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-after");
    expect(home.tasks.get("t-next")?.deviceId).toBe(at.deviceId);
    expect(home.tasks.get("t-after")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-after")?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });

  it("queues a task commissioned while that computer is out of reach, and a task moved back here before it starts runs here", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    const { taskId, crewmate } = await home.supervisor.commission({
      title: "footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue" },
      repoId: repo.id,
    });
    expect(crewmate).toBe("queued");
    expect(home.tasks.get(taskId)).toMatchObject({ status: "open", deviceId: at.deviceId });
    expect(feed(home)).toContain(
      "home's next task waits for Builder. It never runs on this computer instead.",
    );

    // The captain sets it to run here before it starts: it starts here.
    home.repos.setRunsOn(repo.id, null);
    await home.supervisor.dispatchQueuedTask(taskId);
    expect(home.tasks.get(taskId)?.deviceId ?? null).toBeNull();
    // This test's home keeps no working copies, so the start here is refused there.
    expect(home.tasks.get(taskId)?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });

  it("starts a project kept on this Mac only here, and refuses to move it", async () => {
    const at = await world();
    const home = at.home();
    const { repo } = await home.repos.setup({ kind: "init", name: "notes" });
    expect(() => home.repos.setRunsOn(repo.id, at.deviceId)).toThrow(
      "notes: Kept on this computer only, so its tasks run here.",
    );
    seedTask(home.tasks, { id: "t-notes", title: "notes", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-notes");
    // It started here: this test's home keeps no working copies of its own,
    // so this Mac's workspace refusing to make one is the start here.
    expect(home.tasks.get("t-notes")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-notes")?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });
});

/**
 * The captain's word on where a filed task runs, as update_task's runs_on
 * carries it (the Firstmate's update delegate): refused in plain words, or
 * kept on the record, and the task and its parts that have not started go
 * there. Answers the refusal, or the change the record keeps.
 */
function askRunsOn(home: PlacedHome, taskId: string, ask: string | null): string {
  const refused = home.supervisor.runsOnRefusal(taskId, ask);
  if (refused) return refused;
  const words = home.supervisor.runsOnWords(taskId, ask);
  const changes = home.tasks.updateFields(taskId, { runsOn: { ask, words } }, "firstmate");
  home.supervisor.runsOnChanged(taskId);
  return changes.join(", ");
}

/** The task's record, which the case knows exists. */
function recordOf(home: PlacedHome, taskId: string) {
  const record = home.tasks.get(taskId);
  if (!record) throw new Error(`No task ${taskId}`);
  return record;
}

/**
 * The home's one-time move into Infinitary's folder (docs/saved-data-compatibility.md,
 * "The one-time move"), for a project's folder: with the home stopped, the
 * folder is copied to a new one, the older one staying as it was, and the
 * move's own rewrite re-points the home's records, including a task held on
 * another computer. Answers the new folder.
 */
async function moveProjectFolder(
  at: Awaited<ReturnType<typeof world>>,
  from: string,
): Promise<string> {
  const to = join(scratchDir("infinitary-placed-moved-"), "home");
  const { userData } = at.home().paths;
  await at.restartHome(() => {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rewriteDatabases(userData, pathsOf(from), to);
  });
  return to;
}

/** Manual-placement journeys name their starting computer instead of borrowing a default. */
async function adoptHere(repos: PlacedHome["repos"], path: string) {
  const result = await repos.setup({ kind: "adopt", path });
  return { ...result, repo: repos.setRunsOn(result.repo.id, null) };
}

/** Where this Mac's workspace refused to start a task here: this test's home keeps no working copies. */
const STARTED_HERE = "A placed task asked this Mac's workspace for createTaskWorktree.";

/**
 * A task's own Runs on (docs/helper.md, "A task's own Runs on"): the
 * captain tells Firstmate where one task runs, before it starts. It wins
 * over its project's Runs on, for the task and each part of it with none
 * of its own, and stays when the project moves.
 */
describe("a task's own Runs on", () => {
  // INF-1582: a named computer starts real placed work, not merely a queued row.
  it("starts work by computer name and keeps its stable device ID", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([
      {
        tools: [
          { name: "emit_card", args: { title: "Named computer started", body: "<p>On it.</p>" } },
        ],
      },
      { text: "Started on the named computer." },
    ]);
    const { taskId, crewmate } = await home.supervisor.commission({
      title: "named footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue on Mac mini" },
      repoId: repo.id,
      shape: { runs_on_ask: "Mac mini" },
    });
    expect(crewmate).not.toBe("queued");
    await expect.poll(() => home.tasks.get(taskId)?.branch).toBe(`fm/task-${taskId}`);
    expect(home.tasks.get(taskId)).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      shape: expect.objectContaining({ runs_on_ask: at.deviceId }),
    });
    await expect
      .poll(() => home.cards().find((card) => card.title === "Named computer started"))
      .toMatchObject({ place: "as Builder" });
    console.log(
      "Named placement proof",
      JSON.stringify({
        selected: "Mac mini",
        storedComputer: home.tasks.get(taskId)?.deviceId,
        branch: home.tasks.get(taskId)?.branch,
        result: "The placed crewmate emitted its card.",
      }),
    );
  });

  it("starts a task on the computer the captain named while its project runs here, and its card says where", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();
    model([
      { tools: [{ name: "emit_card", args: { title: "Footer started", body: "<p>On it.</p>" } }] },
      { text: "Started on the footer." },
    ]);
    const { taskId, crewmate } = await home.supervisor.commission({
      title: "footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue on the mini" },
      repoId: repo.id,
      shape: { runs_on_ask: at.deviceId },
    });
    expect(crewmate).not.toBe("queued");
    await expect.poll(() => home.tasks.get(taskId)?.branch).toBe(`fm/task-${taskId}`);
    expect(home.tasks.get(taskId)).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      worktreeDir: "",
    });
    await expect
      .poll(() => home.cards().find((card) => card.title === "Footer started"))
      .toMatchObject({ meta: "footer", place: "as Builder" });
    expect(home.supervisor.runsOnFact(recordOf(home, taskId))).toEqual({
      label: "Running as Builder",
      source: "task",
    });
    // Started, it finishes there.
    expect(askRunsOn(home, taskId, "this-mac")).toBe(
      `${recordOf(home, taskId).key} "footer" has started, so it finishes where it started, as Builder.`,
    );

    // The project's next task, with nothing said, starts here as before.
    seedTask(home.tasks, { id: "t-here", title: "header", status: "queued", repoId: repo.id });
    expect(home.supervisor.runsOnFact(recordOf(home, "t-here"))).toEqual({
      label: "This computer",
      source: "project",
    });
    await home.supervisor.dispatchQueuedTask("t-here");
    expect(home.tasks.get("t-here")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-here")?.gate?.reason).toBe(STARTED_HERE);
  });

  it("waits by its own name for the computer the captain named, stays when its project moves, and runs here once reset", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    seedTask(home.tasks, { id: "t-own", title: "footer", status: "queued", repoId: repo.id });
    seedTask(home.tasks, { id: "t-follows", title: "header", status: "queued", repoId: repo.id });

    expect(askRunsOn(home, "t-own", at.deviceId)).toBe("Runs on: Running as Builder (This task)");
    // The record keeps it, and the feed shows it as it shows a policy edit.
    expect(home.tasks.timeline("t-own").at(-1)).toMatchObject({
      actor: "firstmate",
      text: "updated: Runs on: Running as Builder (This task)",
      feed: true,
    });

    // Out of reach, it waits as queued work, and the feed names the task.
    await home.supervisor.dispatchQueuedTask("t-own");
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(home.tasks.get("t-own")).toMatchObject({ status: "open", deviceId: at.deviceId });
    const waits = () => feed(home).filter((line) => line.includes('"footer"'));
    expect(waits()).toEqual([
      '"footer" waits for Builder. It never runs on this computer instead.',
    ]);
    expect(await home.supervisor.startQueuedNow("t-own")).toBe(
      `${recordOf(home, "t-own").key} "footer" waits for Builder, which is out of reach. It never runs on this computer instead.`,
    );
    ahead += 24 * 60 * 60 * 1000;
    await home.supervisor.dispatchQueuedTask("t-own");
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(waits().slice(1)).toEqual([
      'Running as Builder has been out of reach for a day. "footer" still waits.',
      'To run it here instead, ask your first mate to run "footer" on this computer.',
    ]);

    // The project moves there and back: the captain's word stands, and the
    // task he said nothing about follows its project.
    home.repos.setRunsOn(repo.id, at.deviceId);
    expect(home.tasks.get("t-follows")?.deviceId).toBe(at.deviceId);
    home.repos.setRunsOn(repo.id, null);
    expect(home.tasks.get("t-follows")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-own")?.deviceId).toBe(at.deviceId);

    // project: it follows its project again, which runs here, and starts here.
    expect(askRunsOn(home, "t-own", null)).toBe("Runs on: This computer (Project setting)");
    expect(home.tasks.get("t-own")?.shape?.runs_on_ask).toBeUndefined();
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(home.tasks.get("t-own")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-own")?.gate?.reason).toBe(STARTED_HERE);
  });

  it("keeps a task on this Mac when the captain says so while its project runs on the computer", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, { id: "t-stays", title: "footer", status: "queued", repoId: repo.id });
    expect(home.supervisor.runsOnFact(recordOf(home, "t-stays"))).toEqual({
      label: "Running as Builder",
      source: "project",
    });
    expect(askRunsOn(home, "t-stays", "this-mac")).toBe("Runs on: This computer (This task)");
    await home.supervisor.dispatchQueuedTask("t-stays");
    expect(home.tasks.get("t-stays")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-stays")?.gate?.reason).toBe(STARTED_HERE);
  });

  // Intent: INF-409's goal - a Runs on changed while a start waits on a
  // computer starts the task where it now runs, routed among that place's
  // own subscriptions, never with a route chosen for the computer it left.
  it("routes among this Mac's subscriptions and starts here when the captain runs it here while it waited for that computer's (INF-409)", async () => {
    // This Mac serves the starter map's medium Codex model, which routing
    // takes here; that computer's Codex account serves GPT-6 Sol alone.
    const at = await world(undefined, {
      routing: THIS_MAC_ON_NEWER_CODEX,
      signedInTo: [computerAccount("acct_codex_there", "openai-codex")],
      served: [
        {
          accountId: "acct_codex_there",
          models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
        },
      ],
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-moved",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    const held = holdNext(home.placed, "served");
    const starting = home.supervisor.dispatchQueuedTask("t-moved");
    await held.reached;
    expect(askRunsOn(home, "t-moved", "this-mac")).toBe("Runs on: This computer (This task)");
    held.release();
    await starting;
    expect(home.decisions.latestRouting("t-moved")).toMatchObject({
      provider: "openai-codex",
      model: CODEX_MEDIUM_STARTER,
    });
    expect(home.tasks.get("t-moved")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-moved")?.gate?.reason).toBe(STARTED_HERE);
    // Nothing was tried there.
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("is never held for that computer's GitHub sign-in once the captain runs it here while that computer's sign-ins were read (INF-409)", async () => {
    // That computer offers a GitHub sign-in from here and has none yet.
    const forges: ComputerForges = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      forges: () => forges,
    });
    const home = at.home();
    const project = await gitProject();
    await git(project.home, ["remote", "set-url", "origin", "https://github.com/octo/website.git"]);
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-github",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    const held = holdNext(home.placed, "signInsOf");
    const starting = home.supervisor.dispatchQueuedTask("t-github");
    await held.reached;
    expect(askRunsOn(home, "t-github", "this-mac")).toBe("Runs on: This computer (This task)");
    held.release();
    await starting;
    // Tried here, never held behind that computer's own GitHub sign-in
    // (whose wait its project, still set to run there, says by itself).
    expect(home.tasks.get("t-github")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-github")?.gate?.reason).toBe(STARTED_HERE);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("gives each part its parent's Runs on unless the part has its own", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const queued = { status: "queued", repoId: repo.id, startPolicy: "on-request" } as const;
    seedTask(home.tasks, { id: "t-parent", title: "site", ...queued });
    seedTask(home.tasks, { id: "t-part", title: "footer", parentId: "t-parent", ...queued });
    seedTask(home.tasks, { id: "t-own-part", title: "header", parentId: "t-parent", ...queued });

    expect(askRunsOn(home, "t-own-part", "this-mac")).toBe("Runs on: This computer (This task)");
    expect(askRunsOn(home, "t-parent", at.deviceId)).toBe(
      "Runs on: Running as Builder (This task)",
    );
    expect(home.tasks.get("t-part")?.deviceId).toBe(at.deviceId);
    expect(home.tasks.get("t-own-part")?.deviceId ?? null).toBeNull();
    expect(home.supervisor.runsOnFact(recordOf(home, "t-part"))).toEqual({
      label: "Running as Builder",
      source: "parent",
    });
    expect(home.supervisor.runsOnFact(recordOf(home, "t-own-part"))).toEqual({
      label: "This computer",
      source: "task",
    });

    // A part commissioned under it later waits for the same computer.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const { taskId, crewmate } = await home.supervisor.commission({
      title: "nav",
      intent: { goal: "Fix the nav.", userWords: "fix the nav" },
      repoId: repo.id,
      parent: "t-parent",
    });
    expect(crewmate).toBe("queued");
    expect(home.tasks.get(taskId)?.deviceId).toBe(at.deviceId);
  });

  it("forgets the captain's word for a computer being removed, so the task and its parts follow the project", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const queued = { status: "queued", repoId: repo.id, startPolicy: "on-request" } as const;
    seedTask(home.tasks, { id: "t-parent", title: "site", ...queued });
    seedTask(home.tasks, { id: "t-part", title: "footer", parentId: "t-parent", ...queued });
    askRunsOn(home, "t-parent", at.deviceId);
    expect(home.tasks.get("t-part")?.deviceId).toBe(at.deviceId);

    await home.supervisor.stopTasksOn(at.deviceId);
    expect(home.tasks.get("t-parent")?.shape?.runs_on_ask).toBeUndefined();
    expect(home.tasks.get("t-parent")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-part")?.deviceId ?? null).toBeNull();
    expect(home.tasks.timeline("t-parent").at(-1)?.text).toBe(
      "Runs on: the computer it named was removed, so it runs where its parent or project says",
    );
  });

  it("keeps the captain's word on where a task runs through Start again and a stronger-model retry", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const own = { kind: "fix", runs_on_ask: at.deviceId } as const;

    seedTask(home.tasks, {
      id: "t-dropped",
      title: "footer",
      status: "cancelled",
      repoId: repo.id,
      shape: own,
    });
    const again = home.supervisor.startAgain("t-dropped");
    if (!again.ok) throw new Error(again.text);
    expect(again.task.shape?.runs_on_ask).toBe(at.deviceId);
    expect(await again.started).toContain("waits for Builder, which is out of reach");
    expect(home.tasks.get(again.task.id)).toMatchObject({ status: "open", deviceId: at.deviceId });

    seedTask(home.tasks, {
      id: "t-tried",
      title: "header",
      status: "completed",
      outcome: "Made the header blue.",
      repoId: repo.id,
      shape: own,
    });
    const retry = await home.supervisor.commission({
      title: "header",
      intent: { goal: "Make the header blue.", userWords: "not good enough, try a stronger one" },
      shape: { escalate_from: "t-tried" },
    });
    expect(retry.crewmate).toBe("queued");
    expect(home.tasks.get(retry.taskId)).toMatchObject({
      repoId: repo.id,
      deviceId: at.deviceId,
      shape: expect.objectContaining({ runs_on_ask: at.deviceId }),
    });
  });

  it("refuses in plain words a started task, the personal workspace, a project kept here, a review, a task with no project and a computer that runs no work", async () => {
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const { repo: notes } = await home.repos.setup({ kind: "init", name: "notes" });
    const personal = home.repos.ensurePersonal(scratchDir("infinitary-placed-personal-"));
    const refusal = (id: string, ask: string | null = at.deviceId) =>
      home.supervisor.runsOnRefusal(id, ask)?.replace(recordOf(home, id).key, "KEY");

    seedTask(home.tasks, { id: "t-going", title: "footer", status: "running", repoId: repo.id });
    expect(refusal("t-going")).toBe(
      'KEY "footer" has started, so it finishes where it started, on this computer.',
    );
    expect(refusal("t-going", null)).toBe(
      'KEY "footer" has started, so it finishes where it started, on this computer.',
    );
    seedTask(home.tasks, { id: "t-panel", title: "panel", status: "queued", repoId: personal.id });
    expect(refusal("t-panel")).toBe(
      'KEY "panel" builds in your personal workspace, which stays on this computer.',
    );
    seedTask(home.tasks, { id: "t-notes", title: "notes", status: "queued", repoId: notes.id });
    expect(refusal("t-notes")).toBe(
      'KEY "notes" is in notes. Kept on this computer only, so its tasks run here.',
    );
    seedTask(home.tasks, {
      id: "t-review",
      title: "review",
      status: "queued",
      repoId: repo.id,
      shape: { kind: "review" },
    });
    expect(refusal("t-review")).toBe(
      'KEY "review" is a review and follows its builder\'s computer; its location cannot be chosen separately.',
    );
    seedTask(home.tasks, { id: "t-loose", title: "loose", status: "queued" });
    expect(refusal("t-loose")).toBeUndefined();
    expect(refusal("t-loose", "a-mac-that-only-controls")).toBe(
      "No computer that runs work has that deviceId. Look with app_state.",
    );
    seedTask(home.tasks, { id: "t-fine", title: "fine", status: "queued", repoId: repo.id });
    expect(refusal("t-fine", "a-mac-that-only-controls")).toBe(
      "No computer that runs work has that deviceId. Look with app_state.",
    );
    expect(refusal("t-fine")).toBeUndefined();
    expect(refusal("t-fine", "this-mac")).toBeUndefined();
    expect(refusal("t-fine", null)).toBeUndefined();

    // Asked at the spawn, a refusal starts nothing.
    const before = home.tasks.list().length;
    await expect(
      home.supervisor.commission({
        title: "notes",
        intent: { goal: "Tidy the notes.", userWords: "tidy the notes on the mini" },
        repoId: notes.id,
        shape: { runs_on_ask: at.deviceId },
      }),
    ).rejects.toThrow(
      'Nothing was spawned. "notes" is in notes. Kept on this computer only, so its tasks run here.',
    );
    await expect(
      home.supervisor.commission({
        title: "review",
        intent: { goal: "Review the footer.", userWords: "review the footer on the mini" },
        repoId: repo.id,
        shape: { review_of: "t-going", runs_on_ask: at.deviceId },
      }),
    ).rejects.toThrow(
      "Nothing was spawned. A review follows its builder's computer; omit runs_on_ask.",
    );
    expect(home.tasks.list()).toHaveLength(before);
  });
});

/**
 * What a computer that runs work holds for a task this Mac no longer
 * records there (docs/helper.md, "Leftovers"): it goes by the rule this
 * Mac's own leftover working copies follow - its unmerged work here first,
 * on the task's kept ref in the project it was cloned from, then its
 * working copy and folder there - and stays there only while its work has
 * nowhere to go here.
 */
describe("leftovers on a computer that runs work", () => {
  it("removes the working copy and folder a fresh start left there when it failed after the copy was made", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    at.refuseOpens(true);

    // That computer made the working copy, then refused the conversation:
    // the start failed, and this Mac kept no record of it.
    await expect(
      home.supervisor.commission({
        title: "footer",
        intent: { goal: "Make the footer blue.", userWords: "make the footer blue" },
        repoId: repo.id,
      }),
    ).rejects.toThrow(`no sign-in for ${PROVIDER} here`);
    expect(home.tasks.list()).toEqual([]);
    expect(feed(home)).toContain("Mac mini cloned home.");

    // What it left there goes at once, without waiting for that computer to come back.
    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("brings a purged task's unmerged work home onto its kept ref in the project it was cloned from, then removes its working copy and folder there", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-purged", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-purged")?.activity).toBe("idle");
    const work = at.folders("t-purged").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    writeFileSync(join(work, "notes.txt"), "still thinking\n");

    await home.supervisor.purgeAllTasks();
    expect(home.tasks.get("t-purged")).toBeUndefined();

    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-purged")]);
    expect(await git(project.home, ["show", `${kept}:notes.txt`])).toBe("still thinking");
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    // Its work came home whole, so nothing was said.
    expect(feed(home).filter((line) => line.includes("leftover"))).toEqual([]);
  });

  it("keeps a leftover working copy there while its work has nowhere to go here, says so once, and brings it home once its project is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([{ text: "Started on the footer." }]);
    await at.start("t-stays", "Make the footer blue.", repo.id);
    await expect.poll(() => home.tasks.get("t-stays")?.activity).toBe("idle");
    const work = at.folders("t-stays").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");

    // Out of reach, the record goes and so does its project here.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.supervisor.purgeAllTasks();
    home.repos.unregister(repo.id);

    // Back: its work has nowhere to go here, so it stays there, said once.
    const said = () => feed(home).filter((line) => line.includes("leftover"));
    await home.listen();
    await expect
      .poll(said)
      .toEqual([
        "Mac mini keeps a leftover working copy, because its work could not be saved on this computer first: fm/task-t-stays.",
      ]);
    expect(at.holds()).toEqual({ tasks: ["t-stays"], workingCopies: ["t-stays"] });
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(tip);

    // Its project is here again: the next time that computer is back, its
    // work comes home and the copy goes, with nothing said twice.
    await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.listen();
    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-stays")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(said()).toHaveLength(1);
  });

  it("removes the working copy a failed start left there once its task is set to run elsewhere, at that computer's next contact", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    at.refuseOpens(true);

    // A queued start there fails after the copy was made: the record waits
    // for the captain, still placed there, and its copy stays for its next start.
    seedTask(home.tasks, { id: "t-moved", title: "footer", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-moved");
    expect(home.tasks.get("t-moved")).toMatchObject({ status: "open", deviceId: at.deviceId });
    expect(at.holds().workingCopies).toEqual(["t-moved"]);

    // Set to run here before it ever ran there: the copy there is no
    // longer its own, and goes the next time that computer is back.
    home.repos.setRunsOn(repo.id, null);
    expect(home.tasks.get("t-moved")?.deviceId ?? null).toBeNull();
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await home.listen();
    await expect.poll(() => at.holds()).toEqual({ tasks: [], workingCopies: [] });
    expect(home.tasks.get("t-moved")?.status).toBe("open");
  });
});

/** The feed's lines, oldest first. */
describe("removing a computer that runs work", () => {
  /** Your devices over this world's home, as createServices composes them. */
  function devicesOf(
    at: Awaited<ReturnType<typeof world>>,
    removeThere?: (device: DeviceView) => Promise<boolean>,
  ) {
    const home = at.home();
    const pushed: DeviceView[][] = [];
    const problems: string[] = [];
    const computers = new Computers({
      pairing: at.pairing(),
      work: home.devices,
      tasks: home.tasks,
      repos: home.repos,
      stopTasks: (deviceId) => home.supervisor.stopTasksOn(deviceId),
      bringHome: (deviceId) => home.placed.bringHome(deviceId),
      ...(removeThere ? { removeThere } : {}),
      emit: (list) => pushed.push(list),
      onProblem: (text) => problems.push(text),
      now,
      bootedAt: () => 0,
    });
    return { computers, pushed, problems };
  }

  /** A project that runs on the computer, with a task working there that holds a commit never merged. */
  async function busyComputer(options: { remoteLogin?: string } = {}) {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), options);
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    model([{ text: "Started." }]);
    await at.start("t-gone", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    const tip = await commit(work, "feat: a footer");
    return { project, at, home, repo, work, tip };
  }

  it("stops its task, brings its unmerged work home, runs its project here, and only then takes it off the list", async () => {
    const { project, at, home, repo, work, tip } = await busyComputer();
    const { computers, pushed } = devicesOf(at);
    expect(computers.list()).toEqual([
      expect.objectContaining({ id: at.deviceId, inReach: true, tasks: 1, runs: ["home"] }),
    ]);

    const gone = await computers.remove(at.deviceId);
    expect(gone).toMatchObject({ id: at.deviceId, runs: ["home"] });
    // Its stages, in order, as Devices draws them.
    const stages = pushed
      .flatMap((list) => list.map((device) => device.removal ?? null))
      .filter((stage, index, all) => stage !== null && stage !== all[index - 1]);
    expect(stages).toEqual(["bringing-work", "cleaning-up"]);
    // The task stopped, and its work came home before the working copy went there.
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();
    expect(at.pairing().list()).toEqual([]);
    expect(computers.list()).toEqual([]);
    // Cut off, it removes what Firstmate set up there, and stops.
    await expect.poll(() => existsSync(join(at.dataDir, "repos"))).toBe(false);
    expect(existsSync(work)).toBe(false);
    expect(existsSync(join(at.dataDir, "home.json"))).toBe(false);
  });

  it("refuses connected removal without falsifying retirement, and retries successfully after work history is repaired", async () => {
    const { project, at, home, work } = await busyComputer();
    const { computers } = devicesOf(at);
    writeFileSync(join(work, "only-copy.txt"), "unique work\n");
    const metadata = readFileSync(join(work, ".git"), "utf8");
    writeFileSync(join(work, ".git"), `gitdir: ${join(at.dataDir, "missing")}\n`);
    await expect(computers.remove(at.deviceId)).rejects.toThrow("It stays on your list");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("present");
    expect(
      home.tasks.timeline("t-gone").some((event) => event.text.includes("saved here first")),
    ).toBe(false);
    expect(
      at
        .pairing()
        .list()
        .map((device) => device.id),
    ).toContain(at.deviceId);
    expect(readFileSync(join(work, "only-copy.txt"), "utf8")).toBe("unique work\n");
    writeFileSync(join(work, ".git"), metadata);
    await computers.remove(at.deviceId);
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(await git(project.home, ["show", `${kept}:only-copy.txt`])).toBe("unique work");
    await expect.poll(() => existsSync(work)).toBe(false);
    expect(at.pairing().list()).toEqual([]);
  });

  it("out of reach, asks first, then waits until it is back and brings its work home before removing it", async () => {
    const { project, at, home, tip } = await busyComputer();
    const { computers } = devicesOf(at);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    expect(computers.list()[0]).toMatchObject({ inReach: false, seenAt: expect.any(Number) });
    await expect(computers.remove(at.deviceId)).rejects.toThrow("out of reach");
    expect(await computers.remove(at.deviceId, "when-back")).toMatchObject({
      removal: "when-back",
    });
    // Keep it takes the wait back, and asking again waits once more.
    expect(computers.keep(at.deviceId).removal).toBeUndefined();
    await computers.remove(at.deviceId, "when-back");
    expect(at.pairing().list()).toHaveLength(1);

    await home.listen();
    await expect.poll(() => at.pairing().list(), { timeout: 8_000 }).toEqual([]);
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    const kept = await git(project.home, ["rev-parse", keptRefFor("t-gone")]);
    expect(
      await git(project.home, ["merge-base", "--is-ancestor", tip, kept]).then(() => true),
    ).toBe(true);
  });

  it("out of reach, removes it now, stops its task here and leaves its unmerged work there", async () => {
    const { at, home, repo, work } = await busyComputer();
    const { computers } = devicesOf(at);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    await computers.remove(at.deviceId, "now");
    expect(at.pairing().list()).toEqual([]);
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    expect(home.tasks.get("t-gone")?.workspaceState).toBe("removed");
    expect(home.tasks.timeline("t-gone").at(-1)?.text).toBe(
      "working copy left on Running as Builder - it was removed while out of reach, so any unmerged work stays there",
    );
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();

    // Back, it learns it was removed: what Firstmate set up goes, its unmerged work stays.
    await home.listen();
    await expect
      .poll(() => existsSync(join(at.dataDir, "home.json")), { timeout: 8_000 })
      .toBe(false);
    await expect.poll(() => existsSync(join(at.dataDir, "tasks"))).toBe(false);
    expect(existsSync(join(work, "footer.html"))).toBe(true);
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("feat: a footer");
  });

  it("out of reach, a Mac added by its address has what Firstmate set up there removed over Remote Login now, keeps its unmerged work there, and stops listening for it", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), {
      remoteLogin: "sam@mini.local",
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    model([{ text: "Started." }]);
    await at.start("t-gone", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-gone")?.activity).toBe("idle");
    const work = at.folders("t-gone").work;
    writeFileSync(join(work, "footer.html"), "<footer></footer>\n");
    await commit(work, "feat: a footer");
    // Nobody is logged in there: its run stops, and it is out of reach.
    await at.stopComputer();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    expect(at.pairing().list()[0]?.remoteLogin).toBe("sam@mini.local");

    // Over Remote Login the home starts the copy kept there as `work remove`.
    const reached: string[] = [];
    const removeThere = async (device: DeviceView) => {
      reached.push(device.remoteLogin ?? "");
      const outcome = await removeFromHome({
        dataDir: at.dataDir,
        background: null,
        backgroundEnv: {},
        expected: { homeKey: at.pairing().identity().pin, deviceId: device.id },
      });
      return outcome.firstmate === "removed";
    };
    const { computers } = devicesOf(at, removeThere);
    await computers.remove(at.deviceId, "now");
    expect(reached).toEqual(["sam@mini.local"]);
    expect(at.pairing().list()).toEqual([]);
    expect(home.tasks.get("t-gone")?.status).toBe("dropped");
    // What Firstmate set up there is gone now; the working copy with its unmerged work stays.
    expect(existsSync(join(at.dataDir, "home.json"))).toBe(false);
    expect(existsSync(join(at.dataDir, "tasks"))).toBe(false);
    expect(await git(work, ["log", "-1", "--format=%s"])).toBe("feat: a footer");
    // Nothing is left there to hear it was removed, so the home listens for nothing.
    expect(at.pairing().any()).toBe(false);
  });
});

function feed(home: PlacedHome): string[] {
  return home.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
}

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.name=Crewmate",
    "-c",
    "user.email=crew@localhost",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** INF-1965: the publication fixtures describe their actual committed, unserved footer file. */
function footerStory(base: string, head: string): ChangePresentationDraft {
  return {
    title: "feat: a blue footer",
    publishable: true,
    base,
    head,
    why: ["The website needs the requested footer."],
    whatChanged: ["Added the blue footer file."],
    before: ["The project contained its README alone."],
    after: ["The committed project includes the footer file."],
    views: [],
    noPicture: "This fixture checks unserved branch content, not a running website.",
    checked: [{ check: "Commit", result: "Git recorded the footer in the task's branch." }],
    verification: ["Committed footer.html in the work computer's working copy."],
    risk: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        { level: "low", why: "Disposable footer content only." },
      ]),
    ) as RiskDeclaration,
    requiredActions: [],
    unfinished: [],
  };
}

/**
 * A project where it lives - a bare repository on disk with one commit on
 * `main` - and the home's own clone of it, named `home`. Its forge is a plain
 * Git host over that origin, sending from `home` unless named another clone,
 * whose workflow evidence answers one artifact.
 */
async function gitProject() {
  const root = scratchDir("infinitary-placed-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = join(root, "seed");
  await git(root, ["clone", "--quiet", origin, seed]);
  writeFileSync(join(seed, "README.md"), "# website\n");
  const main = await commit(seed, "chore: start the website");
  await git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  const home = join(root, "home");
  await git(root, ["clone", "--quiet", origin, home]);
  const forge = (bytes: Buffer, path = home): Forge =>
    Object.assign(
      // A plain Git host: open_change sends the branch up from this Mac's own repository.
      createForgeResolver({
        github: () => {
          throw new Error("This project does not live on GitHub.");
        },
      })({
        path,
        origin: "https://git.example.com/me/website.git",
        host: { kind: "git", name: "git.example.com" },
      }),
      {
        workflows: {
          run: async (id: number) => ({
            id,
            name: "checks",
            headSha: main,
            branch: null,
            attempt: 1,
            status: "completed",
            conclusion: "failure",
            url: "https://git.example.com/runs/41",
          }),
          jobs: async () => ({ jobs: [], total: 0, complete: true }),
          jobLog: async () => {
            throw new Error("No job logs here.");
          },
          download: async (_runId: number, artifactId: number) => ({
            artifact: {
              id: artifactId,
              name: "logs",
              sizeBytes: bytes.length,
              expired: false,
              expiresAt: "2026-11-01T00:00:00Z",
            },
            bytes,
          }),
          archive: async (_runId: number, artifactId: number) => ({
            artifact: {
              id: artifactId,
              name: "logs",
              sizeBytes: bytes.length,
              expired: false,
              expiresAt: "2026-11-01T00:00:00Z",
            },
            archive: {
              size: bytes.length,
              read: async (start: number, end: number) => bytes.subarray(start, end),
            },
          }),
        },
      },
    );
  return { origin, home, main, forge };
}
