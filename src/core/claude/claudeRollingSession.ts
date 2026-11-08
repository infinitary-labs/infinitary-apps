import { randomUUID } from "node:crypto";
import { type Query, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { PROGRESS_TOOL_NAMES } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import { outputCapErrorMessage, type SessionClock } from "../session/bounds";
import { type PersonalResourceDigests, personalResources } from "../session/personalResources";
import { projectSkillFolders } from "../session/projectResources";
import {
  type ContractStamp,
  type ModelSession,
  type SafeStopOptions,
  type SafeStopOutcome,
  type SessionEvent,
  type SessionImage,
  type SessionRenewal,
  type SessionResume,
  type SessionSpec,
  StoppedBeforeStartError,
  type ThinkingLevel,
} from "../session/session";
import { claimStagingFolder, type StagingFolder } from "../session/stagingFolders";
import type { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import {
  type ClaudeNormalizeResult,
  type ClaudeTurnFailure,
  createNormalizerState,
} from "./claudeEvents";
import { canonicalClaudeModelId } from "./claudeModelCatalog";
import { claudeModelName } from "./claudeModels";
import { type ClaudeProjectResources, claudeProjectResources } from "./claudeProjectResources";
import {
  CLAUDE_CONTROL_PROFILE,
  CLAUDE_MODEL_PROVIDER,
  ClaudeQueryCore,
  type ClaudeSessionDeps,
  MessageQueue,
  noteTo,
  refuseMissingClient,
  userMessage,
} from "./claudeQueryCore";
import { ClaudeSafeStop } from "./claudeSafeStop";
import { CLAUDE_STEER_PRIORITY, claudeSessionOptions } from "./claudeSessionOptions";
import { ClaudeSessionRecord, type Pushed, sha256 } from "./claudeSessionRecord";
import { acquireSessionLease } from "./claudeStoreLease";
import type { ClaudeTranscriptLookup } from "./claudeTranscript";
import { claudeCodingReasoning } from "./reasoning";

/** The progress a shortening of the conversation reports itself by, as Pi's does. */
const [FOLD_TOOL] = PROGRESS_TOOL_NAMES;

/**
 * The rolling Claude session: one conversation across prompts, steers and
 * client attachments, for the seat and the crewmate (`session.ts` says how
 * the shape is served). Its durable record is `ClaudeSessionRecord`, its
 * safe stop `ClaudeSafeStop`, and the options each attachment hands the
 * client `claudeSessionOptions`.
 */

/** What a prompt or steer on a disposed rolling session is told. */
const ENDED_TEXT = "This Claude session has ended.";

/** What a continuation the client's exit cut short, or a prompt it stranded, is told. */
const STOPPED_TEXT = "Claude stopped before the turn finished.";

type Connection = {
  /** The session id this client runs, which a renewal can leave behind. */
  sessionId: string;
  query: Query;
  input: MessageQueue;
  /** The effort the client is serving at right now. */
  effort: ThinkingLevel | "off";
  /** The session is ending this attachment itself; its stream's end is expected. */
  closing: boolean;
  /** When the session ended its input; a client still running a tick later is stopped. */
  closedAt?: number;
  /** Resolves once the stream is over and the lease is back. */
  done: Promise<void>;
  /** Hands this client's lease on the account's store back. */
  release: () => void;
};

/** What a rolling session runs on, resolved at open. */
type RollingConfig = {
  accountId: string;
  env: NodeJS.ProcessEnv;
  /** The app's own record of the session, in the spec's record dir. */
  store: SessionRecordStore;
  stamp: ContractStamp | undefined;
  clock: SessionClock;
};

export class ClaudeRollingSession extends ClaudeQueryCore<SessionEvent> implements ModelSession {
  readonly controlProfile = CLAUDE_CONTROL_PROFILE;
  private connection: Connection | undefined;
  /**
   * The model every attachment asks the client for: the spec's, else the
   * one a resumed session ran on before the client swapped it, else the
   * first one the client reported. Never what the client swapped in, so a
   * reattach or a resume does not keep a refusal fallback on its own.
   */
  private asked: string | undefined;
  /** The model the client last said answers, as Infinitary names it; what the session reports. */
  private answering: string | undefined;
  private instructions: ServedInstructions | undefined;
  /** New instructions wait for the next prompt's attachment. */
  private reopen = false;
  private wantedEffort: ThinkingLevel | "off";
  /** A prompt is in flight, from its call until the client is idle again. */
  private promptOpen = false;
  /** The client is running a turn no prompt asked for, until it is idle again. */
  private continuing = false;
  /** The prompt's message or a continuation is in the client's hands: a steer can join it. */
  private accepting = false;
  private pushed: Pushed[] = [];
  /** Steers that arrived while the client was starting, pushed after the prompt. */
  private early: { text: string; images?: SessionImage[] }[] = [];
  /** Each prompt's number, so a late start of an abandoned one pushes nothing. */
  private generation = 0;
  /** Steers that arrived while no prompt could take them, for the next one. */
  private held: string[] = [];
  /** The client has said something since the prompt was pushed. */
  private ran = false;
  /** The client reports its session state; without it a result settles. */
  private statesSeen = false;
  /**
   * Where the client's own shortening of the conversation stands: running
   * from its compacting status, ended once one of its two end signals (the
   * status's result or the compact boundary) is heard and until the other.
   */
  private folding: "idle" | "running" | "ended" = "idle";
  private acksSeen = false;
  /** This prompt already reported a failure. */
  private failed = false;
  /** The failure an `abort(failure)` asked the cut turn to report, and when it asked. */
  private cut: { message: string; at: number } | undefined;
  /** When the client was first asked to interrupt the running turn, until that turn answers. */
  private interruptedAt: number | undefined;
  /** Run once the open prompt settles: a dispose or a detach waiting for it. */
  private afterSettle: (() => void)[] = [];
  private disposing = false;
  /** The last settled prompt's messages, where `servedState` locates them. */
  private served: Pushed[] | undefined;
  /** The session is gone: its client has exited and its store is free. */
  private retired = false;
  /** The session this one started over from, until the owner takes it. */
  private renewal: SessionRenewal | undefined;
  /** The client took a prompt under the current id: a reattach resumes it. */
  private tookPrompt = false;
  private readonly retirement: { promise: Promise<void>; resolve: () => void };
  private readonly record: ClaudeSessionRecord;
  private readonly safeStop = new ClaudeSafeStop(() => void this.interrupt());

  constructor(
    private id: string,
    private readonly spec: SessionSpec,
    private readonly config: RollingConfig,
    private readonly deps: ClaudeSessionDeps,
    private readonly unregister: () => void,
    transcripts: ClaudeTranscriptLookup,
  ) {
    super(spec.owner);
    this.record = new ClaudeSessionRecord(config.store, transcripts, config.clock, (line) =>
      this.note(line),
    );
    this.asked = spec.model?.id;
    this.instructions = spec.instructions.served;
    // Coding care is fixed at open; only the seat changes effort per turn.
    this.wantedEffort = spec.thinking.quick ? "off" : spec.thinking.level;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.retirement = { promise, resolve };
  }

  /** Resolves once the session is disposed, its client has exited and the account's store is free. */
  closed(): Promise<void> {
    return this.retirement.promise;
  }

  /** The id the client runs under: the resumed one, or the one a renewal minted. */
  get sessionId(): string {
    return this.id;
  }

  resume(): SessionResume {
    return { backend: "claude", sessionId: this.sessionId };
  }

  /** The app's copy of the client's transcript: the session's durable record. */
  recordPath(): string;
  recordPath(options: { refresh?: boolean }): string | Promise<string>;
  recordPath(options?: { refresh?: boolean }): string | Promise<string> {
    const path = this.config.store.transcriptPath(this.sessionId);
    const pending = options?.refresh
      ? this.record.bringUp(this.connection?.sessionId ?? this.id)
      : undefined;
    return pending ? pending.then(() => path) : path;
  }

  isStreaming(): boolean {
    return this.promptOpen || this.continuing;
  }

  modelRef(): { provider: string; id: string } | undefined {
    const id = this.answering ?? this.asked;
    return id ? { provider: CLAUDE_MODEL_PROVIDER, id } : undefined;
  }

  modelLabel(): string | undefined {
    return claudeModelName(this.answering ?? this.asked);
  }

  prompt(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposing) return Promise.reject(new Error(ENDED_TEXT));
    if (this.isStreaming()) {
      // Overwriting the running turn would orphan whoever awaits it; work
      // for a running turn belongs in steer().
      return Promise.reject(new Error("This session is still working on its current turn."));
    }
    this.promptOpen = true;
    this.generation += 1;
    this.pushed = [];
    this.early = [];
    this.ran = false;
    this.failed = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.served = undefined;
    return new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
      void this.start(this.generation, text, images);
    });
  }

  /** Attach, set the turn's effort, then hand the client the prompt and any steer that waited. */
  private async start(generation: number, text: string, images?: SessionImage[]): Promise<void> {
    let connection: Connection;
    try {
      connection = await this.attach(generation);
      await this.applyEffort(connection);
    } catch (caught) {
      if (generation === this.generation) this.finish(caught);
      return;
    }
    // An abort may have given up on this prompt while the client started.
    if (generation !== this.generation || !this.promptOpen) return;
    // A safe stop came while the client started: the client never takes
    // the prompt, whose input goes again.
    if (this.safeStop.cut) {
      this.finish(new StoppedBeforeStartError());
      return;
    }
    this.accepting = true;
    this.push(connection, "prompt", text, images);
    for (const steer of this.early.splice(0)) {
      this.push(connection, "steer", steer.text, steer.images);
    }
    // A dispose that came while the client started ends this turn early too.
    if (this.disposing) void this.interrupt();
    else void this.readAhead();
  }

  /** A seat's record is read ahead of its turns' ends (`ClaudeSessionRecord.readAhead`); a coding session's owner never asks. */
  async readAhead(): Promise<void> {
    if (this.spec.builtins === "coding") return;
    const sessionId = this.sessionId;
    await this.record.readAhead(sessionId, () => sessionId === this.sessionId && !this.retired);
  }

  /** Honored when the spec asked for a per-turn level (WI-13). */
  setThinkingLevel(level: ThinkingLevel): void {
    if (!this.spec.thinking.perTurn) return;
    this.wantedEffort = level;
  }

  /** A coding session's effort is set once, on its opening query. */
  reasoning(): Reasoning | undefined {
    return this.spec.builtins === "coding" && this.spec.model
      ? claudeCodingReasoning(this.spec)
      : undefined;
  }

  serveInstructions(instructions: ServedInstructions): void {
    if (this.instructions?.sha === instructions.sha) return;
    // Never mid-turn: a change waits for the next prompt's own boundary. A
    // prompt cannot be patched in place, so the next prompt reattaches -
    // under a new id when the client has recorded this one (`renewIfChanged`).
    if (this.isStreaming()) return;
    this.instructions = instructions;
    this.reopen = true;
    this.renewIfChanged();
    void this.stampContract().catch((error: unknown) =>
      this.note(`the contract stamp was not written: ${String(error)}`),
    );
  }

  takeRenewal(): SessionRenewal | undefined {
    const renewal = this.renewal;
    this.renewal = undefined;
    return renewal;
  }

  /**
   * Start over under a new id when the prompt array this session would serve
   * is not the one its client started under (`changedSinceStart` says when).
   * The app's copy of the old session stays; a client still attached exits
   * at the next attach and its copy is finished under its own id.
   */
  renewIfChanged(): void {
    const changed = this.record.changedSinceStart(
      this.id,
      this.config.stamp,
      this.instructions?.sha,
      this.tookPrompt,
    );
    if (changed) this.renewFor(changed);
  }

  /** Claude restores its recorded opening prompt; renew when the personal opt-in or files changed. */
  renewPersonalIfChanged(): void {
    if (this.spec.builtins !== "coding" || this.record.clientTranscript(this.id) === null) return;
    const previous = this.record.personalAtStart(this.id);
    const current = this.spec.personalResources
      ? personalResources(
          this.config.env.HOME,
          new Set(projectSkillFolders(this.spec.cwd).map((skill) => skill.name)),
        ).digests
      : undefined;
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.renewFor(["instructions"]);
  }

  private renewFor(changed: ("prompt" | "instructions")[]): void {
    const from = this.id;
    this.record.mirror(from);
    // The old id's entries are never read again; its copy on disk stays.
    this.record.release(from);
    this.id = randomUUID();
    this.tookPrompt = false;
    this.reopen = true;
    this.served = undefined;
    this.renewal = { from, changed };
    this.note(
      `the ${changed.join(" and ")} changed since session ${from} started; starting ${this.id}`,
    );
  }

  /**
   * Into the running turn - a prompt's or a continuation's - at its next
   * step; with no turn to join, held for the owner to take back.
   */
  steer(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposing) return Promise.reject(new Error(ENDED_TEXT));
    const connection = this.connection;
    if (this.safeStop.stopping) {
      // A stopping turn takes nothing more: the owner has it back at its end.
      this.held.push(text);
    } else if (this.accepting && connection) {
      this.push(connection, "steer", text, images);
    } else if (this.promptOpen) {
      // The client is still starting: the steer follows the prompt in.
      this.early.push({ text, ...(images ? { images } : {}) });
    } else {
      this.held.push(text);
    }
    return Promise.resolve();
  }

  takeUndeliveredSteers(): string[] {
    if (this.isStreaming()) return [];
    return this.held.splice(0);
  }

  /**
   * Interrupt the running turn. With a failure (a watched bound's, say), the
   * cut turn reports it as a failed turn. A client that does not answer the
   * interrupt within a tick is stopped, and the turn ends anyway.
   */
  async abort(failure?: string): Promise<void> {
    if (failure !== undefined && this.isStreaming() && !this.cut) {
      this.cut = { message: failure, at: this.config.clock.now() };
    }
    await this.interrupt();
  }

  /** The safe stop (`ModelSession.stopSafely`, `ClaudeSafeStop`); a steer from now on is held for the owner. */
  stopSafely(options: SafeStopOptions = {}): Promise<SafeStopOutcome> {
    return this.safeStop.ask(options, this.isStreaming());
  }

  /** Interrupt the turn the client runs: a prompt's once it holds it, or a continuation. */
  private async interrupt(): Promise<void> {
    const connection = this.connection;
    if (!this.accepting || !connection || connection.closing) return;
    this.interrupting = true;
    this.interruptedAt ??= this.config.clock.now();
    try {
      await connection.query.interrupt();
    } catch (caught) {
      this.note(`interrupt failed: ${String(caught)}`);
    }
  }

  /**
   * Ends input only after a settled turn - an open prompt or continuation
   * is interrupted first - and lets the client exit on its own, which is
   * when it writes the last of its transcript. The store stays leased until
   * it has.
   */
  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const finish = () => {
      this.disposed = true;
      const connection = this.connection;
      if (connection) this.close(connection);
      else this.retire();
    };
    if (this.isStreaming()) {
      this.afterSettle.push(finish);
      void this.interrupt();
    } else {
      finish();
    }
  }

  /**
   * End the client at an idle boundary - after the open prompt or
   * continuation settles, never mid-turn - and hand the account's store
   * back once it has exited. The next prompt reattaches, resuming the
   * session. The owner detaches before anything else may rewrite that store
   * (a sign-in or sign-out) and while the session is benched.
   */
  detach(): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        const connection = this.connection;
        if (!connection) {
          resolve();
          return;
        }
        this.close(connection);
        void connection.done
          .then(() => this.record.refreshMirror(connection.sessionId))
          .then(resolve);
      };
      if (this.isStreaming()) this.afterSettle.push(end);
      else end();
    });
  }

  /**
   * Where the last prompt and its steers landed in the recorded transcript
   * (R2 provenance), read from the app's copy as it stands. The client
   * writes its transcript on its own schedule, so a location it has not
   * written yet is null here; the sidecar's served stamp keeps the ids to
   * find it by once it has.
   */
  servedState(): ServedState | undefined {
    const served = this.served;
    if (!served) return undefined;
    this.record.mirror(this.id);
    return this.record.locate(this.sessionId, served);
  }

  /**
   * One tick of the host's clock. The client writes its transcript on its
   * own schedule, so the tail of a turn can land after the idle boundary
   * copied it; while a client stays attached (a crewmate's does, between
   * prompts), each tick brings the app's copy up to it. Then the client's
   * hygiene.
   */
  tick(now: number): void {
    if (this.connection) this.record.mirror(this.connection.sessionId);
    this.checkClient(now);
  }

  /**
   * A client that has not done what it was asked a tick later is stopped:
   * one still running after its input ended, and one that never answered
   * an interrupt - that turn ends anyway, failed when a failing abort cut it.
   */
  checkClient(now: number): void {
    const connection = this.connection;
    if (
      connection?.closing &&
      connection.closedAt !== undefined &&
      now - connection.closedAt >= TICK_PERIOD_MS
    ) {
      // Its input ended a tick ago and the client is still running: stop it.
      this.close(connection, true);
    }
    // The interrupt never landed within a tick: the client is wedged.
    const asked = this.cut?.at ?? this.interruptedAt;
    if (this.isStreaming() && asked !== undefined && now - asked >= TICK_PERIOD_MS) this.abandon();
  }

  /** Write the spec's contract stamp when it differs from the session's newest one. */
  stampContract(): Promise<void> {
    return this.record.stampContract(this.sessionId, this.config.stamp, this.instructions?.sha);
  }

  private personalDigests: PersonalResourceDigests | undefined;
  /** This session's own folder for the skills its attaches stage, held until it retires. */
  private staging: StagingFolder | undefined;

  /** A coding session's working copy as this attach hands it to the client (`claudeProjectResources`). */
  private async projectResources(): Promise<ClaudeProjectResources | undefined> {
    const shape = this.spec.shape;
    if (this.spec.builtins !== "coding" || shape.turns !== "rolling") return undefined;
    // Attaches take turns, so this session's own folder is rebuilt by one at a time.
    this.staging ??= await claimStagingFolder(shape.record.dir);
    const { project, personalDigests } = await claudeProjectResources(
      this.spec,
      this.config.env.HOME,
      this.staging.dir,
      (line) => this.note(line),
    );
    this.personalDigests = personalDigests;
    return project;
  }

  /**
   * The live attachment, reopened when it ended or new instructions wait,
   * for the prompt numbered `generation`. An attach can outlive its prompt
   * (the bounds give up on it while it waits for a sign-in to finish), so
   * after every wait it checks the prompt is still the one it serves and
   * spawns nothing otherwise: a later attach, a detach or a dispose never
   * has an orphaned client beside it.
   */
  private async attach(generation: number): Promise<Connection> {
    const current = this.connection;
    if (current && !current.closing && !this.reopen) return current;
    if (current) {
      this.close(current);
      await current.done;
    }
    // Whatever the client wrote since the last boundary, before it runs again.
    await this.record.refreshMirror(this.id);
    this.stillServing(generation);
    this.reopen = false;
    const env = this.config.env;
    // The machine's own client (F14), checked at every attachment: refuse
    // with its sentence, before anything is leased, when it is gone or old.
    await refuseMissingClient(this.deps, env);
    this.stillServing(generation);
    // This client holds the account's store for as long as it runs: it
    // refreshes its own login inside the run, and the refresh token behind
    // it is single use. A sign-in in progress is waited out first.
    const release = await acquireSessionLease(this.deps.configDir);
    try {
      this.stillServing(generation);
    } catch (caught) {
      release();
      throw caught;
    }
    // A session the client has recorded resumes; one it has not (no turn
    // yet) starts under the same id.
    const recorded = this.record.clientTranscript(this.id) !== null;
    // A resume that names no model would get back the model the client
    // swapped in (it restores its transcript's last one): ask for the one
    // it swapped out instead.
    if (this.asked === undefined && recorded) this.asked = this.record.swappedFrom(this.id);
    const input = new MessageQueue();
    const project = await this.projectResources();
    const options = claudeSessionOptions({
      spec: this.spec,
      env,
      executable: resolveClaudeExecutable(env),
      stderr: (data) => this.note(data.trimEnd()),
      attachment: {
        ...(this.asked ? { model: this.asked } : {}),
        ...(this.instructions?.text ? { served: this.instructions.text } : {}),
        session: recorded ? { resume: this.sessionId } : { sessionId: this.sessionId },
        ...(project ? { project } : {}),
        toolGate: this.safeStop.toolGate,
      },
    });
    let query: Query;
    try {
      query = (this.deps.query ?? sdkQuery)({ prompt: input, options });
    } catch (caught) {
      release();
      throw caught;
    }
    // A new client starts the normalizer over: its usage counts from zero
    // (the running totals turn its cumulative figures into each turn's
    // delta), and nothing the last client said about its turn - a pushed
    // reading, an error, a tool in flight - classifies this one's.
    this.normalizer = createNormalizerState();
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    const connection: Connection = {
      sessionId: this.id,
      query,
      input,
      effort: this.spec.thinking.quick ? "off" : this.spec.thinking.level,
      closing: false,
      done: Promise.resolve(),
      release,
    };
    this.connection = connection;
    connection.done = this.pumpQuery(query);
    return connection;
  }

  /** Throws, spawning nothing, when the prompt an attach serves is no longer the open one. */
  private stillServing(generation: number): void {
    if (this.disposed) throw new Error(ENDED_TEXT);
    if (generation !== this.generation || !this.promptOpen) {
      throw new Error("The turn ended before Claude attached.");
    }
  }

  /** Per turn (WI-13): the client changes effort from its next request on. */
  private async applyEffort(connection: Connection): Promise<void> {
    if (connection.effort === this.wantedEffort || this.wantedEffort === "off") return;
    const effort = this.wantedEffort;
    try {
      await connection.query.applyFlagSettings({ effortLevel: effort });
      connection.effort = effort;
    } catch (caught) {
      // The turn still runs, at the effort the client has.
      this.note(`effort ${effort} was not applied: ${String(caught)}`);
    }
  }

  private push(
    connection: Connection,
    kind: Pushed["kind"],
    text: string,
    images: SessionImage[] | undefined,
  ): void {
    const uuid = randomUUID();
    this.pushed.push({ uuid, kind, text, acked: false });
    connection.input.push(
      userMessage(text, kind === "steer" ? CLAUDE_STEER_PRIORITY : undefined, images, uuid),
    );
  }

  /**
   * End an attachment: its input ends and the client exits on its own,
   * writing the last of its transcript; `hard` stops it outright (a client
   * that stopped answering).
   */
  private close(connection: Connection, hard = false): void {
    if (!connection.closing) {
      connection.closing = true;
      connection.closedAt = this.config.clock.now();
      connection.input.close();
    }
    if (hard) connection.query.close();
  }

  /** The session is gone: its record is final, the store is free, the clock forgets it. */
  private retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.unregister();
    // Its client has exited: the next session of the task removes the folder.
    this.staging?.release();
    void this.record
      .settled()
      .then(() => this.record.refreshMirror(this.id))
      .then(() => {
        // The session's record is final: its parsed entries are no longer read.
        this.record.release(this.id);
        this.retirement.resolve();
      });
  }

  /**
   * The client's status says when it starts shortening the conversation
   * (`compacting`) and when it stops (another status, with or without a
   * result). Reported the way Pi reports its own: as the shortening's
   * progress.
   */
  private foldStatus(record: { status?: unknown; compact_result?: unknown }): void {
    if (record.status === "compacting") {
      if (this.folding !== "running") this.foldProgress("start");
      this.folding = "running";
      return;
    }
    if (this.folding === "running") {
      this.foldProgress("end", record.compact_result === "failed");
      this.folding = "ended";
    } else if (this.folding === "ended" && record.compact_result !== undefined) {
      this.folding = "idle";
    }
  }

  private foldProgress(edge: "start" | "end", failed = false): void {
    const callId = `${this.taskId}:compaction`;
    if (edge === "start")
      this.emit({ type: "tool_start", taskId: this.taskId, callId, toolName: FOLD_TOOL });
    else
      this.emit({
        type: "tool_end",
        taskId: this.taskId,
        callId,
        toolName: FOLD_TOOL,
        isError: failed,
      });
  }

  protected observe(message: unknown, result: ClaudeNormalizeResult): void {
    const record = message as {
      type?: unknown;
      subtype?: unknown;
      model?: unknown;
      state?: unknown;
      status?: unknown;
      compact_result?: unknown;
      isReplay?: unknown;
      uuid?: unknown;
      event?: { type?: unknown };
    };
    this.safeStop.track(message);
    if (record.type === "system" && record.subtype === "status") this.foldStatus(record);
    if (record.type === "system" && record.subtype === "compact_boundary") {
      // A boundary ends a running shortening; one heard with no start is
      // reported as a start and an end together, so it still shows.
      if (this.folding === "ended") this.folding = "idle";
      else {
        if (this.folding === "idle") this.foldProgress("start");
        this.foldProgress("end");
        this.folding = "ended";
      }
      // Claude's client folds between its own requests; whether more follow
      // is not said.
      this.emit({ type: "context_compacted", turn: "unknown" });
    }
    if (this.spec.builtins === "coding" && result.backgroundJobs !== undefined) {
      this.emit({
        type: "background_work_changed",
        count: result.backgroundJobs,
        tasks: result.backgroundTasks ?? [],
      });
    }
    if (record.type === "system" && record.subtype === "init" && typeof record.model === "string") {
      // A session that named no model keeps the one it opened on.
      this.asked ??= record.model;
      this.serve(record.model);
    }
    // The client moved the session off the model it asked for (a refusal
    // fallback). A subagent's own fallback leaves the session's model as it was.
    if (result.fallback?.scope === "session") this.serve(result.fallback.to, result.fallback);
    if (record.type === "system" && record.subtype === "session_state_changed") {
      this.statesSeen = true;
      if (record.state === "running") {
        // Running with no prompt open is the client resuming on its own.
        if (this.promptOpen) this.ran = true;
        else this.beginContinuation();
      }
      if (record.state === "idle") {
        if (this.promptOpen) {
          if (this.accepting && this.ran) this.finish();
        } else {
          this.endContinuation();
        }
      }
      return;
    }
    if (record.type === "user" && record.isReplay === true && typeof record.uuid === "string") {
      this.acksSeen = true;
      const pushed = this.pushed.find((entry) => entry.uuid === record.uuid);
      if (pushed && !pushed.acked) {
        pushed.acked = true;
        this.emit({
          type: "input_read",
          textSha256: sha256(pushed.text),
        });
      }
    }
    if (record.type === "stream_event" && record.event?.type === "message_start") {
      // One model request begins: the per-inference clock starts over.
      this.emit({ type: "request_started" });
    }
    if (result.rateLimit) this.deps.onRateLimit?.(this.config.accountId, result.rateLimit);
  }

  protected resultFailed(result: ClaudeNormalizeResult, failure: ClaudeTurnFailure): void {
    this.failed = true;
    // An answer that kept running past the spec's output cap is the cap's
    // failure, said in the session's words rather than the client's.
    const cap = this.spec.bounds?.request?.maxOutputTokens;
    this.emit({
      type: "turn_failed",
      taskId: this.taskId,
      error: failure.outputCapped && cap !== undefined ? outputCapErrorMessage(cap) : failure.error,
      ...(failure.cutOff ? { cutOff: failure.cutOff } : {}),
      ...(failure.contextOverflow ? { contextOverflow: true } : {}),
    });
    this.closeTurn(result, undefined);
  }

  protected resultInterrupted(result: ClaudeNormalizeResult): void {
    // An abort with a failure (a watched bound's) interrupted the turn: say
    // it, the way the Pi session rewrites its cut turn. A plain abort ends
    // quietly.
    const cut = this.cut;
    if (cut && !this.failed) {
      this.failed = true;
      this.emit({ type: "turn_failed", taskId: this.taskId, error: cut.message });
    }
    this.closeTurn(result, undefined);
  }

  protected resultClean(result: ClaudeNormalizeResult): void {
    this.deps.onServed?.(this.config.accountId);
    this.closeTurn(result, result.finalText?.trim() || undefined);
  }

  protected streamFailed(caught: unknown, stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream || connection.closing) return;
    const message = caught instanceof Error ? caught.message : String(caught);
    this.note(`the client stopped: ${message}`);
    // The failure was already told; the throw is the same failure ending the stream.
    if (this.continuing) {
      this.endContinuation(this.failed ? undefined : message);
      return;
    }
    if (!this.promptOpen) return;
    if (this.failed) this.finish();
    else this.finish(caught);
  }

  protected streamEnded(stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream) return;
    this.connection = undefined;
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    // The client has exited: its store is free, and its transcript is
    // complete up to here.
    connection.release();
    this.record.mirror(connection.sessionId);
    this.endContinuation(STOPPED_TEXT);
    if (connection.closing) {
      if (this.disposing) this.retire();
      return;
    }
    if (this.promptOpen) this.finish(new Error(STOPPED_TEXT));
  }

  /** One result: its events, then the session's closing text for it. */
  private closeTurn(result: ClaudeNormalizeResult, text: string | undefined): void {
    this.ran = true;
    this.emitAll(result.events);
    this.emit({ type: "turn_closed", ...(text ? { text } : {}) });
    if (this.cut) {
      // The cut's interrupt landed. A steer the client still holds is
      // answered in a turn of its own, under bounds of its own: the wedge
      // watch stands down, and a bound that cuts that turn is reported as
      // this one was.
      this.cut = undefined;
      this.failed = false;
    }
    // The client answered: it is not wedged.
    this.interruptedAt = undefined;
    // A client that never reports its state settles on the result that
    // follows the last acknowledged message.
    if (!this.statesSeen && (!this.acksSeen || this.pushed.every((entry) => entry.acked))) {
      this.finish();
    }
  }

  /**
   * The client did not answer its interrupt: end it, and the turn with it -
   * failed when a failing abort cut it, quietly as a plain interrupt ends
   * otherwise. A continuation ends once the stopped client's stream does.
   */
  private abandon(): void {
    const cut = this.cut;
    this.cut = undefined;
    this.interruptedAt = undefined;
    if (this.promptOpen && !this.failed) {
      if (cut) {
        this.failed = true;
        this.emit({ type: "turn_failed", taskId: this.taskId, error: cut.message });
      }
      this.emit({ type: "turn_end", taskId: this.taskId });
      this.emit({ type: "turn_closed" });
    }
    const connection = this.connection;
    if (connection) this.close(connection, true);
    this.finish();
  }

  /** The prompt is over: record where it landed, then settle it. */
  private finish(caught?: unknown): void {
    if (!this.promptOpen) return;
    this.promptOpen = false;
    this.accepting = false;
    this.interrupting = false;
    this.interruptedAt = undefined;
    this.holdUnacknowledgedSteers();
    for (const steer of this.early.splice(0)) this.held.push(steer.text);
    this.record.mirror(this.id);
    this.served = this.pushed;
    if (this.pushed.some((entry) => entry.acked)) {
      this.tookPrompt = true;
      this.record.stampServed(this.sessionId, this.pushed, this.personalDigests);
    }
    this.safeStop.turnOver();
    if (caught === undefined) this.settleTurn();
    else this.rejectTurn(caught);
    for (const after of this.afterSettle.splice(0)) after();
  }

  /** A steer the client never took in goes back to the owner. */
  private holdUnacknowledgedSteers(): void {
    for (const entry of this.pushed) {
      if (entry.kind === "steer" && !entry.acked) this.held.push(entry.text);
    }
  }

  /**
   * The client said it is running with no prompt open: it resumed on its
   * own (a background command it started finished), and the owner gets the
   * same turn boundary a prompt has. A client whose input is ending is not
   * starting work for anyone.
   */
  private beginContinuation(): void {
    const connection = this.connection;
    if (this.continuing || this.disposing || !connection || connection.closing) return;
    this.continuing = true;
    this.accepting = true;
    this.pushed = [];
    this.failed = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.emit({ type: "continuation_started" });
  }

  /**
   * The continuation is over: the client is idle again, or it exited
   * (`error`). Its own failure, when it had one, was already told as its
   * turn's `turn_failed`.
   */
  private endContinuation(error?: string): void {
    if (!this.continuing) return;
    this.continuing = false;
    this.accepting = false;
    this.interrupting = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.holdUnacknowledgedSteers();
    this.record.mirror(this.id);
    this.safeStop.turnOver();
    this.emit({ type: "continuation_ended", ...(error !== undefined ? { error } : {}) });
    for (const after of this.afterSettle.splice(0)) after();
  }

  /**
   * The model the client answers on now, said to the owner when it is news:
   * its first report, and every change after it.
   */
  private serve(raw: string, fallback?: { from: string; category?: string }): void {
    const id = this.named(raw);
    if (!id || id === this.answering) return;
    this.answering = id;
    this.emit({
      type: "model_served",
      model: { provider: CLAUDE_MODEL_PROVIDER, id },
      ...(fallback
        ? {
            fallback: {
              from: { provider: CLAUDE_MODEL_PROVIDER, id: this.named(fallback.from) },
              ...(fallback.category ? { category: fallback.category } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * A model the client reported, as Infinitary names it: the client's own
   * variant and snapshot marks (`[1m]`, a date) name the same model, and the
   * spec's model keeps the id the spec gave it.
   */
  private named(raw: string): string {
    const id = canonicalClaudeModelId({ value: raw });
    const spec = this.spec.model?.id;
    return spec && canonicalClaudeModelId({ value: spec }) === id ? spec : id;
  }

  private note(line: string): void {
    if (!line) return;
    noteTo(this.deps)(line);
  }
}
