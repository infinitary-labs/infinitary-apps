/**
 * WI-19 - the replay engine behind `scripts/replay-captain-session.ts`.
 *
 * A captain session is replayed against the CURRENT host code: the real
 * FirstmateAgent (its emit_card lint, ownership rules and ask capture) and
 * the real CrewSupervisor (the whose-turn sort, wake routing, closes,
 * hygiene) run over an in-memory database built by the app's own
 * migrations. Only the MODELS are recorded: every Firstmate turn plays back
 * the tool calls the orchestrator made (crew_status, supervision_log,
 * check_pr_ci and the other read or outside-world tools answer from the
 * recording) and every crewmate turn plays back its recorded session.
 * Nothing reaches a provider, the network, or a real repository.
 *
 * Since S7c there is no recorded triage to play: what a report earns is the
 * whose-turn rule's answer over live state (`reportSort.ts`), so the
 * recording's own verdicts are history, not an input. What the replay
 * measures is exactly what a lint, prompt-wiring, tool or sort change does
 * to the same recorded decisions: a card the lint now refuses is not shown,
 * a wake the host no longer raises is never answered. A recorded answer is
 * matched to the wake the current code produces (same text, else the same
 * kind of wake about the same task); a wake with no recorded answer is
 * played as silence and counted under `fidelity`, never invented.
 *
 * Its parts sit beside it: the recording and the refs a recorded answer is
 * matched by (`./recording.ts`), the recorded inputs in playback order
 * (`./timeline.ts`), the id maps (`./ids.ts`), crewmates' recorded sessions
 * (`./crew.ts`), recorded calls in today's vocabulary (`./translation.ts`)
 * and what the report observes (`./observations.ts`).
 *
 * Loaded through Vite's module runner by the CLI (core modules use path
 * aliases plain Node cannot resolve) and imported directly by vitest.
 */

import { isolatedWorkspace, wireIsolatedHost } from "./isolatedHost.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CrewSupervisor,
  CardChoiceUnavailableError,
} from "../../src/core/orchestrator/crewSupervisor.ts";
import { crewmateSessionSpec } from "../../src/core/orchestrator/crewSession.ts";
import {
  actionTookEffect,
  type DeliveryNote,
} from "../../src/core/orchestrator/answerDelivery.ts";
import { FirstmateAgent } from "../../src/core/orchestrator/firstmateAgent.ts";
import { appPathsFor } from "../../src/core/paths.ts";
import {
  buildCrewmateSystemPrompt,
  buildFirstmateSystemPrompt,
} from "../../src/core/pi/piResources.ts";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/session.ts";
import type { BoundTool } from "../../src/core/session/tools.ts";
import type { HostChildProcess, HostChildSpawner } from "../../src/core/host.ts";
import type { ModelRuntime } from "../../src/core/pi/types.ts";
import type {
  ModelSession,
  SessionEvent,
  SessionFactory,
} from "../../src/core/session/session.ts";
import { CardStore } from "../../src/core/storage/cardStore.ts";
import { openInMemoryDatabase } from "../../src/core/storage/db.ts";
import {
  FIRSTMATE_RECIPIENT,
  InboxStore,
  WAKE_COALESCE_MS,
  wakeIdentity,
} from "../../src/core/storage/inboxStore.ts";
import { SettingsStore } from "../../src/core/storage/settingsStore.ts";
import { DecisionStore } from "../../src/core/storage/decisionStore.ts";
import { seedTask } from "../../src/core/tasks/seedTask.ts";
import { TaskService } from "../../src/core/tasks/taskService.ts";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry.ts";
import type { Card } from "../../src/shared/cards.ts";
import { resolveFirstmateCardId } from "../../src/core/pi/cardTool.ts";
import { renderWake, type WakeFacts } from "../../src/core/orchestrator/wakes.ts";
import { UNSTATED_TURN_ERROR } from "../../src/shared/events.ts";
import { FIRSTMATE_SESSION_ID } from "../../src/shared/observe.ts";
import { cardIdFromEmitResult } from "../dispatch-corpus/cards.ts";
import { taskIdFromSpawnResult } from "../extract-dispatch-corpus.ts";
import {
  type CardPair,
  duplicatePairs,
  isQuestion,
  looksGarbled,
  type MetricScores,
  type ObservedCard,
  type ObservedQuestion,
  type ObservedApproval,
  type SessionObservation,
  approvalLabelKey,
  parseApprovalLabels,
  scoreSession,
} from "../interaction-metrics.ts";
import {
  emptyTables,
  numberColumn,
  type RecordedTables,
  readRecordedTables,
  stringColumn,
  type TableRow,
} from "../recorded-tables.ts";
import { CrewPlayback } from "./crew.ts";
import { ReplayIds } from "./ids.ts";
import {
  CardObserver,
  excerpt,
  observedDispatches,
  replayedReviews,
  sha,
} from "./observations.ts";
import {
  type CrewRecording,
  type CrewSegment,
  factsWakeRef,
  firstmatePromptParts,
  type JsonRecord,
  type LiveWake,
  MATCH_LOOKAHEAD_MS,
  normalizeWording,
  type RecordedCall,
  type RecordedFirstmateTurn,
  readCrewRecording,
  readFirstmateRecording,
  refAliases,
  samePrefix,
  TASK_WAKE_KINDS,
  wakeRefAliases,
} from "./recording.ts";
import {
  RECORDED_CHOICE,
  type RecordedTimeline,
  recordedDelivery,
  recordedTimeline,
  SPAWN_TOOLS,
  type TimelineEvent,
} from "./timeline.ts";
import {
  legacyStateOf,
  recordedActions,
  recordedQuestions,
  recordedShape,
  seededShape,
} from "./translation.ts";
import { type ReplayWindow, windowTables } from "./window.ts";

// --------------------------------------------------------------------------
// Sources and report
// --------------------------------------------------------------------------

export type ReplaySources = {
  /** The session's name in reports and in the baseline file. */
  name: string;
  /** The Firstmate's rolling session transcripts. */
  orchestratorFiles: string[];
  /** Recorded task id -> that crewmate's session transcripts. */
  crewmateFiles: Record<string, string[]>;
  /**
   * The retired supervision session's transcripts. Still discovered so an
   * existing fixture directory loads unchanged; nothing replays them.
   */
  supervisionFiles: string[];
  /** firstmate.db, or a scrubbed tables.json dump. */
  tablesPath: string | null;
  /** Replay only this stretch of the recording (`--from` / `--to`, `./window.ts`). */
  window?: ReplayWindow | null;
  /**
   * The hand-scored plain-language labels (roadmap 1.5), one row per card
   * read: `tests/fixtures/plain-language/labels.jsonl` by default. A card
   * with no row scores as unknown.
   */
  plainLabels?: string | null;
  /**
   * The hand-labelled captain choices (the plan-to-build handoff), one row
   * per card and action: `tests/fixtures/approval-labels/labels.jsonl` by
   * default. A choice with no row is not scored.
   */
  approvalLabels?: string | null;
};

/**
 * Why a recorded crewmate turn never played: the input it answered never
 * reached it under the current host (`docs/replay-harness.md`, "Crewmate
 * turns").
 */
export type UnplayedCrewReason =
  /** The Firstmate turn whose spawn started the crewmate never played. */
  | "spawn-not-played"
  /** The replay never started the crewmate for any other reason. */
  | "not-started"
  /** It answered the captain's choice on a card the replay never showed. */
  | "card-not-shown"
  /** It answered the captain's thread reply under a card the replay never showed, or one the host refused. */
  | "reply-not-delivered"
  /** It answered a Firstmate steer whose recorded turn never played. */
  | "steer-not-played"
  /** It answered a Firstmate steer whose turn played, but whose words never reached it within ten minutes of its recorded moment. */
  | "steer-not-received"
  /** None of the above: an input the replay never served, with no named cause. */
  | "unserved";

export type SessionReport = {
  session: string;
  /** The window the recording was trimmed to, as ISO times; null for the whole recording. */
  window: { from: string | null; to: string | null } | null;
  provenance: {
    firstmate_prompt_sha: string;
    crewmate_prompt_sha: string;
  };
  /** How much of the recording the current code actually exercised. */
  fidelity: {
    recorded_captain_turns: number;
    replayed_captain_turns: number;
    recorded_op_turns: number;
    played_op_turns: number;
    unrecorded_firstmate_wakes: number;
    crewmate_sessions: number;
    /** Every turn the crewmates' recordings hold, and those the replay played. */
    recorded_crewmate_turns: number;
    played_crewmate_turns: number;
    unrecorded_crewmate_turns: number;
    missing_tools: string[];
    skipped_card_resolutions: number;
    /** The captain's replies in card threads, and those the current host never took. */
    recorded_thread_replies: number;
    skipped_thread_replies: number;
    settle_timeouts: number;
  };
  metrics: MetricScores;
  details: {
    /** Captain turns in playback order, with their recorded timestamps. */
    captain_turn_order: { at: string; user: string }[];
    /** Recorded choices current admission refuses; never force them through. */
    refused_card_choices: string[];
    /** Recorded resolutions that were the emitter's own close_card, by title: never captain inputs. */
    withdrawn_cards: string[];
    /** Recorded resolutions written by task retirement, by title: host output, never choices. */
    retired_cards: string[];
    /** Every recorded crewmate turn the replay never played, by crewmate and turn, and why. */
    unplayed_crewmate_turns: {
      crewmate: string;
      turn: number;
      at: string;
      reason: UnplayedCrewReason;
    }[];
    lock_refusals: { tool: string; task: string | null }[];
    duplicate_pairs: { task: string | null; first: string; second: string; similarity: number }[];
    /** `scored` is false when the recording carries no answer for this wake. */
    escalations: { handled: boolean; scored: boolean; wake: string }[];
    unrecorded_wakes: string[];
    unanswered_questions: string[];
    closed_with_worktree: string[];
    /**
     * Every labelled choice the recording answered, by its recorded card:
     * the plan it was about (its recorded key) and the builders grounded on
     * that plan the answering turn started.
     */
    approvals: {
      card: string;
      choice: string;
      builds: boolean;
      plan: string | null;
      grounded_starts: number;
    }[];
    /**
     * Every program the replayed first mate filed (INF-799 piece 3), in
     * filing order: its title, whether it sits under a parent, the bound it
     * proposed, and whether the host's runner started it. Its script never
     * runs here (`unplayedProgram`), so it has no parts.
     */
    programs: { title: string; parent: boolean; bound: number; started: boolean }[];
    /** The host-stamped task shape, for replaying deliverable declarations. */
    task_shapes: { title: string; deliverable: string | null; kind: string | null }[];
  };
};

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * A program's script, never run (INF-799 piece 3): the recording holds only
 * models, and a script's parts are crewmates the recording holds no turns
 * for, so playing it would only add turns nobody recorded. This process
 * takes the script and answers nothing, so a recorded `create_task program`
 * files and starts its program as the live host would, and no part is filed.
 */
const unplayedProgram: HostChildSpawner = {
  spawn: (): HostChildProcess => {
    const exits: ((code: number | null) => void)[] = [];
    let ended = false;
    return {
      pid: undefined,
      postMessage: () => {},
      onMessage: () => {},
      onExit: (listener) => {
        exits.push(listener);
      },
      kill: () => {
        if (ended) return;
        ended = true;
        for (const listener of exits) listener(null);
      },
    };
  },
};

/**
 * Tools whose answer comes from the recording instead of running. The
 * replay binds no app dispatcher, so the action catalog's look and change
 * answer as recorded, like the repo tools they replaced, which recordings
 * from before the catalog still name. It binds no preferences writer, plugin
 * installer or knowledge store either: `personalize`, `install_plugin` and
 * the knowledge pair answer as recorded too, and so does the integrations
 * pair, which reaches GitHub through the captain's sign-in. `check_pr_ci` is
 * retired and answers as recorded for the same reason.
 */
const RECORDED_ANSWER_TOOLS = new Set([
  "crew_status",
  "supervision_log",
  "check_pr_ci",
  "locate_project",
  "app_state",
  "app_change",
  "setup_repo",
  "configure_repo",
  "unregister_repo",
  "schedule_prompt",
  "cancel_schedule",
  "personalize",
  "install_plugin",
  "knowledge",
  "record_knowledge",
  "integrations",
  "use_integration",
]);

/** A successful call to one of these is the Firstmate acting on a wake. */
const ACTION_TOOLS = new Set([
  "steer_crewmate",
  "interrupt_crewmate",
  "settle_task",
  "spawn_crewmate",
  "create_task",
  "update_task",
  "link_tasks",
  "recall_decision",
  "close_card",
  "app_change",
]);

/**
 * The pre-WI-4 claim refusal, as the recording and any regression word it.
 * S7c retired the claim that produced it, so nothing in the current code
 * can say this; the count is the guard that keeps it that way.
 */
const LOCK_REFUSAL = /being triaged by fleet supervision|try again in a moment/i;
const REFUSAL_TEXT =
  /^(refused|could not|cannot|can't|unable|not allowed)\b|answer ownership conflict|being triaged|try again in a moment/i;

/**
 * Whether a played call was the Firstmate acting. A refusal never is, and
 * `app_change` answers its refusals and its Settings handover in words, so
 * only its applied answer - the action and the value it now holds - acts.
 */
function playedAction(name: string, text: string, refused: boolean): boolean {
  if (!ACTION_TOOLS.has(name) || refused) return false;
  if (name !== "app_change") return true;
  try {
    const applied = JSON.parse(text) as unknown;
    return (
      typeof applied === "object" &&
      applied !== null &&
      typeof (applied as JsonRecord).action === "string" &&
      "current" in applied
    );
  } catch {
    return false;
  }
}

const TICK_MS = 60_000;
const SETTLE_LIMIT_MS = 5_000;

// --------------------------------------------------------------------------
// The virtual clock: recorded time, advancing in real time between events
// --------------------------------------------------------------------------

class ReplayClock {
  private readonly realNow = Date.now;
  private offset = 0;
  private installed = false;

  now = (): number => this.realNow.call(Date) + this.offset;

  install(at: number): void {
    this.offset = at - this.realNow.call(Date);
    Date.now = this.now;
    this.installed = true;
  }

  /** Never backwards: real work between events keeps the clock moving. */
  advanceTo(at: number): void {
    if (at > this.now()) this.offset = at - this.realNow.call(Date);
  }

  restore(): void {
    if (this.installed) Date.now = this.realNow;
    this.installed = false;
  }
}

const realSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------
// The replay
// --------------------------------------------------------------------------

type PlayedTurn = {
  cardsShown: string[];
  actions: number;
  spawned: boolean;
  /** What the recording shows took effect (or was refused) after the captain's message, in order. */
  delivery: DeliveryNote[];
};

/** A labelled choice a turn is about to answer, with what was started before it. */
type PendingApproval = {
  card: string;
  choice: string;
  builds: boolean;
  plan: string | null;
  before: Set<string>;
};

class Replay {
  private readonly clock = new ReplayClock();
  private readonly dir = mkdtempSync(join(tmpdir(), "infinitary-replay-"));
  private readonly db = openInMemoryDatabase();
  private readonly tasks = new TaskService({ db: this.db, strict: true });
  private readonly paths = appPathsFor(this.dir);
  private readonly repos = new RepoRegistry(this.db, this.paths.fleetDir);
  private readonly inbox = new InboxStore(this.db);
  private readonly ledger = new DecisionStore(this.db);
  private readonly settings = new SettingsStore(this.db);
  private supervisor!: CrewSupervisor;
  private firstmate!: FirstmateAgent;
  /**
   * The wakes the whose-turn rule escalated this run (S7c). The rule's
   * `captain` verdict IS the escalation now - the retired session's
   * "fleet event escalated to you" prefix has no writer - so the op-turn
   * loop scores a payload as an escalation when the rule recorded it.
   */
  /** A `captain` sort's wake with no typed facts, by its words. */
  private readonly ruleEscalations = new Set<string>();
  /** A `captain` sort's typed wake, by its identity (P6): what the Firstmate is served is that row. */
  private readonly escalatedWakes = new Set<string>();

  /** The task rows that existed before the session, seeded rather than commissioned. */
  private readonly seeded = new Set<string>();
  private readonly ids = new ReplayIds();
  private pendingSpawnAlias: string | null = null;
  /** Firstmate turns still playing; a crewmate's turns count in `crewPlayback.inflight`. */
  private inflight = 0;

  private readonly captainTurns: RecordedFirstmateTurn[] = [];
  /** The captain's thread replies the replay never delivered, with the crewmate whose card they were under. */
  private readonly skippedReplies: { taskAlias: string | null; text: string }[] = [];
  private readonly opTurns: RecordedFirstmateTurn[] = [];
  private readonly captainPlays = new Map<RecordedFirstmateTurn, PlayedTurn>();
  private readonly captainTurnOrder: RecordedFirstmateTurn[] = [];
  private readonly pendingCaptainSteers: string[] = [];
  private readonly crew = new Map<string, CrewRecording>();
  private tables!: RecordedTables;
  /** What the recording says happened, read once before it plays (`./timeline.ts`). */
  private recorded!: RecordedTimeline;

  private readonly fidelity: SessionReport["fidelity"] = {
    recorded_captain_turns: 0,
    replayed_captain_turns: 0,
    recorded_op_turns: 0,
    played_op_turns: 0,
    unrecorded_firstmate_wakes: 0,
    crewmate_sessions: 0,
    recorded_crewmate_turns: 0,
    played_crewmate_turns: 0,
    unrecorded_crewmate_turns: 0,
    missing_tools: [],
    skipped_card_resolutions: 0,
    recorded_thread_replies: 0,
    skipped_thread_replies: 0,
    settle_timeouts: 0,
  };
  private readonly observed = {
    opWakes: 0,
    guidanceQueuedWakes: 0,
    wakesAfterCancel: 0,
    spawnStartFailures: 0,
    escalations: [] as { handled: boolean; scored: boolean; wake: string }[],
    lockRefusals: [] as { tool: string; task: string | null }[],
    unrecordedWakes: [] as string[],
    approvals: [] as (ObservedApproval & { card: string; choice: string; plan: string | null })[],
  };

  private readonly crewPlayback = new CrewPlayback({
    ids: this.ids,
    crew: this.crew,
    fidelity: this.fidelity,
    steersTo: (alias) => this.recorded.steers.get(alias) ?? [],
    pendingSpawnAlias: () => this.pendingSpawnAlias,
    aliasTask: (recorded, replay) => this.aliasTask(recorded, replay),
    recordedAnswer: (args, ids) => this.recordedAnswer(args, ids),
  });

  constructor(private readonly sources: ReplaySources) {}

  async run(): Promise<SessionReport> {
    this.load();
    this.recorded = recordedTimeline({
      captainTurns: this.captainTurns,
      opTurns: this.opTurns,
      crew: this.crew,
      tables: this.tables,
    });
    this.fidelity.recorded_thread_replies = this.recorded.threadReplies;
    const timeline = this.recorded.events;
    const startAt = timeline[0]?.at ?? 0;
    this.clock.install(startAt);
    try {
      this.wire();
      await this.seedBefore(Math.min(startAt, this.recorded.begins));
      await this.supervisor.reconcileFleetHygiene();
      await this.settle();
      let lastTick = startAt;
      for (const event of timeline) {
        this.clock.advanceTo(event.at);
        if (this.clock.now() - lastTick >= TICK_MS) {
          lastTick = this.clock.now();
          await this.tick();
        }
        await this.apply(event);
        await this.settle();
      }
      await this.flush();
      return this.report();
    } finally {
      this.firstmate?.dispose();
      this.supervisor?.disposeAll();
      this.clock.restore();
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  // ---- loading -----------------------------------------------------------

  private load(): void {
    const window = this.sources.window ?? null;
    this.tables = windowTables(
      this.sources.tablesPath ? readRecordedTables(this.sources.tablesPath) : emptyTables(),
      window,
    );
    const recording = readFirstmateRecording(this.sources.orchestratorFiles, window);
    this.captainTurns.push(...recording.captain);
    this.opTurns.push(...recording.op);
    this.fidelity.recorded_captain_turns = this.captainTurns.length;
    this.fidelity.recorded_op_turns = this.opTurns.length;
    for (const [alias, files] of Object.entries(this.sources.crewmateFiles)) {
      this.crew.set(alias, readCrewRecording(alias, files, window));
    }
    this.fidelity.crewmate_sessions = this.crew.size;
    this.fidelity.recorded_crewmate_turns = [...this.crew.values()].reduce(
      (sum, recording) => sum + recording.segments.length,
      0,
    );
  }

  // ---- wiring the real host ----------------------------------------------

  private wire(): void {
    const workspace = isolatedWorkspace(this.paths, true);
    // The replay's one session factory: a session with the coding set is a
    // crewmate's recorded session, any other the Firstmate's recorded turns.
    const sessions: SessionFactory = {
      backend: "pi",
      controlProfile: PI_CONTROL_PROFILE,
      open: async (spec) =>
        spec.builtins === "coding" ? this.crewPlayback.open(spec) : this.firstmateSession(spec.tools),
    };
    const cardStore = new CardStore(this.db);
    const crewOptions: ConstructorParameters<typeof CrewSupervisor>[0] = {
      sessions: { pi: sessions },
      bind: async () => ({ backend: "pi", runtime: {} as ModelRuntime }),
      // The crewmate preset, keeping each crewmate's callbacks for its
      // recorded tool calls to play into.
      sessionSpec: (crewmate, binding) => {
        this.crewPlayback.specs.set(crewmate.taskId, crewmate);
        return crewmateSessionSpec(this.paths, crewmate, binding);
      },
      workspace,
      repos: this.repos,
      tasks: this.tasks,
      cardStore,
      inbox: this.inbox,
      paths: this.paths,
      mergePullRequest: async () => ({ ok: true, text: "merged (replay)" }),
      programProcess: unplayedProgram,
      hasRunningJobs: (taskId) => this.crewPlayback.hasRunningJobs(taskId),
      // The whose-turn sort's record (S7c), exactly as services.ts wires
      // it, plus the set the escalation metric reads: an escalation is a
      // `captain` verdict now, not a prefix in the wake's wording.
      recordSort: ({ taskId, wake, facts, verdict, summary, rule, wakeKind, effect }) => {
        this.ledger.transaction(() => {
          this.ledger.recordSort({ taskId, wake, facts, verdict, summary, rule, wakeKind });
          effect?.();
        });
        if (verdict !== "captain") return;
        if (facts) this.escalatedWakes.add(wakeIdentity({ facts }, wakeKind));
        else this.ruleEscalations.add(wake);
      },
      broadcastEvent: () => {},
      broadcastCards: () => {},
    };
    const selfSourceDir = join(this.dir, "self-source");
    mkdirSync(selfSourceDir, { recursive: true });
    const seatOptions: Omit<ConstructorParameters<typeof FirstmateAgent>[0], "supervisor"> = {
      paths: this.paths,
      inbox: this.inbox,
      settings: this.settings,
      modelRuntime: {} as ModelRuntime,
      availableModels: () => [{ provider: "replay", id: "recorded" }],
      quotaModels: () => undefined,
      quotaLine: () => "replay",
      repos: this.repos,
      tasks: this.tasks,
      broadcastEvent: () => {},
      selfSourceDir,
      supervisionLog: (limit) => this.ledger.recent(limit),
      flagMissedEscalation: (input) => this.ledger.flagMissedEscalation(input),
      // The captain's duplicate label lands on the replay's own card, as
      // services.ts wires it, so the duplicate metric counts it.
      flagDuplicate: (input) => this.supervisor.flagDuplicate(input),
      seats: { pi: sessions },
    };
    const host = wireIsolatedHost(crewOptions, seatOptions);
    this.supervisor = host.supervisor;
    this.firstmate = host.firstmate;
  }

  /** Repos the recorded context block names, adopted from empty folders under the recorded names. */
  private async ensureRepos(fleet: RecordedFirstmateTurn["fleet"]): Promise<void> {
    for (const repo of fleet?.repos ?? []) {
      if (this.ids.toReplay.has(repo.id)) continue;
      const path = join(this.dir, "repos", repo.name);
      mkdirSync(path, { recursive: true });
      // Where it lived (git integration PR 1.1): every recording predates
      // the forge seam, when a proposed change could only go to GitHub, so
      // a recorded direct-pr project lived there. Give its folder that
      // origin before adopting it, so the host renders what it rendered.
      if (repo.delivery === "direct-pr") {
        execFileSync("git", ["init", "-q", "-b", "main", path]);
        execFileSync("git", [
          "-C",
          path,
          "remote",
          "add",
          "origin",
          `https://github.com/replay/${repo.name}.git`,
        ]);
      }
      const { repo: view } = await this.repos.setup({ kind: "adopt", path, name: repo.name });
      this.repos.configure(view.id, {
        delivery: repo.delivery === "direct-pr" ? "direct-pr" : "local-only",
        autonomy: repo.autonomy,
      });
      this.ids.alias(repo.id, view.id);
    }
  }

  /** Task rows that existed before the session, driven through the one writer. */
  private async seedBefore(startAt: number): Promise<void> {
    const firstFleet = this.captainTurns.find((turn) => turn.fleet)?.fleet ?? null;
    await this.ensureRepos(firstFleet);
    for (const row of this.tables.tasks) {
      const id = stringColumn(row, "id");
      const created = numberColumn(row, "created_at");
      if (!id || created === null || created >= startAt) continue;
      // The tables hold each row as it stood at export. A row whose own
      // start time falls after the replay begins was still waiting then.
      const startedAt = numberColumn(row, "started_at");
      const legacy: ReturnType<typeof legacyStateOf> =
        startedAt !== null && startedAt > startAt
          ? { status: "queued", worktree: false }
          : legacyStateOf(row);
      if (!legacy) continue;
      const repoId = stringColumn(row, "repo_id");
      // How the row starts and the work's declared facts (its basis among
      // them) as the record held them: an on-request row must not start on
      // the replay's first sweep, and a builder planned behind a plan stays
      // grounded on it.
      const startPolicy = stringColumn(row, "start_policy");
      const shape = seededShape(stringColumn(row, "shape_json"));
      seedTask(this.tasks, {
        id,
        title: stringColumn(row, "title") ?? "Recorded task",
        kind: "work",
        status: legacy.status,
        ...(startPolicy === "on-request" ? { startPolicy } : {}),
        ...(shape ? { shape } : {}),
        createdAt: created,
        repoId: repoId ? (this.ids.toReplay.get(repoId) ?? null) : null,
        worktreeDir: legacy.worktree ? join(this.paths.worktreesDir, id) : "",
        branch: legacy.worktree ? `fm/task-${id}` : "",
      });
      this.ids.alias(id, id);
      this.seeded.add(id);
      const key = stringColumn(row, "key");
      const seededKey = this.tasks.get(id)?.key;
      if (key && seededKey) this.ids.alias(key, seededKey);
    }
  }

  private aliasTask(recorded: string, replay: string): void {
    this.ids.alias(recorded, replay);
    const recordedKey = this.tables.tasks.find((row) => stringColumn(row, "id") === recorded);
    const key = recordedKey ? stringColumn(recordedKey, "key") : null;
    const replayKey = this.tasks.get(replay)?.key;
    if (key && replayKey) this.ids.alias(key, replayKey);
  }

  // ---- the Firstmate's recorded turns ------------------------------------

  private firstmateSession(served: readonly BoundTool[]): ModelSession {
    const tools = new Map(served.map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: SessionEvent) => void>();
    let streaming = false;
    const endTurn = (closing: { text: string; failed: boolean; error: string | null }) => {
      const taskId = FIRSTMATE_SESSION_ID;
      const text = closing.text.trim();
      const events: SessionEvent[] = [
        ...(closing.failed
          ? [{ type: "turn_failed" as const, taskId, error: closing.error || UNSTATED_TURN_ERROR }]
          : []),
        { type: "turn_end", taskId },
        { type: "turn_closed", ...(text ? { text } : {}) },
      ];
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
    };
    return {
      sessionId: "replay-firstmate",
      controlProfile: PI_CONTROL_PROFILE,
      // The recorded turns are the record: the replay keeps none of its own.
      resume: () => undefined,
      recordPath: () => undefined,
      isStreaming: () => streaming,
      modelRef: () => ({ provider: "replay", id: "recorded" }),
      modelLabel: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: async (text) => {
        streaming = true;
        this.inflight += 1;
        try {
          endTurn(await this.onFirstmatePrompt(text, tools));
          while (this.pendingCaptainSteers.length > 0) {
            const steer = this.pendingCaptainSteers.shift() as string;
            endTurn(await this.onFirstmatePrompt(steer, tools));
          }
        } finally {
          streaming = false;
          this.inflight -= 1;
        }
      },
      steer: async (text) => {
        // The recorded model has already stopped reading. Refuse instead
        // of accepting into a closed prompt: steerRecorded keeps the inbox
        // row pending, and the host drains it when this turn closes.
        if (!streaming) throw new Error("The replay prompt has finished reading steers");
        this.pendingCaptainSteers.push(text);
      },
      // If a prompt exits with unread steers, hand ownership back to the
      // host once instead of keeping them for an unrelated later prompt.
      takeUndeliveredSteers: () => this.pendingCaptainSteers.splice(0),
      // The recorded turns ran at whatever level they ran at, on whatever
      // instructions they were served.
      setThinkingLevel: () => {},
      reasoning: () => undefined,
      serveInstructions: () => {},
      takeRenewal: () => undefined,
      servedState: () => undefined,
      abort: async () => {},
      detach: async () => {},
      dispose: () => {},
      closed: async () => {},
    };
  }

  /**
   * Count the operational wakes a captain turn carried (WI-13): the text
   * before its [user] line holds the pending `[fm-op]` payloads the turn
   * absorbed. They are not a standalone op wake, but an escalation among them
   * still reached the Firstmate, so it is scored like any other - `handled`
   * from this captain turn's own play. The leading context (never `[fm-op]`)
   * is skipped.
   *
   * A live wake is read by its typed facts (P6; `liveWakes`), and only a
   * prose one by its WORDING, which is how the recorded half is read: the
   * recordings are text, carry no stamped origin, and stay text. The facts
   * speak the recorded half's vocabulary (`factsWakeRef`), so the two halves
   * still meet. None of this is origin classification: the product
   * classifies by `ServedOrigin` alone.
   */
  private countCarriedWakes(wakes: LiveWake[], handled: boolean): void {
    for (const wake of wakes) {
      if (!wake.facts && !wake.payload.startsWith("[fm-op]")) continue;
      this.countWakeFacts(wake);
      if (this.isEscalation(wake)) {
        // Carried by a captain turn: that turn's own play IS the answer.
        this.observed.escalations.push({
          handled,
          scored: true,
          wake: excerpt(this.ids.normalize(wake.payload)),
        });
      }
    }
  }

  /**
   * The frustration counters one live wake moves: a guidance-queued wake,
   * and a wake about a task already closed. A typed wake is read by its
   * facts (P6) - no kind the host composes today is a guidance-queued wake
   * - and a prose one by its words, as the recordings are.
   */
  private countWakeFacts(wake: LiveWake): void {
    const { facts, payload } = wake;
    if (!facts && /guidance queued|is being delivered now/i.test(payload)) {
      this.observed.guidanceQueuedWakes += 1;
    }
    const taskId = facts
      ? TASK_WAKE_KINDS.has(facts.kind) && "task" in facts
        ? facts.task.id
        : undefined
      : /escalated to you|reported on task|'s turn on task/.test(payload)
        ? /task ([A-Za-z0-9_-]{6,})/.exec(payload)?.[1]
        : undefined;
    const record = taskId ? this.tasks.get(taskId) : undefined;
    if (record && TaskService.isClosed(record)) this.observed.wakesAfterCancel += 1;
  }

  /**
   * An escalation is a wake the host decided the Firstmate must answer.
   * Two writers, because a replay mixes eras: the whose-turn rule's own
   * `captain` verdict (S7c - the record says so, not the wording), read by
   * the typed wake's identity (P6), and the retired supervision session's
   * prefix, which pre-S7c recordings carry.
   */
  private isEscalation(wake: LiveWake): boolean {
    if (wake.facts) {
      return this.escalatedWakes.has(wakeIdentity({ facts: wake.facts }, wake.origin));
    }
    return (
      this.ruleEscalations.has(wake.payload) ||
      /^\[fm-op\] fleet event escalated to you/.test(wake.payload)
    );
  }

  /**
   * The turn's wakes joined to the rows they were served from - the rows
   * the Firstmate still holds, awaiting their ack - so each is classified
   * by its typed facts (P6). The session hears only the framed text, and a
   * served wake is its row's rendering byte for byte (the one renderer), so
   * the join is by those bytes; a wake no row renders is read by its words.
   */
  private liveWakes(payloads: string[]): LiveWake[] {
    const rows = this.inbox.inFlight(FIRSTMATE_RECIPIENT);
    return payloads.map((payload) => {
      const at = rows.findIndex((row) => renderWake(row).trim() === payload);
      const row = at >= 0 ? rows.splice(at, 1)[0] : undefined;
      return { payload, facts: row?.facts ?? null, origin: row?.origin ?? null };
    });
  }

  /** The refs a live wake may be matched by: its facts' kind and task, else its words'. */
  private liveRefs(wake: LiveWake, normalized: string): string[] {
    if (!wake.facts) return wakeRefAliases(normalized).filter((ref) => !ref.endsWith(":"));
    const ref = factsWakeRef(wake.facts, (text) => this.ids.normalize(text));
    return ref ? refAliases(ref) : [];
  }

  private async onFirstmatePrompt(
    text: string,
    tools: Map<string, BoundTool>,
  ): Promise<{ text: string; failed: boolean; error: string | null }> {
    const parts = firstmatePromptParts(text);
    if (parts.user !== null) {
      const user = parts.user;
      const choiceRow = this.inbox.inFlight(FIRSTMATE_RECIPIENT).find(
        (row) => row.origin === "captain" && row.facts?.kind === "card-choice" &&
          renderWake(row).replace(/^\[user\]\n/, "").trim() === user,
      );
      if (choiceRow?.facts?.kind === "card-choice") {
        const facts = choiceRow.facts;
        const ref = factsWakeRef(facts, (word) => this.ids.normalize(word));
        const turn = [...this.recorded.cardChoiceTurns, ...this.opTurns].find(
          (candidate) => !candidate.consumed &&
            (this.recorded.cardChoiceTurns.has(candidate)
              ? candidate.user.startsWith(`${facts.choice.label}\nChoice on card "${facts.card.title}"`)
              : ref !== null && candidate.refs.includes(ref)),
        );
        if (!turn) {
          this.fidelity.unrecorded_firstmate_wakes += 1;
          return { text: "", failed: false, error: null };
        }
        turn.consumed = true;
        if (this.recorded.cardChoiceTurns.has(turn)) {
          this.fidelity.replayed_captain_turns += 1;
          this.captainTurnOrder.push(turn);
        } else this.fidelity.played_op_turns += 1;
        await this.ensureRepos(turn.fleet);
        const approvals = this.pendingApprovals([facts]);
        await this.playCalls(turn.calls, tools);
        this.settleApprovals(approvals);
        return { text: turn.closing, failed: turn.failed, error: turn.error };
      }
      const turn = this.captainTurns.find((candidate) => !candidate.consumed && candidate.user === user);
      if (!turn) return { text: "", failed: false, error: null };
      turn.consumed = true;
      this.fidelity.replayed_captain_turns += 1;
      this.captainTurnOrder.push(turn);
      await this.ensureRepos(turn.fleet);
      const approvals = this.pendingApprovals(
        this.liveWakes(parts.payloads).map((wake) => wake.facts),
      );
      const play = await this.playCalls(turn.calls, tools);
      this.settleApprovals(approvals);
      this.captainPlays.set(turn, play);
      // The wake diet (WI-13): a captain turn carries the pending operational
      // wakes before its [user] line, so those escalations DID reach the
      // Firstmate - count them as escalations (handled by this turn's play),
      // just not as a standalone op wake. Without this the carry would look
      // like escalations simply vanishing.
      this.countCarriedWakes(
        this.liveWakes(parts.payloads),
        play.cardsShown.length > 0 || play.actions > 0,
      );
      return { text: turn.closing, failed: turn.failed, error: turn.error };
    }

    const wakes = this.liveWakes(parts.payloads);
    const matched: RecordedFirstmateTurn[] = [];
    const answered: (WakeFacts | null)[] = [];
    const escalations: { payload: string; scored: boolean }[] = [];
    // The wake diet (WI-13) is measured in interruptions, not facts: an
    // operational drain that hears several wakes together is ONE wake of the
    // Firstmate, matching the report's "turns on operations" framing. The
    // per-payload loop below still counts every distinct fact (guidance,
    // wakes-after-cancel, escalations) and matches each to its recorded turn.
    if (wakes.length > 0) this.observed.opWakes += 1;
    for (const wake of wakes) {
      const payload = wake.payload;
      this.countWakeFacts(wake);
      const escalated = this.isEscalation(wake);
      const normalized = this.ids.normalize(payload);
      const refs = this.liveRefs(wake, normalized);
      const horizon = Date.now() + MATCH_LOOKAHEAD_MS;
      const open = this.opTurns.filter(
        (turn) => !turn.consumed && !matched.includes(turn) && turn.at <= horizon,
      );
      const found =
        open.find((turn) => turn.normalized.includes(normalized)) ??
        open.find((turn) => turn.normalized.some((text) => samePrefix(text, normalized))) ??
        open.find((turn) => refs.some((ref) => turn.refs.includes(ref)));
      if (found) {
        matched.push(found);
        answered.push(wake.facts);
        if (escalated) escalations.push({ payload, scored: true });
      } else {
        // No recorded answer: the recording cannot say what the Firstmate
        // would have done, so this counts under fidelity and is NOT scored
        // for precision. An unanswerable escalation is unknown, never a
        // failure - the same denominator rule the rigor metrics keep.
        if (escalated) escalations.push({ payload, scored: false });
        this.fidelity.unrecorded_firstmate_wakes += 1;
        this.observed.unrecordedWakes.push(excerpt(normalized));
      }
    }
    let played: PlayedTurn = { cardsShown: [], actions: 0, spawned: false, delivery: [] };
    let closing = { text: "", failed: false, error: null as string | null };
    // A labelled choice among the drained wakes is answered by the turns
    // the drain played; one with no recorded answer stays unknown.
    const approvals = this.pendingApprovals(answered);
    for (const turn of matched.sort((a, b) => a.at - b.at)) {
      turn.consumed = true;
      this.fidelity.played_op_turns += 1;
      await this.ensureRepos(turn.fleet);
      const result = await this.playCalls(turn.calls, tools);
      played = {
        cardsShown: [...played.cardsShown, ...result.cardsShown],
        actions: played.actions + result.actions,
        spawned: played.spawned || result.spawned,
        delivery: [...played.delivery, ...result.delivery],
      };
      closing = { text: turn.closing, failed: turn.failed, error: turn.error };
    }
    this.settleApprovals(approvals);
    const handled = played.cardsShown.length > 0 || played.actions > 0;
    for (const escalation of escalations) {
      this.observed.escalations.push({
        handled: escalation.scored && handled,
        scored: escalation.scored,
        wake: excerpt(this.ids.normalize(escalation.payload)),
      });
    }
    return closing;
  }

  private async playCalls(
    calls: RecordedCall[],
    tools: Map<string, BoundTool>,
  ): Promise<PlayedTurn> {
    const played: PlayedTurn = { cardsShown: [], actions: 0, spawned: false, delivery: [] };
    for (const call of calls) {
      const recordedNote = recordedDelivery(call.name, call.result);
      if (recordedNote) played.delivery.push(recordedNote);
      const args = this.ids.mapArgs(call.args) as JsonRecord;
      // The sessions were recorded under the reserved-id contract; the live
      // tool wants effects (P1), so the ids the host used to dispatch on
      // become the effects they meant.
      if (call.name === "emit_card") {
        if (typeof args.body === "string") args.body = recordedQuestions(args.body, args.actions);
        args.actions = recordedActions(args.actions);
        // Its reply names the captain message it answered, as the host read it then.
        const id = typeof args.id === "string" ? args.id : "";
        const answers =
          typeof args.reply === "string" && id
            ? this.recordedAnswer(args, [id, resolveFirstmateCardId(id)])
            : undefined;
        if (answers !== undefined) args.answers_message = answers;
      }
      // The same for a spawn recorded under the pre-v2.8 contract: its
      // judged `difficulty` and `model_id` become the shape facts they
      // meant, so the replay exercises today's tool with what the captain
      // actually asked for.
      if (call.name === "spawn_crewmate") recordedShape(args);
      // These recordings predate correlated response expectations, just as
      // their spawns predate care. Preserve that recorded contract instead
      // of inventing questions their fixed model outputs could never answer.
      // An explicitly recorded response policy is never replaced.
      if (call.name === "steer_crewmate" && args.response_mode === undefined)
        args.response_mode = "guidance-only";
      const recorded = call.result;
      let text: string;
      let isError: boolean;
      if (RECORDED_ANSWER_TOOLS.has(call.name)) {
        text = recorded?.text ?? "";
        isError = recorded?.isError ?? false;
      } else {
        const tool = tools.get(call.name);
        if (!tool) {
          if (!this.fidelity.missing_tools.includes(call.name)) {
            this.fidelity.missing_tools.push(call.name);
          }
          continue;
        }
        if (SPAWN_TOOLS.has(call.name) && recorded) {
          this.pendingSpawnAlias = taskIdFromSpawnResult(recorded.text);
        }
        try {
          text = (await tool.run(args)).text;
          isError = false;
        } catch (caught) {
          text = caught instanceof Error ? caught.message : String(caught);
          isError = true;
        } finally {
          if (SPAWN_TOOLS.has(call.name)) this.pendingSpawnAlias = null;
        }
      }
      if (LOCK_REFUSAL.test(text)) {
        const taskId = typeof args.task_id === "string" ? args.task_id : null;
        this.observed.lockRefusals.push({
          tool: call.name,
          task: taskId ? (this.ids.toRecorded.get(taskId) ?? taskId) : null,
        });
      }
      const refused = isError || REFUSAL_TEXT.test(text.slice(0, 240));
      if (call.name === "emit_card" && !isError) {
        const shown = cardIdFromEmitResult(text);
        const was = recorded ? cardIdFromEmitResult(recorded.text) : null;
        if (shown) {
          played.cardsShown.push(shown);
          if (was) this.ids.alias(was, shown);
        }
      }
      if (SPAWN_TOOLS.has(call.name)) {
        const was = recorded ? taskIdFromSpawnResult(recorded.text) : null;
        const now = refused ? null : taskIdFromSpawnResult(text);
        if (was && now) this.aliasTask(was, now);
        if (now) played.spawned = true;
        if (call.name === "spawn_crewmate" && (refused || /could not start/i.test(text))) {
          this.observed.spawnStartFailures += 1;
        }
      }
      if (playedAction(call.name, text, refused)) played.actions += 1;
    }
    return played;
  }

  // ---- the plan-to-build handoff -----------------------------------------

  private approvalLabelMap: Map<string, boolean> | null = null;

  /** The hand labels, read once per engine; an unreadable file is a loud failure, never an empty sample. */
  private approvalLabels(): Map<string, boolean> {
    if (this.approvalLabelMap) return this.approvalLabelMap;
    const file = this.sources.approvalLabels ?? null;
    this.approvalLabelMap = file ? parseApprovalLabels(readFileSync(file, "utf8")) : new Map();
    return this.approvalLabelMap;
  }

  /**
   * The labelled choices among the wakes a turn answers: an answer task the
   * captain's choice closed, or a choice returned to the Firstmate on a card
   * of its own. The card, the choice and the task are the wake's typed
   * facts; whether the choice authorized a build is the label's, never the
   * card's words. What was started before the turn is taken now.
   */
  private pendingApprovals(facts: (WakeFacts | null)[]): PendingApproval[] {
    const pending: PendingApproval[] = [];
    for (const fact of facts) {
      const choice =
        fact?.kind === "answer-closed"
          ? { card: fact.handoff.card.id, id: fact.handoff.choice.id, task: fact.handoff.task.id }
          : fact?.kind === "card-choice" && fact.card.id
            ? { card: fact.card.id, id: fact.choice.id, task: fact.card.taskId ?? null }
            : null;
      if (!choice) continue;
      const card = this.ids.toRecorded.get(choice.card) ?? choice.card;
      const builds = this.approvalLabels().get(approvalLabelKey(card, choice.id));
      if (builds === undefined) continue;
      const plan = this.planOf(choice.task);
      pending.push({ card, choice: choice.id, builds, plan, before: this.groundedStarted(plan) });
    }
    return pending;
  }

  /**
   * The plan a choice is about: the task it closed, or - on a builder's own
   * card - the basis that builder is grounded on.
   */
  private planOf(taskId: string | null): string | null {
    const record = taskId ? this.tasks.get(taskId) : undefined;
    if (!record) return null;
    const basis = record.shape?.basis;
    return basis ? (this.tasks.resolve(basis)?.id ?? null) : record.id;
  }

  /** The started builders grounded on a plan, as the record holds them. */
  private groundedStarted(plan: string | null): Set<string> {
    if (!plan) return new Set();
    return new Set(
      this.tasks
        .list()
        .filter((record) => {
          const basis = record.shape?.basis;
          return Boolean(basis) && record.startedAt !== null && this.tasks.resolve(basis as string)?.id === plan;
        })
        .map((record) => record.id),
    );
  }

  /**
   * The captain message a recorded line answers. A line recorded before a
   * line named the message it answers (`answers_message`) was its author's
   * answer to the newest captain message on the card it waited on, as the
   * host then read it; today's host ends a question only on a line naming
   * it (docs/card-threads.md, "Shared cards"), so the line stands in naming
   * it. An explicitly recorded name passes through.
   */
  private recordedAnswer(args: JsonRecord, ids: string[]): number | undefined {
    if (typeof args.answers_message === "number") return args.answers_message;
    const card = this.supervisor
      .cardsSnapshot()
      .find((shown) => ids.includes(shown.id) && shown.awaiting === "answer");
    if (!card) return undefined;
    return this.supervisor.cardThread(card.id).messages.findLast((line) => line.who === "captain")
      ?.id;
  }

  /** What each answered choice started, now that its turn has played. */
  private settleApprovals(pending: PendingApproval[]): void {
    for (const approval of pending) {
      const after = this.groundedStarted(approval.plan);
      const key = approval.plan ? this.tasks.get(approval.plan)?.key : undefined;
      this.observed.approvals.push({
        card: approval.card,
        choice: approval.choice,
        builds: approval.builds,
        plan: key ? (this.ids.toRecorded.get(key) ?? key) : approval.plan,
        groundedStarts: [...after].filter((id) => !approval.before.has(id)).length,
      });
    }
  }

  private readonly refusedCardChoices: string[] = [];

  private applyChoice(card: Card, action: string, source: "chrome" | "frame" = "chrome"): void {
    try {
      this.supervisor.act(card.id, action, source);
    } catch (error) {
      if (!(error instanceof CardChoiceUnavailableError)) throw error;
      // The recording is an input, not permission to bypass current admission.
      this.fidelity.skipped_card_resolutions += 1;
      this.refusedCardChoices.push(card.title);
    }
  }

  // ---- inputs ------------------------------------------------------------

  private async apply(event: TimelineEvent): Promise<void> {
    switch (event.type) {
      case "captain":
        await this.ensureRepos(event.turn.fleet);
        await this.firstmate.converse(event.turn.user);
        return;
      case "crew-start": {
        const recording = this.crew.get(event.alias);
        const brief = recording?.segments[0]?.user ?? "";
        const goal = /^Goal: (.*)$/m.exec(brief)?.[1] ?? brief.split("\n")[0] ?? "Recorded task";
        const words =
          /verbatim[^\n]*\n(.*)$/m.exec(brief)?.[1] ?? goal;
        this.pendingSpawnAlias = event.alias;
        try {
          await this.supervisor.commission({
            title: goal.slice(0, 64),
            intent: { goal, userWords: words },
          });
        } finally {
          this.pendingSpawnAlias = null;
        }
        return;
      }
      case "crew-input": {
        const state = this.crewPlayback.states.get(event.alias);
        const taskId = this.ids.toReplay.get(event.alias);
        if (state) state.cursor = Math.max(state.cursor, event.segment);
        if (!taskId) return;
        if (event.input.kind === "job") {
          this.crewPlayback.jobFinished(taskId, event.input.text);
          this.supervisor.deliverJobResult(taskId, event.input.text);
        } else if (event.input.kind === "choice") {
          const title = event.input.title;
          const card = this.supervisor
            .cardsSnapshot()
            .find((candidate) => candidate.taskId === taskId && candidate.title === title);
          if (card) this.applyChoice(card, event.input.actionId);
          else this.fidelity.skipped_card_resolutions += 1;
        }
        return;
      }
      case "crew-cancel": {
        const taskId = this.ids.toReplay.get(event.alias);
        const record = taskId ? this.tasks.get(taskId) : undefined;
        if (!taskId || !record || TaskService.isClosed(record)) return;
        await this.supervisor.interruptCrewmate(taskId, "cancel").catch(() => {});
        return;
      }
      case "card-resolution": {
        const card = this.openCard(event.cardId, event.taskAlias, event.title);
        if (!card) {
          this.fidelity.skipped_card_resolutions += 1;
          return;
        }
        if (event.action === "close") this.supervisor.close(card.id);
        else this.applyChoice(card, event.action, event.source);
        return;
      }
      case "thread-reply": {
        // The current host never showed the card, so there is nothing to
        // reply under: the author's recorded answer cannot play.
        const card = this.openCard(event.cardId, event.taskAlias, event.title);
        if (!card) {
          this.fidelity.skipped_thread_replies += 1;
          this.skippedReplies.push({ taskAlias: event.taskAlias, text: event.text });
          return;
        }
        if (event.turn) await this.ensureRepos(event.turn.fleet);
        try {
          // The host's own reply path: a steer to the crewmate that wrote
          // the card, or a captain turn about the Firstmate's own.
          this.supervisor.replyToCard(card.id, event.text);
        } catch {
          // The recording is an input, not permission to bypass a refusal.
          this.fidelity.skipped_thread_replies += 1;
          this.skippedReplies.push({ taskAlias: event.taskAlias, text: event.text });
        }
        return;
      }
    }
  }

  /** The replay's open card for a recorded one: by its id, else by its title on the same task. */
  private openCard(
    cardId: string,
    taskAlias: string | null,
    title: string | null,
  ): Card | undefined {
    const open = this.supervisor.cardsSnapshot();
    const mapped = this.ids.toReplay.get(cardId);
    const taskId = taskAlias ? this.ids.toReplay.get(taskAlias) : undefined;
    const sameTitle = (candidate: Card) =>
      candidate.title === title && (taskId ? candidate.taskId === taskId : true);
    return (
      open.find((candidate) => candidate.id === mapped) ??
      (title === null ? undefined : open.find(sameTitle))
    );
  }

  /**
   * End-of-timeline flush (WI-13). The coalescing window holds a wake until
   * the clock moves past it, and in production a real timer supplies that
   * move; the replay's clock only advances between recorded events, so at the
   * end it advances the clock past the window and settles, repeatedly, until
   * both lanes are empty. Each pass drains one hop - a held wake, then the
   * escalations it cascades into, then those - so a bounded loop covers the
   * supervision -> firstmate chain without waiting on wall time.
   */
  private async flush(): Promise<void> {
    for (let pass = 0; pass < 6; pass += 1) {
      this.clock.advanceTo(Date.now() + WAKE_COALESCE_MS + 1);
      await this.tick();
      await this.settle();
      const pending = this.inbox.pending(FIRSTMATE_RECIPIENT, Date.now(), { limit: 1 }).length;
      if (pending === 0) return;
    }
  }

  /** The supervisor's shared tick, on recorded time. */
  private async tick(): Promise<void> {
    const now = Date.now();
    await this.supervisor.sweepInbox(now).catch(() => {});
    await this.supervisor.sweepGates(now).catch(() => {});
    this.firstmate.pokeInbox();
  }

  /** Wait until every actor is idle and nothing due is left undrained. */
  private async settle(): Promise<void> {
    const deadline = performance.now() + SETTLE_LIMIT_MS;
    let quiet = 0;
    let pokes = 0;
    while (performance.now() < deadline) {
      await realSleep(2);
      const busy =
        this.firstmate.isBusy() || this.inflight > 0 || this.crewPlayback.inflight > 0;
      if (busy) {
        quiet = 0;
        continue;
      }
      const now = Date.now();
      const due = this.inbox.pending(FIRSTMATE_RECIPIENT, now, { limit: 1 }).length;
      if (due > 0 && pokes < 3) {
        pokes += 1;
        quiet = 0;
        this.firstmate.pokeInbox();
        continue;
      }
      quiet += 1;
      if (quiet >= 4) return;
    }
    this.fidelity.settle_timeouts += 1;
  }

  // ---- scoring -----------------------------------------------------------

  /** Every recorded crewmate turn the replay never played, by crewmate and turn, and why. */
  private unplayedCrewTurns(): SessionReport["details"]["unplayed_crewmate_turns"] {
    const unplayed: SessionReport["details"]["unplayed_crewmate_turns"] = [];
    for (const [alias, recording] of [...this.crew].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [turn, segment] of recording.segments.entries()) {
        if (this.crewPlayback.played.has(segment)) continue;
        unplayed.push({
          crewmate: alias,
          turn,
          at: new Date(segment.at).toISOString(),
          reason: this.unplayedReason(alias, segment),
        });
      }
    }
    return unplayed;
  }

  /**
   * Why one recorded crewmate turn never played, read off what the replay
   * did with the input it answered: the crewmate never started, the card
   * its choice or thread reply was on was never shown, or the Firstmate
   * steer it answered never played or never reached it in time. The host
   * serves a thread reply with the captain's words verbatim.
   */
  private unplayedReason(alias: string, segment: CrewSegment): UnplayedCrewReason {
    if (!this.crewPlayback.states.has(alias)) {
      return this.recorded.spawnTurns.get(alias)?.consumed === false ? "spawn-not-played" : "not-started";
    }
    // A batched input is read by its first part, the one its turn opened on.
    const choice = RECORDED_CHOICE.exec(segment.user.split("\n\n")[0] ?? "");
    if (choice) return this.everShown(alias, choice[1] ?? "") ? "unserved" : "card-not-shown";
    const reply = this.skippedReplies.find(
      (skipped) =>
        (skipped.taskAlias === null || skipped.taskAlias === alias) &&
        segment.user.includes(skipped.text),
    );
    if (reply) return "reply-not-delivered";
    const words = normalizeWording(segment.user);
    const steer = this.recorded.steers
      .get(alias)
      ?.find((candidate) => candidate.delivered && candidate.words === words);
    if (steer) return steer.turn.consumed ? "steer-not-received" : "steer-not-played";
    return "unserved";
  }

  /** Whether the replay ever showed a card with this title on the crewmate's task. */
  private everShown(alias: string, title: string): boolean {
    const taskId = this.ids.toReplay.get(alias);
    if (!taskId) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM cards WHERE task_id = ? AND title = ? LIMIT 1")
        .get(taskId, title) !== undefined
    );
  }

  private report(): SessionReport {
    const rows = this.db.prepare("SELECT * FROM cards").all() as TableRow[];
    const observer = new CardObserver(this.sources.plainLabels ?? null, this.crewPlayback.cardIds);
    const cards: ObservedCard[] = rows.map((row) => observer.observe(row));
    const questions: ObservedQuestion[] = this.captainTurns
      .filter((turn) => isQuestion(turn.user))
      .map((turn) => {
        const played = this.captainPlays.get(turn);
        return {
          at: turn.at,
          text: turn.user,
          answeredInTurn: Boolean(played && played.cardsShown.length > 0 && !played.spawned),
          answerCardIds: played?.cardsShown ?? [],
        };
      });
    const records = this.tasks.list();
    const closed = records.filter((record) => TaskService.isClosed(record));
    const observation: SessionObservation = {
      captainTurns: this.captainTurns.length,
      questions,
      cards,
      opWakes: this.observed.opWakes,
      guidanceQueuedWakes: this.observed.guidanceQueuedWakes,
      escalations: this.observed.escalations,
      wakesAfterCancel: this.observed.wakesAfterCancel,
      lockRefusals: this.observed.lockRefusals.length,
      closedTasks: closed.map((record) => ({
        status: record.status as "done" | "dropped",
        worktreePresent: record.workspaceState === "present",
        // WI-11 retired `delivered`: only merge and land close as done, and
        // host closes are dropped, so a close without evidence is structural.
        deliveredWithoutEvidence: false,
      })),
      implausibleOutcomes: records.filter((record) => record.outcome && looksGarbled(record.outcome))
        .length,
      spawnStartFailures: this.observed.spawnStartFailures,
      dispatches: observedDispatches(
        { db: this.db, ledger: this.ledger, seeded: this.seeded },
        records,
        rows,
      ),
      reviews: replayedReviews(this.db, records),
      approvals: this.observed.approvals,
      asksWithoutAction: [...this.captainPlays.values()].filter(
        (play) => !actionTookEffect(play.delivery.map((note) => ({ ...note, at: 0 }))),
      ).length,
    };
    const authored = cards.filter((card) => card.author !== "host");
    const titles = new Map(authored.map((card) => [card.id, card.title]));
    const pairs: CardPair[] = duplicatePairs(authored);
    const window = this.sources.window ?? null;
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
    return {
      session: this.sources.name,
      window: window ? { from: iso(window.from), to: iso(window.to) } : null,
      provenance: {
        firstmate_prompt_sha: sha(buildFirstmateSystemPrompt()),
        crewmate_prompt_sha: sha(buildCrewmateSystemPrompt()),
      },
      fidelity: { ...this.fidelity, missing_tools: [...this.fidelity.missing_tools].sort() },
      metrics: scoreSession(observation),
      details: {
        captain_turn_order: this.captainTurnOrder.map((turn) => ({
          at: new Date(turn.at).toISOString(),
          user: turn.user,
        })),
        refused_card_choices: this.refusedCardChoices,
        withdrawn_cards: this.recorded.withdrawnCards,
        retired_cards: this.recorded.retiredCards,
        unplayed_crewmate_turns: this.unplayedCrewTurns(),
        lock_refusals: this.observed.lockRefusals,
        // Ordered by the recorded ids, never the replay's own: those are
        // minted fresh every run, and the report must read the same twice.
        duplicate_pairs: pairs
          .map((pair) => ({
            task: this.ids.toRecorded.get(pair.taskId) ?? null,
            first: titles.get(pair.first) ?? "",
            second: titles.get(pair.second) ?? "",
            similarity: Math.round(pair.similarity * 10_000) / 10_000,
          }))
          .sort(
            (a, b) =>
              (a.task ?? "").localeCompare(b.task ?? "") ||
              a.first.localeCompare(b.first) ||
              a.second.localeCompare(b.second),
          ),
        escalations: this.observed.escalations,
        unrecorded_wakes: this.observed.unrecordedWakes,
        unanswered_questions: questions
          .filter((question) => !question.answeredInTurn)
          .map((question) => excerpt(question.text)),
        closed_with_worktree: closed
          .filter((record) => record.workspaceState === "present")
          .map((record) => record.title),
        approvals: this.observed.approvals.map((approval) => ({
          card: approval.card,
          choice: approval.choice,
          builds: approval.builds,
          plan: approval.plan,
          grounded_starts: approval.groundedStarts,
        })),
        task_shapes: records.filter((record) => record.kind === "work").map((record) => ({
          title: record.title,
          deliverable: record.shape?.deliverable ?? null,
          kind: record.shape?.kind ?? null,
        })),
        programs: records.flatMap((record) =>
          record.shape?.program
            ? [
                {
                  title: record.title,
                  parent: record.parentId !== null,
                  bound: record.shape.program.bound,
                  started: this.tasks.starts.programStarted(record.id),
                },
              ]
            : [],
        ),
      },
    };
  }
}

/** Replay one recorded captain session against the current code and score it. */
export async function replaySession(sources: ReplaySources): Promise<SessionReport> {
  return new Replay(sources).run();
}
