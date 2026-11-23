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
import { CardActions } from "../src/core/orchestrator/cardActions.ts";
import { CardService } from "../src/core/orchestrator/cardService.ts";
import { CrewStarts } from "../src/core/orchestrator/starts.ts";
import { SessionRecordStore } from "../src/core/storage/sessionRecordStore.ts";
import { TaskTurns } from "../src/core/tasks/taskTurns.ts";
import { frameServedInput, type ServedSegmentInput } from "../src/shared/servedFrame.ts";
import { claudeCrewTwin, crewSessionsDir, crewTwinTime, piCrewTwin } from "./helpers/crewTwins.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * WI-19: the replay harness over the committed captain-session fixtures.
 * The engine runs the real FirstmateAgent and CrewSupervisor over recorded
 * Firstmate/crew decisions and the current whose-turn rule, so each assertion below is
 * about the CURRENT host code: the nine frustration modes of report.md
 * section 2.2 (F1-F9), the committed baseline, and determinism. The F1-F9
 * modes assert on the sep14/sep04 reconstructions; the independently authored fleet recordings
 * (fleet-mixed, fleet-captain-only, tests/fixtures/replay/README.md) sit beside them,
 * run identically, and are gated by the same baseline. Recordings a test
 * writes line by line replay in tests/replay-synthetic-recordings.test.ts.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/replay/", import.meta.url));
const BASELINE = join(FIXTURES, "baseline.json");

let sep14: SessionReport;
let sep04: SessionReport;
let mixedFleet: SessionReport;
let captainOnly: SessionReport;
let sep26Claude: SessionReport;
let handoffApproval: SessionReport;
let handoffStart: SessionReport;
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
  mixedFleet = await replaySession(fixture("fleet-mixed"));
  captainOnly = await replaySession(fixture("fleet-captain-only"));
  sep26Claude = await replaySession(fixture("sep26-claude"));
  handoffApproval = await replaySession(fixture("handoff-approval"));
  handoffStart = await replaySession(fixture("handoff-start"));
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
      mixedFleet,
      captainOnly,
      sep26Claude,
      handoffApproval,
      handoffStart,
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
    expect(mixedFleet.details.retired_cards).toEqual([
      "Reservoir inspection ready",
      "Door seal measurement ready",
    ]);
    expect(mixedFleet.details.refused_card_choices).toEqual([]);
    expect(sep26Claude.details.retired_cards).toEqual([]);
    expect(sep26Claude.details.refused_card_choices).toEqual([]);
  });

  it("reads an emitter's own close_card as its withdrawal, never the captain's choice (FI3-287)", () => {
    // Each row holds its close_card's reason where an action id would be;
    // the recorded call that closed it says whose resolution it was.
    expect(mixedFleet.details.withdrawn_cards).toEqual([
      "Superseded north line reading",
      "Reservoir note used the wrong scale",
      "Earlier rain gauge estimate",
      "Back door measurement replaced",
      "Thermostat report superseded",
    ]);
    expect(sep26Claude.details.withdrawn_cards).toEqual([]);
  });

  it("names why each of fleet-mixed's crewmate turns that never plays did not (FI3-442)", () => {
    expect(mixedFleet.fidelity).toMatchObject({
      recorded_crewmate_turns: 164,
      played_crewmate_turns: 140,
    });
    const unplayed = mixedFleet.details.unplayed_crewmate_turns;
    expect(unplayed).toHaveLength(164 - 140);
    const turns = (reason: string) =>
      unplayed
        .filter((turn) => turn.reason === reason)
        .map((turn) => `${turn.crewmate}#${turn.turn}`);
    // Every gap has a cause the replay can name.
    expect(turns("unserved")).toEqual([]);
    // A historical escalation did not reach the current host, so the gauge crew never starts.
    expect(turns("spawn-not-played")).toEqual(
      Array.from({ length: 15 }, (_, turn) => `8c200002#${turn}`),
    );
    // Five recorded choices have no shown card. Four recorded steers are on unserved wakes.
    expect(turns("card-not-shown")).toEqual(
      Array.from({ length: 5 }, (_, turn) => `8c200001#${140 + turn}`),
    );
    expect(turns("steer-not-played")).toEqual(
      Array.from({ length: 4 }, (_, turn) => `8c200001#${145 + turn}`),
    );
    expect(unplayed).toHaveLength(15 + 5 + 4);
    for (const report of [sep14, sep04, sep26Claude, handoffApproval, handoffStart]) {
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
        "fleet-mixed": mixedFleet.metrics,
        "fleet-captain-only": captainOnly.metrics,
        "sep26-claude": sep26Claude.metrics,
        "handoff-approval": handoffApproval.metrics,
        "handoff-start": handoffStart.metrics,
        "oct22-program": oct22Program.metrics,
      },
      readBaseline(BASELINE).sessions,
    );
    expect(regressions).toEqual([]);
    expect(mixedFleet.fidelity.replayed_captain_turns).toBe(36);
    expect(mixedFleet.fidelity.recorded_captain_turns).toBe(36);
    expect(captainOnly.fidelity).toMatchObject({
      recorded_captain_turns: 12,
      replayed_captain_turns: 12,
      recorded_op_turns: 22,
      played_op_turns: 0,
      missing_tools: [],
      settle_timeouts: 0,
    });
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
 * INF-3022: a loop toward a goal goes to one crewmate, which starts the
 * program itself. The recording (`tests/fixtures/replay/README.md`,
 * `oct22-program`) holds the first mate answering that ask with one
 * `spawn_crewmate` whose constraint says "use start_program to do this", the
 * captain's direction that the first mate never write the script; the
 * replay files it through today's tool, and the first mate files no program.
 */
describe("a program ask the first mate hands to a crewmate", () => {
  it("replays the loop ask as one crewmate task and no program of the first mate's", () => {
    expect(oct22Program.fidelity).toMatchObject({
      recorded_captain_turns: 1,
      replayed_captain_turns: 1,
      missing_tools: [],
      settle_timeouts: 0,
    });
    expect(oct22Program.details.programs).toEqual([]);
    expect(oct22Program.details.task_shapes.map((shape) => shape.title)).toEqual([
      "Fix the flaky checkout tests until the suite passes",
    ]);
  });
});

/** The historical approval miss and later explicit start in an authored forecast scenario. */
describe("the plan-to-build handoff", () => {
  it("replays the whole approval recording: the planner's card shown, the agree applied and answered", () => {
    expect(handoffApproval.fidelity).toMatchObject({
      recorded_captain_turns: 5,
      replayed_captain_turns: 5,
      // The recorded spawn named its model and read which model took the task
      // in the tool's answer; that answer now returns before the start, so the
      // model arrives in a wake the recording never answered (INF-3060).
      unrecorded_firstmate_wakes: 1,
      crewmate_sessions: 1,
      missing_tools: [],
      settle_timeouts: 0,
    });
    // The two choices skipped are on cards shown before the window opened.
    expect(handoffApproval.fidelity.skipped_card_resolutions).toBe(2);
    expect(handoffApproval.details.refused_card_choices).toEqual([]);
  });

  it("delivers the captain's thread reply to the planner, whose recorded revision and report play", async () => {
    expect(handoffApproval.fidelity).toMatchObject({
      recorded_crewmate_turns: 2,
      played_crewmate_turns: 2,
      recorded_thread_replies: 1,
      skipped_thread_replies: 0,
    });
    const replies = vi.spyOn(CardActions.prototype, "replyToCard");
    const lines = vi.spyOn(CardService.prototype, "addMessage");
    const reports = vi.spyOn(TaskTurns.prototype, "recordReport");
    try {
      await replaySession(fixture("handoff-approval"));
      expect(replies.mock.calls).toEqual([
        [
          expect.stringMatching(/^card-[0-9a-f]+-rain-outlook-plan$/),
          "Does the placement also work with the large text setting?",
        ],
      ]);
      const card = replies.mock.calls[0]?.[0];
      const thread = lines.mock.calls.flatMap(([id, who, text], index) =>
        id === card ? [{ who, text, order: lines.mock.invocationCallOrder[index] ?? 0 }] : [],
      );
      // The planner revised the card under the same id, so the host wrote
      // its "revised" line after the captain's.
      expect(thread.map(({ who, text }) => ({ who, text }))).toEqual([
        { who: "captain", text: "Does the placement also work with the large text setting?" },
        {
          who: "host",
          text: "revised: Plan: put the rain outlook above the hourly table",
        },
        // The recording predates answers on revisions, so the replay gives one.
        { who: "crewmate", text: expect.stringMatching(/^\(recorded before/) },
      ]);
      const revisedAt = thread[1]?.order ?? Number.POSITIVE_INFINITY;
      const after = reports.mock.calls.filter(
        (_, index) => (reports.mock.invocationCallOrder[index] ?? 0) > revisedAt,
      );
      expect(after.map(([, input]) => input.text.split(".")[0])).toEqual([
        "The large text check confirms the same reading order",
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
      const sources = fixture("handoff-approval");
      const tables = JSON.parse(readFileSync(sources.tablesPath ?? "", "utf8")) as {
        card_messages: { card_id: string; who: string }[];
      };
      for (const row of tables.card_messages) {
        if (row.who === "captain") row.card_id = "card-8c300001-never-shown";
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
      expect(report.details.unplayed_crewmate_turns).toEqual([
        { crewmate: "8c300001", turn: 1, at: expect.any(String), reason: "reply-not-delivered" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("scores the recorded miss: the agreed plan was answered with no builder started", () => {
    expect(handoffApproval.details.approvals).toEqual([
      {
        card: "card-8c300001-rain-outlook-plan",
        choice: "agree",
        builds: true,
        plan: "WEAT-1",
        grounded_starts: 0,
      },
    ]);
    expect(handoffApproval.metrics.approval_handoff_share).toEqual({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
  });

  it("scores the explicit start: exactly one builder, grounded on the agreed plan, and its first turn plays", () => {
    expect(handoffStart.details.approvals).toEqual([
      {
        card: "card-fm-start-rain-outlook",
        choice: "start-implementation",
        builds: true,
        plan: "WEAT-1",
        grounded_starts: 1,
      },
    ]);
    expect(handoffStart.metrics.approval_handoff_share).toEqual({
      value: 1,
      numerator: 1,
      denominator: 1,
    });
    // The builder was still waiting when the window opened, though the tables
    // hold it as it closed later; the builder's recorded first turn plays.
    expect(handoffStart.fidelity).toMatchObject({
      recorded_captain_turns: 2,
      replayed_captain_turns: 2,
      crewmate_sessions: 1,
      unrecorded_crewmate_turns: 0,
      skipped_card_resolutions: 0,
    });
  });

  it("fails the gate when the host stops starting planned work on request", async () => {
    const refuse = vi
      .spyOn(CrewStarts.prototype, "startQueuedNow")
      .mockImplementation(async () => "Cannot start this task now.");
    try {
      const report = await replaySession(fixture("handoff-start"));
      expect(report.details.approvals.map((approval) => approval.grounded_starts)).toEqual([0]);
      const regressions = compareToBaseline(
        { "handoff-start": report.metrics },
        { "handoff-start": readBaseline(BASELINE).sessions["handoff-start"] ?? {} },
      );
      expect(regressions.map((regression) => regression.metric)).toContain(
        "approval_handoff_share",
      );
    } finally {
      refuse.mockRestore();
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
    for (const report of [sep04, captainOnly, mixedFleet, handoffApproval, handoffStart]) {
      expect(report.metrics.asks_without_action.value, report.session).toBe(0);
    }
  });
});

describe("the nine frustration modes (report.md section 2.2)", () => {
  it("F1 ghost crew: no done or dropped row keeps its worktree after boot hygiene and the reconcile", () => {
    const tables = readRecordedTables(join(FIXTURES, "sep14", "tables.json"));
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
      mixedFleet,
      captainOnly,
      sep26Claude,
      handoffApproval,
      handoffStart,
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
    // The fleet and handoff recordings sit
    // beside the reconstructions and are discovered in sorted order; every
    // one has a baseline row.
    expect(report.sessions.map((session) => session.session)).toEqual([
      "fleet-captain-only",
      "fleet-mixed",
      "handoff-approval",
      "handoff-start",
      "oct22-program",
      "sep04",
      "sep14",
      "sep26-claude",
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
    const lines = readAll(target)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; timestamp?: string });
    expect(lines.some((line) => line.type === "session")).toBe(true);
    for (const line of lines.filter((entry) => entry.type === "message")) {
      expect(Date.parse(line.timestamp ?? "")).toBeGreaterThanOrEqual(window.from);
    }
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
