import {
  COMPLETION_CARD_HEADINGS,
  type DomNode,
  ELEMENT_TYPES,
  HEADING_TAGS,
  NON_COPY,
  textOf,
} from "@shared/cardHeadings";
import {
  type Card,
  type CardMessage,
  cardPresentation,
  isStoryNote,
  mergeEffectOf,
  onStage,
} from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { cutText } from "@shared/textCut";
import { ElementType, parseDocument } from "htmlparser2";

/**
 * Native notifications (capability-gap P2): exactly the events that already
 * raise cards reach Notification Center, and only while the window is not
 * focused. The card/feed split is the noise filter - feed lines never
 * notify. The notifier diffs card snapshots at the broadcast seam, so the
 * supervisor stays notification-free and every card producer is covered by
 * one observer.
 */

export type CardNotifierOptions = {
  /** The user's toggle (default on). */
  enabled: () => boolean;
  /** True while any app window is focused; focused means no notification. */
  focused: () => boolean;
  /**
   * Shows one notification (Electron Notification behind this, or a phone's
   * push, `./phonePush.ts`); its click opens `cardId`. `kind` says whether
   * the card is new or its author answered the captain's reply.
   */
  show: (notification: CardNotice) => void;
  /**
   * What the record knows about a card that the card itself does not carry
   * (`NoticeFacts`); absent where nothing is known, as in a view of another
   * Mac, which then shows the card's own title and no project.
   */
  facts?: (card: Card, kind: CardNotice["kind"]) => NoticeFacts;
};

/**
 * Typed facts a notification's words need from the record, never from the
 * card's words: the project of the card's task, the task's title when the
 * card was drawn from its saved change story, and on a reply the author's
 * newest thread message since the captain's reply (`authorAnswer`).
 */
export type NoticeFacts = {
  project?: string | undefined;
  storyName?: string | undefined;
  answer?: string | undefined;
};

/**
 * One card-worthy moment, as every notifier shows it (INF-5030's plan,
 * arrangement A): the title is the ask line, what the card asks and its
 * project; the body is the work's name, a line break, then what it does.
 */
export type CardNotice = {
  kind: "card" | "reply";
  title: string;
  body: string;
  cardId: string;
};

/**
 * The longest body, in UTF-16 code units, cut at a whole word. It rests on
 * what one push carries: the relay sends Apple the sealed card inside a
 * payload of at most 4,096 bytes (its `APPLE_PAYLOAD_LIMIT`), and this body,
 * with the 200-unit title and a card id, still fits after sealing and
 * base64url at three bytes a unit (`src/core/phonePush.test.ts`). The phone
 * and the Mac shorten what they draw themselves.
 */
export const NOTICE_BODY_LIMIT = 600;

export class CardNotifier {
  /**
   * Whether each last-seen card was waiting on its author
   * (the captain replied under it); also the "already notified" record.
   */
  private readonly seen = new Map<string, { waiting: boolean }>();
  /**
   * Cards that were on the stage and left it to await their author's answer
   * to the captain's reply: their return is a reply, not a new card.
   */
  private away = new Set<string>();
  private primed = false;

  constructor(private readonly options: CardNotifierOptions) {}

  /**
   * Observe one cards broadcast. The first snapshot only seeds the map:
   * cards restored from a previous run are old news, not notifications.
   * A card off the stage, awaiting its author, is not there yet: it
   * notifies when it reaches the stage, the moment the window shows it. A
   * kept card the captain replied under stays on the stage: its
   * author's answer notifies when the wait ends.
   */
  observe(cards: Card[]): void {
    const live = new Set<string>();
    const away = new Set(
      cards
        .filter((entry) => !onStage(entry) && !entry.ended)
        .map((entry) => entry.id)
        .filter((id) => this.seen.has(id) || this.away.has(id)),
    );
    // An ended card is not news: its author closed it (INF-3071).
    for (const card of cards.filter((entry) => onStage(entry) && !entry.ended)) {
      live.add(card.id);
      const before = this.seen.get(card.id);
      this.seen.set(card.id, { waiting: card.awaiting !== undefined });
      if (!this.primed) continue;
      // A new card or an answered reply is news; a body update alone is not.
      const becameReady = before === undefined || (before.waiting && card.awaiting === undefined);
      if (!becameReady) continue;
      if (!this.options.enabled() || this.options.focused()) continue;
      const kind = before === undefined && !this.away.has(card.id) ? "card" : "reply";
      this.options.show({ kind, cardId: card.id, ...noticeWords(card, kind, this.options.facts) });
    }
    for (const id of this.seen.keys()) {
      if (!live.has(id)) this.seen.delete(id);
    }
    this.away = away;
    this.primed = true;
  }

  /**
   * Starts over as at boot: the next snapshot only seeds. A view of another
   * Mac (docs/view.md) does this when it reads everything again, so what
   * that read finds is old news, as restored cards are.
   */
  forget(): void {
    this.seen.clear();
    this.away.clear();
    this.primed = false;
  }

  /**
   * Seeds from a snapshot that was read rather than pushed, unless a push
   * has seeded since the last start: a push is never older than the read.
   */
  seed(cards: Card[]): void {
    if (!this.primed) this.observe(cards);
  }
}

/** The ask line, the name and the gist, in arrangement A. */
function noticeWords(
  card: Card,
  kind: CardNotice["kind"],
  factsOf: CardNotifierOptions["facts"],
): Pick<CardNotice, "title" | "body"> {
  const facts = factsOf?.(card, kind) ?? {};
  const ask = askWord(card, kind);
  const title = facts.project ? m.noticeAskInProject({ ask, project: facts.project }) : ask;
  const name = oneLine(facts.storyName || card.title);
  const gist = oneLine((kind === "reply" && facts.answer) || bodyGist(card.body));
  return { title, body: cutAtWord(gist ? `${name}\n${gist}` : name, NOTICE_BODY_LIMIT) };
}

/**
 * What the card asks, from typed facts alone: a merge button, the story
 * note of a task that merges on its own, an author's answer, or else the
 * card's kind chip.
 */
function askWord(card: Card, kind: CardNotice["kind"]): string {
  if (card.actions.some((action) => mergeEffectOf(action))) return m.noticeReadyToMerge();
  if (isStoryNote(card)) return m.mergesOnItsOwn();
  if (kind === "reply") return m.noticeReply();
  const presentation = cardPresentation(card);
  if (presentation === "decision") return m.uiCardKindDecision();
  return presentation === "attention" ? m.uiCardKindAttention() : m.uiCardKindNote();
}

/**
 * The author's newest thread message since the captain's newest reply,
 * undefined when the author answered only by revising the card. Host lines
 * and revision lines are not an answer.
 */
export function authorAnswer(messages: readonly CardMessage[]): string | undefined {
  const lastCaptain = messages.findLastIndex((message) => message.who === "captain");
  if (lastCaptain < 0) return undefined;
  return messages
    .slice(lastCaptain + 1)
    .findLast((message) => message.who !== "host" && !message.revision && message.text.trim())
    ?.text;
}

const NOT_GIST = new Set([
  ...NON_COPY,
  "figure",
  "svg",
  "table",
  "details",
  "form",
  "fieldset",
  "input",
  "select",
  "textarea",
  "button",
  "label",
  "img",
  "video",
  "audio",
  "canvas",
]);
/** The app's own lines on a card: its facts strip, its follow-ups and its merge line. */
const HOST_MARKS = ["data-facts", "data-followups", "data-merge-line"];
/** Elements whose text is one prose block. */
const BLOCKS = new Set(["p", "li", "blockquote", "dd", "dt", "pre", "figcaption"]);
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "br",
  "cite",
  "code",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
]);

type Element = DomNode & { attribs?: Record<string, string> };

/**
 * The body's gist, found by its structure, never its words: on a body with
 * the completion headings, the first prose block under What changed;
 * otherwise the first prose block. Empty when the body has none.
 */
export function bodyGist(body: string): string {
  const blocks = proseBlocks(body);
  const underWhatChanged = blocks.find((block) => block.heading === COMPLETION_CARD_HEADINGS[1]);
  return (underWhatChanged ?? blocks[0])?.text ?? "";
}

function proseBlocks(body: string): { heading: string | undefined; text: string }[] {
  const document = parseDocument(body, { decodeEntities: true });
  const blocks: { heading: string | undefined; text: string }[] = [];
  let heading: string | undefined;
  const add = (text: string) => {
    const line = oneLine(text);
    if (line) blocks.push({ heading, text: line });
  };
  const skipped = (node: Element) =>
    NOT_GIST.has(node.name?.toLowerCase() ?? "") ||
    HOST_MARKS.some((mark) => node.attribs?.[mark] !== undefined);
  const walk = (nodes: Element[]) => {
    let run = "";
    for (const node of nodes) {
      const name = node.name?.toLowerCase() ?? "";
      const inline =
        node.type === ElementType.Text || (ELEMENT_TYPES.has(node.type) && INLINE.has(name));
      if (inline) {
        if (!ELEMENT_TYPES.has(node.type) || !skipped(node)) run += ` ${proseOf(node)}`;
        continue;
      }
      add(run);
      run = "";
      if (!ELEMENT_TYPES.has(node.type) || skipped(node)) continue;
      if (HEADING_TAGS.has(name)) heading = oneLine(textOf(node));
      else if (BLOCKS.has(name)) add(proseOf(node));
      else walk((node.children ?? []) as Element[]);
    }
    add(run);
  };
  walk(document.children as unknown as Element[]);
  return blocks;
}

function proseOf(node: Element): string {
  if (node.type === ElementType.Text) return node.data ?? "";
  if (!ELEMENT_TYPES.has(node.type)) return "";
  const name = node.name?.toLowerCase() ?? "";
  if (NOT_GIST.has(name) || HOST_MARKS.some((mark) => node.attribs?.[mark] !== undefined))
    return "";
  if (name === "br") return " ";
  return ((node.children ?? []) as Element[]).map(proseOf).join("");
}

/**
 * One line of plain words: control characters, which a push would carry as
 * six-byte escapes, go with the line breaks.
 */
function oneLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
      .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
      .replace(/ ([.,;:!?])/g, "$1")
      .trim()
  );
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = cutText(text, max - 1);
  const space = room.search(/\s\S*$/);
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}
