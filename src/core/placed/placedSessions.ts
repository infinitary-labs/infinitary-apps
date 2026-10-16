import {
  appendFileSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { standingCutOff } from "@shared/accounts";
import type { CutOffClass } from "@shared/authFailure";
import { COMPUTER, HERE } from "@shared/deviceNames";
import type { FmEvent } from "@shared/events";
import {
  type InvokeRequest,
  type InvokeResponse,
  speaksInfinitaryNames,
  speaksKnowledge,
  speaksSeed,
  speaksTempCleanup,
  type WorkInvokeChannel,
} from "@shared/ipc";
import { catalogEntry } from "@shared/providers";
import type { ComputerSignIns, signInPlace } from "@shared/signIns";
import {
  type PlacedEventRecord,
  type PlacedRosterTask,
  type PlacedSpec,
  type PlacedState,
  placedSpecSchema,
  placedTaskFolders,
  type WorkingCopyBase,
  type WorkOrderChannel,
  type WorkOrderResponse,
  workOrders,
} from "@shared/work";
import { z } from "zod";
import type { WorkDeviceContact } from "../connection/connection";
import type { JobExit } from "../jobs/jobManager";
import { crewmateResumeToken } from "../orchestrator/crewSession";
import {
  type AppPaths,
  crewmateCardPicturesDir,
  crewmatePlacedDir,
  crewmateSessionsDir,
} from "../paths";
import { CREWMATE_BROWSER_LINE, crewmateBrowserLine } from "../pi/piResources";
import type { QuotaCatalogModel } from "../quota/auth";
import { type ComputerPool, computerPool, heldThere } from "../routing/computerPool";
import type {
  ControlProfile,
  ModelSession,
  SessionBackend,
  SessionFactories,
  SessionFactory,
  SessionSpec,
} from "../session/session";
import { CardRefusedError, type DeclaredCardInput } from "../session/tools";
import type { TaskRecord } from "../storage/taskStore";
import { TaskService } from "../tasks/taskService";
import type { DependencyInstall } from "../workspace/workspaceService";
import { PlacedCopies, type PlacedCopy } from "./placedCopies";
import { PlacedSession } from "./placedSession";
import { NO_PLACED_TASK, type PlacedWork } from "./placedWork";
import { sendSourceFile } from "./sourceFiles";
import type { WorkDevices } from "./workDevices";

/**
 * The home's side of a crewmate's conversation held on a computer that runs
 * work (docs/helper.md, "Holding a conversation"; src/shared/work.ts).
 *
 * - **Factories.** One `SessionFactory` per backend for each such computer
 *   (`factories(deviceId)`), presenting the backend it runs there, so no
 *   third backend exists. Each opens a `PlacedSession`: the conversation
 *   runs there, with the crewmate's tools, and this Mac drives it by orders.
 * - **Work requests.** What the computer asks about a task it holds for this
 *   home (`answer`): each tool callback is done here exactly as for a
 *   crewmate of this Mac, by the callbacks its session was opened with, and
 *   its answer is kept in `crewmates/<task>/placed/calls.jsonl` before it is
 *   returned, so a callback asked again after a drop is answered from there.
 *   The numbered events are taken in order once each, and the newest the
 *   home keeps for good is saved in `crewmates/<task>/placed/state.json` at
 *   every model turn's end. A request about a task this Mac does not record
 *   on that computer is refused.
 * - **Lost contact.** A task's computer out of reach, or back and not yet
 *   caught up, holds the task (`ready`): its lane waits and nothing calls it
 *   stuck. Once back, the computer's roster is read: a turn it runs that
 *   this Mac does not follow - after a restart here - is adopted, a closed
 *   record's conversation is closed there, and orders it could not be asked
 *   go now under their own ids. The feed says when a computer has been out
 *   of reach for a minute and when its work caught up.
 *
 * Nothing here reaches a computer before the shell attaches the connection
 * (`WorkDevices`).
 */

/** How long a computer with work is out of reach before the feed says so. */
export const OUT_OF_REACH_LINE_MS = 60_000;

/** What the supervisor does for the placed tasks (`CrewSupervisor`). */
export type PlacedHost = {
  /**
   * Opens the task's conversation on this Mac when no crewmate here holds it
   * - a restart left it, or its computer asks first - and resolves once it
   * is open.
   */
  adopt(taskId: string): Promise<void>;
  /** These tasks' computer is in reach and caught up: their lanes go on, and a waiting start may start. */
  caughtUp(taskIds: readonly string[]): void;
  /** A background job the crewmate's shell started there ended. */
  jobExit(taskId: string, exit: JobExit): void;
};

/** What the crew reads of the computers that run work (`CrewSupervisorOptions.machines`). */
export type CrewMachines = {
  /** The factories that open a conversation there; undefined when no computer can. */
  factories(machine: string): SessionFactories | undefined;
  /** The task's folders there, by the layout its roster named; undefined until it is read. */
  folders(machine: string, taskId: string): ReturnType<typeof placedTaskFolders> | undefined;
  /**
   * That computer keeps its tasks' own browsers, as its roster says
   * (docs/task-browser.md, "On another computer"); false until it is read.
   */
  keepsBrowsers?(machine: string): boolean;
  /** The task's computer is in reach and caught up, so its lane may go on. */
  ready(machine: string, taskId: string): boolean;
  /**
   * The task's working copy there, made now or found as it was: its
   * project cloned there once, then a working copy on the task's branch
   * (docs/helper.md, "Its working copies").
   */
  prepare(
    machine: string,
    taskId: string,
    repoId: string | null,
    base?: WorkingCopyBase,
  ): Promise<PlacedCopy>;
  /** Copy a source file to the task folder, returning its verified path there. */
  sourceFile?(machine: string, taskId: string, name: string, file: string): Promise<string>;
  /** Carry a home ref into the destination repository before naming it in the brief. */
  sourceRef?(
    machine: string,
    taskId: string,
    repoId: string | null,
    sourceId: string,
    ref: string,
  ): Promise<string>;
  /** A committed revision and its changed-file list, read on that computer. */
  revision(
    machine: string,
    taskId: string,
    headSha?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">>;
  /**
   * Whether the computer takes a task with no project (`speaksSeed`); absent
   * where the home cannot tell.
   */
  takesRepoless?(machine: string): boolean;
  /**
   * Whether the computer gives its crewmates the home's knowledge
   * (`speaksKnowledge`, docs/knowledge.md "Who has it"); false while the
   * home cannot tell.
   */
  takesKnowledge?(machine: string): boolean;
  /** The working copy's dependencies, installed there; a failure is an outcome. */
  install(machine: string, taskId: string): Promise<DependencyInstall>;
  /** What the task's working copy there holds unmerged; null while nobody can tell. */
  workStatus(taskId: string): Promise<{ dirty: boolean; unlandedCommits: number } | null>;
  /** The task's branch, brought here from there before this Mac's own git reads it. */
  bringBranchHome(taskId: string, strict?: boolean): Promise<void>;
  /** The computers that run work on the list, by device id. */
  computers(): readonly string[];
  /** The computer's name, as Devices lists it. */
  nameOf(machine: string): string;
  /** How the home's words place the computer (`signInPlace`): "Mac mini", "Running as Builder". */
  placeOf(machine: string): ReturnType<typeof signInPlace>;
  /**
   * What the computer's own sign-ins serve, as it last said of them: the
   * models a task that runs there is routed among, and the account there
   * for each provider (docs/helper.md, "Its own sign-ins"). Never this
   * Mac's sign-ins.
   */
  served(machine: string): Promise<ComputerPool>;
  /**
   * What the computer last said of its own sign-ins, asked now when it has
   * said nothing yet and is in reach; null when it cannot say. A task about
   * to start there reads whether it has any sign-in at all, and one for the
   * host its project lives on, before anything is tried there.
   */
  signInsOf(machine: string): Promise<ComputerSignIns | null>;
  /**
   * The computer's own account a conversation held there is bound to, as
   * that computer last said (`PlacedState.accountId`): the one its usage is
   * booked on. Never one of this Mac's accounts; undefined when it named none.
   */
  servingAccount(session: ModelSession): string | undefined;
  /**
   * The same account for a task, keyed as the cut-off contract names an
   * account (`<account>@<computer>`, never one of this Mac's ids): from its
   * open conversation, else the computer's roster. Undefined when it names
   * none, or nothing has said yet.
   */
  accountOf(machine: string, taskId: string): string | undefined;
  /**
   * The cut-off that computer last said stands on an account `accountOf`
   * keyed (docs/helper.md, "Its own sign-ins"); undefined for none, and for
   * a key of this Mac's own.
   */
  cutOffOf(account: string): { class: CutOffClass; since: number; resetsAt?: number } | undefined;
  /**
   * Whether that computer has said anything of its sign-ins since this Mac
   * started, so a cut-off on the account is known to stand or to be over;
   * true for a key of this Mac's own.
   */
  knows(account: string): boolean;
  /** The account's provider and where it is ("on Mac mini"), for a key `accountOf` made. */
  accountPlace(account: string): { provider: string; where: string } | undefined;
  /**
   * The computer's own sign-in a cut-off alone keeps from serving a task
   * there, as it last said, when nothing else there serves: a task for it
   * waits until it serves again. Undefined when something there serves,
   * nothing would, or it has said nothing yet.
   */
  signInWait(
    machine: string,
  ): { account: string; provider: string; class: CutOffClass; resetsAt?: number } | undefined;
};

export type PlacedSessionsOptions = {
  tasks: TaskService;
  paths: AppPaths;
  devices: WorkDevices;
  /** Each backend's control plane on this Mac, which it presents from there. */
  profiles: { pi: ControlProfile; claude?: ControlProfile };
  /** A paired computer's name, as Devices lists it. */
  deviceName: (deviceId: string) => string | undefined;
  /** The computers that run work on the list, by device id; absent, none. */
  computers?: () => readonly string[];
  /** How the home's words place a paired computer (`devicePlace`); absent, by its name alone. */
  devicePlace?: (deviceId: string) => ReturnType<typeof signInPlace>;
  /** A project's name, by its id. */
  projectName: (repoId: string) => string | undefined;
  /**
   * The home's repository for a task's work: its project's, or this Mac's
   * own local workspace for a task with none. A placed task's branch and
   * kept work are brought into it (`PlacedCopies`).
   */
  homeRepo?: (repoId: string | null) => Promise<string | undefined>;
  /** Every project's id, to find the one a leftover working copy there was cloned from. */
  projects?: () => readonly string[];
  /**
   * What a computer last said of its own sign-ins (`DeviceSignIns`), asked
   * when it has said nothing yet; absent, it is known to serve nothing.
   */
  signIns?: (deviceId: string) => Promise<ComputerSignIns | null>;
  /**
   * The same, read now without asking (`DeviceSignIns.lastSaid`): a cut-off
   * it names on the account a task there is bound to holds that task.
   * Absent, nothing there ever holds one.
   */
  saidSignIns?: (deviceId: string) => ComputerSignIns | null;
  /**
   * Asks a computer its sign-ins again and resolves once it answered or
   * could not (`DeviceSignIns.refresh`): before a turn there that met a
   * cut-off ends here, so the turn ends held.
   */
  refreshSignIns?: (deviceId: string) => Promise<void>;
  /** Every model this Mac's catalog lists, provider-wide, which needs no sign-in here. */
  catalogModels?: () => readonly QuotaCatalogModel[];
  /**
   * Whether Firstmate on a computer runs work for another Firstmate now, as
   * this Mac's own SSH connection to it found (`runsForAnotherFirstmate`):
   * its work never catches up here, and removing it here stops that work.
   * Absent, none does.
   */
  runsForAnotherFirstmate?: (deviceId: string) => boolean;
  /**
   * Where what a task's browser on a computer tells this Mac goes
   * (docs/task-browser.md, "On another computer"): its fact, its pictures
   * and what it has this Mac do once. Read when it arrives, since the
   * browsers are composed after the conversations; absent, nothing there
   * is heard.
   */
  browsers?: () => PlacedBrowserSink | undefined;
  /**
   * A computer went out of reach, or came back and caught up: whether its
   * tasks wait on it moved, which their Tasks rows say (`TaskView.place`).
   */
  reachMoved?: () => void;
  broadcastEvent: (event: FmEvent) => void;
  now: () => number;
  log?: (line: string) => void;
};

/** What a task's browser on a computer tells this Mac, by the computer that asked. */
export type PlacedBrowserSink = {
  heardFact: (
    deviceId: string,
    task: string,
    fact: InvokeRequest<"inf:work:browser">[0]["fact"],
  ) => void;
  heardFrame: (task: string, frame: InvokeRequest<"inf:work:browser-frame">[0]["frame"]) => void;
  heardEvent: (
    deviceId: string,
    task: string,
    event: InvokeRequest<"inf:work:browser-event">[0]["event"],
  ) => void;
};

/** A conversation not open on this Mac, or a computer not caught up: asked again, never kept. */
class NotHeldHere extends Error {}

type Roster = {
  tasksDir: string;
  /** Where its working copies are; absent from a computer that keeps none. */
  worktreesDir?: string;
  tasks: Map<string, PlacedRosterTask>;
  /** It keeps its tasks' own browsers (docs/task-browser.md, "On another computer"). */
  browsers: boolean;
};

type Device = {
  readonly id: string;
  /** Read once each time it comes into reach. */
  roster: Roster | undefined;
  /** Each contact counts, so a roster from an earlier one is let go. */
  contact: number;
  /** Since when it has been out of reach, or since this Mac started without it. */
  goneSince: number;
  /** The feed said it went, so it says when its work caught up. */
  saidGone: boolean;
  /** Resolves once this contact's roster is read: what it asks first waits for it. */
  rostered: Promise<void>;
  rosterRead: () => void;
};

type CallLine = {
  callId: string;
  channel: string;
  /** The newest event the home had taken in when it answered. */
  after: number;
  answer?: unknown;
  error?: string;
  /** A report's words, which a restart here gives its turn again. */
  report?: { text: string; summary?: string; declared?: unknown };
};

type Placed = {
  readonly task: string;
  readonly deviceId: string;
  /** The newest event taken in. */
  through: number;
  /** The newest event kept for good, at a model turn's end. */
  kept: number;
  /** The newest turn's end kept. */
  ended: number;
  session: PlacedSession | undefined;
  /** The conversation is being opened on this Mac for an ask that came first. */
  adopting: Promise<void> | undefined;
  ledger: Map<string, CallLine> | undefined;
  calling: Map<string, Promise<unknown>>;
  /** One events request at a time, in order. */
  chain: Promise<unknown>;
  /** Reports answered since the last kept turn's end, given again to an adopting turn. */
  replays: CallLine[];
  /** It was caught up the last time the lane was let go. */
  released: boolean;
  /** Close was asked of the computer, and answered. */
  closed: boolean;
  /** The record's copy, one at a time. */
  copying: Promise<void>;
  /** Where this Mac keeps the copy: its open session's record folder. */
  recordDir: string;
  /** What its session was opened with, to open it there again after that computer restarts. */
  spec: PlacedSpec | undefined;
};

const keptStateSchema = z.object({
  kept: z.number().int().nonnegative(),
  ended: z.number().int().nonnegative(),
});

const callLineSchema = z.object({
  callId: z.string(),
  channel: z.string(),
  after: z.number().int().nonnegative(),
  answer: z.unknown().optional(),
  error: z.string().optional(),
  report: z
    .object({ text: z.string(), summary: z.string().optional(), declared: z.unknown().optional() })
    .optional(),
});

const rosterSchema = workOrders["inf:session:roster"].response;
const openAnswerSchema = workOrders["inf:session:open"].response;

export class PlacedSessions implements PlacedWork, CrewMachines {
  /** The tasks' working copies on those computers (docs/helper.md, "Its working copies"). */
  readonly copies: PlacedCopies;
  private readonly devices = new Map<string, Device>();
  private readonly placed = new Map<string, Placed>();
  private host: PlacedHost | undefined;
  private readonly startedAt: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: PlacedSessionsOptions) {
    this.startedAt = options.now();
    this.log = options.log ?? ((line) => console.warn(`[placed] ${line}`));
    this.copies = new PlacedCopies({
      tasks: options.tasks,
      devices: options.devices,
      paths: options.paths,
      homeRepo: options.homeRepo ?? (async () => undefined),
      projects: options.projects ?? (() => []),
      deviceName: (deviceId) => this.nameOf(deviceId),
      projectName: options.projectName,
      broadcastEvent: options.broadcastEvent,
      now: options.now,
      log: this.log,
    });
    options.devices.onWorkDevice((contact) => this.contact(contact));
    // A record that closes closes its conversation there; one that goes -
    // a start that failed, a purge - leaves what it had there to the
    // leftover rule (`PlacedCopies.retireLeftover`).
    options.tasks.onChange((change) => {
      for (const taskId of change.taskIds) this.closeIfClosed(taskId);
      if (change.removed.length > 0 || change.reset) this.sweepLeftovers();
    });
  }

  /** The supervisor, once it exists. */
  serve(host: PlacedHost): void {
    this.host = host;
  }

  // ---- the crew's side ------------------------------------------------------

  factories(machine: string): SessionFactories | undefined {
    const claude = this.factory(machine, "claude");
    return { pi: this.factory(machine, "pi") as SessionFactory, ...(claude ? { claude } : {}) };
  }

  folders(machine: string, taskId: string): ReturnType<typeof placedTaskFolders> | undefined {
    const roster = this.devices.get(machine)?.roster;
    return roster ? placedTaskFolders(roster.tasksDir, taskId, roster.worktreesDir) : undefined;
  }

  keepsBrowsers(machine: string): boolean {
    return this.devices.get(machine)?.roster?.browsers === true;
  }

  takesRepoless(machine: string): boolean {
    const version = this.options.devices.version(machine);
    return version ? speaksSeed(version.contract) : true;
  }

  takesKnowledge(machine: string): boolean {
    const version = this.options.devices.version(machine);
    return version ? speaksKnowledge(version.contract) : false;
  }

  prepare(
    machine: string,
    taskId: string,
    repoId: string | null,
    base?: WorkingCopyBase,
  ): Promise<PlacedCopy> {
    return this.copies.prepare(machine, taskId, repoId, base);
  }

  sourceFile(machine: string, taskId: string, name: string, file: string): Promise<string> {
    return sendSourceFile(this.options.devices, machine, taskId, name, file);
  }

  sourceRef(
    machine: string,
    taskId: string,
    repoId: string | null,
    sourceId: string,
    ref: string,
  ): Promise<string> {
    return this.copies.sourceRef(machine, taskId, repoId, sourceId, ref);
  }

  revision(
    machine: string,
    taskId: string,
    headSha?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">> {
    return this.copies.revision(machine, taskId, headSha);
  }

  install(machine: string, taskId: string): Promise<DependencyInstall> {
    return this.copies.install(machine, taskId);
  }

  workStatus(taskId: string): Promise<{ dirty: boolean; unlandedCommits: number } | null> {
    return this.copies.status(taskId);
  }

  bringBranchHome(taskId: string, strict?: boolean): Promise<void> {
    return this.copies.bringBranchHome(taskId, strict);
  }

  async signInsOf(machine: string): Promise<ComputerSignIns | null> {
    return (await this.options.signIns?.(machine)) ?? null;
  }

  async served(machine: string): Promise<ComputerPool> {
    const signIns = (await this.options.signIns?.(machine)) ?? null;
    return computerPool(
      this.placeOf(machine).who,
      signIns,
      this.options.catalogModels?.() ?? [],
      this.options.now(),
    );
  }

  accountOf(machine: string, taskId: string): string | undefined {
    const placed = this.placed.get(taskId);
    const session = placed?.session && !placed.session.letGo ? placed.session : undefined;
    const accountId =
      session?.servingAccount() ??
      this.devices.get(machine)?.roster?.tasks.get(taskId)?.state?.accountId;
    return accountId ? accountKey(machine, accountId) : undefined;
  }

  cutOffOf(account: string): { class: CutOffClass; since: number; resetsAt?: number } | undefined {
    const row = this.accountRow(account);
    return row ? standingCutOff(row, this.options.now()) : undefined;
  }

  knows(account: string): boolean {
    const key = parseAccountKey(account);
    if (!key || !this.options.saidSignIns) return true;
    return this.options.saidSignIns(key.deviceId) !== null;
  }

  accountPlace(account: string): { provider: string; where: string } | undefined {
    const key = parseAccountKey(account);
    if (!key) return undefined;
    const providerId = this.accountRow(account)?.providerId;
    return {
      provider: providerWord(providerId),
      where: this.placeOf(key.deviceId).where,
    };
  }

  signInWait(
    machine: string,
  ): { account: string; provider: string; class: CutOffClass; resetsAt?: number } | undefined {
    const now = this.options.now();
    const held = heldThere(this.options.saidSignIns?.(machine), now);
    const cutOff = held ? standingCutOff(held, now) : undefined;
    return held && cutOff
      ? {
          account: accountKey(machine, held.id),
          provider: providerWord(held.providerId),
          class: cutOff.class,
          ...(cutOff.resetsAt !== undefined ? { resetsAt: cutOff.resetsAt } : {}),
        }
      : undefined;
  }

  /** The row that computer last said of an account `accountOf` keyed. */
  private accountRow(account: string) {
    const key = parseAccountKey(account);
    if (!key) return undefined;
    return this.options
      .saidSignIns?.(key.deviceId)
      ?.accounts.find((row) => row.id === key.accountId);
  }

  ready(machine: string, taskId: string): boolean {
    if (!this.options.devices.inReach(machine)) return false;
    const roster = this.devices.get(machine)?.roster;
    if (!roster) return false;
    const placed = this.placed.get(taskId);
    if (placed?.adopting) return false;
    const there = roster.tasks.get(taskId);
    if (!there) return true;
    return (placed ?? this.load(taskId, machine)).through >= there.seq;
  }

  // ---- the work requests ------------------------------------------------------

  async answer<C extends WorkInvokeChannel>(
    deviceId: string,
    channel: C,
    request: InvokeRequest<C>[0],
  ): Promise<InvokeResponse<C>> {
    const asked = request as { task: string; callId?: string };
    const record = this.options.tasks.get(asked.task);
    if (record?.deviceId !== deviceId) throw new Error(NO_PLACED_TASK);
    // A browser that stops as its task closes copies a saved sign-in back
    // after the close (docs/task-browser.md, "On another computer").
    const copyBack =
      channel === "inf:work:browser-event" &&
      (request as InvokeRequest<"inf:work:browser-event">[0]).event.kind === "sign-in";
    if (TaskService.isClosed(record) && !copyBack)
      throw new Error(`That task is closed on ${HERE.this}.`);
    // A browser's fact and pictures are said once, and the next says it whole.
    if (channel === "inf:work:browser") {
      const { fact } = request as InvokeRequest<"inf:work:browser">[0];
      this.options.browsers?.()?.heardFact(deviceId, asked.task, fact);
      return { ok: true } as InvokeResponse<C>;
    }
    if (channel === "inf:work:browser-frame") {
      const { frame } = request as InvokeRequest<"inf:work:browser-frame">[0];
      this.options.browsers?.()?.heardFrame(asked.task, frame);
      return { ok: true } as InvokeResponse<C>;
    }
    const placed = this.load(asked.task, deviceId);
    if (channel === "inf:work:events") {
      const { events } = request as InvokeRequest<"inf:work:events">[0];
      const run = placed.chain.then(() => this.events(placed, events));
      placed.chain = run.catch(() => undefined);
      return run as Promise<InvokeResponse<C>>;
    }
    const callId = asked.callId as string;
    const ledger = this.ledger(placed);
    const kept = ledger.get(callId);
    if (kept) {
      if (kept.error !== undefined) throw new Error(kept.error);
      return kept.answer as InvokeResponse<C>;
    }
    // Asked again while the first is still being done: one effect, one answer.
    const running = placed.calling.get(callId);
    if (running) return running as Promise<InvokeResponse<C>>;
    const work = this.call(placed, channel, request as Record<string, unknown>);
    placed.calling.set(callId, work);
    try {
      const answer = await work;
      this.keep(placed, {
        callId,
        channel,
        after: placed.through,
        answer,
        ...this.reportOf(channel, request),
      });
      return answer as InvokeResponse<C>;
    } catch (caught) {
      // Not held here yet is asked again; every other refusal is the callback's answer.
      if (!(caught instanceof NotHeldHere))
        this.keep(placed, {
          callId,
          channel,
          after: placed.through,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      throw caught;
    } finally {
      placed.calling.delete(callId);
    }
  }

  /**
   * The minute's line for a computer with work that went out of reach, once
   * per absence; one whose Firstmate runs work for another one now is never
   * said to come back.
   */
  tick(now: number): void {
    for (const deviceId of this.devicesWithWork()) {
      if (this.options.devices.inReach(deviceId)) continue;
      const device = this.device(deviceId);
      if (device.saidGone || now - device.goneSince < OUT_OF_REACH_LINE_MS) continue;
      device.saidGone = true;
      const name = this.nameOf(deviceId);
      const projects = this.projectsOf(deviceId);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: this.options.runsForAnotherFirstmate?.(deviceId)
          ? `${name} runs work for another first mate now. Its work on ${projects} stops when you remove it here.`
          : `${name} is out of reach. Its work on ${projects} catches up here when it is back.`,
      });
    }
  }

  // ---- opening ----------------------------------------------------------------

  private factory(deviceId: string, backend: SessionBackend): SessionFactory | undefined {
    const profile = this.options.profiles[backend];
    if (!profile) return undefined;
    // The computer's own background work is out of this Mac's sight: the
    // stall clock watches it, as for Claude here.
    const controlProfile: ControlProfile = { ...profile, backgroundWork: "client" };
    return {
      backend,
      controlProfile,
      open: (spec) => this.open(deviceId, backend, controlProfile, spec),
    };
  }

  private async open(
    deviceId: string,
    backend: SessionBackend,
    controlProfile: ControlProfile,
    spec: SessionSpec,
  ): Promise<PlacedSession> {
    const name = backend === "pi" ? "A Pi session" : "A Claude session";
    if (spec.machine !== deviceId)
      throw new Error(`${name} held on another computer cannot run on machine ${spec.machine}.`);
    if (spec.binding.backend !== backend)
      throw new Error(
        `${name} held on another computer cannot serve a ${spec.binding.backend} binding.`,
      );
    if (spec.shape.turns !== "rolling")
      throw new Error(
        `${name} held on another computer serves the coding built-ins on a rolling session only.`,
      );
    if (spec.builtins !== "coding")
      throw new Error(`${name} held on another computer holds a crewmate's conversation only.`);
    const device = this.device(deviceId);
    if (!this.options.devices.inReach(deviceId) || !device.roster)
      throw new Error(`${this.nameOf(deviceId)} is out of reach, so the conversation waits.`);
    const resume = crewmateResumeToken(spec.shape.record.resume);
    const version = this.options.devices.version(deviceId)?.contract;
    const supportsSpeed = Boolean(
      version &&
        (Number(version.split(".")[0]) > 5 ||
          (Number(version.split(".")[0]) === 5 && Number(version.split(".")[1]) >= 2)),
    );
    if (spec.speed && !supportsSpeed) {
      const model = spec.model ?? { provider: "openai-codex", id: "This model" };
      const requested = await spec.speed.requested(model);
      if (requested !== "standard")
        spec.speed.record(model, {
          requested,
          sent: "standard",
          reason:
            "the computer running this task has not confirmed support for crew speed settings",
        });
    }
    const placedSpec = placedSpecSchema.parse({
      binding: {
        backend,
        ...(spec.binding.accountId ? { accountId: spec.binding.accountId } : {}),
        ...(spec.model?.provider ? { provider: spec.model.provider } : {}),
      },
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.speed && supportsSpeed ? { speed: true } : {}),
      thinking: {
        level: spec.thinking.level,
        ...(spec.thinking.quick ? { quick: true } : {}),
      },
      instructions: instructionsThere(spec.instructions.base, version),
      ...(spec.personalResources !== undefined
        ? { personalResources: spec.personalResources }
        : {}),
      tools: spec.tools.map((tool) => tool.name),
      // Its own browser, there beside its shell (docs/task-browser.md, "On another computer").
      ...(spec.callbacks?.browser && device.roster.browsers ? { browser: true } : {}),
      ...(resume ? { resume } : {}),
      ...(spec.bounds?.request?.retries !== undefined
        ? { retries: spec.bounds.request.retries }
        : {}),
    });
    const task = spec.owner;
    const placed = this.load(task, deviceId);
    const { state } = openAnswerSchema.parse(
      await this.options.devices.ask(deviceId, "inf:session:open", [
        { orderId: `open:${task}:${this.options.now()}`, task, spec: placedSpec },
      ]),
    );
    const recordDir = spec.shape.record.dir;
    placed.recordDir = recordDir;
    placed.spec = placedSpec;
    const session: PlacedSession = new PlacedSession(
      {
        task,
        backend,
        recordDir,
        callbacks: spec.callbacks,
        order: <C extends WorkOrderChannel>(channel: C, args: unknown) =>
          this.options.devices.ask(deviceId, channel, args) as Promise<WorkOrderResponse<C>>,
        inReach: () => this.options.devices.inReach(deviceId),
        copy: () => this.copy(placed),
        interrupted: () =>
          `${this.nameOf(deviceId)} quit before this turn finished, so its messages go again.`,
        released: (released) => {
          if (placed.session === released) placed.session = undefined;
        },
      },
      controlProfile,
      state,
    );
    placed.session = session;
    // A turn the computer runs now, which this Mac does not follow yet.
    const there = device.roster.tasks.get(task);
    if (there) session.adopt(there);
    // A report its turn already gave before this Mac restarted, once its owner listens.
    const replays = placed.replays.filter((replay) => replay.after <= placed.through);
    placed.replays = placed.replays.filter((replay) => replay.after > placed.through);
    if (replays.length > 0)
      session.onceHeard(() => {
        for (const line of replays) this.replay(session, line);
      });
    return session;
  }

  // ---- contact ------------------------------------------------------------------

  private contact(contact: WorkDeviceContact): void {
    const device = this.device(contact.deviceId);
    device.contact += 1;
    this.awaitRoster(device);
    if (contact.contact === "gone") {
      device.roster = undefined;
      device.goneSince = this.options.now();
      for (const placed of this.placed.values())
        if (placed.deviceId === contact.deviceId) placed.released = false;
      this.options.reachMoved?.();
      return;
    }
    void this.reach(device, device.contact).catch((caught: unknown) =>
      this.log(`could not read what ${contact.deviceId} holds: ${messageOf(caught)}`),
    );
  }

  /**
   * Back in reach: its roster first, then each closed record's conversation
   * closed there, what a task this Mac no longer records there left removed
   * by the leftover rule, each running turn followed, and what waited asked
   * now.
   */
  private async reach(device: Device, contact: number): Promise<void> {
    const raw = await this.options.devices.ask(device.id, "inf:session:roster", []);
    if (device.contact !== contact) return;
    const roster = rosterSchema.parse(raw);
    device.roster = {
      tasksDir: roster.tasksDir,
      ...(roster.worktreesDir ? { worktreesDir: roster.worktreesDir } : {}),
      tasks: new Map(roster.tasks.map((entry) => [entry.task, entry])),
      browsers: roster.browsers === true,
    };
    device.rosterRead();
    const adopting: Promise<unknown>[] = [];
    for (const entry of roster.tasks) {
      const record = this.options.tasks.get(entry.task);
      if (record?.deviceId !== device.id) {
        // No task of this Mac's there: its working copy and folder go once
        // any work in them is here.
        void this.copies.retireLeftover(device.id, entry.task);
        continue;
      }
      if (TaskService.isClosed(record)) {
        // Closed here: its conversation closes there, then its working copy
        // goes once its work is here.
        if (!entry.closed) this.close(entry.task, device.id);
        else if (entry.workingCopy) void this.copies.retire(entry.task);
        continue;
      }
      const placed = this.load(entry.task, device.id);
      const session = placed.session && !placed.session.letGo ? placed.session : undefined;
      // That computer restarted: the conversation this Mac holds opens there again.
      if (session && !entry.open) adopting.push(this.reopen(placed, session, device.id));
      else if (session) session.adopt(entry);
      // A turn this Mac does not follow: a restart here left it running there.
      else if (entry.running) adopting.push(this.live(placed).catch(() => undefined));
    }
    for (const placed of this.placed.values()) {
      if (placed.deviceId !== device.id || !placed.session || placed.session.letGo) continue;
      // What waited for it goes now; the record's copy may have missed a turn's end the drop cut off.
      placed.session.reached();
      void this.copy(placed).catch(() => undefined);
    }
    // A closed task whose working copy it no longer holds has nothing left there to bring home.
    if (roster.worktreesDir)
      for (const record of this.options.tasks.list())
        if (record.deviceId === device.id && !device.roster.tasks.has(record.id))
          this.copies.forget(record.id);
    await Promise.all(adopting);
    if (device.contact === contact) this.release(device.id);
  }

  /**
   * Opens the conversation there again, from where its record ends, for the
   * session this Mac still holds; the lane waits until it is open.
   */
  private reopen(placed: Placed, session: PlacedSession, deviceId: string): Promise<void> {
    const spec = placed.spec;
    if (!spec) return Promise.resolve();
    const resume = session.resumeToken();
    const reopening = this.options.devices
      .ask(deviceId, "inf:session:open", [
        {
          orderId: `open:${placed.task}:${this.options.now()}`,
          task: placed.task,
          spec: { ...spec, ...(resume ? { resume } : {}) },
        },
      ])
      .then((raw) => session.reopened(openAnswerSchema.parse(raw).state))
      .catch((caught: unknown) =>
        this.log(`could not open ${placed.task} there again: ${messageOf(caught)}`),
      );
    placed.adopting = reopening.finally(() => {
      placed.adopting = undefined;
    });
    return placed.adopting;
  }

  /** Lets each of the computer's caught-up tasks go on, and says its work caught up. */
  private release(deviceId: string): void {
    const ready: string[] = [];
    let behind = false;
    for (const record of this.options.tasks.listLive()) {
      if (record.deviceId !== deviceId) continue;
      const placed = this.load(record.id, deviceId);
      if (!this.ready(deviceId, record.id)) {
        behind = true;
        continue;
      }
      if (placed.released) continue;
      placed.released = true;
      ready.push(record.id);
    }
    const device = this.device(deviceId);
    if (!behind && device.saidGone) {
      device.saidGone = false;
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `${this.nameOf(deviceId)} is back. Its work on ${this.projectsOf(deviceId)} caught up.`,
      });
    }
    if (ready.length > 0) this.host?.caughtUp(ready);
    this.options.reachMoved?.();
  }

  /** A roster to wait for, from this contact on; whoever waited on the last one looks again. */
  private awaitRoster(device: Device): void {
    const wake = device.rosterRead;
    device.rostered = new Promise<void>((resolve) => {
      device.rosterRead = resolve;
    });
    wake();
  }

  /** The task's conversation, open on this Mac: opened by the supervisor when nothing holds it. */
  private async live(placed: Placed): Promise<PlacedSession> {
    if (placed.session && !placed.session.letGo) return placed.session;
    const host = this.host;
    if (!host) throw new NotHeldHere(`${HERE.This} is still starting.`);
    // Asked before its roster was read: where its folders are comes first.
    const device = this.device(placed.deviceId);
    while (!device.roster) {
      if (!this.options.devices.inReach(device.id))
        throw new NotHeldHere("That computer is out of reach.");
      await device.rostered;
    }
    placed.adopting ??= host.adopt(placed.task).finally(() => {
      placed.adopting = undefined;
    });
    try {
      await placed.adopting;
    } catch (caught) {
      this.log(`could not open ${placed.task}'s conversation here: ${messageOf(caught)}`);
      throw new NotHeldHere(
        `Could not open the conversation on ${HERE.this}: ${messageOf(caught)}`,
      );
    }
    if (!placed.session || placed.session.letGo)
      throw new NotHeldHere(`That task's conversation is not open on ${HERE.this}.`);
    return placed.session;
  }

  // ---- events ---------------------------------------------------------------------

  private async events(
    placed: Placed,
    records: readonly PlacedEventRecord[],
  ): Promise<{ through: number; kept: number }> {
    if (!records.some((record) => record.seq > placed.through))
      return { through: placed.through, kept: placed.kept };
    const session = await this.live(placed);
    for (const record of records) {
      if (record.seq <= placed.through) continue;
      // A gap: the computer sends on from the number after `through`.
      if (record.seq !== placed.through + 1) break;
      // A cut-off the turn met there is that computer's own to record, and it
      // says so with its sign-ins: heard first, so the turn ends here held.
      if (metCutOff(record.event))
        await this.options.refreshSignIns?.(placed.deviceId).catch(() => undefined);
      await session.take(record.event);
      placed.through = record.seq;
      const type = record.event.type;
      if (type === "turn_end" || type === "turn_ended") {
        placed.kept = placed.through;
        if (type === "turn_ended") {
          placed.ended = placed.through;
          placed.replays = [];
        }
        this.writeKept(placed);
      }
      for (const line of placed.replays.filter((replay) => replay.after === placed.through))
        this.replay(session, line);
    }
    if (!placed.released) this.release(placed.deviceId);
    return { through: placed.through, kept: placed.kept };
  }

  // ---- callbacks ----------------------------------------------------------------

  private async call(
    placed: Placed,
    channel: WorkInvokeChannel,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    switch (channel) {
      case "inf:work:picture":
        return this.picture(placed, request as InvokeRequest<"inf:work:picture">[0]);
      case "inf:work:media":
        return this.recordingPiece(placed, request as InvokeRequest<"inf:work:media">[0]);
      case "inf:work:job-exit": {
        const { exit } = request as InvokeRequest<"inf:work:job-exit">[0];
        if (!this.host) throw new NotHeldHere(`${HERE.This} is still starting.`);
        this.host.jobExit(placed.task, { ...exit, ownerId: placed.task });
        return { ok: true };
      }
      case "inf:work:browser-event": {
        const { event } = request as InvokeRequest<"inf:work:browser-event">[0];
        const browsers = this.options.browsers?.();
        if (!browsers) throw new NotHeldHere(`${HERE.This} is still starting.`);
        browsers.heardEvent(placed.deviceId, placed.task, event);
        return { ok: true };
      }
      default:
        break;
    }
    const session = await this.live(placed);
    const callbacks = session.callbacks;
    const missing = (): never => {
      throw new Error("That tool is not this task's.");
    };
    switch (channel) {
      case "inf:work:card": {
        const { card } = request as InvokeRequest<"inf:work:card">[0];
        const onCard = callbacks?.onCard ?? missing();
        try {
          const cardId = await onCard(card as DeclaredCardInput);
          return { shown: true, ...(cardId ? { cardId } : {}) };
        } catch (caught) {
          if (!(caught instanceof CardRefusedError)) throw caught;
          return { refused: { message: caught.message, reason: caught.reason, why: caught.why } };
        }
      }
      case "inf:work:card-refused": {
        const { refusal } = request as InvokeRequest<"inf:work:card-refused">[0];
        callbacks?.onCardRefused?.(refusal);
        return { ok: true };
      }
      case "inf:work:close-card": {
        const { cardId, reason } = request as InvokeRequest<"inf:work:close-card">[0];
        const onCloseCard = callbacks?.onCloseCard ?? missing();
        return { text: await onCloseCard({ cardId, ...(reason ? { reason } : {}) }) };
      }
      case "inf:work:followup": {
        const { input } = request as InvokeRequest<"inf:work:followup">[0];
        return { text: await (callbacks?.onFollowup ?? missing())(input) };
      }
      case "inf:work:progress": {
        const { text, plan } = request as InvokeRequest<"inf:work:progress">[0];
        return { text: await (callbacks?.onProgress ?? missing())(text, plan) };
      }
      case "inf:work:report": {
        const { text, summary, declared } = request as InvokeRequest<"inf:work:report">[0];
        return { text: await (callbacks?.onReport ?? missing())(text, summary, declared) };
      }
      case "inf:work:reply": {
        const { cardId, text } = request as InvokeRequest<"inf:work:reply">[0];
        return { text: await (callbacks?.onReply ?? missing())({ cardId, text }) };
      }
      case "inf:work:speed-note": {
        const { model, selection } = request as InvokeRequest<"inf:work:speed-note">[0];
        callbacks?.onSpeed?.(model, selection);
        return { ok: true };
      }
      case "inf:work:speed": {
        const { model } = request as InvokeRequest<"inf:work:speed">[0];
        return (await callbacks?.requestedSpeed?.(model)) ?? "standard";
      }
      case "inf:work:tasks": {
        const { input } = request as InvokeRequest<"inf:work:tasks">[0];
        return await (callbacks?.onQueryTasks ?? missing())(input);
      }
      case "inf:work:read-workflow": {
        const { input } = request as InvokeRequest<"inf:work:read-workflow">[0];
        return { text: await (callbacks?.onReadWorkflow ?? missing())(input) };
      }
      case "inf:work:github-read": {
        const { input } = request as InvokeRequest<"inf:work:github-read">[0];
        return { text: await (callbacks?.onGithubRead ?? missing())(input) };
      }
      case "inf:work:github-write": {
        const { input } = request as InvokeRequest<"inf:work:github-write">[0];
        return { text: await (callbacks?.onGithubWrite ?? missing())(input) };
      }
      case "inf:work:open-change": {
        const { input } = request as InvokeRequest<"inf:work:open-change">[0];
        return { text: await (callbacks?.onOpenChange ?? missing())(input) };
      }
      case "inf:work:check-change": {
        const { input } = request as InvokeRequest<"inf:work:check-change">[0];
        return { text: await (callbacks?.onCheckChange ?? missing())(input) };
      }
      case "inf:work:download-artifact": {
        const { input } = request as InvokeRequest<"inf:work:download-artifact">[0];
        return { text: await (callbacks?.onDownloadArtifact ?? missing())(input) };
      }
      case "inf:work:knowledge": {
        const { input } = request as InvokeRequest<"inf:work:knowledge">[0];
        return { text: await (callbacks?.knowledge ?? missing()).read(input) };
      }
      case "inf:work:record-knowledge": {
        const { input } = request as InvokeRequest<"inf:work:record-knowledge">[0];
        return { text: await (callbacks?.knowledge ?? missing()).record(input) };
      }
      default:
        throw new Error(`${channel} is not a request ${HERE.this} answers.`);
    }
  }

  /** A card picture's bytes, kept where this Mac's cards show their pictures from. */
  private picture(placed: Placed, request: InvokeRequest<"inf:work:picture">[0]): { ok: true } {
    if (!request.id.startsWith(`${placed.task}-`))
      throw new Error("That picture is not this task's.");
    const dir = crewmateCardPicturesDir(this.options.paths, placed.task);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${request.id}.${request.extension}`),
      Buffer.from(request.data, "base64"),
    );
    return { ok: true };
  }

  /**
   * A piece of a card's demo recording, written at its place in a partial
   * file; the last piece makes it the recording its poster names, so a card
   * never names one this Mac holds only part of.
   */
  private recordingPiece(
    placed: Placed,
    request: InvokeRequest<"inf:work:media">[0],
  ): { ok: true } {
    if (!request.id.startsWith(`${placed.task}-`))
      throw new Error("That recording is not this task's.");
    const piece = Buffer.from(request.data, "base64");
    if (request.offset + piece.length > request.size)
      throw new Error("That piece runs past the recording's end.");
    const dir = crewmateCardPicturesDir(this.options.paths, placed.task);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${request.id}.${request.extension}`);
    const partial = `${file}.partial`;
    const handle = openSync(partial, request.offset === 0 ? "w" : "r+");
    try {
      writeSync(handle, piece, 0, piece.length, request.offset);
    } finally {
      closeSync(handle);
    }
    if (request.offset + piece.length === request.size) renameSync(partial, file);
    return { ok: true };
  }

  /** A report a turn gave before this Mac restarted, given to the turn this Mac follows now. */
  private replay(session: PlacedSession, line: CallLine): void {
    if (!line.report) return;
    const { text, summary, declared } = line.report;
    try {
      void Promise.resolve(
        session.callbacks?.onReport?.(
          text,
          summary,
          declared as Parameters<NonNullable<typeof session.callbacks.onReport>>[2],
        ),
      ).catch(() => undefined);
    } catch {
      // Refused again now: it was refused or answered then, and the crewmate read that.
    }
  }

  private reportOf(
    channel: WorkInvokeChannel,
    request: unknown,
  ): Pick<CallLine, "report"> | Record<string, never> {
    if (channel !== "inf:work:report") return {};
    const { text, summary, declared } = request as InvokeRequest<"inf:work:report">[0];
    return {
      report: {
        text,
        ...(summary !== undefined ? { summary } : {}),
        ...(declared !== undefined ? { declared } : {}),
      },
    };
  }

  // ---- the record's copy -------------------------------------------------------

  /**
   * Brings this Mac's copy of the conversation's record up to the
   * computer's, from where each file's copy ends; a file the computer
   * rewrote shorter is rewritten from where it differs.
   */
  private copy(placed: Placed): Promise<void> {
    const recordDir = placed.recordDir;
    const run = placed.copying.then(async () => {
      let more = true;
      while (more) {
        const answer = (await this.options.devices.ask(placed.deviceId, "inf:session:copy", [
          { task: placed.task, from: copiedFiles(recordDir) },
        ])) as WorkOrderResponse<"inf:session:copy">;
        for (const file of answer.files) writeAt(recordDir, file);
        more = answer.more && answer.files.length > 0;
      }
    });
    placed.copying = run.catch((caught: unknown) =>
      this.log(`could not copy ${placed.task}'s record home: ${messageOf(caught)}`),
    );
    return run;
  }

  /**
   * A record went while its computer may be in reach: each computer in
   * reach whose roster was read is asked again, and what a task this Mac
   * no longer records there left goes by the leftover rule now rather than
   * at its next contact.
   */
  private sweepLeftovers(): void {
    for (const device of this.devices.values()) {
      if (!device.roster || !this.options.devices.inReach(device.id)) continue;
      void this.options.devices
        .ask(device.id, "inf:session:roster", [])
        .then((raw) => {
          for (const entry of rosterSchema.parse(raw).tasks)
            if (this.options.tasks.get(entry.task)?.deviceId !== device.id)
              void this.copies.retireLeftover(device.id, entry.task);
        })
        .catch((caught: unknown) =>
          this.log(`could not read what ${device.id} holds: ${messageOf(caught)}`),
        );
    }
  }

  // ---- removing a computer -------------------------------------------------------

  /**
   * Before a computer that runs work is removed (docs/devices.md, "Remove"):
   * every conversation it holds is closed there for good and every working
   * copy whose task this Mac records is retired once its kept work is here.
   * Rejects while one of its tasks is still open here, and when a working
   * copy there still holds work this Mac lacks, so nothing that never came
   * home is ever lost to a removal.
   */
  async bringHome(deviceId: string): Promise<void> {
    const name = this.nameOf(deviceId);
    const roster = rosterSchema.parse(
      await this.options.devices.ask(deviceId, "inf:session:roster", []),
    );
    for (const entry of roster.tasks) {
      const record = this.options.tasks.get(entry.task);
      const ours = record?.deviceId === deviceId;
      if (ours && record && !TaskService.isClosed(record))
        throw new Error(`"${record.title}" is still running on ${name}.`);
      if (!entry.closed) {
        await this.options.devices.ask(deviceId, "inf:session:close", [
          { orderId: `close:${entry.task}`, task: entry.task },
        ]);
        if (ours) this.load(entry.task, deviceId).closed = true;
      }
      if (entry.workingCopy && ours) await this.copies.retire(entry.task);
    }
    const after = rosterSchema.parse(
      await this.options.devices.ask(deviceId, "inf:session:roster", []),
    );
    const left = after.tasks.filter(
      (entry) => entry.workingCopy && this.options.tasks.get(entry.task)?.deviceId === deviceId,
    ).length;
    if (left > 0)
      throw new Error(
        `the work of ${left === 1 ? "one task" : `${left} tasks`} on ${name} could not come here yet`,
      );
  }

  // ---- closing ------------------------------------------------------------------

  /** Called only for a closed task whose home-authoritative retention period is over. */
  async removeClosedTaskFiles(
    record: TaskRecord,
  ): Promise<WorkOrderResponse<"inf:session:clean-files">> {
    if (!record.deviceId || !TaskService.isClosed(record))
      throw new Error("This task is not closed on another computer.");
    const deviceId = record.deviceId;
    if (!this.options.devices.inReach(deviceId))
      throw new Error("This task's computer is out of reach.");
    await this.options.devices.ask(deviceId, "inf:session:close", [
      { orderId: `close:${record.id}`, task: record.id },
    ]);
    const result = await this.options.devices.ask(deviceId, "inf:session:clean-files", [
      { orderId: `clean-files:${record.id}:${record.closedAt}`, task: record.id },
    ]);
    return workOrders["inf:session:clean-files"].response.parse(result);
  }

  /**
   * Removes only the provisioned temporary folder on the computer that
   * holds the task. An older computer, or one out of reach, is not reported
   * as cleaned; the caller retries.
   */
  async removeClosedTaskTemp(
    record: TaskRecord,
  ): Promise<WorkOrderResponse<"inf:session:clean-temp">> {
    if (!record.deviceId || !TaskService.isClosed(record))
      throw new Error("This task is not closed on another computer.");
    const deviceId = record.deviceId;
    if (!this.options.devices.inReach(deviceId))
      throw new Error("This task's computer is out of reach.");
    const version = this.options.devices.version(deviceId)?.contract ?? "";
    if (!speaksTempCleanup(version))
      throw new Error("This computer needs an update before temporary files can be removed.");
    await this.options.devices.ask(deviceId, "inf:session:close", [
      { orderId: `close:${record.id}`, task: record.id },
    ]);
    const result = await this.options.devices.ask(deviceId, "inf:session:clean-temp", [
      { orderId: `clean-temp:${record.id}:${record.closedAt}`, task: record.id },
    ]);
    return workOrders["inf:session:clean-temp"].response.parse(result);
  }

  private closeIfClosed(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (!record?.deviceId || !TaskService.isClosed(record)) return;
    const placed = this.load(taskId, record.deviceId);
    if (placed.closed || !this.options.devices.inReach(record.deviceId)) return;
    this.close(taskId, record.deviceId);
  }

  /**
   * The record closed here: its conversation closes there for good, now or
   * at its next roster, and then its working copy goes there once its work
   * is here (`PlacedCopies.retire`).
   */
  private close(taskId: string, deviceId: string): void {
    const placed = this.load(taskId, deviceId);
    placed.closed = true;
    this.options.devices
      .ask(deviceId, "inf:session:close", [{ orderId: `close:${taskId}`, task: taskId }])
      .then(
        () => this.copies.retire(taskId),
        (caught: unknown) => {
          placed.closed = false;
          this.log(`could not close ${taskId} there yet: ${messageOf(caught)}`);
        },
      );
  }

  // ---- what the home keeps ----------------------------------------------------------

  private device(deviceId: string): Device {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = {
        id: deviceId,
        roster: undefined,
        contact: 0,
        goneSince: this.startedAt,
        saidGone: false,
        rostered: Promise.resolve(),
        rosterRead: () => {},
      };
      this.awaitRoster(device);
      this.devices.set(deviceId, device);
    }
    return device;
  }

  private load(task: string, deviceId: string): Placed {
    const known = this.placed.get(task);
    if (known) return known;
    const kept = readKept(join(crewmatePlacedDir(this.options.paths, task), "state.json"));
    const placed: Placed = {
      task,
      deviceId,
      through: kept.kept,
      kept: kept.kept,
      ended: kept.ended,
      session: undefined,
      adopting: undefined,
      ledger: undefined,
      calling: new Map(),
      chain: Promise.resolve(),
      replays: [],
      released: false,
      closed: false,
      copying: Promise.resolve(),
      recordDir: crewmateSessionsDir(this.options.paths, task),
      spec: undefined,
    };
    this.placed.set(task, placed);
    // The reports a turn this Mac had not finished gave: a restart here replays them.
    placed.replays = [...this.ledger(placed).values()].filter(
      (line) => line.report !== undefined && line.after >= placed.ended,
    );
    return placed;
  }

  private ledger(placed: Placed): Map<string, CallLine> {
    if (placed.ledger) return placed.ledger;
    const ledger = new Map<string, CallLine>();
    let text = "";
    try {
      text = readFileSync(
        join(crewmatePlacedDir(this.options.paths, placed.task), "calls.jsonl"),
        "utf8",
      );
    } catch {
      // Nothing asked yet.
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const call = callLineSchema.parse(JSON.parse(line)) as CallLine;
        ledger.set(call.callId, call);
      } catch {
        // A line a quit cut short was never answered: it is asked again.
      }
    }
    placed.ledger = ledger;
    return ledger;
  }

  /** Kept before it is returned, so a callback asked again is answered from here. */
  private keep(placed: Placed, line: CallLine): void {
    const dir = crewmatePlacedDir(this.options.paths, placed.task);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(line)}\n`);
    this.ledger(placed).set(line.callId, line);
  }

  private writeKept(placed: Placed): void {
    const dir = crewmatePlacedDir(this.options.paths, placed.task);
    try {
      mkdirSync(dir, { recursive: true });
      const next = join(dir, "state.json.next");
      writeFileSync(next, `${JSON.stringify({ kept: placed.kept, ended: placed.ended })}\n`);
      renameSync(next, join(dir, "state.json"));
    } catch (caught) {
      this.log(`could not keep ${placed.task}'s place: ${messageOf(caught)}`);
    }
  }

  // ---- words ------------------------------------------------------------------------

  private devicesWithWork(): Set<string> {
    const devices = new Set<string>();
    for (const record of this.options.tasks.listActive())
      if (record.deviceId) devices.add(record.deviceId);
    return devices;
  }

  computers(): readonly string[] {
    return this.options.computers?.() ?? [];
  }

  nameOf(deviceId: string): string {
    return this.options.deviceName(deviceId) ?? `The other ${COMPUTER.one}`;
  }

  placeOf(deviceId: string): ReturnType<typeof signInPlace> {
    if (this.options.devicePlace) return this.options.devicePlace(deviceId);
    const name = this.nameOf(deviceId);
    return { label: name, where: `on ${name}`, who: name };
  }

  servingAccount(session: ModelSession): string | undefined {
    return session instanceof PlacedSession ? session.servingAccount() : undefined;
  }

  /** The projects a computer's active work belongs to, as one phrase. */
  private projectsOf(deviceId: string): string {
    const names = [
      ...new Set(
        this.options.tasks
          .listActive()
          .filter((record) => record.deviceId === deviceId)
          .map((record) =>
            record.repoId
              ? (this.options.projectName(record.repoId) ?? record.title)
              : record.title,
          ),
      ),
    ];
    if (names.length <= 1) return names[0] ?? "its tasks";
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
}

/** What a placed state is, for the session's own reading. */
export type { PlacedState };

function readKept(path: string): z.infer<typeof keptStateSchema> {
  try {
    return keptStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { kept: 0, ended: 0 };
  }
}

/** Every file of this Mac's copy, by its path under the record's folder, with where it ends. */
function copiedFiles(dir: string): { name: string; offset: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[];
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) return [];
      return [{ name: relative(dir, join(dir, name)).split(sep).join("/"), offset: stat.size }];
    } catch {
      return [];
    }
  });
}

/** One copied stretch of a file, written at its offset; the file ends where the stretch does. */
function writeAt(
  dir: string,
  file: { name: string; size: number; offset: number; data: string },
): void {
  const path = join(dir, ...file.name.split("/"));
  if (relative(dir, path).startsWith("..")) return;
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from(file.data, "base64");
  const fd = openSync(path, "a+");
  closeSync(fd);
  const handle = openSync(path, "r+");
  try {
    let written = 0;
    while (written < bytes.length)
      written += writeSync(handle, bytes, written, bytes.length - written, file.offset + written);
    const end = file.offset + bytes.length;
    if (end >= file.size) ftruncateSync(handle, end);
  } finally {
    closeSync(handle);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A computer's own account, keyed apart from this Mac's own account ids (a
 * device id is a UUID and an account id holds no `@`), so the cut-off
 * contract's wakes and once-names can name it beside them.
 */
function accountKey(deviceId: string, accountId: string): string {
  return `${accountId}@${deviceId}`;
}

function parseAccountKey(account: string): { deviceId: string; accountId: string } | undefined {
  const at = account.lastIndexOf("@");
  if (at <= 0 || at === account.length - 1) return undefined;
  return { accountId: account.slice(0, at), deviceId: account.slice(at + 1) };
}

/** A provider as the captain names it. */
function providerWord(providerId: string | undefined): string {
  return (providerId && catalogEntry(providerId)?.name) || providerId || "its subscription";
}

/** An event that carries a typed cut-off its turn met there. */
function metCutOff(event: PlacedEventRecord["event"]): boolean {
  return (
    (event.type === "turn_failed" || event.type === "continuation_ended") &&
    "cutOff" in event &&
    event.cutOff !== undefined
  );
}

/**
 * A crewmate's instructions as the computer that runs it knows its own
 * commands: one from before the Infinitary rename has its browser command
 * under Firstmate 3000's name only (`INFINITARY_NAMES_SINCE`), so its
 * crewmate is told that name. Any other computer is told the instructions
 * as they are.
 */
export function instructionsThere(base: string, contract: string | undefined): string {
  return contract && !speaksInfinitaryNames(contract)
    ? base.replace(CREWMATE_BROWSER_LINE, crewmateBrowserLine("fm-browser-axi"))
    : base;
}
