/**
 * The dispatch extractor's cards (`scripts/extract-dispatch-corpus.ts`):
 * the version of a card that was shown, what its resolution says, and what
 * the captain's chosen action declared - read off the card's own actions,
 * never a table of reserved ids.
 */

import { LEGACY_CLOSE_CONTROL_IDS } from "../../src/shared/cardLeave.ts";
import { migrateLegacyActions } from "../../src/shared/cards.ts";
import type { CardRow } from "./fleetTables.ts";

type JsonRecord = Record<string, unknown>;

export type CardRevisionRow = {
  card_id: string;
  revision: number;
  kind: string;
  title: string;
  body: string;
  actions_json: string;
  created_at: number;
  replaced_at: number;
  replaced_by: string;
};

export type CardVersion = {
  kind: string;
  title: string;
  body: string;
  actions_json: string;
  basis: "current" | "revision";
};

export type CardVersionSource = Pick<CardRow, "kind" | "title" | "body" | "actions_json">;

/** `Card shown: <title> (<card id>)` → the card id the store assigned. */
export function cardIdFromEmitResult(text: string): string | null {
  const match = text.match(/^Card shown: .*\(([^()]+)\)\s*$/);
  return match?.[1] ?? null;
}

/** The card's declared actions, or an empty list when the row has none. */
export function declaredActionsOf(actionsJson: string | null | undefined): JsonRecord[] {
  if (!actionsJson) return [];
  try {
    const parsed = JSON.parse(actionsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is JsonRecord => !!a && typeof a === "object");
  } catch {
    return [];
  }
}

/** The captain's own dismissal id (`CrewSupervisor.dismissCard`). */
const CAPTAIN_DISMISS = "close";

/**
 * Whether an id that names no declared action was one of the pre-P1 CLOSE
 * CONTROLS (`dismiss`, `later`, `keep`). The answer comes from the one
 * shared list (`LEGACY_CLOSE_CONTROL_IDS`), so this file keeps no
 * reserved-id list of its own, and a historical dismissal still reads as
 * the dismissal it was.
 */
function wasCloseControl(id: string): boolean {
  return LEGACY_CLOSE_CONTROL_IDS.has(id);
}

/**
 * The words the HOST itself writes into `chosen_action` when a card leaves
 * the stack without anyone choosing anything: an emitter's `close_card`
 * default, the duplicate label, a recovered credential, resumed activity,
 * and the closed-task reasons a settle retires its cards with
 * (`CrewSupervisor.retireTaskCards`, `taskClosedReasonSchema`). None of
 * them is a captain answer.
 */
const HOST_WITHDRAWALS = new Set([
  "closed",
  "duplicate",
  "recovered",
  "activity-resumed",
  "dropped",
  "superseded",
  "landed",
  "merged",
  "answered",
  "settled",
  "finished",
  "cancelled",
  "discarded",
  "failed",
]);

/**
 * What a resolved card says, read off the card's OWN actions rather than a
 * table of reserved ids:
 *
 * - the stored `chosen_action` naming one of the card's declared actions is
 *   the captain choosing it;
 * - `close` is the captain's dismissal (the X control);
 * - anything else is a host or emitter withdrawal - `closed` (close_card),
 *   `duplicate`, `recovered`, `activity-resumed`, a settled task retiring
 *   its cards - and is NOT a captain answer, so it must never read as one.
 *
 * The reserved-id table this replaces mislabelled every current card: real
 * ids are free-form since P1, so "not one of the ids I know" had become
 * "the captain answered".
 */
export function resolutionOf(
  card: {
    resolved_at?: number | null;
    chosen_action?: string | null;
    actions_json?: string | null;
  },
  /**
   * The record's own `card_resolved` row, when the timeline has one. Its
   * actor label is the authority on WHO closed the card - the host writes
   * an emitter's `close_card` reason verbatim, so the string alone cannot
   * always say.
   */
  event?: { actor: string; action?: string } | null,
  options: { legacy?: boolean } = {},
): "open" | "acted" | "dismissed" | "retired" {
  if (card.resolved_at === null || card.resolved_at === undefined) return "open";
  if (event && event.actor !== "captain") return "retired";
  const chosen = card.chosen_action;
  const declared = declaredActionsOf(card.actions_json);
  if (
    !options.legacy &&
    event?.action &&
    event.action === chosen &&
    declared.some((action) => action.id === chosen)
  ) {
    return "acted";
  }
  if (event?.action === "dismissed") return "dismissed";
  if (event?.action === "withdrawn" || event?.action === "closed") return "retired";
  if (options.legacy) {
    if (!chosen || chosen === CAPTAIN_DISMISS || wasCloseControl(chosen)) return "dismissed";
    if (HOST_WITHDRAWALS.has(chosen)) return "retired";
    if (declared.some((action) => action.id === chosen)) return "acted";
    return "acted";
  }
  if (chosen && declared.some((action) => action.id === chosen)) return "acted";
  if (!chosen || chosen === CAPTAIN_DISMISS) return "dismissed";
  return "retired";
}

/**
 * The effect the chosen action declared, and what the click therefore did.
 * A `settle` effect is host-owned teardown (`CardActions.act`): the
 * crewmate is never steered by it, so recording one as a steer invents
 * captain contact that never happened.
 */
/** A merge (INF-2744's one effect, or a record's older request_merge) or a discard settles the task. */
function settles(kind: unknown): boolean {
  return kind === "settle" || kind === "merge" || kind === "request_merge";
}

export function chosenEffectOf(
  actions: JsonRecord[],
  chosen: string | null | undefined,
  resolution: "open" | "acted" | "dismissed" | "retired" | "unknown",
  options: { legacy?: boolean; cardId?: string | null; author?: string | null } = {},
): {
  chosen_effect: JsonRecord | null;
  effect_source: "declared" | "legacy-id" | null;
  captain_contact: "steer" | "settle" | "open" | "dismissed" | "withdrawn" | "none";
} {
  if (resolution === "open" || resolution === "unknown")
    return { chosen_effect: null, effect_source: null, captain_contact: "none" };
  if (resolution === "dismissed")
    return { chosen_effect: null, effect_source: null, captain_contact: "dismissed" };
  if (resolution === "retired")
    return { chosen_effect: null, effect_source: null, captain_contact: "withdrawn" };
  const action = actions.find((entry) => entry.id === chosen);
  const declared = action?.effect;
  if (declared && typeof declared === "object") {
    const effect = declared as JsonRecord;
    return {
      chosen_effect: effect,
      effect_source: options.legacy ? "legacy-id" : "declared",
      captain_contact: settles(effect.kind) ? "settle" : effect.kind === "open" ? "open" : "none",
    };
  }
  const legacyShape = action ?? (chosen ? { id: chosen, label: chosen } : undefined);
  const migrated =
    options.legacy && legacyShape ? migrateLegacyActions([legacyShape as never])[0] : undefined;
  const legacy = migrated?.effect as JsonRecord | undefined;
  if (legacy) {
    return {
      chosen_effect: legacy,
      effect_source: "legacy-id",
      captain_contact: settles(legacy.kind) ? "settle" : legacy.kind === "open" ? "open" : "none",
    };
  }
  const author = options.author ?? (options.cardId?.startsWith("card-fm-") ? "firstmate" : "crewmate");
  return {
    chosen_effect: null,
    effect_source: null,
    captain_contact: author === "crewmate" ? "steer" : "none",
  };
}

export function cardVersionAt(
  row: CardVersionSource,
  revisions: CardRevisionRow[],
  at: number,
): CardVersion | null {
  if (revisions.length === 0) {
    return {
      kind: row.kind,
      title: row.title,
      body: row.body,
      actions_json: row.actions_json,
      basis: "current",
    };
  }
  const revision = revisions.find((candidate) => at >= candidate.created_at && at < candidate.replaced_at);
  if (revision) {
    return {
      kind: revision.kind,
      title: revision.title,
      body: revision.body,
      actions_json: revision.actions_json,
      basis: "revision",
    };
  }
  const latest = revisions.at(-1);
  if (latest && at >= latest.replaced_at) {
    return {
      kind: row.kind,
      title: row.title,
      body: row.body,
      actions_json: row.actions_json,
      basis: "current",
    };
  }
  return null;
}

/** The one card row an emitted title names at the time it was shown, when only one does. */
export function pickByTitle(
  rows: CardRow[] | undefined,
  title: string,
  at: number,
  revisionsByCard: Map<string, CardRevisionRow[]>,
): CardRow | undefined {
  if (!rows || rows.length === 0) return undefined;
  const covering = rows.filter((row) => {
    if (row.created_at > at) return false;
    const version = cardVersionAt(row, revisionsByCard.get(row.id) ?? [], at);
    return version?.title === title;
  });
  return covering.length === 1 ? covering[0] : undefined;
}

/**
 * The word for a card emitted under one card shape (cards/tasks/agents P1):
 * nothing on the wire declares a kind, so a card with actions is a decision
 * and one without is a note - the same rule the host dresses it by. A
 * recorded session from before P1 still names its kind, and that name is
 * kept verbatim (the caller reads it first).
 */
export function cardWordOf(args: JsonRecord): "decision" | "note" {
  const actions = args.actions;
  return Array.isArray(actions) && actions.length > 0 ? "decision" : "note";
}
