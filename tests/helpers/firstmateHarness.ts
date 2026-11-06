import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, actionRefusal } from "@shared/actions";
import type { Card } from "@shared/cards";
import type { FmEvent, FmUsage } from "@shared/events";
import type { KnowledgeDirectionChange, KnowledgeDirectionsArgs } from "@shared/knowledge";
import type { PersonalSnapshot } from "@shared/personal/manifest";
import type { PanelMounts } from "@shared/personal/mounts";
import type { ModelsCatalogView, Slot } from "@shared/quota";
import { parseServedInput, type ServedWakeOrigin } from "@shared/servedFrame";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { z } from "zod";
import type { IntegrationBinding, IntegrationsService } from "../../src/core/integrations";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService";
import { CrewSupervisor } from "../../src/core/orchestrator/crewSupervisor";
import {
  FirstmateAgent,
  type FirstmateTurnOutcome,
} from "../../src/core/orchestrator/firstmateAgent";
import type { Flagship } from "../../src/core/orchestrator/flagship";
import { appPathsFor } from "../../src/core/paths";
import { piToolsOf } from "../../src/core/pi/toolSpec";
import type { ModelRuntime } from "../../src/core/pi/types";
import type { CrewMachines } from "../../src/core/placed/crewMachines";
import { ShellPreferencesService } from "../../src/core/preferences/shellPreferences";
import type {
  ModelSession,
  SessionBackend,
  SessionEvent,
  SessionFactory,
  SessionRenewal,
  SessionResume,
  SessionSpec,
} from "../../src/core/session/session";
import { CardStore } from "../../src/core/storage/cardStore";
import type { AppDatabase } from "../../src/core/storage/db";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../../src/core/storage/inboxStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { seedTask, type TaskSeed } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import type { WorkspaceService } from "../../src/core/workspace/workspaceService";
import { AdmissionClock } from "./admissionClock";
import { freshDatabase as openInMemoryDatabase } from "./database";
import { FAKE_CONTROL_PROFILE, fakeBinding, fakeSessionFactory } from "./fakeSession";
import { scratchDir } from "./scratchDirs";

/**
 * The first mate's test harness, shared by the `src/core/orchestrator/firstmateAgent.*.test.ts`
 * files: the agent over a scripted session, the real task service and SQLite,
 * a fake clock whose admission steps are awaited, and the small readers those
 * tests share. A test file calls `fakeClockEachTest()` once at its top level.
 */

export type TurnImages = Array<{ mimeType: string; data: string }> | undefined;

type ContextObject = Record<string, unknown> & {
  repos: Record<string, unknown>[];
  quota: string;
  self_source: string;
  crew: Array<Record<string, unknown> & { task_id: string; title: string }>;
  open_cards?: Array<{ card_id: string; task?: string; task_id?: string; line: string }>;
  backlog?: { note: string; projects: Array<Record<string, unknown>> };
  surfaces: {
    panels: Array<{ id: string }>;
  };
  captain_resolutions: string[];
  thread_activity?: string[];
  models_by_intelligence_bucket: string[];
  visible_card_hint?: string;
  about?: string;
};

/** A row section's id, the way each row names itself. */
function rowId(row: Record<string, unknown>): string {
  return String(row.task_id ?? row.repo_id ?? row.card_id ?? row.id);
}

/**
 * What a model holds after reading these inputs in order (INF-1712): each
 * complete context replaces its view, and each later one applies its
 * changes - the same fold `tests/e2e/providerRequest.ts` makes.
 */
export function heldContext(inputs: readonly string[]): ContextObject {
  let held: Record<string, unknown> = {};
  for (const input of inputs) {
    const context = decodeContext(input) as Record<string, unknown>;
    if (String(context.delivery).startsWith("complete")) {
      held = { ...context };
      continue;
    }
    for (const [name, value] of Object.entries(context)) {
      if (name === "removed_sections") {
        for (const gone of value as string[]) delete held[gone];
        continue;
      }
      const prior = held[name];
      if (Array.isArray(prior) && value && typeof value === "object" && !Array.isArray(value)) {
        const delta = value as { changed?: Record<string, unknown>[]; removed?: string[] };
        const rows = new Map(
          (prior as Record<string, unknown>[]).map((row) => [rowId(row), row] as const),
        );
        for (const id of delta.removed ?? []) rows.delete(id);
        for (const row of delta.changed ?? []) rows.set(rowId(row), row);
        held[name] = [...rows.values()];
      } else if (prior === undefined && value && typeof value === "object" && "changed" in value) {
        held[name] = (value as { changed: unknown[] }).changed;
      } else {
        held[name] = value;
      }
    }
  }
  return held as ContextObject;
}

export function decodeContext(block: string): ContextObject {
  const segment = parseServedInput(block)?.find((entry) => entry.kind === "context")?.body ?? block;
  const firstBreak = segment.indexOf("\n");
  expect(segment.slice(0, firstBreak)).toBe("[fm-op] context (not the user)");
  return decode(segment.slice(firstBreak + 1)) as ContextObject;
}

export type FakeSession = Omit<ModelSession, "sessionId"> & {
  /** Settable, so a test can name the session a backend minted. */
  sessionId: string;
  prompts: string[];
  steers: string[];
  promptImages: TurnImages[];
  steerImages: TurnImages[];
  emitTurnEnd: (text: string, usage?: FmUsage) => void;
  /** A provider-failed turn: the seat resolves it and says so with turn_failed. */
  emitTurnFailed: (errorMessage: string) => void;
  emitDelta: (text: string) => void;
  /** Any session event, to every subscriber. */
  emit: (event: SessionEvent) => void;
  /** Every setThinkingLevel call, in order (WI-13). */
  thinkingLevels: string[];
  /** The instructions served at each idle boundary (docs/sequences.md). */
  served: { text: string; sha: string }[];
  /** The session it started over from, for the next `takeRenewal`, as a Claude seat's. */
  renewal: SessionRenewal | undefined;
  resolveNextPrompt: () => void;
  rejectNextPrompt: (message: string) => void;
  /**
   * From now on the run never reads a steer: each waits in the queue, as a
   * real session's does when it lands after the run's last look at it.
   */
  holdSteers: () => void;
  readSteers: () => void;
};

/**
 * A seat session whose model the test plays. Its record is its backend's, as
 * a real session's is: a Pi file, or - on a Claude model - the Claude
 * session it is.
 */
export function fakeSession(
  model: { provider: string; id: string } = { provider: "fm-mock", id: "mock-1" },
  backend: SessionBackend = model.provider === "anthropic-claude" ? "claude" : "pi",
): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const prompts: string[] = [];
  const steers: string[] = [];
  const promptImages: TurnImages[] = [];
  const steerImages: TurnImages[] = [];
  const thinkingLevels: string[] = [];
  const served: { text: string; sha: string }[] = [];
  let streaming = false;
  let holding = false;
  let queued: string[] = [];
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((error: Error) => void) | undefined;
  const sessionFile = "/tmp/fm/sessions/session.jsonl";
  const session: FakeSession = {
    sessionId: "fm-session",
    controlProfile: FAKE_CONTROL_PROFILE,
    resume: (): SessionResume =>
      backend === "claude"
        ? { backend: "claude", sessionId: session.sessionId }
        : { backend: "pi", sessionFile },
    recordPath: () => sessionFile,
    isStreaming: () => streaming,
    modelRef: () => model,
    modelLabel: () => model.id,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: (text: string, images?: TurnImages) => {
      prompts.push(text);
      promptImages.push(images);
      streaming = true;
      emit({ type: "input_read", textSha256: createHash("sha256").update(text).digest("hex") });
      return new Promise<void>((resolve, reject) => {
        resolvePrompt = () => {
          streaming = false;
          resolve();
        };
        rejectPrompt = (error) => {
          streaming = false;
          reject(error);
        };
      });
    },
    steer: async (text: string, images?: TurnImages) => {
      steers.push(text);
      steerImages.push(images);
      if (holding) queued.push(text);
      else
        emit({ type: "input_read", textSha256: createHash("sha256").update(text).digest("hex") });
    },
    // Pi's `steerFirst`: ahead of the steers still queued, which keep their order.
    steerFirst: async (text: string) => {
      steers.push(text);
      steerImages.push(undefined);
      if (holding) queued.unshift(text);
      else
        emit({ type: "input_read", textSha256: createHash("sha256").update(text).digest("hex") });
    },
    takeUndeliveredSteers: () => {
      if (streaming) return [];
      const taken = queued;
      queued = [];
      return taken;
    },
    holdSteers: () => {
      holding = true;
    },
    readSteers: () => {
      for (const text of queued.splice(0)) {
        emit({ type: "input_read", textSha256: createHash("sha256").update(text).digest("hex") });
      }
    },
    abort: async () => {},
    detach: async () => {},
    dispose: vi.fn(),
    closed: async () => {},
    servedState: () => undefined,
    setThinkingLevel: (level) => {
      thinkingLevels.push(level);
    },
    reasoning: () => undefined,
    serveInstructions: (instructions) => {
      served.push(instructions);
    },
    renewal: undefined,
    takeRenewal: () => {
      const taken = session.renewal;
      session.renewal = undefined;
      return taken;
    },
    thinkingLevels,
    served,
    prompts,
    steers,
    promptImages,
    steerImages,
    emitTurnEnd: (text, usage) => {
      emit({ type: "turn_end", taskId: "firstmate", ...(usage ? { usage } : {}) });
      emit({ type: "turn_closed", ...(text.trim() ? { text: text.trim() } : {}) });
    },
    emitTurnFailed: (errorMessage) => {
      emit({ type: "turn_failed", taskId: "firstmate", error: errorMessage });
      emit({ type: "turn_end", taskId: "firstmate" });
      emit({ type: "turn_closed" });
    },
    emitDelta: (text: string) => {
      emit({ type: "assistant_delta", taskId: "firstmate", text });
    },
    emit,
    resolveNextPrompt: () => resolvePrompt?.(),
    rejectNextPrompt: (message) => rejectPrompt?.(new Error(message)),
  };
  return session;
}

/** A backend's seat factory over a test's own open. */
export function seatFactory(
  backend: SessionBackend,
  open: (spec: SessionSpec) => Promise<ModelSession>,
): SessionFactory {
  return { backend, controlProfile: FAKE_CONTROL_PROFILE, open };
}

/**
 * The harness's database under a name of its own. better-sqlite3 names its
 * connection type only through an alias, and an exported helper's inferred
 * return type cannot spell the type behind it.
 */
export interface HarnessDatabase extends AppDatabase {}

/** Where a seat spec resumes from. */
export function resumeOf(spec: SessionSpec | undefined): SessionResume | undefined {
  return spec?.shape.turns === "rolling" ? spec.shape.record.resume : undefined;
}

export function setup(
  options: {
    session?: FakeSession;
    computerVersions?: ConstructorParameters<typeof FirstmateAgent>[0]["computerVersions"];
    scheduler?: ConstructorParameters<typeof FirstmateAgent>[0]["scheduler"];
    selfSourceFacts?: ConstructorParameters<typeof FirstmateAgent>[0]["selfSourceFacts"];
    selfSourceFactsAsync?: ConstructorParameters<typeof FirstmateAgent>[0]["selfSourceFactsAsync"];
    crewSource?: ConstructorParameters<typeof CrewSupervisor>[0]["source"];
    failCreate?: string;
    onCaptainTurnAccepted?: () => void;
    onTurnSettled?: ConstructorParameters<typeof FirstmateAgent>[0]["onTurnSettled"];
    availableModels?: () => { provider: string; id: string }[];
    quotaModels?: () => ModelsCatalogView | undefined;
    slotsOf?: (ref: { provider: string; id: string }) => Slot[];
    listedModels?: () => { provider: string; id: string }[];
    /** Task records that exist before the agent boots (a crew already at work). */
    seedTasks?: TaskSeed[];
    /** Open cards the supervisor restores at boot (a crewmate's card on screen). */
    seedCards?: Card[];
    /** The coalescing window (WI-13); 0 (immediate) unless a test exercises it. */
    coalesceMs?: number;
    /** The host's one clock (the ticker's); absent reads `Date.now()`. */
    now?: () => number;
    /** The personal panels the core serves (Step 2's snapshot), for "your surfaces". */
    personal?: PersonalSnapshot;
    /** What the window said it did with each panel, for "your surfaces" (INF-607). */
    mounts?: PanelMounts;
    /** Where projects live and the app's sign-ins there (git integration PR 1.2/1.3). */
    forges?: ConstructorParameters<typeof FirstmateAgent>[0]["forges"];
    /** The flagship binding over this setup's settings; absent = the base runtime. */
    flagship?: (settings: SettingsStore) => Flagship;
    /** A Claude seat factory's open beside the Pi one (the seat seam); absent = none. */
    claudeSeat?: (spec: SessionSpec) => Promise<ModelSession>;
    piSeat?: (spec: SessionSpec) => Promise<ModelSession>;
    /** Where the seat records a typed cut-off on its account. */
    noteCutOff?: ConstructorParameters<typeof FirstmateAgent>[0]["noteCutOff"];
    /**
     * The scripted model never takes an action. Absent, it reacts to every
     * captain turn it is served, as a real model always does something, so a
     * test about another behavior never meets the answer-delivery retry.
     */
    silent?: boolean;
    /** Knowledge (docs/knowledge.md), in memory for this fixture. */
    knowledge?: boolean;
    /**
     * What the last process left behind, written before the agent boots:
     * a restart's open messages and the rows still on the lane.
     */
    beforeBoot?: (state: {
      db: ReturnType<typeof openInMemoryDatabase>;
      tasks: TaskService;
    }) => void;
    /** A previous run's database: this setup is that app, restarted. */
    db?: ReturnType<typeof openInMemoryDatabase>;
    /** The computers that run work for this one, as the crew reads them. */
    machines?: CrewMachines;
    /** The captain's integrations, over this setup's supervisor (docs/integrations.md). */
    integrations?: (supervisor: CrewSupervisor) => IntegrationsService;
  } = {},
) {
  const paths = appPathsFor(scratchDir("infinitary-agent-"));
  const db: HarnessDatabase = options.db ?? openInMemoryDatabase();
  const settings = new SettingsStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const events: FmEvent[] = [];
  let cards: Card[] = [];
  const tasks = new TaskService({ db, strict: true });
  options.beforeBoot?.({ db, tasks });
  for (const seed of options.seedTasks ?? []) seedTask(tasks, seed);
  const seededCards = new CardStore(db);
  for (const card of options.seedCards ?? []) seededCards.upsert(card);
  const crew = fakeSessionFactory();
  const supervisor = new CrewSupervisor({
    sessions: { pi: crew },
    ...(options.crewSource ? { source: options.crewSource } : {}),
    bind: async (accountId) => fakeBinding(accountId),
    workspace: {
      createTaskWorktree: vi.fn(async (taskId: string, repoDir?: string) => ({
        taskId,
        cwd: join(paths.worktreesDir, taskId),
        branch: `fm/task-${taskId}`,
        repoDir: repoDir ?? paths.defaultWorkspaceDir,
      })),
      removeTaskWorktree: vi.fn(async () => {}),
      retireTaskWorktree: vi.fn(async () => ({ outcome: "removed" as const, kept: null })),
      installDependencies: vi.fn(async () => ({ outcome: "skipped" as const })),
    } as unknown as WorkspaceService,
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox: new InboxStore(db),
    paths,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: (snapshot) => {
      cards = snapshot;
    },
    ...(options.machines ? { machines: options.machines } : {}),
  });
  const session = options.session ?? fakeSession();
  const specs: SessionSpec[] = [];
  const usages: unknown[] = [];
  const selfSourceDir = join(paths.userData, "self-source");
  mkdirSync(selfSourceDir, { recursive: true });
  writeFileSync(join(selfSourceDir, "self-marker.txt"), "SELF_SOURCE_JAIL_OK\n");
  const knowledge =
    options.knowledge !== false
      ? new KnowledgeService({
          projects: { get: (id) => repos.get(id), list: () => repos.list() },
        })
      : undefined;
  // Talk-to-personalize Step 1: the preferences writer pushes every write;
  // the personal workspace is a fresh directory under this test's userData.
  const pushes: unknown[] = [];
  const preferences = new ShellPreferencesService(settings, (channel, payload) => {
    pushes.push({ channel, payload });
  });
  const personalWorkspaceDir = join(paths.userData, "fleet", "personal");
  mkdirSync(personalWorkspaceDir, { recursive: true });
  const removedPersonal: string[] = [];
  const turns: FirstmateTurnOutcome[] = [];
  const agent = createTrackedAgent(
    {
      paths,
      ...(options.computerVersions ? { computerVersions: options.computerVersions } : {}),
      inbox: new InboxStore(db),
      settings,
      onTurnSettled: (outcome) => {
        turns.push(outcome);
        options.onTurnSettled?.(outcome);
      },
      onCaptainTurnAccepted: options.onCaptainTurnAccepted,
      personalize: {
        preferences,
        personal: () => options.personal ?? { extensions: [] },
        removePersonal: async (id) => {
          removedPersonal.push(id);
          return { removed: true, committed: false };
        },
        uninstallPlugin: async () => ({ removed: false }),
        personalWorkspaceDir,
        gates: () => ({ knowledge: false }),
        mounts: () => options.mounts ?? null,
      },
      modelRuntime: {} as ModelRuntime,
      availableModels: options.availableModels ?? (() => [{ provider: "fm-mock", id: "mock-1" }]),
      quotaModels: options.quotaModels ?? (() => undefined),
      ...(options.slotsOf ? { slotsOf: options.slotsOf } : {}),
      ...(options.listedModels ? { listedModels: options.listedModels } : {}),
      quotaLine: () => "codex 62% weekly on_pace",
      repos,
      supervisor,
      tasks,
      ...(knowledge ? { knowledge } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.forges ? { forges: options.forges } : {}),
      ...(options.integrations ? { integrations: options.integrations(supervisor) } : {}),
      flagDuplicate: (input) => supervisor.flagDuplicate(input),
      broadcastEvent: (event) => events.push(event),
      selfSourceDir,
      ...(options.selfSourceFacts ? { selfSourceFacts: options.selfSourceFacts } : {}),
      ...(options.selfSourceFactsAsync
        ? { selfSourceFactsAsync: options.selfSourceFactsAsync }
        : {}),
      recordUsage: (input) => usages.push(input),
      ...(options.noteCutOff ? { noteCutOff: options.noteCutOff } : {}),
      coalesceMs: options.coalesceMs ?? 0,
      ...(options.now ? { now: options.now } : {}),
      ...(options.flagship ? { flagship: options.flagship(settings) } : {}),
      seats: {
        pi: seatFactory("pi", async (spec) => {
          specs.push(spec);
          if (options.failCreate) throw new Error(options.failCreate);
          return options.piSeat ? options.piSeat(spec) : session;
        }),
        ...(options.claudeSeat ? { claude: seatFactory("claude", options.claudeSeat) } : {}),
      },
    },
    { silent: options.silent },
  );
  return {
    agent,
    session,
    specs,
    /** What each crewmate session was opened with: its card and reply outputs. */
    crewSpecs: crew.specs,
    events,
    cards: () => cards,
    db,
    settings,
    repos,
    supervisor,
    tasks,
    usages,
    knowledge,
    selfSourceDir,
    preferences,
    pushes,
    personalWorkspaceDir,
    removedPersonal,
    turns,
    paths,
  };
}

/** A connection with one change action, the captain's notes, kept in memory. */
export function notesBinding(): IntegrationBinding {
  const notes: string[] = [];
  return {
    kind: "mcp",
    connections: () => [
      {
        id: "mcp-notes",
        name: "Notes",
        account: null,
        health: "ok",
        actions: [
          {
            name: "add_note",
            label: "Add a note",
            effect: "changes",
            description: "Adds a note to the end of the list.",
            input: z.strictObject({ text: z.string() }),
          },
        ],
      },
    ],
    check: async () => {},
    remove: () => {},
    call: async (_id, _action, input) => {
      notes.push((input as { text: string }).text);
      return { text: notes.join("\n") };
    },
  };
}

/**
 * A prose op on the Firstmate's lane: a row whose payload is text, as an
 * older build queued one, recorded on the inbox's wake path and followed by
 * the drain's poke - what `notifyOp` does for a typed wake.
 */
export function notifyProse(
  db: ReturnType<typeof setup>["db"],
  agent: FirstmateAgent,
  text: string,
  origin: ServedWakeOrigin,
  ref?: string,
): void {
  if (new InboxStore(db).enqueueWake(FIRSTMATE_RECIPIENT, text, origin, ref) !== null) {
    agent.pokeInbox();
  }
}

// Admission can read real files before a turn starts. A bare clock advance
// raced that I/O; wait for the actual admission promises between deadline
// steps instead. Held model prompts are deliberately not awaited here.
export const admissionClock = new AdmissionClock((ms) => vi.advanceTimersByTimeAsync(ms));
const reacting = new WeakSet<object>();

/**
 * The scripted model reacts to every captain turn it is served, as a real
 * model always does something: a test about any other behavior then never
 * meets the answer-delivery retry. A test about that retry passes `silent`.
 */
function reactingSeats(
  seats: NonNullable<ConstructorParameters<typeof FirstmateAgent>[0]["seats"]>,
): NonNullable<ConstructorParameters<typeof FirstmateAgent>[0]["seats"]> {
  const wrapped: typeof seats = { pi: seats.pi };
  for (const backend of ["pi", "claude"] as const) {
    const factory = seats[backend];
    if (!factory) continue;
    wrapped[backend] = {
      ...factory,
      open: async (spec) => {
        const opened = await factory.open(spec);
        if (reacting.has(opened)) return opened;
        reacting.add(opened);
        const react = (text: string) => {
          if (parseServedInput(text)?.some((segment) => segment.kind === "user")) {
            void spec.tools.find((tool) => tool.name === "emote")?.run({ emote: "nod" });
          }
        };
        const pending = new Map<string, string>();
        opened.subscribe((event) => {
          if (event.type !== "input_read") return;
          const text = pending.get(event.textSha256);
          if (text === undefined) return;
          pending.delete(event.textSha256);
          // All owner listeners must see the read point before a tool acts.
          queueMicrotask(() => react(text));
        });
        const expectRead = (text: string) =>
          pending.set(createHash("sha256").update(text).digest("hex"), text);
        const serve = opened.prompt.bind(opened);
        opened.prompt = (text, images) => {
          expectRead(text);
          return serve(text, images);
        };
        const steer = opened.steer.bind(opened);
        opened.steer = async (text, images) => {
          expectRead(text);
          await steer(text, images);
        };
        return opened;
      },
    };
  }
  return wrapped;
}

export function createTrackedAgent(
  options: ConstructorParameters<typeof FirstmateAgent>[0],
  tracking: { silent?: boolean } = {},
): FirstmateAgent {
  const agent = new FirstmateAgent({
    ...options,
    ...(options.seats && !tracking.silent ? { seats: reactingSeats(options.seats) } : {}),
  });
  agent.converse = admissionClock.track(agent.converse.bind(agent));
  // Observe the real private admission seams; do not replace their behavior.
  const admission = agent as unknown as {
    drainInbox(): Promise<void>;
    seat: { moveFlagship(providerId: string): Promise<void> };
  };
  admission.drainInbox = admissionClock.track(admission.drainInbox.bind(agent));
  const seat = admission.seat;
  seat.moveFlagship = admissionClock.track(seat.moveFlagship.bind(seat));
  return agent;
}

/**
 * A captain Start reaches the Firstmate first: its turn reads the wake and
 * ends without starting the task, so the app starts it as it is.
 */
export async function endStartTurn(session: {
  prompts: unknown[];
  emitTurnEnd: (text: string) => void;
  resolveNextPrompt: () => void;
}): Promise<void> {
  await tick();
  session.emitTurnEnd("Noted.");
  session.resolveNextPrompt();
  for (let settle = 0; settle < 4; settle += 1) await tick();
}

export const tick = () =>
  vi.isFakeTimers()
    ? admissionClock.advance(100)
    : new Promise((resolve) => setTimeout(resolve, 100));

/**
 * Waits for the coalescing window to drain into `count` turns. A fixed sleep
 * raced the window under a loaded suite (the 30ms window plus a 150ms sleep is
 * not a margin when 180 files are running); the claim these tests make is
 * about WHICH wakes share a turn, which the assertions that follow carry.
 */
export const drained = (session: { prompts: string[] }, count: number) =>
  vi.waitFor(() => expect(session.prompts).toHaveLength(count), { timeout: 5_000, interval: 10 });

/** A decision the first mate showed on a task, with its buttons (the card-fm- prefix). */
export function firstmateCard(
  id: string,
  taskId: string,
  title: string,
  actions: Card["actions"],
): Card {
  return {
    id,
    taskId,
    author: "firstmate",
    priority: 50,
    title,
    meta: "firstmate",
    body: "<p>Choose one.</p>",
    actions,
    status: "ready",
    createdAt: Date.now(),
  };
}

/** A card a crewmate emitted on its task (never the card-fm- prefix). */
export function crewCard(id: string, taskId: string, title: string, body: string): Card {
  return {
    id,
    taskId,
    author: "crewmate",
    priority: 30,
    title,
    meta: "crewmate 2",
    body,
    actions: [],
    status: "ready",
    createdAt: Date.now(),
  };
}

/** d:d-9yi5fx, the rule the captain had to type three times (INF-626, INF-638). */
export const FIX_MERGE_RULE =
  "In Infinitary, a fix for a broken main or a failed alpha merges on its own once all checks pass: set that task's autonomy on and cite this direction.";

/**
 * The core's catalog path for the `direction` line, as the dispatcher runs
 * it for the first mate (src/core/dispatcher.ts): the line's permission for
 * the wake the agent stamps, the knowledge service's change, and the
 * trail's word back to the agent.
 */
export function bindDirections(agent: FirstmateAgent, knowledge: KnowledgeService): void {
  let operations = 0;
  agent.bindAppDispatch(async (channel, args, actor) => {
    if (channel === "inf:knowledge:directions")
      return knowledge.directions.page(
        (args as [KnowledgeDirectionsArgs?])[0] ?? { scope: "all" },
      ) as never;
    if (channel !== "inf:knowledge:direction:set") throw new Error(`Not a direction: ${channel}`);
    const refusal = actor?.kind === "firstmate" && actionRefusal(ACTIONS.direction, actor);
    if (refusal) throw new Error(refusal);
    const changed = knowledge.directions.change((args as [KnowledgeDirectionChange])[0]);
    operations += 1;
    agent.appActionRecorded(`op-${operations}`, "direction", {
      op: changed.op,
      text: changed.direction.text,
    });
    return changed as never;
  });
}

/** The directions app_change answers with, as its current value. */
export function directionsIn(
  result: { content: { text?: string }[] } | undefined,
): { id: string; revision: number; text: string }[] {
  return JSON.parse(result?.content[0]?.text ?? "{}").current?.directions;
}

type ToolHandle = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
};

export function toolsOf(specs: SessionSpec[]): Map<string, ToolHandle> {
  const tools = piToolsOf(specs[0]?.tools ?? []) as unknown as ToolHandle[];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/**
 * Every first mate test runs on the fake clock, and admission's own promises
 * are awaited between clock steps (`admissionClock`); each test file calls
 * this once at its top level.
 */
export function fakeClockEachTest(): void {
  beforeEach(() => {
    admissionClock.clear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    admissionClock.clear();
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
  });
}
