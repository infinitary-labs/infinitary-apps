import { type AgentEffect, type CardPicture, LIVE_ATTACHMENT_LABEL_MAX } from "@shared/cards";
import { type RequiredAction, requiredActionsSchema } from "@shared/requiredActions";
import {
  RISK_DIMENSIONS,
  RISK_LEVELS,
  RISK_WHY_MAX,
  type RiskDeclaration,
  riskDeclarationSchema,
} from "@shared/risk";
import { TASK_BROWSER_REQUEST_MAX, UNKNOWN_OUTCOME_WORDS } from "@shared/taskBrowser";
import { type Static, type TSchema, Type } from "typebox";
import { browserCommand } from "../browser/commandWords";
import {
  CARD_PARAMS,
  CREWMATE_EMIT_CARD_DESCRIPTION,
  FIRSTMATE_EMIT_CARD_DESCRIPTION,
} from "../prompts/cardContract";
import {
  bindTool,
  boundTool,
  CardRefusedError,
  type CrewmateTool,
  type CrewmateToolDelegate,
  callWithSignal,
  cardRefusalOf,
  crewmateTool,
  type DeclaredAction,
  type EmittedAction,
  labeledActions,
  OutcomeUnknownError,
  stringEnum,
  type ToolOutput,
  zodParameter,
} from "../session/tools";
import { MAX_CARD_BODY_LENGTH, readCardBodyFile } from "./cardBodyFile";
import { type CardPictureRoot, cardPictureRoot, verifyCardImages } from "./cardImages";

/**
 * The card surface (decision D-9): a custom Pi tool through which an agent
 * emits cards - one shape, its actions carrying effects (cards/tasks/agents
 * P1). The description IS the card contract (`src/core/prompts/
 * cardContract.ts`, contract v2.0) plus the caller's role addendum, and the
 * crewmate's tool is one entry of the crewmate tool spec
 * (`../session/tools.ts`) that both runtimes generate their tool from, so
 * the two cannot drift.
 *
 * Trap to respect: Pi's `tools` allowlist gates custom tools too - the
 * session must list "emit_card" or the tool is silently disabled.
 */

export const EMIT_CARD_TOOL_NAME = "emit_card";
export const CLOSE_CARD_TOOL_NAME = "close_card";

export const CLOSE_CARD_TOOL_DESCRIPTION = [
  "Withdraw a card of YOUR OWN that is no longer valid or necessary, without waiting for the captain, by the id emit_card returned.",
  "A note you emitted as this turn's answer is current and must not be withdrawn during this turn.",
  "Close a decision only when the choice no longer applies - you are withdrawing it as obsolete, not answering for the captain.",
  "Someone else's card is not yours to close - steer its author instead; the captain dismisses a card themselves.",
].join(" ");

const STABLE_CARD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STABLE_CARD_ID_MAX = 64;

/** The crewmate's emit_card description: the contract plus the completion card. */
export const EMIT_CARD_TOOL_DESCRIPTION = CREWMATE_EMIT_CARD_DESCRIPTION;

/**
 * The Firstmate persona's emit_card description: the contract plus attach
 * first (task-system P1) and steer-not-answer (WI-12). A crewmate's cards
 * attach to its own task by construction, so its description stays without
 * them, and so does its schema.
 */
export const FIRSTMATE_EMIT_CARD_TOOL_DESCRIPTION = FIRSTMATE_EMIT_CARD_DESCRIPTION;

/**
 * A declared card action as the tools carry it: `default` is WI-10's
 * decision shape, `effect` and `danger` P1's effect vocabulary
 * (`src/shared/cards.ts`). One type for the Pi and Claude tools and the
 * supervisor's input.
 */
export type { EmittedAction } from "../session/tools";

/**
 * The effect parameter as the model passes it, for both tool runtimes:
 * a flat shape with `confirm` as a plain boolean, normalized to the wire's
 * `AgentEffect` (settle | open; the host kind is not offered).
 */
export type EffectParam =
  | { kind: "settle"; mode: "merge" | "discard"; confirm?: boolean; proceed_with_open?: boolean }
  | { kind: "request_merge"; review: string }
  | { kind: "request_write"; ask: string }
  | {
      kind: "open";
      target: "settings" | "subscriptions" | "projects" | "browser";
      sign_in?: string;
    };

export function agentEffect(effect: EffectParam): AgentEffect {
  if (effect.kind === "open") {
    return {
      kind: "open",
      target: effect.target,
      ...(effect.sign_in ? { signIn: effect.sign_in } : {}),
    };
  }
  if (effect.kind === "request_merge") {
    return { kind: "request_merge", review: effect.review };
  }
  if (effect.kind === "request_write") {
    return { kind: "request_write", ask: effect.ask };
  }
  return {
    kind: "settle",
    mode: effect.mode,
    ...(effect.confirm ? { confirm: true } : {}),
    ...(effect.proceed_with_open ? { proceedWithOpen: true } : {}),
  };
}

/**
 * The emit_card action parameter's own fields, shared by the Pi and Claude
 * tools. A crewmate's action may come without a label (`DeclaredAction`).
 */
export function emittedAction(action: {
  id: string;
  label?: string;
  default?: boolean;
  effect?: EffectParam;
  danger?: boolean;
}): DeclaredAction {
  return {
    id: action.id,
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.default ? { default: true } : {}),
    ...(action.effect ? { effect: agentEffect(action.effect) } : {}),
    ...(action.danger ? { danger: true } : {}),
  };
}

/** One card shape (ruling D1 a): the emitter declares no kind. */
export type EmittedCard = {
  title: string;
  body: string;
  /** A completion from the current saved change story; resolved by the home before any card lint. */
  presentationRevision?: number;
  actions: EmittedAction[];
  id?: string;
  /**
   * The task the card is about (task-system P1, attach first): an answer
   * about existing work, or a decision gating it - a settle effect needs
   * it. Consumed at the tool boundary; it does not ride into the rendered
   * card. Only the Firstmate's schema carries it.
   */
  taskId?: string;
  /** The independent review whose findings the first mate relays; host validates reviewOf. */
  reviewTaskId?: string;
  /**
   * The explicit assertion that a note is a one-off with no connection to
   * any work (D1): only then does the host file it as its own question
   * task. A note with neither task_id nor standalone is refused.
   */
  standalone?: boolean;
  /**
   * The pictures the host verified in the body and copied under the task
   * (card pictures, phase 2): written on the card row, never the bytes.
   */
  pictures?: CardPicture[];
  /**
   * The author's width hint (`width` on the tool): it can only widen what
   * the body's facts already ask for (`decidedCardWidth`).
   */
  width?: "wide" | "full";
  /** Replies stay shown and arrivals come forward; every choice still closes. */
  holdsPlace?: boolean;
  /** The short answer to the captain's reply in this card's thread, posted beside a revision. */
  reply?: string;
  /**
   * The label of the button that opens the crewmate's task browser
   * (`browser_button`, only on a task that has one): the host resolves it
   * into the card's live attachment, or refuses the card.
   */
  browserButton?: string;
  /**
   * The HTML file in the crewmate's task's project that its browser button
   * opens (`browser_page`, only beside `browser_button`): the host checks it
   * and turns the button into the card's page from the project, or refuses
   * the card.
   */
  browserPage?: string;
  /**
   * A request that the captain take over the crewmate's task browser
   * (`browser_handoff`, only on a task that has one): the host pauses the
   * browser before the card goes up, or refuses the card.
   */
  browserHandoff?: { site: string; reason: string; after: string };
  /** Bind the shown ordinary action to a recorded validation request. */
  validationDecision?: { request: string; action: string };
  /**
   * The crewmate's risk assessment of its change (`risk`, only on its
   * completion decision; docs/card-authoring.md "The risk chart"): the host
   * measures the change beside it and draws both as the card's radar.
   */
  riskDeclaration?: RiskDeclaration;
  requiredActions?: RequiredAction[];
  /** Declared: this card still asks a question and is not the ready plan. */
  asking?: boolean;
  /** Declared: this offer is design-only. Not inferred from its sentences. */
  designOnly?: boolean;
  /** Declared: the captain's choice on it is not the task's answer (INF-1226). */
  continues?: boolean;
};

export type OnCardEmitted = (card: EmittedCard) => string | undefined | Promise<string | undefined>;

/** A card as the tool reads it from the call, before any action is checked for words. */
type DeclaredCard = Omit<EmittedCard, "actions"> & { actions: DeclaredAction[] };

/**
 * A boundary lint over the emitted card (contract v1 shape rules, v2.0
 * facts-and-fix refusals): returns corrective refusal text, or undefined to
 * let the card through. A refusal is thrown as a loud tool error and the
 * card is never shown.
 */
export type CardLint = (card: EmittedCard) => string | undefined;

export type CloseCardInput = {
  cardId: string;
  reason?: string;
};

export type OnCardClosed = (input: CloseCardInput) => string;

/** Validate the optional emit_card id. Empty is absent; anything else must be kebab-case. */
export function parseStableCardId(raw: string | undefined): string | undefined {
  const id = raw?.trim() ?? "";
  if (!id) return undefined;
  if (id.length > STABLE_CARD_ID_MAX || !STABLE_CARD_ID.test(id)) {
    throw new Error(
      "Card id must be kebab-case and at most 64 characters (for example fm-feed-scroll).",
    );
  }
  return id;
}

/** Firstmate-routable card id from a caller-supplied stable key. */
export function resolveFirstmateCardId(stableId: string): string {
  if (stableId.startsWith("card-fm-")) return stableId;
  if (stableId.startsWith("fm-")) return `card-${stableId}`;
  return `card-fm-${stableId}`;
}

const settleEffectParam = Type.Object({
  kind: Type.Literal("settle"),
  mode: stringEnum(["merge", "discard"]),
  confirm: Type.Optional(Type.Boolean()),
  proceed_with_open: Type.Optional(Type.Boolean()),
});

const requestMergeEffectParam = Type.Object({
  kind: Type.Literal("request_merge"),
  review: Type.String(),
});

/** A crewmate's ask to send a write it kept (FI3-1571 piece 4); no Firstmate schema carries it. */
const requestWriteEffectParam = Type.Object({
  kind: Type.Literal("request_write"),
  ask: Type.String(),
});

const openEffectParam = Type.Object({
  kind: Type.Literal("open"),
  target: stringEnum(["settings", "subscriptions", "projects"]),
  sign_in: Type.Optional(Type.String()),
});

/**
 * The open effect a crewmate whose task has its own browser may also
 * declare: its browser's view, with the captain in control, on a card that
 * asks for his help (`browser_handoff`).
 */
const browserOpenEffectParam = Type.Object({
  kind: Type.Literal("open"),
  target: stringEnum(["settings", "subscriptions", "projects", "browser"]),
  sign_in: Type.Optional(Type.String()),
});

/** One declared action, with the effects a role's schema may declare. */
function actionParam<Effect extends TSchema>(effect: Effect) {
  // Open to fields it does not declare, so a retired `keeps_open` reaches
  // `emitCard` on both runtimes and is refused there rather than dropped
  // (the Claude client would strip an undeclared field).
  return Type.Object(
    {
      id: Type.String(),
      label: Type.String(),
      default: Type.Optional(Type.Boolean()),
      effect: Type.Optional(effect),
      danger: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  );
}

/**
 * A crewmate's declared action: the same, with its label optional (FI3-249).
 * The crewmate is told the host attaches a completion decision's buttons
 * and to declare no labels, so a schema that asked for one refused that
 * card before the host saw it. The host words its own buttons and refuses
 * any other action without words (`labeledActions`).
 */
function crewActionParam<Effect extends TSchema>(effect: Effect) {
  return Type.Object(
    { ...actionParam(effect).properties, label: Type.Optional(Type.String()) },
    { additionalProperties: true },
  );
}

/**
 * The fields every emit_card carries, whichever role calls it. Only the
 * top-level ones are described: an action's rules ride `actions` and the
 * tool's own description (`CARD_PARAMS`).
 */
const REQUIRED_ACTIONS_DESCRIPTION =
  "Required on a completion merge offer, including [] when none. Display-only obligations: id (stable kebab-case), optional sharedId (explicitly shared outstanding action), target, title (imperative), consequence, instructions (list), criterion, prerequisites (task IDs), completion (manual with label, or device-version with deviceId and minVersion). Merging never performs them. Captain-only parts; post-merge fleet work is a Continue: ... filing. The first mate may declare immediately required actions on a non-merge card.";

const sharedCardParams = {
  required_actions: Type.Optional(
    zodParameter<RequiredAction[]>(requiredActionsSchema, {
      description: REQUIRED_ACTIONS_DESCRIPTION,
    }),
  ),
  title: Type.String({ description: CARD_PARAMS.title }),
  body: Type.String({ description: CARD_PARAMS.body }),
  id: Type.Optional(Type.String({ description: CARD_PARAMS.id })),
  width: Type.Optional(stringEnum(["wide", "full"], { description: CARD_PARAMS.width })),
  holds_place: Type.Optional(Type.Boolean({ description: CARD_PARAMS.holds_place })),
  reply: Type.Optional(Type.String({ description: CARD_PARAMS.reply })),
  actions: Type.Optional(
    Type.Array(
      actionParam(Type.Union([settleEffectParam, requestMergeEffectParam, openEffectParam])),
      {
        description: CARD_PARAMS.actions,
      },
    ),
  ),
};

/** One dimension of a crewmate's risk: its level and one line why. Its rules ride `risk`. */
const riskRatingParam = Type.Object({ level: stringEnum(RISK_LEVELS), why: Type.String() });

/**
 * A crewmate's risk assessment, on its completion decision alone: every
 * dimension, each rated. Only the top-level description is served, so it
 * carries every rule (`CARD_PARAMS.risk`).
 */
const riskParam = Type.Object(
  {
    blast: riskRatingParam,
    behavior: riskRatingParam,
    undo: riskRatingParam,
    evidence: riskRatingParam,
    sensitivity: riskRatingParam,
    novelty: riskRatingParam,
    deps: riskRatingParam,
  },
  { description: CARD_PARAMS.risk },
);

/** The Firstmate's attribution and attach-first fields (task-system P1); no crewmate schema carries them. */
const firstmateCardParams = {
  task_id: Type.Optional(Type.String({ description: CARD_PARAMS.task_id })),
  review_task_id: Type.Optional(Type.String({ description: CARD_PARAMS.review_task_id })),
  standalone: Type.Optional(Type.Boolean({ description: CARD_PARAMS.standalone })),
};

export type EmitCardRole = "crewmate" | "firstmate";

/** The emit_card params every role passes, plus the Firstmate's attribution and attach-first fields. */
type EmitCardParams = Omit<Static<typeof crewmateCardParams>, "actions" | "risk"> & {
  actions?: Static<typeof crewmateBrowserCardParams>["actions"];
  /** As the call carried it: the host reads it again (`riskDeclarationOf`). */
  risk?: unknown;
  task_id?: string;
  review_task_id?: string;
  standalone?: boolean;
  browser_button?: string;
  validation_request?: { request: string; action: string };
  browser_handoff?: { site: string; reason: string; after: string };
  browser_page?: string;
};

/**
 * The saved-story rule, said once (INF-416 piece J). A top-level parameter,
 * so a Claude crewmate reads it whole. The prompt, the brief and the other
 * tools do not restate it.
 */
export const SAVED_STORY_RULE = [
  "The saved-story rule, said once: a future github.com pull request or gitlab.com merge request, and its completion card, use the story prepare_change returns.",
  "Pass that current revision here and to open_change as presentation, not body; supply the saved conventional title on both surfaces, give one settle merge action, and omit body, body_file, risk and required_actions. A task that merges on its own passes it on a note with no actions instead.",
  "The host uses the saved story after the checks pass.",
  "Pictures and recordings on it are the selected, inspected, publishable ones, with no local path or private thread.",
  "A story published before a later push is no longer current: prepare a new revision at the pushed version, keeping its base and title and updating what was checked, and publish it with open_change before the card.",
  "Existing pull requests, self-hosted GitLab, GitHub Enterprise, plain Git and local-only delivery keep body and the five headings.",
  "A pull request opened before saved stories and since closed starts a new story; one still open keeps body.",
].join(" ");

const crewmateCardParams = Type.Object({
  ...sharedCardParams,
  title: Type.String({
    description: CARD_PARAMS.title,
  }),
  presentation: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: SAVED_STORY_RULE,
    }),
  ),
  actions: Type.Optional(
    Type.Array(
      crewActionParam(
        Type.Union([
          settleEffectParam,
          requestMergeEffectParam,
          requestWriteEffectParam,
          openEffectParam,
        ]),
      ),
      {
        description: CARD_PARAMS.crewActions,
      },
    ),
  ),
  body: Type.Optional(sharedCardParams.body),
  risk: Type.Optional(
    Type.Object(riskParam.properties, {
      description: CARD_PARAMS.risk,
    }),
  ),
  asking: Type.Optional(Type.Boolean({ description: CARD_PARAMS.asking })),
  design_only: Type.Optional(Type.Boolean({ description: CARD_PARAMS.design_only })),
  continues: Type.Optional(Type.Boolean({ description: CARD_PARAMS.continues })),
  validation_request: Type.Optional(
    Type.Object(
      { request: Type.String(), action: Type.String() },
      {
        description:
          "Bind an approval action to a recorded validation request. Code clearance precedes display. Only the captain's exact chrome choice grants this one effect or gap, never a merge.",
      },
    ),
  ),
  body_file: Type.Optional(
    Type.String({
      description:
        "Write every card body as a UTF-8 HTML file in your task's card body folder, outside the working copy, then name it here (absolute path or relative to that folder). To revise, prefer editing the file in place - only the parts the captain's words changed, the rest word for word - so the app can mark what changed for them; a full rewrite is fine when the answer itself changed shape, and the opening sentence then says what changed. Then call emit_card again with the same id. Give exactly one of body_file or body; inline body is still accepted. The app reads the file only at this call and runs the usual checks; it does not watch edits.",
    }),
  ),
});

/**
 * The browser button, on the emit_card of a crewmate whose task has its own
 * browser (docs/task-browser.md, "From a card"); every other crewmate's
 * schema, and the Firstmate's, go without it. Its rules ride its own
 * description, which a Claude model reads.
 */
const BROWSER_BUTTON_DESCRIPTION = [
  `Optional: a short label (at most ${LIVE_ATTACHMENT_LABEL_MAX} characters), such as Try it, View search or View booking, for a button the app adds under this card's body that opens this task's browser for the captain to watch, beside its site and who is driving.`,
  "It only opens the view: it never answers or closes the card, and it changes no merge.",
  `It needs this task's browser, opened with ${browserCommand("open <url>")}; leave it open while the card is up, since a stopped browser opens stopped and a fresh one starts with nothing it had.`,
].join(" ");

/**
 * The page a crewmate's browser button opens from its task's project
 * (docs/task-browser.md, "A page from the project"). Its rules ride its own
 * description, which a Claude model reads.
 */
const BROWSER_PAGE_DESCRIPTION = [
  "Optional, only beside browser_button: an HTML file from your task's project, such as index.html, that the button opens in this task's browser with the captain in control, such as Play on a finished game's note.",
  "Give its path relative to your working copy, the same in the project folder: an .html or .htm file, with no .. and no link on the way.",
  "The app checks it in your working copy or the project folder when the card goes up, and on each click serves only files inside the project folder on a local address of its own, so before your work is merged the click opens the project's current file or says it is not there yet.",
  "It needs no browser open now, works after your task closes, never answers or closes the card, changes no merge and does not keep your task open; never beside browser_handoff.",
].join(" ");

/** The label the request's description gives as its example of the captain's step to sign in. */
export const BROWSER_SIGN_IN_STEP = "Open browser and sign in";
/** And its example of the captain's step to pay, on a review. */
export const BROWSER_PAY_STEP = "Open browser and pay";

/**
 * The request for the captain to take over the browser, on the same
 * crewmate's emit_card (docs/task-browser.md, "Asking for help"). Its rules
 * ride the top-level description, which a Claude model reads.
 */
const BROWSER_HANDOFF_DESCRIPTION = [
  "Optional: ask the captain to take over this task's browser, for what only a person should do - a sign-in, a verification code, a payment - never in a card reply.",
  `Give site (the page's host), reason (why you need the captain) and after (what you will do once control comes back), each a short sentence of at most ${TASK_BROWSER_REQUEST_MAX} characters.`,
  `The card is an ordinary decision naming the site and why; give it exactly one action whose effect is { kind: "open", target: "browser" }, labeled as the captain's step, such as ${BROWSER_SIGN_IN_STEP}, beside one such as Leave waiting.`,
  "The app pauses your browser before the card goes up: your browser commands refuse until the captain returns control, and nothing the captain types or sees reaches you.",
  "Only the captain's Return control resumes you, once, with your earlier refs gone: take a fresh look and check what changed.",
  `Returning control gives this task the signed-in site, never permission to buy, pay or submit something that matters. ${browserCommand("stop")} withdraws a waiting request.`,
  "A purchase, booking or other submission that commits the captain is the captain's to make: prepare it up to its last step and ask here, with the card as its review.",
  `The review names what the captain commits to, read from the page now - for a trip the route, dates and times with time zones, passengers, seller, total and currency, baggage and fare rules - with anything uncertain and what changed since the captain chose; label the step, such as ${BROWSER_PAY_STEP}, beside one such as Stop here.`,
  "If the price or terms change after a review, stop and review again: an earlier choice does not cover them.",
  "If the page does not confirm the captain's last step, the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain here to check.",
  UNKNOWN_OUTCOME_WORDS,
].join(" ");

const crewmateBrowserCardParams = Type.Object({
  ...crewmateCardParams.properties,
  actions: Type.Optional(
    Type.Array(
      crewActionParam(
        Type.Union([
          settleEffectParam,
          requestMergeEffectParam,
          requestWriteEffectParam,
          browserOpenEffectParam,
        ]),
      ),
      {
        description: CARD_PARAMS.crewActions,
      },
    ),
  ),
  browser_button: Type.Optional(Type.String({ description: BROWSER_BUTTON_DESCRIPTION })),
  browser_page: Type.Optional(Type.String({ description: BROWSER_PAGE_DESCRIPTION })),
  browser_handoff: Type.Optional(
    Type.Object(
      { site: Type.String(), reason: Type.String(), after: Type.String() },
      { description: BROWSER_HANDOFF_DESCRIPTION },
    ),
  ),
});

/** The refusal for a completion decision that declares no risk. */
export const RISK_MISSING_REFUSAL = `a completion decision with a settle merge action carries risk: give each of ${RISK_DIMENSIONS.join(", ")} a level (low, medium or high) and why, one line of at most ${RISK_WHY_MAX} characters, and emit it again.`;

/** The refusal for risk on a card that merges nothing. */
export const RISK_ELSEWHERE_REFUSAL =
  "risk rides only on a completion decision with a settle merge action: drop it from this card.";

/**
 * A crewmate's declared risk, read again whatever its runtime's schema let
 * through: every dimension, a level from the three and a line of words. A
 * line's spaces are folded, so a line the model wrapped reads as one.
 * Refused in words that name what to fix.
 */
export function riskDeclarationOf(raw: unknown): RiskDeclaration {
  const folded =
    raw && typeof raw === "object"
      ? Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).map(([dimension, rating]) => [
            dimension,
            rating && typeof rating === "object"
              ? {
                  ...(rating as Record<string, unknown>),
                  ...(typeof (rating as { why?: unknown }).why === "string"
                    ? { why: (rating as { why: string }).why.replace(/\s+/g, " ").trim() }
                    : {}),
                }
              : rating,
          ]),
        )
      : raw;
  const parsed = riskDeclarationSchema.safeParse(folded);
  if (parsed.success) return parsed.data;
  const at = parsed.error.issues[0]?.path.join(".");
  const text = `${at ? `risk.${at}` : "risk"} is missing or not right: ${RISK_MISSING_REFUSAL}`;
  throw new CardRefusedError(`Card refused: ${text}`, "shape", text);
}

/**
 * One emit_card call, whichever role and runtime made it: the size bound,
 * the stable id, the pictures, then the host, which reads the card as
 * declared. Thrown errors are the loud refusals the tool reports.
 */
async function emitCard(
  params: EmitCardParams,
  options: {
    onCard: (card: DeclaredCard) => string | undefined | Promise<string | undefined>;
    firstmate?: boolean;
    pictures?: CardPictureRoot;
    cardBodiesDir?: string;
    /** The schema offered `browser_button`: the crewmate's task has its own browser. */
    browserButton?: boolean;
  },
): Promise<string> {
  if (!options.firstmate && params.presentation !== undefined) {
    const actions = params.actions ?? [];
    const merges =
      actions.length === 1 &&
      actions[0]?.effect?.kind === "settle" &&
      actions[0].effect.mode === "merge";
    // The home checks task autonomy before accepting a no-action story note (INF-968).
    const note = actions.length === 0;
    if (
      (!merges && !note) ||
      params.body !== undefined ||
      params.body_file !== undefined ||
      params.risk !== undefined ||
      params.required_actions !== undefined ||
      params.browser_button ||
      params.browser_handoff ||
      params.browser_page ||
      params.asking ||
      params.design_only ||
      params.continues
    )
      throw new Error(
        "A saved-story completion gives presentation and one settle merge action, or no actions for a note when the task merges on its own, without body, risk, required_actions or browser controls; those facts come from its published version.",
      );
    const id = parseStableCardId(params.id);
    const cardId = await options.onCard({
      title: params.title,
      body: "",
      presentationRevision: params.presentation,
      actions: actions.map(emittedAction),
      ...(id ? { id } : {}),
      ...(params.reply?.trim() ? { reply: params.reply.trim() } : {}),
      ...(params.holds_place ? { holdsPlace: true } : {}),
      ...(params.width ? { width: params.width } : {}),
    });
    return `Card shown from presentation ${params.presentation}${cardId ? ` (${cardId})` : ""}`;
  }
  if ((params.body !== undefined) === (params.body_file !== undefined)) {
    // INF-961: a completion card given neither may have meant its saved story.
    const story =
      !options.firstmate &&
      params.body === undefined &&
      (params.actions ?? []).some(
        (action) => action.effect?.kind === "settle" && action.effect.mode === "merge",
      );
    throw new Error(
      `Card refused: give exactly one of body or body_file.${story ? " A completion card for a saved story gives presentation instead: the newest revision prepare_change returned, published with open_change at the pushed version. After a push since the story was published, prepare a new story revision at the pushed version and publish it with open_change first." : ""}`,
    );
  }
  if (options.firstmate && params.body_file !== undefined) {
    throw new Error("Card refused: the first mate's cards use inline body, not body_file.");
  }
  const sourceBody =
    params.body_file !== undefined
      ? await readCardBodyFile(params.body_file, options.cardBodiesDir)
      : (params.body as string);
  if (sourceBody.length > MAX_CARD_BODY_LENGTH) {
    throw new Error("Card body too large (64KB max); emit a smaller card.");
  }
  // keeps_open is retired (contract 4.65, FI3-642): dropping it would turn
  // a revise button into a closing choice, so a leftover is refused instead.
  const keptOpen = (params.actions ?? []).find((action) => Object.hasOwn(action, "keeps_open"));
  if (keptOpen) {
    throw new Error(
      `Card refused: action "${keptOpen.id}" passes keeps_open, which is retired. Every action closes the card, and the captain asks for changes by reply: drop keeps_open, and drop an action that only asked for a revision.`,
    );
  }
  const id = parseStableCardId(params.id);
  const firstmate = options.firstmate === true;
  // A crewmate's completion decision carries its risk, and no other card
  // does (docs/card-authoring.md "The risk chart"); the Firstmate's schema
  // has no risk to give.
  const merges = (params.actions ?? []).some(
    (action) => action.effect?.kind === "settle" && action.effect.mode === "merge",
  );
  let riskDeclaration: RiskDeclaration | undefined;
  if (!firstmate && params.risk !== undefined) {
    if (!merges) {
      throw new CardRefusedError(
        `Card refused: ${RISK_ELSEWHERE_REFUSAL}`,
        "shape",
        RISK_ELSEWHERE_REFUSAL,
      );
    }
    riskDeclaration = riskDeclarationOf(params.risk);
  } else if (!firstmate && merges) {
    throw new CardRefusedError(
      `Card refused: ${RISK_MISSING_REFUSAL}`,
      "shape",
      RISK_MISSING_REFUSAL,
    );
  }
  // Pictures are markup (card pictures, phase 2): every <img> naming a
  // working-copy path is verified, copied under the task and rewritten
  // before the lint reads the card, so the lint never sees a path.
  const { body, pictures } = await verifyCardImages(sourceBody, options.pictures);
  const card: DeclaredCard = {
    title: params.title,
    body,
    ...(pictures.length ? { pictures } : {}),
    actions: (params.actions ?? []).map(emittedAction),
    ...(id ? { id } : {}),
    ...(params.width ? { width: params.width } : {}),
    ...(params.holds_place ? { holdsPlace: true } : {}),
    ...(params.reply?.trim() ? { reply: params.reply.trim() } : {}),
    // Only the schema of a crewmate whose task has a browser offers them.
    ...(options.browserButton && params.browser_button !== undefined
      ? { browserButton: params.browser_button }
      : {}),
    ...(params.validation_request ? { validationDecision: params.validation_request } : {}),
    ...(options.browserButton && params.browser_handoff !== undefined
      ? { browserHandoff: params.browser_handoff }
      : {}),
    ...(options.browserButton && params.browser_page !== undefined
      ? { browserPage: params.browser_page }
      : {}),
    ...(riskDeclaration ? { riskDeclaration } : {}),
    ...(params.required_actions !== undefined
      ? { requiredActions: requiredActionsSchema.parse(params.required_actions) }
      : {}),
    ...(params.asking ? { asking: true } : {}),
    ...(params.design_only ? { designOnly: true } : {}),
    ...(params.continues ? { continues: true } : {}),
    // The attribution and attach-first fields exist only in the Firstmate's schema; a
    // crewmate's runtime never passes them.
    ...(firstmate && params.task_id?.trim() ? { taskId: params.task_id.trim() } : {}),
    ...(firstmate && params.review_task_id?.trim()
      ? { reviewTaskId: params.review_task_id.trim() }
      : {}),
    ...(firstmate && params.standalone ? { standalone: true } : {}),
  };
  const cardId = await options.onCard(card);
  return typeof cardId === "string" && cardId
    ? `Card shown: ${params.title} (${cardId})`
    : `Card shown: ${params.title}`;
}

/** One crewmate's emit_card run, bound to its callbacks. */
function crewmateEmitCard(
  delegate: CrewmateToolDelegate,
  onCard: NonNullable<CrewmateToolDelegate["onCard"]>,
  browserButton: boolean,
): (params: EmitCardParams, signal?: AbortSignal) => Promise<ToolOutput> {
  const pictures = cardPictureRoot(delegate);
  return async (params, signal) => {
    try {
      return {
        text: await emitCard(params, {
          onCard: (card) => callWithSignal(onCard, [card], signal),
          cardBodiesDir: delegate.cardBodiesDir,
          browserButton,
          ...(pictures ? { pictures } : {}),
        }),
      };
    } catch (error) {
      // A refused completion card is a fact the host keeps, whichever
      // step refused it: the crewmate's report may still say it went up.
      // One whose request went out and was never answered may already be
      // up, so it is no refusal: its error tells the crewmate what to check.
      if (
        !(error instanceof OutcomeUnknownError) &&
        (params.actions ?? []).some((action) => action.effect?.kind === "settle")
      ) {
        delegate.onCardRefused?.({ title: params.title, ...cardRefusalOf(error) });
      }
      throw error;
    }
  };
}

/**
 * The crewmate's emit_card, one entry of the crewmate tool spec: the
 * contract plus the completion card, and no task_id or standalone. A
 * crewmate whose task has its own browser gets `browser_button` beside the
 * rest; every other crewmate's schema stays as it was.
 */
export const EMIT_CARD_TOOL: CrewmateTool<
  typeof EMIT_CARD_TOOL_NAME,
  typeof crewmateBrowserCardParams
> = {
  name: EMIT_CARD_TOOL_NAME,
  label: "Emit card",
  description: EMIT_CARD_TOOL_DESCRIPTION,
  // Everything the tool can take; each crewmate's bound schema is its own.
  parameters: crewmateBrowserCardParams,
  bind: (delegate) => {
    const onCard = delegate.onCard;
    if (!onCard) return undefined;
    const browserButton = delegate.browser !== undefined;
    return boundTool({
      name: EMIT_CARD_TOOL_NAME,
      label: "Emit card",
      description: EMIT_CARD_TOOL_DESCRIPTION,
      // The narrower schema is the same one less its optional field: a
      // call it validates is one the wider type describes.
      parameters: (browserButton
        ? crewmateBrowserCardParams
        : crewmateCardParams) as typeof crewmateBrowserCardParams,
      run: crewmateEmitCard(delegate, onCard, browserButton),
    });
  },
};

/**
 * The emit_card tool for one role: the crewmate's (the default) reads the
 * contract plus the completion card and never sees task_id or standalone;
 * the Firstmate's reads the contract plus attach-first and carries both.
 */
export function createEmitCardTool(
  onCard: OnCardEmitted,
  lint?: CardLint,
  options: { role?: EmitCardRole; pictures?: CardPictureRoot; cardBodiesDir?: string } = {},
) {
  const firstmate = options.role === "firstmate";
  return boundTool({
    name: EMIT_CARD_TOOL_NAME,
    label: "Emit card",
    description: firstmate ? FIRSTMATE_EMIT_CARD_TOOL_DESCRIPTION : EMIT_CARD_TOOL_DESCRIPTION,
    parameters: firstmate
      ? Type.Object({ ...sharedCardParams, ...firstmateCardParams })
      : crewmateCardParams,
    run: async (params) => {
      const text = await emitCard(params as EmitCardParams, {
        // No host words these buttons, so every action carries its own
        // before the lint reads the card.
        onCard: (declared) => {
          const card: EmittedCard = { ...declared, actions: labeledActions(declared.actions) };
          const refusal = lint?.(card);
          if (refusal) {
            throw new Error(`Card refused: ${refusal}`);
          }
          return onCard(card);
        },
        firstmate,
        cardBodiesDir: options.cardBodiesDir,
        ...(options.pictures ? { pictures: options.pictures } : {}),
      });
      return { text };
    },
  });
}

/** close_card, shared by the Firstmate and every crewmate on both runtimes. */
export const CLOSE_CARD_TOOL = crewmateTool({
  name: CLOSE_CARD_TOOL_NAME,
  label: "Close card",
  description: CLOSE_CARD_TOOL_DESCRIPTION,
  parameters: Type.Object({
    card_id: Type.String(),
    reason: Type.Optional(
      Type.String({
        description: "Why this card is obsolete; one line",
      }),
    ),
  }),
  bind: ({ onCloseCard }) =>
    onCloseCard &&
    (async (params, signal) => ({
      text: await callWithSignal(
        onCloseCard,
        [
          {
            cardId: params.card_id,
            ...(params.reason !== undefined ? { reason: params.reason } : {}),
          },
        ],
        signal,
      ),
    })),
});

export function createCloseCardTool(onClose: OnCardClosed) {
  return bindTool(CLOSE_CARD_TOOL, { onCloseCard: onClose });
}
