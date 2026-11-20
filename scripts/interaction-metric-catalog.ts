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
