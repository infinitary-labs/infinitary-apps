import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, resolve } from "node:path";
import type { AccountView } from "@shared/accounts";
import {
  deviceForgeGateRef,
  deviceForgeSignInCardId,
  deviceForgeWaitLine,
  noSignInsWaitLine,
} from "@shared/deviceSetup";
import type { DeviceView } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import type { ComputerForges } from "@shared/signIns";
import { type PlacedSpec, placedTaskFolders, workOrders } from "@shared/work";
import {
  afterAll,
  afterEach,
  beforeAll,
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
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import { type PlacedHome, startPlacedHome } from "../../../tests/helpers/placedHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import type { ContractWorld } from "../../../tests/helpers/sessionContract";
import { moveWorkFolder, olderWorkFolder } from "../../../tests/helpers/workFolderMove";
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
import { CREWMATE_INTEGRATIONS_LINE } from "../integrations";
import { JobManager } from "../jobs/jobManager";
import { createCrewmateTranscriptResolver } from "../observe/transcriptSource";
import { crewmateRenewedNote, crewmateRestartText } from "../orchestrator/crewSession";
import { crewmateCardPicturesDir, crewmatePlacedDir, crewmateSessionsDir } from "../paths";
import type { AccountVault } from "../pi/accountVault";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import { crewmateComputerNote } from "../pi/piResources";
import { createPiSessionFactory } from "../pi/sessionFactory";
import type { ModelRuntime } from "../pi/types";
import { Router } from "../routing/router";
import type { CrewmateTool } from "../session/tools";
import { forkChildProcess } from "../sql/forkChildProcess";
import { SettingsStore } from "../storage/settingsStore";
import { CrewTranscripts } from "../tasks/crewTranscript";
import { seedTask } from "../tasks/seedTask";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { git } from "../workspace/git";
import { ProjectChanges } from "../workspace/projectChanges";
import { keptRefFor } from "../workspace/workspaceService";
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

/** The model, one step per request from now on; past the last step it answers "Done." */
function model(steps: Step[]): void {
  const first = api.requests.length;
  api.answer((request: StubRequest, res: ServerResponse) => {
    const step = steps[request.n - first - 1] ?? { text: "Done." };
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
    "routing" | "runsForAnotherFirstmate" | "github"
  > & {
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
     */
    jobs?: boolean;
    /** The contract the computer's hello names; this build's own unless a test stands in an older one. */
    protocolVersion?: string;
    /** The contract changes the computer's hello lists; this build's own unless a test stands in an older one. */
    changes?: readonly string[];
    tools?: readonly CrewmateTool[];
    /** The home's github.com sign-in, whose integrations its crew there reaches through its task channel. */
    github?: Parameters<typeof startPlacedHome>[0]["github"];
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
      ...(options.changes ? { changes: options.changes } : {}),
      ...(options.signedInTo
        ? { signIns: signedInTo(options.signedInTo, options.forges, options.served) }
        : {}),
      // Removed, it removes what Firstmate set up here; no agent was set up.
      cleanUp: () => cleanUp({ dataDir, background: null }),
      conversations: async ({ dataDir: dir, ask, tell }) => {
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
  await inReach();
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
     * port, after `whileStopped` runs on what it left.
     */
    restartHome: async (whileStopped?: () => void | Promise<void>) => {
      await home.quit();
      pairing?.dispose();
      pairing = undefined;
      await whileStopped?.();
      home = startHome(userData, port, pairingNow, forgeFor, options);
      await home.listen();
    },
    /**
     * The computer's own process quits, and starts again from the same
     * folder; updated, with the crewmate tools its new version binds.
     */
    restartComputer: async (updated?: {
      tools?: readonly CrewmateTool[];
      protocolVersion?: string;
    }) => {
      if (updated?.protocolVersion) protocolVersion = updated.protocolVersion;
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
    expect(JSON.stringify(brief?.body.system)).toContain(crewmateComputerNote("Mac mini"));
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

  // INF-367: a computer's restart reports each background job it cut off
  // once to its task, so an idle crewmate never waits for an exit that
  // cannot arrive.
  it("tells a crewmate waiting on a background job, as its next turn and once, that its computer's restart stopped the job (INF-367)", async () => {
    const at = await world(undefined, { jobs: true });
    const waiting = "The suite runs as a background job; I will pick up its result.";
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
      { text: "Running the suite again." },
    ]);
    const requests = api.requests.length;
    await at.start("t-job");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe(waiting);
    const job = /background job ([0-9a-f]{8})/.exec(said(api.requests[requests + 1]))?.[1];
    expect(job).toBeDefined();

    // The computer restarts while the crewmate waits: the job ends with that run.
    await at.restartComputer();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe("Running the suite again.");
    const heard = said(api.requests.at(-1));
    expect(heard).toContain(`background job ${job} did not finish`);
    expect(heard).toContain(JSON.stringify('"sleep 600" was stopped').slice(1, -1));
    expect(api.requests.length - requests).toBe(3);
    // Once: nothing is left there to tell again, and its lane is empty.
    expect(existsSync(join(at.folders("t-job").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-job")).toEqual([]);
    await at.restartComputer();
    await at.inReach("t-job");
    expect(api.requests.length - requests).toBe(3);
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
    const at = await world(() =>
      Object.assign(project.forge(Buffer.alloc(0)), {
        changeFor: async () => null,
        attachments: {
          destination: async () => ({
            host: "github.com",
            projectId: 1,
            fullName: "octo/website",
            visibility: "private" as const,
          }),
          upload,
        },
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
    const artifact = Buffer.from("the failing test's log\n");
    const at = await world(() => project.forge(artifact));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([
      { text: "Started on the footer." },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", body: "Intent" } }] },
      { tools: [{ name: "download_artifact", args: { runId: 41, artifactId: 9 } }] },
      { text: "Opened, and read the artifact." },
    ]);
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
    await home.supervisor.steerCrewmate("t-copy", "Open the change.");
    // The brief's turn, then this one: open_change, download_artifact, its answer.
    await expect.poll(() => api.requests.length - requests).toBe(4);
    await expect.poll(() => home.tasks.get("t-copy")?.activity).toBe("idle");

    // open_change ran here: the branch came home over the connection, and
    // this Mac sent it up to where the project lives.
    expect(await git(project.home, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(await git(project.origin, ["rev-parse", "refs/heads/fm/task-t-copy"])).toBe(tip);
    expect(said(api.requests.at(-2))).toContain("Opened the pushed branch fm/task-t-copy");
    // download_artifact downloaded here and wrote the file there, never here.
    const written = join(work, ".infinitary-artifacts", "run-41", "artifact-9.zip");
    expect(readFileSync(written).equals(artifact)).toBe(true);
    expect(said(api.requests.at(-1))).toContain(
      createHash("sha256").update(artifact).digest("hex"),
    );
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
    model([
      { text: "Started on the footer." },
      { tools: [{ name: "open_change", args: { title: "feat: a blue footer", body: "Intent" } }] },
      { text: "Opened." },
    ]);
    await at.start("t-moved", "Make the footer blue.", repo.id);
    await expect.poll(() => at.home().tasks.get("t-moved")?.activity).toBe("idle");
    const work = at.folders("t-moved").work;
    writeFileSync(join(work, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commit(work, "feat: a blue footer");
    // INF-125 adds an explicit proof prerequisite; INF-97 still owns the real moved-folder/git boundary below.
    at.home().tasks.recordDelivery("t-moved", {
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
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-moved", "Open the change.");
    // This turn: open_change, then its answer.
    await expect.poll(() => api.requests.length - requests).toBe(2);
    await expect.poll(() => home.tasks.get("t-moved")?.activity).toBe("idle");

    expect(said(api.requests.at(-1))).toContain("Opened the pushed branch fm/task-t-moved");
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
          shellCommand(`infinitary-integrations-axi call GitHub write '${JSON.stringify(issue)}'`),
        ],
      },
      { text: "The issue waits for the captain." },
    ]);
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
    expect(write.output).toContain("Not sent");
    const kept = home.tasks.get("t-reach")?.delivery?.writeAsks?.[0];
    expect(write.output).toContain(`Kept as ask ${kept?.id}`);
    expect(home.tasks.get("t-reach")?.delivery?.writeAsks).toEqual([
      expect.objectContaining({ method: "POST", path: issue.path, via: "account" }),
    ]);
    expect(github.seen).toHaveLength(1);
    // The call is kept by its id, so one asked again after a drop is answered once.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-reach"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { channel: string }).channel);
    expect(calls.filter((channel) => channel === "inf:work:use-integration")).toHaveLength(2);

    // Nothing of the sign-in is on that computer, while the answer it read is in its record there.
    expect(filesHolding(at.dataDir, GITHUB_TOKEN)).toEqual([]);
    expect(filesHolding(at.dataDir, "The Octocat")).toContainEqual(
      expect.stringMatching(/^tasks\/t-reach\/sessions\//),
    );
  });

  it("gives a crewmate on a computer without the change neither the command nor its line", async () => {
    const github = await standInGitHub();
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      github: { apiBaseUrl: github.base, token: GITHUB_TOKEN, login: "octo" },
      changes: CONTRACT_CHANGES.names.filter((name) => name !== "integrations-there"),
    });
    model([
      { tools: [shellCommand("infinitary-integrations-axi")] },
      { text: "No integrations here." },
    ]);
    const requests = api.requests.length;
    await at.start("t-older");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-older")?.outcome).toBe("No integrations here.");
    expect(systemOf(api.requests[requests])).not.toContain(CREWMATE_INTEGRATIONS_LINE);
    expect(shellAnswer(api.requests[requests + 1]).exit).toBe(127);
    expect(github.seen).toEqual([]);
  });
});

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
  const text =
    typeof result === "string"
      ? result
      : Array.isArray(result)
        ? (result as { text?: string }[]).map((block) => block.text ?? "").join("")
        : "";
  const [first = "", ...rest] = text.split("\n");
  return { exit: Number(/^exit (\d+)$/.exec(first)?.[1] ?? Number.NaN), output: rest.join("\n") };
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
        },
      },
    );
  return { origin, home, main, forge };
}
