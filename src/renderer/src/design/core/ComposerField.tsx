import { pathInsertion } from "@shared/attachments";
import { TURN_IMAGE_MAX_BYTES } from "@shared/cards";
import {
  COMPOSER_NOTICE_WORDS,
  composerCount,
  fittingHint,
  limitBand,
  normalizeLineEndings,
  shouldChip,
} from "@shared/composer";
import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ComposerHistory,
  changedRange,
  type EditKind,
  editKind,
  emptyHistory,
  type FieldState,
  noteCaret,
  recordEdit,
  redoStep,
  undoStep,
} from "./composerHistory";
import {
  enterAction,
  historyKey,
  isInsideOpenFence,
  joinKill,
  killRange,
  type MessageField,
  messageKey,
  type ShellEdit,
} from "./composerKeys";
import { isComposing, keyPress } from "./composing";
import { thisDesktop } from "./desktop";
import { installedBindings } from "./installedKeys";

export type ImageAttachment = {
  id: string;
  preview: string;
  name?: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

type ClipboardItemLike = { type: string; getAsFile: () => File | null };

/** The paste filter, pure for tests: accepted image types under the cap. */
export function acceptedImageFiles(
  items: Iterable<ClipboardItemLike> | undefined,
): Array<{ file: File; mimeType: ImageAttachment["mimeType"] }> {
  if (!items) return [];
  const accepted: Array<{ file: File; mimeType: ImageAttachment["mimeType"] }> = [];
  for (const item of items) {
    const mimeType = ACCEPTED_IMAGE_TYPES.find((accept) => accept === item.type);
    if (!mimeType) continue;
    const file = item.getAsFile();
    if (!file || file.size > TURN_IMAGE_MAX_BYTES) continue;
    accepted.push({ file, mimeType });
  }
  return accepted;
}

/** How many pictures of an accepted type in a paste are over the size cap. */
export function tooBigImageCount(items: Iterable<ClipboardItemLike> | undefined): number {
  if (!items) return 0;
  let count = 0;
  for (const item of items) {
    if (!ACCEPTED_IMAGE_TYPES.some((accept) => accept === item.type)) continue;
    const file = item.getAsFile();
    if (file && file.size > TURN_IMAGE_MAX_BYTES) count++;
  }
  return count;
}

/** One FileReader pass yields both the chip preview and the send payload. */
export function readImageAttachment(entry: {
  file: File;
  mimeType: ImageAttachment["mimeType"];
}): Promise<ImageAttachment | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!base64) return resolve(undefined);
      resolve({
        id: Math.random().toString(36).slice(2),
        preview: dataUrl,
        name: entry.file.name || entry.mimeType.slice("image/".length),
        mimeType: entry.mimeType,
        data: base64,
      });
    };
    reader.readAsDataURL(entry.file);
  });
}

/**
 * Types `text` at the caret the way a keystroke would, so the field's
 * change event and undo history both see it; falls back to replacing the
 * selection when the command is unavailable.
 */
function typeAtCaret(field: HTMLTextAreaElement, text: string): void {
  if (document.execCommand?.("insertText", false, text)) return;
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Deletes the field's selection the way a keystroke would, undoable like one. */
function deleteSelection(field: HTMLTextAreaElement): void {
  if (document.execCommand?.("delete")) return;
  field.setRangeText("", field.selectionStart, field.selectionEnd, "start");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function fieldState(field: HTMLTextAreaElement): FieldState {
  return { value: field.value, start: field.selectionStart, end: field.selectionEnd };
}

/**
 * An edit the field makes itself, which its input listener records as
 * `kind` from the state before it (`restore` is an undo or redo being shown,
 * which records nothing).
 */
let ownEdit:
  | { field: HTMLTextAreaElement; kind: EditKind | "restore"; before: FieldState }
  | undefined;

function asOwnEdit(field: HTMLTextAreaElement, kind: EditKind | "restore", edit: () => void) {
  const outer = ownEdit;
  ownEdit = { field, kind, before: fieldState(field) };
  try {
    edit();
  } finally {
    ownEdit = outer;
  }
}

/** Shows `state` in the field through the smallest edit, so the host's change event sees it. */
function showState(field: HTMLTextAreaElement, state: FieldState): void {
  const { start, end, text } = changedRange(field.value, state.value);
  asOwnEdit(field, "restore", () => {
    field.setSelectionRange(start, end);
    if (text) typeAtCaret(field, text);
    else if (start < end) deleteSelection(field);
  });
  field.setSelectionRange(state.start, state.end);
}

/**
 * The shell keys' kill buffer: what the last Ctrl+U, Ctrl+K or Ctrl+W took,
 * for Ctrl+Y in any composer field (one per window, as a shell keeps one),
 * and the field as that kill left it, so a kill straight after it joins on.
 * Memory only; never the clipboard.
 */
const killBuffer: {
  text: string;
  left?: { field: HTMLTextAreaElement; value: string; caret: number };
} = { text: "" };

/** Runs a shell edit on `field` as a step of its own; false when it had nothing to change. */
function runShellEdit(field: HTMLTextAreaElement, edit: ShellEdit): boolean {
  let changed = false;
  asOwnEdit(field, "step", () => {
    changed = shellEdit(field, edit);
  });
  return changed;
}

function shellEdit(field: HTMLTextAreaElement, edit: ShellEdit): boolean {
  if (edit === "yank") {
    if (!killBuffer.text) return false;
    typeAtCaret(field, killBuffer.text);
    return true;
  }
  const { value, selectionStart, selectionEnd } = field;
  const { start, end } = killRange(value, selectionStart, selectionEnd, edit);
  if (start >= end) return false;
  const left = killBuffer.left;
  const continues =
    selectionStart === selectionEnd &&
    left?.field === field &&
    left.value === value &&
    left.caret === selectionStart;
  killBuffer.text = joinKill(killBuffer.text, value.slice(start, end), edit, continues);
  field.setSelectionRange(start, end);
  deleteSelection(field);
  killBuffer.left = { field, value: field.value, caret: field.selectionStart };
  return true;
}

/**
 * Types file paths into `field` at its caret as an ordinary edit (undoable
 * like typing), one per line and set apart from the words around them.
 * False when the field is gone or disabled; the caller then keeps the paths
 * in its draft some other way.
 */
export function typePathsInto(
  field: HTMLTextAreaElement | null,
  paths: readonly string[],
): boolean {
  if (!field?.isConnected || field.disabled || field.readOnly) return false;
  field.focus();
  const insertion = pathInsertion(field.value, field.selectionStart, field.selectionEnd, paths);
  if (insertion) asOwnEdit(field, "step", () => typeAtCaret(field, insertion));
  return true;
}

/** Read by a screen reader, drawn nowhere. */
const unseen: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/** One canvas measures every hint, in the field's own font. */
let ruler: OffscreenCanvasRenderingContext2D | null | undefined;

/** How wide a line of text sets in `style`'s font; undefined where nothing can measure. */
function lineWidthIn(style: CSSStyleDeclaration): ((text: string) => number) | undefined {
  ruler ??=
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  const context = ruler;
  if (!context) return undefined;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => context.measureText(text).width;
}

export type ComposerFieldProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "rows" | "onPaste" | "style" | "placeholder"
> & {
  value: string;
  /**
   * The empty field's hint. A list is one hint's forms, fullest first: the
   * field shows the first that fits its one line, else the last.
   */
  placeholder?: string | readonly string[];
  /** The underlying textarea, for a host that focuses or reads it. */
  fieldRef?: React.Ref<HTMLTextAreaElement>;
  /** The field stops growing at this many lines, then scrolls inside. */
  lineCap: number;
  /**
   * An ancestor that must stay within `frameMaxHeight`: the field gives up
   * whatever the ancestor's other rows take. Attach it with an object ref or
   * a stable callback: an inline callback ref is detached on every commit
   * and set again only after the field has measured.
   */
  frame?: React.RefObject<HTMLElement | null>;
  frameMaxHeight?: number;
  /** Which message field this is, for the keys it owns (`messageKey`, docs/keyboard.md). */
  messageField: MessageField;
  /** Recording: every Enter does nothing. */
  recording?: boolean;
  /** Whether a send does anything now: something to send, within the limit. */
  canSend: boolean;
  onSend?: () => void;
  /** Any key the field did not take for itself, and every line it added. */
  onKeystroke?: () => void;
  /** Up or Ctrl+P in an empty field: bring back the last message sent. */
  onRecall?: () => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Pasted pictures of an accepted type under the size cap, read. */
  onAttach?: (items: ImageAttachment[]) => void;
  /** A pasted picture over the size cap, which is never attached. */
  onPictureTooBig?: () => void;
  /** A paste long enough to become a chip (`shouldChip`), exact clipboard text. */
  onPasteText?: (text: string) => void;
  /** Where the caret is, reported as it moves. */
  onCaretChange?: (caret: number) => void;
  /** The draft is one line of words that wraps onto more. */
  onWrapChange?: (wrapped: boolean) => void;
  /** The caret moved into or out of an open ``` block. */
  onFenceChange?: (inFence: boolean) => void;
  /** Size, color and padding; the field grows by its content height, whatever its padding. */
  style?: React.CSSProperties;
};

/**
 * The composer's field (`docs/composer.md`), shared by the task prompt and a
 * card's reply row: a textarea that grows one line at a time to its cap and
 * then scrolls, decides every Enter through `enterAction` (so a line is only
 * ever added on purpose, and an input method's Enter neither sends nor adds
 * one), runs the shell keys' kills and yank itself (`messageKey`), and takes
 * a paste as pictures, a chip, or text with its line breaks made `\n`. The
 * shell around it - border, chips, send control - is the host's.
 */
export function ComposerField({
  value,
  fieldRef,
  lineCap,
  frame,
  frameMaxHeight,
  messageField,
  recording = false,
  canSend,
  onSend,
  onKeystroke,
  onRecall,
  onPaste,
  onAttach,
  onPictureTooBig,
  onPasteText,
  onCaretChange,
  onWrapChange,
  onFenceChange,
  style,
  onKeyDown,
  onSelect,
  onBlur,
  placeholder,
  ...rest
}: ComposerFieldProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const hints = typeof placeholder === "string" ? [placeholder] : (placeholder ?? []);
  const [fitted, setFitted] = useState<string>();
  const hint = fitted !== undefined && hints.includes(fitted) ? fitted : hints[0];
  // Held read-only by its host (a reply while it sends): the field keeps the
  // focus and its words, and takes nothing in - no line, no recall, no paste.
  // Recording's own read-only still takes pastes, which ride the turn.
  const held = rest.readOnly === true;
  const said = useRef<{ wrapped?: boolean; inFence?: boolean }>({});
  const report = (next: { wrapped?: boolean; inFence?: boolean }) => {
    if (next.wrapped !== undefined && next.wrapped !== said.current.wrapped) {
      said.current.wrapped = next.wrapped;
      onWrapChange?.(next.wrapped);
    }
    if (next.inFence !== undefined && next.inFence !== said.current.inFence) {
      said.current.inFence = next.inFence;
      onFenceChange?.(next.inFence);
    }
  };

  // Grow with the draft: one line at a time up to the cap, then scroll. An
  // empty field is one line, whatever its placeholder would wrap to, so it
  // shows the fullest form of its hint that fits that line. Measured only
  // when the text, width, cap or font changes, once before paint.
  const measured = useRef("");
  const metrics = useRef<{
    width: number;
    line: number;
    padX: number;
    padY: number;
    widthOf?: (text: string) => number;
  } | null>(null);
  const measure = () => {
    const field = own.current;
    if (!field) return;
    const width = field.clientWidth;
    let cached = metrics.current;
    if (!cached || cached.width !== width) {
      const style = getComputedStyle(field);
      const line = Number.parseFloat(style.lineHeight);
      cached = {
        width,
        line,
        padX: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
        padY: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
        widthOf: hints.length > 1 ? lineWidthIn(style) : undefined,
      };
      metrics.current = cached;
    }
    const shown = field.value === "" && width > 0;
    if (cached.widthOf && shown) {
      const next = fittingHint(hints, Math.max(0, width - cached.padX), cached.widthOf);
      if (next !== hint) setFitted(next);
    }
    const line = cached.line;
    if (!Number.isFinite(line) || line <= 0) return;
    const key = `${field.value}\0${width}\0${lineCap}\0${frameMaxHeight ?? ""}\0${recording}`;
    if (key === measured.current && field.style.height !== "" && field.style.height !== "auto")
      return;
    measured.current = key;
    // Setting height to auto moves the caret. Put it back, or Enter inside a
    // code block reads the start of the draft and sends it.
    const start = field.selectionStart;
    const end = field.selectionEnd;
    field.style.height = "auto";
    // scrollHeight counts the field's vertical padding; style.height does not.
    const content = field.value ? field.scrollHeight - cached.padY : line;
    const outer = frame?.current;
    let room = Number.POSITIVE_INFINITY;
    if (outer && frameMaxHeight !== undefined) {
      const chrome = outer.getBoundingClientRect().height - field.getBoundingClientRect().height;
      // The height set below leaves out the field's own padding, which the frame still holds.
      room = frameMaxHeight - chrome - cached.padY;
    }
    const cap = Math.max(line, Math.min(lineCap * line, room));
    field.style.height = `${Math.max(line, Math.min(content, cap))}px`;
    field.style.overflowY = content > cap + 1 ? "auto" : "hidden";
    if (document.activeElement === field && start !== null && end !== null)
      field.setSelectionRange(start, end);
    report({
      wrapped: field.value !== "" && !field.value.includes("\n") && content > line * 1.5,
      // A draft replaced from outside (sent, recalled, a transcript) moves
      // no caret event, so the code-block state is re-read with the text.
      inFence: isInsideOpenFence(field.value, field.selectionStart),
    });
  };
  const measureNow = useRef(measure);
  measureNow.current = measure;
  const hintKey = hints.join("\0");
  useLayoutEffect(() => {
    metrics.current = null;
    measured.current = "";
    if (hintKey.length >= 0) measureNow.current();
  }, [hintKey]);
  useLayoutEffect(() => {
    if (`${value}:${lineCap}:${frameMaxHeight ?? ""}:${recording}` === measured.current) return;
    measureNow.current();
  }, [value, lineCap, frameMaxHeight, recording]);

  // The field's own undo history (docs/composer.md, "Undo"): every edit is
  // recorded as it lands, and Cmd+Z and Cmd+Shift+Z, from the keys or the
  // Edit menu, step through it instead of the platform's.
  const history = useRef<ComposerHistory>(emptyHistory);
  // The field as the last edit left it, and as it stood before the edit
  // the platform is about to make.
  const known = useRef<FieldState>({ value, start: value.length, end: value.length });
  const pending = useRef<FieldState | undefined>(undefined);

  // A draft replaced from outside (sent, recalled, a transcript) starts a
  // new history: nothing before it comes back.
  useLayoutEffect(() => {
    const field = own.current;
    if (!field || field.value === known.current.value) return;
    history.current = emptyHistory;
    known.current = fieldState(field);
  });

  /** One step back or forward through the field's history; nothing in a held field. */
  const stepHistory = (field: HTMLTextAreaElement, direction: "undo" | "redo") => {
    if (field.readOnly || field.disabled) return;
    const step = (direction === "undo" ? undoStep : redoStep)(history.current, fieldState(field));
    if (!step) return;
    showState(field, step.state);
    history.current = step.history;
  };
  const stepHistoryNow = useRef(stepHistory);
  stepHistoryNow.current = stepHistory;

  useEffect(() => {
    const field = own.current;
    if (!field) return;
    // The keys are the field's own (`handleKeyDown`); this is the Edit menu.
    const beforeInput = (event: InputEvent) => {
      const back = event.inputType === "historyUndo";
      if (!back && event.inputType !== "historyRedo") {
        pending.current = fieldState(field);
        return;
      }
      if (event.isComposing) return;
      event.preventDefault();
      stepHistoryNow.current(field, back ? "undo" : "redo");
    };
    const input = (event: Event) => {
      const after = fieldState(field);
      const made = ownEdit?.field === field ? ownEdit : undefined;
      if (made?.kind !== "restore") {
        const kind = made?.kind ?? editKind(event instanceof InputEvent ? event.inputType : "");
        const before = made?.before ?? pending.current ?? known.current;
        history.current = recordEdit(history.current, before, after, kind);
      }
      pending.current = undefined;
      known.current = after;
    };
    field.addEventListener("beforeinput", beforeInput);
    field.addEventListener("input", input);
    return () => {
      field.removeEventListener("beforeinput", beforeInput);
      field.removeEventListener("input", input);
    };
  }, []);

  // A width the host never re-rendered for (a card resized with the window)
  // re-wraps the text, so the width is watched too.
  useEffect(() => {
    const field = own.current;
    if (!field || typeof ResizeObserver === "undefined") return;
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = field.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      measureNow.current();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  // A hint measured before the field's font arrived is measured again once it has.
  useEffect(() => {
    const remeasure = () => measureNow.current();
    document.fonts.addEventListener("loadingdone", remeasure);
    return () => document.fonts.removeEventListener("loadingdone", remeasure);
  }, []);

  const setField = (field: HTMLTextAreaElement | null) => {
    own.current = field;
    if (typeof fieldRef === "function") fieldRef(field);
    else if (fieldRef) fieldRef.current = field;
  };
  const reportCaret = (field: HTMLTextAreaElement) => {
    history.current = noteCaret(history.current, field.selectionStart, field.selectionEnd);
    onCaretChange?.(field.selectionEnd);
    report({ inFence: isInsideOpenFence(field.value, field.selectionStart) });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste?.(e);
    if (held) {
      e.preventDefault();
      return;
    }
    if (onAttach) {
      if (tooBigImageCount(e.clipboardData?.items) > 0) onPictureTooBig?.();
      const files = acceptedImageFiles(e.clipboardData?.items);
      if (files.length > 0) {
        // Image paste becomes an attachment, never input text.
        e.preventDefault();
        void Promise.all(files.map(readImageAttachment)).then((read) => {
          const items = read.filter((item) => item !== undefined);
          if (items.length > 0) onAttach(items);
        });
        return;
      }
    }
    const pasted = e.clipboardData?.getData("text/plain") ?? "";
    if (!pasted) return;
    const normalized = normalizeLineEndings(pasted);
    if (onPasteText && normalized.trim() && shouldChip(normalized)) {
      e.preventDefault();
      onPasteText(pasted);
      return;
    }
    if (normalized !== pasted) {
      e.preventDefault();
      const field = e.currentTarget;
      asOwnEdit(field, "step", () => typeAtCaret(field, normalized));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const field = e.currentTarget;
    if (e.key === "Enter") {
      // Every Enter is handled here, never by the platform's default, so a
      // line is only ever added on purpose (docs/composer.md, "Keys").
      e.preventDefault();
      const action = enterAction({
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        composing: isComposing(e),
        inFence: isInsideOpenFence(field.value, field.selectionStart),
        recording: recording || held,
        repeat: e.repeat,
      });
      if (action === "newline") {
        asOwnEdit(field, "line", () => typeAtCaret(field, "\n"));
        onKeystroke?.();
      } else if (action === "send" && canSend) {
        onSend?.();
      }
      return;
    }
    const press = keyPress(e);
    const direction = historyKey(press, thisDesktop().keys);
    if (direction) {
      // The platform's own redo never reaches the page while its history
      // is empty, so both keys are the field's (docs/composer.md, "Undo").
      e.preventDefault();
      stepHistory(field, direction);
      return;
    }
    const owned = messageKey(press, messageField, installedBindings());
    if (owned && owned !== "recall" && !field.readOnly && !field.disabled) {
      // The shell keys (docs/composer.md, "Shell keys") are the field's own:
      // the platform has no Ctrl+U or Ctrl+W, and no Ctrl+Y that works.
      e.preventDefault();
      if (runShellEdit(field, owned)) onKeystroke?.();
      return;
    }
    if (owned === "recall" && !recording && !held && value === "" && onRecall) {
      e.preventDefault();
      onRecall();
      return;
    }
    onKeystroke?.();
  };

  return (
    <textarea
      {...rest}
      ref={setField}
      rows={1}
      value={value}
      placeholder={hint}
      readOnly={recording || rest.readOnly}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onSelect={(e) => {
        reportCaret(e.currentTarget);
        onSelect?.(e);
      }}
      onBlur={(e) => {
        reportCaret(e.currentTarget);
        onBlur?.(e);
      }}
      style={{
        display: "block",
        minWidth: 0,
        resize: "none",
        overflowY: "hidden",
        background: "transparent",
        border: "none",
        outline: "none",
        // The surrounding message shell draws focus, not the textarea.
        boxShadow: "none",
        fontFamily: "var(--font-ui)",
        color: "var(--fg-1)",
        textAlign: "left",
        ...style,
      }}
    />
  );
}

/**
 * A draft against its send limit: the mono count from 80% of it, `--warn`
 * past it (`limitBand`). Nothing below 80%.
 */
export function ComposerCount({ length, max }: { length: number; max: number }) {
  const band = limitBand(length, max);
  if (band === "none") return null;
  return (
    <span
      data-composer-count={band}
      aria-hidden="true"
      style={{
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: band === "over" ? "var(--warn)" : "var(--fg-3)",
      }}
    >
      {composerCount(length, max)}
    </span>
  );
}

/**
 * What a screen reader hears of the count: said when it appears and when it
 * crosses the limit, never on every keystroke - the live text changes only
 * then.
 */
export function ComposerCountAnnouncer({ length, max }: { length: number; max: number }) {
  const band = limitBand(length, max);
  const lengthNow = useRef(length);
  lengthNow.current = length;
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(
      band === "over"
        ? COMPOSER_NOTICE_WORDS["too-long"]
        : band === "near"
          ? composerCount(lengthNow.current, max)
          : "",
    );
  }, [band, max]);
  return (
    <span aria-live="polite" style={unseen}>
      {announced}
    </span>
  );
}
