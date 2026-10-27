import { z } from "zod";
import { SPELLINGS } from "./codeNames.ts";
import { requiredActionsSchema } from "./requiredActions.ts";
import { rigorSchema } from "./rigor.ts";

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
 * A host-run settle. `merge` is resolved by the host from the task's
 * delivery posture (merge the PR on a direct-pr repo, land the branch into
 * the local checkout otherwise), so no agent ever learns the difference.
 * `confirm` discards work the body already says is unlanded (the host's own
 * confirm gate). `proceedWithOpen` is P2's (WI-11) close over open
 * follow-ups, declared now so the schema changes once.
 */
export const settleEffectSchema = z.object({
  kind: z.literal("settle"),
  mode: z.enum(["merge", "discard"]),
  confirm: z.literal(true).optional(),
  proceedWithOpen: z.literal(true).optional(),
});
export type SettleEffect = z.infer<typeof settleEffectSchema>;

/**
 * A request to merge one reviewed pull request (FI3-1543). Declaring it
 * grants no approval and merges nothing. `review` is the id `check_change`
 * stored; the host resolves the target from that record, never from the card.
 */
export const requestMergeEffectSchema = z.object({
  kind: z.literal("request_merge"),
  review: z.string().min(1).max(64),
});
export type RequestMergeEffect = z.infer<typeof requestMergeEffectSchema>;

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
  /** Only the host's integration approval card declares the duration or refusal. */
  integration: z.enum(["always", "once", "deny"]).optional(),
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
  | { make: DeviceMake }
  | { remove: string }
  | { add: string }
  | { update: string };

/** The arrival an open effect on Devices carries, as the store keeps it. */
export function deviceArrival(effect: {
  make?: DeviceMake | undefined;
  remove?: string | undefined;
  add?: string | undefined;
  update?: string | undefined;
}): { pendingDeviceArrival: DeviceArrival } | Record<string, never> {
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
 * Settings -> Projects starts there on arrival (docs/forge.md, "A
 * computer's own sign-in"): the code to read opens under that computer's
 * row. Only the host's own cards carry it.
 */
export const forgeSignInOnSchema = z.object({
  deviceId: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
});

/**
 * An open effect: Settings on a section, or - on a crewmate's card that asks
 * the captain to take over its task's browser - that browser's view with the
 * captain in control (`browser`, docs/task-browser.md "Asking for help"),
 * the card's own attachment naming which browser. With `savedSignIn` the
 * browser gets the captain's saved sign-in for its site instead and goes
 * back to its crewmate ("Saved sign-ins"); only the host adds that action.
 */
export const openEffectSchema = z.object({
  kind: z.literal("open"),
  target: z.enum(["settings", "subscriptions", "projects", "devices", "browser"]),
  savedSignIn: z.literal(true).optional(),
  signIn: z.string().min(1).max(253).optional(),
  make: deviceMakeSchema.optional(),
  remove: z.string().min(1).max(64).optional(),
  // The address, as the line's own value schema read it (`remoteLoginAddressSchema`);
  // `inf:devices:add` reads it again before anything is reached.
  add: z.string().min(1).max(255).optional(),
  update: z.string().min(1).max(64).optional(),
  signInOn: signInOnSchema.optional(),
  forgeSignInOn: forgeSignInOnSchema.optional(),
});
export type OpenEffect = z.infer<typeof openEffectSchema>;

/**
 * The host's own operations, carried only by the cards it authors (the
 * agent-down set, the consent card, and the idle-stall card): re-run an
 * account's sign-in (`arg` = account id), move the Firstmate flagship to
 * another provider (`arg` = provider id), retry the failed Firstmate turn,
 * try a refused account again (`arg` = account id; the only way a refusal
 * clears on the captain's word, W1 S9),
 * add or turn down a plugin waiting on the captain's consent (`arg` =
 * plugin id; one plugin vehicle, Phase A, A2a), add or turn down a project
 * Firstmate proposed on the setup card (`arg` = the card's offer as JSON,
 * `ProjectSetupOffer`; Add project also reads the card's answers), tell a stuck
 * crewmate to carry on or stop its task (`arg` = task id; idle crew
 * recovery), move a started task off the provider that failed it to the
 * app's pick (`arg` = task id and that provider, joined by a colon; INF-849),
 * start a charted task now (`arg` = task id), and send a message
 * Firstmate never answered once more (`arg` = the message's id). An effect is
 * never declared to a body's frame, so only the captain's click on the
 * card's own controls runs one.
 *
 * The task record's footer (`TASK_LIFECYCLE_OPS`, `inf:task:run`) runs the
 * same start, stop and continue ops, plus Drop task on never-started work,
 * and the task board adds queue and unqueue. Drop task, queue and unqueue
 * are not card effects. Merge, discard and keep stay on cards.
 */
export const HOST_OPS = [
  "restore-account",
  "move-flagship",
  "retry-firstmate",
  "try-again",
  "add-plugin",
  "decline-plugin",
  "apply-project-change",
  "decline-project-change",
  "add-project",
  "decline-project",
  "continue-task",
  "move-task",
  "stop-task",
  "start-task",
  "ask-again",
  "confirm-required-action",
  "defer-required-action",
] as const;

/**
 * The host ops that turn down what a host card asks (the consent card, the
 * setup card): closing that card is the same answer, never a question left
 * behind a card nobody can see.
 */
export const HOST_DECLINE_OPS: ReadonlySet<(typeof HOST_OPS)[number]> = new Set([
  "decline-plugin",
  "decline-project",
  "decline-project-change",
]);

/**
 * The host ops the task record's footer and the task board run, on one
 * task. `drop-task` is the footer's own, and `queue-task` and
 * `unqueue-task` the board's (src/shared/taskQueue.ts): none is a card host
 * effect.
 */
export const TASK_LIFECYCLE_OPS = [
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
  requestMergeEffectSchema,
  requestWriteEffectSchema,
  openEffectSchema,
  hostEffectSchema,
]);
export type CardEffect = z.infer<typeof cardEffectSchema>;

/** The effects an agent may declare (D2): every kind but the host's own. */
export const agentEffectSchema = z.discriminatedUnion("kind", [
  settleEffectSchema,
  requestMergeEffectSchema,
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
 * Whether a body is a preview rather than prose: it brings behaviour or
 * styling of its own - a `<style>` sheet, a `<canvas>`, or a `<script>`
 * outside every `<figure>`. Such a body is markup first and copy second, so
 * the rules written for prose do not read it - the shape lint lets it be
 * (core/pi/cardLint.ts), the Firstmate's context line quotes no excerpt from
 * it (core/orchestrator/firstmateAgent.ts) and no change bar marks it
 * (core/orchestrator/cardChanges.ts). A script inside a figure only makes
 * that figure move (FI3-796, the captain's yes): the body stays prose. It is
 * a shape test, never a kind test.
 */
export function isPreviewBody(body: string): boolean {
  let figures = 0;
  for (const [, raw, close, tag] of body.matchAll(PREVIEW_TAGS)) {
    const name = (raw ?? tag ?? "").toLowerCase();
    if (name === "style" || (name === "canvas" && !close)) return true;
    if (name === "script" && figures === 0) return true;
    if (name === "figure") figures = close ? Math.max(0, figures - 1) : figures + 1;
  }
  return false;
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

/**
 * The facts the host writes on a settle card's fact strip
 * (`CrewSupervisor.settleFacts`), in the order it writes them; each cell
 * carries its fact in `data-fact`. A cell is present only when the host
 * holds that fact.
 */
export const SETTLE_FACTS = [
  "project",
  "device",
  "crewmate",
  "care",
  "change",
  "lines",
  "checks",
  "review",
  "override",
] as const;
export type SettleFact = (typeof SETTLE_FACTS)[number];

/**
 * The class of a settle fact's value inside its `data-fact` cell, as the
 * host writes the strip: a reader takes a fact's value by it, never by the
 * label beside it. The frame stylesheet gives it its look.
 */
export const SETTLE_FACT_VALUE_CLASS = "inf-fact-v";

/** How the host opens a settle card's fact strip; its cells hold no `div`, so the next `</div>` closes it. */
export const SETTLE_FACTS_OPEN = '<div class="inf-facts" data-facts>';

/**
 * Whether the host writes its fact strip on a card, and the stage draws it
 * beside the buttons: a settle card, an independent review's card, and the
 * story note of a task that merges on its own (INF-1219), which is the one
 * card with a risk assessment and no actions - the risk rides only a merge
 * offer and that note, both written by the host from the crewmate's story.
 */
export function takesFactStrip(card: Pick<Card, "actions" | "reviewTaskId" | "risk">): boolean {
  if (card.reviewTaskId) return true;
  if (card.actions.some((action) => settleEffectOf(action))) return true;
  return card.risk !== undefined && card.actions.length === 0;
}

/**
 * A settle card's body without the host's fact strip, and the strip itself,
 * so the stage shows the strip beside the card's buttons rather than at the
 * end of a body that may scroll it out of view. The host appends its strip
 * after the author's body, so the last one is the host's. `at` is where it
 * was cut out. Undefined when the body carries no strip.
 */
export function splitSettleFacts(
  body: string,
): { body: string; facts: string; at: number } | undefined {
  // A home on the other side of the Infinitary rename writes its own spelling.
  const at = Math.max(
    ...SPELLINGS.map((spelling) => body.lastIndexOf(`<div class="${spelling}-facts" data-facts>`)),
  );
  if (at < 0) return undefined;
  const close = body.indexOf("</div>", at);
  if (close < 0) return undefined;
  const end = close + "</div>".length;
  return { body: body.slice(0, at) + body.slice(end), facts: body.slice(at, end), at };
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
export const CARD_ANSWERS_BOUND_REFUSAL = `The card's answers must be JSON no larger than ${CARD_ANSWERS_MAX_BYTES.toLocaleString("en-US")} bytes.`;
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
export const CARD_REPLY_HINT = "anything to add?";
/** The button at the right edge of a card's choices that sends the field as a reply. */
export const CARD_CHAT_LABEL = "Chat";
/** What leads the words a past card's field sent with its choice. */
export const PAST_CARD_WORDS_LEAD = "Sent with your choice:";
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

/**
 * The captain's answers to a card body's own questions, one line each, in
 * the words every reader gets them in - the author's wake, the Firstmate's
 * resolutions line, a build brief grounded in the card (contract 4.22). A
 * picked option reads as the text of the `<label>` bound to it with its
 * value beside it; an option with none reads as its value alone; a staged
 * snapshot stays JSON. What the captain wrote under Something else follows
 * the picks as `written in: "…"`. Whether each differs from what the card
 * proposed is the bridge's typed fact, never read off the words.
 */
export function cardAnswerLines(answers: readonly CardAnswer[]): string[] {
  return answers.map((answer) => {
    const parts = answer.json
      ? [`${answer.values[0] ?? ""} (JSON)`]
      : answer.values.map((value, index) => {
          const label = answer.labels?.[index];
          return label && label !== value
            ? `${JSON.stringify(label)} (${value})`
            : JSON.stringify(value);
        });
    if (answer.written !== undefined) parts.push(`written in: ${JSON.stringify(answer.written)}`);
    const picked = parts.length === 0 ? "no answer" : parts.join(", ");
    return `- ${answer.name}: ${picked}, ${answer.changed ? "changed" : "as proposed"}`;
  });
}

/**
 * The line above a reply's settings in what its author reads: the settings
 * are context for the captain's words, never permission.
 */
export const REPLY_SETTINGS_HEAD = "Current settings (context, not permission):";

/**
 * A captain's reply as its author reads it: his words, then the settings
 * and answers the card sent with them. The thread keeps the two apart
 * (`CardMessage.answers`); every agent reader joins them here.
 */
export function replyWithSettings(text: string, answers?: readonly CardAnswer[]): string {
  return answers?.length
    ? `${text}\n${REPLY_SETTINGS_HEAD}\n${cardAnswerLines(answers).join("\n")}`
    : text;
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
export const cardSubmissionSchema = z.strictObject({
  id: z.string().min(8).max(64),
  lifecycleId: z.string().max(64).optional(),
  offerId: z.string().max(64).optional(),
  reading: z.enum(["fresh", "fallback", "none"]).optional(),
  /** The card showed another offer by the time the reading came back. */
  remounted: z.literal(true).optional(),
  questions: cardQuestionsSchema.optional(),
  questionsGap: cardQuestionsGapSchema.optional(),
});
export type CardSubmission = z.infer<typeof cardSubmissionSchema>;

/** The meta line of a card the Firstmate itself writes, where a crewmate's card names its task. */
export const FIRSTMATE_CARD_META = "firstmate";
/** INF-63: the app-owned label for a validated independent review. */
export const REVIEW_FINDING_LABEL = "Review finding";

/** How a card's meta line reads: the first mate's own cards say who wrote them in words, never the stored name. */
export function cardMetaWords(meta: string): string {
  return meta === FIRSTMATE_CARD_META ? "first mate" : meta;
}

/**
 * Strict on purpose: the wire refuses a `kind` (or any other field the
 * model does not have), so a card can only ever be dressed by what it is.
 */
/**
 * The captain's message a card is about (`Card.asked`): when they sent it
 * and their words, whole. The chrome shows the start and opens the rest on
 * request, so a long message never fills the card.
 */
export const cardAskedSchema = z.strictObject({
  at: z.number(),
  text: z.string(),
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
  requiredActions: requiredActionsSchema.optional(),
  actions: z.array(cardActionSchema),
  status: z.enum(["streaming", "ready"]),
  createdAt: z.number(),
  /**
   * The pictures the host verified in the body (card pictures, phase 2;
   * `cards.pictures`): id, alt, size and group, never the bytes. Absent on a
   * card that names none.
   */
  pictures: z.array(cardPictureSchema).optional(),
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
  /** Snapshot-only: the captain has seen an offer in this lifecycle, from card observations. */
  seen: z.boolean().optional(),
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
 * captain's close, the author's withdrawal, or a note's seen-collapse - all
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

export const cardMessageSchema = z.strictObject({
  revision: cardRevisionSchema.optional(),
  revisionShown: revisionShownSchema.optional(),
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
 * welcome, `Card.replies`).
 */
export function cardTakesReplies(card: Pick<Card, "author" | "taskId" | "replies">): boolean {
  if (card.replies === false) return false;
  if (card.author === "firstmate") return true;
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

/**
 * The settle a card action asks for, if any. A `merge` is the delivery
 * posture's own mode; the host resolves it where it knows the task.
 */
export function settleEffectOf(action: Pick<CardAction, "effect">): SettleEffect | undefined {
  return action.effect?.kind === "settle" ? action.effect : undefined;
}

/** The reviewed-pull-request merge a card action requests, if any. */
export function requestMergeEffectOf(
  action: Pick<CardAction, "effect">,
): RequestMergeEffect | undefined {
  return action.effect?.kind === "request_merge" ? action.effect : undefined;
}

/** The kept write a card action asks to send, if any. */
export function requestWriteEffectOf(
  action: Pick<CardAction, "effect">,
): RequestWriteEffect | undefined {
  return action.effect?.kind === "request_write" ? action.effect : undefined;
}

/**
 * An action whose click asks to merge a pull request: the posture's settle
 * merge, or a `request_merge` of one stored review. Readers use this instead
 * of matching an action id.
 */
export function isPullRequestMergeAction(action: Pick<CardAction, "effect">): boolean {
  return settleEffectOf(action)?.mode === "merge" || requestMergeEffectOf(action) !== undefined;
}

/**
 * Whether a click on this action opens a Settings section of the Mac where
 * Firstmate lives: an open effect on any section, or the host's
 * restore-account op, which the core answers with Subscriptions. A task's
 * browser is not Settings. An app controlling that Mac from another keeps
 * none of those sections, so it sends no such click (docs/view.md).
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
  /** Settings -> Intelligence starts this sign-in on that computer on arrival. */
  signInOn: signInOnSchema.optional(),
  /** Settings -> Projects starts that computer's own sign-in where projects live on arrival. */
  forgeSignInOn: forgeSignInOnSchema.optional(),
});
export type ShellEffect = z.infer<typeof shellEffectSchema>;

/**
 * The action ids the host dispatched on before P1, as the effects they
 * meant. Migration 29 runs this once over the open cards of an upgraded
 * database, and the replay harness over the cards its recorded sessions
 * emit, so a card minted under the old contract still does what its
 * button says. `null` is an id that carried no meaning worth keeping:
 * `later` parked (gone since P0), `keep` and `dismiss` were the close
 * control, which every card has in its chrome. `undefined` is an ordinary
 * reply, untouched.
 */
export function legacyActionEffect(id: string): CardEffect | null | undefined {
  switch (id) {
    case "merge-pr":
    case "land":
      return { kind: "settle", mode: "merge" };
    case "discard":
      return { kind: "settle", mode: "discard" };
    case "discard-anyway":
      return { kind: "settle", mode: "discard", confirm: true };
    case "open-settings":
      return { kind: "open", target: "settings" };
    case "retry-firstmate":
      return { kind: "host", op: "retry-firstmate" };
    case "later":
    case "keep":
    case "dismiss":
      return null;
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
 * become effects (a discard is danger), the ids that were the close control
 * go, and every other action is the reply it always was. An action that
 * already carries an effect is left alone, so the mapping is idempotent.
 */
export function migrateLegacyActions(actions: CardAction[]): CardAction[] {
  return actions.flatMap((action) => {
    if (action.effect) return [action];
    const effect = legacyActionEffect(action.id);
    if (effect === null) return [];
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
  actions: z.array(cardActionSchema),
  pictures: z.array(cardPictureSchema).optional(),
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
});

/**
 * A thread line about the card: which message (its words stay in
 * `card_messages`), who wrote it, and the offer on the stage then. A reply
 * resolves nothing.
 */
export const cardMessageRefPayloadSchema = z.strictObject({
  messageId: z.number().int(),
  who: cardMessageWhoSchema,
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
 * window was visible and focused. Written once per offer, only for the one
 * the stage shows; what the next revision is compared with (`Card.changes`).
 */
export const cardSeenPayloadSchema = z.strictObject({});

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
