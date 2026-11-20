import type { AppDatabase } from "./db";

/** Frozen compatibility translation of the retired kind; runtime behavior reads only declared facts. */
export function migrateOngoingWork(db: AppDatabase): void {
  db.exec(`INSERT INTO task_contracts (task_id, value_json)
    SELECT task_id, '{"ongoing":true}' FROM task_routing_requests
    WHERE json_extract(value_json, '$.kind') = 'teach'
    ON CONFLICT(task_id) DO UPDATE SET value_json = json_set(task_contracts.value_json, '$.ongoing', json('true'));
    UPDATE task_routing_requests SET value_json = json_set(value_json,
      '$.kind', 'unclear', '$.intelligence', 'high')
    WHERE json_extract(value_json, '$.kind') = 'teach';`);
}
