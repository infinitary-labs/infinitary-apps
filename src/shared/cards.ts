import { z } from "zod";
import { afterMergeShownListSchema } from "./afterMerge.ts";
import { cardFileSchema } from "./cardFiles.ts";
import { cardCornerSchema, noteDoneSchema } from "./cardLeave.ts";
import { cardNotesSchema, pointedAtLines } from "./cardNotes.ts";
import { cardEndedSchema } from "./endedCard.ts";
import { HOST_OPS } from "./hostOps.ts";
import { servedNumber } from "./i18n/format.ts";
import * as m from "./i18n/messages.generated.ts";
import { putOffUntilSchema } from "./putOff.ts";
import { requiredActionsSchema } from "./requiredActions.ts";
import { rigorSchema } from "./rigor.ts";
import { SETTLE_FACTS_OPEN } from "./settleFacts.ts";
import { throughSchema } from "./through.ts";

export {
  SETTLE_FACT_VALUE_CLASS,
  SETTLE_FACTS,
  SETTLE_FACTS_OPEN,
  SETTLE_LEVELS,
  type SettleFact,
  type SettleLevel,
  splitSettleFacts,
} from "./settleFacts.ts";

/** Eligibility uses the shown version, never the pending durable head. */
export function isReadyDecision(card: Card): boolean {
  return !card.awaiting && card.actions.length > 0;
}

/**
 * The card model (decision D-9; cards/tasks/agents P1, captain ruling D1 a):
 * ONE card shape on the wire. There is no `kind`. A card with actions is a
 * decision, a card without is a note, and a card the host itself authored -
 * the agent-down set - reads as attention; the badge is derived from the
 * actions and the author (`cardPresentation`), never declared.
 *
 * What an action DOES is its `effect` (ruling D2: settle and open are the
 * only host semantics an agent may declare). The host dispatches on the
 * effect and never on an action id: an action with no effect is a reply
 * that returns to its author - an [fm-op] for a Firstmate card, a steer for
 * a crewmate's. The `host` effect is the agent-down cards' own (sign in,
 * move the flagship, retry the failed turn) and every emit boundary refuses
 * it.
 */

/**
 * A host-run discard: the task closes unmerged and its working copy goes.
 * `confirm` discards work the body already says is unlanded (the host's
 * own confirm gate). `proceedWithOpen` is P2's (WI-11) close over open
 * follow-ups.
 */
export const settleEffectSchema = z.object({
  kind: z.literal("settle"),
  mode: z.literal("discard"),
  confirm: z.literal(true).optional(),
  proceedWithOpen: z.literal(true).optional(),
});
export type SettleEffect = z.infer<typeof settleEffectSchema>;

/**
 * The one merge request (INF-2744, the captain's "every request to merge a
 * PR should be raised through the exact same ... card"): every merge card
 * carries it, whichever change it merges and whoever asked. Declaring it
 * grants no approval and merges nothing; the merge gate decides
 * (`SettleService.mergeGate`).
 *
 * - `review` names the change: the id `check_change` stored for a pull
 *   request. Absent, it is the task's current change - its pull request, or
 *   its branch on a project that merges locally - which the host resolves
 *   from the task's delivery, so no agent learns merge-pr from land.
 * - `after` is what follows for the task, the crewmate's declaration: the
 *   merge closes it, or it continues. An open question or another open pull
 *   request on the task keeps it open either way (INF-2525).
 * - `asksFirst` keeps a task whose autonomy is on from merging on its own:
 *   the crewmate names the standing direction whose exception this merge
 *   is, and the card waits for the captain's click.
 * - `proceedWithOpen` merges past open follow-ups (WI-11).
 */
export const mergeEffectSchema = z.object({
  kind: z.literal("merge"),
  review: z.string().min(1).max(64).optional(),
  after: z.enum(["close", "continue"]),
  asksFirst: z.string().min(1).max(400).optional(),
  proceedWithOpen: z.literal(true).optional(),
});
export type MergeEffect = z.infer<typeof mergeEffectSchema>;

/**
 * A request to send one write a crewmate asked for where a project lives
 * (FI3-1571 piece 4). Declaring it sends nothing. `ask` is the id
 * `github_write` kept; the host resolves the exact call from that record,
 * draws it on the card and names the button, and only the captain's click
 * sends it, once.
 */
export const requestWriteEffectSchema = z.object({
  kind: z.literal("request_write"),
  ask: z.string().min(1).max(64),
  /**
   * Only the host's integration approval card declares the duration or
   * refusal; `task` allows it for the rest of the asking task, sent only to
   * a view that lists `integration-task-allow` (INF-2993).
   */
  integration: z.enum(["always", "task", "once", "deny"]).optional(),
});
export type RequestWriteEffect = z.infer<typeof requestWriteEffectSchema>;

/**
 * The shell opens Settings, on the named section. `signIn` names a host
 * whose sign-in Settings -> Projects starts on arrival (git integration
 * PR 1.2), so the code is already on screen when the section opens.
 * `make` and `remove` are what Settings -> Devices does on arrival
 * (docs/devices.md, "Asking the first mate"): make a link or a command there,
 * which the card never holds, or remove the device with that id. `signInOn` names a
 * computer that runs work and a subscription whose sign-in Settings ->
 * Intelligence starts there on arrival (docs/helper.md, "Its own
 * sign-ins"). Only the host's own cards carry `devices` or `signInOn`; no
 * agent's tool offers either.
 */
/**
 * What Settings -> Devices makes on arrival from a card's button
 * (docs/devices.md, "Asking the first mate"): a link, the command for another
 * Mac, or the command for another user on this Mac.
 */
export const deviceMakeSchema = z.enum(["link", "command", "user-command"]);
export type DeviceMake = z.infer<typeof deviceMakeSchema>;

/**
 * What Settings -> Devices does on arrival from a card's button, carried
 * from the card's open effect: make a link or a command, remove a device,
 * add the Mac at an address over Remote Login, or update Firstmate on a Mac
 * added that way.
 */
export type DeviceArrival =
  | { make: DeviceMake | "phone" }
  | { remove: string }
  | { add: string }
  | { update: string };

/** The arrival an open effect on Devices carries, as the store keeps it. */
export function deviceArrival(effect: {
  make?: DeviceMake | undefined;
  phone?: true | undefined;
  remove?: string | undefined;
  add?: string | undefined;
  update?: string | undefined;
}): { pendingDeviceArrival: DeviceArrival } | Record<string, never> {
  // A phone's link is its own field, so a view from before opens Devices and makes nothing.
  if (effect.phone) return { pendingDeviceArrival: { make: "phone" } };
  if (effect.make) return { pendingDeviceArrival: { make: effect.make } };
  if (effect.remove) return { pendingDeviceArrival: { remove: effect.remove } };
  if (effect.add) return { pendingDeviceArrival: { add: effect.add } };
  if (effect.update) return { pendingDeviceArrival: { update: effect.update } };
  return {};
}

export const signInOnSchema = z.object({
  deviceId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(256),
});

/**
 * A computer that runs work and a host where projects live whose sign-in
 * Settings starts there on arrival (docs/forge.md, "A computer's own
 * sign-in"): the effect names `projects`, which lands on Settings ->
 * Integrations (`openedSection`), and the code to read opens under that
 * computer's row. Only the host's own cards carry it.
 */
export const forgeSignInOnSchema = z.object({
  deviceId: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
});

/**
 * The exact place in Settings a host card's button opens, beside what the
 * target already says (primitives/app-actions.md, "Hand over"): `section`
 * names the section when the target does not (Secrets, Automation,
 * Integrations), `item` what that section shows on arrival, as a panel's
 * `point.openSettings` names it (a project's id in Projects, a computer's in
 * Devices, a page in Secrets, `kept:<id>` in Automation, `inbox` in
 * Integrations), and `phone` asks Devices to make a phone's link on
 * arrival. `fromHome` says the act there is only on the first mate's own
 * computer, as Settings shows it: a computer that controls the first mate
 * keeps the card up and says where to choose it. Each is optional, so a
 * view from before opens the target's section as it did. Only the host's
 * own cards carry them.
 */
const settingsPlaceShape = {
  section: z.string().min(1).max(64).optional(),
  item: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\r\n]*$/)
    .optional(),
  phone: z.literal(true).optional(),
  fromHome: z.literal(true).optional(),
};

/**
 * An open effect: Settings on a section, or - on a crewmate's card that asks the captain to take
 * over its task's browser - that browser's view with the captain in control (`browser`,
 * docs/task-browser.md "Asking for help"), the card's own attachment naming which browser. With
 * `savedSignIn` the browser gets the captain's saved sign-in for its site instead and goes back to
 * its crewmate ("Signed-in sites"); only the host adds that action.
 */
export const openEffectSchema = z.object({
  kind: z.literal("open"),
  target: z.enum(["settings", "subscriptions", "projects", "devices", "browser"]),
  folder: z.literal(true).optional(), // A Choose folder button on projects (docs/fleet.md)
  savedSignIn: z.literal(true).optional(),
  signIn: z.string().min(1).max(253).optional(),
  make: deviceMakeSchema.optional(),
  remove: z.string().min(1).max(64).optional(),
  // The address, as the line's own value schema read it (`remoteLoginAddressSchema`);
  // `inf:devices:add` reads it again before anything is reached.
  add: z.string().min(1).max(255).optional(),
  update: z.string().min(1).max(64).optional(),
  privateSite: z.string().min(1).max(253).optional(),
  signInOn: signInOnSchema.optional(),
  forgeSignInOn: forgeSignInOnSchema.optional(),
  ...settingsPlaceShape,
});
export type OpenEffect = z.infer<typeof openEffectSchema>;

export { HOST_OPS };

/**
 * The host ops the task record's footer and the task board run, on one
 * task. `drop-task` is the footer's own, and `queue-task` and
 * `unqueue-task` the board's (src/shared/taskQueue.ts): none is a card host
 * effect.
 */
export const TASK_LIFECYCLE_OPS = [
  "answer-done",
  "dismiss-question",
  "start-task",
  "start-again",
  "stop-task",
  "continue-task",
  "drop-task",
  "queue-task",
  "unqueue-task",
  "show-card",
] as const;
export const taskLifecycleOpSchema = z.enum(TASK_LIFECYCLE_OPS);
export type TaskLifecycleOp = z.infer<typeof taskLifecycleOpSchema>;

/**
 * The graph effects the captain reviewed before Drop task. The host
 * recomputes the same lists and writes only when they still match.
 * `parts` is empty when the drop may proceed: open parts are refused.
 */
export const dropTaskReviewSchema = z.object({
  parts: z.array(z.string().min(1).max(64)).max(64),
  waiting: z.array(z.string().min(1).max(64)).max(64),
  underway: z.array(z.string().min(1).max(64)).max(64),
});
export type DropTaskReview = z.infer<typeof dropTaskReviewSchema>;

/**
 * Where a move on `inf:task:run` came from when a panel made it on the
 * captain's click or key (docs/ui-plugins.md, "A panel's cards"): the
 * panel's title, which the task's record names beside the move. Absent for
 * the task record's own buttons and the task board.
 */
export const taskMoveFromSchema = z.strictObject({ panel: z.string().min(1).max(40) });
export type TaskMoveFrom = z.infer<typeof taskMoveFromSchema>;

export const hostEffectSchema = z.object({
  kind: z.literal("host"),
  op: z.enum(HOST_OPS),
  arg: z.string().optional(),
});
export type HostEffect = z.infer<typeof hostEffectSchema>;

export const cardEffectSchema = z.discriminatedUnion("kind", [
  settleEffectSchema,
  mergeEffectSchema,
  requestWriteEffectSchema,
  openEffectSchema,
  hostEffectSchema,
]);
export type CardEffect = z.infer<typeof cardEffectSchema>;

/** The effects an agent may declare (D2): every kind but the host's own. */
export const agentEffectSchema = z.discriminatedUnion("kind", [
  settleEffectSchema,
  mergeEffectSchema,
  requestWriteEffectSchema,
  openEffectSchema,
]);
export type AgentEffect = z.infer<typeof agentEffectSchema>;

/** Who put the card on the stack: the fact the badge derives from. */
export const cardAuthorSchema = z.enum(["crewmate", "firstmate", "host"]);
export type CardAuthor = z.infer<typeof cardAuthorSchema>;

/**
 * The tags `isPreviewBody` reads, in document order: a comment, a script or
 * style element with its raw text (so a `</figure>` inside a script string
 * closes nothing, as in the browser), or a figure or canvas tag.
 */
const PREVIEW_TAGS =
  /<!--[\s\S]*?(?:-->|$)|<(script|style)(?=[\s>/])[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)|<(\/?)(figure|canvas)(?=[\s>/])[^>]*>/gi;

/**
 * What a body brings of its own: a style sheet, and controls of its own (a
 * `<canvas>`, or a `<script>` outside every `<figure>`). A script inside a
 * figure only makes that figure move (FI3-796, the captain's yes).
 */
function bodyShape(body: string): { styled: boolean; playable: boolean } {
  let figures = 0;
  let styled = false;
  for (const [, raw, close, tag] of body.matchAll(PREVIEW_TAGS)) {
    const name = (raw ?? tag ?? "").toLowerCase();
    if (name === "style") styled = true;
    if ((name === "canvas" && !close) || (name === "script" && figures === 0)) {
      return { styled, playable: true };
    }
    if (name === "figure") figures = close ? Math.max(0, figures - 1) : figures + 1;
  }
  return { styled, playable: false };
}

/**
 * Whether a body is a preview rather than prose: a style sheet or controls
 * of its own. It is markup first, so the Firstmate's context line quotes no
 * excerpt from it (core/orchestrator/firstmateContext.ts) and no change bar
 * marks it (core/orchestrator/cardChanges.ts). A shape test, never a kind.
 */
export function isPreviewBody(body: string): boolean {
  const shape = bodyShape(body);
  return shape.styled || shape.playable;
}

/**
 * Whether a body is a playable preview, running controls of its own: its
 * form controls are settings, so its footer counts them answered, tags no
 * Default, steps through none, and the question lint lets it be. A style
 * sheet alone asks questions as every decision does (INF-5452).
 */
export function isPlayableBody(body: string): boolean {
  return bodyShape(body).playable;
}

/** The id of the Merge anyway action the host adds beside a merge on failed checks (`passes`). */
export const MERGE_ANYWAY_ACTION = "merge-anyway";

export const cardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  variant: z.enum(["primary", "secondary", "ghost", "danger"]).optional(),
  /**
   * The step the emitter would take (interaction P1, WI-10): a decision
   * marks exactly one, and the host renders it primary. This is how a
   * decision carries an answer's proposed next step - no separate kind.
   */
  default: z.boolean().optional(),
  /**
   * Published compatibility only: contract 4.65 retired non-closing actions,
   * and migration 73 removes them from open cards. Changes come by reply.
   */
  keepsOpen: z.boolean().optional(),
  /** What the host does on the click; absent = the click returns to the author. */
  effect: cardEffectSchema.optional(),
  /** A destructive choice: rendered in the danger variant. */
  danger: z.boolean().optional(),
  /**
   * The care the captain's click sets on the card's task before the choice
   * returns to its author like any reply (INF-562, docs/delivery-rigor.md
   * "Raising care from a merge card"). Only the host adds it, to the merge
   * card it words; no agent declares it, and a body's script cannot press it.
   */
  care: rigorSchema.optional(),
  /**
   * The soft hold the captain's click passes at the card's version before
   * its merge runs (INF-1137 friction 6, docs/delivery-rigor.md "Its
   * words"): Merge anyway on failed checks. Only the host adds it, beside
   * the merge it words; no agent declares it, and a body's script cannot
   * press it.
   */
  passes: z.literal("checks").optional(),
  /** The choice says no to every other one (INF-3108); a decision with none gets `withAppDecline`'s. */
  declines: z.literal(true).optional(),
  /** A put-off ("Not until…", INF-3846 piece 3): the host keeps the card and raises it again (`./putOff`). */
  until: putOffUntilSchema.optional(),
});
export type CardAction = z.infer<typeof cardActionSchema>;

/**
 * One verified picture on a card (card pictures, phase 2; minted and
 * served through `./cardPictures`), as the host records it on the row
 * (`cards.pictures`, captain's Q9): what it proves, its size from its own
 * header, and which group it belongs to - a `figure.inf-pictures`, or the
 * picture alone. Never the bytes.
 */
/**
 * The recording a demo poster stands for (demo videos, docs/card-authoring.md
 * "Demo recordings"): the host's verified copy, minted and served through
 * `./cardPictures` at its `media` host, and what the host read from it before
 * keeping it. Never the bytes.
 */
export const cardDemoSchema = z.strictObject({
  /** The copy's minted id, `<taskId>-<32 hex>`; its file is `<id>.<kind>`. */
  id: z.string(),
  /**
   * An MP4, or the single-play GIF a crewmate made when no MP4 could be:
   * `CARD_MEDIA_KINDS` (`./cardPictures`), written out because that module's
   * imports reach this one; `cardPictures.test.ts` holds the two equal.
   */
  kind: z.enum(["mp4", "gif"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  bytes: z.number().int().positive(),
  /** The SHA-256 of the bytes the host verified and copied, in hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CardDemo = z.infer<typeof cardDemoSchema>;

export const cardPictureSchema = z.strictObject({
  /** Verified content identity, absent on older pictures. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  id: z.string(),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 0-based, in body order; each lone picture is a group of its own. */
  group: z.number().int().nonnegative(),
  /**
   * The demo recording this picture is the poster of, when it sits in a
   * `figure[data-inf-demo]`: the poster's own id is the recording's poster id.
   */
  demo: cardDemoSchema.optional(),
});
export type CardPicture = z.infer<typeof cardPictureSchema>;

/** The longest label an author may give a card's live attachment ("View booking"). */
export const LIVE_ATTACHMENT_LABEL_MAX = 32;

/** The longest path a card's page from its task's project may name (`./projectPage`). */
export const PROJECT_PAGE_PATH_MAX = 256;

/**
 * One live thing a card points at, which the host owns and draws as chrome
 * between the body and the buttons, labeled by the card's author
 * (docs/task-browser.md, "From a card"; design skill ResponseCard, "A live
 * attachment"). The first kind is a task's own browser: the task, the
 * run of this Mac's task browsers it was open in (`session`, a new one each
 * time the app starts) and which of that task's browsers it was in that run
 * (`generation`), so a click can tell the browser the card was emitted with
 * from a newer one. The host writes every field but the label from what it
 * holds at emit; the author only names the label. A click opens the view and
 * nothing else: it never answers the card, runs no effect, and the body's
 * script can neither see nor press it. `handoff` marks a card that asks the
 * captain to take the browser over (docs/task-browser.md, "Asking for
 * help"): its strip is drawn as attention while the request stands.
 *
 * The second kind is a page from the task's project (docs/task-browser.md,
 * "A page from the project"): the task and the path of an HTML file
 * relative to its project folder, from a browser button with
 * `browser_page`. A click opens it in the task's own browser with the
 * captain in control after the host checks it again inside that folder
 * (`inf:cards:open-page`); no browser need be open, and it works the same
 * once the task has closed.
 */
export const liveAttachmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("browser"),
    label: z.string().min(1).max(LIVE_ATTACHMENT_LABEL_MAX),
    taskId: z.string().min(1).max(64),
    session: z.string().min(1).max(64),
    generation: z.number().int().positive(),
    handoff: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("page"),
    label: z.string().min(1).max(LIVE_ATTACHMENT_LABEL_MAX),
    taskId: z.string().min(1).max(64),
    path: z.string().min(1).max(PROJECT_PAGE_PATH_MAX),
  }),
]);
export type LiveAttachment = z.infer<typeof liveAttachmentSchema>;

/**
 * A merge card's risk assessment (FI3-1127's plan, built in FI3-1128;
 * docs/card-authoring.md "The risk chart"), as the card and its task carry
 * it: seven dimensions a person weighs before merging, each declared by the
 * crewmate that did the work at one of three levels with one line why. No overall level
 * exists. The words and the drawing's reading of it live in `./risk`.
 */
/** The dimensions, in the radar's order: clockwise from the top. */
export const RISK_DIMENSIONS = [
  "blast",
  "behavior",
  "undo",
  "evidence",
  "sensitivity",
  "novelty",
  "deps",
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

/** A dimension's level, from least to most risk. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The longest line a crewmate may give for one dimension. */
export const RISK_WHY_MAX = 100;

/** One dimension as the crewmate declares it: its level and one line why. */
export const riskRatingSchema = z.strictObject({
  level: z.enum(RISK_LEVELS),
  why: z.string().min(1).max(RISK_WHY_MAX),
});
export type RiskRating = z.infer<typeof riskRatingSchema>;

/** Every dimension, declared: none may be left out. */
export const riskDeclarationSchema = z.strictObject({
  blast: riskRatingSchema,
  behavior: riskRatingSchema,
  undo: riskRatingSchema,
  evidence: riskRatingSchema,
  sensitivity: riskRatingSchema,
  novelty: riskRatingSchema,
  deps: riskRatingSchema,
} satisfies Record<RiskDimension, typeof riskRatingSchema>);
export type RiskDeclaration = z.infer<typeof riskDeclarationSchema>;

/** What a merge card and its task keep: the crewmate's declaration alone.
 * Unknown historical fields are discarded when saved cards are read.
 */
export const riskAssessmentSchema = z.object({
  declared: riskDeclarationSchema,
});
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;

/** Marks the line on a merge card whose Merge the app holds behind a newer version (INF-4031). */
export const MERGE_HELD_MARK = "data-inf-merge-held";

/**
 * Whether the host writes its task's facts on a card's strip, which the
 * stage draws above the buttons: every merge card and one whose Merge it
 * holds (`MERGE_HELD_MARK`), a discard card, an independent review's card,
 * and the merge card of a task that merges on its own (INF-1219), which
 * carries the story's risk and no buttons - the risk rides only a merge
 * card, written by the host from the crewmate's story.
 */
type FactsCard = Pick<Card, "actions" | "reviewTaskId" | "risk"> & { body?: string };
export function takesTaskFacts(card: FactsCard): boolean {
  if (card.reviewTaskId || card.body?.includes(MERGE_HELD_MARK)) return true;
  if (card.actions.some((action) => settleEffectOf(action) || mergeEffectOf(action))) return true;
  return card.risk !== undefined && card.actions.length === 0;
}

/**
 * The story note of a task that merges on its own (INF-1219): a crewmate's
 * card with a risk assessment and no actions. Its task's open change keeps
 * it off the stack until the merge has a result (INF-2533).
 */
export function isStoryNote(
  card: Pick<Card, "author" | "actions" | "reviewTaskId" | "risk">,
): boolean {
  return (
    card.author === "crewmate" &&
    !card.reviewTaskId &&
    card.risk !== undefined &&
    card.actions.length === 0
  );
}

/** The id of the Not now the host puts beside a merge that keeps the task open. */
export const MERGE_NOT_NOW_ID = "not-now";

/**
 * A crewmate's merge card with only the host's buttons - the merge, Discard
 * or Not now, Review carefully - never an unrelated decision.
 */
export function isRoutineMergeCard(card: Pick<Card, "author" | "actions">): boolean {
  return (
    card.author === "crewmate" &&
    card.actions.some((action) => mergeEffectOf(action)) &&
    card.actions.every(
      (action) =>
        mergeEffectOf(action) ||
        settleEffectOf(action) ||
        action.care ||
        (action.id === MERGE_NOT_NOW_ID && !action.effect),
    )
  );
}

/**
 * A card that keeps its task open past a merge (INF-2525): an open
 * question of its crewmate's or the first mate's - any card with actions
 * but a merge card, whose pull request the task's changes answer for. The
 * app's own cards never do.
 */
export function keepsTaskOpen(card: Pick<Card, "author" | "actions">): boolean {
  return (
    card.author !== "host" &&
    card.actions.length > 0 &&
    !card.actions.some((action) => mergeEffectOf(action))
  );
}

/**
 * The app's line on every merge card (INF-2490, INF-2744): whether the
 * merge closes the task. The crewmate declares it on the merge (`after`),
 * and a question or another pull request on the task still open keeps the
 * task open whatever it declared (INF-2525). The host reads it from the
 * card's own merge and the task's open cards and pull requests, never from
 * its words.
 */
export const MERGE_CLOSES_WORDS = {
  closes: "Merging closes this task",
  continues: "The task continues after this merge",
} as const;

/** The merge line's mark, which readers find it by. */
export const MERGE_CLOSES_MARK = "data-merge-closes";

/**
 * The merge line for a card's actions, or undefined on a card that merges
 * nothing. A merge declared to close continues the task too while something
 * else on it is open - a question or another pull request (`othersOpen`,
 * INF-2525).
 */
export function mergeClosesLine(
  actions: readonly Pick<CardAction, "effect">[],
  othersOpen = false,
): string | undefined {
  const merge = actions.map((action) => mergeEffectOf(action)).find(Boolean);
  const words = merge
    ? merge.after === "close" && !othersOpen
      ? MERGE_CLOSES_WORDS.closes
      : MERGE_CLOSES_WORDS.continues
    : undefined;
  return words ? mergeClosesMarkup(words) : undefined;
}

/** The merge line as a card's body carries it. */
function mergeClosesMarkup(words: string): string {
  return `<p class="inf-merge-closes" ${MERGE_CLOSES_MARK}>${words}</p>`;
}

/**
 * A card's body without its merge line, and without the strip that held
 * only that line: for a card that no longer merges, such as one its author
 * ended (INF-3071).
 */
export function withoutMergeClosesLine(body: string): string {
  let next = body;
  for (const words of Object.values(MERGE_CLOSES_WORDS)) {
    const line = mergeClosesMarkup(words);
    next = next.replace(`${SETTLE_FACTS_OPEN}${line}</div>`, "").replace(line, "");
  }
  return next;
}

/**
 * A card's strip with its merge line as the last part, which the stage
 * draws beside the buttons (`splitMergeClosesLine`);
 * a merge card with no task facts gets a strip holding only the line.
 */
export function withMergeClosesLine(
  strip: string | undefined,
  actions: readonly Pick<CardAction, "effect">[],
  othersOpen = false,
): string | undefined {
  const line = mergeClosesLine(actions, othersOpen);
  if (!line) return strip;
  if (!strip?.endsWith("</div>")) return `${SETTLE_FACTS_OPEN}${line}</div>`;
  return `${strip.slice(0, -"</div>".length)}${line}</div>`;
}

/**
 * A strip without its merge line, and the line's words: the stage draws the
 * line at the start of the card's buttons row, beside the buttons it
 * describes, and the strip's frame draws the rest. `strip` is undefined when
 * the line was all the strip held. A strip with no merge line comes back as
 * it is; the phone and a past card keep the line where the host wrote it, as
 * the strip's last part.
 */
export function splitMergeClosesLine(strip: string): {
  strip: string | undefined;
  words: string | undefined;
} {
  for (const words of Object.values(MERGE_CLOSES_WORDS)) {
    const line = mergeClosesMarkup(words);
    if (!strip.includes(line)) continue;
    const rest = strip.replace(line, "");
    return { strip: rest === `${SETTLE_FACTS_OPEN}</div>` ? undefined : rest, words };
  }
  return { strip, words: undefined };
}

/**
 * How much of the stage a card asks for (the captain's Q5 to Q7 A of
 * 2026-09-28; docs/card-authoring.md "Card width"): `regular` is the 560 px
 * card every card was until then, `wide` 800 px, `full` the stage up to
 * 1,040 px. The host decides it at emit from closed facts about the body -
 * a wide table, a long code line, a large picture, a picture group, a
 * preview - and the author's `width` hint can only widen it. The captain's
 * drag is the shell's alone and never reaches the row.
 */
export const CARD_WIDTHS = ["regular", "wide", "full"] as const;
export const cardWidthSchema = z.enum(CARD_WIDTHS);
export type CardWidth = z.infer<typeof cardWidthSchema>;

/** The wider of two widths: the order every widening rule reads. */
export function widerCardWidth(a: CardWidth, b: CardWidth | undefined): CardWidth {
  if (!b) return a;
  return CARD_WIDTHS.indexOf(b) > CARD_WIDTHS.indexOf(a) ? b : a;
}

/** What a card off the stage waits on (`Card.awaiting`). */
export const cardAwaitingSchema = z.enum(["answer", "close-out"]);
export type CardAwaiting = z.infer<typeof cardAwaitingSchema>;

/** The most change bars one card draws: past it, a long body's new parts are counted, not drawn. */
export const CARD_CHANGE_MARKS_MAX = 512;

/**
 * What changed in the version of a card on the stage since the captain last
 * saw it (the accepted FI3-472 plan; docs/card-authoring.md "What changed
 * since you looked"). The host compares the two versions part by part -
 * paragraph, list item, table row, figure, question - and the author marks
 * nothing. Absent on a card the captain never saw before it changed, and on
 * one unchanged since.
 */
export const cardChangesSchema = z.strictObject({
  /** When the version on the stage was written. */
  at: z.number(),
  /** Its parts the captain has not seen. */
  added: z.number().int().nonnegative(),
  /** Parts of the version last seen that it no longer has: counted, never drawn. */
  removed: z.number().int().nonnegative(),
  /** More than half its parts are new: the line says Rewritten and nothing is marked. */
  rewritten: z.boolean(),
  /**
   * Where each new part's opening tag starts in `body`, for its change bar.
   * Empty when rewritten, and on a playable preview, whose own code draws it.
   */
  marks: z.array(z.number().int().nonnegative()).max(CARD_CHANGE_MARKS_MAX),
});
export type CardChanges = z.infer<typeof cardChangesSchema>;

/**
 * Whether the stage shows a card: every card but one awaiting its author's
 * first close-out. A reply never moves its card: a replied-under card
 * carries `sentBackAt` while its author answers. Cards older versions sent
 * away on a reply carry no stamp and stay off until their author answers.
 */
export function onStage(card: Pick<Card, "awaiting" | "sentBackAt">): boolean {
  return card.awaiting === undefined || card.sentBackAt !== undefined;
}

/**
 * The stack's order: by priority, then oldest. A reply never moves a card,
 * so a card awaiting its author's answer keeps its place. The core snapshot
 * owns the order.
 */
export function compareStack(
  a: Pick<Card, "priority" | "createdAt">,
  b: Pick<Card, "priority" | "createdAt">,
): number {
  return b.priority - a.priority || a.createdAt - b.createdAt;
}

export const cardActionSourceSchema = z.enum(["chrome", "frame"]);
export type CardActionSource = z.infer<typeof cardActionSourceSchema>;

/** The named questions one card body's answers may carry. */
export const CARD_MAX_ANSWERS = 256;
/** The values one answer may carry (a checkbox group, a multiple select). */
export const CARD_MAX_ANSWER_VALUES = 256;
/** A question's name, as a control's `name` or `inf.stage` gives it. */
export const CARD_ANSWER_NAME_MAX = 200;
/**
 * One value or one label of an answer. The frame's reading is the shell's
 * draft and is bounded per value; what a footer click may SEND is
 * CARD_ANSWERS_MAX_BYTES on the whole set.
 */
export const CARD_ANSWER_TEXT_MAX = 16_384;
/**
 * The most a footer click's answers may weigh as JSON. Footer answers are
 * the shell's own reading of every question, not a frame action value
 * (`ACTION_VALUE_MAX_BYTES` in `./plugins/bridge`), so the two are not the
 * same bound. An engineering envelope for a full answer set, the same size
 * as the question definitions that ride the same click, not a measured
 * optimum. Past it the chrome refuses the click rather than cut the
 * captain's picks. A literal here because this module loads in plain Node.
 */
export const CARD_ANSWERS_MAX_BYTES = 64 * 1024;
/** What the captain sees when a footer click or a reply's answers exceed the bound. */
export const CARD_ANSWERS_TOO_LONG =
  "These answers are too long to send. Shorten them and try again.";
/** What the core says when a footer click's answers exceed the bound. */
export const CARD_ANSWERS_BOUND_REFUSAL = `The card's answers must be JSON no larger than ${servedNumber(CARD_ANSWERS_MAX_BYTES)} bytes.`;
/**
 * The most the captain may write in a question's Something else field
 * (FI3-1002): the field's own `maxlength`, and the bound on `written`.
 */
export const CARD_WRITTEN_MAX = 500;

/**
 * The answer a card's one field rides a footer click as (INF-680; the
 * field and its Chat button, INF-924): the words the captain wrote under
 * the card before he clicked a choice, marked written in. An author may not
 * name a control of its own this (`cardLint`).
 */
export const ANYTHING_ELSE_ANSWER = "anything_else";
/** What the card's one field says while it is empty (the captain's words, INF-924). */
export const CARD_REPLY_HINT = m.cardReplyHint();
/** The button at the right edge of a card's choices that sends the field as a reply. */
export const CARD_CHAT_LABEL = "Chat";
/** What leads the words a past card's field sent with its choice. */
export const PAST_CARD_WORDS_LEAD = m.cardPastSentLead();
/** Why a card's choices wait while a file or picture is attached to its field. */
export const CARD_FILES_FIRST = "Send the file as a reply first";
/** A reply is one message, not a document: longer is refused at the boundary. */
export const CARD_REPLY_MAX_CHARS = 4_000;
/** The most a choice carries from the field: as much as a reply. */
export const ANYTHING_ELSE_MAX_CHARS = CARD_REPLY_MAX_CHARS;

/**
 * One question a card body asks with its own form (inline decisions,
 * contract 4.22; docs/card-authoring.md "Questions in the body"), as the
 * frame bridge reads it: its name, the value or values picked (none when
 * nothing is), the text of the `<label>` bound to each picked option
 * (aligned with `values`; present only when at least one has one), and
 * whether the pick differs from the state the author wrote. `json` marks a
 * snapshot staged with `inf.stage`, whose one value is JSON text. `written`
 * is what the captain wrote under the question's Something else row
 * (`data-inf-write-in`, FI3-1002): an answer of the captain's own, none of
 * the options, so `values` never holds that row and an answer with words
 * is always `changed`. The answers reach the author with a footer click or
 * an author-directed reply.
 */
export const cardAnswerSchema = z.strictObject({
  name: z.string().min(1).max(CARD_ANSWER_NAME_MAX),
  values: z.array(z.string().max(CARD_ANSWER_TEXT_MAX)).max(CARD_MAX_ANSWER_VALUES),
  labels: z.array(z.string().max(CARD_ANSWER_TEXT_MAX)).max(CARD_MAX_ANSWER_VALUES).optional(),
  changed: z.boolean(),
  json: z.literal(true).optional(),
  // The Something else field holds itself to CARD_WRITTEN_MAX; the words
  // the card's field sends with a choice are the longest written there is.
  written: z.string().min(1).max(ANYTHING_ELSE_MAX_CHARS).optional(),
  // A question the captain may skip and left untouched (INF-4425,
  // `card-answer-skipped.md`): `values` and `labels` hold the Default the
  // skip sent, as the card proposed it, never a pick of the captain's.
  skipped: z.literal(true).optional(),
});
export type CardAnswer = z.infer<typeof cardAnswerSchema>;
export const cardAnswersSchema = z.array(cardAnswerSchema).max(CARD_MAX_ANSWERS);

/**
 * The answers with the card's field's words joined as one more answer, the
 * captain's own and so changed; words of only whitespace add nothing. A
 * body control of the same name gives way to the field.
 */
export function withAnythingElse(answers: readonly CardAnswer[], words: string): CardAnswer[] {
  const rest = answers.filter((answer) => answer.name !== ANYTHING_ELSE_ANSWER);
  const written = words.trim();
  return written
    ? [...rest, { name: ANYTHING_ELSE_ANSWER, values: [], changed: true, written }]
    : rest;
}

/** What the card's field sent with a choice, if it sent anything. */
export function anythingElseOf(answers: readonly CardAnswer[] | undefined): string | undefined {
  return answers?.find((answer) => answer.name === ANYTHING_ELSE_ANSWER)?.written;
}

/**
 * What a footer click carries as `inf:cards:act`'s value: the answers, in one
 * envelope. A frame click's value stays the body's own.
 */
export const cardChromeValueSchema = z.strictObject({ answers: cardAnswersSchema });
export type CardChromeValue = z.infer<typeof cardChromeValueSchema>;

/** Every agent-facing card read retains annotations, including a note-only reply. */
export function cardMessageText(message: Pick<CardMessage, "text" | "notes">): string {
  return [message.text, ...pointedAtLines(message.notes ?? [])].filter(Boolean).join("\n");
}

/** The answers' JSON size, which a footer click may not take past CARD_ANSWERS_MAX_BYTES. */
export function cardAnswersBytes(answers: readonly CardAnswer[]): number {
  return new TextEncoder().encode(JSON.stringify(answers)).byteLength;
}

/**
 * The longest question wording or option label a definition keeps, as the
 * frame bridge reads label text (`words`, 500 characters). A longer one is
 * cut there and the definition says so (`label-truncated`).
 */
export const CARD_QUESTION_LABEL_MAX = 500;
/**
 * The most a footer click's question definitions may weigh as JSON: an
 * engineering envelope for optional evidence, not a measured optimum. Past
 * it the shell sends none and says why (`too-large`); the answers still go.
 */
export const CARD_QUESTIONS_MAX_BYTES = 64 * 1024;

/**
 * What a question a card body asks lets the captain give, read from its
 * controls: one pick, a set of picks, words, or a value the body's own
 * script or a hidden field holds (`opaque`, never proof of a visible choice).
 */
export const CARD_QUESTION_KINDS = ["single", "multiple", "text", "opaque"] as const;

/** What keeps a question definition from being a whole reading of the question. */
export const CARD_QUESTION_GAPS = [
  // No wording is bound to the question itself (an option's label labels the option).
  "no-prompt",
  // The controls sit in different labelled containers, so no one wording is theirs.
  "conflicting-prompt",
  // The wording or an option label ran past CARD_QUESTION_LABEL_MAX.
  "label-truncated",
  // Two options share a value, so a picked value names neither for sure.
  "duplicate-values",
  // One name spans different kinds of control.
  "mixed-controls",
  // A hidden field or a staged snapshot: a setting, not a visible choice.
  "opaque",
] as const;

export const cardQuestionOptionSchema = z.strictObject({
  /** The control's authored value: the option's id. */
  value: z.string().max(CARD_ANSWER_TEXT_MAX),
  /** The words bound to the option, when any are. */
  label: z.string().max(CARD_QUESTION_LABEL_MAX).nullable(),
  /** Checked or selected as the author wrote the body. */
  authoredDefault: z.boolean(),
  disabled: z.boolean(),
  /** Laid out with no box: in the body, but not on screen. */
  hidden: z.boolean(),
});
export type CardQuestionOption = z.infer<typeof cardQuestionOptionSchema>;

/**
 * One question a card body asked with its own form, as the frame bridge read
 * it at the footer click that sent its answer: frame-reported evidence of
 * what was offered, never the answer itself (that is the `CardAnswer` of the
 * same name) and never a judgment of what the question means. The wording is
 * the one explicitly bound to the question - a fieldset's `legend`, a
 * group's `aria-labelledby` or `aria-label`, a lone field's `<label>` - or
 * null with the gap that says why; the nearest paragraph is never guessed.
 */
export const cardQuestionSchema = z.strictObject({
  name: z.string().min(1).max(CARD_ANSWER_NAME_MAX),
  kind: z.enum(CARD_QUESTION_KINDS),
  /** The control type the author used, kept for a reader that wants it. */
  control: z.enum([
    "radio",
    "checkbox",
    "select",
    "select-multiple",
    "text",
    "textarea",
    "hidden",
    "staged",
    "mixed",
  ]),
  prompt: z.string().max(CARD_QUESTION_LABEL_MAX).nullable(),
  promptBasis: z.enum(["legend", "labelledby", "aria-label", "label"]).nullable(),
  /** In display order; empty for words and opaque values. */
  options: z.array(cardQuestionOptionSchema).max(CARD_MAX_ANSWER_VALUES),
  /**
   * Where the proposal came from: the author's own checked/selected/filled
   * state, a single select's first option the browser picks by itself
   * (`implicit-first`, not the author's recommendation), or none.
   */
  defaultBasis: z.enum(["authored", "implicit-first", "none"]),
  required: z.boolean(),
  gaps: z.array(z.enum(CARD_QUESTION_GAPS)).max(CARD_QUESTION_GAPS.length),
  /** A visible question with its wording and every option read whole. */
  complete: z.boolean(),
  /**
   * The question also offered a Something else row (`data-inf-write-in`,
   * FI3-1002), which `options` leaves out: the captain could write an
   * answer of their own. Absent when it offered none.
   */
  writeIn: z.literal(true).optional(),
});
export type CardQuestion = z.infer<typeof cardQuestionSchema>;
export const cardQuestionsSchema = z.array(cardQuestionSchema).max(CARD_MAX_ANSWERS);

/** The definitions' JSON size, which a click may not take past CARD_QUESTIONS_MAX_BYTES. */
export function cardQuestionsBytes(questions: readonly CardQuestion[]): number {
  return new TextEncoder().encode(JSON.stringify(questions)).byteLength;
}

/**
 * Why a click carried no question definitions: the reading was not the
 * mounted frame's own at the click, or the definitions were past their
 * bound, or they could not be read as definitions.
 */
export const cardQuestionsGapSchema = z.enum(["no-fresh-reading", "too-large", "invalid"]);
export type CardQuestionsGap = z.infer<typeof cardQuestionsGapSchema>;

/**
 * What the shell says about a click beside it (`inf:cards:act`, `close` and
 * `reply`): the gesture's own id, minted when the captain clicked, and the
 * lifecycle and offer of the card it had mounted at that moment - read then,
 * never looked up again after an await. The core normally only records it
 * (docs/card-evidence.md); a durable action's confirmation or a merge with
 * declared requirements refuses a stale, remounted or unreadable offer.
 * `reading` says where the
 * footer's answers came from: the mounted frame's fresh reading, the shell's
 * last draft when the frame could not answer, or no form at all.
 */
/**
 * What pressed a card's button, as the window heard it (INF-4175): a pointer
 * and which (`mouse`, `pen` or `touch`); the focused button's own key
 * (`Enter` or `Space`); or a window command that presses it, by its key
 * (`key` with the `command` and the `keys` it had installed then, such as
 * ⌘1) or chosen in command search. The window sends none when it could not
 * tell, so a missing input is unknown, never guessed.
 */
export const cardPressInputSchema = z.strictObject({
  kind: z.enum(["pointer", "key", "command-search"]),
  pointer: z.enum(["mouse", "pen", "touch"]).optional(),
  key: z.enum(["Enter", "Space"]).optional(),
  command: z.string().max(64).optional(),
  keys: z.array(z.string().max(32)).max(8).optional(),
});
export type CardPressInput = z.infer<typeof cardPressInputSchema>;

export const cardSubmissionSchema = z.strictObject({
  id: z.string().min(8).max(64),
  lifecycleId: z.string().max(64).optional(),
  offerId: z.string().max(64).optional(),
  reading: z.enum(["fresh", "fallback", "none"]).optional(),
  /** The card showed another offer by the time the reading came back. */
  remounted: z.literal(true).optional(),
  questions: cardQuestionsSchema.optional(),
  questionsGap: cardQuestionsGapSchema.optional(),
  /** What pressed the button, on an action or a note's own button (`card-press-input.md`). */
  input: cardPressInputSchema.optional(),
});
export type CardSubmission = z.infer<typeof cardSubmissionSchema>;

/** The meta line of a card the Firstmate itself writes, where a crewmate's card names its task. */
export const FIRSTMATE_CARD_META = "firstmate";
/** INF-63: the app-owned label for a validated independent review. */
export const REVIEW_FINDING_LABEL = m.cardReviewFinding();

/**
 * Whether a card is the first mate's own answer (INF-2714): a first mate
 * card whose head says first mate. It leads with no task's key and reads
 * its asked line from its own record, while a card the app writes about a
 * task - a required action, a closing note - heads with that task.
 */
export function firstmateOwnCard(card: Pick<Card, "author" | "meta">): boolean {
  return card.author === "firstmate" && card.meta === FIRSTMATE_CARD_META;
}

/** How a card's meta line reads: the first mate's own cards say who wrote them in words, never the stored name. */
export function cardMetaWords(meta: string): string {
  return meta === FIRSTMATE_CARD_META ? "first mate" : meta;
}

/**
 * Strict on purpose: the wire refuses a `kind` (or any other field the
 * model does not have), so a card can only ever be dressed by what it is.
 */
/**
 * What a card's line under its title says about where its work came from
 * (INF-2326, docs/card-authoring.md "The You asked line"), nearest first:
 * the captain's message that filed or started it (`asked`, also when `kind`
 * is absent), an automation that filed it, their card click it was filed
 * from (`chose`), else a message of theirs aimed at that work alone
 * (`said`), else the nearest task it came from (`from`).
 */
export const CARD_ASKED_KINDS = ["asked", "said", "chose", "automation", "from"] as const;
export type CardAskedKind = (typeof CARD_ASKED_KINDS)[number];

/**
 * The line's facts (`Card.asked`): when it happened and the words. `text`
 * is the captain's words, whole, for `asked` and `said`; what they wrote
 * with a click for `chose`, whose button words are `choice` and whose card's
 * title is `card` (INF-2744: the line names the card the click was on); the
 * automation's name, as it was when it ran, for `automation`; and the task's
 * title for `from`, whose key is `key`. `through` counts the tasks between
 * the card's task and the one the source sits on. The chrome shows the start
 * of the captain's words and opens the rest on request, so a long message
 * never fills the card.
 */
export const cardAskedSchema = z.strictObject({
  at: z.number(),
  text: z.string(),
  kind: z.enum(CARD_ASKED_KINDS).optional(),
  choice: z.string().optional(),
  card: z.string().optional(),
  key: z.string().optional(),
  through: z.number().int().positive().optional(),
});
export type CardAsked = z.infer<typeof cardAskedSchema>;

export const cardSchema = z.strictObject({
  id: z.string(),
  taskId: z.string().optional(),
  /** Host-validated independent review of this card’s task (INF-63). */
  reviewTaskId: z.string().optional(),
  author: cardAuthorSchema,
  /** Higher shows first in the stack. */
  priority: z.number(),
  title: z.string(),
  /** Mono metadata line: relative time, crewmate ref. */
  meta: z.string(),
  /**
   * The model its author ran on, as a label (a crewmate's card). The chrome
   * paints it as a chip beside the meta line, never inside it. Absent on a
   * card with no model to name and on every card written before it.
   */
  model: z.string().optional(),
  /**
   * Where its task runs, for a crewmate's card from a task on a computer
   * that runs work, as the words after a verb ("on Mac mini", "as Builder";
   * `signInPlace`). The chrome paints it right after the meta line, which
   * gives way to it (docs/helper.md, "A card from there"). Absent on a card
   * from a task that runs here and on every card written before it.
   */
  place: z.string().optional(),
  /** Semantic HTML rendered only inside a sandboxed iframe. */
  body: z.string(),
  /** Core-owned presentation and explicit answer receipt (INF-1879). */
  corner: cardCornerSchema.optional(),
  answerDone: z.object({ taskId: z.string(), label: z.string(), restWords: z.string() }).optional(),
  /** Every live note's one button, Done or Got it (INF-2794). */
  noteDone: noteDoneSchema.optional(),
  requiredActions: requiredActionsSchema.optional(),
  /** The crew's after-merge steps its saved story declared (INF-2796), drawn beside the merge. */
  afterMerge: afterMergeShownListSchema.optional(),
  actions: z.array(cardActionSchema),
  status: z.enum(["streaming", "ready"]),
  createdAt: z.number(),
  /**
   * The pictures the host verified in the body (card pictures, phase 2;
   * `cards.pictures`): id, alt, size and group, never the bytes. Absent on a
   * card that names none.
   */
  pictures: z.array(cardPictureSchema).optional(),
  /** Files for the captain (`cards.files_json`, docs/card-authoring.md): references, never bytes. */
  files: z.array(cardFileSchema).optional(),
  /**
   * The width the host decided at emit (`cards.width`): the body's facts,
   * widened by the author's hint. Absent means default-wide; regular means short plain copy.
   */
  width: cardWidthSchema.optional(),
  /**
   * The one live thing the card points at, which the chrome draws between
   * the body and the buttons (`cards.attachment_json`): a crewmate's
   * labeled door to its task's browser. Absent on every other card.
   */
  attachment: liveAttachmentSchema.optional(),
  /**
   * A merge card's risk assessment (`cards.risk_json`; docs/card-authoring.md
   * "The risk chart"): the levels and lines its crewmate declared, which the chrome draws as a
   * radar at the card's top right. Absent on every other card.
   */
  risk: riskAssessmentSchema.optional(),
  /**
   * False on a card that takes no reply, whoever its author is
   * (docs/card-threads.md "A card with no reply row"): the chrome draws no
   * reply row and the core refuses one (`cardTakesReplies`). The host sets
   * it on the welcome alone (`cards.replies`); absent on every other card,
   * which takes replies as its author allows.
   */
  replies: z.literal(false).optional(),
  /**
   * Who answers a reply under a card whose author cannot (`cards.answered_by`):
   * the host sets "firstmate" on its stuck alert (`card-stall-<task>`, INF-1670),
   * so the chrome draws a reply row and the first mate answers in the thread,
   * never the task's crewmate. Absent on every other card, which takes replies
   * as its author allows.
   */
  answeredBy: z.literal("firstmate").optional(),
  /** Declared by the author: replies stay shown; each arrival comes forward. Choices still close. */
  holdsPlace: z.literal(true).optional(),
  /**
   * The planner declared this card still asks a question and is not the
   * ready plan. Absent means it did not. The host does not infer it.
   */
  asking: z.literal(true).optional(),
  /**
   * The planner declared this offer design-only. Absent means it did not.
   * The host does not infer it from the card's sentences.
   */
  designOnly: z.literal(true).optional(),
  /**
   * Its crewmate declared that the captain's choice on it is not its answer
   * but something it goes on from, such as a consent before it uses
   * something sensitive (INF-1226): on a task that only answers, the choice
   * reaches the crewmate and the task stays open. Absent means it did not;
   * the host does not infer it. Kept in `cards.continues`.
   */
  continues: z.literal(true).optional(),
  /**
   * Its author declared that the card answers the captain's message it is
   * about (INF-1610): the outcome of the work they asked for, or the first
   * mate's own note answering it. Absent means it did not; the host never
   * infers it from the card's words. Kept in `cards.answering`.
   */
  answering: z.literal(true).optional(),
  /**
   * Off the stage until its author closes out (docs/card-threads.md "When
   * a card reaches the stage"; the captain's Q1, Q4 and Q5 A of
   * 2026-09-27): `answer` while the captain's reply is the newest line on
   * the thread, `close-out` while its author has written on it - a new
   * card, a revision, a thread answer - and has not yet closed out (a
   * crewmate's next report or its idle, the Firstmate's turn end). Absent
   * on a card the stage shows. `CardService` is its one writer.
   */
  awaiting: cardAwaitingSchema.optional(),
  /** Captain-only saved stack visibility, independent of author holds and task gates. */
  minimized: z.literal(true).optional(),
  /**
   * A reply kept shown at send time (docs/card-threads.md), or a legacy reply:
   * it sorts after new arrivals while awaiting its author, in reply order. The author's
   * close-out clears it, returning the card to its original place. Host stamp,
   * never an author's; `CardService` is its one writer.
   */
  sentBackAt: z.number().int().nonnegative().optional(),
  /**
   * The card's current occurrence on the stack and the exact version it
   * carries (the human-supervision capture, docs/card-evidence.md): host
   * stamps, never an author's. A reopen starts a new lifecycle and a change
   * to anything the card shows mints a new offer; a status or stage change
   * does not. The shell echoes the offer it mounted with a click, so the
   * record names the version the captain chose from. Absent on a card no
   * capture has stamped.
   */
  lifecycleId: z.string().max(64).optional(),
  offerId: z.string().max(64).optional(),
  /**
   * What changed since the captain last saw the card: the host's revised
   * line and change bars. Host-computed on the stage's snapshot, never
   * stored on the row and never an author's.
   */
  changes: cardChangesSchema.optional(),
  /**
   * The captain's message the card is about, as they sent it, which the
   * chrome draws as the "You asked" line (INF-1610): read from the saved
   * message through the card's task, never from the card's words. Host-
   * computed on the stage's snapshot, never stored on the row and never an
   * author's. Absent on a card about no message of theirs.
   */
  asked: cardAskedSchema.optional(),
  /**
   * The app's Quick answer mark (INF-4344, the captain's direction C of
   * INF-4341): a crewmate's card from a task sorted as a quick answer
   * (`isQuickAnswer`), which the chrome draws as a quiet chip after the kind
   * chip. Host-computed on the stage's snapshot from the task's recorded
   * kind, never stored on the row and never an author's.
   */
  quick: z.literal(true).optional(),
  /** Snapshot-only: the captain has seen an offer in this lifecycle, from card observations. */
  seen: z.boolean().optional(),
  /** Snapshot-only: the exact released update, distinct from its historical offer. */
  currentUpdateId: z.string().max(64).optional(),
  /** An accepted sighting of that exact update, shared by every updated view. */
  currentUpdateSeen: z.boolean().optional(),
  /**
   * Its author ended it while the captain had seen it (INF-3071): the record
   * has closed it, and the stack keeps drawing it with no actions, one Close
   * and this app line until the captain closes it. Host stamp, never an
   * author's; absent on every live card.
   */
  ended: cardEndedSchema.optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const cardsSnapshotSchema = z.array(cardSchema);

/**
 * How a card reads, derived from what it is: a card with actions is a
 * decision, one the host authored an attention, one without actions a
 * note. The renderer's chrome, the built-in manifest's card-kind rows, and
 * the words the agents' context blocks use are all keyed on this.
 */
export const CARD_PRESENTATIONS = ["decision", "note", "attention"] as const;
export type CardPresentation = (typeof CARD_PRESENTATIONS)[number];

export function cardPresentation(card: Pick<Card, "author" | "actions">): CardPresentation {
  if (card.actions.length === 0) return "note";
  return card.author === "host" ? "attention" : "decision";
}

/**
 * Cards as threads (phase 1, captain-approved 2026-09-20; the design is R4
 * of `fm3000-card-close-decision-model-s1`). Every card is the head of a
 * thread between the captain and the card's AUTHOR: what the captain types
 * under a card goes to that author, and the author answers either by
 * revising the card (preferred - the head re-renders and the thread shows
 * one host line) or with a prose message in the thread.
 *
 * A reply never closes a card and never resolves a decision: the buttons
 * stay pinned, and a card still leaves the stage on a button, a settle, the
 * captain's close or the author's withdrawal - all
 * host code.
 */
export const cardMessageWhoSchema = z.enum(["captain", "crewmate", "firstmate", "host"]);
export type CardMessageWho = z.infer<typeof cardMessageWhoSchema>;

/** Host-derived, bounded destinations, never author selectors. */
export const REVISION_TARGETS_MAX = 512;
export const revisionTargetSchema = z.strictObject({
  id: z
    .number()
    .int()
    .nonnegative()
    .max(REVISION_TARGETS_MAX + 1),
  label: z.string().max(160),
  region: z.enum(["body", "title", "buttons", "whole", "preview"]),
  start: z.number().int().nonnegative().optional(),
});
export type RevisionTarget = z.infer<typeof revisionTargetSchema>;
export const cardRevisionSchema = z.strictObject({
  lifecycleId: z.string().min(1).max(64),
  offerId: z.string().min(1).max(64),
  previousOfferId: z.string().min(1).max(64),
  released: z.boolean(),
  targets: z.array(revisionTargetSchema).max(REVISION_TARGETS_MAX + 2),
  removed: z.number().int().nonnegative(),
});
export type CardRevisionLinks = z.infer<typeof cardRevisionSchema>;
/** Projection into the offer actually displayed; absent targets remain unavailable links. */
export const revisionShownSchema = z.strictObject({
  offerId: z.string().min(1).max(64),
  targets: z.array(revisionTargetSchema).max(REVISION_TARGETS_MAX + 2),
});
export type RevisionShown = z.infer<typeof revisionShownSchema>;

/**
 * Who actually wrote a line or a revision on a card that is not their own
 * (docs/card-threads.md, "Shared cards"): the first mate, or a crewmate by
 * its task. `label` is the host's words for them, the same on every view.
 * A line with no contributor was written by the card's own author, or is
 * older than this record and stays unattributed.
 */
export const cardContributorSchema = z.strictObject({
  actor: z.enum(["crewmate", "firstmate"]),
  taskId: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(160),
});
export type CardContributor = z.infer<typeof cardContributorSchema>;

/**
 * What one write on a shared card did (docs/card-threads.md, "Shared
 * cards"), as the tool text, the record and the answer count all read it:
 * created, revised, a reply alone, unchanged, or refused with nothing
 * written. `display` is whether the captain can see the write now or it
 * waits for its writer's turn to end; neither says it was read.
 */
export const CARD_MUTATION_EFFECTS = [
  "created",
  "revised",
  "reply-only",
  "unchanged",
  "refused",
] as const;
export const cardMutationSchema = z.object({
  effect: z.enum(CARD_MUTATION_EFFECTS),
  cardId: z.string(),
  title: z.string().optional(),
  /** The card's lifecycle and current revision (its offer) after the write. */
  lifecycleId: z.string().optional(),
  revision: z.string().optional(),
  /** A required action's generation after the write. */
  generation: z.number().int().optional(),
  contributor: cardContributorSchema,
  /** The thread line it wrote, and the captain message that line ended. */
  replyId: z.number().int().optional(),
  answered: z.number().int().optional(),
  /** A captain message someone had already answered: the line is a comment. */
  alreadyAnswered: z
    .object({ messageId: z.number().int(), by: z.string(), text: z.string() })
    .optional(),
  /** A closed card's dated note. */
  clarification: z.literal(true).optional(),
  /** What the write kept as it was. */
  unchanged: z.array(z.string()).optional(),
  display: z.enum(["available", "held"]),
  responseId: z.string().optional(),
  refusal: z.string().optional(),
  /** The same operation identity answered its earlier result. */
  repeated: z.literal(true).optional(),
});
export type CardMutation = z.infer<typeof cardMutationSchema>;

export const cardMessageSchema = z.strictObject({
  notes: cardNotesSchema.optional(),
  revision: cardRevisionSchema.optional(),
  revisionShown: revisionShownSchema.optional(),
  /** Who wrote a line on a card that is not theirs (major 15). */
  contributor: cardContributorSchema.optional(),
  /** The captain's message this line answers and ends, by its row id. */
  answersMessage: z.number().int().positive().optional(),
  /** A dated note added after the card closed; it reopens and changes nothing. */
  clarification: z.literal(true).optional(),
  /** Row id, ascending with `at`; the renderer's key. */
  id: z.number(),
  cardId: z.string(),
  who: cardMessageWhoSchema,
  /** Prose only - no actions, no script, no figure (captain's Q4 B). */
  text: z.string(),
  at: z.number(),
  /**
   * On a captain's reply: the settings and answers the card sent with his
   * words, kept beside them rather than in `text`, so the thread shows what
   * he typed and his settings apart (FI3-617). The author still reads both
   * together (`replyWithSettings`).
   */
  answers: cardAnswersSchema.optional(),
  /** On a captain's line: sent from his own command, `infinitary-axi`, not the window. */
  through: throughSchema.optional(),
});
export type CardMessage = z.infer<typeof cardMessageSchema>;

export const cardThreadSchema = z.strictObject({
  cardId: z.string(),
  messages: z.array(cardMessageSchema),
});
export type CardThread = z.infer<typeof cardThreadSchema>;

/**
 * How a saved card ended, for the past card's strip (FI3-579): a choice, or
 * one of the ways a card leaves without one. `unknown` is a card saved
 * before the capture that records the difference.
 */
export const PAST_ENDINGS = [
  "chose",
  "dismissed",
  "author-withdrawal",
  "host-withdrawal",
  "task-retired",
  "duplicate",
  "unknown",
] as const;
export type PastEnding = (typeof PAST_ENDINGS)[number];

/**
 * A closed card as the captain last saw it, read-only (FI3-579 piece 2):
 * the version he had in front of him (title, body, actions without their
 * effects, width), how it ended, the answers he submitted and its thread.
 * Pictures are in the body. Reading one never changes anything, and nothing
 * in it can run an effect: the actions carry no `effect`.
 */
export const pastCardSchema = z.strictObject({
  id: z.string(),
  reviewTaskId: z.string().optional(),
  taskId: z.string().optional(),
  author: cardAuthorSchema,
  title: z.string(),
  meta: z.string(),
  model: z.string().optional(),
  body: z.string(),
  actions: z.array(cardActionSchema.omit({ effect: true })),
  width: cardWidthSchema.optional(),
  requiredActions: requiredActionsSchema.optional(),
  /** The crew's after-merge steps its saved story declared (INF-2796), drawn beside the merge. */
  afterMerge: afterMergeShownListSchema.optional(),
  /** The risk assessment of the version shown, which a past card draws as its live one did. */
  risk: riskAssessmentSchema.optional(),
  ending: z.strictObject({
    how: z.enum(PAST_ENDINGS),
    at: z.number(),
    /** The action the captain (or a script) chose; set when `how` is `chose`. */
    actionId: z.string().optional(),
    label: z.string().optional(),
    by: z.enum(["captain", "firstmate", "crewmate", "host", "frame"]).optional(),
  }),
  answers: cardAnswersSchema,
  messages: z.array(cardMessageSchema),
});
export type PastCard = z.infer<typeof pastCardSchema>;

/**
 * A captain turn's text, refused past this at the `inf:converse` boundary.
 * The composer reads the same number, so an over-long draft is kept, never
 * cleared and lost.
 */
export const CONVERSE_TEXT_MAX_CHARS = 20_000;

/**
 * Whether a card has an author a reply can reach. A crewmate card's reply
 * is a captain steer to that crewmate's session, which needs the task it
 * runs on. A Firstmate card's reply is a captain turn about that card
 * (cards-as-threads phase 2). The host's own agent-down cards answer to
 * nobody, and neither does a card the host marked as taking no reply (the
 * welcome, `Card.replies`), unless the host named the first mate as its
 * answerer (the stuck alert, `Card.answeredBy`).
 */
export function cardTakesReplies(
  card: Pick<Card, "author" | "taskId" | "replies" | "answeredBy">,
): boolean {
  if (card.replies === false) return false;
  if (card.author === "firstmate" || card.answeredBy === "firstmate") return true;
  return card.author === "crewmate" && card.taskId !== undefined;
}

/**
 * An image riding a captain turn or a thread reply/steer. An accepted turn
 * keeps message-owned copies (`src/core/attachments.ts`) that its inbox row
 * names; only a legacy row that could not keep the bytes says so with
 * `ATTACHMENTS_DROPPED_NOTE`.
 */
export const turnImageSchema = z.strictObject({
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(1).max(7_500_000),
  /** The file's display name, when the picture came from a file; text, never markup. */
  name: z.string().max(120).optional(),
});
export type TurnImage = z.infer<typeof turnImageSchema>;

export const TURN_IMAGES_MAX = 4;

/** A pasted picture's size cap, before base64 (the schema's data cap mirrors it). */
export const TURN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Durable copy of a turn whose images the inbox cannot keep. */
export const ATTACHMENTS_DROPPED_NOTE = "[image attachments could not be kept - ask to resend]";

/** The word a card is spoken of by ("decision", "note") from its actions alone. */
export function cardWord(card: { actions: readonly unknown[] }): "decision" | "note" {
  return card.actions.length > 0 ? "decision" : "note";
}

/** The discard a card action asks for, if any. */
export function settleEffectOf(action: Pick<CardAction, "effect">): SettleEffect | undefined {
  return action.effect?.kind === "settle" ? action.effect : undefined;
}

/**
 * The merge a card action asks for, if any (INF-2744). A card saved before
 * the one merge effect reads as it: its settle merge as a merge of the
 * task's current change that closes it, its `request_merge` as a merge of
 * that review that continues it, as each one meant then.
 */
export function mergeEffectOf(action: Pick<CardAction, "effect">): MergeEffect | undefined {
  const effect = action.effect as
    | { kind?: string; mode?: string; review?: unknown; proceedWithOpen?: true }
    | undefined;
  if (effect?.kind === "merge") return effect as MergeEffect;
  if (effect?.kind === "settle" && effect.mode === "merge")
    return {
      kind: "merge",
      after: "close",
      ...(effect.proceedWithOpen ? { proceedWithOpen: true as const } : {}),
    };
  if (effect?.kind === "request_merge" && typeof effect.review === "string")
    return { kind: "merge", review: effect.review, after: "continue" };
  return undefined;
}

/**
 * A card's actions with every merge in the one merge effect (INF-2744): a
 * card saved with the older `settle merge` or `request_merge` reads as the
 * merge it was, so a past card's history and a view's strict read agree.
 */
export function oneMergeEffect<A extends Pick<CardAction, "effect">>(actions: A[]): A[] {
  return actions.map((action) => {
    const merge = mergeEffectOf(action);
    return merge && action.effect?.kind !== "merge" ? { ...action, effect: merge } : action;
  });
}

/** The kept write a card action asks to send, if any. */
export function requestWriteEffectOf(
  action: Pick<CardAction, "effect">,
): RequestWriteEffect | undefined {
  return action.effect?.kind === "request_write" ? action.effect : undefined;
}

/**
 * Whether a click on this action opens a Settings section of the Mac where
 * Firstmate lives: an open effect on any section, or the host's
 * restore-account op, which the core answers with Subscriptions. A task's
 * browser is not Settings. An app controlling a first mate on an older
 * version sends no such click, since that first mate cannot answer it
 * (docs/view.md, "A first mate on an older version").
 */
export function opensSettings(action: Pick<CardAction, "effect">): boolean {
  const effect = action.effect;
  if (effect?.kind === "open") return effect.target !== "browser";
  return effect?.kind === "host" && effect.op === "restore-account";
}

/**
 * Whether a click on this action hands a task's browser to the captain, to
 * take control of its page on the Mac where Firstmate lives: a request
 * card's open-browser action (docs/task-browser.md, "Asking for help"). The
 * host's saved sign-in is not one, since it needs no one at the page. An
 * app controlling that Mac from another shows no task's page, so it sends
 * no such click (docs/view.md).
 */
export function takesTaskBrowser(action: Pick<CardAction, "effect">): boolean {
  const effect = action.effect;
  return effect?.kind === "open" && effect.target === "browser" && !effect.savedSignIn;
}

/**
 * What the shell does after a click, when the core asks it to: open
 * Settings, on a section, and - for the host's restore-account op - with
 * the account whose sign-in the Subscriptions tab re-runs on arrival, or -
 * for a sign-in where projects live - the host whose sign-in the Projects
 * tab starts on arrival, or what the Devices tab does on arrival.
 * Returned by `inf:cards:act`; the shell never reads an action id.
 */
export const shellEffectSchema = z.object({
  kind: z.literal("open"),
  target: z.enum(["settings", "subscriptions", "projects", "devices", "browser"]),
  /**
   * `browser`: the task's browser view to open, as the card's attachment
   * named it, with the card it came from (docs/task-browser.md, "Asking
   * for help").
   */
  browser: z
    .object({
      taskId: z.string(),
      session: z.string(),
      generation: z.number().int().positive(),
      cardId: z.string(),
    })
    .optional(),
  restoreAccountId: z.string().optional(),
  /** The host whose sign-in Settings -> Projects starts on arrival. */
  signIn: z.string().optional(),
  /** Settings -> Devices makes a link, or a command, on arrival. */
  make: deviceMakeSchema.optional(),
  /** Settings -> Devices removes this device on arrival. */
  remove: z.string().optional(),
  /** Settings -> Devices adds the Mac at this address over Remote Login on arrival. */
  add: z.string().optional(),
  /** Settings -> Devices updates Firstmate on this computer, added by its address, on arrival. */
  update: z.string().optional(),
  /** Settings -> General adds this private site for task browsers on arrival; the add checks it again. */
  privateSite: z.string().optional(),
  /** Settings -> Intelligence starts this sign-in on that computer on arrival. */
  signInOn: signInOnSchema.optional(),
  /** Settings -> Projects starts that computer's own sign-in where projects live on arrival. */
  forgeSignInOn: forgeSignInOnSchema.optional(),
  /** The section, the item it shows and the phone's link, as `settingsPlaceShape` says. */
  ...settingsPlaceShape,
});
export type ShellEffect = z.infer<typeof shellEffectSchema>;

/**
 * The action ids the host dispatched on before P1, as the effects they
 * meant. Migration 29 runs this once over the open cards of an upgraded
 * database, and the replay harness over the cards its recorded sessions
 * emit, so a card minted under the old contract still does what its
 * button says. `undefined` is an ordinary reply, untouched, the old close
 * controls included (`LEGACY_CLOSE_CONTROL_IDS`, INF-3108).
 */
export function legacyActionEffect(id: string): CardEffect | undefined {
  switch (id) {
    case "merge-pr":
    case "land":
      return { kind: "merge", after: "close" };
    case "discard":
      return { kind: "settle", mode: "discard" };
    case "discard-anyway":
      return { kind: "settle", mode: "discard", confirm: true };
    case "open-settings":
      return { kind: "open", target: "settings" };
    case "retry-firstmate":
      return { kind: "host", op: "retry-firstmate" };
    default:
      break;
  }
  const restore = "restore-account:";
  if (id.startsWith(restore))
    return { kind: "host", op: "restore-account", arg: id.slice(restore.length) };
  const move = "move-flagship:";
  if (id.startsWith(move)) return { kind: "host", op: "move-flagship", arg: id.slice(move.length) };
  return undefined;
}

/**
 * A card's actions from before P1 in P1's vocabulary: the reserved ids
 * become effects (a discard is danger), and every other action is the
 * reply it always was, the old close controls included. A settle merge or
 * a `request_merge` from before the one merge effect becomes that effect
 * (INF-2744, `mergeEffectOf`). Any other action that already carries an
 * effect is left alone, so the mapping is idempotent.
 */
export function migrateLegacyActions(actions: CardAction[]): CardAction[] {
  return oneMergeEffect(actions).flatMap((action) => {
    if (action.effect) return [action];
    const effect = legacyActionEffect(action.id);
    if (effect === undefined) return [action];
    const danger = effect.kind === "settle" && effect.mode === "discard";
    return [{ ...action, effect, ...(danger ? { danger: true, variant: "danger" as const } : {}) }];
  });
}

// --- The card evidence (the local human-supervision capture) ---------------
//
// docs/card-evidence.md. Every write to a card lands one typed observation
// beside it, in the same transaction, through `CardService` and
// `CardStore`: what was offered, when it was on the stage, what the captain
// or a body's script did with it, which thread line was about which offer,
// and how the card left. Facts only - no observation carries a label, a
// score or a judgment of what the captain meant.

/**
 * The capture contract the observations are written under, stamped on each
 * one. A reader treats a record from another version by that version's rules.
 */
export const CARD_CAPTURE_VERSION = 1;

export const CARD_OBSERVATION_KINDS = [
  "offer",
  "availability",
  "action",
  "message_ref",
  "exit",
  "effect_receipt",
  "seen",
] as const;
export type CardObservationKind = (typeof CARD_OBSERVATION_KINDS)[number];

/**
 * Who did it, as the host knows it: `frame` is a body's own script, which is
 * never proof the captain did anything.
 */
export const CARD_OBSERVATION_ACTORS = [
  "captain",
  "firstmate",
  "crewmate",
  "host",
  "frame",
] as const;
export type CardObservationActor = (typeof CARD_OBSERVATION_ACTORS)[number];

/**
 * Who a choice by a body's own script is credited to: its card's author, and
 * on a host card the first mate. The resolution and the past card's words
 * both read it, so neither ever names the captain for a `frame` choice.
 */
export function scriptChooser(author: CardAuthor): "firstmate" | "crewmate" {
  return author === "crewmate" ? "crewmate" : "firstmate";
}

/** The channel it came through, host-stamped. */
export const CARD_OBSERVATION_SOURCES = [
  // The card's own footer buttons.
  "chrome",
  // A body's script (`inf.action`).
  "frame",
  // The card chrome's close.
  "close-control",
  // A line typed under the card.
  "thread",
  // An agent's tool call (emit_card, close_card, reply, flag_duplicate).
  "tool",
  // The host's own logic.
  "host",
  // A boot that found the card open.
  "restore",
  // The window's stage, saying what it showed the captain.
  "stage",
] as const;
export type CardObservationSource = (typeof CARD_OBSERVATION_SOURCES)[number];

/**
 * Whether the offer the shell said it showed is the offer the core
 * dispatched: `legacy-missing` when the click said nothing about it,
 * `unavailable` when what it said could not be read or named no offer.
 */
export const cardDisplaySchema = z.strictObject({
  fidelity: z.enum(["matched", "mismatched", "legacy-missing", "unavailable"]),
  reportedOfferId: z.string().max(64).optional(),
  reportedLifecycleId: z.string().max(64).optional(),
});
export type CardDisplay = z.infer<typeof cardDisplaySchema>;

/**
 * The task as it stood the moment before a choice was admitted, read
 * through `TaskService` and frozen: the input a later reader may use, never
 * a pointer to a row that has moved on since.
 */
export const cardDecisionContextSchema = z.strictObject({
  at: z.number(),
  taskId: z.string(),
  key: z.string(),
  kind: z.string(),
  status: z.string(),
  activity: z.string().nullable(),
  parentId: z.string().nullable(),
  gate: z.strictObject({ kind: z.string(), ref: z.string().optional() }).nullable(),
  delivery: z
    .strictObject({
      mode: z.string(),
      changeLabel: z.string().optional(),
      headSha: z.string().optional(),
      checks: z.string().optional(),
      checksAt: z.number().optional(),
      review: z.string().optional(),
      reviewSha: z.string().optional(),
      reviewedAt: z.number().optional(),
      settlePending: z.boolean(),
    })
    .nullable(),
  /** The tasks this one waits on, with their status then. */
  blockers: z.array(z.strictObject({ id: z.string(), status: z.string() })),
  /** The captain's asks this task carries. */
  asks: z.array(z.string()),
});
export type CardDecisionContext = z.infer<typeof cardDecisionContextSchema>;

/** The words a note on an observation may carry: a reason, never a document. */
export const CARD_OBSERVATION_NOTE_MAX = 500;

/**
 * An offer: the exact version of a card the host put up, whole - its final
 * body with every fact the host appended, its actions in footer order with
 * their defaults and effects, its pictures' metadata. Immutable; its
 * observation id IS the offer id. `basis` says how it was taken: written by
 * an agent's emit, put by the host, or read off a card a boot found open
 * before the capture existed, whose start is unknown.
 */
export const cardOfferPayloadSchema = z.strictObject({
  reviewTaskId: z.string().optional(),
  basis: z.enum(["emitted", "put", "legacy-initial-snapshot"]),
  /** SHA-256 of the shown content, for a reader matching offers across cards. */
  fingerprint: z.string(),
  author: cardAuthorSchema,
  title: z.string(),
  meta: z.string(),
  model: z.string().optional(),
  place: z.string().optional(),
  body: z.string(),
  requiredActions: requiredActionsSchema.optional(),
  /** The crew's after-merge steps its saved story declared (INF-2796), drawn beside the merge. */
  afterMerge: afterMergeShownListSchema.optional(),
  actions: z.array(cardActionSchema),
  pictures: z.array(cardPictureSchema).optional(),
  files: z.array(cardFileSchema).optional(),
  width: cardWidthSchema.optional(),
  attachment: liveAttachmentSchema.optional(),
  risk: riskAssessmentSchema.optional(),
  asking: z.literal(true).optional(),
  designOnly: z.literal(true).optional(),
  continues: z.literal(true).optional(),
  answering: z.literal(true).optional(),
  holdsPlace: z.literal(true).optional(),
});

/**
 * An offer's place on the stage: `available` while the stage shows it (not
 * proof anyone read it), `waiting` while it waits on its author's close-out
 * or on the answer to the captain's reply. The first one of a lifecycle says
 * how it began; `replaces` names the offer an available one took over from.
 */
export const cardAvailabilityPayloadSchema = z.strictObject({
  state: z.enum(["available", "waiting"]),
  waitingOn: cardAwaitingSchema.optional(),
  cause: z.enum(["emit", "revise", "put", "close-out", "reply", "answered", "restore"]),
  closeOut: z.enum(["report", "idle", "turn-end", "restart"]).optional(),
  replaces: z.string().optional(),
  lifecycle: z.enum(["started", "reopened", "legacy-initial-snapshot"]).optional(),
  predecessor: z.string().optional(),
});

/**
 * One interaction with an offer's actions - closing or not - as the host
 * admitted it: the action's id and, when the offer declared it, its label
 * and effect; the committed answers; the question definitions the body
 * reported with them; the task as it stood before; and whether the offer
 * the shell showed is the one the core dispatched. An id the offer never
 * declared is kept as `recognized: false`, never as a choice.
 */
export const cardActionPayloadSchema = z.strictObject({
  actionId: z.string(),
  /** Last thread message already present at this interaction, not a later reply. */
  precedingMessageId: z.number().int().nonnegative().optional(),
  recognized: z.boolean(),
  label: z.string().nullable(),
  closes: z.boolean(),
  keepsOpen: z.boolean(),
  effect: cardEffectSchema.nullable(),
  /** A body script's own value, as JSON text (at most 4,096 bytes). */
  frameValue: z.string().optional(),
  answers: cardAnswersSchema.optional(),
  display: cardDisplaySchema,
  reading: z.enum(["fresh", "fallback", "none"]).optional(),
  remounted: z.literal(true).optional(),
  questions: cardQuestionsSchema.optional(),
  questionsGap: z.enum(["absent", "no-fresh-reading", "too-large", "invalid"]).optional(),
  context: cardDecisionContextSchema.optional(),
  contextGap: z.enum(["no-task", "task-missing"]).optional(),
  /** Who minted the interaction id: the shell at the gesture, or the host for a click that sent none. */
  interactionSource: z.enum(["shell", "host"]),
  /** What pressed the button, as the shell said; absent when it did not say or could not tell. */
  input: cardPressInputSchema.optional(),
});

/**
 * A thread line about the card: which message (its words stay in
 * `card_messages`), who wrote it, and the offer on the stage then. A reply
 * resolves nothing.
 */
export const cardMessageRefPayloadSchema = z.strictObject({
  messageId: z.number().int(),
  who: cardMessageWhoSchema,
  /** Typed control provenance for written answers; words themselves stay with their owner. */
  questions: cardQuestionsSchema.optional(),
  questionsGap: cardActionPayloadSchema.shape.questionsGap,
  /** An interim author line does not release a new answer. */
  interim: z.literal(true).optional(),
  answers: cardAnswersSchema.optional(),
  display: cardDisplaySchema.optional(),
});

/**
 * How a lifecycle ended without a declared action: the captain's close, the
 * author's withdrawal, the host taking a card whose question is gone, a
 * settled task retiring its cards, or a confirmed duplicate. A closing
 * action is its own `action`, never an exit too.
 */
export const cardExitPayloadSchema = z.strictObject({
  reason: z.enum([
    "dismissed",
    "author-withdrawal",
    "host-withdrawal",
    "task-retired",
    "duplicate",
  ]),
  note: z.string().max(CARD_OBSERVATION_NOTE_MAX).optional(),
  duplicateOf: z.string().optional(),
  display: cardDisplaySchema.optional(),
});

/**
 * What directly became of an interaction's effect, where the host holds the
 * fact at the card seam. None is written yet: until one is, an
 * interaction's outcome is unknown, never a success or a failure.
 */
export const cardEffectReceiptPayloadSchema = z.strictObject({
  interactionId: z.string(),
  outcome: z.enum(["completed", "refused", "failed", "queued"]),
  note: z.string().max(CARD_OBSERVATION_NOTE_MAX).optional(),
});

/**
 * The captain had this offer in front of them: the stage showed it while the
 * window was visible and focused. Legacy sightings are once per offer; an exact
 * update sighting also names its released update. Both retain the offer that
 * the next revision is compared with (`Card.changes`).
 */
export const cardSeenPayloadSchema = z.strictObject({
  /** Absent on legacy offer sightings; those never acknowledge a released update. */
  updateId: z.string().max(64).optional(),
});

export const cardObservationPayloadSchemas = {
  offer: cardOfferPayloadSchema,
  availability: cardAvailabilityPayloadSchema,
  action: cardActionPayloadSchema,
  message_ref: cardMessageRefPayloadSchema,
  exit: cardExitPayloadSchema,
  effect_receipt: cardEffectReceiptPayloadSchema,
  seen: cardSeenPayloadSchema,
} as const satisfies Record<CardObservationKind, z.ZodType>;

export type CardObservationPayload<K extends CardObservationKind> = z.infer<
  (typeof cardObservationPayloadSchemas)[K]
>;

/** One observation, as `CardStore` hands it back. */
export type CardObservation = {
  [K in CardObservationKind]: {
    /** The local order: stable where two share a clock tick. */
    seq: number;
    id: string;
    kind: K;
    cardId: string;
    lifecycleId: string;
    taskId: string | null;
    schemaVersion: number;
    captureVersion: number;
    recordedAt: number;
    actor: CardObservationActor;
    source: CardObservationSource;
    offerId: string | null;
    interactionId: string | null;
    messageId: number | null;
    build: string | null;
    payload: CardObservationPayload<K>;
  };
}[CardObservationKind];
