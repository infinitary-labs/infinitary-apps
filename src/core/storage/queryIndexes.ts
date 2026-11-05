import type { AppDatabase } from "./db";
import { COMPACTION_CANDIDATE } from "./taskEventCompaction";

/**
 * An optional query index adds no saved-data format or migration version.
 * The task ones keep a read of the live set, or of what closed this week,
 * from scanning a long record's closed rows on every crew event. The
 * event one seeks the tasks a message or a card names (`taskIdsWithRef`,
 * `latestTaskForRef`), which the open messages read before and after
 * every first mate turn, instead of walking every task event (INF-2059).
 * The rest keep a read the statement check found walking a growing table
 * from doing so (docs/testing.md, "The statement check"): the deferred
 * reference from a task to its specification, checked on each
 * specification write; the answer-delivery check's messages by state, and
 * the newest message, read around each first mate turn; recently resolved
 * cards and recent card threads, read into each turn's context; and the
 * tasks holding a computer move, which the ready sweep seeks each minute
 * instead of reading every task (docs/testing.md, "The scale check").
 * The permission index seeks only recorded overrides for each load round,
 * never the permission-bearing history that has no override.
 * Captain-click context seeks that actor's recent events, not every
 * crewmate's progress in the same time window (INF-2284).
 * The first launch's crew facts seek a task by kind and status instead of
 * composing every task at each boot and task close (INF-2338).
 * The roster's restart read names the restart-outcome index (INDEXED BY in
 * `latestRestartObservation`), so a database this block has not reached
 * refuses that read rather than walking every note of a running task
 * (INF-2341).
 * `migrate` (db.ts) creates them once a database reaches the newest migration.
 */
export function createQueryIndexes(db: AppDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS usage_events_account_at ON usage_events (account_id, at);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS tasks_kind_status ON tasks (kind, status);
    CREATE INDEX IF NOT EXISTS task_permissions_override
      ON task_permissions (override_json) WHERE override_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tasks_parent_status ON tasks (parent_id, status);
    CREATE INDEX IF NOT EXISTS tasks_closed_at ON tasks (closed_at);
    CREATE INDEX IF NOT EXISTS task_events_ref ON task_events (kind, ref) WHERE ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_events_compaction ON task_events (task_id, at)
      WHERE ${COMPACTION_CANDIDATE};
    CREATE INDEX IF NOT EXISTS task_events_actor_at ON task_events (actor, at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS decisions_sort_recent ON decisions (kind, id DESC) WHERE kind = 'sort';
    CREATE INDEX IF NOT EXISTS decisions_chosen_task_at ON decisions (kind, task_id, at DESC, id DESC)
      WHERE provider IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_events_task_kind_at ON task_events (task_id, kind, at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS task_events_firstmate_action ON task_events (task_id, at, id)
      WHERE actor = 'firstmate' AND kind <> 'decided';
    CREATE INDEX IF NOT EXISTS task_events_restart_outcome ON task_events (task_id, at DESC, id DESC)
      WHERE kind = 'note'
      AND CASE WHEN json_valid(data_json) THEN json_type(data_json, '$.restartOutcome') END = 'object';
    CREATE INDEX IF NOT EXISTS tasks_specification ON tasks (specification_id);
    CREATE INDEX IF NOT EXISTS captain_asks_at ON captain_asks (at);
    CREATE INDEX IF NOT EXISTS captain_asks_turn ON captain_asks (turn_state, at);
    CREATE INDEX IF NOT EXISTS captain_asks_delivery ON captain_asks (delivery, at);
    CREATE INDEX IF NOT EXISTS captain_asks_continues ON captain_asks (continues, at);
    CREATE INDEX IF NOT EXISTS captain_asks_unanswered ON captain_asks (followed, answered_at, at);
    CREATE INDEX IF NOT EXISTS cards_resolved_at ON cards (resolved_at);
    CREATE INDEX IF NOT EXISTS card_messages_at ON card_messages (at);
    CREATE INDEX IF NOT EXISTS task_placement_requests_computer_move
      ON task_placement_requests (json_type(value_json, '$.computer_move'));
  `);
}
