/**
 * A task row missing a record invariant TaskService enforces: its key, its
 * project or its update time. The start's record check counts these rows
 * (`TaskRecords.countMissingInvariants`) through the partial index that
 * holds only them (`tasks_missing_invariants`, queryIndexes.ts), which the
 * planner uses only while both say exactly this.
 */
export const MISSING_INVARIANTS = "key IS NULL OR project_id IS NULL OR updated_at IS NULL";

/**
 * True of every task row, since a status is text: the term only the start's
 * reads of every task's status and close carry (`TaskRecords.statuses`,
 * `TaskRecords.listClosedRetentionFields`), so their covering index
 * (`tasks_status_reads`, queryIndexes.ts) serves those reads alone. A full
 * index on these columns would be offered to every join on a task's id or
 * status, and the planner then reorders joins that seek live rows into
 * walks of the closed history.
 */
export const EVERY_STATUS = "typeof(status) = 'text'";
