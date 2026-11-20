import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { routingSettingsSchema } from "@shared/quota";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import type { AppDatabase } from "./db";

/** Carry the two effects of the former Off choice into their separate owners. */
export function migrateAlwaysRoute(db: AppDatabase): void {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'routing'").get() as
    | { value: string }
    | undefined;
  if (!row) return;
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return;
  }
  const parsed = routingSettingsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.dynamicRouting) return;
  const dormantPins = parsed.data.pins;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'routing'").run(
    JSON.stringify({
      dynamicRouting: true,
      pins: [],
      ...(dormantPins.length ? { dormantPins } : {}),
    }),
  );

  // Home is stored as null on projects. Do not touch explicit devices.
  db.prepare("UPDATE repos SET runs_on = NULL WHERE runs_on = ?").run(AUTOMATIC_COMPUTER);

  // A task can override its project directly or inherit a choice from a
  // parent. Walk only unstarted work and stop at its nearest choice. Do not
  // rewrite a started ancestor just to keep its queued child at home.
  // Published views are down while each migration runs; read the owners.
  const placement = `SELECT t.id, t.parent_id, json_extract(p.value_json, '$.runs_on_ask') AS ask
    FROM tasks t LEFT JOIN task_placement_requests p ON p.task_id = t.id`;
  const queued = db
    .prepare(`${placement}
    LEFT JOIN task_execution e ON e.task_id = t.id
    WHERE t.status = 'open' AND t.kind = 'work' AND t.branch = '' AND e.session_file IS NULL
      AND e.placement_json IS NULL AND e.device_id IS NULL
  `)
    .all() as PlacementRow[];
  const read = db.prepare(`${placement} WHERE t.id = ?`);
  const keepHere = db.prepare(`
    INSERT INTO task_placement_requests (task_id, value_json)
    VALUES (?, json_object('runs_on_ask', ?))
    ON CONFLICT(task_id) DO UPDATE SET
      value_json = json_set(value_json, '$.runs_on_ask', excluded.value_json ->> '$.runs_on_ask')
  `);
  for (const task of queued) {
    const seen = new Set<string>();
    let at: PlacementRow | undefined = task;
    while (at && !at.ask && at.parent_id && !seen.has(at.id)) {
      seen.add(at.id);
      at = read.get(at.parent_id) as PlacementRow | undefined;
    }
    if (at?.ask === AUTOMATIC_COMPUTER) keepHere.run(task.id, RUNS_ON_THIS_MAC);
  }
}

type PlacementRow = { id: string; parent_id: string | null; ask: string | null };
