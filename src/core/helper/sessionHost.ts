import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { CutOff } from "@shared/authFailure";
import {
  CARD_MEDIA_PIECE_BYTES,
  cardTypefaceNames,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import type { CardPicture } from "@shared/cards";
import { crewSpeedSchema } from "@shared/crewSpeed";
import { HOME } from "@shared/deviceNames";
import {
  hearsClientJobEnds,
  invokeContract,
  keepsCardTypefaces,
  type WorkInvokeChannel,
} from "@shared/ipc";
import {
  isWorkOrderChannel,
  PLACED_EVENTS_MAX_PER_REQUEST,
  type PlacedEvent,
  type PlacedEventRecord,
  type PlacedSpec,
  type PlacedState,
  placedCardAnswerSchema,
  placedEventsAnswerSchema,
  requestRepeatsSafely,
  type WorkOrderChannel,
  type WorkOrderRequest,
  type WorkOrderResponse,
  workOrders,
  workRequests,
} from "@shared/work";
import type { CrewmateBrowser } from "../browser/taskBrowsers";
import { WorkRequestAbortedError } from "../devices/homeLink";
import { PLACED_RELEASE_FILE_REFUSAL } from "../forge";
import type { JobExit } from "../jobs/jobManager";
import {
  crewmateContractStamp,
  crewmateResume,
  crewmateResumeToken,
} from "../orchestrator/crewSession";
import type { MediaProbe, TypefaceProbe } from "../pi/cardImages";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import {
  type ClientBackgroundTask,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionBackend,
  type SessionBinding,
  type SessionEvent,
  type SessionFactories,
  type SessionRenewal,
  type SessionSpec,
  type TaskShell,
} from "../session/session";
import {
  bindTools,
  CardRefusedError,
  type CrewmateTool,
  type CrewmateToolDelegate,
  OutcomeUnknownError,
} from "../session/tools";
import { changeRecoveryCheck, sameNames } from "../session/workRecovery";
import type { TaskQueryRow } from "../tasks/taskQuery";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import type { PlacedJob, PlacedTaskState, PlacedTasks } from "./placedTasks";
import { PLACED_REQUEST_WAIT_MS } from "./toolWait";
import type { WorkingCopies } from "./workingCopies";

/**
 * A crewmate's conversation held on a computer that runs work, for its home
 * (docs/helper.md, "Holding a conversation"): the computer's side of the
 * orders and work requests in src/shared/work.ts.
 *
 * The real Pi or Claude conversation runs here, with the crewmate's file
 * tools and shell in this computer's own folder for the task and this
 * computer's own sign-ins. The crewmate's own tools run here too, so a card
 * body file or a picture is read where it was written; each tool's callback
 * - a card, a report, a follow-up, a progress note, a reply, a look at the
 * tasks, a read or write of the home's knowledge - asks the home, which does
 * it exactly as for a crewmate of its own.
 *
 * Each task's conversation runs in its own working copy here, which the
 * home has made first (`WorkingCopies`, docs/helper.md "Its working
 * copies"); the orders about the working copy ride the same answers.
 *
 * Nothing is done twice. An order carries an id from what the home saved,
 * and one this conversation already applied is answered as it was, without
 * acting. A callback asks under one id and asks again under it after a drop.
 * What the conversation does is numbered per task and written to the task's
 * outbox before it is sent, one request at a time, and forgotten only once
 * the home keeps it. A turn this computer quit in the middle of ends as
 * `interrupted` at its next start, as a turn on the home ends when the home
 * quits, and each background job's end it had not told yet - an exit the
 * home had not answered, or a job its end cut off, a Claude client's
 * background tasks among them - is told to its home once. So is each
 * background task a Claude client still ran when it ended while this
 * computer ran on.
 */

export type SessionHostOptions = {
  tasks: PlacedTasks;
  /** Asks the home one work request; asked again after every drop until it answers. */
  ask: (channel: WorkInvokeChannel, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** This computer's own factories. */
  factories: Partial<SessionFactories>;
  /** The binding the home described, resolved with this computer's own sign-ins. */
  bind: (binding: PlacedSpec["binding"]) => Promise<SessionBinding>;
  /**
   * This computer's own accounts, as far as a conversation's facts go: which
   * of them a resolved binding is, which the state names to the home so its
   * usage is booked there, and where a typed cut-off a turn here meets is
   * recorded - on that account in this computer's own store, never the
   * home's (docs/helper.md, "Its own sign-ins"). Absent, a conversation
   * names no account of its own.
   */
  accounts?: OwnAccounts;
  /** This computer's own Pi shell jobs; Claude reports its own background work. */
  runningJobCount?: (task: string) => number;
  /** Ends what a task's shell left running, when its conversation closes. */
  killJobs?: (task: string) => void;
  /**
   * This computer's decoder for a card's demo recording (docs/card-authoring.md
   * "Demo recordings"). Absent, a card naming one is refused here.
   */
  probeMedia?: MediaProbe;
  /**
   * This computer's loader for a preview's project font (docs/card-authoring.md
   * "Fonts by reference"). Absent, a card naming one is refused here.
   */
  probeTypeface?: TypefaceProbe;
  /**
   * The contract the home said in its welcome, while it is known: a project
   * font goes home only to a home that keeps one (`CARD_TYPEFACES_SINCE`).
   */
  homeVersion?: () => string | null;
  /**
   * This computer's working copies, which a conversation runs in. Absent,
   * a conversation runs in an empty folder of its task's own.
   */
  copies?: WorkingCopies;
  /**
   * This computer's task browsers (docs/task-browser.md, "On another
   * computer"): a conversation whose task the home says has a browser is
   * given it, through `infinitary-browser-axi` in its shell, and the browser goes
   * when the conversation closes for good. Absent, this computer keeps none,
   * and its roster says so.
   */
  browsers?: {
    grant: (task: string) => { browser: CrewmateBrowser; shell: TaskShell };
    close: (task: string) => void;
  };
  /**
   * The crewmate tools it binds, by the names the home sends: the crewmate's
   * own whose callbacks ask the home, unless a test stands in its own.
   */
  tools?: readonly CrewmateTool[];
  now?: () => number;
  log?: (line: string) => void;
};

/** What a conversation held here knows of this computer's own accounts (`SessionHostOptions.accounts`). */
export type OwnAccounts = {
  /** The account of this computer's own that a resolved binding is, if it is one. */
  of(binding: SessionBinding): string | undefined;
  /** Records a typed cut-off on that account, in this computer's own store. */
  noteCutOff(accountId: string, cutOff: CutOff): void;
};

/** The crewmate tools whose callbacks can ask the home; the home names which a task gets. */
const FORWARDED_TOOLS = new Set([
  "emit_card",
  "close_card",
  "file_followup",
  "note_progress",
  "report",
  "reply",
  "tasks",
  "read_workflow",
  "github_read",
  "github_write",
  "prepare_change",
  "open_change",
  "check_change",
  "download_artifact",
  "knowledge",
  "record_knowledge",
]);

/** The provider's retries a crewmate's turn gets when the home names none. */
const RETRIES = 2;

const toolTextSchema = workRequests["inf:work:close-card"].response;
const tasksAnswerSchema = workRequests["inf:work:tasks"].response;

type Flush = { seq: number; resolve: () => void };

type Held = {
  readonly task: string;
  state: PlacedTaskState;
  session: ModelSession | null;
  /** Reopening the home’s side can enable the policy without interrupting this conversation. */
  speed: boolean;
  backend: SessionBackend | null;
  /** The last Pi shell count sent, so another task's job does not repeat it. */
  jobs: number | undefined;
  /**
   * The background tasks the open conversation's own client runs now (a
   * Claude conversation's), each by its row in the task's job rows, so an
   * end of the client that takes them with it is told: now, or at the next
   * start when it is this computer's stop.
   */
  clientTasks: Map<string, PlacedJob>;
  /** The account of this computer's own the open conversation is bound to, if it is one. */
  account: string | undefined;
  /** The session the open conversation started over from, until a turn of it finishes (`PlacedState.renewal`). */
  renewal: SessionRenewal | undefined;
  opening: Promise<void> | null;
  unsubscribe: (() => void) | null;
  readonly orders: Map<string, unknown>;
  /** Every event after the home's `kept`, in order. */
  outbox: PlacedEventRecord[];
  /** Events not yet on disk. */
  unwritten: PlacedEventRecord[];
  /** The newest number the home said it has. */
  through: number;
  sending: boolean;
  /** The home refused this task's events; nothing more is sent until it is in reach again. */
  refused: boolean;
  flushes: Flush[];
  /** Orders run one at a time per task. */
  chain: Promise<unknown>;
  /** The working copy's orders being done now, by id: one asked again waits for the same. */
  copying: Map<string, Promise<unknown>>;
  /** Its folder was removed (`inf:session:remove`): nothing of it is written again. */
  removed: boolean;
  /** The tool names and instructions this conversation was opened with. */
  opened: { tools: readonly string[]; instructions: string; browser: boolean } | undefined;
};

export class SessionHost {
  private readonly held = new Map<string, Held>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private stopped = false;
  /** Nothing is sent until the home is first in reach, or asks something. */
  private live = false;
  private writeTimer: NodeJS.Immediate | undefined;

  constructor(private readonly options: SessionHostOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(`[session-host] ${line}`));
    // A turn left running by a quit, or a crash, ended then: say so first.
    for (const task of options.tasks.list()) {
      const held = this.load(task);
      if (held.state.running) {
        const { turn } = held.state.running;
        held.state = { ...held.state, running: undefined };
        this.record(held, { type: "turn_ended", turn, outcome: "interrupted", undelivered: [] });
        this.writeOut(held);
      }
      this.interruptContinuation(held);
      // No conversation is open yet, so no job of this run is: each row is
      // a job the last run's end cut off, or an exit the home had not answered.
      for (const job of options.tasks.jobs(task)) this.tellJobEnd(held, job);
    }
  }

  /** Answers one order the home asked (src/shared/work.ts), or throws why not. */
  async answer(channel: string, args: unknown): Promise<unknown> {
    if (this.stopped) throw new Error("This computer is stopping.");
    if (!isWorkOrderChannel(channel))
      throw new Error(`${channel} is not a request this computer answers.`);
    const parsed = workOrders[channel].request.safeParse(args);
    if (!parsed.success) throw new Error(`Rejected ${channel}: malformed request`);
    this.live = true;
    return this.order(channel, parsed.data);
  }

  /**
   * The home is in reach again: whatever it has not taken goes now. A home
   * that restarted holds only what it kept, so the events after its `kept`
   * go again; one that only lost the connection skips the ones it has.
   */
  reached(): void {
    this.live = true;
    for (const held of this.held.values()) {
      held.refused = false;
      held.through = Math.min(held.through, held.state.kept);
      this.pump(held);
    }
  }

  /** The shell job list changed: each open Pi conversation sends its own count. */
  jobsChanged(): void {
    if (this.stopped) return;
    for (const held of this.held.values()) this.recordJobs(held);
  }

  private recordJobs(held: Held, snapshot = false): void {
    if (!held.session || held.state.closed || held.backend !== "pi") return;
    const count = this.options.runningJobCount?.(held.task);
    if (count === undefined || (!snapshot && count === held.jobs)) return;
    held.jobs = count;
    this.record(held, { type: "background_work_changed", count });
  }

  /**
   * The background tasks the conversation's own client runs now (a Claude
   * conversation's), as its client lists them: each new one gets a row,
   * and one the client no longer lists loses its row, since the client
   * tells its own model how it ended. A row the last run left is told at
   * this start and never touched here.
   */
  private keepClientTasks(held: Held, tasks: readonly ClientBackgroundTask[]): void {
    const live = new Set(tasks.map((task) => task.id));
    for (const id of held.clientTasks.keys()) {
      if (live.has(id)) continue;
      held.clientTasks.delete(id);
      this.options.tasks.forgetJob(held.task, id);
    }
    if (held.state.closed) return;
    for (const task of tasks) {
      if (held.clientTasks.has(task.id)) continue;
      const row: PlacedJob = { id: task.id, command: task.description, startedAt: this.now() };
      held.clientTasks.set(task.id, row);
      this.options.tasks.keepJob(held.task, row);
    }
  }

  /**
   * The conversation's client ended while this computer runs on - the home
   * let go of it (its quit does), a moved contract reopened it, or it
   * stopped by itself - and each background task it still listed ended with
   * it (INF-405). Its row keeps that end until the home answers, and the
   * home is told now, once, so its crewmate never waits on the task.
   */
  private clientEnded(held: Held): void {
    for (const row of held.clientTasks.values()) {
      const job: PlacedJob = {
        ...row,
        exit: {
          exitCode: null,
          durationMs: Math.max(0, this.now() - row.startedAt),
          tail: "",
          interrupted: "client",
        },
      };
      this.options.tasks.keepJob(held.task, job);
      this.tellJobEnd(held, job);
    }
    held.clientTasks.clear();
  }

  /**
   * A background job a crewmate's shell started here ended: its home hears
   * it as a wake. Its row keeps the exit until the home answers, so a stop
   * before then tells it at the next start.
   */
  jobExit(exit: JobExit): void {
    const held = this.held.get(exit.ownerId);
    if (!held || held.state.closed) return;
    const job: PlacedJob = {
      id: exit.jobId,
      command: exit.command,
      startedAt: this.now() - exit.durationMs,
      exit: { exitCode: exit.exitCode, durationMs: exit.durationMs, tail: exit.tail },
    };
    this.options.tasks.keepJob(held.task, job);
    this.tellJobEnd(held, job);
  }

  /**
   * Tells the home a job's end, the one its crewmate waits for, once: its
   * exit, or - for a job the last run here left running - that it never
   * exited, because that run's stop killed it or the run ended without one,
   * or because the Claude client it ran in ended first. It goes under the
   * job's own call id, and its row goes only once the home answers, so a
   * stop before then asks again at the next start and the home answers that
   * from what it kept. A home known to be older hears a client's end
   * without why (`CLIENT_JOB_ENDS_SINCE`), as an exit by signal.
   */
  private tellJobEnd(held: Held, job: PlacedJob): void {
    const forget = () => {
      if (!held.removed) this.options.tasks.forgetJob(held.task, job.id);
    };
    // A closed conversation has nobody waiting.
    if (held.state.closed) {
      forget();
      return;
    }
    const home = this.options.homeVersion?.() ?? null;
    const { interrupted, ...exit } = job.exit ?? {
      exitCode: null,
      durationMs: Math.max(0, (job.stoppedAt ?? job.startedAt) - job.startedAt),
      tail: "",
      interrupted: job.stoppedAt === undefined ? ("crash" as const) : ("quit" as const),
    };
    const older = interrupted === "client" && home !== null && !hearsClientJobEnds(home);
    // A job's end is its own request: it carries no tool's cancellation,
    // so a tool that started the job cannot withdraw the end.
    void this.call(held, "inf:work:job-exit", {
      callId: `job:${job.id}`,
      exit: {
        jobId: job.id,
        command: job.command,
        ...exit,
        ...(interrupted && !older ? { interrupted } : {}),
      },
    }).then(forget, (error: unknown) => {
      // Stopping first: its row stays for the next start.
      if (this.stopped) return;
      this.log(`a job's end was refused: ${messageOf(error)}`);
      forget();
    });
  }

  /**
   * This computer stops: every conversation lets go, a running turn ends
   * as `interrupted`, and what is not on disk is written.
   */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.writeTimer) clearImmediate(this.writeTimer);
    this.writeTimer = undefined;
    const sessions: ModelSession[] = [];
    for (const held of this.held.values()) {
      if (held.state.running) {
        const { turn } = held.state.running;
        held.state = { ...held.state, running: undefined };
        this.record(held, { type: "turn_ended", turn, outcome: "interrupted", undelivered: [] });
      }
      this.interruptContinuation(held);
      held.unsubscribe?.();
      held.unsubscribe = null;
      // The client's background tasks end with it: their rows say this stop
      // killed them, for the next start to tell.
      for (const id of held.clientTasks.keys())
        this.options.tasks.jobRows.markStoppedByQuit(id, held.task, this.now());
      held.clientTasks.clear();
      if (held.session) sessions.push(held.session);
      held.session = null;
      this.writeOut(held);
    }
    for (const session of sessions) session.dispose();
    await Promise.all(sessions.map((session) => session.closed().catch(() => undefined)));
  }

  private async order<C extends WorkOrderChannel>(
    channel: C,
    request: WorkOrderRequest<C>,
  ): Promise<WorkOrderResponse<C>> {
    if (channel === "inf:session:roster") return this.roster() as WorkOrderResponse<C>;
    const [fields] = request as [{ task: string; orderId?: string }];
    if (channel === "inf:session:copy") {
      const [copy] = request as WorkOrderRequest<"inf:session:copy">;
      if (copy.refresh) this.held.get(copy.task)?.session?.recordPath({ refresh: true });
      return this.options.tasks.copy(copy.task, copy.from) as WorkOrderResponse<C>;
    }
    if (channel === "inf:session:source-file") {
      const [piece] = request as WorkOrderRequest<"inf:session:source-file">;
      return this.options.tasks.sourceFile(piece) as Promise<WorkOrderResponse<C>>;
    }
    if (channel.startsWith("inf:working-copy:"))
      return this.workingCopy(channel, request) as Promise<WorkOrderResponse<C>>;
    const held = this.hold(fields.task);
    // A new order is news from the home: what it refused before goes again.
    held.refused = false;
    const run = held.chain.then(() => this.act(held, channel, request));
    held.chain = run.catch(() => undefined);
    return run as Promise<WorkOrderResponse<C>>;
  }

  private async act(held: Held, channel: WorkOrderChannel, request: unknown): Promise<unknown> {
    const [fields] = request as [{ orderId: string }];
    // Applied before: answered as it was, and nothing is done again.
    // A pending temporary-folder removal is not final, so it is tried again.
    if (channel !== "inf:session:open" && held.orders.has(fields.orderId)) {
      const remembered = held.orders.get(fields.orderId) as { status?: string } | undefined;
      if (!(channel === "inf:session:clean-temp" && remembered?.status === "pending")) {
        return remembered;
      }
      held.orders.delete(fields.orderId);
    }
    let answer: unknown;
    switch (channel) {
      case "inf:session:open": {
        const [open] = request as WorkOrderRequest<"inf:session:open">;
        return { state: await this.open(held, open.spec) };
      }
      case "inf:session:prompt": {
        const [prompt] = request as WorkOrderRequest<"inf:session:prompt">;
        answer = this.prompt(held, prompt.orderId, prompt.text, prompt.images);
        break;
      }
      case "inf:session:steer": {
        const [steer] = request as WorkOrderRequest<"inf:session:steer">;
        const session = this.conversation(held);
        // A turn that ended took nothing: the home puts the words back on its lane.
        if (!held.state.running) answer = { delivered: false };
        else {
          await session.steer(steer.text, steer.images);
          answer = { delivered: true };
        }
        break;
      }
      case "inf:session:abort": {
        const [abort] = request as WorkOrderRequest<"inf:session:abort">;
        // Nothing open: nothing to do, now or when asked again.
        if (!held.session) return { ok: true };
        await held.session.abort(abort.failure);
        answer = { ok: true };
        break;
      }
      case "inf:session:detach":
        if (!held.session) return { ok: true };
        if (!held.state.running) await held.session.detach();
        answer = { ok: true };
        break;
      case "inf:session:close":
        await this.closeTask(held);
        answer = { ok: true };
        break;
      case "inf:session:clean-files":
        if (held.session || held.opening || held.state.running || !held.state.closed)
          throw new Error("This task's conversation is not closed here yet.");
        answer = await this.options.tasks.removeLeftovers(held.task);
        break;
      case "inf:session:clean-temp":
        if (held.session || held.opening || held.state.running || !held.state.closed)
          throw new Error("This task's conversation is not closed here yet.");
        answer = await this.options.tasks.removeOwnedTemp(held.task);
        break;
      case "inf:session:remove":
        // Nothing is remembered: its orders go with its folder, and asked
        // again it finds nothing left to remove.
        this.removeTask(held);
        return { ok: true };
      default:
        throw new Error(`${channel} is not a request this computer answers.`);
    }
    this.remember(held, fields.orderId, answer);
    return answer;
  }

  /** An applied order and its answer, kept for this conversation's life. */
  private remember(held: Held, orderId: string, answer: unknown): void {
    if (held.orders.has(orderId)) return;
    held.orders.set(orderId, answer);
    this.options.tasks.applied(held.task, orderId, answer);
  }

  private roster(): WorkOrderResponse<"inf:session:roster"> {
    const open = [...this.held.values()].filter((held) => held.session).map((held) => held.task);
    const copies = this.options.copies;
    const tasks = new Set([...this.options.tasks.list(), ...open, ...(copies?.list() ?? [])]);
    return {
      tasksDir: this.options.tasks.tasksDir,
      ...(copies ? { worktreesDir: copies.worktreesDir } : {}),
      ...(this.options.browsers ? { browsers: true } : {}),
      tasks: [...tasks].sort().map((task) => {
        const held = this.hold(task);
        const state = held.session ? this.stateOf(held) : undefined;
        return {
          task,
          open: held.session !== null,
          closed: held.state.closed,
          ...(held.state.running ? { running: held.state.running } : {}),
          seq: held.state.seq,
          ...(state ? { state } : {}),
          ...(copies ? { workingCopy: copies.has(task) } : {}),
        };
      }),
    };
  }

  /**
   * An order about a task's working copy (docs/helper.md, "Its working
   * copies"). Those that act carry an id and are answered as they were when
   * asked again; they run beside the conversation's own orders, so a long
   * clone or install never holds a steer or an abort.
   */
  private async workingCopy(channel: WorkOrderChannel, request: unknown): Promise<unknown> {
    const copies = this.options.copies;
    if (!copies) throw new Error("This computer keeps no working copies.");
    switch (channel) {
      case "inf:working-copy:source-ref": {
        const [source] = request as WorkOrderRequest<"inf:working-copy:source-ref">;
        const file = `${this.options.tasks.folders(source.task).sourceCards}/${source.name}`;
        return copies.sourceRef(source, file);
      }
      case "inf:working-copy:revision": {
        const [{ task, headSha }] = request as WorkOrderRequest<"inf:working-copy:revision">;
        return copies.revision(task, headSha);
      }
      case "inf:working-copy:status": {
        const [{ task }] = request as WorkOrderRequest<"inf:working-copy:status">;
        return copies.status(task);
      }
      case "inf:working-copy:read": {
        const [{ task, ref, offset }] = request as WorkOrderRequest<"inf:working-copy:read">;
        return copies.read(task, ref, offset);
      }
      case "inf:working-copy:bundle": {
        const [{ task, ref, have }] = request as WorkOrderRequest<"inf:working-copy:bundle">;
        return copies.bundle(task, ref, have);
      }
      case "inf:working-copy:seed": {
        const [seed] = request as WorkOrderRequest<"inf:working-copy:seed">;
        return copies.seed(seed);
      }
      case "inf:working-copy:artifact": {
        const [piece] = request as WorkOrderRequest<"inf:working-copy:artifact">;
        return copies.artifact(piece);
      }
      default:
        break;
    }
    const [fields] = request as [{ task: string; orderId: string }];
    const held = this.hold(fields.task);
    const saved = held.orders.get(fields.orderId);
    const retryingPreparation = channel === "inf:working-copy:prepare" && preparationUnknown(saved);
    if (held.orders.has(fields.orderId) && !retryingPreparation) return saved;
    const running = held.copying.get(fields.orderId);
    if (running) return running;
    const run = (async () => {
      let answer: unknown;
      switch (channel) {
        case "inf:working-copy:prepare": {
          const [prepare] = request as WorkOrderRequest<"inf:working-copy:prepare">;
          if (held.state.closed)
            throw new Error(
              "This task's conversation was closed here, so it takes no working copy.",
            );
          if (prepare.base && held.state.running)
            throw new Error("The conversation is running; its working copy cannot move yet.");
          // Persist uncertainty before any asynchronous preparation. After a
          // restart a failed reconciliation cannot prove the earlier work ended.
          this.remember(held, fields.orderId, { refused: "preparation-unknown" });
          try {
            answer = await copies.prepare(
              prepare.task,
              prepare.project,
              prepare.seed,
              prepare.base,
            );
          } catch (caught) {
            // The host wants this computer's own sign-in: a typed answer, so
            // the home holds the task for it rather than reading the words
            // of a failure (docs/forge.md, "A computer's own sign-in").
            if (retryingPreparation) {
              answer = { refused: "preparation-unknown" };
              break;
            }
            if (!(caught instanceof ForgeAuthRequiredError)) {
              answer = {
                refused: "preparation-failed",
                message: (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000),
              };
              break;
            }
            const refused: WorkOrderResponse<"inf:working-copy:prepare"> = {
              refused: "forge-sign-in",
              host: caught.host,
              name: "GitHub",
            };
            answer = refused;
          }
          break;
        }
        case "inf:working-copy:install":
          answer = await copies.install(held.task);
          break;
        case "inf:working-copy:keep":
          // Its conversation is closed for good first, so nothing changes the copy after.
          if (held.session || held.opening || held.state.running)
            throw new Error("This task's conversation is still open here.");
          answer = await copies.keep(held.task);
          break;
        case "inf:working-copy:retire": {
          const [retire] = request as WorkOrderRequest<"inf:working-copy:retire">;
          await copies.retire(held.task, retire.kept);
          answer = { ok: true };
          break;
        }
        default:
          throw new Error(`${channel} is not a request this computer answers.`);
      }
      if (channel === "inf:working-copy:prepare" && !preparationUnknown(answer))
        held.orders.delete(fields.orderId);
      this.remember(held, fields.orderId, answer);
      return answer;
    })();
    held.copying.set(fields.orderId, run);
    try {
      return await run;
    } finally {
      held.copying.delete(fields.orderId);
    }
  }

  private async open(held: Held, spec: PlacedSpec): Promise<PlacedState> {
    if (held.state.closed)
      throw new Error("This task's conversation was closed here, so it opens no more.");
    held.speed = spec.speed === true;
    if (held.opening) await held.opening;
    if (held.session) {
      // A turn in progress keeps the tools it started with. An idle
      // conversation whose named tools or instructions changed, because the
      // home reopened it for a contract this computer now speaks, lets go
      // and opens again, so a version-gated tool arrives without a restart here.
      if (held.state.running || !this.contractMoved(held, spec)) {
        this.recordJobs(held, true);
        return this.stateOf(held);
      }
      await this.releaseConversation(held);
    }
    const opening = (async () => {
      const binding = await this.options.bind(spec.binding);
      const factory = this.options.factories[binding.backend];
      if (!factory) throw new Error(`This computer holds no ${binding.backend} conversations.`);
      if (this.options.copies && !this.options.copies.has(held.task))
        throw new Error("This task has no working copy here yet.");
      const folders = this.options.tasks.ensure(held.task);
      const instructions = spec.instructions;
      // Pi records belong to this task's sessions folder, never a path a
      // home cached before an update. Claude's token is its session id.
      const token =
        spec.resume && binding.backend === "pi"
          ? join(folders.sessions, basename(spec.resume))
          : spec.resume;
      const resume = crewmateResume(token, binding.backend);
      // Its own browser, here beside its shell, when the home says it has one.
      const granted = spec.browser ? this.options.browsers?.grant(held.task) : undefined;
      const tools = bindTools(
        (
          this.options.tools ?? CREWMATE_TOOLS.filter((tool) => FORWARDED_TOOLS.has(tool.name))
        ).filter((tool) => spec.tools.includes(tool.name)),
        {
          ...this.delegate(held, folders),
          ...(granted ? { browser: granted.browser } : {}),
        },
      );
      const sessionSpec: SessionSpec = {
        machine: LOCAL_MACHINE_ID,
        owner: held.task,
        cwd: folders.work,
        binding,
        ...(spec.model ? { model: spec.model } : {}),
        speed: {
          requested: async (model) =>
            held.speed
              ? crewSpeedSchema.parse(
                  await this.call(held, "inf:work:speed", {
                    callId: randomUUID(),
                    model: { provider: model.provider, id: model.id },
                  }),
                )
              : "standard",
          record: (model, selection) => {
            if (!held.speed) return;
            void this.call(held, "inf:work:speed-note", {
              callId: randomUUID(),
              model: { provider: model.provider, id: model.id },
              selection,
            }).catch((error: unknown) =>
              this.log(`speed could not be recorded: ${messageOf(error)}`),
            );
          },
        },
        thinking: {
          level: spec.thinking.level,
          ...(spec.thinking.quick ? { quick: true } : {}),
        },
        instructions: { base: instructions },
        ...(spec.personalResources !== undefined
          ? { personalResources: spec.personalResources }
          : {}),
        builtins: "coding",
        tools,
        ...(granted ? { shell: granted.shell } : {}),
        shape: {
          turns: "rolling",
          record: {
            dir: folders.sessions,
            ...(resume ? { resume } : {}),
            // Stamped here, on the tools this computer serves.
            stamp: crewmateContractStamp(instructions, tools),
          },
        },
        bounds: { request: { retries: spec.retries ?? RETRIES } },
      };
      const session = await factory.open(sessionSpec);
      if (this.stopped) {
        session.dispose();
        throw new Error("This computer is stopping.");
      }
      held.session = session;
      held.opened = {
        tools: spec.tools,
        instructions: spec.instructions,
        browser: spec.browser === true,
      };
      held.backend = binding.backend;
      held.account = this.options.accounts?.of(binding);
      held.renewal = session.takeRenewal();
      held.unsubscribe = session.subscribe((event) => {
        // A cut-off is a fact about the account that served the turn: this
        // computer's own, kept in its own store and never the home's.
        if (event.type === "turn_failed" && event.cutOff && held.account)
          this.options.accounts?.noteCutOff(held.account, event.cutOff);
        if (event.type === "background_work_changed") {
          // The home hears the count, as before; the tasks stay here.
          this.record(held, { type: "background_work_changed", count: event.count });
          // A client that ended (`count` unknown) took what it ran with it.
          if (event.count === undefined) this.clientEnded(held);
          else this.keepClientTasks(held, event.tasks ?? []);
          return;
        }
        this.record(held, event);
      });
      this.recordJobs(held, true);
    })();
    held.opening = opening;
    try {
      await opening;
    } finally {
      held.opening = null;
    }
    return this.stateOf(held);
  }

  /** Whether this open names tools or instructions the held conversation was not opened with. */
  private contractMoved(held: Held, spec: PlacedSpec): boolean {
    const opened = held.opened;
    if (!opened) return false;
    return (
      !sameNames(opened.tools, spec.tools) ||
      opened.instructions !== spec.instructions ||
      opened.browser !== (spec.browser === true)
    );
  }

  /** Lets an idle conversation go so a later open can bind the tools this spec names. */
  private async releaseConversation(held: Held): Promise<void> {
    held.unsubscribe?.();
    held.unsubscribe = null;
    const session = held.session;
    held.session = null;
    held.opened = undefined;
    held.renewal = undefined;
    held.backend = null;
    if (!session) return;
    // Its client ends now, and what it ran in the background with it.
    this.clientEnded(held);
    session.dispose();
    await session.closed().catch(() => undefined);
  }

  private prompt(
    held: Held,
    orderId: string,
    text: string,
    images: WorkOrderRequest<"inf:session:prompt">[0]["images"],
  ): { turn: number } {
    const session = this.conversation(held);
    if (held.state.running) throw new Error("A turn is already running here.");
    const turn = held.state.turn + 1;
    held.state = {
      ...held.state,
      turn,
      running: { turn, orderId },
    };
    this.record(held, { type: "turn_started", turn, orderId });
    this.writeOut(held);
    // Kept before the turn starts: asked again after a quit here, it is
    // answered and never started twice; that turn ended `interrupted`.
    this.remember(held, orderId, { turn });
    session.prompt(text, images).then(
      () => this.ended(held, turn, "done"),
      (error: unknown) => this.ended(held, turn, "failed", messageOf(error)),
    );
    return { turn };
  }

  private ended(held: Held, turn: number, outcome: "done" | "failed", error?: string): void {
    // Closed, or this computer stopped, first: that turn already ended.
    if (held.state.running?.turn !== turn || !held.session) return;
    const undelivered = held.session.takeUndeliveredSteers();
    held.state = { ...held.state, running: undefined };
    // The home told the crewmate why with this turn's prompt, so a home
    // that opens it again later hears of no move.
    if (outcome === "done") held.renewal = undefined;
    this.record(held, {
      type: "turn_ended",
      turn,
      outcome,
      ...(error !== undefined ? { error } : {}),
      undelivered,
      state: this.stateOf(held),
    });
    this.writeOut(held);
  }

  private async closeTask(held: Held): Promise<void> {
    if (held.state.closed) return;
    if (held.opening) await held.opening.catch(() => undefined);
    if (held.state.running) {
      const { turn } = held.state.running;
      held.state = { ...held.state, running: undefined };
      this.record(held, { type: "turn_ended", turn, outcome: "interrupted", undelivered: [] });
    }
    held.state = { ...held.state, closed: true };
    this.writeOut(held);
    held.unsubscribe?.();
    held.unsubscribe = null;
    const session = held.session;
    held.session = null;
    this.options.killJobs?.(held.task);
    // Its client's background tasks end with it, and nobody waits on them.
    this.keepClientTasks(held, []);
    // Its browser goes with it, copying a saved sign-in back as any stop does.
    this.options.browsers?.close(held.task);
    if (session) {
      session.dispose();
      await session.closed();
    }
  }

  /**
   * The task's folder goes, for a task its home no longer records here:
   * only once its conversation is closed for good and its working copy is
   * gone, so nothing it holds is still in use or holds work.
   */
  private removeTask(held: Held): void {
    const copies = this.options.copies;
    // Without working copies, the crewmate's working folder is inside it.
    if (!copies) throw new Error("This computer keeps a task's work in its folder.");
    if (held.session || held.opening || held.state.running)
      throw new Error("This task's conversation is still open here.");
    if (copies.has(held.task)) throw new Error("This task's working copy is still here.");
    const tasks = this.options.tasks;
    // No folder is one removed already, or never made.
    if (tasks.has(held.task) && !held.state.closed)
      throw new Error("This task's conversation is not closed here yet.");
    held.removed = true;
    held.outbox = [];
    held.unwritten = [];
    this.held.delete(held.task);
    // Nobody waits on events that are no longer anywhere.
    for (const flush of held.flushes.splice(0)) flush.resolve();
    tasks.remove(held.task);
  }

  /** The open conversation, or why an order for it cannot be done. */
  private conversation(held: Held): ModelSession {
    if (!held.session) throw new Error("No conversation is open for this task here.");
    return held.session;
  }

  private stateOf(held: Held): PlacedState {
    const session = this.conversation(held);
    const resume = crewmateResumeToken(session.resume());
    const record = recordName(this.options.tasks.folders(held.task).sessions, session.recordPath());
    const model = session.modelRef();
    const modelLabel = session.modelLabel();
    const reasoning = session.reasoning();
    return {
      sessionId: session.sessionId,
      backend: held.backend ?? "pi",
      controlProfile: session.controlProfile,
      streaming: session.isStreaming(),
      ...(resume ? { resume } : {}),
      ...(record ? { record } : {}),
      ...(model ? { model } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(held.renewal ? { renewal: { ...held.renewal, changed: [...held.renewal.changed] } } : {}),
      ...(held.account ? { accountId: held.account } : {}),
    };
  }

  /**
   * The callbacks a crewmate's tools run on here: each asks the home, after
   * every event the conversation wrote before it, so the home hears them in
   * the order they happened.
   */
  private delegate(held: Held, folders: ReturnType<PlacedTasks["folders"]>): CrewmateToolDelegate {
    const text = async (channel: WorkInvokeChannel, fields: object, signal?: AbortSignal) =>
      toolTextSchema.parse(
        await this.call(held, channel, { callId: randomUUID(), ...fields }, signal),
      ).text;
    const ask = (channel: WorkInvokeChannel, fields: object, toolSignal?: AbortSignal) =>
      this.withDeadline(channel, (deadline) => text(channel, fields, deadline), toolSignal);
    const sendPictures = async (pictures: readonly CardPicture[], signal: AbortSignal) => {
      // Each picture's bytes first, so the home holds them when it shows the card.
      for (const picture of pictures) {
        const { extension, data } = this.options.tasks.picture(held.task, picture.id);
        await this.call(
          held,
          "inf:work:picture",
          {
            callId: randomUUID(),
            id: picture.id,
            extension,
            data: data.toString("base64"),
          },
          signal,
        );
        // A poster's recording follows it, a piece at a time.
        if (!picture.demo) continue;
        const { id, kind } = picture.demo;
        const recording = this.options.tasks.recording(held.task, id, kind);
        for (let offset = 0; offset < recording.length; offset += CARD_MEDIA_PIECE_BYTES) {
          await this.call(
            held,
            "inf:work:media",
            {
              callId: randomUUID(),
              id,
              extension: kind,
              offset,
              size: recording.length,
              data: recording.subarray(offset, offset + CARD_MEDIA_PIECE_BYTES).toString("base64"),
            },
            signal,
          );
        }
      }
    };
    return {
      taskId: held.task,
      cwd: folders.work,
      picturesDir: folders.cards,
      cardBodiesDir: folders.cardBodies,
      evidenceDir: folders.evidence,
      ...(this.options.probeMedia ? { probeMedia: this.options.probeMedia } : {}),
      ...(this.options.probeTypeface ? { probeTypeface: this.options.probeTypeface } : {}),
      onCard: (card, toolSignal) =>
        this.withDeadline(
          "inf:work:card",
          async (signal) => {
            // A card whose preview names a project font of this task's own goes
            // only to a home that keeps one: an older home is told nothing, not
            // even the card's pictures.
            const typefaces = cardTypefaceNames(card.body).flatMap((name) => {
              const typeface = parseCardTypefaceFileName(name);
              return typeface?.taskId === held.task ? [typeface] : [];
            });
            const home = this.options.homeVersion?.() ?? null;
            if (typefaces.length > 0 && home !== null && !keepsCardTypefaces(home)) {
              throw new Error(
                `Card font refused: ${HOME.the} runs an older Infinitary that cannot show a project's fonts; draw the preview in the app's own typefaces until it is updated.`,
              );
            }
            // Each picture's bytes first, so the home holds them when it shows the card.
            await sendPictures(card.pictures ?? [], signal);
            // Each project font its preview names, before the card too.
            for (const typeface of typefaces) {
              await this.call(
                held,
                "inf:work:typeface",
                {
                  callId: randomUUID(),
                  id: typeface.id,
                  extension: typeface.kind,
                  data: this.options.tasks
                    .typeface(held.task, typeface.fileName)
                    .toString("base64"),
                },
                signal,
              );
            }
            const answer = placedCardAnswerSchema.parse(
              await this.call(held, "inf:work:card", { callId: randomUUID(), card }, signal),
            );
            if ("refused" in answer)
              throw new CardRefusedError(
                answer.refused.message,
                answer.refused.reason,
                answer.refused.why,
              );
            return answer.cardId;
          },
          toolSignal,
        ),
      onCardRefused: (refusal) => {
        // A refusal record is not the card's request, so the card's cancellation does not reach it.
        void this.call(held, "inf:work:card-refused", { callId: randomUUID(), refusal }).catch(
          (error: unknown) => this.log(`a refused card was not recorded: ${messageOf(error)}`),
        );
      },
      onCloseCard: (input, signal) => ask("inf:work:close-card", input, signal),
      onFollowup: (input, signal) => ask("inf:work:followup", { input }, signal),
      onProgress: (note, plan, signal) =>
        ask("inf:work:progress", { text: note, ...(plan !== undefined ? { plan } : {}) }, signal),
      onReport: (report, summary, declared, signal) =>
        ask(
          "inf:work:report",
          {
            text: report,
            ...(summary !== undefined ? { summary } : {}),
            ...(declared !== undefined ? { declared } : {}),
          },
          signal,
        ),
      onReply: (input, signal) => ask("inf:work:reply", input, signal),
      onQueryTasks: (input, toolSignal) =>
        this.withDeadline(
          "inf:work:tasks",
          async (signal) => {
            const answer = tasksAnswerSchema.parse(
              await this.call(held, "inf:work:tasks", { callId: randomUUID(), input }, signal),
            );
            return { rows: answer.rows as TaskQueryRow[], total: answer.total };
          },
          toolSignal,
        ),
      onReadWorkflow: (input, signal) => ask("inf:work:read-workflow", { input }, signal),
      onGithubRead: (input, signal) => ask("inf:work:github-read", { input }, signal),
      onGithubWrite: (input, signal) => {
        if (input.file !== undefined) return Promise.resolve(PLACED_RELEASE_FILE_REFUSAL);
        return ask("inf:work:github-write", { input }, signal);
      },
      // The home opens, checks and merges with its own sign-in, once it has
      // brought the branch home; an artifact is written here before it answers.
      onPrepareChange: (story, toolSignal) =>
        this.withDeadline(
          "inf:work:prepare-change",
          async (signal) => {
            try {
              await sendPictures(story.pictures, signal);
              return await text("inf:work:prepare-change", { input: story }, signal);
            } finally {
              await this.options.tasks
                .discardCardCopies(
                  held.task,
                  story.assets.map((asset) => asset.file),
                )
                .catch(() => {
                  console.warn("Could not remove transferred story staging copies", held.task);
                });
            }
          },
          toolSignal,
        ),
      onOpenChange: (input, signal) => ask("inf:work:open-change", { input }, signal),
      onCheckChange: (input, signal) =>
        ask("inf:work:check-change", { input: input ?? {} }, signal),
      onDownloadArtifact: (input, signal) => ask("inf:work:download-artifact", { input }, signal),
      // The home's knowledge, read and written there as for a crewmate of its own.
      knowledge: {
        read: (input, signal) => ask("inf:work:knowledge", { input }, signal),
        record: (input, signal) => ask("inf:work:record-knowledge", { input }, signal),
      },
    };
  }

  /**
   * One deadline spans all requests in a callback, including its asset transfers.
   * The tool's own cancellation, when it passed one, ends them too.
   */
  private async withDeadline<T>(
    channel: WorkInvokeChannel,
    run: (signal: AbortSignal) => Promise<T>,
    toolSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLACED_REQUEST_WAIT_MS);
    const signal = toolSignal
      ? AbortSignal.any([controller.signal, toolSignal])
      : controller.signal;
    try {
      return await run(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      const days = PLACED_REQUEST_WAIT_MS / (24 * 60 * 60 * 1000);
      const ended = controller.signal.aborted
        ? `The request waited ${days} days for ${HOME.the}`
        : `The conversation stopped waiting for ${HOME.the}`;
      const sent = error instanceof WorkRequestAbortedError && error.everSent;
      if (invokeContract[channel].effect === "read")
        throw new Error(
          sent
            ? `${ended}; the request was sent, but its answer did not arrive. You can ask for the read again.`
            : `${ended}; the request was not sent. It will not be sent when ${HOME.the} returns. You can ask again.`,
        );
      throw sent
        ? new OutcomeUnknownError(
            `${ended}; the change may already be done. ${changeRecoveryCheck(channel)}`,
          )
        : new Error(
            `${ended}; the change was not sent. It will not be sent when ${HOME.the} returns. You can ask again.`,
          );
    } finally {
      clearTimeout(timer);
    }
  }

  /** One work request, after prior events reach the home, within its callback's deadline. */
  private async call(
    held: Held,
    channel: WorkInvokeChannel,
    fields: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!signal)
      return this.withDeadline(channel, (deadline) => this.call(held, channel, fields, deadline));
    signal.throwIfAborted();
    await this.flushed(held, signal);
    signal.throwIfAborted();
    try {
      return await this.options.ask(channel, [{ task: held.task, ...fields }], signal);
    } catch (error) {
      if (!(error instanceof WorkRequestAbortedError)) throw error;
      const finalRequest = !requestRepeatsSafely(channel);
      throw new WorkRequestAbortedError(finalRequest && error.everSent, error.cause);
    }
  }

  private hold(task: string): Held {
    return this.held.get(task) ?? this.load(task);
  }

  private load(task: string): Held {
    const tasks = this.options.tasks;
    const state = tasks.state(task);
    const outbox = tasks.outbox(task, state.kept);
    const seq = Math.max(state.seq, outbox.at(-1)?.seq ?? 0, state.kept);
    // Older folders have the boundaries in their outbox but no state flag yet.
    const continuing = outbox.reduce(
      (active, { event }) =>
        event.type === "continuation_started"
          ? true
          : event.type === "continuation_ended"
            ? false
            : active,
      state.continuing === true,
    );
    const held: Held = {
      task,
      state: { ...state, seq, continuing: continuing ? true : undefined },
      session: null,
      speed: false,
      backend: null,
      jobs: undefined,
      clientTasks: new Map(),
      account: undefined,
      renewal: undefined,
      opening: null,
      unsubscribe: null,
      orders: tasks.orders(task),
      outbox,
      unwritten: [],
      through: state.kept,
      sending: false,
      refused: false,
      flushes: [],
      chain: Promise.resolve(),
      copying: new Map(),
      removed: false,
      opened: undefined,
    };
    this.held.set(task, held);
    return held;
  }

  /** This computer owns the terminal boundary when its client cannot send one. */
  private interruptContinuation(held: Held): void {
    if (held.state.closed || !held.state.continuing) return;
    this.record(held, {
      type: "continuation_ended",
      interrupted: true,
      // Older homes can still read a plain error when they ignore the new marker.
      error: "Work stopped before the turn finished.",
    });
  }

  /** One thing the conversation did, numbered, kept until the home keeps it, and sent. */
  private record(held: Held, event: SessionEvent | PlacedEvent): void {
    const seq = held.state.seq + 1;
    held.state = {
      ...held.state,
      seq,
      ...(event.type === "continuation_started" ? { continuing: true as const } : {}),
      ...(event.type === "continuation_ended" ? { continuing: undefined } : {}),
    };
    const record: PlacedEventRecord = { seq, at: this.now(), event: event as PlacedEvent };
    held.outbox.push(record);
    held.unwritten.push(record);
    // Keep the boundary even if the home acknowledges and trims its outbox entry.
    if (event.type === "continuation_started" || event.type === "continuation_ended")
      this.writeOut(held);
    // A burst of words is one write.
    if (!this.writeTimer)
      this.writeTimer = setImmediate(() => {
        this.writeTimer = undefined;
        for (const each of this.held.values()) this.writeEvents(each);
      });
    this.pump(held);
  }

  private writeEvents(held: Held): void {
    if (held.unwritten.length === 0 || held.removed) return;
    const records = held.unwritten;
    held.unwritten = [];
    try {
      this.options.tasks.append(held.task, records);
    } catch (error) {
      this.log(`could not keep ${held.task}'s events: ${messageOf(error)}`);
    }
  }

  /** The events and the state, on disk now. */
  private writeOut(held: Held): void {
    if (held.removed) return;
    this.writeEvents(held);
    try {
      this.options.tasks.writeState(held.task, held.state);
    } catch (error) {
      this.log(`could not keep ${held.task}'s state: ${messageOf(error)}`);
    }
  }

  /** Sends the next events the home does not have, one request at a time. */
  private pump(held: Held): void {
    if (held.sending || held.refused || held.removed || this.stopped || !this.live) return;
    const from = Math.max(held.through, held.state.kept);
    const batch = held.outbox
      .filter((record) => record.seq > from)
      .slice(0, PLACED_EVENTS_MAX_PER_REQUEST);
    if (batch.length === 0) {
      this.settleFlushes(held);
      return;
    }
    // On disk before it is sent: what the home has not kept survives a quit.
    this.writeEvents(held);
    held.sending = true;
    this.options
      .ask("inf:work:events", [{ task: held.task, events: batch }])
      .then(
        (raw) => {
          // Stopping first: the run that starts next from this folder may
          // already have gone on, so this answer writes nothing over it; that
          // run sends again what the home had not kept, and the home skips
          // what it has (INF-151).
          if (held.removed || this.stopped) return;
          const answer = placedEventsAnswerSchema.parse(raw);
          held.through = Math.min(answer.through, held.state.seq);
          const kept = Math.min(answer.kept, held.state.seq);
          if (kept > held.state.kept) {
            held.state = { ...held.state, kept };
            held.outbox = held.outbox.filter((record) => record.seq > kept);
            this.writeEvents(held);
            try {
              this.options.tasks.trim(held.task, kept);
              this.options.tasks.writeState(held.task, held.state);
            } catch (error) {
              this.log(`could not forget ${held.task}'s kept events: ${messageOf(error)}`);
            }
          }
        },
        (error: unknown) => {
          if (this.stopped) return;
          held.refused = true;
          this.log(`the home refused ${held.task}'s events: ${messageOf(error)}`);
        },
      )
      .finally(() => {
        held.sending = false;
        this.settleFlushes(held);
        this.pump(held);
      });
  }

  /** Resolves once the home has every event written before now, or refused them. */
  private flushed(held: Held, signal?: AbortSignal): Promise<void> {
    const seq = held.state.seq;
    if (held.through >= seq || held.refused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        held.flushes = held.flushes.filter((entry) => entry !== flush);
        reject(signal?.reason);
      };
      const flush = {
        seq,
        resolve: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      held.flushes.push(flush);
      this.pump(held);
    });
  }

  private settleFlushes(held: Held): void {
    const waiting = held.flushes;
    held.flushes = [];
    for (const flush of waiting) {
      if (held.refused || held.through >= flush.seq) flush.resolve();
      else held.flushes.push(flush);
    }
  }
}

/** A record's path under its task's `sessions` folder, slash-separated; none outside it. */
function recordName(sessions: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = relative(sessions, path);
  if (!name || name.startsWith("..") || isAbsolute(name)) return undefined;
  return name.split(sep).join("/");
}

function preparationUnknown(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "refused" in value &&
    value.refused === "preparation-unknown"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
