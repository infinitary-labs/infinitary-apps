import { appendFileSync, existsSync, rmSync } from "node:fs";
import { homedir, type NetworkInterfaceInfo } from "node:os";
import { dirname, join } from "node:path";
import type { MachineLoginOutcome } from "@shared/accounts";
import type { DeviceGrant } from "@shared/devices";
import { isFileOrderChannel } from "@shared/files";
import { formatDateTime } from "@shared/i18n/format";
import type { WorkInvokeChannel } from "@shared/ipc";
import { LEFT_BEHIND_ORDER, leftBehindOrders } from "@shared/leftoverPrograms";
import { LOAD_ORDER, loadOrders } from "@shared/load";
import { PLACEMENT_FACTS_ORDER } from "@shared/placement";
import { RESOURCE_ORDER, type ResourceMemory, resourceOrders } from "@shared/resources";
import { isSignInOrderChannel } from "@shared/signIns";
import {
  downloadOrders,
  isBrowserOrderChannel,
  type UpdateProgress,
  updateOrders,
  WORK_DOWNLOAD_ORDER,
  WORK_PROGRESS_ORDER,
  WORK_UPDATE_ORDER,
  type WorkDownloadAnswer,
  type WorkUpdateAnswer,
} from "@shared/work";
import type { WebSocket } from "ws";
import { dialHome } from "../devices/dial";
import { HomeLink, type HomeLinkState } from "../devices/homeLink";
import { JoinedHome } from "../devices/joinedHome";
import { FileReach, protectedPlaces } from "../files/fileReach";
import type { MoveDeps } from "../folderMove/move";
import type { HostChildSpawner, HostKeychain } from "../host";
import { hostEnv } from "../hostEnv";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { LoadLine } from "../placed/loadLine";
import { answerPlacementFacts } from "../placed/placementFacts";
import { readProcesses } from "../placed/processResources";
import { ResourceSampler } from "../placed/resourceSampler";
import type { LeftBehindHere } from "../tasks/leftBehind";
import { leftBehindHere } from "../tasks/leftoverPrograms";
import type { ComputerAccounts } from "./accounts";
import {
  type BackgroundContext,
  readAutomaticStartup,
  retireStrays,
  separateMac,
} from "./background";
import { type CleanUpResult, LEFT_CLAUDE_LOGIN } from "./cleanUp";
import type { ComputerBrowserParts, Conversations } from "./conversations";
import { configureComputerGit, holdsForgeSignIn } from "./forges";
import { homePlace } from "./homePlace";
import { homeDialAddress } from "./join";
import { FolderBusyError, folderHolder, lockFolder } from "./lock";
import { PlacedTasks } from "./placedTasks";
import { homeDialOptions } from "./route";
import type { HeldSignIns } from "./signIns";
import { type DownloadedHere, downloadHere, type UpdatedHere, updateHere } from "./update";
import { helperWords, homeLabel } from "./words";

/**
 * What runs work for a home on another Mac, or as another user on the home's
 * own Mac, entire (docs/helper.md): the composition the app's work mode
 * starts. It holds the data folder, dials the home with the grant it joined
 * with, keeps dialing while the home is out of reach, and says each change
 * in plain words. Unlike `createServices` it has no Firstmate, task record,
 * scheduler or sharing: the home keeps all of those. Beside the link it
 * holds the crewmate conversations its home opens here (`SessionHost`,
 * docs/helper.md "Holding a conversation"), loaded once there is one, and
 * this computer's own sign-ins (`SignInHost`, docs/helper.md "Its own
 * sign-ins"), loaded once the home asks about them or there is one. Every
 * git it starts answers a host the app signs in to with this computer's own
 * sign-in there, and never prompts (`configureComputerGit`).
 */

/**
 * How a run ended: `removed` when the home took it off its list, `updated`
 * when the home updated Firstmate here and the background starts it again,
 * `stopped` otherwise.
 */
export type HelperEnded = "removed" | "updated" | "stopped";

export type HelperRun = {
  state: () => HomeLinkState;
  /** Resolves once it stopped, saying how. */
  readonly ended: Promise<HelperEnded>;
  /**
   * Lets every conversation it holds go, stops dialing, lets the folder go,
   * and resolves `ended`; resolves once all of that is done.
   */
  stop: () => Promise<void>;
};

export type StartHelperOptions = {
  source?: import("../selfSource/resolve").SelfSourceReader;
  dataDir: string;
  say: (lines: readonly string[]) => void;
  /** Whether it runs from a packaged app; the dev and test endpoint overrides are read only off one. */
  packaged?: boolean;
  /**
   * The app's own git helper (`resources/git-askpass`), which every child
   * it starts is given to answer a host with this computer's own sign-in.
   * A test that starts no git leaves it out, and the process's git is left
   * as it is.
   */
  gitAskpass?: string;
  /**
   * This Mac's saved passwords, where Claude Code keeps its login: a Claude
   * sign-in looks there for the login already here, and its allowance is
   * read with it, only ever without asking (docs/helper.md, "Its own
   * sign-ins"). Without one, only the login's file is read.
   */
  keychain?: HostKeychain;
  /** This computer's decoder for a card's demo recording; absent, a card naming one is refused here. */
  probeMedia?: MediaProbe;
  /** This computer's loader for a preview's project font; absent, a card naming one is refused here. */
  probeTypeface?: TypefaceProbe;
  /** Host memory observations, independent of accounts and conversations. */
  resourceMemory?: () => Promise<ResourceMemory | null>;
  /**
   * This computer's browser engine and command process, which its tasks'
   * own browsers run on (docs/task-browser.md, "On another computer");
   * absent, it keeps none and its tasks have no browser.
   */
  browser?: Omit<ComputerBrowserParts, "version">;
  /**
   * Starts the process each file the home copies from here is set aside in,
   * so a copy never drops this process's own locks
   * (`FileReachOptions.setAsideProcess`).
   */
  setAsideProcess?: HostChildSpawner;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** The contract version it speaks to the home; this build's own unless a test stands in another. */
  protocolVersion?: string;
  /**
   * The contract changes its hello lists by name; this build's own unless a
   * test stands in a computer from before one (`HomeLinkOptions.changes`).
   */
  changes?: readonly string[];
  /** The version of Firstmate it runs, which its hello tells the home; unsaid when absent. */
  appVersion?: string;
  /**
   * Opens the WebSocket to the home: by default where the grant dials now,
   * read again on every dial (`homeDialOptions`), unless a test stands in
   * its own.
   */
  dial?: (grant: DeviceGrant) => Promise<WebSocket>;
  retryMs?: readonly number[];
  now?: () => number;
  /**
   * Starts the conversations it holds; this computer's own Pi and Claude
   * (`startConversations`) unless a test stands in its own.
   */
  conversations?: (options: {
    dataDir: string;
    load?: LoadLine;
    leftBehind?: LeftBehindHere;
    ask: (channel: WorkInvokeChannel, args: unknown, signal?: AbortSignal) => Promise<unknown>;
    tell: (channel: WorkInvokeChannel, args: unknown) => Promise<unknown>;
    browser?: ComputerBrowserParts;
    accounts: () => Promise<ComputerAccounts>;
    /** This computer's own sign-ins when it keeps or is making any, never loaded for nothing. */
    signedIn: () => Promise<ComputerAccounts> | undefined;
    probeMedia?: MediaProbe;
    probeTypeface?: TypefaceProbe;
    source?: import("../selfSource/resolve").SelfSourceReader;
    homeVersion?: () => string | null;
    homeChanges?: () => readonly string[] | null;
    /** Whether its crewmates' builds and tests stay below the UI: on the home's own Mac (`separateMac`). */
    belowUi: boolean;
  }) => Promise<Conversations>;
  /**
   * Loads this computer's own sign-ins (`startSignIns`) unless a test
   * stands in its own.
   */
  signIns?: (options: {
    dataDir: string;
    packaged: boolean;
    tell: (channel: "inf:work:sign-in" | "inf:work:sign-ins", args: unknown) => Promise<unknown>;
    log: (line: string) => void;
    keychain?: HostKeychain;
  }) => Promise<HeldSignIns>;
  /** Where notes about the work go; the folder's own `work.log` unless a test stands in its own. */
  log?: (line: string) => void;
  /**
   * Removes what Firstmate set up here once the home removed it
   * (`cleanUp`), after every conversation and sign-in let go; nothing is
   * removed when absent.
   */
  cleanUp?: () => Promise<CleanUpResult>;
  /**
   * Brings Firstmate here to the home's version when the home asks
   * (`updateHere`), unless a test stands in its own. `signal` aborts when
   * the run stops part way, which lets the copy go.
   */
  update?: (grant: DeviceGrant, signal: AbortSignal) => Promise<UpdatedHere>;
  /**
   * The program a download here checks its publisher with (`downloadHere`):
   * this Mac's own codesign unless a development run or a test stands in
   * its own.
   */
  verifier?: string;
  /** No byte moving this long stops a download here; two minutes unless a test says. */
  downloadIdleSeconds?: number;
  /**
   * How the one-time move runs here when the home sends an app that keeps
   * its work in another folder (`updateHere`); this computer's own unless a
   * test stands in its own.
   */
  moveDeps?: MoveDeps;
  /**
   * This user's background, which the update moves to another spelling's
   * app the home sends, and whose agent left beside it by a move that
   * stopped partway the run takes away (`retireStrays`); none for a run
   * started where nothing runs it in the background.
   */
  background?: { context: BackgroundContext; env: Readonly<Record<string, string>> } | null;
  /**
   * Signs out a Claude login Firstmate made here, as its record names it
   * (`ClaudeAuthBackend.signOutMadeLogin`): one a join that left a home
   * kept for this run (`LEFT_CLAUDE_LOGIN`) goes before anything else here
   * can use it. Nothing is signed out when absent.
   */
  signOutClaude?: (record: string) => Promise<MachineLoginOutcome>;
};

export type StartHelperOutcome =
  | { ok: true; run: HelperRun }
  | { ok: false; reason: "busy" | "not-joined" };

export function startHelper(options: StartHelperOptions): StartHelperOutcome {
  const { dataDir, say } = options;
  const joinedHome = new JoinedHome(dataDir, () => {});
  if (!joinedHome.read()) {
    say(helperWords.notJoined);
    return { ok: false, reason: "not-joined" };
  }
  let release: () => void;
  try {
    release = lockFolder(dataDir);
  } catch (error) {
    if (!(error instanceof FolderBusyError)) throw error;
    say(helperWords.busy);
    return { ok: false, reason: "busy" };
  }
  // Read again under the lock: a join or a removal may have finished between.
  const joined = joinedHome.read();
  if (!joined) {
    release();
    say(helperWords.notJoined);
    return { ok: false, reason: "not-joined" };
  }
  const log = options.log ?? workLog(dataDir);
  // With the folder held, an agent or copy a move left behind goes.
  if (options.background)
    void retireStrays(options.background.context).catch((error) =>
      log(`could not take away what a move left: ${String(error)}`),
    );
  const place = homePlace(joined.grant, options.interfaces);
  const packaged = options.packaged ?? false;
  let loadOverrides = new Set<string>();
  const loadLine = new LoadLine({
    stateFile: join(dataDir, "load", "holds.json"),
    overridden: (taskId) => loadOverrides.has(taskId),
  });
  // What this computer's finished tasks left (docs/leftover-programs.md,
  // "What a close leaves"), which the home lists and a cleanup look acts on.
  const placedTasks = new PlacedTasks(dataDir);
  const leftBehind = leftBehindHere({
    tasksDir: placedTasks.tasksDir,
    closed: (task) => placedTasks.has(task) && placedTasks.state(task).closed,
    runs: () => loadLine.snapshot().runs,
  });
  const resources = new ResourceSampler({
    memory: options.resourceMemory,
    processes: readProcesses,
    observed: (observation, processes, started, window, cpuWindow) =>
      loadLine.observe(observation, processes, started, window, cpuWindow),
  });
  if (options.gitAskpass) configureComputerGit({ dataDir, askpass: options.gitAskpass, packaged });
  // This computer's own files, as the home reads them for a crewmate on
  // another computer (docs/files.md), with the app's sign-ins and keys
  // refused here and in the app data folder this one sits in.
  const filesHome = hostEnv().HOME ?? homedir();
  const files = new FileReach({
    home: filesHome,
    protectedPlaces: protectedPlaces({
      userData: dirname(dataDir),
      home: filesHome,
      workDir: dataDir,
    }),
    stagingDir: join(dataDir, "file-reach"),
    ...(options.setAsideProcess ? { setAsideProcess: options.setAsideProcess } : {}),
  });
  let name = joined.name;
  let onHomeMac = joined.grant.onHomeMac ?? null;
  let said: HomeLinkState | null = null;
  let finish: (how: HelperEnded) => void = () => {};
  const ended = new Promise<HelperEnded>((resolve) => {
    finish = resolve;
  });
  // Dialing waits on unreferenced timers between attempts; this keeps the
  // process up while the home is out of reach.
  const alive = setInterval(() => {}, 1 << 30);
  let stopped = false;
  // A home on this Mac is dialed at loopback from now on, so a change of
  // this Mac's network address never strands it.
  const grant = { ...joined.grant, at: homeDialAddress(joined.grant.at, options.interfaces) };
  if (grant.at !== joined.grant.at) {
    try {
      joinedHome.dialAt(grant.at);
    } catch (error) {
      log(`could not keep where the home is dialed: ${String(error)}`);
    }
  }
  // A Claude login Firstmate made for a home this user left, which the join
  // kept for this run: signed out here, in this user's login session, before
  // a sign-in or a conversation could use it (docs/helper.md, "Removed").
  const leftLogin = join(dataDir, LEFT_CLAUDE_LOGIN);
  const signOutClaude = options.signOutClaude;
  const leftSignedOut: Promise<void> =
    signOutClaude && existsSync(leftLogin)
      ? signOutClaude(leftLogin)
          .catch((): MachineLoginOutcome => "not-signed-out")
          .then((outcome) => {
            try {
              rmSync(leftLogin, { force: true });
            } catch (error) {
              log(`could not remove ${leftLogin}: ${String(error)}`);
            }
            say(helperWords.claudeLogin(outcome));
          })
      : Promise.resolve();
  // This computer's own sign-ins, loaded with the first order about them or
  // the first conversation: a computer that signs in to nothing never loads
  // a model's code.
  let signIns: Promise<HeldSignIns> | undefined;
  const signingIn = (): Promise<HeldSignIns> => {
    signIns ??= leftSignedOut
      .then(() =>
        (options.signIns ?? (async (start) => (await import("./signIns")).startSignIns(start)))({
          dataDir,
          packaged,
          // Asked once, while the home is in reach: a sign-in is the captain's
          // to answer now, and stops when nobody can.
          tell: (channel, args) => link.invoke(channel, args),
          log,
          ...(options.keychain ? { keychain: options.keychain } : {}),
        }),
      )
      .then((held) => {
        if (link.state().contact === "in-reach") held.host.reached();
        return held;
      });
    return signIns;
  };
  // The conversations the home opened here, loaded with the first one: a
  // computer never given work never loads a model's code.
  let conversations: Promise<Conversations> | undefined;
  const holding = (): Promise<Conversations> => {
    conversations ??= leftSignedOut
      .then(() =>
        (
          options.conversations ??
          (async (start) => (await import("./conversations")).startConversations(start))
        )({
          dataDir,
          load: loadLine,
          leftBehind,
          ask: (channel, args, signal) => link.ask(channel, args, signal),
          // A browser's fact and pictures go once, while the home is in reach.
          tell: (channel, args) => link.invoke(channel, args),
          ...(options.browser
            ? { browser: { ...options.browser, version: options.appVersion ?? "0.0.0" } }
            : {}),
          accounts: async () => (await signingIn()).accounts,
          signedIn: () => signIns?.then((held) => held.accounts),
          ...(options.probeMedia ? { probeMedia: options.probeMedia } : {}),
          ...(options.source ? { source: options.source } : {}),
          ...(options.probeTypeface ? { probeTypeface: options.probeTypeface } : {}),
          // The contract its home said in its welcome, which decides whether it keeps project fonts.
          homeVersion: () => link.state().homeVersion,
          // The changes its home listed, which decide whether a report hands files on.
          homeChanges: () => link.state().homeChanges,
          belowUi: !separateMac(dataDir, options.interfaces),
        }),
      )
      .then((held) => {
        if (link.state().contact === "in-reach") held.host.reached();
        return held;
      });
    return conversations;
  };
  let ending: Promise<void> | undefined;
  const end = (how: HelperEnded): Promise<void> => {
    if (ending) return ending;
    stopped = true;
    clearInterval(alive);
    loadLine.dispose();
    downloading?.abort();
    stopUpdating.abort();
    // Every conversation lets go and writes what it holds, and a download or
    // update stopped part way takes what it fetched away, before the link
    // and the folder go.
    const letGo = Promise.all([
      leftSignedOut,
      fetching,
      updating?.catch(() => undefined),
      conversations?.then((held) => held.close()).catch(() => undefined),
      signIns?.then((held) => held.close()).catch(() => undefined),
      files.close().catch(() => undefined),
    ]);
    ending = letGo
      .then(async () => {
        link.close();
        if (how !== "removed" || !options.cleanUp) return;
        try {
          const { kept, unreadable, unremoved, claude } = await options.cleanUp();
          say(helperWords.cleanedUp(kept, unreadable, unremoved, claude ? { claude } : {}));
        } catch (error) {
          log(`could not remove what was set up here: ${String(error)}`);
        }
      })
      .then(async () => {
        release();
        // What an update that moved or rewrote the background leaves for last.
        if (how === "updated" && afterUpdate)
          await afterUpdate().catch((error) =>
            log(`could not finish what the update left for last: ${String(error)}`),
          );
        finish(how);
      });
    return ending;
  };

  // Updated by its home (docs/helper.md, "Updated by its home"): the home's
  // Firstmate is kept here first, then the answer goes, then this run ends
  // so the background starts it again from what is kept. One order at a
  // time; one that failed changed nothing, and the home may ask again.
  let updating: Promise<UpdatedHere> | undefined;
  const stopUpdating = new AbortController();
  let afterUpdate: (() => Promise<void>) | undefined;
  const update = async (args: unknown): Promise<WorkUpdateAnswer> => {
    updateOrders[WORK_UPDATE_ORDER].request.parse(args);
    // A download running here is waited for, as a home that could not look
    // its version up asks this order: one that kept its copy updated this
    // computer, and answers the same; one that ended with nothing changed
    // lets this update go on.
    while (downloading) await fetching;
    if (downloaded) return downloaded;
    // A run that stopped while that download ran starts no update.
    if (stopped) throw new Error("This computer is stopping.");
    progress = { received: 0, state: "updating" };
    updating ??= (
      options.update ??
      ((grant) =>
        updateHere({
          dataDir,
          grant,
          now: options.now,
          // The contract its home said in its welcome, which decides whether it is told this system.
          homeProtocol: link.state().homeVersion,
          background: options.background ?? null,
          ...(options.moveDeps ? { moveDeps: options.moveDeps } : {}),
          log,
          signal: stopUpdating.signal,
        }))
    )(joined.grant, stopUpdating.signal);
    let answer: WorkUpdateAnswer;
    try {
      const { afterRun, ...answered } = await updating;
      answer = answered;
      afterUpdate = afterRun;
    } catch (error) {
      updating = undefined;
      progress = { received: 0, state: "idle" };
      log(`could not update Infinitary here: ${String(error)}`);
      throw error;
    }
    say(helperWords.updated(place, name, answer.restarts));
    // The answer is written before the connection closes.
    setImmediate(() => void end("updated"));
    return answer;
  };

  // Downloaded by itself (docs/helper.md, "Updated by its home"): the home
  // names where its version is published, and this Mac gets and checks it
  // itself, saying how far it got to the home's progress order. One that
  // could not answers `fallback` with nothing changed, and the home sends
  // its own copy with the update order. A home gone out of reach does not
  // stop it: it follows it by its progress once it is back. One asked while
  // an update runs answers that it is updating already.
  let progress: UpdateProgress = { received: 0, state: "idle" };
  let downloading: AbortController | undefined;
  let fetching: Promise<unknown> = Promise.resolve();
  let downloaded: WorkUpdateAnswer | undefined;
  const download = async (args: unknown): Promise<WorkDownloadAnswer> => {
    const [published] = downloadOrders[WORK_DOWNLOAD_ORDER].request.parse(args);
    if (updating || downloading) return { updating: true };
    const stopping = new AbortController();
    downloading = stopping;
    progress = { received: 0, state: "downloading" };
    let got: DownloadedHere;
    try {
      const getting = downloadHere({
        dataDir,
        grant: joined.grant,
        now: options.now,
        homeProtocol: link.state().homeVersion,
        background: options.background ?? null,
        ...(options.moveDeps ? { moveDeps: options.moveDeps } : {}),
        log,
        download: published,
        signal: stopping.signal,
        onProgress: (count) => {
          progress = count;
        },
        ...(options.verifier ? { verifier: options.verifier } : {}),
        ...(options.downloadIdleSeconds ? { idleSeconds: options.downloadIdleSeconds } : {}),
      });
      fetching = getting.catch(() => undefined);
      got = await getting;
    } catch (error) {
      progress = { received: 0, state: "idle" };
      log(`could not update Infinitary here: ${String(error)}`);
      throw error;
    } finally {
      downloading = undefined;
    }
    if ("fallback" in got) {
      progress = {
        received: got.received,
        ...(got.total ? { total: got.total } : {}),
        state: got.fallback,
      };
      return got;
    }
    const { afterRun, ...answer } = got;
    afterUpdate = afterRun;
    updating = Promise.resolve(got);
    downloaded = { restarts: answer.restarts };
    say(helperWords.updated(place, name, answer.restarts));
    setImmediate(() => void end("updated"));
    return answer;
  };

  const automaticStartup = readAutomaticStartup(dataDir);
  const link: HomeLink = new HomeLink({
    grant,
    // A Mac that also controls its home says this connection is its work.
    as: "work",
    ...(automaticStartup ? { automaticStartup } : {}),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.changes ? { changes: options.changes } : {}),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    // A home that reaches this computer through its own SSH connection is
    // dialed at the route its connection keeps now, never at the grant's
    // address; with no route the dial fails, and the link keeps trying.
    dial:
      options.dial ?? ((grant) => dialHome(grant, homeDialOptions(dataDir, grant, options.now))),
    ...(options.retryMs ? { retryMs: options.retryMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    // A computer that runs work is sent no pushes.
    onPush: () => {},
    // Each welcome, the home may have restarted - within the link's grace,
    // with no change of contact here - so what it has not kept goes again,
    // and it hears this computer's sign-ins whole.
    onCaughtUp: () => {
      void conversations?.then((held) => held.host.reached());
      void signIns?.then((held) => held.host.reached());
    },
    // What the home asks: the orders about the conversations it holds here,
    // its own sign-ins, and an update.
    onInvoke: async (channel, args) => {
      if (stopped) throw new Error("This computer is stopping.");
      if (channel === WORK_UPDATE_ORDER) return update(args);
      if (channel === WORK_DOWNLOAD_ORDER) return download(args);
      if (channel === WORK_PROGRESS_ORDER) {
        downloadOrders[WORK_PROGRESS_ORDER].request.parse(args);
        return progress;
      }
      if (channel === PLACEMENT_FACTS_ORDER) {
        return answerPlacementFacts(args, dataDir, () =>
          signingIn().then((held) => held.host.list()),
        );
      }
      if (channel === LOAD_ORDER) {
        const [request] = loadOrders[LOAD_ORDER].request.parse(args);
        loadOverrides = new Set(request.overrides);
        loadLine.reconsider();
        return loadLine.snapshot();
      }
      if (channel === LEFT_BEHIND_ORDER) {
        leftBehindOrders[LEFT_BEHIND_ORDER].request.parse(args);
        return leftBehind.list();
      }
      if (channel === RESOURCE_ORDER) {
        resourceOrders[RESOURCE_ORDER].request.parse(args);
        return resources.read();
      }
      if (isSignInOrderChannel(channel)) return (await signingIn()).host.answer(channel, args);
      if (isFileOrderChannel(channel)) return files.answer(channel, args);
      if (isBrowserOrderChannel(channel)) {
        const held = await holding();
        if (!held.browsers) throw new Error("This computer keeps no task browsers.");
        return held.browsers.answer(channel, args);
      }
      return (await holding()).host.answer(channel, args);
    },
    onState: (state) => {
      if (state.name && state.name !== name) {
        name = state.name;
        joinedHome.name(state.name);
      }
      // Where the home says this computer runs, kept on the grant for the
      // next time its agent is set up and its run starts.
      if (state.onHomeMac !== null && state.onHomeMac !== onHomeMac) {
        onHomeMac = state.onHomeMac;
        try {
          joinedHome.onHomeMac(state.onHomeMac);
        } catch (error) {
          log(`could not keep where the home says this computer runs: ${String(error)}`);
        }
      }
      if (state.removed) {
        // Noted as not finished until the removal says what it could not remove.
        joinedHome.leave(
          { name: homeLabel(place, name), reason: "removed", at: (options.now ?? Date.now)() },
          options.cleanUp ? [] : undefined,
        );
        say(helperWords.removed(place, name));
        void end("removed");
        return;
      }
      const before = said;
      said = state;
      // Nobody can answer a sign-in running here now, or watch a browser.
      if (state.contact !== "in-reach" && before?.contact === "in-reach") {
        void signIns?.then((held) => held.host.dropped());
        void conversations?.then((held) => held.browsers?.dropped()).catch(() => undefined);
      }
      if (state.contact !== before?.contact) {
        if (state.contact === "in-reach") say(helperWords.inReach(place, name));
        else if (state.contact === "lost") say(helperWords.outOfReach(place, name));
        else if (state.contact === "closed") say(helperWords.quit(place, name));
      }
      if (state.takesWork === false && before?.takesWork !== false)
        say(helperWords.noNewWork(place, name));
    },
  });
  // A conversation left on disk by an earlier run still has things to tell the home.
  if (placedTasks.list().length > 0) void holding().catch(() => undefined);
  // A sign-in kept here has an allowance to read, or a short-lived sign-in
  // where projects live to keep renewed, and the home to tell.
  if (existsSync(join(dataDir, "accounts", "registry.json")) || holdsForgeSignIn(dataDir))
    void signingIn().catch((error: unknown) =>
      log(`this computer's sign-ins did not load: ${String(error)}`),
    );
  link.start();
  return {
    ok: true,
    run: { state: () => link.state(), ended, stop: () => end("stopped") },
  };
}

/**
 * A removal an earlier run could not finish (docs/helper.md, "Removed"): its
 * home let it go, so this run finishes it instead of dialing, and says what
 * is still left. Null when no removal waits here, `busy` while another
 * process holds the folder.
 */
export async function finishRemoval(options: {
  dataDir: string;
  say: (lines: readonly string[]) => void;
  cleanUp: () => Promise<CleanUpResult>;
}): Promise<CleanUpResult | "busy" | null> {
  const { dataDir, say } = options;
  const joinedHome = new JoinedHome(dataDir, () => {});
  if (joinedHome.read() || !joinedHome.unfinished()) return null;
  let release: () => void;
  try {
    release = lockFolder(dataDir);
  } catch (error) {
    if (!(error instanceof FolderBusyError)) throw error;
    say(helperWords.busy);
    return "busy";
  }
  try {
    // Read again under the lock: another run may have finished it, or a join begun.
    if (joinedHome.read() || !joinedHome.unfinished()) return null;
    const result = await options.cleanUp();
    say(
      helperWords.cleanedUp(
        result.kept,
        result.unreadable,
        result.unremoved,
        result.claude ? { claude: result.claude } : {},
      ),
    );
    return result;
  } finally {
    release();
  }
}

/** What this user has joined, in words, without dialing or taking the folder. */
export function helperStatus(
  dataDir: string,
  options: {
    interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
    formatTime?: (ms: number) => string;
  } = {},
): readonly string[] {
  const joinedHome = new JoinedHome(dataDir, () => {});
  const joined = joinedHome.read();
  if (!joined) {
    const left = joinedHome.left();
    return left
      ? leftWords(dataDir, left.name, joinedHome.unfinished(), left.reason)
      : helperWords.notJoined;
  }
  const format = options.formatTime ?? ((ms: number) => formatDateTime(ms));
  return helperWords.status(
    homePlace(joined.grant, options.interfaces),
    joined.name,
    joined.grant.at,
    format(joined.joinedAt),
    folderHolder(dataDir) !== null,
  );
}

/**
 * What a removal left, in words: the Claude login Firstmate made here, which
 * the note keeps beside the paths for the work's own run, said as that and
 * never as a path.
 */
function leftWords(
  dataDir: string,
  name: string,
  unfinished: readonly string[] | null,
  reason: Parameters<typeof helperWords.left>[2],
): readonly string[] {
  const record = join(dataDir, LEFT_CLAUDE_LOGIN);
  const paths = unfinished?.filter((path) => path !== record) ?? null;
  return helperWords.left(name, paths, reason, paths?.length !== unfinished?.length);
}

/** Notes about the work, kept in the folder's own log; Terminal never shows them. */
export function workLog(dataDir: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(join(dataDir, "work.log"), `${new Date().toISOString()} ${line}\n`, {
        mode: 0o600,
      });
    } catch {
      // A note that cannot be kept is not the work's failure.
    }
  };
}
