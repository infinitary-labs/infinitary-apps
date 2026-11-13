import type { CardFile } from "@shared/cardFiles";
import { cardSizeRefusal } from "@shared/cardSize";
import {
  type AgentEffect,
  type CardMutation,
  type CardPicture,
  LIVE_ATTACHMENT_LABEL_MAX,
} from "@shared/cards";
import type { PutOffUntil } from "@shared/putOff";
import { type RequiredAction, requiredActionsSchema } from "@shared/requiredActions";
import {
  RISK_DIMENSIONS,
  RISK_LEVELS,
  RISK_WHY_MAX,
  type RiskDeclaration,
  riskDeclarationSchema,
} from "@shared/risk";
import { TASK_BROWSER_REQUEST_MAX, UNKNOWN_OUTCOME_WORDS } from "@shared/taskBrowser";
import { cutText } from "@shared/textCut";
import { type Static, type TSchema, Type } from "typebox";
import { browserCommand } from "../browser/commandWords";
import { cardMutationText } from "../orchestrator/cardMutationText";
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
import { type CardFileRoot, keepCardFiles } from "./cardFiles";
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
  // Someone else's card is said by close_card's own refusal, which names
  // revising it or replying on it (docs/card-threads.md, "Shared cards").
].join(" ");

const STABLE_CARD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const STABLE_CARD_ID_MAX = 64;

/** The crewmate's emit_card description: the contract plus the merge card. */
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
  | { kind: "settle"; mode: "discard"; confirm?: boolean; proceed_with_open?: boolean }
  | {
      kind: "merge";
      after: "close" | "continue";
      review?: string;
      asks_first?: string;
      proceed_with_open?: boolean;
    }
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
  if (effect.kind === "merge") {
    return {
      kind: "merge",
      after: effect.after,
      ...(effect.review ? { review: effect.review } : {}),
      ...(effect.asks_first?.trim() ? { asksFirst: cutText(effect.asks_first.trim(), 400) } : {}),
      ...(effect.proceed_with_open ? { proceedWithOpen: true } : {}),
    };
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
 * A put-off as the model passes it ("Not until…", INF-3846 piece 3): flat,
 * a task key for a close, an ISO time for a date, and an integration, its
 * event and filter for an event, as an Automation event rule names them.
 * The home resolves the key to its task and refuses an unknown task, a time
 * already past or an event nothing connected tells (`CardEmits`), so a time
 * that does not parse stays unparsed here.
 */
export type UntilParam = {
  kind: "close" | "date" | "event" | "word";
  task?: string;
  at?: string;
  integration?: string;
  event?: string;
  filter?: Record<string, string>;
};

export function putOffUntil(until: UntilParam): PutOffUntil {
  if (until.kind === "close") return { kind: "close", task: until.task?.trim() ?? "" };
  if (until.kind === "date") return { kind: "date", at: Date.parse(until.at ?? "") };
  if (until.kind === "event")
    return {
      kind: "event",
      integration: until.integration?.trim() ?? "",
      event: until.event?.trim() ?? "",
      ...(until.filter ? { filter: until.filter } : {}),
    };
  return { kind: "word" };
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
  declines?: boolean;
  until?: UntilParam;
}): DeclaredAction {
  return {
    id: action.id,
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.default ? { default: true } : {}),
    ...(action.effect ? { effect: agentEffect(action.effect) } : {}),
    ...(action.danger ? { danger: true } : {}),
    ...(action.declines ? { declines: true } : {}),
    ...(action.until ? { until: putOffUntil(action.until) } : {}),
  };
}

/** One card shape (ruling D1 a): the emitter declares no kind. */
export type EmittedCard = {
  title: string;
  body: string;
  /** A completion from the current saved change story; resolved by the home before any card lint. */
  presentationRevision?: number;
  /** The crewmate's summary of what changed since the captain's last merge card (`since_seen`). */
  sinceSeen?: string;
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
   * The tasks the card mentions, by id or key (INF-2714): the host links
   * each one's record to the card's own record as related. The card stays
   * the first mate's own. Only the Firstmate's schema carries it.
   */
  relatedTaskIds?: string[];
  /**
   * The pictures the host verified in the body and copied under the task
   * (card pictures, phase 2): written on the card row, never the bytes.
   */
  pictures?: CardPicture[];
  /**
   * The files for the captain the host kept where the crewmate runs
   * (`files`, docs/card-authoring.md "Files for the captain"): references,
   * never the bytes.
   */
  files?: CardFile[];
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
  browserHandoff?: { site: string; reason: string; after: string; savedFailed?: true };
  /** Bind the shown ordinary action to a recorded validation request. */
  validationDecision?: { request: string; action: string; gaps?: string[] };
  /** The ordinary action whose click the app keeps as the captain's yes, and what it covers (`allows`). */
  allows?: { action: string; covers: string };
  /**
   * The crewmate's risk assessment of its change (`risk`, only on its
   * merge card; docs/card-authoring.md "The risk chart"): the host
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
  /** Declared: it answers the captain's message it is about (INF-1610). */
  answering?: boolean;
};

export type OnCardEmitted = (
  card: EmittedCard,
) => string | CardMutation | undefined | Promise<string | CardMutation | undefined>;

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
  mode: stringEnum(["discard"]),
  confirm: Type.Optional(Type.Boolean()),
  proceed_with_open: Type.Optional(Type.Boolean()),
});

/**
 * The one merge effect (INF-2744): the merge card of any of the task's pull
 * requests. Its words ride the actions parameter, so a Claude crewmate reads them.
 */
const mergeEffectParam = Type.Object({
  kind: Type.Literal("merge"),
  after: stringEnum(["close", "continue"]),
  review: Type.Optional(Type.String()),
  asks_first: Type.Optional(Type.String()),
  proceed_with_open: Type.Optional(Type.Boolean()),
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

/** A put-off choice's end; its rules ride the actions parameter (`CARD_PARAMS.actions`). */
const untilParam = Type.Object({
  kind: stringEnum(["close", "date", "event", "word"]),
  task: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  integration: Type.Optional(Type.String()),
  event: Type.Optional(Type.String()),
  filter: Type.Optional(Type.Unsafe<Record<string, string>>({ type: "object" })),
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
      declines: Type.Optional(Type.Boolean()),
      until: Type.Optional(untilParam),
    },
    { additionalProperties: true },
  );
}

/**
 * A crewmate's declared action: the same, with its label optional (FI3-249).
 * The crewmate is told the host attaches a merge card's buttons
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
  "Required on a merge card, including [] when none. Display-only obligations: id (stable kebab-case), optional sharedId (explicitly shared outstanding action), target, title (imperative), consequence, instructions (list), criterion, prerequisites (task IDs), completion (manual with label, or device-version with deviceId and minVersion). Merging never performs them. Captain-only parts. The first mate may declare immediately required actions on a non-merge card.";

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
  answering: Type.Optional(Type.Boolean({ description: CARD_PARAMS.answering })),
  // A write on someone else's card, all four served bare
  // (docs/orchestrator-contract.md, "The fixed-context budget"): the refusal
  // of a write there says to pass expected_revision with the revision read,
  // or reply alone for the thread; a resent operation_id's receipt says it
  // already ran; and every refusal, wake and receipt about a waiting captain
  // question names answers_message, as reply's description does.
  expected_revision: Type.Optional(Type.String()),
  contribution_reason: Type.Optional(Type.String()),
  operation_id: Type.Optional(Type.String()),
  answers_message: Type.Optional(Type.Integer({ minimum: 1 })),
  actions: Type.Optional(
    Type.Array(actionParam(Type.Union([mergeEffectParam, settleEffectParam, openEffectParam])), {
      description: CARD_PARAMS.actions,
    }),
  ),
};

/** One dimension of a crewmate's risk: its level and one line why. Its rules ride `risk`. */
const riskRatingParam = Type.Object({ level: stringEnum(RISK_LEVELS), why: Type.String() });

/**
 * A crewmate's risk assessment, on its merge card alone: every
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
  // The first mate's fixed context is held to its boundary
  // (tests/firstmate-fixed-context.test.ts), and its descriptor already says
  // what body and id are (`CARD_MECHANICS`: a raw HTML fragment; reuse an open
  // card's id to revise it in place) and when to pass task_id
  // (`FIRSTMATE_CARD_ADDENDUM`), so the three are served bare to it.
  body: Type.String(),
  id: Type.Optional(Type.String()),
  task_id: Type.Optional(Type.String()),
  review_task_id: Type.Optional(Type.String({ description: CARD_PARAMS.review_task_id })),
  related: Type.Optional(Type.Array(Type.String(), { description: CARD_PARAMS.related })),
};

export type EmitCardRole = "crewmate" | "firstmate";

/** The emit_card params every role passes, plus the Firstmate's attribution and attach-first fields. */
type EmitCardParams = Omit<Static<typeof crewmateCardParams>, "actions" | "risk"> & {
  actions?: Static<typeof crewmateBrowserCardParams>["actions"];
  /** As the call carried it: the host reads it again (`riskDeclarationOf`). */
  risk?: unknown;
  task_id?: string;
  review_task_id?: string;
  related?: string[];
  browser_button?: string;
  validation_request?: { request: string; action: string; gaps?: string[] };
  allows?: { action: string; covers: string };
  browser_handoff?: { site: string; reason: string; after: string; saved_failed?: boolean };
  browser_page?: string;
};

/**
 * The yes the app keeps (INF-3170 piece 2): a top-level parameter, so a
 * Claude crewmate reads it whole.
 */
export const ALLOWS_PARAM =
  "Mark the yes action of a consent ask: action names an ordinary action with no effect, covers says what a yes allows, as the card asks it. The captain's own click on it is recorded and served as already allowed to later turns of this task, its reviewer, a stronger-model retry and a takeover of its work, so none asks again.";

/**
 * The summary of what changed since the captain's last merge card
 * (INF-3715): a top-level parameter, so a Claude crewmate reads it whole.
 * It says what the summary is for and who reads it, and leaves the words to
 * the crewmate: no sections, length or required items.
 */
export const SINCE_SEEN_PARAM =
  "When the captain saw an earlier merge card, summarize changes since in your words. The card draws it first under that viewing time; only the captain reads it, never the pull request, story or merge message.";

/**
 * The saved-story rule, said once (INF-416 piece J). A top-level parameter,
 * so a Claude crewmate reads it whole. The prompt, the brief and the other
 * tools do not restate it.
 */
export const SAVED_STORY_RULE = [
  "The saved-story rule, said once: every branch and local-only change uses prepare_change's story. show_merge_card prepares, publishes and shows it; the rest applies where it is not served.",
  "Pass the current revision as presentation here and to open_change, with its saved title and one merge action, no body, body_file, risk or required_actions; autonomy on merges from it. A host-identified upstream contribution shows its published presentation as a note without actions; maintainers merge it.",
  "Local-only skips open_change: prepare the committed story, then show it. Publish other branches with open_change; the host uses it after checks pass.",
  "Public GitHub and GitLab upload inspected media unless the host marks it card-only; other hosts publish text with media on the card. Plain Git keeps the story on the card. Never downgrade a failed upload.",
  "After a push, show the same presentation; the host republishes the pull request story at that version. Changed words or a later local-only or plain-branch commit need a revision with the same base, title and updated verification; publish it where needed before the card.",
  "After the merge click, a same-version story revision keeps approval: publish it without another merge card; only another commit needs one.",
].join(" ");

/**
 * Files for the captain on a crewmate's card (docs/card-authoring.md, "Files
 * for the captain"). A top-level parameter, so a Claude crewmate reads it whole.
 */
export const CARD_FILES_PARAM = [
  "Files for the captain to open, edit, attach or send: absolute or working-copy-relative paths, at most 1 GB each.",
  "The app keeps copies where you run, with a Save row per file the captain's click moves to Downloads.",
  "Never give a path instead, especially on another computer or in temporary or evidence folders. Revisions pass files again; the list replaces the card's.",
].join(" ");

const crewmateCardParams = Type.Object({
  ...sharedCardParams,
  files: Type.Optional(Type.Array(Type.String(), { description: CARD_FILES_PARAM })),
  // INF-2884: a revision's reply that names no captain message is refused
  // while one waits, unless it is marked a progress note.
  interim: Type.Optional(Type.Boolean({ description: CARD_PARAMS.interim })),
  title: Type.String({
    description: CARD_PARAMS.title,
  }),
  presentation: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: SAVED_STORY_RULE,
    }),
  ),
  since_seen: Type.Optional(Type.String({ description: SINCE_SEEN_PARAM })),
  actions: Type.Optional(
    Type.Array(
      crewActionParam(
        Type.Union([mergeEffectParam, settleEffectParam, requestWriteEffectParam, openEffectParam]),
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
      {
        request: Type.String(),
        action: Type.String(),
        gaps: Type.Optional(
          Type.Array(Type.String(), {
            description: "Other gaps of this version, on one checklist.",
          }),
        ),
      },
      {
        description:
          "Bind an approval action to a recorded validation request; only the captain's click grants it, never a merge.",
      },
    ),
  ),
  allows: Type.Optional(
    Type.Object({ action: Type.String(), covers: Type.String() }, { description: ALLOWS_PARAM }),
  ),
  body_file: Type.Optional(
    Type.String({
      description:
        "Write card bodies as UTF-8 HTML in the task's card body folder outside the working copy; name an absolute or folder-relative path. Revise in place only what the captain's words changed, so the app can mark it. A full rewrite is fine when the answer changed shape; say so in the opening sentence. Call emit_card again with the same id. Give exactly one of body_file or body. The app reads only on this call; it does not watch edits.",
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
  `Optional: a short label (at most ${LIVE_ATTACHMENT_LABEL_MAX} characters), such as Try it or View booking, for a button the app adds under this card's body that opens this task's browser for the captain to watch.`,
  "It only opens the view: it never answers or closes the card, and it changes no merge.",
  `It needs this task's browser, opened with ${browserCommand("open <url>")}; leave it open while the card is up.`,
].join(" ");

/**
 * The page a crewmate's browser button opens from its task's project
 * (docs/task-browser.md, "A page from the project"). Its rules ride its own
 * description, which a Claude model reads.
 */
const BROWSER_PAGE_DESCRIPTION = [
  "Optional, only beside browser_button: an HTML file from your task's project, such as index.html, that the button opens in this task's browser.",
  "Give its path relative to your working copy, the same in the project folder: an .html or .htm file, with no .. and no link on the way.",
  "The app serves only files inside the project folder; before your work merges the click opens the current file or says it is not there yet.",
  "It needs no browser open now and works after your task closes; never beside browser_handoff.",
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
  "Optional: ask the captain to take over this task's browser for what only a person should do - a sign-in, a code, a payment - never in a card reply.",
  `Give site (the page's host), reason (why you need the captain) and after (what you will do once control comes back), each a short sentence of at most ${TASK_BROWSER_REQUEST_MAX} characters.`,
  `The card is an ordinary decision naming the site and why; give it exactly one action whose effect is { kind: "open", target: "browser" }, labeled as the captain's step, such as ${BROWSER_SIGN_IN_STEP}, beside one such as Leave waiting.`,
  "The app pauses your browser before the card goes up; its commands refuse until the captain returns control.",
  "Only the captain's Return control resumes you, once, with your earlier refs gone.",
  `Returning control gives this task the signed-in site, never permission to buy, pay or submit something that matters. ${browserCommand("stop")} withdraws a waiting request.`,
  "A purchase, booking or other submission that commits the captain is the captain's to make: prepare it up to its last step and ask here, with the card as its review.",
  `The review names what the captain commits to, read from the page now - for a trip the route, dates and times with time zones, passengers, seller, total and currency, baggage and fare rules - with anything uncertain and what changed since the captain chose; label the step, such as ${BROWSER_PAY_STEP}, beside one such as Stop here.`,
  "If the price or terms change after a review, stop and review again: an earlier choice does not cover them.",
  "If the page does not confirm the captain's last step, the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain.",
  UNKNOWN_OUTCOME_WORDS,
].join(" ");

const crewmateBrowserCardParams = Type.Object({
  ...crewmateCardParams.properties,
  actions: Type.Optional(
    Type.Array(
      crewActionParam(
        Type.Union([
          mergeEffectParam,
          settleEffectParam,
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
      {
        site: Type.String(),
        reason: Type.String(),
        after: Type.String(),
        // The saved-sign-in notice says when; it is not fixed context (INF-1849).
        saved_failed: Type.Optional(Type.Boolean()),
      },
      { description: BROWSER_HANDOFF_DESCRIPTION },
    ),
  ),
});

/** The refusal for a merge card of the task's own change that declares no risk. */
export const RISK_MISSING_REFUSAL = `a merge card carries risk: give each of ${RISK_DIMENSIONS.join(", ")} a level (low, medium or high) and why, one line of at most ${RISK_WHY_MAX} characters, and emit it again.`;

/** The refusal for risk on a card that merges nothing. */
export const RISK_ELSEWHERE_REFUSAL = "risk rides only on a merge card: drop it from this card.";

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
 * Why a saved-story merge card is refused: its story is the saved
 * revision's, and a copy of its facts that differs from it competes with it
 * (INF-2744). The tool says it for the call's shape; the home says it for a
 * copy that differs from the story it holds (`CrewmateCards`).
 */
const SAVED_STORY_REFUSAL =
  "A saved-story merge card gives presentation and one merge action for your task's current change, without body, risk, required_actions or browser controls; those facts come from its saved revision.";

/**
 * The saved-story refusal naming each field it refused (INF-3717 piece 1),
 * so a crewmate drops exactly those rather than guessing.
 */
export function savedStoryRefusal(refused: readonly string[]): string {
  return refused.length
    ? `${SAVED_STORY_REFUSAL} Refused: ${refused.join(", ")}.`
    : SAVED_STORY_REFUSAL;
}

/** Each field a saved-story merge card's call passed that the card does not take. */
function savedStoryRefusedFields(params: EmitCardParams, note = false): string[] {
  const actions = params.actions ?? [];
  const merge = actions.find((action) => action.effect?.kind === "merge");
  const effect = merge?.effect as { review?: string } | undefined;
  return [
    ...(note
      ? []
      : actions.length !== 1
        ? [`actions (${actions.length} given; one merge action only)`]
        : !merge
          ? ["actions (the one action must merge)"]
          : []),
    ...(effect?.review ? ["review on the merge effect (it merges your current change)"] : []),
    ...(
      [
        "body",
        "body_file",
        "browser_button",
        "browser_handoff",
        "browser_page",
        "files",
        "asking",
        "design_only",
        "continues",
      ] as const
    ).filter((field) => {
      const value = params[field];
      if (field === "body" || field === "body_file") return value !== undefined;
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }),
  ];
}

/**
 * The copies of a saved story's risk and required actions a merge card's
 * call passed, read as the home compares them; one that does not read is
 * no copy of the story, so it is the saved-story refusal (INF-3060).
 */
function savedStoryCopies(params: EmitCardParams): {
  facts: Pick<DeclaredCard, "riskDeclaration" | "requiredActions">;
  names: string[];
} {
  try {
    return {
      facts: {
        ...(params.risk !== undefined ? { riskDeclaration: riskDeclarationOf(params.risk) } : {}),
        ...(params.required_actions !== undefined
          ? { requiredActions: requiredActionsSchema.parse(params.required_actions) }
          : {}),
      },
      names: [
        ...(params.risk !== undefined ? ["risk"] : []),
        ...(params.required_actions !== undefined ? ["required_actions"] : []),
      ],
    };
  } catch {
    throw new Error(
      savedStoryRefusal([
        ...(params.risk !== undefined ? ["risk (does not read as a risk declaration)"] : []),
        ...(params.required_actions !== undefined
          ? ["required_actions (do not read as required actions)"]
          : []),
      ]),
    );
  }
}

/**
 * One emit_card call, whichever role and runtime made it: the size bound,
 * the stable id, the pictures, then the host, which reads the card as
 * declared. Thrown errors are the loud refusals the tool reports.
 */
async function emitCard(
  params: EmitCardParams,
  options: {
    onCard: (
      card: DeclaredCard,
    ) => string | CardMutation | undefined | Promise<string | CardMutation | undefined>;
    firstmate?: boolean;
    pictures?: CardPictureRoot;
    /** Where a crewmate's card files are kept; absent, a card naming files is refused. */
    files?: CardFileRoot;
    cardBodiesDir?: string;
    /** The schema offered `browser_button`: the crewmate's task has its own browser. */
    browserButton?: boolean;
    contributionNotes?: boolean;
  },
): Promise<string> {
  if (!options.firstmate && params.presentation !== undefined) {
    const actions = params.actions ?? [];
    const merges =
      actions.length === 1 && actions[0]?.effect?.kind === "merge" && !actions[0].effect.review;
    // The home alone knows whether this task contributes upstream and may
    // show an actionless story. It refuses that shape on an ordinary task.
    // The risk and required actions of a saved-story merge card are the
    // saved revision's facts. A copy is handed on for the home to hold
    // against the story, which leaves out one that repeats it exactly and
    // refuses one that differs (INF-3060: three repeats refused in a day;
    // the captain's "we should not take any guesses here"). A body is
    // refused here as before: the story's body carries media names the home
    // mints as it shows the card, so no copy could match it.
    // A story note with no action is allowed where contribution notes are.
    const note = options.contributionNotes === true && actions.length === 0;
    const refused = savedStoryRefusedFields(params, note);
    if ((!merges && !note) || refused.length) throw new Error(savedStoryRefusal(refused));
    const copies = savedStoryCopies(params);
    const id = parseStableCardId(params.id);
    const shown = await options.onCard({
      title: params.title,
      body: "",
      presentationRevision: params.presentation,
      actions: actions.map(emittedAction),
      ...(id ? { id } : {}),
      ...(params.reply?.trim() ? { reply: params.reply.trim() } : {}),
      ...(params.reply?.trim() && params.interim === true ? { interim: true } : {}),
      ...(params.holds_place ? { holdsPlace: true } : {}),
      ...(params.answering ? { answering: true } : {}),
      ...(params.width ? { width: params.width } : {}),
      ...(params.since_seen?.trim() ? { sinceSeen: params.since_seen.trim() } : {}),
      ...copies.facts,
    });
    const dropped = copies.names.length
      ? `The ${copies.names.join(", ")} you passed repeats the saved revision exactly, so the copy was left out.`
      : "";
    if (typeof shown === "object")
      return [cardMutationText(shown), dropped].filter(Boolean).join(" ");
    const said = `Card shown from presentation ${params.presentation}${shown ? ` (${shown})` : ""}`;
    return dropped ? `${said}. ${dropped}` : said;
  }
  if ((params.body !== undefined) === (params.body_file !== undefined)) {
    // INF-961: a merge card given neither may have meant its saved story.
    const story =
      !options.firstmate &&
      params.body === undefined &&
      (params.actions ?? []).some((action) => action.effect?.kind === "merge");
    throw new Error(
      `Card refused: give exactly one of body or body_file.${story ? " A saved-story merge card gives presentation: the newest revision prepare_change returned at the committed version. Publish it with open_change before the card, except on local-only work, which skips publication. After a push the host republishes the published story; a story whose words changed needs a new revision." : ""}`,
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
  // Measured as the window will receive it, against the window's own limit (INF-3887).
  const tooLarge = cardSizeRefusal(sourceBody);
  if (tooLarge) throw new Error(tooLarge);
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
  // A crewmate's merge card carries its risk, and no other card does
  // (docs/card-authoring.md "The risk chart"): the merge card of its own
  // change always, and one of another pull request when it chooses. The
  // Firstmate's schema has no risk to give.
  const mergeEffects = (params.actions ?? []).flatMap((action) =>
    action.effect?.kind === "merge" ? [action.effect] : [],
  );
  const merges = mergeEffects.some((effect) => !effect.review);
  let riskDeclaration: RiskDeclaration | undefined;
  if (!firstmate && params.risk !== undefined) {
    if (mergeEffects.length === 0) {
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
  // Files for the captain are kept where the crewmate runs; the card holds their references.
  const files = firstmate ? [] : await keepCardFiles(params.files ?? [], options.files);
  const card: DeclaredCard = {
    title: params.title,
    body,
    ...(pictures.length ? { pictures } : {}),
    ...(files.length ? { files } : {}),
    actions: (params.actions ?? []).map(emittedAction),
    ...(id ? { id } : {}),
    ...(params.width ? { width: params.width } : {}),
    ...(params.holds_place ? { holdsPlace: true } : {}),
    ...(params.reply?.trim() ? { reply: params.reply.trim() } : {}),
    ...(params.reply?.trim() && params.interim === true ? { interim: true } : {}),
    // Only the schema of a crewmate whose task has a browser offers them.
    ...(options.browserButton && params.browser_button !== undefined
      ? { browserButton: params.browser_button }
      : {}),
    ...(params.validation_request ? { validationDecision: params.validation_request } : {}),
    ...(params.allows ? { allows: params.allows } : {}),
    ...(!firstmate && params.since_seen?.trim() ? { sinceSeen: params.since_seen.trim() } : {}),
    ...(options.browserButton && params.browser_handoff !== undefined
      ? {
          browserHandoff: {
            site: params.browser_handoff.site,
            reason: params.browser_handoff.reason,
            after: params.browser_handoff.after,
            ...(params.browser_handoff.saved_failed === true ? { savedFailed: true as const } : {}),
          },
        }
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
    ...(params.answering ? { answering: true } : {}),
    // The attribution and attach-first fields exist only in the Firstmate's schema; a
    // crewmate's runtime never passes them.
    ...(firstmate && params.task_id?.trim() ? { taskId: params.task_id.trim() } : {}),
    ...(firstmate && params.review_task_id?.trim()
      ? { reviewTaskId: params.review_task_id.trim() }
      : {}),
    ...(firstmate && relatedOf(params.related).length > 0
      ? { relatedTaskIds: relatedOf(params.related) }
      : {}),
    // On someone else's card (docs/card-threads.md, "Shared cards").
    ...(params.expected_revision?.trim()
      ? { expectedRevision: params.expected_revision.trim() }
      : {}),
    ...(params.contribution_reason?.trim()
      ? { contributionReason: params.contribution_reason.trim() }
      : {}),
    ...(params.operation_id?.trim() ? { operationId: params.operation_id.trim() } : {}),
    ...(params.answers_message !== undefined ? { answersMessage: params.answers_message } : {}),
  };
  const shown = await options.onCard(card);
  // A write on someone else's card answers what the host saved, typed.
  if (typeof shown === "object") return cardMutationText(shown);
  return typeof shown === "string" && shown
    ? `Card shown: ${params.title} (${shown})`
    : `Card shown: ${params.title}`;
}

/** The related refs as passed: trimmed, each named once. */
function relatedOf(refs: string[] | undefined): string[] {
  return [...new Set((refs ?? []).map((ref) => ref.trim()).filter(Boolean))];
}

/** One crewmate's emit_card run, bound to its callbacks. */
function crewmateEmitCard(
  delegate: CrewmateToolDelegate,
  onCard: NonNullable<CrewmateToolDelegate["onCard"]>,
  browserButton: boolean,
): (params: EmitCardParams, signal?: AbortSignal) => Promise<ToolOutput> {
  const pictures = cardPictureRoot(delegate);
  const files =
    delegate.picturesDir && delegate.cwd && delegate.taskId
      ? {
          worktree: delegate.cwd,
          dir: delegate.picturesDir,
          taskId: delegate.taskId,
          protectedPlaces: delegate.protectedPlaces ?? [],
        }
      : undefined;
  return async (params, signal) => {
    try {
      return {
        text: await emitCard(params, {
          ...(files ? { files } : {}),
          onCard: (card) => callWithSignal(onCard, [card], signal),
          cardBodiesDir: delegate.cardBodiesDir,
          contributionNotes: delegate.contributionNotes,
          browserButton,
          ...(pictures ? { pictures } : {}),
        }),
      };
    } catch (error) {
      // A refused merge card is a fact the host keeps, whichever
      // step refused it: the crewmate's report may still say it went up.
      // One whose request went out and was never answered may already be
      // up, so it is no refusal: its error tells the crewmate what to check.
      if (
        !(error instanceof OutcomeUnknownError) &&
        (params.actions ?? []).some(
          (action) => action.effect?.kind === "settle" || action.effect?.kind === "merge",
        )
      ) {
        delegate.onCardRefused?.({ title: params.title, ...cardRefusalOf(error) });
      }
      throw error;
    }
  };
}

/**
 * The crewmate's emit_card, one entry of the crewmate tool spec: the
 * contract plus the merge card, and no task_id or related. A
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
 * contract plus the merge card and never sees task_id or related;
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
        description:
          "Why you ended it, in one plain line: a card they have seen stays up, marked ended, with this line",
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
