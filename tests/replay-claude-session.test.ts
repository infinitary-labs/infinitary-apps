import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extractTurnsFromJsonl } from "../scripts/dispatch-corpus/dispatchTurns.ts";
import { replaySession } from "../scripts/replay/engine";
import { discoverSources, exportFixture } from "../scripts/replay-captain-session";
import { resetStoreLeasesForTest } from "../src/core/claude/claudeStoreLease";
import { CrewSupervisor } from "../src/core/orchestrator/crewSupervisor";
import { FirstmateAgent, type FirstmateTurnOutcome } from "../src/core/orchestrator/firstmateAgent";
import { appPathsFor } from "../src/core/paths";
import { PI_CONTROL_PROFILE } from "../src/core/pi/controlProfile";
import { firstmatePromptSha } from "../src/core/pi/piResources";
import type { ModelRuntime } from "../src/core/pi/types";
import { FIRSTMATE_CONTRACT_VERSION } from "../src/core/prompts/contractVersion";
import type { ModelSession, SessionFactory } from "../src/core/session/session";
import { CardStore } from "../src/core/storage/cardStore";
import { InboxStore } from "../src/core/storage/inboxStore";
import { readSession } from "../src/core/storage/sessionReader";
import { SettingsStore } from "../src/core/storage/settingsStore";
import { TaskService } from "../src/core/tasks/taskService";
import { RepoRegistry } from "../src/core/workspace/repoRegistry";
import type { WorkspaceService } from "../src/core/workspace/workspaceService";
import { CLAUDE_PROVIDER_ID } from "../src/shared/providers";
import {
  answerText,
  type StubApi,
  type StubRequest,
  startStubApi,
} from "./helpers/anthropicDialect";
import { claudeFlagship } from "./helpers/claudeFlagship";
import {
  answerTool,
  type ClaudeSeatBox,
  claudeSeatBox,
  clientRecords,
  seatBoxesFlushed,
} from "./helpers/claudeSeatHarness";
import { freshDatabase } from "./helpers/database";
import { fakeBinding, fakeSession } from "./helpers/fakeSession";

/**
 * The Claude-served replay fixture, recorded (W1 S11, owner answer Q7 a): a
 * scripted captain session played through the REAL Firstmate agent on the
 * Claude seat, over the SDK's own client boxed by the seat's hermetic
 * harness (`tests/helpers/claudeSeatHarness.ts`) - two spawns, a steer the
 * captain typed while the Firstmate was mid-tool, a decision card and the
 * captain's choice on it. Only the model is scripted; the agent, its tools,
 * the seat, the client and the app's record are the real ones.
 *
 * Every run records the session afresh and reads it back through the one
 * session reader and the replay, so a client that changes what it
 * writes fails here, not in a baseline. `INFINITARY_WRITE_CLAUDE_FIXTURE=1`
 * also exports the recording through the replay's own export path (its
 * scrub pass included) to `tests/fixtures/replay/sep26-claude/`, the
 * committed fixture the gate replays.
 */

// Four boxed client turns, transcript flushing and a full replay are process
// work. The 5 s default passed on the Mac but timed out on hosted Linux.
vi.setConfig({ testTimeout: 15_000 });

const FIXTURE = resolve(__dirname, "fixtures", "replay", "sep26-claude");
const WRITE_FIXTURE = process.env.INFINITARY_WRITE_CLAUDE_FIXTURE === "1";
/** Where the committed fixture says the recording's userData lived. */
const FIXTURE_USER_DATA = "/Users/captain/Library/Application Support/firstmate-3000";

const MODEL = "claude-opus-5-5";

/** The captain's words, in the order the session hears them. */
const CAPTAIN = {
  fix: "Can you fix the flaky sign-in test? It fails about one run in five.",
  status: "How is the crew doing?",
  steer: "Also have someone fix the typo on the settings page.",
  ask: "Should we ship the release tonight, or wait for the sign-in fix?",
};

/**
 * The status answer: a captain's message ends on a card (INF-1610 piece 2,
 * docs/task-capture.md "How a message ends"), so the status turn shows one.
 */
const STATUS_CARD = {
  title: "Crewmate 1 is on the flaky sign-in test",
  body: "<p>Crewmate 1 is fixing the sign-in test that fails about one run in five.</p>",
  answering: true,
  standalone: true,
};

const CARD = {
  title: "Release tonight or wait for the sign-in fix?",
  body: "<p>Wait for the fix, then release.</p><ul><li>The sign-in test still fails about one run in five.</li><li>Releasing tonight would put that failure in front of everyone who signs in.</li><li>Crewmate 1 is already working on the fix.</li></ul>",
  actions: [
    { id: "release-tonight", label: "Release tonight" },
    { id: "wait-for-fix", label: "Wait for the fix", default: true },
  ],
};

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(async () => {
  resetStoreLeasesForTest();
  await seatBoxesFlushed();
});

/** Crewmates that take their brief and stay at work: the session is about the Firstmate. */
function quietCrew(): SessionFactory {
  return {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) =>
      fakeSession({
        sessionId: `recorded-crewmate-${spec.owner}`,
        owner: spec.owner,
        controlProfile: PI_CONTROL_PROFILE,
        model: { provider: "anthropic-claude", id: MODEL },
      }),
  };
}

/** The real agent and supervisor on the Claude seat, over one boxed client. */
function recordingApp(b: ClaudeSeatBox) {
  const paths = appPathsFor(b.home);
  mkdirSync(paths.defaultWorkspaceDir, { recursive: true });
  const db = freshDatabase();
  const settings = new SettingsStore(db);
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const workspace = {
    createTaskWorktree: async (taskId: string) => ({
      taskId,
      cwd: join(paths.worktreesDir, taskId),
      branch: `fm/task-${taskId}`,
      repoDir: paths.defaultWorkspaceDir,
    }),
    removeTaskWorktree: async () => {},
    retireTaskWorktree: async () => ({ outcome: "removed" as const, kept: null }),
    listWorktreeDirs: () => [] as string[],
    workspaceAt: async () => null,
    removeEmptyWorktreeDir: async () => false,
    taskWorkStatus: async () => ({ dirty: false, unlandedCommits: 0 }),
    ensureDefaultRepo: async () => paths.defaultWorkspaceDir,
    installDependencies: async () => ({ outcome: "skipped" as const }),
    listTaskBranches: async () => [] as { branch: string; taskId: string }[],
  } as unknown as WorkspaceService;
  const supervisor = new CrewSupervisor({
    sessions: { pi: quietCrew() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace,
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox,
    paths,
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  const sessions: ModelSession[] = [];
  const factory: SessionFactory = {
    backend: "claude",
    controlProfile: b.sessions.controlProfile,
    open: async (spec) => {
      const session = await b.sessions.open(spec);
      sessions.push(session);
      return session;
    },
  };
  // The agent's own account of each turn it settled: the order the script waits on.
  const settled: FirstmateTurnOutcome[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const onTurnSettled = (outcome: FirstmateTurnOutcome) => {
    settled.push(outcome);
    for (const waiter of waiters.filter((entry) => settled.length >= entry.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const selfSourceDir = join(paths.userData, "self-source");
  mkdirSync(selfSourceDir, { recursive: true });
  const agent = new FirstmateAgent({
    paths,
    inbox,
    settings,
    modelRuntime: {} as ModelRuntime,
    availableModels: () => [{ provider: "anthropic-claude", id: MODEL }],
    quotaModels: () => undefined,
    quotaLine: () => "claude 71% weekly on_pace",
    repos,
    supervisor,
    tasks,
    broadcastEvent: () => {},
    selfSourceDir,
    coalesceMs: 0,
    onTurnSettled,
    flagship: claudeFlagship()(settings),
    seats: {
      pi: {
        backend: "pi",
        controlProfile: PI_CONTROL_PROFILE,
        open: async () => {
          throw new Error("the recording is served by Claude alone");
        },
      },
      claude: factory,
    },
  });
  return {
    paths,
    db,
    agent,
    supervisor,
    settled,
    /** Resolves once the agent has settled this many turns. */
    turnsSettled: (count: number) =>
      new Promise<void>((resolve) => {
        if (settled.length >= count) resolve();
        else waiters.push({ count, resolve });
      }),
    /** The session the agent attached. */
    session: () => sessions[0],
    /** Every attached client has exited, so its transcript is whole. */
    closed: async () => {
      for (const session of sessions) {
        session.dispose();
        await session.closed();
      }
    },
  };
}

/** Everything the model was shown last, as one string, to key the script on. */
function lastUserContent(request: StubRequest): string {
  const messages = request.body.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  return JSON.stringify(last?.content ?? "");
}

/**
 * The recording, through the replay's own export (its scrub pass), with the
 * throwaway HOME the run lived in written as a stable userData path.
 */
function writeFixture(sources: ReturnType<typeof discoverSources>, home: string): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  const roots = [realpathSync(home), home];
  for (const file of exportFixture(sources, FIXTURE)) {
    let text = readFileSync(file, "utf8");
    for (const root of roots) text = text.split(root).join(FIXTURE_USER_DATA);
    writeFileSync(file, text);
  }
}

describe("a Claude-served Firstmate session, recorded and replayed (W1 S11)", () => {
  it("reads back through the one reader and replays every captain turn", async () => {
    const b = claudeSeatBox(api);
    const app = recordingApp(b);

    // The status turn's first answer is held until the captain's steer is
    // in the client's queue: the steer lands while the turn is mid-tool.
    let releaseStatus!: () => void;
    const statusHeld = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusArrived!: () => void;
    const statusRequested = new Promise<void>((resolve) => {
      statusArrived = resolve;
    });
    const script: ((request: StubRequest, res: Parameters<typeof answerText>[1]) => void)[] = [
      (request, res) =>
        answerTool(request, res, "spawn_crewmate", {
          title: "Fix the flaky sign-in test",
          goal: "The sign-in test passes on every run.",
          user_words: CAPTAIN.fix,
        }),
      (request, res) => answerText(request, res, "Crewmate 1 is on the flaky sign-in test."),
      (request, res) => {
        statusArrived();
        void statusHeld.then(() => answerTool(request, res, "emit_card", STATUS_CARD));
      },
      (request, res) =>
        answerTool(request, res, "spawn_crewmate", {
          title: "Fix the settings page typo",
          goal: "The settings page reads correctly.",
          user_words: CAPTAIN.steer,
        }),
      (request, res) =>
        answerText(
          request,
          res,
          "Crewmate 1 is still on the sign-in test; crewmate 2 is fixing the settings typo.",
        ),
      (request, res) => answerTool(request, res, "emit_card", CARD),
      (request, res) => answerText(request, res, "The choice is on the card."),
      (request, res) =>
        answerText(request, res, "Holding the release until the sign-in fix is in."),
    ];
    const unscripted: string[] = [];
    api.answer((request, res) => {
      const next = script.shift();
      if (next) next(request, res);
      else {
        unscripted.push(lastUserContent(request));
        answerText(request, res, "Aye.");
      }
    });

    await app.agent.converse(CAPTAIN.fix);
    await app.turnsSettled(1);
    await app.agent.converse(CAPTAIN.status);
    await statusRequested;
    const session = app.session();
    if (!session) throw new Error("the agent never attached the Claude seat");
    const queued = clientRecords(
      b,
      session.sessionId,
      (entry) =>
        entry.type === "queue-operation" &&
        entry.operation === "enqueue" &&
        String(entry.content).includes(CAPTAIN.steer),
    );
    await app.agent.converse(CAPTAIN.steer);
    await queued;
    releaseStatus();
    await app.turnsSettled(2);
    await app.agent.converse(CAPTAIN.ask);
    await app.turnsSettled(3);
    const card = app.supervisor.cards.snapshot().find((open) => open.title === CARD.title);
    if (!card) throw new Error("the card never showed");
    app.supervisor.cardActions.act(card.id, "wait-for-fix");
    await app.turnsSettled(4);
    await app.closed();
    // The last turn's served stamp is in the sidecar before anything reads it.
    await b.store.flushed();
    writeFileSync(join(app.paths.userData, "firstmate.db"), app.db.serialize());

    // The script ran as written: every scripted answer served, nothing else asked.
    expect(unscripted).toEqual([]);
    expect(script).toEqual([]);
    expect(app.settled).toEqual([
      { trigger: "captain", failed: false },
      { trigger: "captain", failed: false },
      { trigger: "captain", failed: false },
      { trigger: "captain", failed: false }, // the effect-free card choice is the captain's request
    ]);

    // The replay finds the session where the app keeps it, and the one
    // reader reads it as the turns the captain and the host served.
    const sources = discoverSources({ name: "recorded", root: app.paths.userData });
    expect(sources.orchestratorFiles).toEqual([b.store.transcriptPath(session.sessionId)]);
    const read = readSession(sources.orchestratorFiles[0] as string);
    expect(read).toMatchObject({ dialect: "claude", sessionId: session.sessionId });
    const turns = extractTurnsFromJsonl(read.text, read.path);
    expect(
      turns.map((turn) => ({
        kind: turn.kind,
        user: turn.user,
        ops: turn.ops,
        names: turn.names,
        closing: turn.assistant,
      })),
    ).toEqual([
      {
        kind: "user",
        user: CAPTAIN.fix,
        ops: [],
        names: ["spawn_crewmate"],
        closing: "Crewmate 1 is on the flaky sign-in test.",
      },
      { kind: "user", user: CAPTAIN.status, ops: [], names: ["emit_card"], closing: "" },
      // The steer the client folded into the running turn is a turn of its
      // own, exactly as a Pi session records one.
      {
        kind: "user",
        user: CAPTAIN.steer,
        ops: [],
        names: ["spawn_crewmate"],
        closing: "Crewmate 1 is still on the sign-in test; crewmate 2 is fixing the settings typo.",
      },
      {
        kind: "user",
        user: CAPTAIN.ask,
        ops: [],
        names: ["emit_card"],
        closing: "The choice is on the card.",
      },
      {
        kind: "user",
        user: expect.stringMatching(
          /^Wait for the fix\nChoice on card "Release tonight or wait for the sign-in fix\?"/,
        ),
        ops: [],
        names: [],
        closing: "Holding the release until the sign-in fix is in.",
      },
    ]);
    // Every tool answered, and each turn carries the contract the sidecar
    // stamped and the model the stub API answered as.
    expect(
      turns.flatMap((turn) => turn.calls).every((call) => call.result?.isError === false),
    ).toBe(true);
    for (const turn of turns) {
      expect(turn.contract).toMatchObject({
        version: FIRSTMATE_CONTRACT_VERSION,
        prompt_sha: firstmatePromptSha(),
      });
      expect(turn.model).toBe(`${CLAUDE_PROVIDER_ID}/mock-1`);
    }

    // The four independent captain asks and the card choice all replay;
    // the card resolution does not send a duplicate captain turn.
    const report = await replaySession(sources);
    expect(report.fidelity).toMatchObject({
      recorded_captain_turns: 5,
      replayed_captain_turns: 5,
      recorded_op_turns: 0,
      played_op_turns: 0,
      unrecorded_firstmate_wakes: 0,
      missing_tools: [],
      skipped_card_resolutions: 0,
      settle_timeouts: 0,
    });

    if (WRITE_FIXTURE) writeFixture(sources, b.home);
  });
});
