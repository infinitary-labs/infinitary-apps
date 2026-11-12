/**
 * WI-21 - the interaction metrics (interaction-system program P3; plan
 * `fm3000-interaction-sys-improve-s1/implementation-plan.md` section 4).
 *
 * The ONE place the section-4 numbers are computed, so the replay harness
 * (`scripts/replay-captain-session.ts`) and the duplicate-candidate deriver
 * (`scripts/derive-duplicate-candidates.ts`) score a session the same way.
 * The measured Sep 14 baseline and the captain's targets are committed here
 * as data; the replay gate's own baseline (what the committed fixtures score
 * at the current code) lives next to the fixtures in
 * `tests/fixtures/replay/baseline.json`.
 *
 * Pure and dependency-free on purpose: it is imported both by plain-Node
 * scripts (type stripping, no aliases) and by the Vite-loaded replay engine.
 */

import { createHash } from "node:crypto";

// --------------------------------------------------------------------------
// The catalog: section 4, row by row, plus the frustration-mode counters
// (report.md section 2.2) the replay also gates on.
// --------------------------------------------------------------------------

export type MetricId =
  | "questions_answered_in_turn"
  | "answer_cards_with_default"
  | "captain_reasks_10min"
  | "firstmate_cards_dismissed_60s"
  | "duplicate_card_pairs"
  | "op_wakes_per_captain_turn"
  | "escalation_precision"
  | "lock_refusals"
  | "closed_rows_with_worktree"
  | "closed_without_evidence"
  | "visual_card_share"
  | "mean_card_body_chars"
  | "mean_card_open_words"
  | "escalations"
  | "wakes_after_cancel"
  | "guidance_queued_wakes"
  | "fake_merge_buttons"
  | "implausible_outcomes"
  | "spawn_start_failures"
  | "asks_without_action"
  | "unplanned_change_share"
  | "late_decisions_per_unplanned_change"
  | "tier_share_premium"
  | "tier_share_high"
  | "tier_share_medium"
  | "tier_share_low"
  | "kind_classified_share"
  | "kind_abstained_share"
  | "kind_failed_share"
  | "kind_skipped_share"
  | "tier_downgrade_rate"
  | "escalations_per_lineage"
  | "deliverable_share_answer"
  | "rigor_share_quick"
  | "rigor_share_standard"
  | "rigor_share_reviewed"
  | "evidence_headings_share"
  | "review_rounds_per_change"
  | "findings_auto_fix_per_change"
  | "findings_ask_user_per_change"
  | "findings_no_op_per_change"
  | "findings_ask_user_rate"
  | "review_verdict_share_pass"
  | "review_verdict_share_findings"
  | "review_verdict_share_blocked"
  | "ci_rounds_per_change"
  | "rigor_cap_hits"
  | "hold_overrides"
  | "plain_language_share"
  | "clear_copy_share"
  | "pr_link_share"
  | "term_explained_share"
  | "change_effect_share"
  | "section_question_share"
  | "task_verb_share"
  | "approval_handoff_share";

/**
 * `either` is the observational direction (intelligence-bucket routing S5):
 * the number is recorded in the baseline and printed in the report, but the
 * gate never grades it, because it has no good side. A tier mix that moves
 * toward high is the policy working, not a regression; a mix that moves the
 * other way is not a win. Recording it still makes every change visible in
 * the baseline diff, which is what "explain the baseline change" asks for.
 */
export type MetricDirection = "higher" | "lower" | "either";

export type MetricDef = {
  id: MetricId;
  label: string;
  /**
   * `section4` rows are the plan's table; `mode` counters pin report.md 2.2;
   * `routing` rows are the intelligence-bucket observability (S5);
   * `rigor` rows are the delivery-rigor observability (phase 4);
   * `copy` rows are the plain-language pass (roadmap 1.5) and the sentence
   * habits (contract 4.58), both hand-scored;
   * `handoff` rows are the plan-to-build handoff, scored on hand-labelled
   * choices.
   */
  group: "section4" | "mode" | "routing" | "rigor" | "copy" | "handoff";
  direction: MetricDirection;
  /** Frustration modes (F1-F9) this metric asserts on. */
  modes: FrustrationMode[];
  /** The measured Sep 14 value from report.md, when it is a number. */
  sep14: { value: number | null; text: string };
  /** The captain-approved target, when the plan states one. */
  target: { op: "<" | "<=" | "=" | ">=" | ">"; value: number; text: string } | null;
};

export type FrustrationMode = "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9";

export const FRUSTRATION_MODES: Record<FrustrationMode, string> = {
  F1: "Ghost crew: closed or long-idle rows keep worktrees",
  F2: "Orchestrator locked out by the supervision claim",
  F3: "A corrupted crewmate becomes delivered work",
  F4: "Duplicate cards",
  F5: "Explain, don't solve",
  F6: "Cards unreadable or invisible",
  F7: "Merge clicks that did not merge",
  F8: "Branch-collision cascade",
  F9: "Noise as work",
};

export const METRICS: readonly MetricDef[] = [
  {
    id: "questions_answered_in_turn",
    label: "Questions answered by the Firstmate itself, within one turn",
    group: "section4",
    direction: "higher",
    modes: ["F5"],
    sep14: { value: 8 / 25, text: "8 / 25" },
    target: { op: ">=", value: 0.7, text: "at least 70%" },
  },
  {
    id: "answer_cards_with_default",
    label: "Answer cards carrying a default action",
    group: "section4",
    direction: "higher",
    modes: ["F5"],
    sep14: { value: 0, text: "0 / 15" },
    target: { op: "=", value: 1, text: "all" },
  },
  {
    id: "captain_reasks_10min",
    label: "Captain re-asks on the same topic within 10 min",
    group: "section4",
    direction: "lower",
    modes: ["F5"],
    sep14: { value: 8, text: '8 (the "delivered" thread)' },
    target: { op: "<=", value: 1, text: "at most 1" },
  },
  {
    id: "firstmate_cards_dismissed_60s",
    label: "Firstmate cards dismissed without action within 60 s",
    group: "section4",
    direction: "lower",
    modes: ["F5", "F6"],
    sep14: { value: 9 / 15, text: "9 / 15" },
    target: { op: "<", value: 0.2, text: "under 20%" },
  },
  {
    id: "duplicate_card_pairs",
    label: "Duplicate cards per session (captain-stamped or overlap-detected pairs)",
    group: "section4",
    direction: "lower",
    modes: ["F4"],
    sep14: { value: 3, text: "3 repeat pairs" },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    id: "op_wakes_per_captain_turn",
    label: "Operational wakes per captain turn",
    group: "section4",
    direction: "lower",
    modes: ["F9"],
    sep14: { value: 3.7, text: "3.7" },
    target: { op: "<", value: 1, text: "under 1" },
  },
  {
    id: "escalation_precision",
    label: "Escalations that led to a visible card or a Firstmate action within one turn",
    group: "section4",
    direction: "higher",
    modes: ["F2", "F9"],
    sep14: {
      value: null,
      text: 'most led to a refused steer or "do not duplicate"',
    },
    target: { op: ">", value: 0.8, text: "over 80%" },
  },
  {
    id: "lock_refusals",
    label: "Lock refusals / lost steers",
    group: "section4",
    direction: "lower",
    modes: ["F2"],
    sep14: { value: 21, text: "21" },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    id: "closed_rows_with_worktree",
    // A delivered row keeps its worktree by definition (finished, not yet
    // landed); what must not keep one is a done or dropped close (WI-7).
    label: "Rows with a worktree after a done or dropped close",
    group: "section4",
    direction: "lower",
    modes: ["F1"],
    sep14: {
      value: 20,
      text: "20 cancelled rows (the report's 47 also counts 27 delivered rows)",
    },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    id: "closed_without_evidence",
    label: "Tasks closed as delivered without evidence",
    group: "section4",
    direction: "lower",
    modes: ["F1", "F3"],
    sep14: { value: null, text: "counted inside the 47" },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    id: "visual_card_share",
    label: "Cards with a visual element (table, svg, figure, canvas)",
    group: "section4",
    direction: "higher",
    modes: ["F6"],
    sep14: { value: 3 / 46, text: "3 / 46" },
    target: { op: ">", value: 0.5, text: "most explanations" },
  },
  {
    id: "mean_card_body_chars",
    label: "Mean card body length (characters)",
    group: "section4",
    direction: "lower",
    modes: ["F6"],
    sep14: { value: 1197, text: "1,197 chars" },
    target: { op: "<", value: 1197, text: "shorter" },
  },
  {
    // INF-3749, the captain's "fewer words, big visuals": the words a reader
    // meets before opening anything. Observational: counted and printed, never
    // graded, because no card is refused for its length.
    id: "mean_card_open_words",
    label: "Mean open words per card (outside expands, drawings and scripts)",
    group: "section4",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not recorded" },
    target: null,
  },
  {
    id: "escalations",
    label: "Supervision escalations reaching the Firstmate",
    group: "mode",
    direction: "lower",
    modes: ["F9"],
    sep14: { value: 59, text: "59" },
    target: { op: "<", value: 10, text: "fewer than 10 (P0 exit)" },
  },
  {
    id: "wakes_after_cancel",
    label: "Supervision or Firstmate wakes about a task after it closed",
    group: "mode",
    direction: "lower",
    modes: ["F9"],
    sep14: { value: 5, text: "4 on ba13eadd + 1 on c9dab1e7" },
    target: { op: "=", value: 0, text: "0 (P0 exit)" },
  },
  {
    id: "guidance_queued_wakes",
    label: '"Guidance queued" Firstmate wakes',
    group: "mode",
    direction: "lower",
    modes: ["F9"],
    sep14: { value: 39, text: "39" },
    target: { op: "=", value: 0, text: "0 (P0 exit)" },
  },
  {
    id: "fake_merge_buttons",
    label: "Decision cards shown with a merge-looking action that carries no settle effect",
    group: "mode",
    direction: "lower",
    modes: ["F7"],
    sep14: { value: 29, text: "29 cards resolved with invented merge ids (Sep 4-5)" },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    // Observational: a message is counted when no action took effect after
    // Firstmate read it (docs/task-capture.md "Answer delivery"). The replay
    // judges in observe mode, so no retry or notice changes a recorded turn.
    id: "asks_without_action",
    label: "Captain messages with no action that took effect after Firstmate read them",
    group: "mode",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not recorded" },
    target: null,
  },
  {
    id: "implausible_outcomes",
    label: "Garbled crewmate text recorded as a task's report",
    group: "mode",
    direction: "lower",
    modes: ["F3"],
    sep14: { value: 1, text: "FI3-55's outcome" },
    target: { op: "=", value: 0, text: "0" },
  },
  {
    id: "spawn_start_failures",
    label: "Spawns that could not start",
    group: "mode",
    direction: "lower",
    modes: ["F8"],
    sep14: { value: 3, text: "FI3-62, FI3-64, FI3-63" },
    target: { op: "=", value: 0, text: "0" },
  },
  // ------------------------------------------------------------------------
  // Intelligence-bucket routing (S5). Nothing here has a Sep 14 value: on
  // that evening the Firstmate JUDGED a reasoning class, so no tier was
  // computed, no kind was classified and no lineage was escalated. The four
  // shares are observational - a mix is not a regression - while the
  // downgrade rate and the escalation depth are graded, because both say
  // the work did not get what the policy asked for.
  // ------------------------------------------------------------------------
  {
    id: "unplanned_change_share",
    label: "Changes built without a plan or chosen basis",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not recorded" },
    target: null,
  },
  {
    id: "late_decisions_per_unplanned_change",
    label: "Review questions per unplanned change with a readable review",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not recorded" },
    target: null,
  },
  {
    id: "tier_share_premium",
    label: "Dispatches routed to the premium slot",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (the class was judged, not computed)" },
    target: null,
  },
  {
    id: "tier_share_high",
    label: "Dispatches routed to the high slot",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (the class was judged, not computed)" },
    target: null,
  },
  {
    id: "tier_share_medium",
    label: "Dispatches routed to the medium slot",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (the class was judged, not computed)" },
    target: null,
  },
  {
    id: "tier_share_low",
    label: "Dispatches routed to the low slot",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (the class was judged, not computed)" },
    target: null,
  },
  {
    id: "kind_classified_share",
    label: "Dispatches whose kind a classifier established",
    group: "routing",
    direction: "higher",
    modes: [],
    sep14: { value: null, text: "no classifier existed" },
    target: null,
  },
  {
    id: "kind_abstained_share",
    label: "Dispatches where the classifier abstained",
    group: "routing",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "no classifier existed" },
    target: null,
  },
  {
    id: "kind_failed_share",
    label: "Dispatches where the classification failed outright",
    group: "routing",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "no classifier existed" },
    target: null,
  },
  {
    id: "kind_skipped_share",
    label: "Dispatches where a rule above the kind decided the tier",
    group: "routing",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no classifier existed" },
    target: null,
  },
  {
    id: "tier_downgrade_rate",
    label: "Dispatches served below the tier the policy asked for",
    group: "routing",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "the served slot was not recorded" },
    target: null,
  },
  {
    id: "escalations_per_lineage",
    label: "Escalations spent per escalated lineage",
    group: "routing",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "escalation did not exist" },
    target: null,
  },
  // ------------------------------------------------------------------------
  // Delivery rigor (phase 4). Nothing here has a Sep 14 value either: rigor
  // did not exist, every change shipped at whatever care its crewmate chose,
  // and no reviewer read one. The distributions and the findings mix are
  // observational - a fleet that reviews more is the policy working, not a
  // regression - while the share of shipped changes whose report carries the
  // evidence contract, the rounds each reviewed change costs, and the holds
  // graded, because each of those says the tier is not paying for itself.
  // ------------------------------------------------------------------------
  {
    id: "deliverable_share_answer",
    label: "Dispatches whose deliverable is an answer, not a change",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (the deliverable axis did not exist)" },
    target: null,
  },
  {
    id: "plain_language_share",
    label: "Cards whose visible words follow the vocabulary (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: { value: 0, text: "0 of 48 real cards, read by hand against the vocabulary" },
    target: null,
  },
  {
    id: "clear_copy_share",
    label: "Cards whose sentences follow the five copy habits (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: { value: 20 / 48, text: "20 of 48 real cards, read by hand against the five habits" },
    target: null,
  },
  {
    id: "pr_link_share",
    label: "Cards whose pull request numbers link to their pages (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: {
      value: 5 / 29,
      text: "5 of the 29 real cards whose body names a pull request, read by hand",
    },
    target: null,
  },
  {
    id: "term_explained_share",
    label: "Cards that explain the project's own terms at first use (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: {
      value: 2 / 44,
      text: "2 of the 44 recorded cards whose open prose uses a project term, read by hand",
    },
    target: null,
  },
  {
    id: "change_effect_share",
    label: "Change cards that say near their start what people will notice (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: {
      value: 22 / 33,
      text: "22 of the 33 recorded cards about a change, read by hand",
    },
    target: null,
  },
  {
    id: "section_question_share",
    label: "Decisions that ask each question in the section it is about (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: {
      value: 4 / 5,
      text: "4 of the 5 recorded decisions across several sections, read by hand",
    },
    target: null,
  },
  {
    id: "task_verb_share",
    label: "Cards that say file only for the backlog and start with its moment (hand-scored sample)",
    group: "copy",
    direction: "higher",
    modes: [],
    sep14: {
      value: 6 / 11,
      text: "6 of the 11 recorded cards that file, queue or start a task, read by hand",
    },
    target: null,
  },
  {
    id: "rigor_share_quick",
    label: "Dispatches shipped at the quick tier",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (rigor did not exist)" },
    target: null,
  },
  {
    id: "rigor_share_standard",
    label: "Dispatches shipped at the standard tier",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (rigor did not exist)" },
    target: null,
  },
  {
    id: "rigor_share_reviewed",
    label: "Dispatches shipped at the reviewed tier",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "not measured (rigor did not exist)" },
    target: null,
  },
  {
    id: "evidence_headings_share",
    label: "Standard-or-above shipped changes whose report carried all five headings",
    group: "rigor",
    direction: "higher",
    modes: [],
    sep14: { value: null, text: "the evidence contract did not exist" },
    target: null,
  },
  {
    id: "review_rounds_per_change",
    label: "Review rounds spent per reviewed change",
    group: "rigor",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "findings_auto_fix_per_change",
    label: "Auto-fix findings per reviewed change",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "findings_ask_user_per_change",
    label: "Ask-user findings per reviewed change",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "findings_no_op_per_change",
    label: "No-op findings per reviewed change",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "findings_ask_user_rate",
    label: "Findings the reviewer sent to the captain rather than the builder",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "review_verdict_share_pass",
    label: "Review verdicts that passed",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "review_verdict_share_findings",
    label: "Review verdicts that returned findings",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "review_verdict_share_blocked",
    label: "Review verdicts that were blocked",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "no change was reviewed" },
    target: null,
  },
  {
    id: "ci_rounds_per_change",
    label: "CI rounds spent per direct-pr change",
    group: "rigor",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "the rounds were not counted" },
    target: null,
  },
  {
    id: "rigor_cap_hits",
    label: "Host holds a round cap placed on a change",
    group: "rigor",
    direction: "lower",
    modes: [],
    sep14: { value: null, text: "the caps did not exist" },
    target: null,
  },
  // The captain's words passing a soft hold (docs/delivery-rigor.md, "The
  // holds"; INF-484 move 8). Observational: a hold his words pass often is
  // a sign it is a verdict and should drop a level, which the weekly audit
  // judges from the count per kind (`overridesByHold`) - nobody grades it.
  {
    id: "hold_overrides",
    label: "Overrides the captain's words declared on a task's soft holds",
    group: "rigor",
    direction: "either",
    modes: [],
    sep14: { value: null, text: "the override did not exist" },
    target: null,
  },
  // ------------------------------------------------------------------------
  // The plan-to-build handoff (docs/card-authoring.md "The handoff"). What a
  // captain's choice authorized is a judgment, so a person reads it and files
  // it as a label (`tests/fixtures/approval-labels/labels.jsonl`); nothing
  // parses the card's words. What the Firstmate's answer did is read off the
  // record: the builders grounded on that plan its answering turn started.
  // ------------------------------------------------------------------------
  {
    id: "approval_handoff_share",
    label:
      "Labelled choices the Firstmate's answer honoured: one grounded builder on a build approval, none otherwise",
    group: "handoff",
    direction: "higher",
    modes: [],
    sep14: { value: null, text: "not recorded (no plan had a grounded builder)" },
    target: { op: "=", value: 1, text: "all" },
  },
];

export const METRIC_IDS: readonly MetricId[] = METRICS.map((metric) => metric.id);

export function metricDef(id: MetricId): MetricDef {
  const def = METRICS.find((metric) => metric.id === id);
  if (!def) throw new Error(`unknown metric ${id}`);
  return def;
}

// --------------------------------------------------------------------------
// Shared thresholds
// --------------------------------------------------------------------------

/** Two cards on one task at least this similar are an overlap-detected pair. */
export const DUPLICATE_SIMILARITY = 0.5;
/** ... and only when the second appeared within this long of the first. */
export const DUPLICATE_WINDOW_MS = 30 * 60_000;
/** A captain question repeating a topic within this window is a re-ask. */
export const REASK_WINDOW_MS = 10 * 60_000;
/** A Firstmate card dismissed this soon after it appeared was not wanted. */
export const QUICK_DISMISS_MS = 60_000;

// --------------------------------------------------------------------------
// Text similarity (simple on purpose: a candidate, never a verdict)
// --------------------------------------------------------------------------

/**
 * Words that carry no topic in this product's conversation: English glue
 * plus the fleet vocabulary every question and card shares. Kept short and
 * explicit so the similarity stays explainable.
 */
const STOPWORDS = new Set(
  (
    "a about after again all also and any are because been before being but can could did " +
    "does doesn't don't each even for from get got had has have how i i'm if in into is " +
    "isn't it it's its just let me more most my no not now of on one only or our out over " +
    "should so some still such than that the their them then there these they this those " +
    "to too up us was we were what what's when where which while who why will with would " +
    "yet you your card cards task tasks crewmate crewmates firstmate captain please thing " +
    "things see seeing like want need make think know"
  ).split(" "),
);

/** Lowercase topic words of a text, with markup stripped. */
export function topicTokens(text: string): Set<string> {
  const plain = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase();
  const tokens = new Set<string>();
  for (const raw of plain.split(/[^\p{L}\p{N}'-]+/u)) {
    const word = raw.replace(/^['-]+|['-]+$/g, "");
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type CardText = { title: string; body: string };

/**
 * The key a hand label is filed under (`tests/fixtures/plain-language/
 * labels.jsonl`): the card's own words, hashed, so a label can never drift
 * onto another card. The same shape the kind classifier's labels use.
 */
export function cardLabelKey(card: CardText): string {
  return createHash("sha256").update(`${card.title}\n${card.body}`).digest("hex").slice(0, 12);
}

/**
 * One hand label. `from` names the end-to-end spec a card came from when it
 * is not in a recorded session (git integration PR 1.3): that spec reads
 * the card off the running app and fails when no row names it, the way the
 * committed-sample test does for a recorded card.
 */
export type PlainLabel = {
  key: string;
  plain: boolean;
  note: string;
  from?: string;
  /**
   * The second reading of the same card (contract 4.58): true when its open
   * prose follows the five sentence habits `CARD_AUTHORING` states, false
   * when one is broken, absent when no one has read the card for them.
   * `clear_note` names the habit that broke.
   */
  clear?: boolean;
  clear_note?: string;
  /**
   * The third reading (FI3-1307): true when every pull request the card's
   * body names - by its number or its address - is a link that opens that
   * pull request's page, false when one is not, absent when the body names
   * none. `pr_links_note` names which one stayed text.
   */
  pr_links?: boolean;
  pr_links_note?: string;
  /**
   * The fourth reading (INF-2326): true when every term the project coined
   * that the card's open prose uses is explained in a few plain words at
   * first use or replaced, false when one is not, absent when it uses none.
   * `terms_note` names the term.
   */
  terms?: boolean;
  terms_note?: string;
  /**
   * The fifth reading (INF-2326): true when a card about a change says near
   * its start what people using the project will notice, or that only the
   * build, checks or documents change; false when it does not; absent on a
   * card about no change. `affects_note` names the opening.
   */
  affects?: boolean;
  affects_note?: string;
  /**
   * The sixth reading (INF-2715): true when a decision across several
   * sections - findings, proposals, options - asks each question in the
   * section it is about, and a choice among sections after their comparison;
   * false when it gathers them in one list away from what they ask about;
   * absent on every other card. `sections_note` names the placement.
   */
  sections?: boolean;
  sections_note?: string;
  /**
   * The seventh reading (INF-2715): true when a card that files, queues or
   * starts a task says file only for work left in the backlog and gives
   * work that starts by itself its moment, and a decision proposing new
   * tasks lets the captain file or start each; false when "file" names work
   * that starts, or such a decision offers neither; absent on every other
   * card. `task_words_note` names the words.
   */
  task_words?: boolean;
  task_words_note?: string;
};

/**
 * One hand-labelled captain choice (`tests/fixtures/approval-labels/
 * labels.jsonl`), filed under the recorded card id and the action chosen:
 * `builds` says whether the choice authorized building the plan it closed
 * or the builder its card was about. The judgment is a person's, read from
 * the captain's ask and the card as offered; `note` says why.
 */
export type ApprovalLabel = { card: string; choice: string; builds: boolean; note: string };

export function approvalLabelKey(card: string, choice: string): string {
  return `${card}|${choice}`;
}

/** The approval labels file's rows: `//` comment lines, then one JSON row per choice. */
export function parseApprovalLabelRows(text: string): ApprovalLabel[] {
  const rows: ApprovalLabel[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const row = JSON.parse(trimmed) as ApprovalLabel;
    if (
      typeof row.card !== "string" ||
      typeof row.choice !== "string" ||
      typeof row.builds !== "boolean" ||
      typeof row.note !== "string" ||
      !row.note.trim()
    ) {
      throw new Error(`approval label without a card, a choice, a verdict or a reason: ${trimmed}`);
    }
    const key = approvalLabelKey(row.card, row.choice);
    if (seen.has(key)) throw new Error(`approval label filed twice: ${key}`);
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** The approval labels as the replay reads them: a verdict per card and choice. */
export function parseApprovalLabels(text: string): Map<string, boolean> {
  return new Map(
    parseApprovalLabelRows(text).map((row) => [approvalLabelKey(row.card, row.choice), row.builds]),
  );
}

/** The labels file's rows: `//` comment lines, then one JSON row per card. */
export function parsePlainLabelRows(text: string): PlainLabel[] {
  const rows: PlainLabel[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const row = JSON.parse(trimmed) as PlainLabel;
    if (typeof row.key !== "string" || typeof row.plain !== "boolean") {
      throw new Error(`plain-language label without a key or a verdict: ${trimmed}`);
    }
    if (row.clear !== undefined && typeof row.clear !== "boolean") {
      throw new Error(`plain-language label whose clear verdict is not true or false: ${trimmed}`);
    }
    if (row.pr_links !== undefined && typeof row.pr_links !== "boolean") {
      throw new Error(`plain-language label whose pr_links verdict is not true or false: ${trimmed}`);
    }
    for (const reading of ["terms", "affects", "sections", "task_words"] as const) {
      if (row[reading] !== undefined && typeof row[reading] !== "boolean") {
        throw new Error(
          `plain-language label whose ${reading} verdict is not true or false: ${trimmed}`,
        );
      }
    }
    if (seen.has(row.key)) throw new Error(`plain-language label filed twice: ${row.key}`);
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
}

/** The labels file as the scorer reads it: a verdict per card key. */
export function parsePlainLabels(text: string): Map<string, boolean> {
  return new Map(parsePlainLabelRows(text).map((row) => [row.key, row.plain]));
}

/** The sentence-habit verdicts in the same file: only the cards read for them. */
export function parseClearLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.clear !== undefined) labels.set(row.key, row.clear);
  }
  return labels;
}

/** The pull request link verdicts in the same file: only the cards whose body names one. */
export function parsePrLinkLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.pr_links !== undefined) labels.set(row.key, row.pr_links);
  }
  return labels;
}

/** The project-term verdicts in the same file: only the cards whose open prose uses one. */
export function parseTermLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.terms !== undefined) labels.set(row.key, row.terms);
  }
  return labels;
}

/** The section-question verdicts in the same file: only decisions across several sections. */
export function parseSectionLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.sections !== undefined) labels.set(row.key, row.sections);
  }
  return labels;
}

/** The task-verb verdicts in the same file: only the cards that file, queue or start a task. */
export function parseTaskWordLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.task_words !== undefined) labels.set(row.key, row.task_words);
  }
  return labels;
}

/** The change-effect verdicts in the same file: only the cards about a change. */
export function parseEffectLabels(text: string): Map<string, boolean> {
  const labels = new Map<string, boolean>();
  for (const row of parsePlainLabelRows(text)) {
    if (row.affects !== undefined) labels.set(row.key, row.affects);
  }
  return labels;
}

/**
 * How much two cards say the same thing: the stronger of title overlap and
 * whole-card overlap. A shared title alone ("Plan: X" / "Plan: X") or a
 * restated body alone are each enough to make a candidate.
 */
export function cardSimilarity(a: CardText, b: CardText): number {
  const title = jaccard(topicTokens(a.title), topicTokens(b.title));
  const whole = jaccard(topicTokens(`${a.title} ${a.body}`), topicTokens(`${b.title} ${b.body}`));
  return Math.max(title, whole);
}

// --------------------------------------------------------------------------
// Duplicate pairs (shared with the WI-20 deriver)
// --------------------------------------------------------------------------

export type PairableCard = CardText & {
  id: string;
  taskId: string | null;
  createdAt: number;
};

export type CardPair = {
  first: string;
  second: string;
  taskId: string;
  similarity: number;
  gapMs: number;
};

/**
 * Candidate duplicate pairs: same task, emitted within the window, similar
 * above the threshold. Each later card pairs with its most similar earlier
 * card only, so a thread of N restatements is N-1 pairs, not N choose 2.
 */
export function duplicatePairs(
  cards: PairableCard[],
  options: { threshold?: number; windowMs?: number } = {},
): CardPair[] {
  const threshold = options.threshold ?? DUPLICATE_SIMILARITY;
  const windowMs = options.windowMs ?? DUPLICATE_WINDOW_MS;
  const byTask = new Map<string, PairableCard[]>();
  for (const card of cards) {
    if (!card.taskId) continue;
    const bucket = byTask.get(card.taskId) ?? [];
    bucket.push(card);
    byTask.set(card.taskId, bucket);
  }
  const pairs: CardPair[] = [];
  for (const [taskId, bucket] of byTask) {
    const ordered = [...bucket].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const [index, later] of ordered.entries()) {
      let best: CardPair | undefined;
      for (const earlier of ordered.slice(0, index)) {
        const gapMs = later.createdAt - earlier.createdAt;
        if (gapMs > windowMs) continue;
        const similarity = cardSimilarity(earlier, later);
        if (similarity < threshold) continue;
        if (!best || similarity > best.similarity) {
          best = { first: earlier.id, second: later.id, taskId, similarity, gapMs };
        }
      }
      if (best) pairs.push(best);
    }
  }
  return pairs.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.second.localeCompare(b.second));
}

// --------------------------------------------------------------------------
// Captain questions and re-asks
// --------------------------------------------------------------------------

const QUESTION_LEAD =
  /^(why|what|what's|whats|where|which|who|how|when|is|are|was|were|did|does|do|can|could|should|shouldn't|would|will|isn't|aren't|any)\b/i;

/** A captain turn that asks rather than instructs. */
export function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.includes("?") || QUESTION_LEAD.test(trimmed);
}

export type CaptainQuestion = { at: number; text: string };

/**
 * A question is a re-ask when an earlier question inside the window shares
 * a topic word with it - the captain came back to the same thing.
 */
export function countReasks(
  questions: CaptainQuestion[],
  windowMs: number = REASK_WINDOW_MS,
): number {
  const ordered = [...questions].sort((a, b) => a.at - b.at);
  let reasks = 0;
  for (const [index, question] of ordered.entries()) {
    const tokens = topicTokens(question.text);
    const repeated = ordered
      .slice(0, index)
      .some(
        (earlier) =>
          question.at - earlier.at <= windowMs &&
          [...topicTokens(earlier.text)].some((token) => tokens.has(token)),
      );
    if (repeated) reasks += 1;
  }
  return reasks;
}

// --------------------------------------------------------------------------
// Fake settle buttons and garbled text (the eval's own checks, deliberately
// not imported from the host code they grade)
// --------------------------------------------------------------------------

const SETTLE_SHAPED_ID = /^(merge[-_ ]?pr|merge|land)([-_ ][a-z0-9]+|\d+)?$/i;
const SETTLE_SHAPED_LABEL = /^(merge|land)\b/i;

/**
 * A button that reads like merge or land - by id or by label - and carries
 * no settle effect, so the host runs no settle when it is clicked (F7's fake
 * buttons). Since cards/tasks/agents P1 an id carries no meaning, so
 * "merge-pr" with no effect is as fake as "merge-pr55" ever was.
 */
export function isFakeSettleAction(action: {
  id: string;
  label?: string;
  effect?: { kind: string } | null;
}): boolean {
  const claims = SETTLE_SHAPED_ID.test(action.id) || SETTLE_SHAPED_LABEL.test(action.label ?? "");
  return claims && action.effect?.kind !== "settle" && action.effect?.kind !== "merge";
}

const SCRIPTS: RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Han}/u,
  /\p{Script=Malayalam}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Thai}/u,
];

/**
 * Text no report should be (F3): a leaked tool-call fragment, or three or
 * more writing systems in one short message. Independent of the host's own
 * plausibility check on purpose - a gate that reused it could not catch that
 * check being weakened.
 */
export function looksGarbled(text: string): boolean {
  if (/\bto=functions\.[a-z_]+/i.test(text)) return true;
  const sample = text.slice(0, 2000);
  return SCRIPTS.filter((script) => script.test(sample)).length >= 3;
}

// --------------------------------------------------------------------------
// Routing observability (intelligence-bucket routing S5)
// --------------------------------------------------------------------------

/**
 * The four intelligence slots, strongest first. Spelled here rather than
 * imported: this module is deliberately dependency-free, and the same
 * separation that keeps `isFakeSettleAction` out of the host code it grades
 * applies to the routing vocabulary it measures.
 */
export const TIERS = ["premium", "high", "medium", "low"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The `kind_source` prefixes the spawn path stamps on a work shape
 * (`src/core/routing/kindClassifier.ts` `KIND_SOURCE`). A stamp that matches
 * none of them - `legacy-judgment`, or no stamp at all - is `unstamped`:
 * nobody asked, which is not the same as a classifier declining to answer.
 */
const KIND_SOURCE_CLASSES = {
  classified: "classifier:",
  abstained: "classifier-abstained:",
  failed: "classifier-failed:",
  skipped: "skipped:",
} as const;

export type KindSourceClass = keyof typeof KIND_SOURCE_CLASSES | "unstamped";

export function kindSourceClass(source: string | null | undefined): KindSourceClass {
  if (!source) return "unstamped";
  for (const [name, prefix] of Object.entries(KIND_SOURCE_CLASSES)) {
    if (source.startsWith(prefix)) return name as KindSourceClass;
  }
  return "unstamped";
}

/**
 * One commissioned piece of work, as the record holds it: the tier the
 * policy asked for (`tasks.difficulty` since S2), the tier the ladder
 * actually served (`routing_decisions.served` since S5), how the kind was
 * established (`WorkShape.kind_source`), and the attempt this one replaces
 * (`WorkShape.escalation.from`). Every field may be null, and null is
 * always "not established", never a zero.
 */
export type ObservedDispatch = {
  taskId: string;
  tier: string | null;
  served: string | null;
  kindSource: string | null;
  escalatedFrom: string | null;
  /** Declared direct-build skip; null on older rows and grounded changes. */
  skippedPlanBecause?: string | null;
  /**
   * The delivery rigor the host derived (phase 4). A shaped row that
   * carries none was commissioned before the tiers existed and reads
   * `quick`, which is what it actually shipped at - the same reading the
   * C5 join takes. Null means the row has no rigor to report AT ALL: a
   * review task reads a change rather than shipping one, so counting it in
   * the tier mix would be counting the reading as a shipment.
   */
  rigor: string | null;
  /**
   * What the row DELIVERS (crew-posture rationalization Task B): `answer`
   * for work that finds something out and lands one card, `change` for work
   * that ships. Null on a row shaped before the axis existed, which shipped
   * a change; an answer task is excluded from every rigor denominator,
   * because a task that ships nothing cannot carry the evidence contract.
   */
  deliverable: string | null;
  /** The repository posture the row delivered under; null when unrecorded. */
  delivery: string | null;
  /** A pull request is on the record, so CI had something to read. */
  hasPr: boolean;
  /**
   * Distinct heads CI went red on (`delivery.ciRounds`, phase 3). Null
   * only where no counter was ever written - a row older than the column.
   * A change whose CI never went red is a real zero, not a null.
   */
  ciRounds: number | null;
  /**
   * Round caps the host placed on this change: every cap standing on the
   * record now, plus every `cap_reset` its timeline recorded. A reset
   * clears both counters together and writes one event, so a double hold
   * that was answered counts once - the hold, not the counters.
   */
  capHits: number;
  /**
   * Each override the captain's words declared on this task, as the soft
   * holds it named (`overrideHoldsFrom`), oldest first. A taking-back is
   * not one. Empty when none was declared.
   */
  overrides: string[][];
  /**
   * Whether this change's REPORT carried the five evidence headings in
   * order (contract v3.6, captain lock 3: they left the completion card's
   * open body and stayed required in the report and the PR body, so the
   * metric follows them there rather than grading a rule the lint no longer
   * applies). Null where the tier asks for none, or where the change never
   * settled with a completion card - never a false.
   */
  evidence: boolean | null;
};

/** How deep the escalation walk may go before it calls the chain broken. */
const LINEAGE_WALK_CAP = 32;

/**
 * Escalations per escalated lineage: every dispatch that names an attempt it
 * replaces is one escalation, charged to the root of its chain. The mean is
 * over lineages that were escalated at all - a fleet where nothing escalated
 * has no rate, not a rate of zero - and it is bounded above by the policy's
 * `maxEscalations`, so a number above that is itself a finding.
 */
export function escalationLineages(
  dispatches: ObservedDispatch[],
): { root: string; escalations: number }[] {
  const parent = new Map<string, string>();
  for (const dispatch of dispatches) {
    if (dispatch.escalatedFrom) parent.set(dispatch.taskId, dispatch.escalatedFrom);
  }
  const counts = new Map<string, number>();
  for (const dispatch of dispatches) {
    if (!dispatch.escalatedFrom) continue;
    let root = dispatch.escalatedFrom;
    for (let step = 0; step < LINEAGE_WALK_CAP; step += 1) {
      const next = parent.get(root);
      if (!next || next === root) break;
      root = next;
    }
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([root, escalations]) => ({ root, escalations }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

export type RoutingScores = Pick<
  MetricScores,
  | "tier_share_premium"
  | "tier_share_high"
  | "tier_share_medium"
  | "tier_share_low"
  | "kind_classified_share"
  | "kind_abstained_share"
  | "kind_failed_share"
  | "kind_skipped_share"
  | "tier_downgrade_rate"
  | "escalations_per_lineage"
>;

const TIER_RANK: Record<Tier, number> = { premium: 3, high: 2, medium: 1, low: 0 };

function rankOf(tier: string | null): number | null {
  return tier && tier in TIER_RANK ? (TIER_RANK[tier as Tier] as number) : null;
}

/**
 * The routing half of the score, computed from dispatch records alone so the
 * replay and an offline corpus export read the same numbers the same way.
 * Each share is over the dispatches that could answer it: a row routed
 * before the shape existed has no tier and is not counted against one.
 */
export function scoreRouting(dispatches: ObservedDispatch[]): RoutingScores {
  const tiered = dispatches.filter((dispatch) => rankOf(dispatch.tier) !== null);
  const shareOfTier = (tier: Tier): MetricValue =>
    ratio(tiered.filter((dispatch) => dispatch.tier === tier).length, tiered.length);
  const shareOfSource = (name: KindSourceClass): MetricValue =>
    ratio(
      dispatches.filter((dispatch) => kindSourceClass(dispatch.kindSource) === name).length,
      dispatches.length,
    );
  // Only a dispatch whose serving was actually decided can be downgraded:
  // with no catalog to route against, there is nothing to measure, which is
  // null rather than a clean bill of health.
  const served = dispatches.filter(
    (dispatch) => rankOf(dispatch.served) !== null && rankOf(dispatch.tier) !== null,
  );
  const lineages = escalationLineages(dispatches);
  const escalations = lineages.reduce((sum, lineage) => sum + lineage.escalations, 0);
  return {
    tier_share_premium: shareOfTier("premium"),
    tier_share_high: shareOfTier("high"),
    tier_share_medium: shareOfTier("medium"),
    tier_share_low: shareOfTier("low"),
    kind_classified_share: shareOfSource("classified"),
    kind_abstained_share: shareOfSource("abstained"),
    kind_failed_share: shareOfSource("failed"),
    kind_skipped_share: shareOfSource("skipped"),
    tier_downgrade_rate: ratio(
      served.filter(
        (dispatch) => (rankOf(dispatch.served) as number) < (rankOf(dispatch.tier) as number),
      ).length,
      served.length,
    ),
    escalations_per_lineage: ratio(escalations, lineages.length),
  };
}

// --------------------------------------------------------------------------
// Delivery rigor observability (delivery rigor phase 4)
// --------------------------------------------------------------------------

/**
 * The three delivery tiers and the reviewer's closed vocabularies, spelled
 * here for the same reason `TIERS` is: this module is deliberately
 * dependency-free, and the thing that grades the rigor system should not
 * import the thing that runs it. `tests/interaction-metrics.test.ts` fails
 * if either list drifts from `src/shared/rigor.ts`.
 */
/**
 * Whether a card's declared actions make it a COMPLETION card: one carrying
 * the `settle merge` effect, which is the card the evidence contract is
 * linted at (cards/tasks/agents P1). Read off the declared effect, the way
 * the host itself dispatches - never off an action id, and never off a
 * label. A card recorded before effects existed carries none and is not one:
 * it also predates the contract this counts compliance with.
 */
export function isCompletionCard(actionsJson: string | null | undefined): boolean {
  if (!actionsJson) return false;
  let actions: unknown;
  try {
    actions = JSON.parse(actionsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    const effect = (action as { effect?: { kind?: unknown; mode?: unknown } } | null)?.effect;
    // INF-2744's one merge effect, or a record saved before it.
    return effect?.kind === "merge" || (effect?.kind === "settle" && effect.mode === "merge");
  });
}

export const RIGORS = ["quick", "standard", "reviewed"] as const;
export type RigorTier = (typeof RIGORS)[number];

export const REVIEW_VERDICTS = ["pass", "findings", "blocked"] as const;
export type ReviewVerdictName = (typeof REVIEW_VERDICTS)[number];

/**
 * What a reviewer asks be DONE about a finding, per its brief: `auto-fix`
 * for an objective defect the builder can just fix, `ask-user` for anything
 * touching intent or product behavior, `no-op` for a note. The share that
 * is ask-user is the one number that says whether review is buying the
 * captain's attention or spending it.
 */
export const FINDING_ACTIONS = ["auto-fix", "ask-user", "no-op"] as const;
export type FindingAction = (typeof FINDING_ACTIONS)[number];

export type FindingCounts = Record<FindingAction, number>;

const FINDING_PATTERNS: readonly (readonly [FindingAction, RegExp])[] = [
  ["auto-fix", /\bauto[\s._-]?fix\b/i],
  ["ask-user", /\bask[\s._-]?user\b/i],
  ["no-op", /\bno[\s._-]?op\b/i],
];

/**
 * The findings in a reviewer's report, by the action each asks for. The
 * brief asks for one finding per line ending in its action, so a line is
 * the unit and the first action named on it is its own - a line that names
 * two is still one finding, and the verdict and risk lines the host already
 * reads are never findings. A report that is not on the record is null, not
 * an empty count: a review whose text was never kept found nothing we know
 * of, which is not the same as finding nothing.
 */
export function findingActions(report: string | null | undefined): FindingCounts | null {
  if (!report) return null;
  const counts: FindingCounts = { "auto-fix": 0, "ask-user": 0, "no-op": 0 };
  for (const raw of report.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^verdict:/i.test(line) || /^risk:/i.test(line)) continue;
    const match = FINDING_PATTERNS.find(([, pattern]) => pattern.test(line));
    if (match) counts[match[0]] += 1;
  }
  return counts;
}

/**
 * One verdict a reviewer returned, as the builder's own timeline holds it
 * (a `review` event, delivery rigor phase 2). One row per verdict, so a
 * change reviewed twice has two: the rounds it cost are the rows, and the
 * verdict mix is over them.
 */
export type ObservedReview = {
  /** The builder whose change was reviewed - the change, not the review. */
  taskId: string;
  /** The review task that returned it; null on a record that kept none. */
  reviewTaskId: string | null;
  verdict: string;
  risk: string | null;
  /** The findings that verdict carried, or null when its report is not on record. */
  findings: FindingCounts | null;
};

/** A `review` timeline event, normalized by whoever read the record. */
export type ReviewEvent = {
  taskId: string;
  at: number;
  verdict: string | null;
  risk: string | null;
  reviewTaskId: string | null;
};

/**
 * One `review` timeline row read off its stored `data_json` - the delivery
 * patch the host wrote with it. Here rather than in each reader, so the
 * replay and the offline export agree on what a review event says; an
 * unreadable or absent payload states nothing, and the row is dropped
 * downstream rather than guessed at.
 */
export function reviewEventFrom(taskId: string, at: number, dataJson: string | null): ReviewEvent {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(dataJson ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return {
    taskId,
    at,
    verdict: typeof data.reviewVerdict === "string" ? data.reviewVerdict : null,
    risk: typeof data.reviewRisk === "string" ? data.reviewRisk : null,
    reviewTaskId: typeof data.reviewTaskId === "string" ? data.reviewTaskId : null,
  };
}

/**
 * The review rows, from the events plus whatever report text the record
 * still holds. A review task keeps ONE report - its latest - so only the
 * newest verdict it returned can be credited with findings; an earlier
 * round's text is gone and its findings are honestly unknown. Events with
 * no verdict on them are not reviews and are dropped rather than guessed.
 */
export function observedReviews(
  events: ReviewEvent[],
  reports: Map<string, string | null>,
): ObservedReview[] {
  const newest = new Map<string, number>();
  for (const event of events) {
    if (!event.verdict || !event.reviewTaskId) continue;
    const at = newest.get(event.reviewTaskId);
    if (at === undefined || event.at >= at) newest.set(event.reviewTaskId, event.at);
  }
  const rows: ObservedReview[] = [];
  for (const event of events) {
    if (!event.verdict) continue;
    const latest =
      event.reviewTaskId !== null && newest.get(event.reviewTaskId) === event.at
        ? (reports.get(event.reviewTaskId) ?? null)
        : null;
    rows.push({
      taskId: event.taskId,
      reviewTaskId: event.reviewTaskId,
      verdict: event.verdict,
      risk: event.risk,
      findings: findingActions(latest),
    });
  }
  return rows;
}

export type RigorScores = Pick<
  MetricScores,
  | "deliverable_share_answer"
  | "rigor_share_quick"
  | "rigor_share_standard"
  | "rigor_share_reviewed"
  | "evidence_headings_share"
  | "review_rounds_per_change"
  | "findings_auto_fix_per_change"
  | "findings_ask_user_per_change"
  | "findings_no_op_per_change"
  | "findings_ask_user_rate"
  | "review_verdict_share_pass"
  | "review_verdict_share_findings"
  | "review_verdict_share_blocked"
  | "ci_rounds_per_change"
  | "rigor_cap_hits"
  | "hold_overrides"
>;

/**
 * The rigor half of the score, computed from the same dispatch records the
 * routing half reads plus the verdicts the reviewers returned - so the
 * replay gate and the offline corpus export cannot disagree about how
 * carefully the fleet ships.
 *
 * Every denominator is the population that could answer its question: the
 * evidence share is over changes whose tier asks for evidence AND settled
 * with a completion card; the CI rounds are over direct-pr changes with a
 * pull request; the findings are over changes whose review text is still on
 * the record. A fleet that reviewed nothing has no review numbers at all,
 * which is n/a - never a clean zero.
 */
export function scoreRigor(
  dispatches: ObservedDispatch[],
  reviews: ObservedReview[],
): RigorScores {
  // An answer task ships nothing (Task B), so it answers none of the rigor
  // questions: it is out of every denominator below, and reported on its
  // own observational row instead.
  const changes = dispatches.filter((dispatch) => dispatch.deliverable !== "answer");
  const shipped = changes.filter((dispatch) => dispatch.rigor !== null);
  const shareOfRigor = (rigor: RigorTier): MetricValue =>
    ratio(shipped.filter((dispatch) => dispatch.rigor === rigor).length, shipped.length);
  const evidenced = changes.filter((dispatch) => dispatch.evidence !== null);
  const reviewed = new Set(reviews.map((review) => review.taskId));
  const counted = reviews.filter((review) => review.findings !== null);
  const countedChanges = new Set(counted.map((review) => review.taskId));
  const findings = (action: FindingAction): number =>
    counted.reduce((sum, review) => sum + ((review.findings as FindingCounts)[action] ?? 0), 0);
  const perChange = (action: FindingAction): MetricValue =>
    ratio(findings(action), countedChanges.size);
  const allFindings = FINDING_ACTIONS.reduce((sum, action) => sum + findings(action), 0);
  const shareOfVerdict = (verdict: ReviewVerdictName): MetricValue =>
    ratio(reviews.filter((review) => review.verdict === verdict).length, reviews.length);
  const ciChanges = changes.filter(
    (dispatch) => dispatch.delivery === "direct-pr" && dispatch.hasPr,
  );
  return {
    deliverable_share_answer: ratio(
      dispatches.filter((dispatch) => dispatch.deliverable === "answer").length,
      dispatches.length,
    ),
    rigor_share_quick: shareOfRigor("quick"),
    rigor_share_standard: shareOfRigor("standard"),
    rigor_share_reviewed: shareOfRigor("reviewed"),
    evidence_headings_share: ratio(
      evidenced.filter((dispatch) => dispatch.evidence === true).length,
      evidenced.length,
    ),
      review_rounds_per_change: ratio(reviews.length, reviewed.size),
    findings_auto_fix_per_change: perChange("auto-fix"),
    findings_ask_user_per_change: perChange("ask-user"),
    findings_no_op_per_change: perChange("no-op"),
    findings_ask_user_rate: ratio(findings("ask-user"), allFindings),
    review_verdict_share_pass: shareOfVerdict("pass"),
    review_verdict_share_findings: shareOfVerdict("findings"),
    review_verdict_share_blocked: shareOfVerdict("blocked"),
    ci_rounds_per_change: ratio(
      ciChanges.reduce((sum, dispatch) => sum + (dispatch.ciRounds ?? 0), 0),
      ciChanges.length,
    ),
    rigor_cap_hits: count(changes.reduce((sum, dispatch) => sum + dispatch.capHits, 0)),
    hold_overrides: count(dispatches.reduce((sum, dispatch) => sum + dispatch.overrides.length, 0)),
  };
}

/**
 * The soft holds an override row named, read off the `note` event's stored
 * `data_json`: the delivery patch `update_task override` wrote with it
 * carries the typed `HoldOverride` (src/shared/holds.ts). Null for any other
 * note, a taking-back included, so the replay and the offline export agree
 * on what an override is.
 */
export function overrideHoldsFrom(dataJson: string | null): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse(dataJson ?? "null");
  } catch {
    return null;
  }
  const holds = (data as { override?: { holds?: unknown } } | null)?.override?.holds;
  if (!Array.isArray(holds) || holds.length === 0) return null;
  return holds.filter((hold): hold is string => typeof hold === "string");
}

/**
 * How many overrides named each hold kind (INF-484 move 8): the count per
 * kind the weekly audit reads as the sign that a hold is a verdict. One
 * override naming two holds counts once for each.
 */
export function overridesByHold(dispatches: readonly ObservedDispatch[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dispatch of dispatches)
    for (const override of dispatch.overrides)
      for (const hold of override) counts[hold] = (counts[hold] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// --------------------------------------------------------------------------
// Scoring one session
// --------------------------------------------------------------------------

export type ObservedCard = PairableCard & {
  author: "firstmate" | "crewmate" | "host";
  /** The rendered card body contains a table, svg, figure, or canvas. */
  visual: boolean;
  resolvedAt: number | null;
  /** `withdrawn` is the emitter's own close_card, never captain contact. */
  resolution: "open" | "acted" | "dismissed" | "withdrawn";
  /** The captain's durable stamp (WI-14), when the table carries one. */
  duplicateOf: string | null;
  /** A decision action flagged as the default the agent would take. */
  hasDefault: boolean;
  /** A merge/land-looking action with no settle effect (`isFakeSettleAction`). */
  fakeSettle: boolean;
  /**
   * The hand-scored plain-language label (roadmap 1.5): true when the
   * card's visible words follow the vocabulary, false when a sentence leans
   * on a never-say word, null when no one has read this card - out of the
   * denominator, never a negative.
   */
  plain: boolean | null;
  /**
   * The hand-scored sentence-habit label (contract 4.58): true when the
   * card's open prose follows the five habits, false when one is broken,
   * null when no one has read this card for them - out of the denominator.
   */
  clear: boolean | null;
  /**
   * The hand-scored pull request link label (FI3-1307): true when every
   * pull request the body names links to its page, false when one is text,
   * null when the body names none or no one has read it - out of the
   * denominator.
   */
  prLinks: boolean | null;
  /**
   * The hand-scored project-term label (INF-2326): null when the open prose
   * uses no term the project coined or no one has read it - out of the
   * denominator.
   */
  terms: boolean | null;
  /** The hand-scored change-effect label (INF-2326): null on a card about no change. */
  affects: boolean | null;
  /** The hand-scored section-question label (INF-2715): null unless a decision spans several sections. */
  sections: boolean | null;
  /** The hand-scored task-verb label (INF-2715): null on a card that files, queues or starts no task. */
  taskWords: boolean | null;
};

export type ObservedQuestion = CaptainQuestion & {
  /** The Firstmate showed a card of its own in that turn and spawned nothing. */
  answeredInTurn: boolean;
  /** Ids of the Firstmate cards that turn showed. */
  answerCardIds: string[];
};

export type SessionObservation = {
  captainTurns: number;
  questions: ObservedQuestion[];
  cards: ObservedCard[];
  opWakes: number;
  guidanceQueuedWakes: number;
  /** One entry per escalation the Firstmate received. */
  /**
   * `scored` is false for an escalation the recording has no answer for:
   * whether the Firstmate would have acted is unknown, not a failure, so it
   * counts in `escalations` and stays out of the precision denominator -
   * the same rule the rigor rows keep (a denominator is the population that
   * could answer its question).
   */
  escalations: { handled: boolean; scored?: boolean }[];
  wakesAfterCancel: number;
  lockRefusals: number;
  /** Messages the answer-delivery check judged uncovered (observe mode); absent counts none. */
  asksWithoutAction?: number;
  closedTasks: {
    status: "delivered" | "done" | "dropped";
    worktreePresent: boolean;
    deliveredWithoutEvidence: boolean;
  }[];
  implausibleOutcomes: number;
  spawnStartFailures: number;
  /** Every piece of work the session commissioned, as the record holds it (S5). */
  dispatches: ObservedDispatch[];
  /** Every verdict a reviewer returned on that work (delivery rigor phase 4). */
  reviews: ObservedReview[];
  /**
   * Every labelled captain choice the recording answered (the plan-to-build
   * handoff); absent where nothing labels the session's choices.
   */
  approvals?: ObservedApproval[];
};

/**
 * One labelled captain choice and the Firstmate turn that answered it:
 * `builds` is the label, `groundedStarts` how many builders grounded on the
 * choice's plan that turn started. A choice the recording never answered is
 * not observed at all - what the Firstmate would have done is unknown.
 */
export type ObservedApproval = { builds: boolean; groundedStarts: number };

/**
 * A build approval is honoured by exactly one grounded start - none is the
 * plan left on request, two a duplicate builder - and any other labelled
 * choice by none.
 */
export function scoreApprovals(approvals: ObservedApproval[]): MetricValue {
  const honoured = approvals.filter((row) => row.groundedStarts === (row.builds ? 1 : 0));
  return ratio(honoured.length, approvals.length);
}

export type MetricValue = {
  value: number | null;
  numerator?: number;
  denominator?: number;
};

export type MetricScores = Record<MetricId, MetricValue>;

function ratio(numerator: number, denominator: number): MetricValue {
  return { value: denominator === 0 ? null : numerator / denominator, numerator, denominator };
}

function count(value: number): MetricValue {
  return { value };
}

export function scoreSession(observation: SessionObservation): MetricScores {
  const questions = observation.questions;
  const cardsById = new Map(observation.cards.map((card) => [card.id, card]));
  const answerCards = questions.flatMap((question) =>
    question.answerCardIds.flatMap((id) => {
      const card = cardsById.get(id);
      return card ? [card] : [];
    }),
  );
  const firstmateCards = observation.cards.filter((card) => card.author === "firstmate");
  const quickDismissed = firstmateCards.filter(
    (card) =>
      card.resolution === "dismissed" &&
      card.resolvedAt !== null &&
      card.resolvedAt - card.createdAt <= QUICK_DISMISS_MS,
  );
  // Host chrome (task-result cards, sign-in and error cards) is the app's own
  // copy, not an agent's answer: it neither duplicates nor explains.
  const authored = observation.cards.filter((card) => card.author !== "host");
  const overlap = duplicatePairs(authored);
  const pairKeys = new Set(overlap.map((pair) => `${pair.first}|${pair.second}`));
  let stamped = 0;
  for (const card of observation.cards) {
    if (!card.duplicateOf || !cardsById.has(card.duplicateOf)) continue;
    if (pairKeys.has(`${card.duplicateOf}|${card.id}`)) continue;
    stamped += 1;
  }
  const visualPool = authored;
  const bodyChars = visualPool.map((card) => card.body.length);
  const openWords = visualPool.map((card) => cardOpenWords(card.body));
  return {
    questions_answered_in_turn: ratio(
      questions.filter((question) => question.answeredInTurn).length,
      questions.length,
    ),
    answer_cards_with_default: ratio(
      answerCards.filter((card) => card.hasDefault).length,
      answerCards.length,
    ),
    captain_reasks_10min: count(countReasks(questions)),
    firstmate_cards_dismissed_60s: ratio(quickDismissed.length, firstmateCards.length),
    duplicate_card_pairs: count(overlap.length + stamped),
    op_wakes_per_captain_turn: ratio(observation.opWakes, observation.captainTurns),
    escalation_precision: (() => {
      const scored = observation.escalations.filter((escalation) => escalation.scored !== false);
      return ratio(scored.filter((escalation) => escalation.handled).length, scored.length);
    })(),
    lock_refusals: count(observation.lockRefusals),
    asks_without_action: count(observation.asksWithoutAction ?? 0),
    closed_rows_with_worktree: count(
      observation.closedTasks.filter((task) => task.status !== "delivered" && task.worktreePresent)
        .length,
    ),
    closed_without_evidence: count(
      observation.closedTasks.filter((task) => task.deliveredWithoutEvidence).length,
    ),
    visual_card_share: ratio(visualPool.filter((card) => card.visual).length, visualPool.length),
    plain_language_share: (() => {
      const read = observation.cards.filter((card) => card.plain !== null);
      return ratio(read.filter((card) => card.plain === true).length, read.length);
    })(),
    clear_copy_share: (() => {
      const read = observation.cards.filter((card) => card.clear !== null);
      return ratio(read.filter((card) => card.clear === true).length, read.length);
    })(),
    pr_link_share: (() => {
      const read = observation.cards.filter((card) => card.prLinks !== null);
      return ratio(read.filter((card) => card.prLinks === true).length, read.length);
    })(),
    term_explained_share: (() => {
      const read = observation.cards.filter((card) => card.terms !== null);
      return ratio(read.filter((card) => card.terms === true).length, read.length);
    })(),
    change_effect_share: (() => {
      const read = observation.cards.filter((card) => card.affects !== null);
      return ratio(read.filter((card) => card.affects === true).length, read.length);
    })(),
    section_question_share: (() => {
      const read = observation.cards.filter((card) => card.sections !== null);
      return ratio(read.filter((card) => card.sections === true).length, read.length);
    })(),
    task_verb_share: (() => {
      const read = observation.cards.filter((card) => card.taskWords !== null);
      return ratio(read.filter((card) => card.taskWords === true).length, read.length);
    })(),
    mean_card_body_chars: {
      value:
        bodyChars.length === 0
          ? null
          : Math.round(bodyChars.reduce((sum, chars) => sum + chars, 0) / bodyChars.length),
    },
    mean_card_open_words: {
      value:
        openWords.length === 0
          ? null
          : Math.round(openWords.reduce((sum, words) => sum + words, 0) / openWords.length),
    },
    escalations: count(observation.escalations.length),
    wakes_after_cancel: count(observation.wakesAfterCancel),
    guidance_queued_wakes: count(observation.guidanceQueuedWakes),
    fake_merge_buttons: count(observation.cards.filter((card) => card.fakeSettle).length),
    implausible_outcomes: count(observation.implausibleOutcomes),
    spawn_start_failures: count(observation.spawnStartFailures),
    approval_handoff_share: scoreApprovals(observation.approvals ?? []),
    ...scoreRouting(observation.dispatches),
    ...scorePlanSkips(observation.dispatches, observation.reviews),
    ...scoreRigor(observation.dispatches, observation.reviews),
  };
}

/**
 * The words a card shows before the reader opens anything (INF-3749): an
 * expand counts only its summary, and a drawing, script or style counts
 * nothing, since its labels belong to the picture.
 */
export function cardOpenWords(body: string): number {
  const text = body
    .replace(/<(script|style|svg|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi, (_whole, inner: string) => {
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(inner);
      return ` ${summary?.[1] ?? ""} `;
    })
    .replace(/<[^>]*>/g, " ")
    .replace(/&[#a-z0-9]+;/gi, " ");
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** A declaration is counted, never inferred; historical changes stay in the denominator. */
export function scorePlanSkips(dispatches: ObservedDispatch[], reviews: ObservedReview[]) {
  const known = dispatches.filter((row) => row.deliverable !== "answer");
  const unplanned = new Set(known.filter((row) => row.skippedPlanBecause).map((row) => row.taskId));
  const readable = reviews.filter((row) => unplanned.has(row.taskId) && row.findings !== null);
  const reviewed = new Set(readable.map((row) => row.taskId));
  return {
    unplanned_change_share: ratio(unplanned.size, known.length),
    late_decisions_per_unplanned_change: ratio(
      readable.reduce((sum, row) => sum + (row.findings?.["ask-user"] ?? 0), 0), reviewed.size,
    ),
  };
}

// --------------------------------------------------------------------------
// Targets and the regression gate
// --------------------------------------------------------------------------

export function meetsTarget(id: MetricId, value: number | null): boolean | null {
  const target = metricDef(id).target;
  if (!target || value === null) return null;
  switch (target.op) {
    case "<":
      return value < target.value;
    case "<=":
      return value <= target.value;
    case "=":
      return Math.abs(value - target.value) < 1e-9;
    case ">=":
      return value >= target.value;
    case ">":
      return value > target.value;
  }
}

export type Regression = {
  session: string;
  metric: MetricId;
  baseline: number | null;
  current: number | null;
  reason: string;
};

/** Per fixture session: metric id -> committed value. */
export type BaselineScores = Record<string, Partial<Record<MetricId, number | null>>>;

const EPSILON = 1e-9;

/**
 * Every metric the baseline names must not move in its bad direction, and a
 * measurable metric may not become unmeasurable. Improvements pass; the PR
 * that lands one updates the baseline and says why. Observational rows
 * (`direction: "either"`, S5) are recorded but never graded.
 */
export function compareToBaseline(
  current: Record<string, MetricScores>,
  baseline: BaselineScores,
): Regression[] {
  const regressions: Regression[] = [];
  for (const [session, expected] of Object.entries(baseline)) {
    const scores = current[session];
    if (!scores) {
      regressions.push({
        session,
        metric: METRIC_IDS[0] as MetricId,
        baseline: null,
        current: null,
        reason: `the baseline names session "${session}" but the replay produced no report for it`,
      });
      continue;
    }
    for (const id of METRIC_IDS) {
      if (!(id in expected)) continue;
      // An observational row (S5) is recorded in the baseline so every
      // change shows up in the diff, and graded by nobody: a tier mix has
      // no bad direction to move in.
      if (metricDef(id).direction === "either") continue;
      const was = expected[id] ?? null;
      // The baseline file stores rounded values; compare like with like.
      const now = roundValue(scores[id]?.value ?? null);
      if (was === null) continue;
      if (now === null) {
        regressions.push({
          session,
          metric: id,
          baseline: was,
          current: null,
          reason: "was measurable, now has nothing to measure",
        });
        continue;
      }
      const worse = metricDef(id).direction === "lower" ? now > was + EPSILON : now < was - EPSILON;
      if (worse) {
        regressions.push({
          session,
          metric: id,
          baseline: was,
          current: now,
          reason: `${metricDef(id).direction === "lower" ? "rose" : "fell"} from ${formatValue(was)} to ${formatValue(now)}`,
        });
      }
    }
  }
  return regressions;
}

/** The baseline file's shape for one run: every metric's value, per session. */
export function baselineFrom(current: Record<string, MetricScores>): BaselineScores {
  const out: BaselineScores = {};
  for (const session of Object.keys(current).sort()) {
    const scores = current[session] as MetricScores;
    const row: Partial<Record<MetricId, number | null>> = {};
    for (const id of METRIC_IDS) row[id] = roundValue(scores[id].value);
    out[session] = row;
  }
  return out;
}

function roundValue(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

export function formatValue(value: number | null): string {
  if (value === null) return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
