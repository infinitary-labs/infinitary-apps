import type { AppDatabase } from "./db";
import { UNRESOLVED_SEND } from "./taskDeliveryStore";
import { COMPACTION_CANDIDATE } from "./taskEventCompaction";
import { ORIGIN_EVENT } from "./taskEventStore";
import { EVERY_STATUS, MISSING_INVARIANTS } from "./taskInvariants";

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
 * instead of reading every task (docs/testing.md, "The scale check"), and
 * the tasks that start at a prerequisite's approval, which the ready list
 * seeks the same way (docs/task-graph.md, "A part that starts at approval").
 * The permission index seeks only recorded overrides for each load round,
 * never the permission-bearing history that has no override, and the
 * unresolved-send index only the approval records holding a merge whose
 * outcome was never read back, which every merge send and the minute pass
 * read, closed tasks included (INF-5193).
 * The required-action index seeks the rows holding a required-action
 * record, which a merged close matches its own requirements against
 * instead of composing every task (INF-4224).
 * Captain-click context seeks that actor's recent events, not every
 * crewmate's progress in the same time window (INF-2284).
 * The first launch's crew facts seek a task by kind and status instead of
 * composing every task at each boot and task close (INF-2338).
 * The roster's restart read names the restart-outcome index (INDEXED BY in
 * `latestRestartObservation`), so a database this block has not reached
 * refuses that read rather than walking every note of a running task
 * (INF-2341). The origin read names the origin index the same way, so the
 * open-message walk reads a task's asks and origin notes, never the rest
 * of its history (`listOriginEvents`, INF-6434).
 * The reference index seeks the tasks whose basis, retry or branch names
 * a task by its trimmed, upper-cased name, which the answer-delivery sweep
 * reads for every task a message covers (INF-2971).
 * The present-workspace index seeks the closed tasks whose working copy
 * a work computer's roster may no longer hold, read at each of its
 * contacts instead of composing every task (INF-3040).
 * The routing-model index seeks each model's newest chosen routing row,
 * which a start reads for the models that take turns (INF-3782).
 * The branch index seeks the task that saved a branch name, which a start
 * reads for each name it tries for a new task's branch.
 * The status index covers each task's close, id and status, which the
 * first mate's start reads for every task, for the task board and the
 * passes over closed tasks' files, so those reads never walk the long rows
 * of a record not yet in the system's cache; it is partial so those reads
 * alone use it (taskInvariants.ts). The
 * invariants index holds only the rows missing a key, project or update
 * time, which the start's record check counts without reading every row.
 * The conversation's read (conversationRead.ts) pages the captain's own
 * card presses by time, and seeks the message that names a line typed
 * under a card, instead of walking every observation or every message.
 * Automatic tagging seeks the tasks filed since its start mark, which it
 * moves up to the newest task whenever nothing is owed, and the
 * decision model's rows waiting to be asked again (tagWork.ts), at each
 * task filed, moved or reworded, instead of walking every task.
 * `migrate` (db.ts) creates them once a database reaches the newest migration.
 */
export function createQueryIndexes(db: AppDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS usage_events_account_at ON usage_events (account_id, at);
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS tasks_kind_status ON tasks (kind, status);
    CREATE INDEX IF NOT EXISTS task_permissions_override
      ON task_permissions (override_json) WHERE override_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_permissions_captain_action
      ON task_permissions (task_id) WHERE captain_action_json IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tasks_parent_status ON tasks (parent_id, status);
    CREATE INDEX IF NOT EXISTS tasks_closed_at ON tasks (closed_at);
    CREATE INDEX IF NOT EXISTS tasks_workspace_present ON tasks (closed_at)
      WHERE workspace_state = 'present';
    CREATE INDEX IF NOT EXISTS task_events_ref ON task_events (kind, ref) WHERE ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_references_name ON task_references (kind, upper(trim(ref)));
    CREATE INDEX IF NOT EXISTS task_events_compaction ON task_events (task_id, at)
      WHERE ${COMPACTION_CANDIDATE};
    CREATE INDEX IF NOT EXISTS task_events_actor_at ON task_events (actor, at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS decisions_sort_recent ON decisions (kind, id DESC) WHERE kind = 'sort';
    CREATE INDEX IF NOT EXISTS decisions_chosen_task_at ON decisions (kind, task_id, at DESC, id DESC)
      WHERE provider IS NOT NULL;
    CREATE INDEX IF NOT EXISTS decisions_routing_model_recent ON decisions (provider, model, id DESC)
      WHERE kind = 'routing' AND provider IS NOT NULL;
    CREATE INDEX IF NOT EXISTS task_events_task_kind_at ON task_events (task_id, kind, at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS task_events_firstmate_action ON task_events (task_id, at, id)
      WHERE actor = 'firstmate' AND kind <> 'decided';
    CREATE INDEX IF NOT EXISTS task_events_restart_outcome ON task_events (task_id, at DESC, id DESC)
      WHERE kind = 'note'
      AND CASE WHEN json_valid(data_json) THEN json_type(data_json, '$.restartOutcome') END = 'object';
    CREATE INDEX IF NOT EXISTS task_events_origin ON task_events (task_id, at, id)
      WHERE ${ORIGIN_EVENT};
    CREATE INDEX IF NOT EXISTS task_events_leftovers ON task_events (
      json_extract(data_json, '$.leftoversComputerId'), at, id
    ) WHERE kind = 'note'
      AND CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.leftoversUnresolved') END = 1;
    CREATE INDEX IF NOT EXISTS task_permissions_unresolved_send
      ON task_permissions ((${UNRESOLVED_SEND}), task_id) WHERE (${UNRESOLVED_SEND}) = 1;
    CREATE INDEX IF NOT EXISTS tasks_specification ON tasks (specification_id);
    CREATE INDEX IF NOT EXISTS tasks_branch ON tasks (branch);
    CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks (created_at);
    CREATE INDEX IF NOT EXISTS task_tags_unjudged ON task_tags (task_id)
      WHERE set_by = 'decision' AND revision IS NULL;
    CREATE INDEX IF NOT EXISTS tasks_status_reads ON tasks (closed_at, id, status)
      WHERE ${EVERY_STATUS};
    CREATE INDEX IF NOT EXISTS tasks_missing_invariants ON tasks (id)
      WHERE ${MISSING_INVARIANTS};
    CREATE INDEX IF NOT EXISTS captain_asks_at ON captain_asks (at);
    CREATE INDEX IF NOT EXISTS captain_asks_turn ON captain_asks (turn_state, at);
    CREATE INDEX IF NOT EXISTS captain_asks_delivery ON captain_asks (delivery, at);
    CREATE INDEX IF NOT EXISTS captain_asks_continues ON captain_asks (continues, at);
    CREATE INDEX IF NOT EXISTS captain_asks_unanswered ON captain_asks (followed, answered_at, at);
    CREATE INDEX IF NOT EXISTS captain_asks_typed ON captain_asks (typed_card_id, typed_line)
      WHERE typed_card_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS card_observations_captain_actions ON card_observations (recorded_at)
      WHERE kind = 'action' AND actor = 'captain';
    CREATE INDEX IF NOT EXISTS cards_resolved_at ON cards (resolved_at);
    CREATE INDEX IF NOT EXISTS card_messages_at ON card_messages (at);
    CREATE INDEX IF NOT EXISTS task_placement_requests_computer_move
      ON task_placement_requests (json_type(value_json, '$.computer_move'));
    CREATE INDEX IF NOT EXISTS task_placement_requests_start_at_approval
      ON task_placement_requests (json_type(value_json, '$.start_at_approval'));
  `);
}
