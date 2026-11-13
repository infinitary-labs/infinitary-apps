/**
 * The walks ledger of the statement check (statementCheck.ts; docs/testing.md,
 * "The statement check"). It only shrinks: an entry leaves when its walk is
 * fixed, and the check fails while a ledgered statement no longer makes the
 * walks written here. A new entry is a move its pull request explains, as a
 * moved replay number is.
 */

/**
 * Tables that do not grow with the saved record, each with the code that
 * keeps them small. Every other table grows, a new one included.
 */
export const BOUNDED_TABLES: Record<string, string> = {
  schema_migrations: "one row per migration this build knows",
  activity_events: "ActivityStore.record keeps the newest RETAINED lines",
  quota_snapshots: "QuotaSnapshotStore.record keeps the newest QUOTA_SNAPSHOTS_KEPT",
  inbox: "InboxStore.ack deletes each delivered row; only waiting deliveries stay",
  inbox_acks: "InboxStore.ack deletes the acknowledgements older than INBOX_DEDUPE_WINDOW_MS",
  schedule_runs:
    "ScheduleStore.trim keeps each schedule's settled runs to 30 days and RUN_RETENTION_CAP",
};

/**
 * Code whose statements run once per saved record, never again as it grows:
 * `path function`, as the call stack names it. A statement prepared under
 * one of these is not planned.
 */
export const ONE_TIME_CALLERS: Record<string, string> = {
  "src/core/storage/db.ts migrate": "each migration runs once, when the record reaches its version",
  "src/core/storage/knowledgeStore.ts migrate":
    "each knowledge migration runs once, when the collection reaches its version",
  "src/core/folderMove/rewrite.ts rewriteDatabases":
    "the one-time folder move rewrites and counts every table of its staged copy",
  "src/core/folderMove/taskFolders.ts repairMovedTaskFolders":
    "runs at an open only after a folder move, and rewrites nothing once the rows name the new folder",
  "src/core/tasks/taskArchive.ts TaskArchive.purge": "the D-13 purge deletes every task at once",
  "src/core/knowledge/directions.ts StandingDirections.carry":
    "carries the older record's standing directions into the knowledge collection once, then removes the old tables",
};

/**
 * Statements allowed to walk or sort a growing table, keyed by their text
 * with whitespace collapsed: the walks their plan makes, in plan order, and
 * why the walk is acceptable.
 */
export const WALKS: Record<string, { walks: string[]; reason: string }> = {
  "SELECT DISTINCT extension_id FROM plugin_kv ORDER BY extension_id": {
    walks: ["SCAN plugin_kv USING COVERING INDEX sqlite_autoindex_plugin_kv_1"],
    reason: "one row per key a personal panel saves, read when the panels' data is listed",
  },
  "SELECT * FROM plugins WHERE installed_at IS NOT NULL ORDER BY id": {
    walks: ["SCAN plugins USING INDEX sqlite_autoindex_plugins_1"],
    reason: "one row per personal panel the captain installs",
  },
  "SELECT * FROM plugins WHERE pending_json IS NOT NULL ORDER BY id": {
    walks: ["SCAN plugins USING INDEX sqlite_autoindex_plugins_1"],
    reason: "one row per personal panel the captain installs",
  },
  "SELECT account_id, window_id, status, utilization, resets_at, at FROM pushed_quota": {
    walks: ["SCAN pushed_quota"],
    reason: "one row per account and allowance window",
  },
  "SELECT id FROM captain_asks ORDER BY at DESC, rowid DESC LIMIT 1": {
    walks: ["SCAN captain_asks USING INDEX captain_asks_at"],
    reason: "reads the newest message through captain_asks_at and stops at its LIMIT",
  },
  "SELECT * FROM captain_asks ORDER BY at, rowid": {
    walks: ["SCAN captain_asks USING INDEX captain_asks_at"],
    reason: "every message, oldest first, for tests and the offline scripts (AskStore.list)",
  },
  "SELECT namespace FROM card_capture_epochs ORDER BY capture_version LIMIT 1": {
    walks: ["SCAN card_capture_epochs"],
    reason: "one row per capture version the installation ran, read once at start",
  },
  "SELECT 1 FROM cards LIMIT 1": {
    walks: ["SCAN cards USING COVERING INDEX cards_resolved_at"],
    reason: "reads one row and stops at its LIMIT (CardStore.hasHistory)",
  },
  "SELECT * FROM changes ORDER BY created_at, id": {
    walks: ["SCAN changes", "USE TEMP B-TREE FOR ORDER BY"],
    reason: "every change, for the task export and import (ChangeStore.list)",
  },
  "SELECT * FROM change_versions ORDER BY change_id, seq": {
    walks: ["SCAN change_versions USING INDEX sqlite_autoindex_change_versions_1"],
    reason: "every change version, for the task export and import (ChangeStore.list)",
  },
  "SELECT owner_id, command, stopped_by_quit FROM jobs ORDER BY started_at": {
    walks: ["SCAN jobs", "USE TEMP B-TREE FOR ORDER BY"],
    reason: "the jobs a previous process left, read and deleted once at start",
  },
  "SELECT id, scope, text, origin, revision, retired, created_at AS createdAt, updated_at AS updatedAt FROM directions ORDER BY created_at, id":
    {
      walks: ["SCAN directions", "USE TEMP B-TREE FOR ORDER BY"],
      reason: "one row per standing direction the captain keeps",
    },
  "SELECT * FROM projects ORDER BY created_at, id": {
    walks: ["SCAN projects", "USE TEMP B-TREE FOR ORDER BY"],
    reason: "one row per project the captain adds",
  },
  "SELECT key FROM projects": {
    walks: ["SCAN projects USING COVERING INDEX sqlite_autoindex_projects_2"],
    reason: "one row per project the captain adds",
  },
  "SELECT name, archived_at FROM projects WHERE UPPER(key) = ?": {
    walks: ["SCAN projects"],
    reason: "one row per project the captain adds",
  },
  "SELECT * FROM schedules ORDER BY created_at": {
    walks: ["SCAN schedules", "USE TEMP B-TREE FOR ORDER BY"],
    reason: "one row per schedule the captain sets",
  },
  "SELECT * FROM task_delivery_evidence": {
    walks: ["SCAN task_delivery_evidence"],
    reason:
      "reads a saved database's delivery evidence once, for the offline scripts that read a saved record",
  },
  "SELECT * FROM task_permissions": {
    walks: ["SCAN task_permissions"],
    reason:
      "reads a saved database's permissions once, for the offline scripts that read a saved record",
  },
  "SELECT event_id, task_id, relation, via FROM task_event_concerns ORDER BY event_id, task_id": {
    walks: ["SCAN task_event_concerns USING INDEX sqlite_autoindex_task_event_concerns_1"],
    reason: "every concern row, for the task export (TaskEventStore.listAllConcerns)",
  },
  "SELECT e.*, CASE WHEN json_type(parent_program.value_json, '$.program') = 'object' THEN t.parent_id WHEN json_type(own_program.value_json, '$.program') = 'object' THEN t.id END AS program_id FROM task_events e CROSS JOIN tasks t ON t.id = e.task_id LEFT JOIN task_programs parent_program ON parent_program.task_id = t.parent_id LEFT JOIN task_programs own_program ON own_program.task_id = t.id WHERE e.feed = 1 ORDER BY e.at DESC, e.id DESC":
    {
      walks: ["SCAN e USING INDEX task_events_feed"],
      reason:
        "walks the feed-worthy events newest first through the partial task_events_feed index and stops once it holds the feed's groups; it runs only when the kept view goes stale, and later reads fold in only the events written since (feedProjection.ts, INF-2971)",
    },
  "SELECT * FROM cards WHERE ended_json IS NOT NULL ORDER BY created_at": {
    walks: ["SCAN cards USING INDEX cards_ended"],
    reason:
      "walks only the partial cards_ended index, which holds the cards ended while the captain had seen them and not yet closed; read once at start (EndedCards.restore, INF-3071)",
  },
  "SELECT * FROM cards WHERE put_off_json IS NOT NULL ORDER BY created_at": {
    walks: ["SCAN cards USING INDEX cards_put_off"],
    reason:
      "walks only the partial cards_put_off index, which holds the closed cards the captain put off until a task's close, a time, an event or their word; read when a put-off's rule runs, the captain raises one, a task closes, a task's witnesses are gathered, or once a next-move pass that has a part to read (PutOffs, INF-3846 piece 3)",
  },
  "SELECT task_id FROM task_execution WHERE json_extract(placement_json, '$.reservation') = 'pending'":
    {
      walks: ["SCAN task_execution USING INDEX task_execution_pending_placement"],
      reason:
        "walks only the partial task_execution_pending_placement index, which holds the pending placements",
    },
  "SELECT * FROM task_links ORDER BY created_at, from_id, to_id": {
    walks: ["SCAN task_links", "USE TEMP B-TREE FOR ORDER BY"],
    reason:
      "every link, for a builder that resolves them in one pass (TaskService.graph.allLinks); links grow with tasks, so the scale check counts it",
  },
  "SELECT task_id, kind, ref FROM task_references": {
    walks: ["SCAN task_references"],
    reason:
      "reads a saved database's references once, for the offline scripts that read a saved record",
  },
  "SELECT * FROM task_policies": {
    walks: ["SCAN task_policies"],
    reason:
      "reads a saved database's policies once, for the offline scripts that read a saved record",
  },
  "UPDATE tasks SET activity = 'interrupted', updated_at = ? WHERE status = 'active' AND activity IN ('running', 'starting') AND id NOT IN (SELECT task_id FROM task_execution WHERE device_id IS NOT NULL)":
    {
      walks: ["SCAN task_execution"],
      reason: "marks the work a previous process left running, once at start",
    },
  "SELECT * FROM task_records": {
    walks: ["SCAN t"],
    reason: "the whole task list (TaskService.list), whose many readers the scale check counts",
  },
  "SELECT * FROM tasks": {
    walks: ["SCAN tasks"],
    reason: "the whole task list (TaskService.list), whose many readers the scale check counts",
  },
  "SELECT t.id, t.status, t.closed_at, (SELECT e.device_id FROM task_execution e WHERE e.task_id = t.id) AS device_id FROM tasks t WHERE t.closed_at IS NOT NULL":
    {
      walks: ["SCAN t"],
      reason:
        "the temporary-folder pass's first read of every closed task, once at start; each later pass seeks only the closes since (TaskTempFiles.pass)",
    },
  "SELECT COUNT(*) AS n FROM tasks WHERE key IS NULL OR project_id IS NULL OR updated_at IS NULL": {
    walks: ["SCAN tasks"],
    reason: "the boot check of the record's invariants, once at start",
  },
  "WITH placed AS ( SELECT u.*, CASE WHEN u.task_id = @firstmate THEN 'firstmate' WHEN t.id IS NOT NULL THEN 'task' ELSE 'other' END AS kind, t.id AS known_task FROM usage_events u LEFT JOIN tasks t ON t.id = u.task_id WHERE @since IS NULL OR u.at >= @since ) SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, provider, model, model_source, cost_source, kind, known_task AS task_id, COUNT(*) AS records, SUM(input IS NOT NULL OR output IS NOT NULL OR cache_read IS NOT NULL OR cache_write IS NOT NULL) AS counted, COUNT(input) AS reported_input, COUNT(output) AS reported_output, COUNT(cache_read) AS reported_cache_read, COUNT(cache_write) AS reported_cache_write, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write, SUM(CASE WHEN cost > 0 THEN cost END) AS cost, SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS priced, SUM(CASE WHEN cost > 0 THEN cost_input END) AS cost_input, SUM(CASE WHEN cost > 0 THEN cost_output END) AS cost_output, SUM(CASE WHEN cost > 0 THEN cost_cache_read END) AS cost_cache_read, SUM(CASE WHEN cost > 0 THEN cost_cache_write END) AS cost_cache_write, SUM(CASE WHEN cost > 0 AND (cost_input IS NOT NULL OR cost_output IS NOT NULL OR cost_cache_read IS NOT NULL OR cost_cache_write IS NOT NULL) THEN 1 ELSE 0 END) AS split FROM placed WHERE @scope = 'all' OR kind = @scope GROUP BY day, provider, model, model_source, cost_source, kind, known_task":
    {
      walks: ["SCAN u", "USE TEMP B-TREE FOR GROUP BY"],
      reason: "the usage ledger's totals, read when the captain opens Settings, Usage",
    },
  "WITH recorded AS ( SELECT u.* FROM usage_events u JOIN tasks t ON t.id = u.task_id WHERE u.task_id <> @firstmate AND (@since IS NULL OR u.at >= @since) ) SELECT COUNT(DISTINCT task_id) AS matching FROM recorded":
    {
      walks: ["SCAN u USING COVERING INDEX usage_events_task"],
      reason: "the usage ledger's per-task count, read when the captain opens Settings, Usage",
    },
  "WITH recorded AS ( SELECT u.* FROM usage_events u JOIN tasks t ON t.id = u.task_id WHERE u.task_id <> @firstmate AND (@since IS NULL OR u.at >= @since) ), summed AS ( SELECT task_id, COUNT(*) AS records, SUM(input IS NOT NULL OR output IS NOT NULL OR cache_read IS NOT NULL OR cache_write IS NOT NULL) AS counted, COUNT(input) AS reported_input, COUNT(output) AS reported_output, COUNT(cache_read) AS reported_cache_read, COUNT(cache_write) AS reported_cache_write, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write, SUM(CASE WHEN cost > 0 THEN cost END) AS cost, SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS priced, SUM(CASE WHEN cost > 0 THEN cost_input END) AS cost_input, SUM(CASE WHEN cost > 0 THEN cost_output END) AS cost_output, SUM(CASE WHEN cost > 0 THEN cost_cache_read END) AS cost_cache_read, SUM(CASE WHEN cost > 0 THEN cost_cache_write END) AS cost_cache_write, SUM(CASE WHEN cost > 0 AND (cost_input IS NOT NULL OR cost_output IS NOT NULL OR cost_cache_read IS NOT NULL OR cost_cache_write IS NOT NULL) THEN 1 ELSE 0 END) AS split, SUM(CASE WHEN cost > 0 AND cost_input IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_input, SUM(CASE WHEN cost > 0 AND cost_output IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_output, SUM(CASE WHEN cost > 0 AND cost_cache_read IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_cache_read, SUM(CASE WHEN cost > 0 AND cost_cache_write IS NOT NULL THEN 1 ELSE 0 END) AS cost_reported_cache_write FROM recorded GROUP BY task_id ) SELECT summed.*, t.key, t.title, t.created_at, p.name AS project FROM summed JOIN tasks t ON t.id = summed.task_id LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.created_at DESC, t.id DESC LIMIT @limit":
    {
      walks: ["SCAN u USING INDEX usage_events_task", "USE TEMP B-TREE FOR ORDER BY"],
      reason: "the usage ledger's per-task rows, read when the captain opens Settings, Usage",
    },
  "SELECT task_id, provider, model, COUNT(*) AS records, SUM(input IS NOT NULL OR output IS NOT NULL OR cache_read IS NOT NULL OR cache_write IS NOT NULL) AS counted, COUNT(input) AS reported_input, COUNT(output) AS reported_output, COUNT(cache_read) AS reported_cache_read, COUNT(cache_write) AS reported_cache_write, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write, SUM(CASE WHEN cost > 0 THEN cost END) AS cost, SUM(CASE WHEN cost > 0 THEN 1 ELSE 0 END) AS priced, SUM(CASE WHEN cost > 0 THEN cost_input END) AS cost_input, SUM(CASE WHEN cost > 0 THEN cost_output END) AS cost_output, SUM(CASE WHEN cost > 0 THEN cost_cache_read END) AS cost_cache_read, SUM(CASE WHEN cost > 0 THEN cost_cache_write END) AS cost_cache_write, SUM(CASE WHEN cost > 0 AND (cost_input IS NOT NULL OR cost_output IS NOT NULL OR cost_cache_read IS NOT NULL OR cost_cache_write IS NOT NULL) THEN 1 ELSE 0 END) AS split, SUM(input IS NOT NULL) AS reported_input, SUM(output IS NOT NULL) AS reported_output, SUM(cache_read IS NOT NULL) AS reported_cache_read, SUM(cache_write IS NOT NULL) AS reported_cache_write, MAX(at) AS last_at, MIN(at) AS first_at, CASE WHEN SUM(model_source IS NULL) > 0 THEN 'historical' WHEN SUM(model_source = 'requested') > 0 THEN 'requested' ELSE 'served' END AS attribution FROM usage_events GROUP BY task_id, provider, model ORDER BY task_id, provider, model":
    {
      walks: ["SCAN usage_events USING INDEX usage_events_task", "USE TEMP B-TREE FOR GROUP BY"],
      reason: "the usage ledger's per-model rows, read when the captain opens Settings, Usage",
    },
  "SELECT id, name, path, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, runs_on, placement_requirements_json, scope, queue_workflows_json, queue_answered_at, queue_pending_at, queue_pause_json, contribution_json FROM repos ORDER BY added_at":
    {
      walks: ["SCAN repos", "USE TEMP B-TREE FOR ORDER BY"],
      reason: "one row per project the captain adds",
    },
  "SELECT id, origin FROM repos WHERE forge_kind = 'git' OR forge_kind IS NULL": {
    walks: ["SCAN repos"],
    reason: "one row per project the captain adds",
  },
  "SELECT id, name, path, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, runs_on, placement_requirements_json, scope, queue_workflows_json, queue_answered_at, queue_pending_at, queue_pause_json, contribution_json FROM repos WHERE origin = ? AND kind = 'project'":
    {
      walks: ["SCAN repos"],
      reason: "one row per project the captain adds",
    },
  "SELECT id, name, path, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, runs_on, placement_requirements_json, scope, queue_workflows_json, queue_answered_at, queue_pending_at, queue_pause_json, contribution_json FROM repos WHERE name = ?":
    {
      walks: ["SCAN repos"],
      reason: "one row per project the captain adds",
    },
  "SELECT id, name, path, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, runs_on, placement_requirements_json, scope, queue_workflows_json, queue_answered_at, queue_pending_at, queue_pause_json, contribution_json FROM repos WHERE origin = ? AND setup_kind = 'clone'":
    {
      walks: ["SCAN repos"],
      reason: "one row per project the captain adds",
    },
  "SELECT 1 FROM repos WHERE name = ?": {
    walks: ["SCAN repos"],
    reason: "one row per project the captain adds",
  },
};
