/**
 * The dispatch extractor's fleet tables (`scripts/extract-dispatch-corpus.ts`):
 * a read-only snapshot of the `tasks`, `repos`, `cards` and timeline rows a
 * dispatch record joins to, each column read only where the database has it.
 */

import Database from "better-sqlite3";
import { taskReadTable } from "../../src/core/storage/taskRecordFields.ts";
import { savedShapeReader } from "../../src/core/storage/taskReferenceFields.ts";
import { savedDeliveryReader } from "../../src/core/storage/taskDeliveryFields.ts";
import { overrideHoldsFrom, type ReviewEvent, reviewEventFrom } from "../interaction-metrics.ts";
import { type CardRevisionRow, cardVersionAt, declaredActionsOf } from "./cards.ts";

type JsonRecord = Record<string, unknown>;

export type TaskRow = {
  /** Null means never dispatched; absent only in databases predating that fact. */
  started_at?: number | null;
  id: string;
  /** The task's key (`INF-12`); null on a row with none or a database older than keys. */
  key: string | null;
  title: string;
  status: string;
  kind: string;
  repo_id: string | null;
  /** The parent edge - on a `review` shape, the builder it reads (the one stored join). */
  parent_id: string | null;
  created_at: number;
  closed_at: number | null;
  closed_reason: string | null;
  /** The computed tier (S2); a judged class on rows older than the shape. */
  difficulty: string | null;
  /** The `WorkShape` JSON the host routed from (S2), null before it existed. */
  shape_json: string | null;
  /** The delivery facts JSON (task-system P0), where the review verdict lives. */
  delivery_json: string | null;
  /** The last report the row recorded - a reviewer's verdict text, on a review task. */
  outcome: string | null;
};
type RepoRow = { id: string; name: string; delivery: string; autonomy: number };
export type CardRow = {
  id: string;
  /** The task the card is about, when the emitter attached one (P1). */
  task_id: string | null;
  /** The stored column: "card" since cards/tasks/agents P1, an older row's word before it. */
  kind: string;
  /** The card's declared actions, verbatim: a decision is a card with at least one. */
  actions_json: string;
  author: string | null;
  title: string;
  body: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  chosen_action: string | null;
  /** The captain's confirmed duplicate label (WI-14); null on unflagged or older rows. */
  duplicate_of: string | null;
  duplicate_note: string | null;
  duplicate_at: number | null;
};

/**
 * One override the captain's words declared on a task, as its `note` row
 * recorded it (`docs/agents-reach.md`, "The override counts").
 */
export type RecordedOverride = {
  /** When the row was written. */
  at: number;
  /** Who wrote the row, which says the route its words took (`manifest.rigor.overrides`). */
  actor: string;
  /** The soft holds it named (`overrideHoldsFrom`). */
  holds: string[];
  /** How long it lasts; null on a row whose override does not say. */
  until: "version" | "task" | null;
  /** The version a `version` override covers. */
  head: string | null;
  /** The words were the captain's click on a merge (INF-1966): such an override never stands. */
  mergeClick: boolean;
  /**
   * The override the task's record held when this one was written, which
   * this one replaced; null when none stood or a take-back came between.
   */
  replaces: { at: number; holds: string[] } | null;
};

/** One actor-labelled row of a task's own timeline (`task_events`). */
export type CardEvent = { taskId: string; actor: string; at: number; action?: string };

export type FleetTables = {
  tasks: Map<string, TaskRow>;
  repos: Map<string, RepoRow>;
  cards: Map<string, CardRow>;
  cardsByTitle: Map<string, CardRow[]>;
  /** card id -> the task whose timeline recorded the card being raised. */
  cardRaised: Map<string, CardEvent>;
  /** card id -> the actor-labelled resolution the timeline recorded. */
  cardResolved: Map<string, CardEvent>;
  /** card id -> the decision record the host filed for a task-less card. */
  decisionByCard: Map<string, TaskRow>;
  /** card id -> superseded versions, oldest first. */
  cardRevisions: Map<string, CardRevisionRow[]>;
  /**
   * task id -> what its newest routing decision recorded: the policy rule
   * that chose the tier (S2) and the tier the ladder actually served (S5).
   * Either may be null on a database older than the column that carries it.
   */
  routing: Map<string, { rule: string | null; served: string | null }>;
  /**
   * Every `review` timeline event, oldest first (delivery rigor phase 2):
   * one verdict a reviewer returned, on the BUILDER's own timeline. Empty
   * on a database older than the reviewed tier.
   */
  reviewEvents: ReviewEvent[];
  /**
   * task id -> how many times a `cap_reset` reopened its rounds (phase 3).
   * A cap that is still standing lives on the delivery facts instead; the
   * two together are the holds the change earned.
   */
  capResets: Map<string, number>;
  /**
   * task id -> each override the captain's words declared on it, oldest
   * first (INF-484 move 8). Empty on a database older than the override.
   */
  overrides: Map<string, RecordedOverride[]>;
};

export const EMPTY_TABLES: FleetTables = {
  tasks: new Map(),
  repos: new Map(),
  cards: new Map(),
  cardsByTitle: new Map(),
  cardRaised: new Map(),
  cardResolved: new Map(),
  decisionByCard: new Map(),
  cardRevisions: new Map(),
  routing: new Map(),
  reviewEvents: [],
  capResets: new Map(),
  overrides: new Map(),
};

export function readFleetTables(dbPath: string): FleetTables {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Tables and views: since migration 50 `routing_decisions` is a view
    // over the one decision ledger, with the same rows.
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const tasks = new Map<string, TaskRow>();
    if (tables.has("tasks")) {
      const taskTable = taskReadTable(db);
      const taskColumns = new Set(
        (db.prepare(`PRAGMA table_info(${taskTable})`).all() as { name: string }[]).map((c) => c.name),
      );
      const startedAt = taskColumns.has("started_at") ? "started_at, " : "";
      const key = taskColumns.has("key") ? "key" : "NULL AS key";
      const closedAt = taskColumns.has("closed_at") ? "closed_at" : "NULL AS closed_at";
      const closedReason = taskColumns.has("closed_reason")
        ? "closed_reason"
        : "NULL AS closed_reason";
      const difficulty = taskColumns.has("difficulty") ? "difficulty" : "NULL AS difficulty";
      const shape = taskColumns.has("shape_json") ? "shape_json" : "NULL AS shape_json";
      const delivery = taskColumns.has("delivery_json")
        ? "delivery_json"
        : "NULL AS delivery_json";
      const outcome = taskColumns.has("outcome") ? "outcome" : "NULL AS outcome";
      const parent = taskColumns.has("parent_id") ? "parent_id" : "NULL AS parent_id";
      // A task's shape as the app reads it, its references in it.
      const shapeOf = savedShapeReader(db);
      // Its delivery facts as the app reads them, its evidence and permissions in them.
      const deliveryOf = savedDeliveryReader(db);
      for (const row of db
        .prepare(
          `SELECT id, ${key}, title, status, kind, repo_id, ${parent}, created_at, ${startedAt}${closedAt}, ${closedReason}, ${difficulty}, ${shape}, ${delivery}, ${outcome} FROM ${taskTable}`,
        )
        .all() as TaskRow[]) {
        tasks.set(row.id, {
          ...row,
          shape_json: shapeOf(row.id, row.shape_json),
          delivery_json: deliveryOf(row.id, row.delivery_json),
        });
      }
    }
    // The rule that chose each task's tier and the tier actually served,
    // newest decision per task. Each column arrived with its own step (S2,
    // S5), so a database routed before one simply has none of it - never a
    // guessed rule and never a served tier assumed equal to the asked one.
    const routing = new Map<string, { rule: string | null; served: string | null }>();
    if (tables.has("routing_decisions")) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(routing_decisions)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      const rule = columns.has("rule") ? "rule" : "NULL AS rule";
      const served = columns.has("served") ? "served" : "NULL AS served";
      for (const row of db
        .prepare(`SELECT task_id, ${rule}, ${served} FROM routing_decisions ORDER BY at, id`)
        .all() as { task_id: string; rule: string | null; served: string | null }[]) {
        routing.set(row.task_id, { rule: row.rule, served: row.served });
      }
    }
    const repos = new Map<string, RepoRow>();
    if (tables.has("repos")) {
      for (const row of db
        .prepare("SELECT id, name, delivery, autonomy FROM repos")
        .all() as RepoRow[]) {
        repos.set(row.id, row);
      }
    }
    const cards = new Map<string, CardRow>();
    const cardsByTitle = new Map<string, CardRow[]>();
    if (tables.has("cards")) {
      // A database older than migration 25 has no duplicate label: null.
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map((c) => c.name),
      );
      const labelled = columns.has("duplicate_of")
        ? "duplicate_of, duplicate_note, duplicate_at"
        : "NULL AS duplicate_of, NULL AS duplicate_note, NULL AS duplicate_at";
      const author = columns.has("author") ? "author" : "NULL AS author";
      for (const row of db
        .prepare(
          `SELECT id, task_id, kind, actions_json, ${author}, title, body, status, created_at, resolved_at, chosen_action, ${labelled} FROM cards`,
        )
        .all() as CardRow[]) {
        cards.set(row.id, row);
        const bucket = cardsByTitle.get(row.title) ?? [];
        bucket.push(row);
        cardsByTitle.set(row.title, bucket);
      }
    }
    // Lineage, from the record's own actor-labelled timeline (task-system
    // P2/P3). A card's task is recorded when it is raised and again when it
    // is resolved; reading those beats matching on a title.
    const cardRaised = new Map<string, CardEvent>();
    const cardResolved = new Map<string, CardEvent>();
    if (tables.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT task_id, at, actor, kind, data_json, ref FROM task_events
             WHERE kind IN ('card_raised', 'card_resolved') AND ref IS NOT NULL
             ORDER BY at, id`,
        )
        .all() as {
        task_id: string;
        at: number;
        actor: string;
        kind: string;
        data_json: string | null;
        ref: string;
      }[]) {
        const event: CardEvent = { taskId: row.task_id, actor: row.actor, at: row.at };
        if (row.kind === "card_raised") cardRaised.set(row.ref, event);
        else cardResolved.set(row.ref, { ...event, ...actionOf(row.data_json) });
      }
    }
    const cardRevisions = new Map<string, CardRevisionRow[]>();
    if (tables.has("card_revisions")) {
      for (const row of db
        .prepare(
          `SELECT card_id, revision, kind, title, body, actions_json,
                  created_at, replaced_at, replaced_by
           FROM card_revisions ORDER BY card_id, revision`,
        )
        .all() as CardRevisionRow[]) {
        const revisions = cardRevisions.get(row.card_id) ?? [];
        revisions.push(row);
        cardRevisions.set(row.card_id, revisions);
        const card = cards.get(row.card_id);
        if (card) {
          const titleRows = cardsByTitle.get(row.title) ?? [];
          if (!titleRows.some((candidate) => candidate.id === card.id)) titleRows.push(card);
          cardsByTitle.set(row.title, titleRows);
        }
      }
    }
    // A Firstmate decision card with no task of its own still has a record:
    // the host files a `decision` row gated on the card id (task-system P1).
    const decisionByCard = new Map<string, TaskRow>();
    if (tables.has("tasks")) {
      const taskTable = taskReadTable(db);
      const taskColumns = new Set(
        (db.prepare(`PRAGMA table_info(${taskTable})`).all() as { name: string }[]).map((c) => c.name),
      );
      if (taskColumns.has("gate_ref")) {
        for (const row of db
          .prepare("SELECT id, gate_ref FROM tasks WHERE kind = 'decision' AND gate_ref IS NOT NULL")
          .all() as { id: string; gate_ref: string }[]) {
          const record = tasks.get(row.id);
          if (record) decisionByCard.set(row.gate_ref, record);
        }
      }
      for (const [cardId, raised] of cardRaised) {
        const record = tasks.get(raised.taskId);
        if (record?.kind === "decision") decisionByCard.set(cardId, record);
      }
      if (tables.has("task_events")) {
        const closeEvent = db.prepare(
          `SELECT actor, at FROM task_events
           WHERE task_id = ? AND at = ?
           ORDER BY id DESC LIMIT 1`,
        );
        for (const [cardId, record] of decisionByCard) {
          if (cardResolved.has(cardId) || record.closed_at === null) continue;
          const event = closeEvent.get(record.id, record.closed_at) as
            | { actor: string; at: number }
            | undefined;
          if (event) {
            const card = cards.get(cardId);
            const chosen = card?.chosen_action;
            const version =
              card?.resolved_at == null
                ? null
                : cardVersionAt(card, cardRevisions.get(cardId) ?? [], card.resolved_at);
            const captainDeclaredChoice = Boolean(
              event.actor === "captain" &&
                version?.kind === "card" &&
                chosen &&
                declaredActionsOf(version.actions_json).some((entry) => entry.id === chosen),
            );
            const action =
              record.closed_reason === "cancelled"
                ? "dismissed"
                : record.closed_reason === "superseded"
                  ? captainDeclaredChoice
                    ? (chosen ?? undefined)
                    : "withdrawn"
                  : record.closed_reason === "answered"
                    ? (chosen ?? undefined)
                    : undefined;
            cardResolved.set(cardId, {
              taskId: record.id,
              actor: event.actor,
              at: event.at,
              ...(action ? { action } : {}),
            });
          }
        }
      }
    }
    // The rigor record (delivery rigor phase 4): the verdicts reviewers
    // returned, and the caps a steer reopened. Both live in `task_events`,
    // and a database older than the tiers simply has neither.
    const reviewEvents: ReviewEvent[] = [];
    const capResets = new Map<string, number>();
    // The captain's overrides (INF-484 move 8): a `note` row whose delivery
    // patch carries the typed override. A take-back's row carries the
    // override it took back instead, and leaves nothing standing.
    const overrides = new Map<string, RecordedOverride[]>();
    const standing = new Map<string, RecordedOverride>();
    if (tables.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT task_id, at, actor, kind, data_json FROM task_events
             WHERE kind IN ('review', 'cap_reset')
                OR (kind = 'note' AND (data_json LIKE '%"override":%'
                                    OR data_json LIKE '%"overrideWithdrawn":%'))
             ORDER BY at, id`,
        )
        .all() as {
          task_id: string;
          at: number;
          actor: string;
          kind: string;
          data_json: string | null;
        }[]) {
        if (row.kind === "note") {
          const override = recordedOverrideFrom(row, standing.get(row.task_id));
          if (override) {
            overrides.set(row.task_id, [...(overrides.get(row.task_id) ?? []), override]);
            standing.set(row.task_id, override);
          } else if (tookBackOverride(row.data_json)) standing.delete(row.task_id);
          continue;
        }
        if (row.kind === "cap_reset") {
          capResets.set(row.task_id, (capResets.get(row.task_id) ?? 0) + 1);
          continue;
        }
        reviewEvents.push(reviewEventFrom(row.task_id, row.at, row.data_json));
      }
    }
    return {
      tasks,
      repos,
      cards,
      cardsByTitle,
      cardRaised,
      cardResolved,
      decisionByCard,
      cardRevisions,
      routing,
      reviewEvents,
      capResets,
      overrides,
    };
  } finally {
    db.close();
  }
}

/**
 * The override a `note` row declared, with the one it replaced; undefined
 * for any other note. Whether a row is an override at all is
 * `overrideHoldsFrom`'s, the reading the replay shares.
 */
function recordedOverrideFrom(
  row: { at: number; actor: string; data_json: string | null },
  replaced: RecordedOverride | undefined,
): RecordedOverride | undefined {
  const holds = overrideHoldsFrom(row.data_json);
  if (!holds) return undefined;
  const override = (JSON.parse(row.data_json ?? "null") as { override: JsonRecord }).override;
  return {
    at: row.at,
    actor: row.actor,
    holds,
    until: override.until === "version" || override.until === "task" ? override.until : null,
    head: typeof override.head === "string" ? override.head : null,
    mergeClick: override.mergeClick === true,
    replaces: replaced ? { at: replaced.at, holds: replaced.holds } : null,
  };
}

/** Whether a `note` row is a take-back: it carries the override it took back. */
function tookBackOverride(dataJson: string | null): boolean {
  try {
    const data = JSON.parse(dataJson ?? "null") as { overrideWithdrawn?: unknown } | null;
    return typeof data?.overrideWithdrawn === "object" && data.overrideWithdrawn !== null;
  } catch {
    return false;
  }
}

/** The action a `card_resolved` event recorded, when it carried one. */
export function actionOf(dataJson: string | null): { action?: string } {
  if (!dataJson) return {};
  try {
    const parsed = JSON.parse(dataJson) as JsonRecord;
    return typeof parsed.action === "string" ? { action: parsed.action } : {};
  } catch {
    return {};
  }
}
