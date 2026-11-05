import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseTurnText } from "../scripts/dispatch-corpus/dispatchTurns.ts";
import {
  compareToBaseline,
  type MetricScores,
  scoreSession,
} from "../scripts/interaction-metrics.ts";
import { emptyTables, readRecordedTables } from "../scripts/recorded-tables.ts";
import { replaySession, type SessionReport } from "../scripts/replay/engine.ts";
import { readCrewRecording, readFirstmateRecording } from "../scripts/replay/recording.ts";
import { windowTables } from "../scripts/replay/window.ts";
import {
  discoverFixtures,
  discoverSources,
  type Engine,
  exportFixture,
  type ReplayReport,
  type RunDeps,
  readBaseline,
  run,
} from "../scripts/replay-captain-session.ts";
import type { CoreDispatch } from "../src/core/dispatcher.ts";
import { CardService } from "../src/core/orchestrator/cardService.ts";
import { CrewSupervisor } from "../src/core/orchestrator/crewSupervisor.ts";
import { FirstmateAgent } from "../src/core/orchestrator/firstmateAgent.ts";
import { createAppTools } from "../src/core/pi/appTools.ts";
import { FIRSTMATE_TOOLS } from "../src/core/session/tools.ts";
import { SessionRecordStore } from "../src/core/storage/sessionRecordStore.ts";
import { TaskService } from "../src/core/tasks/taskService.ts";
import { frameServedInput, type ServedSegmentInput } from "../src/shared/servedFrame.ts";
import { claudeCrewTwin, crewSessionsDir, crewTwinTime, piCrewTwin } from "./helpers/crewTwins.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * WI-19: the replay harness over the committed captain-session fixtures.
 * The engine runs the real FirstmateAgent and CrewSupervisor over recorded
 * Firstmate/crew decisions and the current whose-turn rule, so each assertion below is
 * about the CURRENT host code: the nine frustration modes of report.md
 * section 2.2 (F1-F9), the committed baseline, and determinism. The F1-F9
 * modes assert on the sep14/sep04 reconstructions; the real MacBook exports
 * (sep14-real, sep04-real, tests/fixtures/replay/README.md) sit beside them,
 * run identically, and are gated by the same baseline.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));
const BASELINE = join(FIXTURES, "baseline.json");

let sep14: SessionReport;
let sep04: SessionReport;
let sep14Real: SessionReport;
let sep04Real: SessionReport;
let sep26Claude: SessionReport;
let sep30HandoffAgree: SessionReport;
let oct01HandoffStart: SessionReport;
let oct22Program: SessionReport;

function fixture(name: string) {
  const found = discoverFixtures(FIXTURES).find((sources) => sources.name === name);
  if (!found) throw new Error(`fixture ${name} is missing`);
  return found;
}

function readAll(dir: string): string {
  const sources = discoverSources({ name: "x", root: dir });
  return [
    ...sources.orchestratorFiles,
    ...Object.values(sources.crewmateFiles).flat(),
    ...sources.supervisionFiles,
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

beforeAll(async () => {
  sep14 = await replaySession(fixture("sep14"));
  sep04 = await replaySession(fixture("sep04"));
  sep14Real = await replaySession(fixture("sep14-real"));
  sep04Real = await replaySession(fixture("sep04-real"));
  sep26Claude = await replaySession(fixture("sep26-claude"));
  sep30HandoffAgree = await replaySession(fixture("sep30-handoff-agree"));
  oct01HandoffStart = await replaySession(fixture("oct01-handoff-start"));
  oct22Program = await replaySession(fixture("oct22-program"));
}, 240_000);

describe("the fixtures replay against the current code", () => {
  it("exercises the whole recording: every captain turn, no missing tool, no stuck settle", () => {
    for (const report of [sep14, sep04, sep26Claude]) {
      expect(report.fidelity.replayed_captain_turns).toBe(report.fidelity.recorded_captain_turns);
      expect(report.fidelity.recorded_captain_turns).toBeGreaterThan(0);
      expect(report.fidelity.missing_tools).toEqual([]);
      expect(report.fidelity.settle_timeouts).toBe(0);
    }
  });

  it("accounts for every played captain turn in the order trace, including choices and thread replies", () => {
    for (const report of [
      sep14,
      sep04,
      sep14Real,
      sep04Real,
      sep26Claude,
      sep30HandoffAgree,
      oct01HandoffStart,
    ]) {
      expect(report.details.captain_turn_order).toHaveLength(
        report.fidelity.replayed_captain_turns,
      );
    }
  });

  it("plays sep14's captain turns in recorded order, including arrivals during wake drains (FI3-1016)", () => {
    const recorded = readFirstmateRecording(fixture("sep14").orchestratorFiles).captain;
    expect(sep14.details.captain_turn_order).toEqual(
      recorded.map((turn) => ({ at: new Date(turn.at).toISOString(), user: turn.user })),
    );
  });

  it("plays a captain turn during a wake drain even when no later captain turn arrives (FI3-1016)", async () => {
    const sources = fixture("sep14");
    const recorded = readFirstmateRecording(sources.orchestratorFiles).captain;
    const last = recorded.find((turn) => turn.user === "who sets delivered?");
    if (!last) throw new Error("sep14 is missing the captain turn that arrived during a drain");
    const to = last.at + 30_000;
    const report = await replaySession({ ...sources, window: { from: null, to } });
    expect(report.details.captain_turn_order).toEqual(
      recorded
        .filter((turn) => turn.at <= to)
        .map((turn) => ({
          at: new Date(turn.at).toISOString(),
          user: turn.user,
        })),
    );
    expect(report.fidelity.replayed_captain_turns).toBe(report.fidelity.recorded_captain_turns);
    expect(report.fidelity.settle_timeouts).toBe(0);
  }, 60_000);

  it("reads a settled task's card retirement as host output, never a captain choice (FI3-989)", () => {
    expect(sep14Real.details.retired_cards).toEqual([
      "Crew panel removal is ready to merge",
      "PR 88 is already merged",
    ]);
    expect(sep14Real.details.refused_card_choices).toEqual([]);
    expect(sep26Claude.details.retired_cards).toEqual([]);
    expect(sep26Claude.details.refused_card_choices).toEqual([]);
  });

  it("reads an emitter's own close_card as its withdrawal, never the captain's choice (FI3-287)", () => {
    // Each row holds its close_card's reason where an action id would be;
    // the recorded call that closed it says whose resolution it was.
    expect(sep14Real.details.withdrawn_cards).toEqual([
      "Settings page widening is ready to merge",
      "Fix CI-pending labeled as delivered",
      "Stop cancel from marking work delivered",
      "Which crew rows are still real work",
      "Remaining unlanded tasks",
    ]);
    expect(sep26Claude.details.withdrawn_cards).toEqual([]);
  });

  it("names why each of sep14-real's crewmate turns that never plays did not (FI3-442)", () => {
    expect(sep14Real.fidelity).toMatchObject({
      recorded_crewmate_turns: 164,
      played_crewmate_turns: 140,
    });
    const unplayed = sep14Real.details.unplayed_crewmate_turns;
    expect(unplayed).toHaveLength(164 - 140);
    const turns = (reason: string) =>
      unplayed
        .filter((turn) => turn.reason === reason)
        .map((turn) => `${turn.crewmate}#${turn.turn}`);
    // Every gap has a cause the replay can name.
    expect(turns("unserved")).toEqual([]);
    // The Firstmate turn that commissioned 48d9179a answered the retired
    // supervision session's escalation of ba13eadd, a wake today's host never raises.
    expect(turns("spawn-not-played")).toEqual(
      Array.from({ length: 15 }, (_, turn) => `48d9179a#${turn}`),
    );
    // Choices on recorded decision cards that name no default, which today's lint refuses.
    expect(turns("card-not-shown")).toEqual([
      "40706c12#1",
      "ba13eadd#1",
      "c9dab1e7#1",
      "d299b1e5#1",
      "db40a3e8#2",
    ]);
    // Steers sent by Firstmate turns that answered wakes today's host never raises.
    expect(turns("steer-not-played")).toEqual([
      "59f43063#4",
      "98ab0f6a#8",
      "a0533386#4",
      "ba13eadd#7",
    ]);
    expect(unplayed).toHaveLength(15 + 5 + 4);
    // Every other recording plays each of its crewmate turns.
    for (const report of [sep14, sep04, sep26Claude, sep30HandoffAgree, oct01HandoffStart]) {
      expect(report.details.unplayed_crewmate_turns).toEqual([]);
      expect(report.fidelity.played_crewmate_turns).toBe(report.fidelity.recorded_crewmate_turns);
    }
  });

  it("stamps the prompts it replayed against", () => {
    expect(sep14.provenance.firstmate_prompt_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(sep14.provenance.crewmate_prompt_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same recording scores the same twice", async () => {
    const again = await replaySession(fixture("sep14"));
    expect(again.metrics).toEqual(sep14.metrics);
    expect(again.fidelity).toEqual(sep14.fidelity);
  }, 60_000);

  it("does not regress any metric in the committed baseline", () => {
    const regressions = compareToBaseline(
      {
        sep14: sep14.metrics,
        sep04: sep04.metrics,
        "sep14-real": sep14Real.metrics,
        "sep04-real": sep04Real.metrics,
        "sep26-claude": sep26Claude.metrics,
        "sep30-handoff-agree": sep30HandoffAgree.metrics,
        "oct01-handoff-start": oct01HandoffStart.metrics,
        "oct22-program": oct22Program.metrics,
      },
      readBaseline(BASELINE).sessions,
    );
    expect(regressions).toEqual([]);
    // The real evening replays turn for turn (report section 2.2).
    expect(sep14Real.fidelity.replayed_captain_turns).toBe(36);
    expect(sep14Real.fidelity.recorded_captain_turns).toBe(36);
    expect(sep04Real.fidelity.replayed_captain_turns).toBe(12);
  });

  it("replays the Claude-served session like a Pi one: every turn, its card choice answered (W1 S11)", () => {
    const sources = fixture("sep26-claude");
    // Found where the app keeps a Claude seat's sessions, its sidecar beside it.
    expect(sources.orchestratorFiles).toEqual([
      expect.stringMatching(/\/firstmate\/claude\/[0-9a-f-]+\.jsonl$/),
    ]);
    expect(sep26Claude.fidelity).toMatchObject({
      recorded_captain_turns: 4,
      replayed_captain_turns: 4,
      recorded_op_turns: 1,
      // The historical operational card-choice turn is now captain-origin.
      played_op_turns: 1,
      unrecorded_firstmate_wakes: 0,
      skipped_card_resolutions: 0,
    });
  });
});

/**
 * INF-799 piece 3: a loop toward a goal lands as one program task. The
 * recording (`tests/fixtures/replay/README.md`, `oct22-program`) holds the
 * first mate answering that ask with the served guide's loop shape in
 * one `create_task program`; the replay files it through today's tool and
 * the host's runner starts it, with no parent.
 */
describe("a program the first mate files", () => {
  it("replays the loop ask as one program task the runner starts", () => {
    expect(oct22Program.fidelity).toMatchObject({
      recorded_captain_turns: 1,
      replayed_captain_turns: 1,
      missing_tools: [],
      settle_timeouts: 0,
    });
    expect(oct22Program.details.programs).toEqual([
      {
        title: "Fix the flaky checkout tests until the suite passes",
        parent: false,
        bound: 8,
        started: true,
      },
    ]);
  });
});

/**
 * The plan-to-build handoff on the real recording (FI3-309 to FI3-310,
 * `tests/fixtures/replay/README.md`): the captain agreed FI3-309's plan at
 * 19:34:59 UTC on September 30 and the Firstmate answered with a verdict and
 * no start; at 00:45:16 on October 1 he chose "Start implementation" on the
 * Firstmate's own card and it started FI3-310. Each choice is labelled a
 * build approval (`tests/fixtures/approval-labels/labels.jsonl`); the
 * replay counts what the recorded answer started under the current host.
 */
describe("the plan-to-build handoff, on the real FI3-309 to FI3-310 recording", () => {
  it("replays the agreed plan's whole hour: the planner's card shown, the agree applied and answered", () => {
    expect(sep30HandoffAgree.fidelity).toMatchObject({
      recorded_captain_turns: 5,
      replayed_captain_turns: 5,
      unrecorded_firstmate_wakes: 0,
      crewmate_sessions: 1,
      missing_tools: [],
      settle_timeouts: 0,
    });
    // The two choices skipped are on cards shown before the window opened.
    expect(sep30HandoffAgree.fidelity.skipped_card_resolutions).toBe(2);
    expect(sep30HandoffAgree.details.refused_card_choices).toEqual([]);
  });

  it("delivers the captain's 19:25 thread reply to the planner, whose recorded revision and report play", async () => {
    expect(sep30HandoffAgree.fidelity).toMatchObject({
      recorded_crewmate_turns: 2,
      played_crewmate_turns: 2,
      recorded_thread_replies: 1,
      skipped_thread_replies: 0,
    });
    const replies = vi.spyOn(CrewSupervisor.prototype, "replyToCard");
    const lines = vi.spyOn(CardService.prototype, "addMessage");
    const reports = vi.spyOn(TaskService.prototype, "recordReport");
    try {
      await replaySession(fixture("sep30-handoff-agree"));
      // The host's own reply path, on the planner's card as the replay showed it.
      expect(replies.mock.calls).toEqual([
        [
          expect.stringMatching(/^card-[0-9a-f]+-fm-crew-fi3-309-plan$/),
          expect.stringMatching(/^wait interesting\.\. the screenshots you took/),
        ],
      ]);
      const card = replies.mock.calls[0]?.[0];
      const thread = lines.mock.calls.flatMap(([id, who, text], index) =>
        id === card ? [{ who, text, order: lines.mock.invocationCallOrder[index] ?? 0 }] : [],
      );
      // The planner revised the card under the same id, so the host wrote
      // its "revised" line after the captain's.
      expect(thread.map(({ who, text }) => ({ who, text }))).toEqual([
        { who: "captain", text: expect.stringMatching(/^wait interesting/) },
        {
          who: "host",
          text: "revised: Plan: the task record back on the stack, solid cards, the character hidden under them",
        },
        // The recording predates answers on revisions, so the replay gives one.
        { who: "crewmate", text: expect.stringMatching(/^\(recorded before/) },
      ]);
      // And then reported: its second report, after the revision.
      const revisedAt = thread[1]?.order ?? Number.POSITIVE_INFINITY;
      const after = reports.mock.calls.filter(
        (_, index) => (reports.mock.invocationCallOrder[index] ?? 0) > revisedAt,
      );
      expect(after.map(([, input]) => input.text.split(".")[0])).toEqual([
        "Correction to the evidence, not the plan",
      ]);
    } finally {
      replies.mockRestore();
      lines.mockRestore();
      reports.mockRestore();
    }
  }, 60_000);

  it("counts a thread reply under a card the replay never showed, and the answer that did not play", async () => {
    const dir = scratchDir("infinitary-replay-thread-skip-");
    try {
      const sources = fixture("sep30-handoff-agree");
      const tables = JSON.parse(readFileSync(sources.tablesPath ?? "", "utf8")) as {
        card_messages: { card_id: string; who: string }[];
      };
      for (const row of tables.card_messages) {
        if (row.who === "captain") row.card_id = "card-1cf310e2-never-shown";
      }
      const tablesPath = join(dir, "tables.json");
      writeFileSync(tablesPath, JSON.stringify(tables));
      const report = await replaySession({ ...sources, tablesPath });
      expect(report.fidelity).toMatchObject({
        recorded_thread_replies: 1,
        skipped_thread_replies: 1,
        recorded_crewmate_turns: 2,
        played_crewmate_turns: 1,
      });
      // The planner's answer is listed, named by the reply that never reached it.
      expect(report.details.unplayed_crewmate_turns).toEqual([
        { crewmate: "1cf310e2", turn: 1, at: expect.any(String), reason: "reply-not-delivered" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("scores the recorded miss: the agreed plan was answered with no builder started", () => {
    expect(sep30HandoffAgree.details.approvals).toEqual([
      {
        card: "card-1cf310e2-fm-crew-fi3-309-plan",
        choice: "agree",
        builds: true,
        plan: "FI3-309",
        grounded_starts: 0,
      },
    ]);
    expect(sep30HandoffAgree.metrics.approval_handoff_share).toEqual({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
  });

  it("scores the explicit start: exactly one builder, grounded on the agreed plan, and its first turn plays", () => {
    expect(oct01HandoffStart.details.approvals).toEqual([
      {
        card: "card-fm-4-c3408c",
        choice: "start-implementation",
        builds: true,
        plan: "FI3-309",
        grounded_starts: 1,
      },
    ]);
    expect(oct01HandoffStart.metrics.approval_handoff_share).toEqual({
      value: 1,
      numerator: 1,
      denominator: 1,
    });
    // FI3-310 was still waiting when the window opened, though the tables
    // hold it as it closed later; the builder's recorded first turn plays.
    expect(oct01HandoffStart.fidelity).toMatchObject({
      recorded_captain_turns: 2,
      replayed_captain_turns: 2,
      crewmate_sessions: 1,
      unrecorded_crewmate_turns: 0,
      skipped_card_resolutions: 0,
    });
  });

  it("fails the gate when the host stops starting planned work on request", async () => {
    const refuse = vi
      .spyOn(CrewSupervisor.prototype, "startQueuedNow")
      .mockImplementation(async () => "Cannot start this task now.");
    try {
      const report = await replaySession(fixture("oct01-handoff-start"));
      expect(report.details.approvals.map((approval) => approval.grounded_starts)).toEqual([0]);
      const regressions = compareToBaseline(
        { "oct01-handoff-start": report.metrics },
        { "oct01-handoff-start": readBaseline(BASELINE).sessions["oct01-handoff-start"] ?? {} },
      );
      expect(regressions.map((regression) => regression.metric)).toContain(
        "approval_handoff_share",
      );
    } finally {
      refuse.mockRestore();
    }
  }, 60_000);
});

/** Synthetic recordings: lines on one recorded hour, as a Pi session holds them. */
const at = (minute: number, second: number) => Date.UTC(2026, 9, 1, 9, minute, second);
const iso = (minute: number, second: number) => new Date(at(minute, second)).toISOString();
type Line = { at: number; message: Record<string, unknown> };
const user = (when: number, text: string): Line => ({
  at: when,
  message: { role: "user", content: [{ type: "text", text }] },
});
const call = (when: number, id: string, name: string, args: Record<string, unknown>): Line => ({
  at: when,
  message: {
    role: "assistant",
    provider: "replay",
    model: "recorded",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});
const result = (when: number, id: string, name: string, text: string): Line => ({
  at: when,
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
  },
});
const said = (when: number, text: string): Line => ({
  at: when,
  message: {
    role: "assistant",
    provider: "replay",
    model: "recorded",
    stopReason: "stop",
    content: [{ type: "text", text }],
  },
});
const captain = (words: string) =>
  frameServedInput([
    { kind: "context", body: "[fm-op] context (not the user)\nrepos: []" },
    { kind: "user", body: `[user]\n${words}`, origin: "captain" },
  ]).text;

/** A userData holding one Pi session file in each session folder, the tables beside it. */
function recordings(
  sessions: { dir: string[]; lines: Line[] }[],
  tables: Record<string, unknown[]>,
): string {
  const root = scratchDir("infinitary-replay-recording-");
  for (const [n, session] of sessions.entries()) {
    const dir = join(root, ...session.dir);
    mkdirSync(dir, { recursive: true });
    const id = `s${n}`;
    const entries = [
      { type: "session", version: 3, id, timestamp: iso(0, 0), cwd: "/wt" },
      ...session.lines.map((line, index) => ({
        type: "message",
        id: `${id}-m${index}`,
        timestamp: new Date(line.at).toISOString(),
        message: line.message,
      })),
    ];
    writeFileSync(
      join(dir, `2026-10-01T09-00-00-000Z_${id}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }
  writeFileSync(join(root, "tables.json"), JSON.stringify(tables));
  return root;
}

/** A userData holding one Pi session file, the tables beside it. */
function recording(sessionDir: string[], lines: Line[], tables: Record<string, unknown[]>) {
  return recordings([{ dir: sessionDir, lines }], tables);
}

describe("recorded task card retirements", () => {
  const TASK = "c0ffee99";
  const CARD = "card-fm-1-c0ffee";
  const TITLE = "The task is settled";
  const CLOSED = at(0, 10);

  function retirementRecording(
    options: {
      reason?: string;
      task?: Record<string, unknown>;
      card?: Record<string, unknown>;
      actionId?: string;
      shown?: boolean;
    } = {},
  ) {
    const reason = options.reason ?? "discarded";
    const actions = options.actionId
      ? [
          { id: options.actionId, label: "Inspect the result", default: true },
          { id: "leave", label: "Leave it" },
        ]
      : [];
    return recording(
      ["firstmate", "sessions"],
      [
        user(at(0, 1), captain("What happened to the task?")),
        ...(options.shown === false
          ? []
          : [
              call(at(0, 2), "c1", "emit_card", {
                task_id: TASK,
                title: TITLE,
                body: "<p>The task is settled; its result is available to inspect.</p>",
                actions,
              }),
              result(at(0, 3), "c1", "emit_card", `Card shown: ${TITLE} (${CARD})`),
            ]),
        said(at(0, 4), "The result is available."),
      ],
      {
        tasks: [
          {
            id: TASK,
            title: "Recorded task",
            status: reason === "merged" ? "done" : "dropped",
            created_at: at(0, 0),
            closed_at: CLOSED,
            closed_reason: reason,
            ...options.task,
          },
        ],
        cards: [
          {
            id: CARD,
            task_id: TASK,
            title: TITLE,
            actions_json: JSON.stringify(actions),
            created_at: at(0, 3),
            resolved_at: CLOSED + 1,
            chosen_action: reason,
            ...options.card,
          },
        ],
      },
    );
  }

  it.each([
    { reason: "discarded", offset: 1, shown: true },
    { reason: "merged", offset: 0, shown: true },
    { reason: "discarded", offset: 1, shown: false },
  ])(
    "does not admit or skip a $reason retirement (offset $offset, shown $shown)",
    async (options) => {
      const root = retirementRecording({
        ...options,
        card: { resolved_at: CLOSED + options.offset },
      });
      const choices = vi.spyOn(CrewSupervisor.prototype, "act");
      try {
        const report = await replaySession(discoverSources({ name: "retirement", root }));
        expect(choices).not.toHaveBeenCalled();
        expect(report.details.retired_cards).toEqual([TITLE]);
        expect(report.details.refused_card_choices).toEqual([]);
        expect(report.details.withdrawn_cards).toEqual([]);
        expect(report.fidelity.skipped_card_resolutions).toBe(0);
      } finally {
        choices.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "a declared action matching the close reason", actionId: "discarded" },
    { name: "a different choice", card: { chosen_action: "inspect" } },
    { name: "a different close reason", task: { closed_reason: "merged" } },
    { name: "no close reason", task: { closed_reason: null } },
    { name: "no close timestamp", task: { closed_at: null } },
    { name: "no card creation timestamp", card: { created_at: null } },
    { name: "a resolution before the close", card: { resolved_at: CLOSED - 1 } },
    { name: "a card created after the close", card: { created_at: CLOSED + 1 } },
    { name: "another task's close", card: { task_id: "another-task" } },
  ])("keeps $name on the admission path", async ({ name: _name, ...options }) => {
    const root = retirementRecording(options);
    const choices = vi.spyOn(CrewSupervisor.prototype, "act");
    try {
      const report = await replaySession(discoverSources({ name: "choice", root }));
      // This is the admission safeguard's own witness, not sep14-real's
      // host retirement: the current host refuses a choice on a closed task.
      expect(report.details.retired_cards).toEqual([]);
      if (options.actionId) {
        // Current emission refuses decisions on closed tasks before their
        // historical choice can reach admission. It still counts as input.
        expect(choices).not.toHaveBeenCalled();
        expect(report.details.refused_card_choices).toEqual([]);
      } else {
        // A note can still be shown on a closed task, but a recorded choice
        // on it is invalid and must reach the closed-task admission guard.
        expect(choices).toHaveBeenCalledOnce();
        expect(report.details.refused_card_choices).toEqual([TITLE]);
      }
      expect(report.fidelity.skipped_card_resolutions).toBe(1);
    } finally {
      choices.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a captain dismissal as an input", async () => {
    const root = retirementRecording({ card: { chosen_action: "close" } });
    const closes = vi.spyOn(CrewSupervisor.prototype, "close");
    try {
      const report = await replaySession(discoverSources({ name: "dismissal", root }));
      expect(closes).toHaveBeenCalledOnce();
      expect(report.details.retired_cards).toEqual([]);
      expect(report.fidelity.skipped_card_resolutions).toBe(0);
    } finally {
      closes.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The captain's replies in card threads (FI3-429). The recorded tables carry
 * the thread (`card_messages`), and each captain line is replayed through the
 * host's own reply path: on a crewmate's card it is a steer to that crewmate,
 * whose recorded answer then plays; on the Firstmate's own card it is the
 * captain turn about the card the recording holds, played once.
 */
describe("card-thread replies", () => {
  /** The thread lines the host wrote on each card, in order. */
  function threads(lines: { mock: { calls: unknown[][] } }): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [card, who, text] of lines.mock.calls as [string, string, string][]) {
      out[card] = [...(out[card] ?? []), `${who}: ${text}`];
    }
    return out;
  }

  describe("on the Firstmate's own card", () => {
    const CARD = "card-fm-1-a1b2c3";
    const firstmate = (replyCard: string) =>
      recording(
        ["firstmate", "sessions"],
        [
          user(at(0, 1), captain("Should we release tonight?")),
          call(at(0, 2), "c1", "emit_card", {
            standalone: true,
            title: "The release waits for the sign-in fix",
            body: "<p>The release waits until the sign-in fix merges, so it ships with the fix.</p>",
          }),
          result(
            at(0, 3),
            "c1",
            "emit_card",
            `Card shown: The release waits for the sign-in fix (${CARD})`,
          ),
          said(at(0, 4), "Holding the release."),
          user(at(2, 1), captain("why not tonight?")),
          said(at(2, 2), "The sign-in fix is still in review."),
        ],
        {
          cards: [
            {
              id: CARD,
              task_id: null,
              title: "The release waits for the sign-in fix",
              author: "firstmate",
              actions_json: "[]",
              created_at: at(0, 3),
              resolved_at: null,
            },
          ],
          card_messages: [
            { id: 1, card_id: replyCard, who: "captain", text: "why not tonight?", at: at(2, 0) },
            {
              id: 2,
              card_id: replyCard,
              who: "firstmate",
              text: "The sign-in fix is still in review.",
              at: at(2, 3),
            },
          ],
        },
      );

    it("plays the recorded turn once, as the captain's turn about that card, and its closing words answer the thread", async () => {
      const root = firstmate(CARD);
      const turns = vi.spyOn(FirstmateAgent.prototype, "converse");
      const lines = vi.spyOn(CardService.prototype, "addMessage");
      try {
        const report = await replaySession(discoverSources({ name: "thread", root }));
        expect(report.fidelity).toMatchObject({
          recorded_captain_turns: 2,
          replayed_captain_turns: 2,
          recorded_thread_replies: 1,
          skipped_thread_replies: 0,
        });
        const shown = Object.keys(threads(lines))[0] ?? "";
        expect(shown).toMatch(/^card-fm-/);
        expect(threads(lines)).toEqual({
          [shown]: ["captain: why not tonight?", "firstmate: The sign-in fix is still in review."],
        });
        // One converse per captain turn: the reply's turn carries its card,
        // and is never also played as plain words.
        expect(turns.mock.calls.map(([turn]) => turn)).toEqual([
          "Should we release tonight?",
          expect.objectContaining({ text: "why not tonight?", aboutCardId: shown }),
        ]);
      } finally {
        turns.mockRestore();
        lines.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);

    it("never forces a reply under a card the replay did not show through as plain words", async () => {
      const root = firstmate("card-fm-9-never-shown");
      try {
        const report = await replaySession(discoverSources({ name: "thread", root }));
        expect(report.fidelity).toMatchObject({
          recorded_captain_turns: 2,
          replayed_captain_turns: 1,
          recorded_thread_replies: 1,
          skipped_thread_replies: 1,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  });

  it("steers the crewmate on its own card, whose recorded prose answer plays into the thread", async () => {
    const TASK = "c0ffee01";
    const CARD = `card-${TASK}-plan`;
    const root = recording(
      ["crewmates", TASK, "sessions"],
      [
        user(at(0, 1), "Goal: Plan solid cards for the main stack."),
        call(at(0, 2), "c1", "emit_card", {
          id: "plan",
          title: "Plan: solid cards on the main stack",
          body: "<p>Every card on the main stack goes solid, so text behind it never shows through.</p>",
        }),
        result(
          at(0, 3),
          "c1",
          "emit_card",
          `Card shown: Plan: solid cards on the main stack (${CARD})`,
        ),
        call(at(0, 4), "c2", "report", { text: "The plan card is up." }),
        result(at(0, 5), "c2", "report", "Reported."),
        user(at(3, 1), "The captain replied in the thread on your card."),
        call(at(3, 2), "c3", "reply", {
          card_id: CARD,
          text: "The pictures came from the hidden test window; the plan stands.",
        }),
        result(at(3, 3), "c3", "reply", "Replied."),
        call(at(3, 4), "c4", "report", { text: "Answered the captain in the thread." }),
        result(at(3, 5), "c4", "report", "Reported."),
      ],
      {
        cards: [
          {
            id: CARD,
            task_id: TASK,
            title: "Plan: solid cards on the main stack",
            author: "crewmate",
            actions_json: "[]",
            created_at: at(0, 3),
            resolved_at: null,
          },
        ],
        card_messages: [
          { id: 1, card_id: CARD, who: "captain", text: "are those pictures right?", at: at(3, 0) },
        ],
      },
    );
    const lines = vi.spyOn(CardService.prototype, "addMessage");
    try {
      const report = await replaySession(discoverSources({ name: "thread", root }));
      expect(report.fidelity).toMatchObject({
        recorded_crewmate_turns: 2,
        played_crewmate_turns: 2,
        recorded_thread_replies: 1,
        skipped_thread_replies: 0,
      });
      const shown = Object.keys(threads(lines))[0] ?? "";
      expect(shown).toMatch(/-plan$/);
      expect(threads(lines)).toEqual({
        [shown]: [
          "captain: are those pictures right?",
          "crewmate: The pictures came from the hidden test window; the plan stands.",
        ],
      });
    } finally {
      lines.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("plays an unanswered ordinary note read as a silent turn, keeping the next recorded reply", async () => {
    const TASK = "c0ffee02";
    const NOTE = `card-${TASK}-note`;
    const PLAN = `card-${TASK}-plan`;
    const root = recording(
      ["crewmates", TASK, "sessions"],
      [
        user(at(0, 1), "Goal: Plan solid cards for the main stack."),
        call(at(0, 2), "c1", "emit_card", {
          id: "note",
          title: "The stack was measured",
          body: "<p>The main stack draws four cards at most.</p>",
        }),
        result(at(0, 3), "c1", "emit_card", `Card shown: The stack was measured (${NOTE})`),
        call(at(0, 4), "c2", "emit_card", {
          id: "plan",
          title: "Plan: solid cards on the main stack",
          body: "<p>Every card on the main stack goes solid, so text behind it never shows through.</p>",
        }),
        result(
          at(0, 5),
          "c2",
          "emit_card",
          `Card shown: Plan: solid cards on the main stack (${PLAN})`,
        ),
        call(at(0, 6), "c3", "report", { text: "The plan card is up beside the measurement." }),
        result(at(0, 7), "c3", "report", "Reported."),
        user(at(3, 1), "The captain replied in the thread on your card."),
        call(at(3, 2), "c4", "reply", {
          card_id: PLAN,
          text: "The pictures came from the hidden test window; the plan stands.",
        }),
        result(at(3, 3), "c4", "reply", "Replied."),
        call(at(3, 4), "c5", "report", { text: "Answered the captain in the thread." }),
        result(at(3, 5), "c5", "report", "Reported."),
      ],
      {
        cards: [
          {
            id: NOTE,
            task_id: TASK,
            title: "The stack was measured",
            author: "crewmate",
            actions_json: "[]",
            created_at: at(0, 3),
            resolved_at: at(2, 0),
            chosen_action: "close",
          },
          {
            id: PLAN,
            task_id: TASK,
            title: "Plan: solid cards on the main stack",
            author: "crewmate",
            actions_json: "[]",
            created_at: at(0, 5),
            resolved_at: null,
          },
        ],
        card_messages: [
          { id: 1, card_id: PLAN, who: "captain", text: "are those pictures right?", at: at(3, 0) },
        ],
      },
    );
    const lines = vi.spyOn(CardService.prototype, "addMessage");
    try {
      const report = await replaySession(discoverSources({ name: "close", root }));
      // An ordinary read reaches its author. The recording holds no answer
      // to that input, so the replay records a silent turn, never inventing
      // a response or consuming the later recorded thread reply.
      expect(report.fidelity).toMatchObject({
        recorded_crewmate_turns: 2,
        played_crewmate_turns: 2,
        unrecorded_crewmate_turns: 1,
        skipped_card_resolutions: 0,
        recorded_thread_replies: 1,
        skipped_thread_replies: 0,
      });
      expect(report.details.unplayed_crewmate_turns).toEqual([]);
      expect(Object.values(threads(lines))).toEqual([
        [
          "captain: are those pictures right?",
          "crewmate: The pictures came from the hidden test window; the plan stands.",
        ],
      ]);
    } finally {
      lines.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Which recorded crewmate turn answers what the host serves (FI3-442). A
 * served input plays the turn whose recorded input holds the same words;
 * words the recording holds no answer to play nothing; and every recorded
 * turn that never plays is listed with why.
 */
describe("crewmate turns", () => {
  it("plays each served input's own recorded turn, and names why the others never played", async () => {
    const TASK = "c0ffee04";
    const WAITING = "c0ffee05";
    const LIGHT = "Check the light theme too.";
    const DARK = "Check the dark theme too.";
    const AGAIN = "Look at the contrast once more.";
    const steer = (minute: number, words: string, message: string, answer: string) => [
      user(at(minute, 0), captain(words)),
      call(at(minute, 1), `s${minute}`, "steer_crewmate", { task_id: TASK, message }),
      result(at(minute, 2), `s${minute}`, "steer_crewmate", answer),
      said(at(minute, 3), "Passed on."),
    ];
    const answer = (when: number, id: string, text: string) => [
      call(when + 1_000, id, "report", { text }),
      result(when + 2_000, id, "report", "Reported."),
    ];
    const root = recordings(
      [
        {
          dir: ["firstmate", "sessions"],
          lines: [
            ...steer(3, "check the light theme too", LIGHT, `Steered task ${TASK}.`),
            // Refused that night, so the crewmate never heard it: today it lands.
            ...steer(
              5,
              "and the dark one",
              DARK,
              `Task ${TASK} is being triaged by fleet supervision right now; try again in a moment.`,
            ),
            // Sent a quarter of an hour after the crewmate's recording shows it.
            ...steer(21, "look at the contrast once more", AGAIN, `Steered task ${TASK}.`),
          ],
        },
        {
          dir: ["crewmates", TASK, "sessions"],
          lines: [
            user(at(0, 1), "Goal: Check the card stack's contrast."),
            ...answer(at(0, 1), "r0", "The stack's contrast passes."),
            user(at(1, 0), 'Card "Plan: solid cards": the user chose "Go ahead" (go).'),
            ...answer(at(1, 0), "r1", "Answering the choice."),
            user(at(3, 4), LIGHT),
            ...answer(at(3, 4), "r2", "Answering the light theme."),
            user(at(5, 30), '[job] background job abc123 finished: "pnpm test" exited 0 after 2s'),
            ...answer(at(5, 30), "r3", "Answering the test run."),
            user(at(6, 0), AGAIN),
            ...answer(at(6, 0), "r4", "Answering the contrast check."),
          ],
        },
        {
          dir: ["crewmates", WAITING, "sessions"],
          lines: [
            user(at(2, 0), "Goal: Measure the composer."),
            ...answer(at(2, 0), "w0", "The composer is measured."),
          ],
        },
      ],
      {
        // Planned before the recording begins and left on request: nothing starts it.
        tasks: [
          {
            id: WAITING,
            title: "Measure the composer",
            kind: "work",
            status: "open",
            start_policy: "on-request",
            created_at: at(0, 0),
          },
        ],
        cards: [],
      },
    );
    const record = TaskService.prototype.recordReport;
    const reports: { at: number; text: string }[] = [];
    const spy = vi.spyOn(TaskService.prototype, "recordReport").mockImplementation(function (
      this: TaskService,
      ...args
    ) {
      reports.push({ at: Date.now(), text: args[1].text });
      return record.apply(this, args);
    });
    try {
      const report = await replaySession(discoverSources({ name: "turns", root }));
      // The light-theme steer reached the replay as its captain turn began,
      // a moment before the crewmate's recording shows it, and played its
      // own answer, not the turn waiting on the choice that never came; the
      // dark-theme steer the recording refused played nothing, so the test
      // run's notice played its own answer.
      const heard = (from: number, to: number) =>
        reports.filter((entry) => entry.at >= from && entry.at < to).map((entry) => entry.text);
      expect(heard(at(0, 0), at(1, 0))).toEqual(["The stack's contrast passes."]);
      expect(heard(at(1, 0), at(3, 0))).toEqual([]);
      expect(heard(at(3, 0), at(5, 0))).toEqual(["Answering the light theme."]);
      expect(heard(at(5, 0), at(5, 30))).toEqual([]);
      expect(heard(at(5, 30), at(30, 0))).toEqual(["Answering the test run."]);
      expect(report.fidelity).toMatchObject({
        recorded_crewmate_turns: 6,
        played_crewmate_turns: 3,
        // The dark-theme steer and the late contrast steer.
        unrecorded_crewmate_turns: 2,
      });
      expect(report.details.unplayed_crewmate_turns).toEqual([
        { crewmate: TASK, turn: 1, at: iso(1, 0), reason: "card-not-shown" },
        { crewmate: TASK, turn: 4, at: iso(6, 0), reason: "steer-not-received" },
        { crewmate: WAITING, turn: 0, at: iso(2, 0), reason: "not-started" },
      ]);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * The action catalog (FI3-515). The replay binds no app dispatcher, so
 * `app_state` and `app_change` answer from the recording, as the repo tools
 * they replaced still do for a recording from before them. A recorded
 * change answers an escalation only when it applied: a refusal is words.
 */
describe("the action catalog in a recording", () => {
  const TASK = "c0ffee03";
  const TITLE = "Check the light theme's contrast";
  const EXCERPT = "Light passes contrast; switching to it is the captain's call.";
  const CHANGE = {
    action: "theme",
    value: { theme: "light" },
    evidence: "Switch to light once it passes contrast.",
  };

  /** What today's `app_change` answers on a stand-in app, on the report's wake. */
  async function appChangeAnswer(change: typeof CHANGE): Promise<string> {
    let appearance: unknown = { theme: "dark" };
    const dispatch = async (channel: string, args: unknown) => {
      if (channel === "inf:settings:appearance:set") appearance = (args as unknown[])[0];
      return appearance;
    };
    const tool = createAppTools({
      dispatch: dispatch as CoreDispatch,
      actor: () => ({ kind: "firstmate", wake: "other" }),
    }).find((candidate) => candidate.name === "app_change");
    if (!tool) throw new Error("app_change is missing from the app tools");
    return (await tool.run(change)).text;
  }

  /**
   * A crewmate's report the whose-turn rule hands the Firstmate, which
   * answered it by changing the theme; before it, a captain turn recorded
   * before the catalog changed a project through `configure_repo`.
   */
  function escalationAnsweredWith(change: typeof CHANGE, answer: string): string {
    const wake = frameServedInput([
      { kind: "context", body: "[fm-op] context (not the user)\nrepos: []" },
      {
        kind: "wake",
        body: `[fm-op] crewmate 1 reported on task ${TASK} "${TITLE}": ${EXCERPT}`,
        origin: "crewmate-report",
      },
    ]).text;
    return recordings(
      [
        {
          dir: ["firstmate", "sessions"],
          lines: [
            user(at(0, 1), captain("Make nimbus-api local-only.")),
            call(at(0, 2), "f1", "configure_repo", {
              repo_id: "repo-nimbus",
              delivery: "local-only",
              evidence: "Make nimbus-api local-only.",
            }),
            result(at(0, 3), "f1", "configure_repo", "nimbus-api now delivers local-only."),
            said(at(0, 4), "nimbus-api is local-only now."),
            user(at(0, 10), wake),
            call(at(0, 11), "f2", "app_state", { area: "appearance" }),
            result(at(0, 12), "f2", "app_state", JSON.stringify([{ action: "theme" }])),
            call(at(0, 13), "f3", "app_change", change),
            result(at(0, 14), "f3", "app_change", answer),
            said(at(0, 15), "Answered the contrast report."),
          ],
        },
        {
          dir: ["crewmates", TASK, "sessions"],
          lines: [
            user(at(0, 5), `Goal: ${TITLE}.`),
            call(at(0, 6), "c1", "report", { text: EXCERPT }),
            result(at(0, 7), "c1", "report", "Reported."),
          ],
        },
      ],
      {},
    );
  }

  // INF-751: the captain's words quoted as evidence apply on a report's wake;
  // a change with no ask behind it is refused.
  it.each([
    { recorded: "an applied change", change: CHANGE, handled: true },
    { recorded: "a refused change", change: { ...CHANGE, evidence: "" }, handled: false },
  ])(
    "scores the escalation answered by $recorded as handled: $handled",
    async ({ change, handled }) => {
      const root = escalationAnsweredWith(change, await appChangeAnswer(change));
      try {
        const report = await replaySession(discoverSources({ name: "catalog", root }));
        expect(report.fidelity).toMatchObject({
          recorded_captain_turns: 1,
          replayed_captain_turns: 1,
          recorded_op_turns: 1,
          played_op_turns: 1,
          missing_tools: [],
        });
        expect(report.details.escalations).toEqual([
          expect.objectContaining({ handled, scored: true }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/**
 * The captain's own labels and surfaces (FI3-562): `flag_duplicate` runs
 * against the replay's own cards, so its label reaches the duplicate metric,
 * while `personalize`, `install_plugin` and the knowledge pair answer from
 * the recording. None of them is a missing tool.
 */
describe("the captain's labels and surfaces in a recording", () => {
  const FIRST = "card-fm-1-a1b2c3";
  const SECOND = "card-fm-2-d4e5f6";
  const note = (title: string, body: string) => ({ standalone: true, title, body });

  function labelsAndSurfaces(): string {
    return recording(
      ["firstmate", "sessions"],
      [
        user(at(0, 1), captain("Is tonight's release ready?")),
        call(
          at(0, 2),
          "f1",
          "emit_card",
          note("Tonight's release is ready", "<p>Every check passed on the release branch.</p>"),
        ),
        result(at(0, 3), "f1", "emit_card", `Card shown: Tonight's release is ready (${FIRST})`),
        said(at(0, 4), "Release ready."),
        user(at(1, 1), captain("And can it ship this evening?")),
        call(
          at(1, 2),
          "f2",
          "emit_card",
          note("Shipping this evening works", "<p>Nothing holds the build after 6 PM.</p>"),
        ),
        result(at(1, 3), "f2", "emit_card", `Card shown: Shipping this evening works (${SECOND})`),
        said(at(1, 4), "It can ship."),
        user(at(2, 1), captain("That second card says the same as the first.")),
        call(at(2, 2), "f3", "flag_duplicate", {
          card_id: SECOND,
          duplicate_of: FIRST,
          note: "That second card says the same as the first.",
        }),
        result(
          at(2, 3),
          "f3",
          "flag_duplicate",
          `Recorded card ${SECOND} as a duplicate of ${FIRST} and closed it.`,
        ),
        said(at(2, 4), "Closed the repeat."),
        user(at(3, 1), captain("Take the usage panel away.")),
        call(at(3, 2), "f4", "personalize", {
          action: "remove",
          surface: "usage",
          evidence: "Take the usage panel away.",
        }),
        result(
          at(3, 3),
          "f4",
          "personalize",
          "Usage is an app panel, so it is hidden rather than removed; app_change panel with visible true brings it back.",
        ),
        said(at(3, 4), "Usage hidden."),
        user(at(4, 1), captain("Add the weather panel from npm, weather-panel.")),
        call(at(4, 2), "f5", "install_plugin", {
          from: "npm",
          spec: "weather-panel",
          evidence: "Add the weather panel from npm, weather-panel.",
        }),
        result(
          at(4, 3),
          "f5",
          "install_plugin",
          '"Weather" by weather-panel 1.0.0 is fetched and checked. The captain is asked on a card what it can read; it goes in only if they say yes there. Say nothing more about it.',
        ),
        said(at(4, 4), "Asked on its card."),
        user(at(5, 1), captain("Keep it known that releases leave on Thursdays.")),
        call(at(5, 2), "f6", "knowledge", { action: "search", query: "release day" }),
        result(at(5, 3), "f6", "knowledge", 'No knowledge matched "release day".'),
        call(at(5, 4), "f7", "record_knowledge", {
          action: "publish",
          kind: "concept",
          title: "Release day",
          text: "Releases leave on Thursdays.",
          request_id: "r1",
        }),
        result(
          at(5, 5),
          "f7",
          "record_knowledge",
          "Recorded concept c-release-day (revision 1) in firstmate-3000.",
        ),
        said(at(5, 6), "Kept."),
      ],
      {},
    );
  }

  it("serves every call, lands the duplicate label on its replayed card, and counts each answer as acted", async () => {
    const root = labelsAndSurfaces();
    try {
      const report = await replaySession(discoverSources({ name: "labels", root }));
      expect(report.fidelity).toMatchObject({
        recorded_captain_turns: 6,
        replayed_captain_turns: 6,
        missing_tools: [],
      });
      // The two notes share no words, so only the captain's label pairs them.
      expect(report.details.duplicate_pairs).toEqual([]);
      expect(report.metrics.duplicate_card_pairs.value).toBe(1);
      expect(report.metrics.asks_without_action.value).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("answers a recorded call to every tool the Firstmate holds today", async () => {
    const calls = FIRSTMATE_TOOLS.flatMap(({ name }, n) => [
      call(at(0, 2), `t${n}`, name, {}),
      result(at(0, 2), `t${n}`, name, "Refused: nothing was asked."),
    ]);
    const root = recording(
      ["firstmate", "sessions"],
      [user(at(0, 1), captain("Try every tool once.")), ...calls, said(at(0, 3), "Tried.")],
      {},
    );
    try {
      const report = await replaySession(discoverSources({ name: "every-tool", root }));
      expect(report.fidelity).toMatchObject({ replayed_captain_turns: 1, missing_tools: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * R2 framing: a recording made after the host started framing its served
 * inputs must replay exactly like the same evening recorded before. The
 * sep14 reconstruction is rewritten into the framed form the host now emits
 * (Firstmate turns and supervision wakes alike) and replayed.
 */
describe("framed recordings (R2)", () => {
  function framedText(text: string, role: "firstmate" | "supervision"): string {
    if (role === "supervision") {
      const end = text.indexOf("\n\n[context]");
      if (!text.startsWith("[wake] ") || end < 0) return text;
      return frameServedInput([
        { kind: "wake", body: text.slice(0, end), origin: "crewmate-report" },
        { kind: "context", body: text.slice(end + 2) },
      ]).text;
    }
    const parsed = parseTurnText(text);
    if (parsed.kind_basis !== "host-framing" || parsed.context === null) return text;
    const segments: ServedSegmentInput[] = [
      { kind: "context", body: parsed.context },
      ...parsed.ops.map((body): ServedSegmentInput => ({ kind: "wake", body, origin: "agent" })),
    ];
    if (parsed.user !== null) {
      segments.push({ kind: "user", body: `[user]\n${parsed.user}`, origin: "captain" });
    }
    return frameServedInput(segments).text;
  }

  function frameFile(file: string, role: "firstmate" | "supervision"): number {
    let framed = 0;
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        const message = entry.message;
        if (message?.role !== "user") return line;
        const rewrite = (text: string) => {
          const out = framedText(text, role);
          if (out !== text) framed += 1;
          return out;
        };
        if (typeof message.content === "string") {
          message.content = rewrite(message.content);
        } else if (Array.isArray(message.content)) {
          for (const part of message.content as { type?: string; text?: string }[]) {
            if (part.type === "text" && typeof part.text === "string")
              part.text = rewrite(part.text);
          }
        }
        return JSON.stringify(entry);
      });
    writeFileSync(file, lines.join("\n"));
    return framed;
  }

  it("replays a framed copy of sep14 with the same fidelity and scores", async () => {
    const root = scratchDir("infinitary-framed-replay-");
    try {
      const copy = join(root, "sep14");
      cpSync(join(FIXTURES, "sep14"), copy, { recursive: true });
      const sources = discoverSources({ name: "sep14", root: copy });
      let framed = 0;
      for (const file of sources.orchestratorFiles) framed += frameFile(file, "firstmate");
      for (const file of sources.supervisionFiles) framed += frameFile(file, "supervision");
      expect(framed).toBeGreaterThan(0);
      const report = await replaySession(sources);
      expect(report.fidelity).toEqual(sep14.fidelity);
      expect(report.metrics).toEqual(sep14.metrics);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("the answer-delivery row (observational)", () => {
  it("counts the recorded captain messages no action took effect after, read off the recording", () => {
    // sep14: a start refused because its branch existed, and two steers
    // refused under the old triage claim. The current host would let those
    // steers land, but the row reads what the recording shows happened that
    // night, so a host change cannot hide a message that went unanswered.
    expect(sep14.metrics.asks_without_action.value).toBe(3);
    // sep26-claude: "How is the crew doing?" was answered with a lookup and
    // closing words, which are no action under the cards-only contract.
    expect(sep26Claude.metrics.asks_without_action.value).toBe(1);
    for (const report of [sep04, sep04Real, sep14Real, sep30HandoffAgree, oct01HandoffStart]) {
      expect(report.metrics.asks_without_action.value, report.session).toBe(0);
    }
  });
});

describe("the nine frustration modes (report.md section 2.2)", () => {
  it("F1 ghost crew: no done or dropped row keeps its worktree after boot hygiene and the reconcile", () => {
    const tables = readRecordedTables(join(FIXTURES, "sep14", "tables.json"));
    // The recording starts with closed rows still holding worktrees.
    expect(
      tables.tasks.filter((row) => row.status === "dropped" && row.workspace_state === "present")
        .length,
    ).toBeGreaterThan(0);
    expect(sep14.metrics.closed_rows_with_worktree.value).toBe(0);
    expect(sep14.details.closed_with_worktree).toEqual([]);
  });

  it("F2 locked out: steers the recording saw refused under a triage claim now land", () => {
    // The recording still carries the refusals; S7c retired the claim that
    // produced them, so the current code has no way to say it at all.
    expect(readAll(join(FIXTURES, "sep14"))).toContain("being triaged by fleet supervision");
    expect(sep14.metrics.lock_refusals.value).toBe(0);
  });

  it("F3 corrupted crewmate: garbled text never becomes a report, and nothing closes as delivered without evidence", () => {
    expect(readAll(join(FIXTURES, "sep14"))).toContain("to=functions.bash");
    expect(sep14.metrics.implausible_outcomes.value).toBe(0);
    expect(sep14.metrics.closed_without_evidence.value).toBe(0);
  });

  it("F4 duplicate cards: a Firstmate restatement of an on-screen crewmate card is refused, and the pairs left are measured", () => {
    // The recording has three repeat pairs (the deriver finds all three in
    // the tables). The Firstmate's restatement of crewmate card
    // "closeRecord sets delivered on idle cancel" arrives while that card is
    // still open, so the steer-not-answer lint (WI-12) refuses it; the c9
    // restatement follows a plan card the captain already answered, and the
    // crewmate's own restated note is a crewmate-side repeat.
    expect(sep14.metrics.duplicate_card_pairs.value).toBe(sep14.details.duplicate_pairs.length);
    expect(sep14.details.duplicate_pairs.map((pair) => [pair.task, pair.second]).sort()).toEqual([
      ["c9dab1e7", "Plan: trace the stalled-crewmate escalations"],
      ["d299b1e5", "Delivered rows keep their worktree on the board"],
    ]);
  });

  it("F5 explain, don't solve: answered-in-turn and default-action shares are measured", () => {
    expect(sep14.metrics.questions_answered_in_turn.denominator).toBeGreaterThanOrEqual(10);
    expect(sep14.metrics.questions_answered_in_turn.value).not.toBeNull();
    expect(sep14.metrics.answer_cards_with_default.value).not.toBeNull();
    expect(sep14.metrics.captain_reasks_10min.value).toBeGreaterThan(0);
  });

  it("F6 unreadable cards: a table survives the card sanitizer and body length is measured", () => {
    expect(sep14.metrics.visual_card_share.numerator).toBeGreaterThanOrEqual(1);
    expect(sep14.metrics.mean_card_body_chars.value).toBeGreaterThan(0);
  });

  it("F7 fake merge buttons: no card with an undispatchable merge id reaches the stack", () => {
    expect(readAll(join(FIXTURES, "sep04"))).toContain('"id":"merge-pr55"');
    expect(sep04.metrics.fake_merge_buttons.value).toBe(0);
    expect(sep04.details.unanswered_questions).toContain(
      "PR 55 for the flaky quota tests is green, can I merge it?",
    );
  });

  it("F8 branch collision: every spawn the recording saw fail to start now starts", () => {
    expect(readAll(join(FIXTURES, "sep14"))).toContain("could not start because branch");
    expect(sep14.metrics.spawn_start_failures.value).toBe(0);
  });

  it("F9 noise as work: escalations, guidance wakes, and wakes after a cancel stay down", () => {
    expect(sep14.metrics.escalations.value).toBeLessThan(10);
    expect(sep14.metrics.guidance_queued_wakes.value).toBe(0);
    expect(sep14.metrics.wakes_after_cancel.value).toBe(0);
    expect(sep14.metrics.op_wakes_per_captain_turn.value).toBeLessThan(1);
  });
});

describe("the CLI", () => {
  let dir: string;

  beforeAll(() => {
    dir = scratchDir("infinitary-replay-cli-");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<RunDeps> = {}): RunDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      gate: { isPackaged: false },
      loadEngine: async () => ({ replaySession }),
      git: () => ({ head: "0123456789abcdef0123456789abcdef01234567", dirty: false }),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      out,
      err,
      ...overrides,
    };
  }

  function fakeEngine(scores: Partial<Record<keyof MetricScores, number>>): Engine {
    return {
      replaySession: async (sources) => {
        const metrics = scoreSession({
          captainTurns: 0,
          questions: [],
          cards: [],
          opWakes: 0,
          guidanceQueuedWakes: 0,
          escalations: [],
          wakesAfterCancel: 0,
          lockRefusals: scores.lock_refusals ?? 0,
          closedTasks: [],
          implausibleOutcomes: 0,
          spawnStartFailures: 0,
          dispatches: [],
          reviews: [],
        });
        return { ...sep14, session: sources.name, metrics };
      },
    };
  }

  it("preserves explicit pre-S7c archives during fixture export without replaying them", async () => {
    const target = join(dir, "explicit-archives");
    const loadEngine = vi.fn();
    const d = deps({ loadEngine });
    const historical = fixture("sep04");
    expect(
      await run(
        [
          "--user-data",
          join(FIXTURES, "sep26-claude"),
          "--supervision",
          join(FIXTURES, "sep04", "supervision", "sessions"),
          "--export-fixture",
          target,
        ],
        d,
      ),
    ).toBe(0);
    const copy = discoverSources({ name: "copy", root: target });
    expect(copy.supervisionFiles).toHaveLength(1);
    expect(readFileSync(copy.supervisionFiles[0] as string, "utf8")).toBe(
      readFileSync(historical.supervisionFiles[0] as string, "utf8"),
    );
    expect(loadEngine).not.toHaveBeenCalled();
    const replayed = await replaySession(copy);
    expect(replayed.metrics).toEqual(sep26Claude.metrics);
    expect(replayed.fidelity).toEqual(sep26Claude.fidelity);
  }, 60_000);

  it("refuses a packaged build before reading any transcript", async () => {
    const loadEngine = vi.fn();
    const d = deps({ gate: { isPackaged: true }, loadEngine });
    expect(await run(["--fixtures", FIXTURES], d)).toBe(3);
    expect(loadEngine).not.toHaveBeenCalled();
    expect(d.err.join("")).toContain("reads transcripts");
  });

  it("runs in a packaged build only with the explicit INFINITARY_DEV_OBSERVE=1", async () => {
    const d = deps({
      gate: { isPackaged: true, env: { INFINITARY_DEV_OBSERVE: "1" } },
      loadEngine: async () => fakeEngine({}),
    });
    expect(await run(["--fixtures", FIXTURES], d)).toBe(0);
    const report = JSON.parse(d.out.join("")) as ReplayReport;
    expect(report.gate).toEqual({ is_packaged: true, dev_observe_override: true });
  });

  it("reports the commit it ran at and every session's annotated scores", async () => {
    const out = join(dir, "report.json");
    // beforeAll owns these real replays even when this case is selected alone.
    // Exercise the CLI's discovery, annotation, baseline and disk output here,
    // without replaying the same eight recordings a second time for formatting.
    const replayed = [
      sep14,
      sep04,
      sep14Real,
      sep04Real,
      sep26Claude,
      sep30HandoffAgree,
      oct01HandoffStart,
      oct22Program,
    ];
    const unchanged = structuredClone(replayed);
    const replay = vi.fn<Engine["replaySession"]>(async (sources) => {
      const result = replayed.find((report) => report.session === sources.name);
      if (!result) throw new Error(`No prepared replay for ${sources.name}`);
      return structuredClone(result);
    });
    const d = deps({ loadEngine: async () => ({ replaySession: replay }) });
    expect(await run(["--fixtures", FIXTURES, "--baseline", BASELINE, "--out", out], d)).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")) as ReplayReport;
    expect(report.code.head).toBe("0123456789abcdef0123456789abcdef01234567");
    // The real exports (sep14-real, sep04-real, and the handoff's two) sit
    // beside the reconstructions and are discovered in sorted order; every
    // one has a baseline row.
    expect(report.sessions.map((session) => session.session)).toEqual([
      "oct01-handoff-start",
      "oct22-program",
      "sep04",
      "sep04-real",
      "sep14",
      "sep14-real",
      "sep26-claude",
      "sep30-handoff-agree",
    ]);
    const reportedSep14 = report.sessions.find((session) => session.session === "sep14");
    expect(reportedSep14?.scored.lock_refusals).toMatchObject({
      value: 0,
      direction: "lower",
      sep14: "21",
      meets_target: true,
    });
    // Report formatting must carry every real result, not just the one metric
    // whose annotation is pinned above. This also detects a name/cache mismatch.
    expect(replay.mock.calls.map(([sources]) => sources.name)).toEqual(
      report.sessions.map((session) => session.session),
    );
    expect(replayed).toEqual(unchanged);
    for (const result of replayed) {
      expect(report.sessions.find((session) => session.session === result.session)).toMatchObject({
        session: result.session,
        metrics: result.metrics,
        fidelity: result.fidelity,
        provenance: result.provenance,
      });
    }
    expect(report.baseline).toMatchObject({ pass: true, regressions: [] });
  }, 60_000);

  it("fails the gate on a regressed metric and names it", async () => {
    const d = deps({ loadEngine: async () => fakeEngine({ lock_refusals: 4 }) });
    expect(await run(["--fixtures", FIXTURES, "--baseline", BASELINE], d)).toBe(1);
    const report = JSON.parse(d.out.join("")) as ReplayReport;
    expect(report.baseline?.pass).toBe(false);
    expect(report.baseline?.regressions).toContainEqual(
      expect.objectContaining({
        session: "sep14",
        metric: "lock_refusals",
        baseline: 0,
        current: 4,
      }),
    );
    expect(d.err.join("")).toContain("REGRESSION sep14 lock_refusals: rose from 0 to 4");
  });

  it("writes a baseline the same run then passes", async () => {
    const baseline = join(dir, "baseline.json");
    const engine = fakeEngine({ lock_refusals: 2 });
    expect(
      await run(
        ["--fixtures", FIXTURES, "--baseline", baseline, "--write-baseline"],
        deps({ loadEngine: async () => engine }),
      ),
    ).toBe(0);
    expect(readBaseline(baseline).sessions.sep14?.lock_refusals).toBe(2);
    expect(
      await run(
        ["--fixtures", FIXTURES, "--baseline", baseline],
        deps({ loadEngine: async () => engine }),
      ),
    ).toBe(0);
  });

  it("rejects contradictory arguments and an empty source", async () => {
    expect(await run(["--fixtures", FIXTURES, "--user-data", dir], deps())).toBe(2);
    expect(await run(["--fixtures", FIXTURES, "--write-baseline"], deps())).toBe(2);
    expect(await run(["--bogus"], deps())).toBe(2);
    expect(await run(["--user-data", join(dir, "nothing-here")], deps())).toBe(1);
  });

  it("exports a recording as a scrubbed fixture that replays like the original", async () => {
    const source = join(dir, "export-source");
    const sessions = join(source, "firstmate", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "s.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s",
          timestamp: "2026-09-14T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-09-14T00:00:01.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[fm-op] context (not the user)\nquota: none\n\n[user]\nuse sk-ant-api03-LIVEKEYLIVEKEYLIVEKEY now",
              },
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg" },
            ],
          },
        }),
      ].join("\n"),
    );
    writeFileSync(
      join(source, "tables.json"),
      JSON.stringify({
        captain_asks: [
          {
            id: "a1",
            text: "token sk-ant-api03-LIVEKEYLIVEKEYLIVEKEY",
            images_json: '[{"data":"x"}]',
          },
        ],
        card_messages: [
          {
            id: 1,
            card_id: "card-fm-1-a1b2c3",
            who: "captain",
            text: "use sk-ant-api03-LIVEKEYLIVEKEYLIVEKEY for it",
            at: Date.parse("2026-09-14T00:00:02.000Z"),
          },
        ],
      }),
    );
    const target = join(dir, "exported");
    const d = deps();
    expect(await run(["--user-data", source, "--export-fixture", target], d)).toBe(0);
    const exported = readAll(target) + readFileSync(join(target, "tables.json"), "utf8");
    expect(exported).not.toContain("LIVEKEY");
    expect(exported).not.toContain("iVBORw0KGgo");
    expect(exported).toContain("[images omitted]");
    expect(discoverSources({ name: "exported", root: target }).orchestratorFiles).toHaveLength(1);
    // The card threads travel with the tables, through the same scrub.
    expect(readRecordedTables(join(target, "tables.json")).card_messages).toEqual([
      expect.objectContaining({ card_id: "card-fm-1-a1b2c3", who: "captain" }),
    ]);
  });

  it("copies a Claude-served fixture in its own dialect, sidecar and all (W1 S11)", async () => {
    const target = join(dir, "copy-of-sep26-claude");
    exportFixture(fixture("sep26-claude"), target);
    const copy = discoverSources({ name: "copy", root: target });
    const [source] = fixture("sep26-claude").orchestratorFiles;
    const [copied] = copy.orchestratorFiles;
    expect(copied).toBe(join(target, "firstmate", "claude", basename(source ?? "")));
    expect(readFileSync(copied ?? "", "utf8")).toBe(readFileSync(source ?? "", "utf8"));
    const sidecar = (file: string) => file.replace(/\.jsonl$/, ".served.jsonl");
    expect(readFileSync(sidecar(copied ?? ""), "utf8")).toBe(
      readFileSync(sidecar(source ?? ""), "utf8"),
    );
    const again = await replaySession(copy);
    expect(again.metrics).toEqual(sep26Claude.metrics);
    expect(again.fidelity).toEqual(sep26Claude.fidelity);
  }, 60_000);

  it("copies a fixture's layout exactly when the source is already a fixture", () => {
    const target = join(dir, "copy-of-sep04");
    exportFixture(fixture("sep04"), target);
    const copy = discoverSources({ name: "copy", root: target });
    expect(Object.keys(copy.crewmateFiles)).toEqual(["5c0a7e11"]);
    expect(copy.supervisionFiles).toHaveLength(1);
    expect(readRecordedTables(copy.tablesPath ?? "").cards).toHaveLength(
      readRecordedTables(fixture("sep04").tablesPath ?? "").cards.length,
    );
  });
});

describe("the replay window (--from / --to)", () => {
  const SEP14 = join(FIXTURES, "sep14");
  const FROM = "2026-09-14T03:00:00.000Z";
  const window = { from: Date.parse(FROM), to: null };
  let dir: string;

  beforeAll(() => {
    dir = scratchDir("infinitary-replay-window-");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only the crewmates that said something inside the window", () => {
    const whole = discoverSources({ name: "sep14", root: SEP14 });
    const windowed = discoverSources({ name: "sep14", root: SEP14, window });
    expect(Object.keys(whole.crewmateFiles)).toEqual(["ba13eadd", "c9dab1e7", "d299b1e5"]);
    expect(Object.keys(windowed.crewmateFiles)).toEqual(["d299b1e5"]);
    expect(windowed.orchestratorFiles).toEqual(whole.orchestratorFiles);
  });

  it("keeps only the Firstmate sessions that said something inside the window", () => {
    const later = { from: Date.parse("2026-09-15T00:00:00.000Z"), to: null };
    const sources = discoverSources({ name: "sep14", root: SEP14, window: later });
    expect(sources.orchestratorFiles).toEqual([]);
    expect(sources.crewmateFiles).toEqual({});
  });

  it("replays only the window's turns, and an exported window replays identically", async () => {
    const d = deps();
    const report = join(dir, "windowed.json");
    expect(
      await run(["--user-data", SEP14, "--from", FROM, "--name", "sep14", "--out", report], d),
    ).toBe(0);
    const [windowed] = (JSON.parse(readFileSync(report, "utf8")) as ReplayReport).sessions;
    expect(windowed?.window).toEqual({ from: FROM, to: null });
    const recorded = windowed?.fidelity.recorded_captain_turns ?? 0;
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThan(sep14.fidelity.recorded_captain_turns);
    expect(windowed?.fidelity.replayed_captain_turns).toBe(recorded);

    const target = join(dir, "sep14-window");
    expect(
      await run(["--user-data", SEP14, "--from", FROM, "--export-fixture", target], deps()),
    ).toBe(0);
    const exported = discoverSources({ name: "sep14", root: target });
    expect(Object.keys(exported.crewmateFiles)).toEqual(["d299b1e5"]);
    // Every message the fixture kept is inside the window; the session header stays.
    const lines = readAll(target)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; timestamp?: string });
    expect(lines.some((line) => line.type === "session")).toBe(true);
    for (const line of lines.filter((entry) => entry.type === "message")) {
      expect(Date.parse(line.timestamp ?? "")).toBeGreaterThanOrEqual(window.from);
    }
    // Every task row stays; only the window's cards do.
    const tables = readRecordedTables(exported.tablesPath ?? "");
    const all = readRecordedTables(join(SEP14, "tables.json"));
    expect(tables.tasks).toHaveLength(all.tasks.length);
    expect(tables.cards.length).toBeLessThan(all.cards.length);
    for (const card of tables.cards) {
      expect(
        Math.max(Number(card.created_at), Number(card.resolved_at ?? 0)),
      ).toBeGreaterThanOrEqual(window.from);
    }

    const again = await replaySession(exported);
    expect(again.metrics).toEqual(windowed?.metrics);
    expect(again.fidelity).toEqual(windowed?.fidelity);
  }, 60_000);

  it("trims a Claude-served session by the same rule (W1 S11)", async () => {
    const root = join(FIXTURES, "sep26-claude");
    const [file] = discoverSources({ name: "sep26-claude", root }).orchestratorFiles;
    // From the captain's question about the release on: its turn and the card choice's drain.
    const asked = readFileSync(file ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; timestamp?: string; message?: unknown })
      .find(
        (line) => line.type === "user" && JSON.stringify(line.message).includes("ship the release"),
      );
    const from = Date.parse(asked?.timestamp ?? "");
    const windowed = await replaySession(
      discoverSources({ name: "sep26-claude", root, window: { from, to: null } }),
    );
    expect(windowed.fidelity).toMatchObject({
      recorded_captain_turns: 1,
      replayed_captain_turns: 1,
      recorded_op_turns: 1,
      played_op_turns: 1,
    });

    const target = join(dir, "sep26-claude-window");
    expect(
      await run(
        ["--user-data", root, "--from", new Date(from).toISOString(), "--export-fixture", target],
        deps(),
      ),
    ).toBe(0);
    const exported = discoverSources({ name: "sep26-claude", root: target });
    const again = await replaySession(exported);
    expect(again.fidelity).toEqual(windowed.fidelity);
    expect(again.metrics).toEqual(windowed.metrics);
  }, 60_000);

  it("keeps the card-thread messages written inside the window", () => {
    const from = window.from;
    const tables = {
      ...emptyTables(),
      card_messages: [
        { id: 1, card_id: "card-a", who: "captain", text: "before", at: from - 1 },
        { id: 2, card_id: "card-a", who: "captain", text: "inside", at: from },
      ],
    };
    expect(windowTables(tables, window).card_messages.map((row) => row.text)).toEqual(["inside"]);
  });

  it("refuses a window over committed fixtures and a time it cannot read", async () => {
    expect(await run(["--fixtures", FIXTURES, "--from", FROM], deps())).toBe(2);
    expect(await run(["--user-data", SEP14, "--from", "last tuesday"], deps())).toBe(2);
    expect(
      await run(["--user-data", SEP14, "--from", FROM, "--to", "2026-09-14T02:00:00Z"], deps()),
    ).toBe(2);
  });

  function deps(): RunDeps {
    return {
      gate: { isPackaged: false },
      loadEngine: async () => ({ replaySession }),
      git: () => ({ head: null, dirty: null }),
      stdout: () => {},
      stderr: () => {},
    };
  }
});

describe("a Claude-served crewmate's record (the session contract's step 6)", () => {
  /** A userData holding one crewmate on each backend, where the app keeps them. */
  function userData(): { root: string; pi: string; claude: string } {
    const root = scratchDir("infinitary-replay-crew-");
    return {
      root,
      pi: piCrewTwin(crewSessionsDir(root, "pi-task")),
      claude: claudeCrewTwin(crewSessionsDir(root, "claude-task")),
    };
  }
  const sidecarOf = (file: string) => file.replace(/\.jsonl$/, ".served.jsonl");

  it("finds the copy where a Pi crewmate's session lives, never its sidecar as a session", () => {
    const { root, pi, claude } = userData();
    expect(discoverSources({ name: "crew", root }).crewmateFiles).toEqual({
      "claude-task": [claude],
      "pi-task": [pi],
    });
  });

  it("keeps a Claude-served crewmate that said something inside the window", () => {
    const { root } = userData();
    const inside = { from: Date.parse(crewTwinTime(1, 0)), to: null };
    const after = { from: Date.parse(crewTwinTime(9, 0)), to: null };
    expect(
      Object.keys(discoverSources({ name: "crew", root, window: inside }).crewmateFiles),
    ).toEqual(["claude-task", "pi-task"]);
    expect(discoverSources({ name: "crew", root, window: after }).crewmateFiles).toEqual({});
  });

  it("plays the client's own notice as its running turn, and a served steer as a new input", () => {
    // FI3-309's planner built the app in the background; the client folded
    // the build's notice into the running turn, which went on to show the
    // plan card. Nobody served that notice, so nothing would ever prompt a
    // turn that started there.
    const dir = crewSessionsDir(scratchDir("infinitary-replay-crew-notice-"), "claude-task");
    const store = new SessionRecordStore(dir);
    const sessionId = "c1a0de00-0000-4000-8000-0000000071ce";
    const line = (body: Record<string, unknown>) => ({
      sessionId,
      isSidechain: false,
      userType: "external",
      cwd: "/wt",
      version: "2.1.285",
      ...body,
    });
    const call = (uuid: string, step: number, name: string, input: Record<string, unknown>) =>
      line({
        type: "assistant",
        uuid,
        timestamp: crewTwinTime(0, step),
        message: {
          id: `msg-${uuid}`,
          role: "assistant",
          model: "claude-fable-5-1",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: `call-${uuid}`, name, input }],
        },
      });
    const queued = (uuid: string, step: number, prompt: string, commandMode: string) =>
      line({
        type: "attachment",
        uuid,
        timestamp: crewTwinTime(0, step),
        attachment: { type: "queued_command", prompt, source_uuid: `src-${uuid}`, commandMode },
      });
    writeFileSync(
      store.transcriptPath(sessionId),
      `${[
        line({
          type: "user",
          uuid: "u1",
          timestamp: crewTwinTime(0, 1),
          message: { role: "user", content: "Plan solid cards." },
        }),
        call("a1", 2, "Bash", { command: "pnpm build", run_in_background: true }),
        queued("n1", 3, "<task-notification>build done</task-notification>", "task-notification"),
        call("a2", 4, "mcp__firstmate__emit_card", {
          title: "Plan: solid cards",
          body: "<p>Plan.</p>",
        }),
        queued("s1", 5, "The captain replied in the thread on your card.", "prompt"),
        call("a3", 6, "mcp__firstmate__report", { text: "Revised." }),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const recording = readCrewRecording("claude-task", [store.transcriptPath(sessionId)]);
    const tools = recording.segments.map((segment) =>
      segment.messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "toolCall" ? [part.name] : [])),
      ),
    );
    expect(tools).toEqual([["Bash", "emit_card"], ["report"]]);
  });

  it("exports it in its own dialect, sidecar and all, and it reads back as the same work", () => {
    const { root, claude } = userData();
    const target = scratchDir("infinitary-replay-crew-export-");
    exportFixture(discoverSources({ name: "crew", root }), target);
    const copy = discoverSources({ name: "copy", root: target });
    const [copied] = copy.crewmateFiles["claude-task"] ?? [];
    expect(copied).toBe(join(target, "crewmates", "claude-task", "sessions", basename(claude)));
    expect(readFileSync(copied ?? "", "utf8")).toBe(readFileSync(claude, "utf8"));
    expect(readFileSync(sidecarOf(copied ?? ""), "utf8")).toBe(
      readFileSync(sidecarOf(claude), "utf8"),
    );
    expect(readCrewRecording("claude-task", [copied ?? ""])).toEqual(
      readCrewRecording("claude-task", [claude]),
    );
  });
});
