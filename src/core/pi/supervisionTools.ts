import { Type } from "typebox";
import { boundTool } from "../session/tools";
import type { DuplicateResult } from "../storage/cardStore";
import type { MissedEscalationResult, SupervisionOutcome } from "../storage/decisionStore";

/**
 * The Firstmate's three tools over the fleet's own record: the outcome log
 * (`supervision_log`), the captain's duplicate stamp (`flag_duplicate`) and
 * the captain's confirmed missed escalation (`flag_missed_escalation`).
 * The file is named for the store they read; since S7c retired the
 * supervision session there is no second persona holding tools here.
 */

/**
 * The Firstmate agent's query side of the outcome store - the
 * fm_branch_outcomes equivalent: what the fleet did while the captain was
 * not looking, on demand, never as a turn.
 */
export function createSupervisionLogTool(recent: (limit: number) => SupervisionOutcome[]) {
  return boundTool({
    name: "supervision_log",
    label: "Fleet outcome log",
    description:
      "Read triaged routine fleet events: task, verdict and summary, newest first. Use when asked what happened in the fleet.",
    parameters: Type.Object({
      recent: Type.Optional(
        Type.Number({ description: "How many most-recent outcomes to read (default 20)" }),
      ),
    }),
    run: async (params) => {
      const limit =
        typeof params.recent === "number" && params.recent >= 1 ? Math.floor(params.recent) : 20;
      const rows = recent(limit);
      const text =
        rows.length > 0
          ? rows
              .map(
                (row) =>
                  `#${row.id} [${row.verdict}] task ${row.taskId} at ${new Date(row.at).toISOString()}: ${row.summary}${
                    row.missedEscalation ? " (flagged as a missed escalation)" : ""
                  }`,
              )
              .join("\n")
          : "(no fleet outcomes recorded)";
      return { text };
    },
  });
}

export type DuplicateDelegate = {
  /** Store-first labelling plus the host close; every refusal comes back as a value. */
  flag(input: { cardId: string; duplicateOf: string; note: string }): DuplicateResult;
  /** True only on a wake that carries the captain's own words. */
  isCaptainTurn(): boolean;
};

function duplicateText(result: DuplicateResult): string {
  switch (result.status) {
    case "flagged":
      return `Recorded card ${result.card.id} as a duplicate of ${result.original.id}${
        result.card.resolved ? "" : " and closed it"
      }.`;
    case "same-card":
      return `A card cannot duplicate itself (${result.cardId}). Name the earlier card it repeats. Nothing was recorded.`;
    case "no-card":
      return `No card ${result.cardId} exists. Use a card id from the context block's open cards or the on-screen hint. Nothing was recorded.`;
    case "no-original":
      return `No card ${result.cardId} exists to be the original. Use the id of the earlier card this one repeats. Nothing was recorded.`;
    case "already-flagged":
      return `Card ${result.card.id} is already flagged as a duplicate of ${result.duplicateOf}: "${result.note}". Left unchanged.`;
  }
}

/**
 * The confirmed duplicate label (interaction P1 WI-14), modeled on
 * flag_missed_escalation: the one path from the captain's "this is the same
 * as the card before it" to a durable label the duplicate metric reads. No
 * card, no setting, no user surface; the host closes the duplicate, the
 * feed says so, and a crewmate's card's author hears it (INF-759). Captain-turn only, by code: the label's value is that the
 * captain confirmed it.
 */
export function createFlagDuplicateTool(delegate: DuplicateDelegate) {
  return boundTool({
    name: "flag_duplicate",
    label: "Flag duplicate card",
    description: [
      "Record and close a repeated card. Only when the user says it is a duplicate,",
      "pass the duplicate's card id and the id of the earlier card it repeats from context or the on-screen hint.",
      "Never call on your own or to tidy the stack - use close_card. It labels and closes without a card,",
      "and tells a crewmate card's author.",
    ].join(" "),
    parameters: Type.Object({
      // The description names both ids (the duplicate's card id and the earlier card it repeats).
      card_id: Type.String(),
      duplicate_of: Type.String(),
      note: Type.String({ description: "The user's words on why it is a duplicate" }),
    }),
    run: async (params) => {
      const refuse = (text: string) => ({ text });
      if (!delegate.isCaptainTurn()) {
        return refuse(
          "Refused: a duplicate is only recorded from the user's own words in a conversation turn. Nothing was recorded.",
        );
      }
      const note = params.note.trim();
      if (note.length === 0) {
        return refuse("Refused: note must carry the user's words. Nothing was recorded.");
      }
      const result = delegate.flag({
        cardId: params.card_id.trim(),
        duplicateOf: params.duplicate_of.trim(),
        note,
      });
      return { text: duplicateText(result) };
    },
  });
}

export type MissedEscalationDelegate = {
  /** Store-first labelling; every refusal comes back as a value. */
  flag(input: { taskId: string; note: string; outcomeId?: number }): MissedEscalationResult;
  /** True only on a wake that carries the captain's own words. */
  isCaptainTurn(): boolean;
};

function missedEscalationText(result: MissedEscalationResult): string {
  switch (result.status) {
    case "flagged":
      return `Recorded a confirmed missed escalation on outcome #${result.outcome.id} (task ${result.outcome.taskId}).`;
    case "no-outcome":
      return `No routine fleet outcome is recorded for task ${result.taskId}, so there is nothing that failed to reach the captain. Check supervision_log for the task id.`;
    case "other-task":
      return `Outcome #${result.outcome.id} belongs to task ${result.outcome.taskId}, not the task you named. Nothing was recorded.`;
    case "not-routine":
      return `Outcome #${result.outcome.id} was already escalated to the captain (verdict ${result.outcome.verdict}), so it is not a missed escalation. Nothing was recorded.`;
    case "already-flagged":
      return `Outcome #${result.outcome.id} is already flagged as a missed escalation: "${result.outcome.missedNote ?? ""}". Left unchanged.`;
  }
}

/**
 * The confirmed missed-escalation label (PoC-2 C3). Under-escalation is
 * structurally unobservable in production - a routine verdict is one feed
 * line and no captain contact - so this tool is the one path by which
 * "you should have told me about that" becomes a durable label. It is
 * internal machinery: no card, no setting, no user-facing surface, and
 * nothing leaves the box.
 *
 * Captain-turn only, by code: the label's whole value is that it is the
 * captain's own confirmation, so the agent cannot manufacture one on a
 * scheduled, supervision, or crewmate-report wake.
 */
export function createFlagMissedEscalationTool(delegate: MissedEscalationDelegate) {
  return boundTool({
    name: "flag_missed_escalation",
    label: "Flag missed escalation",
    description: [
      "Record a routine fleet event that should have reached the user. Only when they say it",
      "was missed AND supervision_log confirms routine handling; never on a hunch or for an event",
      "that reached them. It only labels: no card, message or task change.",
    ].join(" "),
    parameters: Type.Object({
      task_id: Type.String({ description: "The task whose routine outcome was the miss" }),
      what_was_missed: Type.String({
        description: "In the user's own terms, what should have been raised and why",
      }),
      outcome_id: Type.Optional(
        Type.Number({
          description:
            "The supervision_log outcome id (#N) when a specific one is meant; " +
            "otherwise the task's most recent routine outcome is labelled",
        }),
      ),
    }),
    run: async (params) => {
      if (!delegate.isCaptainTurn()) {
        return {
          text: "Refused: a missed escalation is only recorded from the user's own words in a conversation turn. Nothing was recorded.",
        };
      }
      const note = params.what_was_missed.trim();
      if (note.length === 0) {
        return {
          text: "Refused: what_was_missed must say what should have been raised. Nothing was recorded.",
        };
      }
      const outcomeId =
        typeof params.outcome_id === "number" && Number.isFinite(params.outcome_id)
          ? Math.floor(params.outcome_id)
          : undefined;
      const result = delegate.flag({
        taskId: params.task_id.trim(),
        note,
        ...(outcomeId !== undefined ? { outcomeId } : {}),
      });
      return { text: missedEscalationText(result) };
    },
  });
}
