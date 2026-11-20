import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { useEffect, useRef } from "react";
import { useCommandKeys } from "../app/keyHints";
import { FIND_ICON } from "../design/cards/CardFind";
import { IconButton } from "../design/core/IconButton";
import { closeCardFind, setCardFindWords, stepCardFind, useCardFind } from "./cardFind";
import "./cardFind.css";

const CHEVRON_UP = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m18 15-6-6-6 6" />
  </svg>
);
const CHEVRON_DOWN = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const CLOSE = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

/**
 * The find field (design skill `components/cards/ResponseCard.prompt.md`,
 * "Find in this card"): drawn in the shown card's head in place of its meta
 * line while finding, with the count, Previous, Next and Close. Enter goes
 * to the next match and Shift+Enter to the previous one; Esc closes it back
 * into the magnifying glass and nothing else.
 */
export function CardFindField() {
  const words = useCardFind((s) => s.words);
  const current = useCardFind((s) => s.current);
  const total = useCardFind((s) => s.total);
  const focus = useCardFind((s) => s.focus);
  // Until the field's words are counted, the count is blank and nothing steps.
  const counted = useCardFind((s) => s.found === s.words);
  const field = useRef<HTMLInputElement>(null);
  const previousKeys = useCommandKeys("cards.find-previous");
  const nextKeys = useCommandKeys("cards.find-next");
  // Each ⌘F or press of the magnifying glass puts the caret in the field with its words selected.
  useEffect(() => {
    if (focus === 0) return;
    const input = field.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [focus]);
  const count =
    !words.trim() || !counted
      ? ""
      : total === 0
        ? m.uiCardFindNone()
        : m.uiCardFindCount({ current: formatNumber(current + 1), total: formatNumber(total) });
  return (
    <span
      data-card-find=""
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        flex: 1,
        minWidth: 0,
        height: 28,
        paddingInlineStart: "var(--space-2)",
        background: "var(--surface-input)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      <span style={{ display: "flex", color: "var(--fg-3)", flexShrink: 0 }}>{FIND_ICON}</span>
      <input
        ref={field}
        data-card-find-field=""
        type="text"
        aria-label={m.uiCardFindField()}
        value={words}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setCardFindWords(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            stepCardFind(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            // One Esc closes the field and nothing else: not the card's size, not its record.
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            closeCardFind();
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          background: "transparent",
          outline: "none",
          color: "var(--fg-1)",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
          padding: 0,
        }}
      />
      <span
        data-card-find-count=""
        aria-live="polite"
        style={{
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: total === 0 && counted && words.trim() ? "var(--fg-3)" : "var(--fg-2)",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </span>
      <IconButton
        data-card-find-previous=""
        size={26}
        label={m.uiCardFindPrevious()}
        {...previousKeys}
        off={total === 0 || !counted}
        onClick={() => stepCardFind(-1)}
      >
        {CHEVRON_UP}
      </IconButton>
      <IconButton
        data-card-find-next=""
        size={26}
        label={m.uiCardFindNext()}
        {...nextKeys}
        off={total === 0 || !counted}
        onClick={() => stepCardFind(1)}
      >
        {CHEVRON_DOWN}
      </IconButton>
      <IconButton
        data-card-find-close=""
        size={26}
        label={m.uiCardFindClose()}
        keys="Esc"
        onClick={() => closeCardFind()}
      >
        {CLOSE}
      </IconButton>
    </span>
  );
}
