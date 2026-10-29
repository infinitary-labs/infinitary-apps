import type React from "react";
import { useEffect, useRef } from "react";
import { Button } from "../design";
import { usePopoverPresence } from "../design/motion";
import {
  CLOSE_ANYWAY,
  CLOSE_QUESTION_TITLE,
  closeQuestionWords,
  DISCARD_AND_CLOSE,
  KEEP_ANSWERING,
  PUT_ASIDE_INSTEAD,
  unansweredReplyWords,
} from "./closeQuestionWords";

/**
 * The close is asking first: closing discards the captain's unsent picks
 * (Q3 A), or leaves his reply's answer to the record (INF-770). Asked for
 * by a key, the question takes focus. `onPutAside` puts the card aside
 * instead of closing it.
 */
export type CloseAsk = {
  onClose: () => void;
  onKeep: () => void;
  onPutAside: () => void;
  focus?: boolean;
};

/** The captain's reply is the newest line on the card's thread: who answers it, and its task. */
export type UnansweredReply = { author: string; taskKey?: string | undefined };

/** The panel's own width: room for Keep answering beside Discard and close, or Put aside instead beside Close anyway. */
const WIDTH = 296;

/**
 * The close's one question, in a popover that grows from the card's × (the
 * captain's Build it, 2026-10-04): the card's own action row never changes
 * while it asks. Escape, a click anywhere else - in the card's body too - or
 * the × again keeps the card and its picks. Unsent picks keep their words
 * and choices; an unanswered reply adds its sentence, and alone it offers
 * Put aside instead, the default, beside Close anyway (INF-770).
 */
export function CloseQuestion({
  ask,
  count,
  wrote = false,
  unanswered,
  preview,
  trigger,
}: {
  /** Present while the close is asking. */
  ask: CloseAsk | undefined;
  count: number;
  /** The Anything else? box holds words the card has not sent. */
  wrote?: boolean;
  /** The captain's reply waits on its answer. */
  unanswered?: UnansweredReply | undefined;
  preview: boolean;
  /** The card's ×, which the panel hangs from and grows out of. */
  trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const open = ask !== undefined;
  // The panel keeps its words while it fades out after an answer.
  const last = useRef({ ask, count, wrote, unanswered });
  if (ask) last.current = { ask, count, wrote, unanswered };
  const shown = last.current;
  const drawn = usePopoverPresence(open, panel, trigger);
  const keep = useRef(ask?.onKeep);
  keep.current = ask?.onKeep;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      keep.current?.();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The question owns this Escape.
      event.stopPropagation();
      keep.current?.();
      trigger.current?.focus();
    };
    // A click in a card's body never reaches this window: it takes focus
    // into that body's frame, which is a click elsewhere too.
    let later = 0;
    const onBlur = () => {
      later = window.setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) keep.current?.();
      }, 0);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(later);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, trigger]);

  const focus = ask?.focus === true;
  useEffect(() => {
    if (open && focus) panel.current?.querySelector("button")?.focus();
  }, [open, focus]);

  if (!drawn || !shown.ask) return null;
  const picks = shown.count > 0 || shown.wrote;
  const words = [
    ...(picks ? [closeQuestionWords(shown.count, preview, shown.wrote)] : []),
    ...(shown.unanswered
      ? [unansweredReplyWords(shown.unanswered.author, shown.unanswered.taskKey)]
      : []),
  ].join(" ");
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={CLOSE_QUESTION_TITLE}
      data-card-close-confirm=""
      style={{
        position: "absolute",
        top: "calc(100% + var(--space-1))",
        right: 0,
        zIndex: 4,
        width: WIDTH,
        boxSizing: "border-box",
        padding: "var(--space-3)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        textAlign: "left",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          color: "var(--fg-2)",
          lineHeight: "var(--leading-body)",
        }}
      >
        {words}
      </p>
      {picks ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button variant="secondary" size="sm" onClick={() => shown.ask?.onKeep()}>
            {KEEP_ANSWERING}
          </Button>
          <Button size="sm" onClick={() => shown.ask?.onClose()}>
            {DISCARD_AND_CLOSE}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <Button size="sm" onClick={() => shown.ask?.onPutAside()}>
            {PUT_ASIDE_INSTEAD}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => shown.ask?.onClose()}>
            {CLOSE_ANYWAY}
          </Button>
        </div>
      )}
    </div>
  );
}
