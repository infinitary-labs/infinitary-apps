import { z } from "zod";
import {
  CARD_MAX_ANSWERS,
  CARD_WRITTEN_MAX,
  type CardAnswer,
  type CardQuestion,
  type CardQuestionsGap,
  type CardWidth,
  cardAnswerSchema,
  cardQuestionsGapSchema,
} from "../cards";
import { KNOWLEDGE_ID_EXACT } from "../knowledge";
import { TASK_KEY_EXACT } from "../taskKeys";
import { mediatedFetchRequestSchema } from "./fetch";
import type { ReadTransfer } from "./readTransfer";

/**
 * The messages between a plugin frame and its host (docs/ui-plugins.md):
 * what a frame may send, checked here before the host acts, and what the
 * host sends back. The script every frame runs, and the pin its CSP hash
 * rides, are in ./frameScript.ts.
 */

export const FRAME_BRIDGE_VERSION = 2;

/** The host will not accept an action value larger than this (proposal 5.2). */
export const ACTION_VALUE_MAX_BYTES = 4_096;
/** Subscriptions one mount may hold at once. */
export const FRAME_MAX_SUBSCRIPTIONS = 32;
/** Requests one mount may have unanswered at once. */
export const FRAME_MAX_IN_FLIGHT = 16;
/**
 * The pictures one `image` message may name. A card has no count cap on its
 * pictures, so this bounds the envelope, not an author.
 */
export const FRAME_MAX_PICTURES = 1_024;
/** A picture's src in an `image` message: room for a `data:` picture past the 8 MB file cap. */
export const FRAME_PICTURE_SRC_MAX = 16 * 1024 * 1024;
/** A picture's alt in an `image` message. */
export const FRAME_PICTURE_ALT_MAX = 4_096;
/**
 * Where a verified demo recording is served (`CARD_MEDIA_HOST` of the frame
 * scheme, `@shared/cardPictures`), written out because `../csp` imports this
 * module; `bridge.test.ts` holds the two equal.
 */
export const FRAME_DEMO_SOURCE = "app-frame://media/";
/** A demo's served recording name in a `demo` message: `app-frame://media/<64-char task>-<32 hex>.mp4` fits. */
export const FRAME_DEMO_SRC_MAX = 256;
/** A demo's caption in a `demo` message. */
export const FRAME_DEMO_CAPTION_MAX = 4_096;
/**
 * How a diagram travels in an `image` message (INF-3107): the frame writes
 * the drawing as it stands into one SVG picture of its own, which the host
 * shows as any picture - a picture runs no script and loads nothing.
 */
export const DRAWING_SOURCE_PREFIX = "data:image/svg+xml;charset=utf-8,";
/**
 * The look a diagram's drawn elements carry out of the card, each read off
 * the card as it stands and written on the element: what paints a shape or
 * a label, and what places and sets a label's type.
 */
export const DRAWING_LOOK = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "paint-order",
  "opacity",
  "color",
  "stop-color",
  "stop-opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "text-decoration",
] as const;
/** The same for words a diagram flows inside a `foreignObject`: their type, color and box. */
export const DRAWING_WORDS_LOOK = [
  "color",
  "background-color",
  "opacity",
  "visibility",
  "display",
  "box-sizing",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration",
  "white-space",
  "overflow-wrap",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-radius",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "gap",
  "list-style-type",
] as const;
/** The words a `draft` message may put in the message box: the start of one sentence. */
export const FRAME_DRAFT_MAX = 500;

/**
 * The pictures a group's strip shows - the lead and five thumbnails - so
 * the first one its "+N" tile counts is at this index (the frame stylesheet's
 * `.inf-pictures` rules).
 */
export const PICTURE_STRIP_SHOWN = 6;

// --- the envelope, frame -> host -------------------------------------------

const correlationId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fmMarker = z.literal(FRAME_BRIDGE_VERSION);

/** The store operations a frame may ask for; the slice is always the host's to bind. */
export const FRAME_STORE_OPS = ["get", "set", "delete", "list"] as const;
/** The longest key (and prefix) a store request may carry, as the store itself bounds it. */
export const FRAME_STORE_KEY_MAX = 128;

/**
 * The verbs a frame may ask of the host. Each is answered by exactly one
 * `response` carrying the request's `id`. `subscribe` names a read and its
 * args; the host validates both against the mount's declaration and the
 * catalog before it accepts.
 */
export const frameRequestSchema = z.discriminatedUnion("verb", [
  z.object({
    verb: z.literal("subscribe"),
    sub: correlationId,
    read: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ verb: z.literal("unsubscribe"), sub: correlationId }),
  z.object({
    verb: z.literal("action"),
    action: z.string().min(1).max(200),
    value: z.unknown().optional(),
  }),
  z.object({
    verb: z.literal("fetch"),
    alias: z.string().min(1).max(32),
    request: mediatedFetchRequestSchema,
  }),
  z.object({
    verb: z.literal("store"),
    op: z.enum(FRAME_STORE_OPS),
    key: z.string().min(1).max(FRAME_STORE_KEY_MAX).optional(),
    value: z.unknown().optional(),
    prefix: z.string().max(FRAME_STORE_KEY_MAX).optional(),
  }),
]);
export type FrameRequest = z.infer<typeof frameRequestSchema>;

/**
 * One picture of an `image` message, as the frame saw it: its resolved src,
 * its alt, and its natural size (0 while it has not decoded). Which sources
 * the host will show is its own call (`viewablePictures`).
 */
export const framePictureSchema = z.object({
  src: z.string().min(1).max(FRAME_PICTURE_SRC_MAX),
  alt: z.string().max(FRAME_PICTURE_ALT_MAX),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type FramePicture = z.infer<typeof framePictureSchema>;

/** A `demo` message's fields, as the host hands them on (`FrameMountSpec.onDemo`). */
export type FrameDemo = {
  src: string;
  poster: FramePicture;
  caption: string;
  durationMs: number;
  play: boolean;
};

const answerCount = z.number().int().nonnegative().max(CARD_MAX_ANSWERS);

/**
 * The form's state as one `answers` message reports it: the count the
 * chrome shows (`answered` of `of`, `changed` of them differing from the
 * author's proposal, `picked` of them the captain's own - changed, or chosen
 * where the author only recommended) and the answers, the shell's draft.
 */
/**
 * One answer as a frame reads it: a Something else field holds at most
 * `CARD_WRITTEN_MAX`. Only the app's own Anything else? box, which is host
 * chrome, writes more (`withAnythingElse`).
 */
const frameAnswerSchema = cardAnswerSchema.extend({
  written: z.string().min(1).max(CARD_WRITTEN_MAX).optional(),
});

export const frameAnswersSchema = z.object({
  answered: answerCount,
  of: answerCount,
  changed: answerCount,
  picked: answerCount,
  answers: z.array(frameAnswerSchema).max(CARD_MAX_ANSWERS),
});
/**
 * A reading of the form. The one a footer click asked for (`collect`) also
 * carries what each question offered (`CardQuestion`), or why it could not;
 * the host validates the definitions on their own, so definitions it cannot
 * read never cost the answers.
 */
export type FrameAnswers = z.infer<typeof frameAnswersSchema> & {
  questions?: CardQuestion[];
  questionsGap?: CardQuestionsGap;
};

/**
 * A knowledge entry a card body names, as the bridge links it: its id, the
 * words its reference is read by, and the mark its standing takes - `ok`
 * for a finding checked with evidence, `warn` for one to recheck or with
 * differing evidence, `none` for the rest.
 */
export type FrameEntryRef = { id: string; label: string; tone: "ok" | "warn" | "none" };

/** What the pointer or the keyboard did on a linked task key (FI3-594). */
export const FRAME_TASK_GESTURES = ["rest", "leave", "open"] as const;
export type FrameTaskGesture = (typeof FRAME_TASK_GESTURES)[number];

/** A box in a frame's own viewport, as the frame measured it. */
export const frameBoxSchema = z.object({
  top: z.number().finite(),
  right: z.number().finite(),
  bottom: z.number().finite(),
  left: z.number().finite(),
});
export type FrameBox = z.infer<typeof frameBoxSchema>;

export const frameMessageSchema = z.discriminatedUnion("type", [
  z.object({
    fm: fmMarker,
    type: z.literal("revealed"),
    document: z.string(),
    seq: correlationId,
    offerId: z.string().min(1).max(64),
    top: z.number().finite().nonnegative().max(1_000_000).optional(),
    height: z.number().finite().nonnegative().max(1_000_000).optional(),
  }),
  z.object({
    fm: fmMarker,
    type: z.literal("ready"),
    document: z.string().optional(),
    reuseReads: z.boolean().optional(),
  }),
  z.object({ fm: fmMarker, type: z.literal("request"), id: correlationId }).loose(),
  z.object({
    fm: fmMarker,
    type: z.literal("resize"),
    height: z.number().finite().nonnegative(),
    document: z.string().optional(),
    width: z.number().finite().nonnegative().optional(),
    initialized: z.boolean().optional(),
    live: z.boolean().optional(),
    /** A held page's drawing: its scripts and animations wait for `activate`. */
    held: z.boolean().optional(),
  }),
  z.object({ fm: fmMarker, type: z.literal("link"), href: z.string().min(1).max(2_048) }),
  /** A press on a `data-inf-draft` control: the start of an ask, for the message box. */
  z.object({
    fm: fmMarker,
    type: z.literal("draft"),
    document: z.string(),
    text: z
      .string()
      .min(1)
      .max(FRAME_DRAFT_MAX)
      .regex(/^[^\r\n]*$/),
  }),
  z.object({
    fm: fmMarker,
    type: z.literal("image"),
    index: z.number().int().nonnegative(),
    pictures: z.array(framePictureSchema).min(1).max(FRAME_MAX_PICTURES),
  }),
  z.object({
    fm: fmMarker,
    type: z.literal("demo"),
    /** The recording's served name, as the body's `data-inf-demo` writes it. */
    src: z.string().min(1).max(FRAME_DEMO_SRC_MAX),
    poster: framePictureSchema,
    caption: z.string().max(FRAME_DEMO_CAPTION_MAX),
    /** The length the host wrote on the figure; the player reads the real one. */
    durationMs: z.number().int().nonnegative(),
    /** The Play button (true) or the poster (false), which opens it paused. */
    play: z.boolean(),
  }),
  z.object({ fm: fmMarker, type: z.literal("interaction"), document: z.string() }),
  /** The frame's own window gained or lost the window's focus. */
  z.object({
    fm: fmMarker,
    type: z.literal("focused"),
    document: z.string(),
    focused: z.boolean(),
  }),
  /** A press began in the frame's own window. */
  z.object({ fm: fmMarker, type: z.literal("pressed"), document: z.string() }),
  /** An Escape nothing in a card body used: the body asks to be left for its card. */
  z.object({ fm: fmMarker, type: z.literal("escape"), document: z.string() }),
  z.object({
    fm: fmMarker,
    type: z.literal("task"),
    document: z.string(),
    gesture: z.enum(FRAME_TASK_GESTURES),
    key: z.string().regex(TASK_KEY_EXACT),
    /** Where the key sits in the frame's viewport; only a `rest` carries it. */
    box: frameBoxSchema.optional(),
  }),
  /** A click or Enter on a linked knowledge reference: open its entry. */
  z.object({
    fm: fmMarker,
    type: z.literal("entry"),
    document: z.string(),
    id: z.string().regex(KNOWLEDGE_ID_EXACT),
  }),
  z.object({ fm: fmMarker, type: z.literal("pong"), seq: correlationId }),
  frameAnswersSchema.extend({
    fm: fmMarker,
    type: z.literal("answers"),
    /** Present when the reading answers the host's `collect` of that number. */
    seq: correlationId.optional(),
    /** A collect's question definitions, as the frame read them; validated by the host. */
    questions: z.unknown().optional(),
    questionsGap: cardQuestionsGapSchema.optional(),
  }),
]);
export type FrameMessage = z.infer<typeof frameMessageSchema>;

// --- the envelope, host -> frame -------------------------------------------

/**
 * Why the host refused a request, in a closed vocabulary the template can
 * branch on. Messages are for people; codes are the contract.
 */
export const FRAME_ERROR_CODES = [
  "bad_request",
  "read_not_declared",
  "read_unknown",
  "bad_args",
  "too_many_subscriptions",
  "too_many_in_flight",
  "subscription_unknown",
  "action_not_declared",
  "value_too_large",
  "capability_not_granted",
  "read_failed",
  "fetch_failed",
  "store_failed",
] as const;
export type FrameErrorCode = (typeof FRAME_ERROR_CODES)[number];

export type FrameError = { code: FrameErrorCode; message: string };

/**
 * An answer to one request: its correlation id and the document that asked.
 * Each document numbers its requests from 1, so the bridge in any other
 * document of the mount ignores it.
 */
type FrameResponse = {
  fm: typeof FRAME_BRIDGE_VERSION;
  type: "response";
  id: number;
  document?: string;
};

export type HostMessage =
  | {
      fm: typeof FRAME_BRIDGE_VERSION;
      type: "reveal";
      document: string;
      seq: number;
      offerId: string;
      start: number;
      keyboard: boolean;
    }
  /**
   * The document may report its drawing. `latePictures`: the host's pictures can arrive long after the body,
   * so the drawing waits only for the fonts its layout asked for, never for the page's load (INF-1562).
   */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "initialize"; document: string; latePictures?: true }
  | (FrameResponse & { ok: true; result?: unknown })
  | (FrameResponse & { ok: false; error: FrameError })
  | ({ fm: typeof FRAME_BRIDGE_VERSION; type: "data"; sub: number } & ReadTransfer)
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "data"; sub: number; error: FrameError }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "theme"; theme: "dark" | "light" }
  /** The card is shown: a held page releases its scripts and animations. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "activate" }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "width"; width: CardWidth }
  /** The box the card's chrome holds over the document's top right, in CSS pixels. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "inset"; width: number; height: number }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "state"; state: unknown }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "store"; key: string }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "ping"; seq: number }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "form"; fill: CardAnswer[] | null; readOnly?: true }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "collect"; seq: number; focusUnpicked?: boolean }
  /** The keys the host hears from this document: its pictures, and an Escape that leaves it. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "keys"; pictures: boolean; escape: boolean }
  /** The host just gave the frame focus back: the element that last had it takes it again. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "focus" }
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "tasks"; keys: string[] }
  /** The linked key a rest elsewhere in the window lights (INF-237), or null: the bridge marks `data-inf-lit` on each link to it. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "lit"; key: string | null }
  /** The knowledge entries the body names that the window reads, with each reference's words. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "entries"; entries: FrameEntryRef[] }
  /** The document's markup anew: the bridge rewrites only what differs, in place. */
  | { fm: typeof FRAME_BRIDGE_VERSION; type: "markup"; html: string };

/** What `window.inf` (and `window.fm`) looks like from inside a frame; frame scripts type against this. */
export type FrameBridgeApi = {
  readonly version: typeof FRAME_BRIDGE_VERSION;
  readonly theme: "dark" | "light";
  /** The host's view state for this mount; null until the host pushes one. */
  readonly state: unknown;
  /** The view state the host pushed at this document's birth; null until it pushes one. */
  readonly birthState: unknown;
  onTheme: (listener: (theme: "dark" | "light") => void) => () => void;
  onState: (listener: (state: unknown) => void) => () => void;
  subscribe: <T = unknown>(
    read: string,
    args: Record<string, unknown> | undefined,
    onValue: (value: T) => void,
    onError?: (error: Error & { code: FrameErrorCode }) => void,
  ) => { ready: Promise<void>; unsubscribe: () => Promise<void> };
  /** Resolves to the host's answer, when the action has one (a card's id from `cards.emit`). */
  action: (id: string, value?: unknown) => Promise<unknown>;
  fetch: (alias: string, request: z.input<typeof mediatedFetchRequestSchema>) => Promise<unknown>;
  /** The mount's own store slice; the host binds which. Resolves to the store's answer. */
  store: (request: FrameStoreRequest) => Promise<FrameStoreAnswer>;
  onStore: (listener: (key: string) => void) => () => void;
  /**
   * Stages a JSON snapshot under `name` beside the body's form; `undefined`
   * unstages it. Local: it leaves the card only with a footer click.
   */
  stage: (name: string, value: unknown) => void;
};

export type FrameStoreRequest = {
  op: (typeof FRAME_STORE_OPS)[number];
  key?: string;
  value?: unknown;
  prefix?: string;
};

/** The store's answer as the bridge carries it (`personalStoreResponseSchema`). */
export type FrameStoreAnswer = {
  value?: unknown;
  entries?: { key: string; value: unknown; updatedAt: number }[];
};
