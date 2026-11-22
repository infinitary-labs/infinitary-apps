/**
 * A task's delivery facts as three records (INF-1296 piece 4,
 * `docs/task-record.md` "A task's change evidence and permissions"):
 *
 * - its change evidence, one `task_delivery_evidence` row: how it delivers
 *   and the change's identity, the version its readings were taken at, the
 *   checks, reviews, repair and round ledgers, live validation, the
 *   published story, its risk and the watches;
 * - its permissions and effects, one `task_permissions` row: the
 *   captain's merge approval with its lineage and the attempt in flight,
 *   the completion offers a click approves, reviewed pull requests a
 *   merge card may name, write asks, required actions, the
 *   captain's override, a refused card, the validation permissions with
 *   their effect states, and a settle that has not run;
 * - what stays on the delivery column as history: the closed policy
 *   snapshot and an older release's copy of the latest result.
 *
 * The current turn's declarations are the execution record's
 * (`TURN_DECLARATION_FIELDS`). A record reads every field where it read it
 * before, so no reader changes. This file imports nothing at run time, so
 * the offline tools under `scripts/` read a saved database through it too.
 */

/** The delivery fields that are permissions or effects, and the column each is saved in. */
export const PERMISSION_COLUMNS = {
  mergeAuthorization: "merge_authorization_json",
  mergeOrder: "merge_order_json",
  completionOffers: "completion_offers_json",
  mergeReviews: "merge_reviews_json",
  checkTarget: "check_target_json",
  writeAsks: "write_asks_json",
  requiredActionOffer: "required_action_offer_json",
  captainAction: "captain_action_json",
  cardRefusal: "card_refusal_json",
  override: "override_json",
} as const;
export type PermissionField = keyof typeof PERMISSION_COLUMNS;

/** The delivery fields that stay on the delivery column: history, never live input. */
export const HISTORY_FIELDS = ["closedPolicies", "result"] as const;

/** The fields the turn's declarations hold; the execution record keeps them, not these records. */
const TURN_FIELDS = new Set(["captainWait", "finishedAt", "needsFirstmate", "checkBack"]);

/** The format of an evidence row; a later format names its own number. */
export const EVIDENCE_FORMAT = 1;

export type EvidenceRow = {
  task_id: string;
  format: number;
  mode: string | null;
  head_sha: string | null;
  evidence_json: string | null;
};

export type PermissionRow = { task_id: string } & Record<
  | (typeof PERMISSION_COLUMNS)[PermissionField]
  | "validation_permissions_json"
  | "pending_settle_json",
  string | null
>;

type Values = Record<string, unknown>;

/**
 * A delivery split into the three records. Every value moves exactly as
 * saved, a null included, so it reads back the same; a field this build
 * does not know is evidence. `mode` and `headSha` get columns of their own
 * only when they are text. The live validation's permissions leave its
 * evidence for the permission record. A turn declaration is the caller's
 * to split off first; one left here stays with the history.
 */
export function splitDelivery(delivery: object): {
  history: Values;
  evidence: Omit<EvidenceRow, "task_id"> | null;
  permissions: Partial<Record<keyof Omit<PermissionRow, "task_id">, string>> | null;
} {
  const history: Values = {};
  const evidence: Values = {};
  const permissions: Partial<Record<keyof Omit<PermissionRow, "task_id">, string>> = {};
  let mode: string | null = null;
  let headSha: string | null = null;
  for (const [field, value] of Object.entries(delivery)) {
    if (value === undefined) continue;
    if ((HISTORY_FIELDS as readonly string[]).includes(field) || TURN_FIELDS.has(field)) {
      history[field] = value;
    } else if (field in PERMISSION_COLUMNS) {
      permissions[PERMISSION_COLUMNS[field as PermissionField]] = JSON.stringify(value);
    } else if (field === "mode" && typeof value === "string") {
      mode = value;
    } else if (field === "headSha" && typeof value === "string") {
      headSha = value;
    } else if (
      field === "liveValidation" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "permissions")
    ) {
      const { permissions: granted, ...rest } = value as Values;
      if (granted !== undefined) permissions.validation_permissions_json = JSON.stringify(granted);
      evidence[field] = rest;
    } else {
      evidence[field] = value;
    }
  }
  const hasEvidence = mode !== null || headSha !== null || Object.keys(evidence).length > 0;
  return {
    history,
    evidence: hasEvidence
      ? {
          format: EVIDENCE_FORMAT,
          mode,
          head_sha: headSha,
          evidence_json: Object.keys(evidence).length > 0 ? JSON.stringify(evidence) : null,
        }
      : null,
    permissions: Object.keys(permissions).length > 0 ? permissions : null,
  };
}

function parsed(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function evidenceFields(row: Omit<EvidenceRow, "task_id"> | undefined): Values {
  if (!row) return {};
  const evidence = parsed(row.evidence_json);
  return {
    ...(row.mode !== null ? { mode: row.mode } : {}),
    ...(evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {}),
    ...(row.head_sha !== null ? { headSha: row.head_sha } : {}),
  };
}

export function permissionFields(
  row: Partial<Omit<PermissionRow, "task_id">> | undefined,
  liveValidation: unknown,
): Values {
  if (!row) return {};
  const fields: Values = {};
  for (const [field, column] of Object.entries(PERMISSION_COLUMNS)) {
    const value = parsed(row[column]);
    if (value !== undefined) fields[field] = value;
  }
  const granted = parsed(row.validation_permissions_json);
  if (
    granted !== undefined &&
    liveValidation &&
    typeof liveValidation === "object" &&
    !Array.isArray(liveValidation)
  )
    fields.liveValidation = { ...liveValidation, permissions: granted };
  return fields;
}

/**
 * A delivery as it is read: the history its column keeps, its evidence and
 * its permissions. Null exactly when the column is: a task with no
 * delivery facts has no records.
 */
export function composeDelivery(
  history: Values | null,
  evidence: Omit<EvidenceRow, "task_id"> | undefined,
  permissions: Partial<Omit<PermissionRow, "task_id">> | undefined,
): Values | null {
  if (!history) return null;
  const changes = evidenceFields(evidence);
  const delivery = {
    ...history,
    ...changes,
    ...permissionFields(permissions, changes.liveValidation),
  };
  // Captain INF-1555 F12: discard only the obsolete current cache.
  // Its old declarations and timeline remain history, never merge authority.
  delete delivery.crewVerdict;
  return delivery;
}

type SavedDatabase = {
  prepare(sql: string): { get(): unknown; all(): unknown[] };
};

/**
 * For a tool that reads a saved database's `tasks` rows itself: each row's
 * `delivery_json` as the app reads its delivery facts, its change evidence
 * and permissions in it (INF-1296 piece 4). A database from before those
 * records kept them in the column already, so its rows read unchanged.
 */
export function savedDeliveryReader(
  db: SavedDatabase,
): (taskId: string, deliveryJson: string | null) => string | null {
  const has = (table: string) =>
    Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).get(),
    );
  if (!has("task_delivery_evidence")) return (_taskId, deliveryJson) => deliveryJson;
  const evidence = new Map(
    (db.prepare("SELECT * FROM task_delivery_evidence").all() as EvidenceRow[]).map((row) => [
      row.task_id,
      row,
    ]),
  );
  const permissions = new Map(
    (db.prepare("SELECT * FROM task_permissions").all() as PermissionRow[]).map((row) => [
      row.task_id,
      row,
    ]),
  );
  return (taskId, deliveryJson) => {
    const history = parsed(deliveryJson);
    if (!history || typeof history !== "object" || Array.isArray(history)) return deliveryJson;
    return JSON.stringify(
      composeDelivery(history as Values, evidence.get(taskId), permissions.get(taskId)),
    );
  };
}
