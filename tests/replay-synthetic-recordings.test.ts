import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaySession } from "../scripts/replay/engine.ts";
import { discoverSources } from "../scripts/replay-captain-session.ts";
import type { CoreDispatch } from "../src/core/dispatcher.ts";
import { CardActions } from "../src/core/orchestrator/cardActions.ts";
import { CardService } from "../src/core/orchestrator/cardService.ts";
import { CrewSupervisor } from "../src/core/orchestrator/crewSupervisor.ts";
import { FirstmateAgent } from "../src/core/orchestrator/firstmateAgent.ts";
import { createAppTools } from "../src/core/pi/appTools.ts";
import { FIRSTMATE_TOOLS } from "../src/core/session/tools.ts";
import { TaskTurns } from "../src/core/tasks/taskTurns.ts";
import { frameServedInput } from "../src/shared/servedFrame.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * WI-19's replay harness over recordings each test writes line by line,
 * beside the committed captain-session fixtures
 * (tests/replay-captain-session.test.ts). Each recording replays against the
 * CURRENT host code: recorded task card retirements, card-thread replies,
 * which recorded crewmate turn answers a served input, the action catalog,
 * and the captain's labels and surfaces.
 */

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
      const choices = vi.spyOn(CardActions.prototype, "act");
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
    const choices = vi.spyOn(CardActions.prototype, "act");
    try {
      const report = await replaySession(discoverSources({ name: "choice", root }));
      // This is the admission safeguard's own witness, not fleet-mixed's
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
    const reads = vi.spyOn(CrewSupervisor.prototype, "pressNote"); // A note's read (INF-2794).
    try {
      const report = await replaySession(discoverSources({ name: "dismissal", root }));
      expect(reads).toHaveBeenCalledOnce();
      expect(report.details.retired_cards).toEqual([]);
      expect(report.fidelity.skipped_card_resolutions).toBe(0);
    } finally {
      reads.mockRestore();
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
    const record = TaskTurns.prototype.recordReport;
    const reports: { at: number; text: string }[] = [];
    const spy = vi.spyOn(TaskTurns.prototype, "recordReport").mockImplementation(function (
      this: TaskTurns,
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
