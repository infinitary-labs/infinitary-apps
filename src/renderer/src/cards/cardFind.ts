import { type FindSpan, findMatches } from "@shared/cardFind";
import { useEffect, useLayoutEffect } from "react";
import { create } from "zustand";
import { focusWithRing } from "../design/focus";
import { onFrameHostUpdate } from "../plugins/frames/frameController";
import { controllerOf, giveFocusBack } from "../plugins/frames/frameFocus";

/**
 * Finding words in the shown card (⌘F or the magnifying glass; docs/keyboard.md,
 * "Finding in the shown card"). One finding at a time, on whichever entry the
 * stage shows: its title, body, facts strip and thread, or a record's or past
 * card's own parts, in reading order. The window's own words are matched
 * here; each card page hands out the words it shows and is sent back only
 * where its matches are (`FRAME_FIND_SCRIPT`), so what the person typed never
 * enters a card's page. Matches are drawn with the CSS Custom Highlight API in
 * each document, never written into the markup.
 */

export type CardFindState = {
  open: boolean;
  /** The words looked for; kept when the field closes, so ⌘F brings them back selected. */
  words: string;
  /** The current match, counted from 0 in reading order. */
  current: number;
  total: number;
  /** Moves each time the field should take the keyboard's focus with its words selected. */
  focus: number;
  /**
   * The words `current` and `total` were counted for, by the newest read;
   * null from each change of the words until that read lands. Until they
   * are the words in the field, the count shows nothing and no match is
   * stepped to.
   */
  found: string | null;
};

export const useCardFind = create<CardFindState>(() => ({
  open: false,
  words: "",
  current: 0,
  total: 0,
  focus: 0,
  found: null,
}));

/** The parts of a shown entry that are read, in reading order (a part inside another is read once). */
const REGIONS = [
  "[data-card-title]",
  "[data-past-title]",
  "[data-record-title]",
  "[data-card-body]",
  "[data-card-facts]",
  "[data-thread-messages]",
  "[data-crew-log]",
].join(",");
/** Never read: code, a field's value, and the find field itself. */
const SKIP = "script,style,textarea,select,option,input,noscript,template,[data-card-find]";
/** A change of block between two runs of words: a match never runs from one into the next. */
const BLOCK =
  "p,li,dt,dd,td,th,pre,h1,h2,h3,h4,h5,h6,summary,figcaption,blockquote,legend,label,caption,div,section,article,aside,header,footer,nav,main,figure,details,fieldset,table,tr,ul,ol,dl,button";
const BETWEEN_BLOCKS = "\u0000";

type WindowPart = { kind: "window"; ranges: Range[] };
type FramePart = { kind: "frame"; frame: HTMLIFrameElement; seq: number; spans: FindSpan[] };
type Part = WindowPart | FramePart;

let parts: Part[] = [];
/** The parts whose every match is drawn now, so a step redraws only the current one. */
let painted: Part[] | null = null;
/** The current match's index last sent to each frame (-1 for none). */
const lastMark = new Map<HTMLIFrameElement, number>();
let marked = new Set<HTMLIFrameElement>();
let generation = 0;
/** Watches the frame holding the current match while it grows, to keep the match in sight. */
let following: ResizeObserver | null = null;
/**
 * Whether the current match is still on its way into sight: its box not yet
 * back from the frame holding it, or that frame still followed while it
 * grows. A read again meanwhile, started by any change to what is shown,
 * brings it into sight in its turn instead of dropping it.
 */
let revealing = false;
/**
 * Counts the paints. A newer paint stands for every older one: a frame
 * answers an older paint's mark with no box once a newer mark replaced it,
 * and that late answer must not say the newer match is no longer on its way.
 */
let paints = 0;
/** Counts the person's steps, so a step taken while a read is out is brought into sight by that read. */
let steps = 0;
/** Where focus goes when the field closes: what had it before ⌘F, or the magnifying glass. */
let returnTo: Element | "button" | null = null;

/** The entry the stage shows now, never one it prepares or keeps drawn while it leaves. */
export function shownStageEntry(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-card-presentation] > [data-stage-entry="shown"]',
  );
}

/**
 * Whether an element's words are on show, or would be once the folded
 * sections holding them open: never words hidden on their own, by
 * `visibility`, `display` or `hidden`, which no opening shows.
 */
function shown(element: Element): boolean {
  if (getComputedStyle(element).visibility !== "visible") return false;
  // Outward from the words, every box on the way is drawn, or is only kept
  // from drawing by a closed folded section it sits in, up to one that is
  // drawn; a fold inside a fold counts once both open.
  let folded = false;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (getComputedStyle(at).display === "none") return false;
    if (at.getClientRects().length > 0) return at === element || folded;
    const fold = at.parentElement;
    if (fold instanceof HTMLDetailsElement && !fold.open && at.tagName !== "SUMMARY") folded = true;
  }
  return false;
}

/** Every region's words and frames in the shown entry, in reading order. */
function* regionsOf(entry: HTMLElement): Generator<HTMLElement> {
  for (const region of entry.querySelectorAll<HTMLElement>(REGIONS)) {
    if (region.parentElement?.closest(REGIONS)) continue;
    if (region.closest("[data-card-head]")) continue;
    yield region;
  }
}

/** The window's own words in one region, and the frames it holds, each in turn. */
function* runsOf(
  region: HTMLElement,
): Generator<{ text: string; nodes: Text[]; starts: number[] } | HTMLIFrameElement> {
  const walk = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node instanceof Element
        ? node.matches(SKIP)
          ? NodeFilter.FILTER_REJECT
          : node instanceof HTMLIFrameElement
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT,
  });
  let run = { text: "", nodes: [] as Text[], starts: [] as number[] };
  let block: Element | null = null;
  const seen = new Map<Element, boolean>();
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (node instanceof HTMLIFrameElement) {
      if (run.nodes.length) yield run;
      run = { text: "", nodes: [], starts: [] };
      block = null;
      yield node;
      continue;
    }
    const text = node as Text;
    const element = text.parentElement;
    if (!element || !text.data) continue;
    let ok = seen.get(element);
    if (ok === undefined) {
      ok = shown(element);
      seen.set(element, ok);
    }
    if (!ok) continue;
    const at = element.closest(BLOCK);
    if (run.nodes.length && at !== block) run.text += BETWEEN_BLOCKS;
    block = at;
    run.nodes.push(text);
    run.starts.push(run.text.length);
    run.text += text.data;
  }
  if (run.nodes.length) yield run;
}

/**
 * The ranges of a run's matches, resolved in one pass over its text nodes:
 * `findMatches` gives them in order, so each one's search starts where the
 * last one's ended.
 */
function rangesOf(run: { nodes: Text[]; starts: number[] }, spans: FindSpan[]): Range[] {
  const ranges: Range[] = [];
  const end = (i: number) => (run.starts[i] ?? 0) + (run.nodes[i]?.data.length ?? 0);
  let i = 0;
  for (const span of spans) {
    while (i < run.nodes.length && end(i) <= span.start) i += 1;
    let j = i;
    while (j < run.nodes.length && end(j) < span.end) j += 1;
    const first = run.nodes[i];
    const last = run.nodes[j];
    if (!first || !last) break;
    const range = document.createRange();
    range.setStart(first, span.start - (run.starts[i] ?? 0));
    range.setEnd(last, span.end - (run.starts[j] ?? 0));
    if (!range.collapsed) ranges.push(range);
  }
  return ranges;
}

/** Reads the shown entry anew and matches `words` in it; null when a newer reading began. */
async function collect(entry: HTMLElement, words: string, from: number): Promise<Part[] | null> {
  const found: Part[] = [];
  for (const region of regionsOf(entry)) {
    for (const run of runsOf(region)) {
      if (run instanceof HTMLIFrameElement) {
        const read = await controllerOf(run)?.findRead();
        if (from !== generation) return null;
        if (!read) continue;
        found.push({
          kind: "frame",
          frame: run,
          seq: read.seq,
          spans: findMatches(read.text, words),
        });
        continue;
      }
      const ranges = rangesOf(run, findMatches(run.text, words));
      if (ranges.length) found.push({ kind: "window", ranges });
    }
  }
  return found;
}

function countOf(part: Part): number {
  return part.kind === "window" ? part.ranges.length : part.spans.length;
}

function clearWindow(): void {
  painted = null;
  globalThis.CSS?.highlights?.delete("inf-find");
  globalThis.CSS?.highlights?.delete("inf-find-current");
}

function clearFrames(keep: Set<HTMLIFrameElement> = new Set()): void {
  lastMark.clear();
  for (const frame of marked)
    if (!keep.has(frame) && frame.isConnected) void controllerOf(frame)?.findMark(0, [], -1);
  marked = new Set([...marked].filter((frame) => keep.has(frame)));
}

/** The nearest ancestor that scrolls `element` up and down. */
function scrollerOf(element: Element): HTMLElement | null {
  for (let at = element.parentElement; at && at !== document.body; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && at.scrollHeight > at.clientHeight)
      return at;
  }
  return null;
}

/**
 * The part of a scroller a person reads: its scrollport, less a margin at
 * either edge so a match is never flush against a cut. What an outer
 * scroller cuts off is that scroller's to bring into sight in turn.
 */
function readable(scroller: HTMLElement): { top: number; bottom: number } {
  const box = scroller.getBoundingClientRect();
  const top = box.top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  const context = Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--space-6")) || 24;
  const margin = Math.min(context, Math.max(0, (bottom - top) / 4));
  return { top: top + margin, bottom: bottom - margin };
}

/**
 * Brings the box from `top` to `bottom` (window coordinates) into the part
 * of each scroller holding `element` that a person reads, centred in it:
 * the nearest first, then each outer one, which carries the inner one's
 * sight with it, so the box ends in sight through all of them.
 */
export function bringIntoView(element: Element, top: number, bottom: number): void {
  for (let scroller = scrollerOf(element); scroller; scroller = scrollerOf(scroller)) {
    const sight = readable(scroller);
    if (top >= sight.top && bottom <= sight.bottom) continue;
    const before = scroller.scrollTop;
    scroller.scrollTop +=
      top - sight.top - Math.max(0, (sight.bottom - sight.top - (bottom - top)) / 2);
    const moved = scroller.scrollTop - before;
    top -= moved;
    bottom -= moved;
  }
}

/**
 * Lights every match, the current one apart, and brings the current one
 * into sight when `reveal`: a closed folded section holding it opens.
 */
function paint(current: number, reveal: boolean, from: number): void {
  const painting = ++paints;
  following?.disconnect();
  following = null;
  revealing = false;
  let lit = null as Range | null;
  let litFrame = null as { part: FramePart; index: number } | null;
  let counted = 0;
  for (const part of parts) {
    const count = countOf(part);
    const index = current - counted;
    if (index >= 0 && index < count) {
      if (part.kind === "window") lit = part.ranges[index] ?? null;
      else litFrame = { part, index };
    }
    counted += count;
  }
  if (globalThis.CSS?.highlights) {
    // Every match is drawn once per finding; a step only moves the current
    // one, drawn above the rest.
    if (painted !== parts) {
      painted = parts;
      const every = new Highlight();
      for (const part of parts)
        if (part.kind === "window") for (const r of part.ranges) every.add(r);
      CSS.highlights.set("inf-find", every);
    }
    const highlight = new Highlight();
    if (lit) highlight.add(lit);
    highlight.priority = 1;
    CSS.highlights.set("inf-find-current", highlight);
  }
  for (const part of parts) {
    if (part.kind !== "frame") continue;
    marked.add(part.frame);
    const index = litFrame?.part === part ? litFrame.index : -1;
    // A frame whose current match stays as it was is not sent it again.
    if (lastMark.get(part.frame) === index && !(reveal && index >= 0)) continue;
    lastMark.set(part.frame, index);
    const spans = part.spans.map((span): [number, number] => [span.start, span.end]);
    if (reveal && index >= 0) revealing = true;
    void controllerOf(part.frame)
      ?.findMark(part.seq, spans, index)
      .then((box) => {
        if (painting !== paints || from !== generation || !reveal || index < 0) return;
        if (!box) {
          revealing = false;
          return;
        }
        const frame = part.frame;
        // The frame grows once a section opened in it; look again once it has.
        const show = () => {
          const rect = frame.getBoundingClientRect();
          const scale = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
          const top = rect.top + box.top * scale;
          bringIntoView(frame, top, top + box.height * scale);
        };
        show();
        // An opened section grows the frame a moment later: look again once
        // it has. The observer's first call is the size it had; its second
        // is the growth, after which it lets go.
        following?.disconnect();
        let calls = 0;
        const watch = new ResizeObserver(() => {
          calls += 1;
          if (from === generation && current === useCardFind.getState().current) show();
          if (calls < 2 && from === generation) return;
          watch.disconnect();
          if (following === watch) {
            following = null;
            revealing = false;
          }
        });
        following = watch;
        watch.observe(frame);
      });
  }
  if (reveal && lit) {
    const range = lit;
    const element = range.startContainer.parentElement;
    for (let at = element; at; at = at.parentElement)
      if (at instanceof HTMLDetailsElement && !at.open) at.open = true;
    if (element) {
      const rect = range.getBoundingClientRect();
      bringIntoView(element, rect.top, rect.bottom);
    }
  }
}

/**
 * Finds the words in the shown entry anew. `keep` keeps the current match
 * where it still is (a revision, a new message, a tab switch); otherwise it
 * starts at the first match. `reveal` brings the current match into sight.
 */
async function run(keep: boolean, reveal: boolean): Promise<void> {
  const from = ++generation;
  const stepsBefore = steps;
  following?.disconnect();
  following = null;
  const { open, words } = useCardFind.getState();
  const entry = shownStageEntry();
  if (!open || !entry || !words.trim()) {
    revealing = false;
    parts = [];
    clearWindow();
    clearFrames();
    useCardFind.setState({ total: 0, current: 0, found: words });
    return;
  }
  const found = await collect(entry, words, from);
  if (!found || from !== generation) return;
  parts = found;
  lastMark.clear();
  clearFrames(new Set(found.flatMap((part) => (part.kind === "frame" ? [part.frame] : []))));
  const total = found.reduce((sum, part) => sum + countOf(part), 0);
  const { current } = useCardFind.getState();
  const at = total === 0 ? 0 : keep ? Math.min(current, total - 1) : 0;
  useCardFind.setState({ total, current: at, found: words });
  // A step taken while this read was out went to a page's older read, which
  // could not mark it: this read brings it into sight.
  paint(at, reveal || steps !== stepsBefore, from);
}

/**
 * Drops the matches found so far at once: nothing counted, lit, stepped to
 * or still to be brought into sight is left of them. The words stay.
 */
function dropFound(): void {
  generation += 1;
  following?.disconnect();
  following = null;
  revealing = false;
  parts = [];
  clearWindow();
  clearFrames();
  useCardFind.setState({ total: 0, current: 0, found: null });
}

let pending: ReturnType<typeof setTimeout> | null = null;
/** Finds again on what is shown, keeping the current match, once a burst of changes settles. */
export function refindCard(): void {
  if (!useCardFind.getState().open) return;
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void run(true, revealing);
  }, 50);
}

/**
 * Opens the field on the shown entry, or selects its words when it is open
 * already. `byButton` when the magnifying glass was pressed, which takes the
 * keyboard's focus back when the field closes; otherwise focus goes back to
 * what had it before.
 */
export function openCardFind(byButton: boolean): void {
  const state = useCardFind.getState();
  if (!state.open) {
    const active = document.activeElement;
    returnTo = byButton ? "button" : active instanceof HTMLElement ? active : null;
  }
  useCardFind.setState({ open: true, focus: state.focus + 1 });
}

/** Sets the words looked for; the first match becomes current. */
export function setCardFindWords(words: string): void {
  useCardFind.setState({ words, current: 0, found: null });
}

/** The next match (1) or the previous one (-1), going round past either end. */
export function stepCardFind(direction: 1 | -1): void {
  const { open, total, current, words, found } = useCardFind.getState();
  // Matches counted for other words than the field's are never stepped to.
  if (!open || total === 0 || found !== words) return;
  const next = (current + direction + total) % total;
  steps += 1;
  useCardFind.setState({ current: next });
  paint(next, true, generation);
}

/**
 * An Escape a card's page did not use: closes Find when it is open on the
 * shown entry holding that page, before the page's Escape would do anything
 * else (docs/keyboard.md, "Finding in the shown card"). Whether it closed.
 */
export function closeCardFindFrom(frame: Element | null): boolean {
  if (!useCardFind.getState().open || !frame || !shownStageEntry()?.contains(frame)) return false;
  closeCardFind();
  return true;
}

/** Closes the field back into the magnifying glass, clears every match, and gives focus back. */
export function closeCardFind(): void {
  if (!useCardFind.getState().open) return;
  useCardFind.setState({ open: false });
  const back = returnTo;
  returnTo = null;
  requestAnimationFrame(() => {
    const button = shownStageEntry()?.querySelector<HTMLElement>("[data-card-find-button]");
    if (back !== "button" && giveFocusBack(back)) return;
    if (button) focusWithRing(button);
  });
}

/**
 * The stage's side of finding: finds again when the words change, the field
 * opens or closes, the shown entry or its tab changes, or what it shows
 * changes; and ends the finding when the stage goes.
 */
export function useCardFindStage(entryKey: string | undefined): void {
  useEffect(
    () =>
      useCardFind.subscribe((state, previous) => {
        if (state.open !== previous.open || state.words !== previous.words) void run(false, true);
      }),
    [],
  );
  // Another entry or tab: the last one's matches go before anything is
  // drawn, and its words are looked for in the new one.
  useLayoutEffect(() => {
    if (entryKey === undefined || !useCardFind.getState().open) return;
    dropFound();
    refindCard();
  }, [entryKey]);
  // A card's page the host updates in place, with a revision's words or a
  // task record's new state, is read again; a page redrawing itself on its
  // own is not.
  useEffect(
    () =>
      onFrameHostUpdate((controller) => {
        const entry = shownStageEntry();
        if (!entry || !useCardFind.getState().open) return;
        for (const frame of entry.querySelectorAll("iframe"))
          if (controllerOf(frame) === controller) return refindCard();
      }),
    [],
  );
  // Watched afresh for each shown entry, so a stage drawn anew is the one watched.
  useEffect(() => {
    if (entryKey === undefined) return;
    const presentation = document.querySelector("[data-card-presentation]");
    if (!presentation) return;
    const watch = new MutationObserver((records) => {
      const changed = records.some((record) => {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest("[data-card-find]");
      });
      if (changed) refindCard();
    });
    // A card's page is read again once it is drawn: a new revision or body redraws it.
    watch.observe(presentation, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-frame-drawn", "srcdoc"],
    });
    return () => watch.disconnect();
  }, [entryKey]);
  useEffect(
    () => () => {
      following?.disconnect();
      following = null;
      revealing = false;
      generation += 1;
      parts = [];
      clearWindow();
      clearFrames();
    },
    [],
  );
}
