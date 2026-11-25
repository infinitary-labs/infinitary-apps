import { appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkInvokeChannel } from "@shared/ipc";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { PlacedSpec } from "@shared/work";
import {
  accessFlagSettings,
  readClaudeAccess,
  resolvePlacedClaudePolicyFixture,
} from "../claude/claudeAccess";
import { claudeReportingDeps } from "../claude/claudeCostPolicy";
import { defaultClaudeConfigDir } from "../claude/claudeQuota";
import { createClaudeSessionFactory } from "../claude/session";
import { protectedPlaces } from "../files/fileReach";
import { ForgeSignInStore } from "../forge";
import { captureLoginPath, hostEnv } from "../hostEnv";
import { JobManager } from "../jobs/jobManager";
import { Ticker } from "../orchestrator/ticker";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { createPiSessionFactory } from "../pi/sessionFactory";
import { heldAgainst, sensedLeftOf, spentAllowanceHold } from "../quota/spentAllowance";
import type { SessionBinding } from "../session/session";
import { placedLeftovers } from "../tasks/leftoverPrograms";
import type { ComputerAccounts } from "./accounts";
import { ComputerBrowsers, type ComputerBrowsersOptions } from "./browsers";
import { computerForgesDir, computerKnownHosts } from "./forges";
import { PersonalCopy } from "./personalCopy";
import { PlacedTasks } from "./placedTasks";
import { type OwnAccounts, SessionHost } from "./sessionHost";
import { PLACED_TOOL_WAIT_MS } from "./toolWait";
import { WorkingCopies } from "./workingCopies";

/**
 * The conversations a computer that runs work holds, composed with this
 * computer's own parts (docs/helper.md, "Holding a conversation"): Pi with
 * an agent folder of its own, Claude on this macOS user's own client and
 * login, a crewmate's shell whose long commands are background jobs here,
 * and the working copies they run in (docs/helper.md, "Its working
 * copies"). The helper loads this only once a home asks for work, or when a
 * conversation from an earlier run is still on disk, so a computer that is
 * never given work never loads a model's code.
 */

/** The Claude client's environment for a conversation held here. */
export const PLACED_CLAUDE_ENV = { MCP_TOOL_TIMEOUT: String(PLACED_TOOL_WAIT_MS) } as const;

/** Why a Pi conversation cannot open here: this computer has no sign-in of its own for it. */
export function noSignInHere(provider: string | undefined): string {
  return `This computer has no sign-in of its own for ${provider ?? "that subscription"} yet.`;
}

/**
 * What a Claude binding here names when this computer holds no Claude
 * account of its own: this user's login, which the client holds, and no
 * account at all - never the home's.
 */
export const CLAUDE_LOGIN_HERE = "claude";

/**
 * The binding a home described, with this computer's own sign-ins and never
 * the home's (docs/helper.md, "Its own sign-ins"): Claude on this user's
 * login, which the client holds, named as this computer's own Claude account
 * when it has one - the one the home named when it is this computer's, else
 * the one preferred here, else the first one on - and a Pi binding on one of
 * this computer's own accounts for that provider, chosen the same way among
 * those that can serve. A Pi binding with none is refused; a Claude one runs
 * on the login with no account (`CLAUDE_LOGIN_HERE`).
 */
export async function bindHere(
  binding: PlacedSpec["binding"],
  accounts?: Pick<ComputerAccounts, "vault"> & Partial<Pick<ComputerAccounts, "allowance">>,
): Promise<SessionBinding> {
  if (binding.backend === "claude") {
    const vault = accounts?.vault;
    const claude = (accountId: string) => {
      const account = vault?.get(accountId);
      return account?.enabled === true && account.providerId === CLAUDE_PROVIDER_ID;
    };
    const pinned = vault?.pinnedAccount(CLAUDE_PROVIDER_ID);
    const own =
      (binding.accountId && claude(binding.accountId) ? binding.accountId : undefined) ??
      (pinned && claude(pinned) ? pinned : undefined) ??
      vault?.list(CLAUDE_PROVIDER_ID).find((account) => claude(account.id))?.id;
    return { backend: "claude", accountId: own ?? CLAUDE_LOGIN_HERE };
  }
  const vault = accounts?.vault;
  const serving = (accountId: string) => {
    const account = vault?.get(accountId);
    return (
      account?.enabled === true &&
      vault?.backendIdOf(accountId) === "pi" &&
      vault.connectedSync(accountId) !== false &&
      (binding.provider === undefined || account.providerId === binding.provider)
    );
  };
  const named = binding.accountId && serving(binding.accountId) ? binding.accountId : undefined;
  const provider = binding.provider ?? (named ? vault?.get(named)?.providerId : undefined);
  const pinned = provider ? vault?.pinnedAccount(provider) : undefined;
  const own =
    named ??
    (pinned && serving(pinned) ? pinned : undefined) ??
    (provider ? vault?.list(provider).find((account) => serving(account.id))?.id : undefined);
  if (!vault || !own) throw new Error(noSignInHere(binding.provider));
  return { backend: "pi", accountId: own, runtime: await vault.runtimeFor(own) };
}

/**
 * What a conversation's facts belong to here (`SessionHostOptions.accounts`,
 * docs/helper.md "Its own sign-ins"): the account of this computer's own its
 * binding names - none for Claude on the login alone (`CLAUDE_LOGIN_HERE`) -
 * and that account's own store, where a typed cut-off a turn met is recorded.
 */
export function ownAccounts(
  accounts: () => Promise<
    (Pick<ComputerAccounts, "vault"> & Partial<Pick<ComputerAccounts, "allowance">>) | undefined
  >,
  log: (line: string) => void,
): OwnAccounts {
  return {
    of: (binding) =>
      binding.backend === "claude" && binding.accountId === CLAUDE_LOGIN_HERE
        ? undefined
        : binding.accountId,
    noteCutOff: (accountId, cutOff) => {
      void accounts()
        .then((loaded) => {
          if (!loaded) return;
          // A spent allowance with no reset of its own (xAI's 402) takes the
          // limiting window of this computer's latest reading of the account;
          // either kind keeps what that reading showed, which lays no refusal
          // over it here.
          const reading = loaded.allowance?.();
          const spent = heldAgainst(
            cutOff,
            loaded.vault.get(accountId)?.providerId,
            reading,
            accountId,
            Date.now(),
          );
          const held = spentAllowanceHold(cutOff, spent, sensedLeftOf(reading, accountId));
          loaded.vault.noteCutOff(accountId, held.cutOff, held.seen);
        })
        .catch((error: unknown) =>
          log(`a cut-off on ${accountId} was not recorded: ${messageOf(error)}`),
        );
    },
  };
}

export type Conversations = {
  host: SessionHost;
  /** This computer's task browsers, where it has a browser engine (docs/task-browser.md, "On another computer"). */
  browsers?: ComputerBrowsers;
  close: () => Promise<void>;
};

/**
 * What a computer keeps its tasks' browsers with: its browser engine, the
 * process a command runs in, the launcher's folder and the app's version.
 * The rest is the conversations' own.
 */
export type ComputerBrowserParts = Pick<
  ComputerBrowsersOptions,
  "host" | "spawner" | "binDir" | "version" | "lookup"
>;

export async function startConversations(options: {
  source?: import("../selfSource/resolve").SelfSourceReader;
  dataDir: string;
  /** A disposable policy payload, supplied only by unpackaged work helpers. */
  placedClaudePolicy?: string;
  load?: import("../placed/loadLine").LoadLine;
  /** What this computer's finished tasks left, which a cleanup look acts on (docs/leftover-programs.md). */
  leftBehind?: import("../tasks/leftBehind").LeftBehindHere;
  ask: (channel: WorkInvokeChannel, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Asks the home once, while it is in reach, and never again; a task browser's fact and pictures ride it. */
  tell?: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
  /** This computer's browser engine and command process; absent, it keeps no task browsers. */
  browser?: ComputerBrowserParts;
  /** This computer's own sign-ins, which a Pi conversation binds to. */
  accounts?: () => Promise<ComputerAccounts>;
  /**
   * Those sign-ins when this computer keeps or is making any, without loading
   * them: a Claude conversation runs on this user's login either way, and
   * names its Claude account only when there is one.
   */
  signedIn?: () => Promise<ComputerAccounts> | undefined;
  /** This computer's decoder for a card's demo recording (src/main/mediaProbe.ts). */
  probeMedia?: MediaProbe;
  /** This computer's loader for a preview's project font (src/main/mediaProbe.ts). */
  probeTypeface?: TypefaceProbe;
  /** The contract the home said in its welcome, while it is known. */
  homeVersion?: () => string | null;
  /** The contract changes its home listed, while known (`handover-files.md`). */
  homeChanges?: () => readonly string[] | null;
  /**
   * Whether a crewmate's builds and tests here stay below the UI: on the
   * home's own Mac, whose window draws the character (`separateMac`).
   */
  belowUi: boolean;
  log?: (line: string) => void;
}): Promise<Conversations> {
  // The person's search path for the crewmate's shell and the Claude client.
  await captureLoginPath();
  // Terminal shows only what the helper says; notes about the conversations
  // go to the folder's own log.
  const log =
    options.log ??
    ((line: string) => {
      try {
        appendFileSync(join(options.dataDir, "work.log"), `${new Date().toISOString()} ${line}\n`, {
          mode: 0o600,
        });
      } catch {
        // A note that cannot be kept is not the work's failure.
      }
    });
  // This computer's one clock: a rolling Claude conversation's record copy
  // and client hygiene ride its ticks, as on the home.
  const ticker = new Ticker();
  ticker.start();
  // Its clones and pushes answer where a project lives with this
  // computer's own sign-in there, when it has one (`configureComputerGit`).
  const copies = new WorkingCopies(options.dataDir, {
    signedInTo: (host) =>
      new ForgeSignInStore(computerForgesDir(options.dataDir)).hosts().includes(host),
    knownHosts: () => computerKnownHosts(options.dataDir),
  });
  copies.sweep();
  const tasks = new PlacedTasks(options.dataDir, copies.worktreesDir);
  let host: SessionHost | undefined;
  const jobs = new JobManager({
    // Each job's row in its task's folder, so the next start can tell the
    // home of a job this run's end cuts off (`SessionHost`).
    rows: tasks.jobRows,
    onChange: () => host?.jobsChanged(),
    onExit: (exit) => host?.jobExit(exit),
    now: ticker.now,
    // Below the UI on the home's own Mac, where its window draws the
    // character; on a separate Mac, at the run's own priority.
    belowUi: options.belowUi,
  });
  // Each task's own browser, here beside its shell (docs/task-browser.md,
  // "On another computer"); with no channel, no crewmate here has one.
  const parts = options.browser;
  const tell = options.tell;
  const browsers =
    parts && tell
      ? await ComputerBrowsers.open({
          ...parts,
          keysDir: join(options.dataDir, "task-channel"),
          // The signed-in sites this computer keeps for this home (docs/task-browser.md, "Signed-in sites").
          signInsDir: join(options.dataDir, "web-sign-ins"),
          ...(options.load ? { load: options.load } : {}),
          ...(options.leftBehind ? { leftBehind: options.leftBehind } : {}),
          evidenceDir: (task) => tasks.folders(task).evidence,
          taskFolder: (task) => tasks.folders(task).root,
          heldTasks: () => tasks.list().filter((task) => !tasks.state(task).closed),
          workingCopy: (task) => tasks.folders(task).work,
          // A command that reached this computer keeps its shell waiting for its answer.
          answering: (shell) => jobs.answering(shell),
          tell,
          ask: options.ask,
          log: (line) => log(`browser: ${line}`),
          ...(options.homeChanges ? { homeChanges: options.homeChanges } : {}),
        }).catch((error: unknown) => {
          log(`no task channel, so no crewmate here has a browser: ${messageOf(error)}`);
          return undefined;
        })
      : undefined;
  // The private copies a Secrets use binds here, in this app's own folder:
  // those an earlier run of this app left go before any use binds again.
  const secretRunsDir = join(options.dataDir, "secret-runs");
  await rm(secretRunsDir, { recursive: true, force: true }).catch((error: unknown) =>
    log(`could not remove the Secrets runs an earlier start left: ${messageOf(error)}`),
  );
  host = new SessionHost({
    tasks,
    copies,
    secretRunsDir,
    personal: new PersonalCopy(join(options.dataDir, "personal")),
    ...(options.source ? { source: options.source } : {}),
    ask: options.ask,
    factories: {
      pi: createPiSessionFactory({
        agentDir: join(options.dataDir, "pi-agent"),
        runBash: (input) => jobs.run(input),
        speedCapabilities: async (accountId, id) => {
          const accounts = await options.signedIn?.();
          return accountId ? accounts?.speedCapabilities?.(accountId, id) : undefined;
        },
      }),
      claude: createClaudeSessionFactory({
        configDir: defaultClaudeConfigDir(),
        clock: ticker,
        env: () => hostEnv(PLACED_CLAUDE_ENV),
        onServed: (accountId) => {
          const loaded = options.signedIn?.();
          if (!loaded) return;
          void loaded
            .then((accounts) => accounts?.vault.noteAccepted(accountId))
            .catch((error: unknown) =>
              log(`a served login on ${accountId} was not recorded: ${messageOf(error)}`),
            );
        },
        log: (line) => log(`claude: ${line}`),
        accessSettings: async () => accessFlagSettings(await readClaudeAccess()),
        ...(options.placedClaudePolicy
          ? { resolveWorkSettings: resolvePlacedClaudePolicyFixture(options.placedClaudePolicy) }
          : {}),
        ...claudeReportingDeps(),
      }),
    },
    bind: async (binding) =>
      bindHere(
        binding,
        binding.backend === "pi" ? await options.accounts?.() : await options.signedIn?.(),
      ),
    // Bound to an account of its own, a conversation's sign-ins are loaded.
    accounts: ownAccounts(async () => options.signedIn?.(), log),
    runningJobCount: (task) => jobs.runningJobCount(task),
    oldestRunningJob: (task) => jobs.oldestRunningJob(task),
    killJobs: (task) => jobs.killForOwner(task),
    // The app's own sign-ins and keys here, which a card's files never copy.
    protectedPlaces: protectedPlaces({
      userData: dirname(options.dataDir),
      home: hostEnv().HOME ?? homedir(),
      workDir: options.dataDir,
    }),
    ...(options.probeMedia ? { probeMedia: options.probeMedia } : {}),
    ...(options.probeTypeface ? { probeTypeface: options.probeTypeface } : {}),
    ...(options.homeVersion ? { homeVersion: options.homeVersion } : {}),
    ...(options.homeChanges ? { homeChanges: options.homeChanges } : {}),
    ...(browsers
      ? {
          commands: {
            grant: (task, tools) => browsers.grant(task, tools),
            close: (task) => browsers.close(task),
          },
        }
      : {}),
    claudeConfigDir: () => defaultClaudeConfigDir(),
    // What a closed task left running here stops before its folders go
    // (docs/leftover-programs.md, "On a computer that runs work").
    leftovers: placedLeftovers(tasks),
    ...(options.leftBehind ? { closing: options.leftBehind.sweep.bind(options.leftBehind) } : {}),
    log,
  });
  const held = host;
  return {
    host: held,
    ...(browsers ? { browsers } : {}),
    close: async () => {
      await held.close();
      // Every browser goes with this computer's run, and every key with it.
      browsers?.closeAll();
      jobs.disposeAll();
      ticker.stop();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
