/**
 * Recorded calls and rows in today's vocabulary (`./engine.ts`): what a
 * model or the host recorded under an older contract, replayed as what
 * it meant through today's tools and today's schema.
 */

import {
  preansweredQuestions,
  unmarkedSkippableQuestions,
  writeInGaps,
} from "../../src/core/pi/cardLint.ts";
import { groupSpawnArgs } from "../../src/core/pi/crewTools.ts";
import { legacyShapeFromDifficulty } from "../../src/core/routing/policy.ts";
import type { LegacyTaskStatus } from "../../src/core/tasks/seedTask.ts";
import { LEGACY_CLOSE_CONTROL_IDS } from "../../src/shared/cardLeave.ts";
import { type CardAction, isPreviewBody } from "../../src/shared/cards.ts";
import { migrateLegacyActions } from "../../src/shared/legacyCardActions.ts";
import type { IntelligenceBucket } from "../../src/shared/modelSlots.ts";
import { type WorkShape, workShapeSchema } from "../../src/shared/routingPolicy.ts";
import { stringColumn, type TableRow } from "../recorded-tables.ts";
import type { JsonRecord } from "./recording.ts";

/**
 * onCard's return can be a promise now that a merge decision on a
 * direct-pr task may clear a live CI gate first; replay never wires
 * `checkCi` (its mergePullRequest is a stub), so the gate never applies
 * here and every card resolves synchronously, exactly as before.
 */
export function syncCardId(
  id: string | { cardId: string } | Promise<unknown> | undefined,
): string | undefined {
  if (id instanceof Promise) {
    throw new Error("replay does not expect a pending CI gate on a recorded card");
  }
  // A write on someone else's card answers its typed result, which names the card.
  return typeof id === "object" ? id.cardId : id;
}

/**
 * A recorded spawn in today's vocabulary: v2.8's facts, grouped as v4.12
 * serves them. `premium_ask` and
 * `override_model_id` are the two facts a pre-S2 spawn really carried:
 * `difficulty: premium` was only ever set because the captain asked in
 * words (the v2.7 routing rule), and `model_id` is the same override under
 * its old name. A judged low/medium/high carried no fact the policy reads,
 * so it drops and the work routes as `unclear` does - which is the
 * contract change the baseline is expected to move for.
 */
export function recordedShape(args: JsonRecord): void {
  const shape = legacyShapeFromDifficulty(
    typeof args.difficulty === "string" ? (args.difficulty as IntelligenceBucket) : null,
    typeof args.model_id === "string" ? args.model_id : null,
  );
  delete args.difficulty;
  delete args.model_id;
  if (shape.premium_ask) args.premium_ask = true;
  if (shape.override_model_id) args.override_model_id = shape.override_model_id;
  // A recording from before contract v4.12 carries the work-shape facts and
  // the waits flat; today's tool groups them under `shape` and
  // `start_after`, and a grouped recording passes through as it is.
  const grouped = groupSpawnArgs(args);
  for (const key of Object.keys(args)) delete args[key];
  Object.assign(args, grouped);
  // A recorded session predates delivery rigor (phase 2): nothing derived a
  // tier and no reviewer ran, so the spawn replays as the quick work it was
  // - through the one ask channel the tool has - rather than as a reviewed
  // task whose reports would skip the supervision the recording answers.
  const facts = (args.shape ?? {}) as JsonRecord;
  if (shape.rigor && facts.rigor_ask === undefined) {
    args.shape = { ...facts, rigor_ask: shape.rigor };
  }
}

/** A recorded row's work shape, read through today's schema; null when it carries none. */
export function seededShape(raw: string | null): WorkShape | null {
  if (!raw) return null;
  try {
    const parsed = workShapeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A recorded decision's questions in today's authoring (contract 4.56).
 * Until then CARD_AUTHORING told the author to check or select the option
 * it proposed, so a recorded decision can ask a required question already
 * answered, which today's lint refuses (FI3-309's plan card asked nine).
 * What it checked or selected was its proposal, and today's author marks
 * that `data-inf-recommended` instead - the frame bridge reads the mark as
 * the proposal - with a select opening on an empty Choose option. Until
 * FI3-1002 no author ended a question with a Something else row either, and
 * today's lint refuses a question with options and none, so the row is added
 * where today's author writes it: past the question's last row. Until
 * INF-4425 a question the captain could skip needed no marked option, and
 * today's lint refuses one with none, so that question becomes required. Like
 * `recordedActions`, this replays what the author meant through today's
 * tool. Only the start tags the lint names move and the rows it asks for
 * are added; every other byte stays as recorded, and a card the lint would
 * pass is returned unchanged.
 */
export function recordedQuestions(body: string, actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0 || isPreviewBody(body)) return body;
  const edits: { at: number; end: number; text: string }[] = [];
  for (const gap of writeInGaps(body)) {
    if (gap.at < 0) continue;
    edits.push({ at: gap.at, end: gap.at, text: somethingElseRow(gap) });
  }
  for (const question of preansweredQuestions(body)) {
    for (const pick of question.picks) {
      const tag = START_TAG.exec(body.slice(pick.at))?.[0];
      if (!tag) continue;
      edits.push({ at: pick.at, end: pick.at + tag.length, text: markRecommended(tag, pick) });
    }
    for (const at of question.chooseAt) {
      const tag = START_TAG.exec(body.slice(at))?.[0];
      if (tag) edits.push({ at: at + tag.length, end: at + tag.length, text: CHOOSE_OPTION });
    }
  }
  // Until INF-4425 a skipped question sent no answer, and today's lint
  // refuses one the captain may skip with no marked option. The recorded
  // author asked for the captain's answer and named no option to act on,
  // which today's author writes as a required question.
  for (const question of unmarkedSkippableQuestions(body)) {
    const tag = START_TAG.exec(body.slice(question.at))?.[0];
    if (!tag) continue;
    const required = tag.replace(/\s*\/?>$/, (end) => ` required${end}`);
    edits.push({ at: question.at, end: question.at + tag.length, text: required });
  }
  // From the end backwards, so every offset still names the recorded byte;
  // at one offset the tag's own edit goes before an insertion in front of it.
  edits.sort((a, b) => b.at - a.at || b.end - a.end);
  return edits.reduce((text, edit) => text.slice(0, edit.at) + edit.text + text.slice(edit.end), body);
}

const CHOOSE_OPTION = '<option value="">Choose</option>';

/** The Something else row today's author ends a question with (FI3-1002). */
function somethingElseRow(gap: { name: string; control: "radio" | "checkbox" | "select" }): string {
  if (gap.control === "select") return '<option value="other" data-inf-write-in>Something else</option>';
  const name = gap.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<label><input type="${gap.control}" name="${name}" value="other" data-inf-write-in> Something else</label>`;
}
/** One start tag at the head of a string: its name, then each attribute, quoted values whole. */
const START_TAG = /^<[a-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/i;
const TAG_ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

/** The start tag with its written pick turned into the recommendation mark, or the mark added. */
function markRecommended(
  tag: string,
  pick: { attribute: "checked" | "selected"; written: boolean },
): string {
  if (!pick.written) return tag.replace(/\s*\/?>$/, (end) => ` data-inf-recommended${end}`);
  const head = /^<[^\s/>]+/.exec(tag)?.[0] ?? "";
  const rest = tag.slice(head.length);
  return (
    head +
    rest.replace(TAG_ATTRIBUTE, (whole, name: string) =>
      name.toLowerCase() === pick.attribute ? " data-inf-recommended" : whole,
    )
  );
}

/**
 * A recorded card's actions in P1's vocabulary. The sessions were recorded
 * under the reserved-id contract, so the ids the host used to dispatch on
 * (merge-pr, land, discard, open-settings, ...) become the effects they
 * meant - `migrateLegacyActions`, the same mapping migration 29 runs over
 * an upgraded database. A recorded `keeps_open` action loses only its flag,
 * retired at contract 4.65: it stays the effect-free reply it is today,
 * whose click returns to its author with the captain's answers, as the
 * button asked. It was one of the card's 2 or 3 actions when recorded, so
 * dropping it would leave a recorded decision a lone action the count
 * refuses (FI3-411; FI3-309's plan card offered Agree and Use these
 * answers). A recorded click on one would close the card where the old
 * button kept it open; no committed recording has one. A lookalike id
 * ("merge-pr55") stays a reply with no effect, which is exactly what the
 * fake-button metric counts.
 */
export function recordedActions(raw: unknown): CardAction[] {
  if (!Array.isArray(raw)) return [];
  const actions = raw
    .filter(
      (action): action is JsonRecord =>
        !!action && typeof action === "object" && typeof (action as JsonRecord).id === "string",
    )
    .map(({ keeps_open: _retired, ...action }) => action as unknown as CardAction);
  // A recorded close control (`later`, `keep`, `dismiss`) duplicated the ×
  // every card had when it was recorded, so the replay keeps reading it as
  // that close, not as a choice (INF-3108 keeps them on live cards).
  return migrateLegacyActions(actions).filter(
    (action) => action.effect || !LEGACY_CLOSE_CONTROL_IDS.has(action.id),
  );
}

/**
 * A recorded first mate card's attribution in INF-2714's vocabulary. The
 * sessions were recorded when a note named the task it was about as its own
 * (`task_id`) or asserted it was about none (`standalone`); today a note is
 * the first mate's own card and names its tasks in `related`, so a recorded
 * note's task becomes its related task and the retired assertion drops. A
 * decision keeps its task, which its buttons act on, and so does a review
 * relay. Edits `args` in place.
 */
export function recordedAttribution(args: JsonRecord): void {
  delete args.standalone;
  const actions = Array.isArray(args.actions) ? args.actions : [];
  if (actions.length > 0 || typeof args.task_id !== "string" || args.review_task_id) return;
  const related = Array.isArray(args.related) ? args.related : [];
  args.related = [...related, args.task_id];
  delete args.task_id;
}

export function legacyStateOf(row: TableRow): { status: LegacyTaskStatus; worktree: boolean } | null {
  const status = stringColumn(row, "status");
  const activity = stringColumn(row, "activity");
  const reason = stringColumn(row, "closed_reason");
  const worktree =
    stringColumn(row, "workspace_state") === "present" ||
    (stringColumn(row, "workspace_state") === null && Boolean(stringColumn(row, "worktree_dir")));
  switch (status) {
    case "queued":
    case "running":
    case "idle":
    case "interrupted":
    case "completed":
    case "cancelled":
    case "failed":
      return { status, worktree };
    case "open":
      return { status: "queued", worktree: false };
    case "active":
      return {
        status: activity === "interrupted" ? "interrupted" : activity === "running" ? "running" : "idle",
        worktree: true,
      };
    case "delivered":
      return { status: "completed", worktree: true };
    case "done":
      return { status: "completed", worktree: false };
    case "dropped":
      return { status: reason === "failed" ? "failed" : "cancelled", worktree };
    default:
      return null;
  }
}
