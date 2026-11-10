import {
  CARD_CONTRIBUTIONS_VERSION,
  CREW_RESPONSE_VERSION,
  openInMemoryDatabase,
  TASK_PIN_VERSION,
  TASK_RECORD_RETIREMENT_VERSION,
  TOOL_REPETITION_VERSION,
} from "../../src/core/storage/db";
import { SHAPE_RECORD_TABLES } from "../../src/core/storage/taskOwnedShapeStore";
import { RETIRED_TASK_COLUMNS } from "../../src/core/storage/taskRecordProjection";

/**
 * Fixture-only: reconstruct the exact predecessor schema, never a supported
 * app downgrade. The rebuilt task table has no column a later migration
 * added, so each such migration is marked not run and runs again on the
 * upgrade, as it would for a profile that release saved.
 */
export function taskRecordRetirementReverseSql(): string {
  const old = openInMemoryDatabase(TASK_RECORD_RETIREMENT_VERSION - 1);
  try {
    const schema = old
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .pluck()
      .get() as string;
    const columns = old.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const indexes = old
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL",
      )
      .pluck()
      .all() as string[];
    const kept = new Set([
      "goal",
      "intent_json",
      "prompt",
      "shape_json",
      "delivery_json",
      "pending_settle_json",
    ]);
    const select = columns
      .map(({ name }) => {
        if (!(RETIRED_TASK_COLUMNS as readonly string[]).includes(name) || kept.has(name))
          return name;
        if (name === "recovery_rung" || name === "recovery_count") return `0 AS ${name}`;
        return `NULL AS ${name}`;
      })
      .join(",");
    return `PRAGMA foreign_keys = OFF;
      CREATE TEMP TABLE retired_task_rows AS SELECT ${select} FROM task_records;
      DROP VIEW task_records;
      DROP TABLE task_session_observations;
      DROP INDEX task_events_identity;
      ALTER TABLE task_events DROP COLUMN identity;
      DROP TABLE IF EXISTS card_contributions;
      DROP INDEX IF EXISTS card_messages_answers;
      ALTER TABLE card_messages DROP COLUMN contributor_json;
      ALTER TABLE card_messages DROP COLUMN answers_message;
      ALTER TABLE card_messages DROP COLUMN clarification;
      ALTER TABLE card_messages DROP COLUMN response_id;
      DELETE FROM schema_migrations WHERE version = ${CARD_CONTRIBUTIONS_VERSION};
      DROP TABLE IF EXISTS crew_responses;
      DROP TABLE IF EXISTS response_requests;
      DELETE FROM schema_migrations WHERE version = ${CREW_RESPONSE_VERSION};
      DROP TABLE IF EXISTS task_repetition_cursors;
      DROP TABLE IF EXISTS task_repetitions;
      DELETE FROM schema_migrations WHERE version = ${TOOL_REPETITION_VERSION};
      DROP TABLE tasks;
      ${schema};
      INSERT INTO tasks (${columns.map(({ name }) => name).join(",")}) SELECT * FROM retired_task_rows;
      DROP TABLE retired_task_rows;
      ${indexes.join(";\n")};
      ${[...SHAPE_RECORD_TABLES, "task_specifications", "task_record_history"].map((table) => `DROP TABLE ${table};`).join("\n")}
      DELETE FROM schema_migrations WHERE version = ${TASK_RECORD_RETIREMENT_VERSION};
      DELETE FROM schema_migrations WHERE version = ${TASK_PIN_VERSION};
      PRAGMA foreign_keys = ON;\n`;
  } finally {
    old.close();
  }
}
