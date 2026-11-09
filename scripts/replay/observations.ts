/**
 * What a replay's report observes (`./engine.ts`): its cards with their
 * hand labels, the work it commissioned and the reviews that ran, read
 * off the replay's own record once it has played.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppDatabase } from "../../src/core/storage/db.ts";
import type { DecisionStore } from "../../src/core/storage/decisionStore.ts";
import type { TaskRecord } from "../../src/core/storage/taskRecords.ts";
import {
  carriesEvidenceHeadings,
  reportEvidenceHeadings,
  type Rigor,
  rigorRequiresEvidence,
} from "../../src/shared/rigor.ts";
import {
  cardLabelKey,
  isCompletionCard,
  isFakeSettleAction,
  type ObservedCard,
  type ObservedDispatch,
  type ObservedReview,
  observedReviews,
  overrideHoldsFrom,
  parseClearLabels,
  parseEffectLabels,
  parsePlainLabels,
  parsePrLinkLabels,
  parseSectionLabels,
  parseTaskWordLabels,
  parseTermLabels,
  type ReviewEvent,
  reviewEventFrom,
} from "../interaction-metrics.ts";
import { numberColumn, stringColumn, type TableRow } from "../recorded-tables.ts";
import type { JsonRecord } from "./recording.ts";

/** The replay's cards as the metrics read them, with the hand labels read once per report. */
export class CardObserver {
  private plainLabelMap: Map<string, boolean> | null = null;
  private clearLabelMap: Map<string, boolean> | null = null;
  private prLinkLabelMap: Map<string, boolean> | null = null;
  private termLabelMap: Map<string, boolean> | null = null;
  private effectLabelMap: Map<string, boolean> | null = null;
  private sectionLabelMap: Map<string, boolean> | null = null;
  private taskWordLabelMap: Map<string, boolean> | null = null;

  /** The hand labels, read once per engine; an unreadable file is a loud failure, never an empty sample. */
  private plainLabels(): Map<string, boolean> {
    if (this.plainLabelMap) return this.plainLabelMap;
    const file = this.labelsFile;
    const text = file ? readFileSync(file, "utf8") : null;
    this.plainLabelMap = text === null ? new Map() : parsePlainLabels(text);
    this.clearLabelMap = text === null ? new Map() : parseClearLabels(text);
    this.prLinkLabelMap = text === null ? new Map() : parsePrLinkLabels(text);
    this.termLabelMap = text === null ? new Map() : parseTermLabels(text);
    this.effectLabelMap = text === null ? new Map() : parseEffectLabels(text);
    this.sectionLabelMap = text === null ? new Map() : parseSectionLabels(text);
    this.taskWordLabelMap = text === null ? new Map() : parseTaskWordLabels(text);
    return this.plainLabelMap;
  }

  /** The sentence-habit labels: the second reading filed in the same rows. */
  private clearLabels(): Map<string, boolean> {
    this.plainLabels();
    return this.clearLabelMap ?? new Map();
  }

  /** The pull request link labels: the third reading, on the rows whose body names one. */
  private prLinkLabels(): Map<string, boolean> {
    this.plainLabels();
    return this.prLinkLabelMap ?? new Map();
  }

  /** The project-term and change-effect labels: the fourth and fifth readings. */
  private wordLabels(): { terms: Map<string, boolean>; affects: Map<string, boolean> } {
    this.plainLabels();
    return { terms: this.termLabelMap ?? new Map(), affects: this.effectLabelMap ?? new Map() };
  }

  /** The section-question and task-verb labels: the sixth and seventh readings (INF-2715). */
  private decisionLabels(): { sections: Map<string, boolean>; taskWords: Map<string, boolean> } {
    this.plainLabels();
    return {
      sections: this.sectionLabelMap ?? new Map(),
      taskWords: this.taskWordLabelMap ?? new Map(),
    };
  }

  /** One card the replay holds, as the metrics read it. */
  observe(row: TableRow): ObservedCard {
    const id = stringColumn(row, "id") ?? "";
    const body = stringColumn(row, "body") ?? "";
    const title = stringColumn(row, "title") ?? "";
    let actions: JsonRecord[] = [];
    try {
      const parsed = JSON.parse(stringColumn(row, "actions_json") ?? "[]") as unknown;
      if (Array.isArray(parsed)) actions = parsed as JsonRecord[];
    } catch {
      actions = [];
    }
    const chosen = stringColumn(row, "chosen_action");
    const resolvedAt = numberColumn(row, "resolved_at");
    return {
      id,
      taskId: stringColumn(row, "task_id"),
      title,
      body,
      createdAt: numberColumn(row, "created_at") ?? 0,
      author: id.startsWith("card-fm-")
        ? "firstmate"
        : this.crewCardIds.has(id)
          ? "crewmate"
          : "host",
      // The body as the frame renders it: since the sanitizer was removed
      // (captain decision, 2026-09-15) nothing stands between the two.
      visual: /<(table|svg|figure|canvas)\b/i.test(body),
      resolvedAt,
      resolution:
        resolvedAt === null
          ? "open"
          : chosen === "closed"
            ? "withdrawn"
            : chosen === "close" || chosen === "dismiss"
              ? "dismissed"
              : "acted",
      duplicateOf: stringColumn(row, "duplicate_of"),
      // The hand-scored plain-language label, keyed by the card's own words.
      plain: this.plainLabels().get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored sentence-habit label, filed in the same row.
      clear: this.clearLabels().get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored pull request link label, filed in the same row.
      prLinks: this.prLinkLabels().get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored project-term and change-effect labels, filed in the same row.
      terms: this.wordLabels().terms.get(cardLabelKey({ title, body })) ?? null,
      affects: this.wordLabels().affects.get(cardLabelKey({ title, body })) ?? null,
      // The hand-scored section-question and task-verb labels, filed in the same row.
      sections: this.decisionLabels().sections.get(cardLabelKey({ title, body })) ?? null,
      taskWords: this.decisionLabels().taskWords.get(cardLabelKey({ title, body })) ?? null,
      hasDefault: actions.some((action) => action.default === true),
      fakeSettle: actions.some(
        (action) =>
          typeof action.id === "string" &&
          isFakeSettleAction({
            id: action.id,
            label: typeof action.label === "string" ? action.label : "",
            effect: (action.effect as { kind: string } | undefined) ?? null,
          }),
      ),
    };
  }

  constructor(
    /** The hand-scored labels (`ReplaySources.plainLabels`); null scores every card as unknown. */
    private readonly labelsFile: string | null,
    /** The cards crewmates showed; a `card-fm-` card is the Firstmate's and any other the host's. */
    private readonly crewCardIds: ReadonlySet<string>,
  ) {}
}

/**
 * The work this replay commissioned, as the record holds it (S5). A row
 * carries a shape the real `CrewSupervisor` computed; a seeded pre-session
 * row keeps the shape it was recorded with, and is not a dispatch of this
 * replay either way. The served tier comes from
 * the ledger's routing rows, which are empty here: a replay has no live catalog
 * to route against, so the downgrade rate is honestly unmeasurable rather
 * than a clean zero.
 */
export function observedDispatches(
  replay: { db: AppDatabase; ledger: DecisionStore; seeded: ReadonlySet<string> },
  records: TaskRecord[],
  cardRows: TableRow[],
): ObservedDispatch[] {
  const served = new Map<string, string | null>();
  for (const row of replay.ledger.routing()) served.set(row.taskId, row.served);
  // The caps this replay placed, as the record holds them (phase 4): a
  // cap still standing is on the delivery facts, and one that was
  // answered left a `cap_reset` behind - the hold survives its counters.
  const resets = new Map<string, number>();
  for (const row of replay.db
    .prepare("SELECT task_id, COUNT(*) AS resets FROM task_events WHERE kind = 'cap_reset' GROUP BY task_id")
    .all() as { task_id: string; resets: number }[]) {
    resets.set(row.task_id, row.resets);
  }
  // The captain's overrides this replay recorded (INF-484 move 8).
  const overrides = new Map<string, string[][]>();
  for (const row of replay.db
    .prepare(
      `SELECT task_id, data_json FROM task_events
         WHERE kind = 'note' AND data_json LIKE '%"override":%' ORDER BY at, id`,
    )
    .all() as { task_id: string; data_json: string | null }[]) {
    const holds = overrideHoldsFrom(row.data_json);
    if (holds) overrides.set(row.task_id, [...(overrides.get(row.task_id) ?? []), holds]);
  }
  // Whether a change SETTLED at all still reads off its completion card -
  // the newest one that could, because a revision replaces the reading its
  // earlier version gave - but the evidence contract is now read on the
  // report (contract v3.6, captain lock 3): the five headings left the
  // card's open body and stayed required in the report and the PR body,
  // so grading the card would grade a rule the lint no longer applies.
  const settled = new Set<string>();
  for (const row of cardRows) {
    const taskId = stringColumn(row, "task_id");
    if (taskId && isCompletionCard(stringColumn(row, "actions_json"))) settled.add(taskId);
  }
  return records
    .filter((record) => record.shape !== null && !replay.seeded.has(record.id))
    .map((record) => {
      // A review task ships nothing, so it reports no rigor at all.
      const rigor =
        record.shape?.kind === "review" ? null : (record.shape?.rigor ?? "quick");
      const delivery = record.delivery;
      return {
        taskId: record.id,
        tier: record.difficulty,
        served: served.get(record.id) ?? null,
        kindSource: record.shape?.kind_source ?? null,
        escalatedFrom: record.shape?.escalation?.from ?? null,
        skippedPlanBecause: record.shape?.skipped_plan_because ?? null,
        rigor,
        // What the row DELIVERS (Task B); a recorded spawn from before the
        // axis shipped a change, which is what null reads as.
        deliverable: record.shape?.deliverable ?? null,
        delivery: delivery?.mode ?? null,
        hasPr: Boolean(delivery?.prUrl || delivery?.prNumber),
        ciRounds: delivery?.ciRounds ?? (delivery?.ci !== undefined ? 0 : null),
        capHits:
          (delivery?.ciCapAt !== undefined ? 1 : 0) +
          (delivery?.reviewCapAt !== undefined ? 1 : 0) +
          (resets.get(record.id) ?? 0),
        overrides: overrides.get(record.id) ?? [],
        evidence:
          rigorRequiresEvidence(rigor as Rigor | undefined) && settled.has(record.id)
            ? carriesEvidenceHeadings(reportEvidenceHeadings(record.outcome))
            : null,
      };
    });
}

/**
 * Every verdict a reviewer returned in this replay, off the builders' own
 * timelines (`review` events, phase 2), paired with the report text the
 * review task still holds so the findings can be counted. `records` is the
 * replay's task record as it stands.
 */
export function replayedReviews(db: AppDatabase, records: TaskRecord[]): ObservedReview[] {
  const events: ReviewEvent[] = (
    db
      .prepare(
        "SELECT task_id, at, data_json FROM task_events WHERE kind = 'review' ORDER BY at, id",
      )
      .all() as { task_id: string; at: number; data_json: string | null }[]
  ).map((row) => reviewEventFrom(row.task_id, row.at, row.data_json));
  const reports = new Map<string, string | null>();
  for (const record of records) {
    if (record.shape?.kind === "review") reports.set(record.id, record.outcome ?? null);
  }
  return observedReviews(events, reports);
}

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function excerpt(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
