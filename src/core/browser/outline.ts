/**
 * The page as a crewmate reads it (docs/task-browser.md, "What a crewmate
 * reads"): the browser's own accessibility tree, folded into one short line
 * per heading, piece of text and control. Each control the crewmate can use
 * carries a ref (`g3:e5`) that its commands take: it names its page's book
 * (`g3`) as well as the control (`e5`), so it is refused anywhere but on the
 * page that gave it, never used on another page's element. A ref stays the
 * same for the same element until the page moves to a new address,
 * including a move that does not load a new document.
 *
 * Pure: the host reads the tree (`HostBrowserPage.nodes`), this module
 * writes the words. A password field's value never appears, and once the
 * captain has held the page neither does any text typed into it that the
 * crewmate did not type itself (`OutlineOptions.typedOnly`), nor a key in
 * a format a service issues (`OutlineOptions.hideKeys`). A line shows
 * a time element's machine-readable time and a title tooltip, and a passage
 * longer than the line can be read in full (`passageOf`). Which of the
 * lines one answer shows is `window.ts`'s.
 *
 * A frame's own document, which the host reads beneath the frame's node,
 * reads under a line naming its site, by the same rules; a frame of a
 * known human check says so, and its controls' refs carry it, so the
 * crewmate's commands refuse them (docs/task-browser.md, "Frames").
 */

import { cutText } from "@shared/textCut";
import { hideKeys } from "../keyFormats";
import { browserCommand } from "./commandWords";

/** One accessibility node, as the host reads it off the page. */
export type BrowserNode = {
  id: string;
  role: string;
  name: string;
  value?: string;
  ignored: boolean;
  childIds: readonly string[];
  /** The page element behind the node, which the host can act on; absent for a virtual node. */
  target?: number;
  /** The node's states: checked, disabled, expanded, selected, level, url, focused... */
  properties: Readonly<Record<string, string | number | boolean>>;
  /**
   * Whether the page's window shows the element now: absent when the host
   * could not tell, as for an element the page does not lay out.
   */
  onScreen?: boolean;
  /** Where the page's window shows the element, in the page's own pixels from the window's top left. */
  box?: { x: number; y: number; width: number; height: number };
  /**
   * For a frame whose document the host read (its children): that
   * document's address, which its line names the site of.
   */
  frameUrl?: string;
};

/**
 * What a ref names: the element, the words the crewmate read it by, and
 * the site of the human check it sits in, which only the captain answers.
 */
export type RefEntry = { ref: string; target: number; role: string; name: string; check?: string };

/** A ref as the outline writes it: its book, then its control, as in `g3:e5`. */
export const REF_PATTERN = "g\\d+:e\\d+";

/** A ref's book and control, or nothing when the words are not a whole ref. */
export function parseRef(ref: string): { book: number; control: number } | undefined {
  const match = /^g(\d+):e(\d+)$/.exec(ref.trim().toLowerCase());
  return match ? { book: Number(match[1]), control: Number(match[2]) } : undefined;
}

/**
 * The refs of one document: the same element keeps its ref across reads,
 * and a new address starts a new book (the caller replaces it, including
 * a move that does not load a new document, and also when the captain
 * hands the page back). A book takes its number from `mint` when a read
 * first names a ref from it, and every ref it gives carries that number.
 */
export class RefBook {
  private readonly byTarget = new Map<number, RefEntry>();
  private readonly byRef = new Map<string, RefEntry>();
  /** What the crewmate typed into each element, in this book's time. */
  private readonly typed = new Map<number, string>();
  private next = 1;
  private book: number | undefined;

  constructor(private readonly mint: () => number) {}

  /** This book's number, once a read has named a ref from it. */
  get number(): number | undefined {
    return this.book;
  }

  refFor(target: number, role: string, name: string, check?: string): string {
    const known = this.byTarget.get(target);
    if (known) {
      known.role = role;
      known.name = name;
      if (check) known.check = check;
      else delete known.check;
      return known.ref;
    }
    this.book ??= this.mint();
    const entry: RefEntry = {
      ref: `g${this.book}:e${this.next}`,
      target,
      role,
      name,
      ...(check ? { check } : {}),
    };
    this.next += 1;
    this.byTarget.set(target, entry);
    this.byRef.set(entry.ref, entry);
    return entry.ref;
  }

  resolve(ref: string): RefEntry | undefined {
    return this.byRef.get(ref.trim().toLowerCase());
  }

  /** The crewmate typed this into the element, replacing what it held. */
  noteTyped(target: number, text: string): void {
    this.typed.set(target, text);
  }

  /** Whether the element holds just what the crewmate typed into it: then it is the crewmate's to read. */
  holdsTyped(target: number, value: string): boolean {
    const typed = this.typed.get(target);
    return typed !== undefined && squash(typed) === squash(value);
  }
}

/**
 * Where a ref the current page's book does not hold came from, read off
 * the browser's books: the words a crewmate reads say which, so it never
 * guesses that an old ref still names something.
 */
export type RefStanding =
  /** Not written as a whole ref, such as a bare `e5`. */
  | { kind: "not-a-ref" }
  /** The current page's own book, which never gave this control. */
  | { kind: "this-page" }
  /** The other page's book, while this one is current. */
  | { kind: "other-page"; page: number; current: number }
  /** A page of this browser that has since moved to a new address or closed. */
  | { kind: "earlier-page" }
  /** A page from before the captain last handed this browser back. */
  | { kind: "handed-back" }
  /** A browser this task had before, which has stopped. */
  | { kind: "earlier-browser" }
  /** No book this browser's task has had. */
  | { kind: "unknown" };

/** What a refused ref from a page that moved or closed says after the ref. */
export const REF_FROM_EARLIER_PAGE =
  "is from a page this browser showed before it moved to a new address or closed";

/** What a refused ref from before the captain handed the browser back says after the ref. */
export const REF_FROM_BEFORE_HANDBACK =
  "is from before the captain handed this browser back, and refs from then are gone";

const REF_LOOK_AGAIN = `Use a ref from the latest answer, or run ${browserCommand("snapshot")} for the page's refs now.`;

/** The words that refuse a ref, by where it stands; none is ever used on another element. */
export function refusedRefWords(ref: string, standing: RefStanding): string {
  const shown = ref.trim();
  switch (standing.kind) {
    case "not-a-ref":
      return `${JSON.stringify(shown)} is not a whole ref. A ref names the page it came from as well as its control, and is copied whole, with its g number, from the latest answer.`;
    case "this-page":
      return `There is no ${shown} on the page now. ${REF_LOOK_AGAIN}`;
    case "other-page":
      return `${shown} is a ref on page ${standing.page}, and your commands act on page ${standing.current} now. Use this page's refs, or switch with ${browserCommand(`selectpage ${standing.page}`)}.`;
    case "earlier-page":
      return `${shown} ${REF_FROM_EARLIER_PAGE}, so it is not used on the page now. ${REF_LOOK_AGAIN}`;
    case "handed-back":
      return `${shown} ${REF_FROM_BEFORE_HANDBACK}. ${REF_LOOK_AGAIN}`;
    case "earlier-browser":
      return `${shown} is from a browser this task had before, which has stopped. ${REF_LOOK_AGAIN}`;
    case "unknown":
      return `There is no ${shown} in this browser. ${REF_LOOK_AGAIN}`;
  }
}

/** Controls a crewmate can act on; each gets a ref when the host can reach its element. */
const CONTROLS = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "option",
  "ToggleButton",
  "PopUpButton",
]);

/** Controls whose value is what someone typed or chose. */
const FIELDS = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"]);

/** Fields that hold what someone typed, whatever the browser says of them. */
const TYPED = new Set(["textbox", "searchbox", "spinbutton"]);

/**
 * Whether a node holds text someone typed: a typed field, or anything the
 * browser marks editable - an input a list completes, a part of the page
 * one writes in. A list's chosen option is one of the site's own words.
 */
function typedInto(node: BrowserNode): boolean {
  return TYPED.has(node.role) || Boolean(node.properties.editable);
}

/** One line each, children folded into the line: a heading's or a button's text is its name. */
const LEAVES = new Set([...CONTROLS, "heading", "image", "img", "math", "meter", "progressbar"]);

/** Roles that frame what they hold: a line of their own, their content indented beneath. */
const FRAMES = new Set([
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "status",
  "list",
  "listitem",
  "table",
  "row",
  "grid",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "tree",
  "radiogroup",
  "toolbar",
  "article",
  "figure",
]);

/** Named only, a group or region is a frame too; unnamed it says nothing. */
const NAMED_FRAMES = new Set(["group", "region"]);

/** Nodes that never say anything a reader needs. */
const SILENT = new Set(["InlineTextBox", "ListMarker", "LineBreak", "MenuListPopup"]);

/** Option names a list's line shows before it says how many more there are. */
const OPTIONS_SHOWN = 12;

/** Characters of a name or a passage one outline line shows before it says the rest was cut. */
export const TEXT_SHOWN = 2_000;

/** Characters of one passage `passageOf` reads in full before it says how many remain. */
export const FULL_TEXT_MAX = 80_000;

/** What a line says when its text was cut, so a later read can ask for the rest by its ref. */
export const CUT_SHORT = "cut short";

const NAME_MAX = TEXT_SHOWN;

/** Chromium draws a password field's value as bullets; such a value is never read out. */
const HIDDEN_VALUE = /^•+$/;

/** What a field whose value is never read out says in its place. */
export const HIDDEN_VALUE_WORDS = "(value hidden)";

/** The line for an editable part of the page whose text is not read out. */
const HIDDEN_TEXT_LINE = `editable text ${HIDDEN_VALUE_WORDS}`;

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function squash(text: string): string {
  const line = flat(text);
  return line.length > NAME_MAX ? `${cutText(line, NAME_MAX - 1)}…` : line;
}

/** Whether `squash` cut this text. */
function cutShort(text: string): boolean {
  return flat(text).length > NAME_MAX;
}

/** A time and a title tooltip the outline names, kept short enough for one line. */
type Mark = { datetime?: string; title?: string };

function markText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clipMark(text: string, max: number): string {
  return text.length > max ? `${cutText(text, max - 1)}…` : text;
}

/**
 * Each node's machine-readable time and title tooltip. A `datetime` or
 * `title` on an element applies to the text inside it; an accessible
 * description applies only to its own node.
 */
export function marksById(nodes: readonly BrowserNode[]): Map<string, Mark> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds));
  const marks = new Map<string, Mark>();
  const collect = (id: string, from?: Mark): void => {
    const node = byId.get(id);
    if (!node) return;
    const datetime = markText(node.properties.datetime) ?? from?.datetime;
    const ownTitle = markText(node.properties.title);
    const title = ownTitle ?? from?.title ?? markText(node.properties.description);
    if (datetime || title) {
      marks.set(id, {
        ...(datetime ? { datetime } : {}),
        ...(title ? { title } : {}),
      });
    }
    const passed: Mark = {
      ...(datetime ? { datetime } : {}),
      ...(ownTitle || from?.title ? { title: ownTitle ?? from?.title } : {}),
    };
    // A frame's document is its own: the frame's title names the frame, not what is inside it.
    const frame = node.role === "Iframe" || node.role === "IframePresentational";
    const next = !frame && (passed.datetime || passed.title) ? passed : undefined;
    for (const child of node.childIds) collect(child, next);
  };
  for (const node of nodes) {
    if (!children.has(node.id)) collect(node.id);
  }
  return marks;
}

function annotation(node: BrowserNode, marks: ReadonlyMap<string, Mark>): string {
  const mark = marks.get(node.id);
  if (!mark) return "";
  const bits: string[] = [];
  if (mark.datetime) bits.push(`time: ${clipMark(mark.datetime, 80)}`);
  if (mark.title && flat(mark.title) !== flat(node.name) && mark.title !== mark.datetime) {
    bits.push(`title: ${JSON.stringify(clipMark(mark.title, 200))}`);
  }
  return bits.length > 0 ? ` (${bits.join(", ")})` : "";
}

/**
 * One node's passage in full, for a crewmate that was shown a cut line.
 * The same protection as the outline: a password, and once the captain has
 * held the page any text the crewmate did not type itself, is never read out.
 */
export function passageOf(
  page: BrowserNode,
  refs: RefBook,
  options: OutlineOptions = {},
): { hidden: true } | { hidden: false; text: string; omitted: number } {
  const node = options.hideKeys ? (keysHidden([page]).nodes[0] as BrowserNode) : page;
  const value = node.value === undefined ? "" : String(node.value);
  const own = node.target !== undefined && refs.holdsTyped(node.target, value || node.name);
  if (HIDDEN_VALUE.test(value) || (options.typedOnly && typedInto(node) && !own)) {
    return { hidden: true };
  }
  const raw = FIELDS.has(node.role) && value ? value : node.name;
  const text = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (text.length <= FULL_TEXT_MAX) return { hidden: false, text, omitted: 0 };
  return {
    hidden: false,
    text: cutText(text, FULL_TEXT_MAX),
    omitted: text.length - FULL_TEXT_MAX,
  };
}

function quoted(text: string): string {
  return JSON.stringify(squash(text));
}

/**
 * A link's address, shortened to its path when it stays on the page's own
 * site; without its query and fragment when `bare`, where a signed-in
 * site keeps tokens and codes.
 */
function shortAddress(href: string, pageUrl: string | undefined, bare: boolean): string {
  try {
    const url = new URL(href);
    if (bare) {
      url.search = "";
      url.hash = "";
    }
    const page = pageUrl ? new URL(pageUrl) : undefined;
    if (page && url.origin === page.origin) return `${url.pathname}${url.search}${url.hash}`;
    return url.href;
  } catch {
    return href;
  }
}

/** Whether an outline line is a control or heading named exactly `text`. */
function namesLine(line: string | undefined, text: string): boolean {
  if (!line) return false;
  const body = line.trimStart();
  return !body.startsWith("text ") && body.includes(` ${quoted(text)}`);
}

function stateWords(node: BrowserNode): string[] {
  const props = node.properties;
  const words: string[] = [];
  if (node.role === "heading" && typeof props.level === "number")
    words.push(`level ${props.level}`);
  if (props.checked === "true" || props.checked === true) words.push("checked");
  else if (props.checked === "mixed") words.push("partly checked");
  else if (props.checked === "false" || props.checked === false) words.push("not checked");
  if (props.pressed === "true" || props.pressed === true) words.push("pressed");
  if (props.selected === true && node.role !== "option") words.push("selected");
  if (props.expanded === true) words.push("expanded");
  else if (props.expanded === false) words.push("collapsed");
  if (props.disabled === true) words.push("disabled");
  if (props.readonly === true) words.push("read-only");
  if (props.required === true) words.push("required");
  if (props.invalid === "true") words.push("invalid");
  if (props.focused === true) words.push("focused");
  return words;
}

export type OutlineOptions = {
  /** The page's address, so a link to the same site reads as its path. */
  pageUrl?: string;
  /** Links read without their query and fragment: the page may show the captain's account. */
  withholdQueries?: boolean;
  /**
   * Text typed into the page - a typed field's value, an editable part's
   * text - read out only where it is just what the crewmate typed itself
   * (`RefBook.noteTyped`): once the captain has held the page, any other
   * may be what he typed - a card number, a code - whether or not he sent it.
   */
  typedOnly?: boolean;
  /**
   * A key in a format a service issues (`keyFormats.ts`) reads as
   * `[key hidden]` wherever the page's words reach the crewmate - a name,
   * a value, an address, a tooltip - and a search or wait never finds it:
   * once the captain has held the page, it may show a key he just made.
   */
  hideKeys?: boolean;
};

/**
 * The page's nodes with every key in a known format hidden in their words
 * (`OutlineOptions.hideKeys`), and whether any was: then a picture would
 * show it.
 */
export function keysHidden(nodes: readonly BrowserNode[]): {
  nodes: BrowserNode[];
  hidden: boolean;
} {
  let hidden = false;
  const hide = <T>(value: T): T => {
    if (typeof value !== "string") return value;
    const out = hideKeys(value);
    if (out !== value) hidden = true;
    return out as T;
  };
  const out = nodes.map((node) => {
    const properties: Record<string, string | number | boolean> = {};
    // A link's address is hidden once shortened (`leafLine`): hidden first, it may not parse.
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = key === "url" ? value : hide(value);
    }
    return {
      ...node,
      name: hide(node.name),
      ...(node.value !== undefined ? { value: hide(node.value) } : {}),
      properties,
    };
  });
  return { nodes: out, hidden };
}

/**
 * The issuers of human checks, by the address of the frame they draw in
 * (docs/task-browser.md, "Frames"): a list of their own hosts and paths,
 * a floor and never a claim that nothing else is one. A crewmate reads
 * such a frame and never answers it; only the captain does.
 */
const HUMAN_CHECKS: readonly { host: RegExp; path?: RegExp }[] = [
  { host: /^challenges\.cloudflare\.com$/ },
  { host: /(^|\.)hcaptcha\.com$/ },
  { host: /^(www\.)?(google|recaptcha)\.(com|net)$/, path: /^\/recaptcha\// },
  { host: /(^|\.)(arkoselabs|funcaptcha)\.com$/ },
  { host: /(^|\.)captcha-delivery\.com$/ },
];

/** A frame's host, from its document's address; nothing for one with no web origin. */
function frameHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/** The host of the human check a frame's address belongs to, or nothing. */
export function humanCheckOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const found = HUMAN_CHECKS.some(
      (check) => check.host.test(host) && (!check.path || check.path.test(parsed.pathname)),
    );
    return found ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

/** What a frame that is a human check says after its site. */
export const HUMAN_CHECK_WORDS = "a human check, which only the captain answers";

/** One line of the outline, and what a window needs to know of it (`window.ts`). */
export type OutlineLine = {
  /** The line as the crewmate reads it, indented by its depth. */
  text: string;
  depth: number;
  /** The node's role; `text` for a piece of text. */
  role: string;
  /** Whether the page's window shows it now, when the host could tell. */
  onScreen?: boolean;
  /**
   * What a search for words reads: the line, and the whole of a passage it
   * shows cut short. Never text the outline keeps back.
   */
  words: string;
};

export type Outline = {
  /** Every line of the outline, joined: the whole page as the crewmate reads it. */
  text: string;
  /** Every line of the outline, in order, from the page's top. */
  lines: OutlineLine[];
  /** Every piece of text the page shows, for a wait on some words to appear. */
  words: string;
  /**
   * What holds text `typedOnly` kept back, one each as its line
   * names it (`textbox "Card number" [g1:e1]`), wherever it is on the page:
   * a picture would show it.
   */
  withheld: string[];
  /** Whether a key in a known format reads as `[key hidden]` somewhere on the page. */
  keys: boolean;
};

/**
 * Fold the tree into the crewmate's outline, giving each reachable control
 * a ref from `refs`. The root is the node no other node names as a child.
 */
export function outlinePage(
  page: readonly BrowserNode[],
  refs: RefBook,
  options: OutlineOptions = {},
): Outline {
  const hiding = options.hideKeys ? keysHidden(page) : { nodes: page, hidden: false };
  const nodes = hiding.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds));
  const roots = nodes.filter((node) => !children.has(node.id));
  const lines: OutlineLine[] = [];
  const words: string[] = [];
  const withheld: string[] = [];
  let linkKeys = false;
  const seen = new Set<string>();
  const marks = marksById(nodes);

  const emit = (
    depth: number,
    line: string,
    role: string,
    onScreen: boolean | undefined,
    full?: string,
  ): void => {
    const text = `${"  ".repeat(depth)}${line}`;
    lines.push({
      text,
      depth,
      role,
      ...(onScreen !== undefined ? { onScreen } : {}),
      words: full ? `${line}\n${full}` : line,
    });
  };
  const lastLine = (): string | undefined => lines.at(-1)?.text;

  const optionNames = (node: BrowserNode): string[] => {
    const names: string[] = [];
    const walk = (id: string): void => {
      const child = byId.get(id);
      if (!child || seen.has(child.id)) return;
      seen.add(child.id);
      if (child.role === "option" || child.role === "MenuListOption") {
        if (child.name) names.push(squash(child.name));
        return;
      }
      for (const next of child.childIds) walk(next);
    };
    for (const id of node.childIds) walk(id);
    return names;
  };

  const leafLine = (node: BrowserNode, check: string | undefined): string => {
    const name = squash(node.name);
    const parts = [node.role === "img" ? "image" : node.role];
    if (name) parts.push(quoted(name));
    if (node.target !== undefined && CONTROLS.has(node.role)) {
      parts.push(`[${refs.refFor(node.target, node.role, name, check)}]`);
    }
    const value = node.value === undefined ? "" : String(node.value);
    let line = parts.join(" ");
    if (FIELDS.has(node.role) && value) {
      const own = node.target !== undefined && refs.holdsTyped(node.target, value);
      if (options.typedOnly && typedInto(node) && !own) {
        withheld.push(line);
        line += ` ${HIDDEN_VALUE_WORDS}`;
      } else {
        line += HIDDEN_VALUE.test(value) ? ` ${HIDDEN_VALUE_WORDS}` : `: ${quoted(value)}`;
      }
    }
    if (node.role === "link" && typeof node.properties.url === "string") {
      const address = shortAddress(
        node.properties.url,
        options.pageUrl,
        options.withholdQueries === true,
      );
      const read = options.hideKeys ? hideKeys(address) : address;
      if (read !== address) linkKeys = true;
      line += ` → ${read}`;
    }
    if (node.role === "combobox" || node.role === "listbox") {
      const names = optionNames(node);
      if (names.length > 0) {
        const shown = names.slice(0, OPTIONS_SHOWN).join(", ");
        const more =
          names.length > OPTIONS_SHOWN ? `, and ${names.length - OPTIONS_SHOWN} more` : "";
        line += ` (options: ${shown}${more})`;
      }
    }
    const states = stateWords(node);
    if (states.length > 0) line += ` (${states.join(", ")})`;
    line += annotation(node, marks);
    if (node.name && cutShort(node.name)) line += ` (${CUT_SHORT})`;
    return line;
  };

  /** Mark a node's whole subtree read, answering whether any of it shows text. */
  const fold = (id: string): boolean => {
    const node = byId.get(id);
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    let text = node.role === "StaticText" && squash(node.name) !== "";
    for (const child of node.childIds) text = fold(child) || text;
    return text;
  };

  // `check` is the human check a node sits in, whose controls only the captain uses.
  const walk = (id: string, depth: number, shown?: boolean, check?: string): void => {
    const node = byId.get(id);
    if (!node || seen.has(node.id)) return;
    // An element the host could not place reads as where its parent is.
    const onScreen = node.onScreen ?? shown;
    if (SILENT.has(node.role)) {
      seen.add(node.id);
      return;
    }
    // Text in an editable part of the page is what someone typed there. No
    // ref reaches it, so the crewmate never typed it: read that it holds
    // text, never the text.
    if (options.typedOnly && !FIELDS.has(node.role) && node.properties.editable) {
      if (fold(node.id) && lastLine() !== `${"  ".repeat(depth)}${HIDDEN_TEXT_LINE}`) {
        withheld.push("editable text");
        emit(depth, HIDDEN_TEXT_LINE, "editable", onScreen);
      }
      return;
    }
    seen.add(node.id);
    if (node.role === "StaticText") {
      const text = squash(node.name);
      if (text) {
        // A wait for words reads the passage, not only the cut line.
        words.push(flat(node.name));
        // A label read right after its control says nothing new.
        if (!namesLine(lastLine(), text)) {
          const ref =
            cutShort(node.name) && node.target !== undefined
              ? ` [${refs.refFor(node.target, "text", text, check)}]`
              : "";
          const cut = cutShort(node.name) ? ` (${CUT_SHORT})` : "";
          emit(
            depth,
            `text ${quoted(text)}${ref}${annotation(node, marks)}${cut}`,
            "text",
            onScreen,
            flat(node.name),
          );
        }
      }
      return;
    }
    if (node.ignored) {
      for (const child of node.childIds) walk(child, depth, onScreen, check);
      return;
    }
    if (LEAVES.has(node.role)) {
      if (node.name) words.push(flat(node.name));
      // The label a control is named by, read just before it, folds into the control's line.
      const label = `${"  ".repeat(depth)}text ${quoted(node.name)}`;
      if (node.name && lastLine()?.startsWith(label)) {
        lines.pop();
      }
      emit(
        depth,
        leafLine(node, check),
        node.role,
        onScreen,
        node.name ? flat(node.name) : undefined,
      );
      if (node.role === "combobox" || node.role === "listbox") return;
      // A control's own text is its name; mark the rest read so it is not repeated.
      for (const child of node.childIds) fold(child);
      return;
    }
    if (node.role === "Iframe" || node.role === "IframePresentational") {
      // A frame's own document, which the host read beneath it, reads under
      // a line naming its site; a human check's controls are the captain's.
      const host = frameHost(node.frameUrl);
      const inCheck = humanCheckOf(node.frameUrl) ?? check;
      const named = node.name ? ` ${quoted(node.name)}` : "";
      const from = host ? ` from ${host}` : "";
      const head = `frame${named}${from}${inCheck && inCheck !== check ? `: ${HUMAN_CHECK_WORDS}` : ""}`;
      if (node.childIds.length === 0) {
        emit(depth, `${head} (its content could not be read)`, "frame", onScreen);
        return;
      }
      emit(depth, head, "frame", onScreen);
      const at = lines.length;
      for (const child of node.childIds) walk(child, depth + 1, onScreen, inCheck);
      const line = lines[at - 1];
      if (lines.length === at && line) line.text += " (shows nothing to read)";
      return;
    }
    const framed = FRAMES.has(node.role) || (NAMED_FRAMES.has(node.role) && node.name);
    if (framed) {
      emit(depth, node.name ? `${node.role} ${quoted(node.name)}` : node.role, node.role, onScreen);
      for (const child of node.childIds) walk(child, depth + 1, onScreen, check);
      return;
    }
    for (const child of node.childIds) walk(child, depth, onScreen, check);
  };

  for (const root of roots) walk(root.id, 0);

  return {
    text: lines.map((line) => line.text).join("\n"),
    lines,
    words: words.join("\n"),
    withheld,
    keys: hiding.hidden || linkKeys,
  };
}
