import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyHeadings } from "@shared/cardHeadings";
import {
  carriesEvidenceHeadings,
  EVIDENCE_HEADINGS,
  reviewVerdictSchema,
  rigorSchema,
} from "@shared/rigor";
import { describe, expect, it } from "vitest";
import {
  approvalLabelKey,
  baselineFrom,
  cardLabelKey,
  compareToBaseline,
  countReasks,
  duplicatePairs,
  escalationLineages,
  FINDING_ACTIONS,
  FRUSTRATION_MODES,
  type FrustrationMode,
  findingActions,
  isCompletionCard,
  isFakeSettleAction,
  isQuestion,
  kindSourceClass,
  looksGarbled,
  METRICS,
  type MetricScores,
  meetsTarget,
  metricDef,
  type ObservedCard,
  type ObservedDispatch,
  type ObservedReview,
  observedReviews,
  parseApprovalLabelRows,
  parseApprovalLabels,
  parseClearLabels,
  parseEffectLabels,
  parsePlainLabelRows,
  parsePlainLabels,
  parseSectionLabels,
  parseTaskWordLabels,
  parseTermLabels,
  REVIEW_VERDICTS,
  type ReviewEvent,
  RIGORS,
  type SessionObservation,
  scorePlanSkips,
  scoreRigor,
  scoreRouting,
  scoreSession,
} from "../scripts/interaction-metrics.ts";

/**
 * WI-21: the section-4 numbers are computed in one place. These tests pin
 * the definitions the replay harness and the duplicate deriver share, so a
 * change to a definition is a visible test change, never a silent drift in
 * the gate.
 */

const MIN = 60_000;
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function card(overrides: Partial<ObservedCard> & { id: string }): ObservedCard {
  return {
    taskId: "t1",
    title: "",
    body: "",
    createdAt: 0,
    author: "crewmate",
    visual: false,
    resolvedAt: null,
    resolution: "open",
    duplicateOf: null,
    hasDefault: false,
    fakeSettle: false,
    plain: null,
    clear: null,
    prLinks: null,
    terms: null,
    affects: null,
    sections: null,
    taskWords: null,
    ...overrides,
  };
}

function observation(overrides: Partial<SessionObservation> = {}): SessionObservation {
  return {
    captainTurns: 0,
    questions: [],
    cards: [],
    opWakes: 0,
    guidanceQueuedWakes: 0,
    escalations: [],
    wakesAfterCancel: 0,
    lockRefusals: 0,
    closedTasks: [],
    implausibleOutcomes: 0,
    spawnStartFailures: 0,
    dispatches: [],
    reviews: [],
    ...overrides,
  };
}

describe("the metric catalog", () => {
  it("carries every section-4 row, and every frustration mode has at least one metric", () => {
    const section4 = METRICS.filter((metric) => metric.group === "section4").map((m) => m.id);
    expect(section4).toEqual([
      "questions_answered_in_turn",
      "answer_cards_with_default",
      "captain_reasks_10min",
      "firstmate_cards_dismissed_60s",
      "duplicate_card_pairs",
      "op_wakes_per_captain_turn",
      "escalation_precision",
      "lock_refusals",
      "closed_rows_with_worktree",
      "closed_without_evidence",
      "visual_card_share",
      "mean_card_body_chars",
    ]);
    for (const mode of Object.keys(FRUSTRATION_MODES) as FrustrationMode[]) {
      expect(
        METRICS.some((metric) => metric.modes.includes(mode)),
        mode,
      ).toBe(true);
    }
  });

  it("carries the routing rows, none of them with a Sep 14 value", () => {
    const routing = METRICS.filter((metric) => metric.group === "routing");
    expect(routing.map((metric) => metric.id)).toEqual([
      "unplanned_change_share",
      "late_decisions_per_unplanned_change",
      "tier_share_premium",
      "tier_share_high",
      "tier_share_medium",
      "tier_share_low",
      "kind_classified_share",
      "kind_abstained_share",
      "kind_failed_share",
      "kind_skipped_share",
      "tier_downgrade_rate",
      "escalations_per_lineage",
    ]);
    // Sep 14 predates the policy: the class was judged, so no tier was
    // computed and no kind was classified. A null here is the honest answer,
    // never a zero that would read as "premium was never used".
    for (const metric of routing) expect(metric.sep14.value).toBeNull();
  });

  it("records the measured Sep 14 baseline and the captain's targets as data", () => {
    const byId = Object.fromEntries(METRICS.map((metric) => [metric.id, metric]));
    expect(byId.questions_answered_in_turn?.sep14.value).toBeCloseTo(8 / 25);
    expect(byId.questions_answered_in_turn?.target).toMatchObject({ op: ">=", value: 0.7 });
    expect(byId.lock_refusals?.sep14.value).toBe(21);
    expect(byId.op_wakes_per_captain_turn?.sep14.value).toBe(3.7);
    expect(byId.duplicate_card_pairs?.target).toMatchObject({ op: "=", value: 0 });
    // Not a number in the report: stays null rather than being invented.
    expect(byId.escalation_precision?.sep14.value).toBeNull();
  });

  it("judges targets by their operator", () => {
    expect(meetsTarget("questions_answered_in_turn", 0.7)).toBe(true);
    expect(meetsTarget("questions_answered_in_turn", 0.69)).toBe(false);
    expect(meetsTarget("op_wakes_per_captain_turn", 1)).toBe(false);
    expect(meetsTarget("lock_refusals", 0)).toBe(true);
    expect(meetsTarget("lock_refusals", null)).toBeNull();
  });
});

describe("duplicate pairs", () => {
  const base = { title: "Delivered rows keep their worktree", body: "<p>closeRecord keeps it</p>" };

  it("pairs similar cards on one task inside the window, and nothing else", () => {
    const pairs = duplicatePairs([
      { id: "a", taskId: "t1", createdAt: 0, ...base },
      { id: "b", taskId: "t1", createdAt: 5 * MIN, ...base },
      { id: "c", taskId: "t2", createdAt: 6 * MIN, ...base },
      { id: "d", taskId: "t1", createdAt: 90 * MIN, ...base },
      { id: "e", taskId: null, createdAt: 1 * MIN, ...base },
    ]);
    expect(pairs.map((pair) => [pair.first, pair.second])).toEqual([["a", "b"]]);
    expect(pairs[0]).toMatchObject({ taskId: "t1", similarity: 1, gapMs: 5 * MIN });
  });

  it("links a restatement thread as N-1 pairs, each to its most similar earlier card", () => {
    const pairs = duplicatePairs([
      { id: "a", taskId: "t1", createdAt: 0, ...base },
      { id: "b", taskId: "t1", createdAt: MIN, ...base },
      { id: "c", taskId: "t1", createdAt: 2 * MIN, ...base },
    ]);
    expect(pairs).toHaveLength(2);
  });
});

describe("captain questions", () => {
  it("recognizes a question by its mark or its lead word", () => {
    expect(isQuestion("why I'm seeing 6 idle crewmates?")).toBe(true);
    expect(isQuestion("is this consistent with the board")).toBe(true);
    expect(isQuestion("cancel the meter investigation")).toBe(false);
    expect(isQuestion("")).toBe(false);
  });

  it("counts a re-ask when an earlier question in the window shares a topic", () => {
    const thread = [
      "what's our definition of delivered?",
      "who sets delivered?",
      "is setting delivered deterministic?",
    ].map((text, index) => ({ at: index * 2 * MIN, text }));
    expect(countReasks(thread)).toBe(2);
    expect(
      countReasks([
        { at: 0, text: thread[0]?.text ?? "" },
        { at: 30 * MIN, text: "who sets delivered?" },
      ]),
    ).toBe(0);
    expect(
      countReasks([
        { at: 0, text: "why is CI red?" },
        { at: MIN, text: "where is the proposal?" },
      ]),
    ).toBe(0);
  });
});

describe("the eval's own checks", () => {
  it("flags the F3 garbage report and leaves ordinary prose alone", () => {
    expect(looksGarbled("RGCTXDataിക്ഷassistant to=functions.bash 新天天彩票?")).toBe(true);
    expect(looksGarbled("The meter test leaks a timer; the fix is one line.")).toBe(false);
    expect(looksGarbled("配置は正しいです")).toBe(false);
  });

  it("names a merge-looking button that carries no settle effect (F7)", () => {
    // Since cards/tasks/agents P1 an id is a name: the host settles only on
    // a declared effect, so "merge-pr" with none is as fake as "merge-pr55".
    expect(isFakeSettleAction({ id: "merge-pr55", label: "Merge PR 55" })).toBe(true);
    expect(isFakeSettleAction({ id: "land-it", label: "Land it" })).toBe(true);
    expect(isFakeSettleAction({ id: "merge-pr", label: "Merge PR" })).toBe(true);
    expect(isFakeSettleAction({ id: "go", label: "Merge PR" })).toBe(true);
    expect(isFakeSettleAction({ id: "go", label: "Land locally" })).toBe(true);
    const settle = { kind: "settle" };
    expect(isFakeSettleAction({ id: "merge-pr", label: "Merge PR", effect: settle })).toBe(false);
    expect(isFakeSettleAction({ id: "go", label: "Land locally", effect: settle })).toBe(false);
    expect(isFakeSettleAction({ id: "approve", label: "Approve" })).toBe(false);
    expect(isFakeSettleAction({ id: "explain-more", label: "Explain the merge" })).toBe(false);
    expect(isFakeSettleAction({ id: "go", label: "Merge PR", effect: { kind: "open" } })).toBe(
      true,
    );
  });
});

describe("scoring a session", () => {
  it("computes every metric from one observation", () => {
    const scores = scoreSession(
      observation({
        captainTurns: 4,
        questions: [
          { at: 0, text: "what is delivered?", answeredInTurn: true, answerCardIds: ["card-fm-1"] },
          { at: MIN, text: "who sets delivered?", answeredInTurn: false, answerCardIds: [] },
        ],
        cards: [
          card({
            id: "card-fm-1",
            author: "firstmate",
            hasDefault: true,
            createdAt: 0,
            resolvedAt: 30_000,
            resolution: "dismissed",
            body: "x".repeat(100),
            visual: true,
          }),
          card({
            id: "card-fm-2",
            author: "firstmate",
            createdAt: 0,
            resolvedAt: 5 * MIN,
            resolution: "dismissed",
            body: "x".repeat(300),
          }),
          card({ id: "card-t1-1", body: "y".repeat(200), fakeSettle: true, hasDefault: true }),
          card({ id: "card-host", author: "host", body: "z".repeat(10_000), visual: true }),
        ],
        opWakes: 6,
        guidanceQueuedWakes: 1,
        escalations: [{ handled: true }, { handled: false }, { handled: true }, { handled: true }],
        wakesAfterCancel: 2,
        lockRefusals: 3,
        closedTasks: [
          { status: "dropped", worktreePresent: true, deliveredWithoutEvidence: false },
          { status: "delivered", worktreePresent: true, deliveredWithoutEvidence: true },
        ],
        implausibleOutcomes: 1,
        spawnStartFailures: 1,
        asksWithoutAction: 2,
      }),
    );
    expect(scores.questions_answered_in_turn).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(scores.answer_cards_with_default.value).toBe(1);
    expect(scores.captain_reasks_10min.value).toBe(1);
    expect(scores.firstmate_cards_dismissed_60s).toEqual({
      value: 0.5,
      numerator: 1,
      denominator: 2,
    });
    expect(scores.op_wakes_per_captain_turn.value).toBe(1.5);
    expect(scores.escalation_precision.value).toBe(0.75);
    expect(scores.lock_refusals.value).toBe(3);
    expect(scores.closed_rows_with_worktree.value).toBe(1);
    expect(scores.closed_without_evidence.value).toBe(1);
    // Host chrome is neither an explanation nor a duplicate.
    expect(scores.visual_card_share).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(scores.mean_card_body_chars.value).toBe(200);
    expect(scores.escalations.value).toBe(4);
    expect(scores.wakes_after_cancel.value).toBe(2);
    expect(scores.guidance_queued_wakes.value).toBe(1);
    expect(scores.fake_merge_buttons.value).toBe(1);
    expect(scores.implausible_outcomes.value).toBe(1);
    expect(scores.spawn_start_failures.value).toBe(1);
    // Observational: counted and printed, never graded.
    expect(scores.asks_without_action.value).toBe(2);
    expect(metricDef("asks_without_action").direction).toBe("either");
  });

  it("leaves a ratio with nothing to measure as null, never zero", () => {
    const scores = scoreSession(observation());
    expect(scores.questions_answered_in_turn.value).toBeNull();
    expect(scores.escalation_precision.value).toBeNull();
    expect(scores.mean_card_body_chars.value).toBeNull();
  });

  it("counts a captain stamp once, whether or not the overlap detector also found the pair", () => {
    const same = { title: "Delivered keeps its worktree", body: "<p>same</p>" };
    const scores = scoreSession(
      observation({
        cards: [
          card({ id: "a", ...same }),
          card({ id: "b", createdAt: MIN, duplicateOf: "a", ...same }),
          card({ id: "c", title: "Unrelated quota finding", body: "<p>meter</p>" }),
          card({
            id: "d",
            title: "Another thing entirely",
            body: "<p>allowlist</p>",
            duplicateOf: "c",
          }),
        ],
      }),
    );
    expect(scores.duplicate_card_pairs.value).toBe(2);
  });
});

describe("the plain-language sample (roadmap 1.5)", () => {
  it("scores only the cards someone has read, and nothing when no one has", () => {
    const read = observation({
      cards: [
        card({ id: "a", plain: true }),
        card({ id: "b", plain: false }),
        card({ id: "c", plain: null }),
        card({ id: "d", plain: true }),
      ],
    });
    expect(scoreSession(read).plain_language_share).toEqual({
      value: 2 / 3,
      numerator: 2,
      denominator: 3,
    });
    const unread = observation({ cards: [card({ id: "a" }), card({ id: "b" })] });
    expect(scoreSession(unread).plain_language_share).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it("scores the sentence habits on the cards read for them, apart from the vocabulary", () => {
    const read = observation({
      cards: [
        card({ id: "a", plain: false, clear: true }),
        card({ id: "b", plain: true, clear: false }),
        card({ id: "c", plain: true, clear: null }),
        card({ id: "d", plain: null, clear: true }),
      ],
    });
    const scores = scoreSession(read);
    expect(scores.clear_copy_share).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(scores.plain_language_share).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(scoreSession(observation({ cards: [card({ id: "a" })] })).clear_copy_share).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it("reads a sentence-habit verdict only from the rows that carry one", () => {
    const text = [
      '{"key":"aaaaaaaaaaaa","plain":true,"note":"","clear":false,"clear_note":"a 31-word sentence"}',
      '{"key":"bbbbbbbbbbbb","plain":false,"note":"branch","clear":true,"clear_note":""}',
      '{"key":"cccccccccccc","plain":true,"note":"","from":"tests/e2e/forge-signin.spec.ts"}',
    ].join("\n");
    expect([...parseClearLabels(text).entries()]).toEqual([
      ["aaaaaaaaaaaa", false],
      ["bbbbbbbbbbbb", true],
    ]);
    expect([...parsePlainLabels(text).keys()]).toHaveLength(3);
    expect(() =>
      parseClearLabels('{"key":"aaaaaaaaaaaa","plain":true,"note":"","clear":"yes"}'),
    ).toThrow("clear verdict is not true or false");
  });

  it("scores the two card-word rules apart, each only on the cards it applies to (INF-2326)", () => {
    // The captain's choice on INF-2326: "Words only: two rules in the card
    // guidance, measured by the replay check." A card with no project term,
    // or about no change, is out of that reading's denominator.
    const scores = scoreSession(
      observation({
        cards: [
          card({ id: "a", terms: true, affects: false }),
          card({ id: "b", terms: false, affects: null }),
          card({ id: "c", terms: null, affects: true }),
          card({ id: "d", terms: false, affects: true }),
        ],
      }),
    );
    expect(scores.term_explained_share).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(scores.change_effect_share).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    const text = [
      '{"key":"aaaaaaaaaaaa","plain":true,"note":"","terms":false,"terms_note":"closeRecord is not explained"}',
      '{"key":"bbbbbbbbbbbb","plain":true,"note":"","affects":true,"affects_note":"first sentence"}',
    ].join("\n");
    expect([...parseTermLabels(text).entries()]).toEqual([["aaaaaaaaaaaa", false]]);
    expect([...parseEffectLabels(text).entries()]).toEqual([["bbbbbbbbbbbb", true]]);
    expect(() =>
      parseTermLabels('{"key":"aaaaaaaaaaaa","plain":true,"note":"","affects":"yes"}'),
    ).toThrow("affects verdict is not true or false");
  });

  it("scores the two decision rules apart, each only on the cards it applies to (INF-2715)", () => {
    // INF-2715's approved plan: each question in the section it is about, and
    // file only for the backlog, measured by the replay check. A card that is
    // no decision across sections, or names no task's start, is out of that
    // reading's denominator.
    const scores = scoreSession(
      observation({
        cards: [
          card({ id: "a", sections: false, taskWords: true }),
          card({ id: "b", sections: true, taskWords: null }),
          card({ id: "c", sections: null, taskWords: false }),
          card({ id: "d", sections: true, taskWords: false }),
        ],
      }),
    );
    expect(scores.section_question_share).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(scores.task_verb_share).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    const text = [
      '{"key":"aaaaaaaaaaaa","plain":true,"note":"","sections":false,"sections_note":"one list at the end"}',
      '{"key":"bbbbbbbbbbbb","plain":true,"note":"","task_words":true,"task_words_note":"filed in the backlog"}',
    ].join("\n");
    expect([...parseSectionLabels(text).entries()]).toEqual([["aaaaaaaaaaaa", false]]);
    expect([...parseTaskWordLabels(text).entries()]).toEqual([["bbbbbbbbbbbb", true]]);
    expect(() =>
      parseSectionLabels('{"key":"aaaaaaaaaaaa","plain":true,"note":"","task_words":"yes"}'),
    ).toThrow("task_words verdict is not true or false");
  });

  it("keys a label by the card's own words, so it cannot drift onto another card", () => {
    const key = cardLabelKey({ title: "The checks passed", body: "<p>Ready to put in.</p>" });
    expect(key).toMatch(/^[0-9a-f]{12}$/);
    expect(cardLabelKey({ title: "The checks passed", body: "<p>Ready to put in.</p>" })).toBe(key);
    expect(cardLabelKey({ title: "The checks passed", body: "<p>Ready.</p>" })).not.toBe(key);
  });

  it("reads the labels file, skipping its comments and refusing a row filed twice", () => {
    const labels = parsePlainLabels(
      [
        "// the sample",
        '{"key":"aaaaaaaaaaaa","plain":true,"note":"plain"}',
        "",
        '{"key":"bbbbbbbbbbbb","plain":false,"note":"branch"}',
      ].join("\n"),
    );
    expect([...labels.entries()]).toEqual([
      ["aaaaaaaaaaaa", true],
      ["bbbbbbbbbbbb", false],
    ]);
    expect(() =>
      parsePlainLabels(
        '{"key":"aaaaaaaaaaaa","plain":true,"note":""}\n{"key":"aaaaaaaaaaaa","plain":false,"note":""}',
      ),
    ).toThrow("filed twice");
    expect(() => parsePlainLabels('{"key":"aaaaaaaaaaaa","note":"no verdict"}')).toThrow(
      "without a key or a verdict",
    );
    // A card an end-to-end spec shows carries the spec that reads it.
    expect(
      parsePlainLabelRows(
        '{"key":"cccccccccccc","plain":true,"note":"","from":"tests/e2e/forge-signin.spec.ts"}',
      ),
    ).toEqual([
      { key: "cccccccccccc", plain: true, note: "", from: "tests/e2e/forge-signin.spec.ts" },
    ]);
  });

  it("labels every recorded card in the committed sample by its own words", () => {
    // The committed labels are read against the committed fixtures: a row
    // whose key matches no card is a label that drifted. A row filed from an
    // end-to-end spec (`from`) is read against the running app by that spec
    // instead, so here it only has to name a spec that exists.
    const rows = parsePlainLabelRows(
      readFileSync(join(FIXTURES, "plain-language", "labels.jsonl"), "utf8"),
    );
    for (const row of rows.filter((entry) => entry.from !== undefined)) {
      expect(row.from, row.key).toMatch(/^tests\/e2e\/[\w-]+\.spec\.ts$/);
      expect(existsSync(join(FIXTURES, "..", "..", row.from as string)), row.key).toBe(true);
    }
    const labels = new Map(
      rows.filter((entry) => entry.from === undefined).map((entry) => [entry.key, entry.plain]),
    );
    const keys = new Set<string>();
    for (const name of ["sep14-real", "sep04-real", "sep14", "sep04", "sep26-claude"]) {
      const tables = JSON.parse(
        readFileSync(join(FIXTURES, "replay", name, "tables.json"), "utf8"),
      ) as { cards?: { title?: string; body?: string }[] };
      for (const row of tables.cards ?? []) {
        keys.add(cardLabelKey({ title: row.title ?? "", body: row.body ?? "" }));
      }
    }
    for (const key of labels.keys()) expect(keys, key).toContain(key);
    for (const key of keys) expect(labels.has(key), key).toBe(true);
    // Every recorded card is also read for the sentence habits, and a broken
    // one says which habit broke.
    for (const row of rows.filter((entry) => entry.from === undefined)) {
      expect(typeof row.clear, row.key).toBe("boolean");
      if (row.clear === false) expect(row.clear_note?.trim(), row.key).toBeTruthy();
      // A card-word verdict (INF-2326) names the term or the opening it read.
      if (row.terms !== undefined) expect(row.terms_note?.trim(), row.key).toBeTruthy();
      if (row.affects !== undefined) expect(row.affects_note?.trim(), row.key).toBeTruthy();
      // A decision-rule verdict (INF-2715) names the placement or the words it read.
      if (row.sections !== undefined) expect(row.sections_note?.trim(), row.key).toBeTruthy();
      if (row.task_words !== undefined) expect(row.task_words_note?.trim(), row.key).toBeTruthy();
    }
  });
});

describe("the plan-to-build handoff (hand-labelled choices)", () => {
  it("honours a build approval with exactly one grounded start and any other choice with none", () => {
    const scored = scoreSession(
      observation({
        approvals: [
          // The answer started the plan's builder.
          { builds: true, groundedStarts: 1 },
          // The plan left on request.
          { builds: true, groundedStarts: 0 },
          // A second builder for the same plan.
          { builds: true, groundedStarts: 2 },
          // A choice that authorized nothing, answered with nothing started.
          { builds: false, groundedStarts: 0 },
          // ...and one answered with a start it did not authorize.
          { builds: false, groundedStarts: 1 },
        ],
      }),
    );
    expect(scored.approval_handoff_share).toEqual({ value: 2 / 5, numerator: 2, denominator: 5 });
    // Nothing labelled, or nothing the recording answered: unknown, never a clean score.
    expect(scoreSession(observation()).approval_handoff_share).toEqual({
      value: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it("reads the labels file, skipping its comments and refusing a row filed twice or without a reason", () => {
    const labels = parseApprovalLabels(
      [
        "// the labels",
        '{"card":"card-a","choice":"agree","builds":true,"note":"an accepted plan"}',
        "",
        '{"card":"card-a","choice":"hold","builds":false,"note":"an explicit hold"}',
      ].join("\n"),
    );
    expect([...labels.entries()]).toEqual([
      [approvalLabelKey("card-a", "agree"), true],
      [approvalLabelKey("card-a", "hold"), false],
    ]);
    expect(() =>
      parseApprovalLabels(
        [
          '{"card":"card-a","choice":"agree","builds":true,"note":"once"}',
          '{"card":"card-a","choice":"agree","builds":false,"note":"twice"}',
        ].join("\n"),
      ),
    ).toThrow("filed twice");
    expect(() =>
      parseApprovalLabels('{"card":"card-a","choice":"agree","builds":true,"note":" "}'),
    ).toThrow("without a card, a choice, a verdict or a reason");
  });

  it("files every committed label under a choice a committed recording shows the captain making", () => {
    // A label is read against the fixtures it was written for: a row naming
    // a card no recording resolved, or an action the captain did not choose
    // there, is a label that drifted.
    const rows = parseApprovalLabelRows(
      readFileSync(join(FIXTURES, "approval-labels", "labels.jsonl"), "utf8"),
    );
    expect(rows.length).toBeGreaterThan(0);
    const chosen = new Set<string>();
    for (const name of readdirSync(join(FIXTURES, "replay"))) {
      const path = join(FIXTURES, "replay", name, "tables.json");
      if (!existsSync(path)) continue;
      const tables = JSON.parse(readFileSync(path, "utf8")) as {
        cards?: { id?: string; chosen_action?: string | null }[];
      };
      for (const row of tables.cards ?? []) {
        if (row.id && row.chosen_action) chosen.add(approvalLabelKey(row.id, row.chosen_action));
      }
    }
    for (const row of rows) {
      expect(chosen, approvalLabelKey(row.card, row.choice)).toContain(
        approvalLabelKey(row.card, row.choice),
      );
    }
  });
});

describe("declared plan skips", () => {
  it("counts declared direct builds and only readable late review decisions", () => {
    const base = {
      tier: "high",
      served: "high",
      kindSource: null,
      escalatedFrom: null,
      rigor: "standard",
      deliverable: "change",
      delivery: "direct-pr",
      hasPr: false,
      ciRounds: null,
      capHits: 0,
      overrides: [],
      evidence: null,
    };
    const rows: ObservedDispatch[] = [
      { ...base, taskId: "direct", skippedPlanBecause: "One label, no meaning change; inspect it" },
      { ...base, taskId: "planned", skippedPlanBecause: null },
      { ...base, taskId: "old" },
    ];
    const reviews: ObservedReview[] = [
      {
        taskId: "direct",
        reviewTaskId: "r",
        verdict: "findings",
        risk: null,
        findings: { "ask-user": 2, "auto-fix": 1, "no-op": 0 },
      },
      {
        taskId: "planned",
        reviewTaskId: "p",
        verdict: "findings",
        risk: null,
        findings: { "ask-user": 5, "auto-fix": 0, "no-op": 0 },
      },
    ];
    expect(scorePlanSkips(rows, reviews)).toEqual({
      unplanned_change_share: { value: 1 / 3, numerator: 1, denominator: 3 },
      late_decisions_per_unplanned_change: { value: 2, numerator: 2, denominator: 1 },
    });
  });
});

describe("routing observability (S5)", () => {
  function dispatch(overrides: Partial<ObservedDispatch> = {}): ObservedDispatch {
    return {
      taskId: "t1",
      tier: "high",
      served: "high",
      kindSource: "classifier:xai/grok-4.6",
      escalatedFrom: null,
      rigor: "quick",
      deliverable: "change",
      delivery: "direct-pr",
      hasPr: false,
      ciRounds: null,
      capHits: 0,
      overrides: [],
      evidence: null,
      ...overrides,
    };
  }

  it("folds a kind stamp to the class that wrote it, and an unknown stamp to unstamped", () => {
    expect(kindSourceClass("classifier:xai/grok-4.6")).toBe("classified");
    expect(kindSourceClass("classifier-abstained:xai/grok-4.6")).toBe("abstained");
    expect(kindSourceClass("classifier-failed:timeout")).toBe("failed");
    expect(kindSourceClass("skipped:escalation")).toBe("skipped");
    // A row written before any of this, and a row nobody asked about, are
    // not a classifier declining to answer.
    expect(kindSourceClass("legacy-judgment")).toBe("unstamped");
    expect(kindSourceClass(null)).toBe("unstamped");
  });

  it("scores the tier mix, the classifier sources, downgrades and escalations", () => {
    const scores = scoreRouting([
      dispatch({ taskId: "a", tier: "high", served: "medium" }),
      dispatch({ taskId: "b", tier: "medium", served: "medium" }),
      dispatch({
        taskId: "c",
        tier: "low",
        served: "low",
        kindSource: "classifier-abstained:xai/grok-4.6",
      }),
      dispatch({
        taskId: "d",
        tier: "premium",
        served: "premium",
        kindSource: "skipped:escalation",
        escalatedFrom: "a",
      }),
    ]);
    expect(scores.tier_share_high).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(scores.tier_share_premium.value).toBe(0.25);
    expect(scores.tier_share_medium.value).toBe(0.25);
    expect(scores.tier_share_low.value).toBe(0.25);
    expect(scores.kind_classified_share.value).toBe(0.5);
    expect(scores.kind_abstained_share.value).toBe(0.25);
    expect(scores.kind_skipped_share.value).toBe(0.25);
    expect(scores.kind_failed_share.value).toBe(0);
    // Only "a" was served under the slot the policy asked for.
    expect(scores.tier_downgrade_rate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(scores.escalations_per_lineage.value).toBe(1);
  });

  it("leaves an unrouted fleet unmeasured rather than clean", () => {
    // Nothing routed, so there is no tier mix and no downgrade rate. A zero
    // here would read as "nothing was ever downgraded", which is a claim
    // this evidence cannot make.
    const scores = scoreRouting([]);
    expect(scores.tier_share_high.value).toBeNull();
    expect(scores.tier_downgrade_rate.value).toBeNull();
    expect(scores.escalations_per_lineage.value).toBeNull();
    // A replay has no catalog to route against: the tier is computed, the
    // serving is not, so the downgrade rate stays unmeasurable.
    const unserved = scoreRouting([dispatch({ served: null })]);
    expect(unserved.tier_share_high.value).toBe(1);
    expect(unserved.tier_downgrade_rate.value).toBeNull();
  });

  it("charges every escalation to the root of its own chain", () => {
    const lineages = escalationLineages([
      dispatch({ taskId: "a" }),
      dispatch({ taskId: "b", escalatedFrom: "a" }),
      dispatch({ taskId: "c", escalatedFrom: "b" }),
      dispatch({ taskId: "x" }),
      dispatch({ taskId: "y", escalatedFrom: "x" }),
    ]);
    expect(lineages).toEqual([
      { root: "a", escalations: 2 },
      { root: "x", escalations: 1 },
    ]);
    const scores = scoreRouting([
      dispatch({ taskId: "a" }),
      dispatch({ taskId: "b", escalatedFrom: "a" }),
      dispatch({ taskId: "c", escalatedFrom: "b" }),
    ]);
    expect(scores.escalations_per_lineage.value).toBe(2);
  });
});

describe("the regression gate", () => {
  function scores(values: Partial<Record<keyof MetricScores, number | null>>): MetricScores {
    const empty = scoreSession(observation());
    for (const [id, value] of Object.entries(values)) {
      empty[id as keyof MetricScores] = { value: value ?? null };
    }
    return empty;
  }

  it("fails a metric that moved in its bad direction and passes an improvement", () => {
    const baseline = {
      sep14: { lock_refusals: 0, questions_answered_in_turn: 0.5, op_wakes_per_captain_turn: 1 },
    };
    expect(
      compareToBaseline(
        {
          sep14: scores({
            lock_refusals: 0,
            questions_answered_in_turn: 0.9,
            op_wakes_per_captain_turn: 0.5,
          }),
        },
        baseline,
      ),
    ).toEqual([]);
    const regressions = compareToBaseline(
      {
        sep14: scores({
          lock_refusals: 2,
          questions_answered_in_turn: 0.25,
          op_wakes_per_captain_turn: 1,
        }),
      },
      baseline,
    );
    expect(regressions.map((r) => [r.metric, r.reason])).toEqual([
      ["questions_answered_in_turn", "fell from 0.5000 to 0.2500"],
      ["lock_refusals", "rose from 0 to 2"],
    ]);
  });

  it("fails a metric that became unmeasurable, and a session that vanished", () => {
    const regressions = compareToBaseline(
      { sep14: scores({ escalation_precision: null }) },
      { sep14: { escalation_precision: 1 }, sep04: { lock_refusals: 0 } },
    );
    expect(regressions.map((r) => r.session)).toEqual(["sep14", "sep04"]);
  });

  it("does not fail a metric the baseline could not measure", () => {
    expect(
      compareToBaseline(
        { sep14: scores({ escalation_precision: 0 }) },
        { sep14: { escalation_precision: null } },
      ),
    ).toEqual([]);
  });

  it("writes a baseline that the same scores pass", () => {
    const current = { sep14: scores({ lock_refusals: 0, visual_card_share: 1 / 3 }) };
    expect(compareToBaseline(current, baselineFrom(current))).toEqual([]);
  });

  it("records an observational metric in the baseline and grades nobody on it", () => {
    // A tier mix that moves toward premium is not a regression - the policy
    // decides the mix - so the gate must not fail on it. It still has to
    // land in the baseline, because the PR that moves it explains it.
    const current = { sep14: scores({ tier_share_premium: 0.8, tier_share_high: 0.2 }) };
    expect(baselineFrom(current).sep14?.tier_share_premium).toBe(0.8);
    expect(
      compareToBaseline(current, { sep14: { tier_share_premium: 0, tier_share_high: 1 } }),
    ).toEqual([]);
    // The graded routing rows still fail when they move the wrong way.
    expect(
      compareToBaseline(
        { sep14: scores({ tier_downgrade_rate: 0.4 }) },
        { sep14: { tier_downgrade_rate: 0.1 } },
      ).map((regression) => regression.metric),
    ).toEqual(["tier_downgrade_rate"]);
  });
});

/**
 * Delivery rigor observability (phase 4). The numbers live beside the
 * routing ones so a replay report and an offline corpus export cannot
 * disagree about how carefully the fleet shipped; these pin what each one
 * counts, and that the vocabulary has not drifted from the host's.
 */
describe("delivery rigor observability (phase 4)", () => {
  function dispatch(overrides: Partial<ObservedDispatch> = {}): ObservedDispatch {
    return {
      taskId: "t1",
      tier: "high",
      served: "high",
      kindSource: "classifier:xai/grok-4.6",
      escalatedFrom: null,
      rigor: "quick",
      deliverable: "change",
      delivery: "direct-pr",
      hasPr: false,
      ciRounds: null,
      capHits: 0,
      overrides: [],
      evidence: null,
      ...overrides,
    };
  }

  function review(overrides: Partial<ObservedReview> = {}): ObservedReview {
    return {
      taskId: "bld1",
      reviewTaskId: "rev1",
      verdict: "pass",
      risk: "low",
      findings: null,
      ...overrides,
    };
  }

  it("spells the same vocabulary the host runs on", () => {
    expect([...RIGORS]).toEqual(rigorSchema.options);
    expect([...REVIEW_VERDICTS]).toEqual(reviewVerdictSchema.options);
    // The brief names three actions and the metrics count exactly those.
    expect([...FINDING_ACTIONS]).toEqual(["auto-fix", "ask-user", "no-op"]);
  });

  it("counts a reviewer's findings by the action each asks for, one per line", () => {
    const report = [
      "verdict: findings",
      "F1 error src/a.ts:12 the meter reads a window it never bounded - auto-fix",
      "F2 warning src/b.ts:4 this changes what the captain sees - ask-user",
      "F3 info src/c.ts:9 a note for later - no-op",
      "risk: medium ask-user findings outnumber the fixes",
    ].join("\n");
    expect(findingActions(report)).toEqual({ "auto-fix": 1, "ask-user": 1, "no-op": 1 });
    // A clean review found nothing, which is a real zero.
    expect(findingActions("verdict: pass\nrisk: low nothing to fix")).toEqual({
      "auto-fix": 0,
      "ask-user": 0,
      "no-op": 0,
    });
    // A review whose text is not on the record established nothing.
    expect(findingActions(null)).toBeNull();
  });

  it("credits findings only to the round whose report the record still holds", () => {
    const events: ReviewEvent[] = [
      { taskId: "bld1", at: 10, verdict: "findings", risk: "high", reviewTaskId: "rev1" },
      { taskId: "bld1", at: 20, verdict: "pass", risk: "low", reviewTaskId: "rev1" },
    ];
    const rows = observedReviews(events, new Map([["rev1", "verdict: pass\nrisk: low all clear"]]));
    expect(rows.map((row) => row.verdict)).toEqual(["findings", "pass"]);
    // The earlier round's text was overwritten: unknown, never zero.
    expect(rows[0]?.findings).toBeNull();
    expect(rows[1]?.findings).toEqual({ "auto-fix": 0, "ask-user": 0, "no-op": 0 });
  });

  it("drops a review event that carries no verdict rather than guessing one", () => {
    expect(
      observedReviews(
        [{ taskId: "bld1", at: 1, verdict: null, risk: null, reviewTaskId: "rev1" }],
        new Map(),
      ),
    ).toEqual([]);
  });

  it("reads a completion card off its declared settle effect, never an id or a label", () => {
    expect(
      isCompletionCard(JSON.stringify([{ id: "x", effect: { kind: "settle", mode: "merge" } }])),
    ).toBe(true);
    expect(
      isCompletionCard(JSON.stringify([{ id: "x", effect: { kind: "settle", mode: "discard" } }])),
    ).toBe(false);
    // A merge-looking id with no effect is exactly what `fake_merge_buttons`
    // is for; it is not a completion card.
    expect(isCompletionCard(JSON.stringify([{ id: "merge", label: "Merge the PR" }]))).toBe(false);
    expect(isCompletionCard(null)).toBe(false);
    expect(isCompletionCard("not json")).toBe(false);
  });

  it("reads the evidence contract off the same headings the lint refuses on", () => {
    const body = EVIDENCE_HEADINGS.map((heading) => `<h3>${heading}</h3><p>x</p>`).join("");
    expect(carriesEvidenceHeadings(bodyHeadings(body))).toBe(true);
    // A heading hidden in a script is not copy, so it is not a heading.
    expect(
      carriesEvidenceHeadings(
        bodyHeadings(body.replace("<h3>Risk</h3>", "<script><h3>Risk</h3></script>")),
      ),
    ).toBe(false);
  });

  it("scores the tier mix, the evidence share and the holds from the dispatch records", () => {
    const scores = scoreRigor(
      [
        dispatch({ taskId: "a", rigor: "quick" }),
        dispatch({ taskId: "b", rigor: "standard", evidence: true }),
        dispatch({ taskId: "c", rigor: "reviewed", evidence: false, capHits: 2 }),
        dispatch({ taskId: "d", rigor: "reviewed", evidence: null }),
      ],
      [],
    );
    expect(scores.rigor_share_quick.value).toBe(0.25);
    expect(scores.rigor_share_standard.value).toBe(0.25);
    expect(scores.rigor_share_reviewed.value).toBe(0.5);
    // Only the two changes that actually settled with a completion card
    // can answer the evidence question; the third is not a failure.
    expect(scores.evidence_headings_share).toMatchObject({ numerator: 1, denominator: 2 });
    expect(scores.rigor_cap_hits.value).toBe(2);
  });

  it("leaves a review task out of the tier mix: it read a change, it shipped none", () => {
    const scores = scoreRigor(
      [dispatch({ taskId: "bld1", rigor: "reviewed" }), dispatch({ taskId: "rev1", rigor: null })],
      [],
    );
    expect(scores.rigor_share_reviewed).toMatchObject({ value: 1, denominator: 1 });
    expect(scores.rigor_share_quick.value).toBe(0);
  });

  it("charges CI rounds only to direct-pr changes that opened a pull request", () => {
    const scores = scoreRigor(
      [
        dispatch({ taskId: "a", delivery: "direct-pr", hasPr: true, ciRounds: 3 }),
        dispatch({ taskId: "b", delivery: "direct-pr", hasPr: true, ciRounds: 0 }),
        // No PR, and a local-only change: neither had CI to spend rounds on.
        dispatch({ taskId: "c", delivery: "direct-pr", hasPr: false, ciRounds: null }),
        dispatch({ taskId: "d", delivery: "local-only", hasPr: false, ciRounds: null }),
      ],
      [],
    );
    expect(scores.ci_rounds_per_change).toMatchObject({ value: 1.5, denominator: 2 });
  });

  it("counts rounds, verdicts and the ask-user share over the reviews themselves", () => {
    const scores = scoreRigor(
      [dispatch({ taskId: "bld1", rigor: "reviewed" })],
      [
        review({
          verdict: "findings",
          risk: "high",
          findings: { "auto-fix": 2, "ask-user": 1, "no-op": 1 },
        }),
        review({ verdict: "pass", findings: { "auto-fix": 0, "ask-user": 0, "no-op": 0 } }),
      ],
    );
    // One change, read twice: two rounds.
    expect(scores.review_rounds_per_change.value).toBe(2);
    expect(scores.review_verdict_share_pass.value).toBe(0.5);
    expect(scores.review_verdict_share_findings.value).toBe(0.5);
    expect(scores.review_verdict_share_blocked.value).toBe(0);
    expect(scores.findings_auto_fix_per_change.value).toBe(2);
    expect(scores.findings_ask_user_per_change.value).toBe(1);
    expect(scores.findings_no_op_per_change.value).toBe(1);
    expect(scores.findings_ask_user_rate.value).toBe(0.25);
  });

  it("has no review numbers at all for a fleet that reviewed nothing", () => {
    const scores = scoreRigor([dispatch()], []);
    expect(scores.review_rounds_per_change.value).toBeNull();
    expect(scores.findings_ask_user_rate.value).toBeNull();
    expect(scores.review_verdict_share_pass.value).toBeNull();
    // A hold nobody placed is a real zero: the caps are counts, not shares.
    expect(scores.rigor_cap_hits.value).toBe(0);
  });
});
