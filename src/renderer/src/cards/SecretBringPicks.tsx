import * as m from "@shared/i18n/messages.generated";
import type { SecretBringRow } from "@shared/secretBring";
import { useEffect, useRef, useState } from "react";
import { MicroLabel } from "../design";

/**
 * The tick rows of a bring card (docs/secrets.md, "Bringing secrets from
 * another tool"): host chrome between Infinitary's own bring card's body and
 * its buttons, one tick box per secret the Bring into Secrets button names
 * (`secretBringRows`). A row Secrets already keeps arrives unticked; one the
 * source holds as empty, too large or not text cannot be ticked. The ticks
 * stay here until Bring reads them (`readBringPicks`) and sends the ids with
 * the button's one-time pass; no value is ever here. Tab reaches the rows,
 * the arrows move between them, Space ticks and Enter brings.
 */
export function SecretBringPicks({
  cardId,
  rows,
  disabled,
  onBring,
}: {
  cardId: string;
  rows: readonly SecretBringRow[];
  disabled?: boolean;
  onBring: () => void;
}) {
  const [ticked, setTicked] = useState(
    () => new Set(rows.filter((row) => row.ticked && !row.cannot).map((row) => row.id)),
  );
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const picks = useRef(ticked);
  picks.current = ticked;
  useEffect(() => {
    const reader = () => rows.filter((row) => picks.current.has(row.id)).map((row) => row.id);
    readers.set(cardId, reader);
    return () => {
      if (readers.get(cardId) === reader) readers.delete(cardId);
    };
  }, [cardId, rows]);
  const open = rows.filter((row) => !row.cannot);
  return (
    <fieldset
      data-secret-bring={cardId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        minWidth: 0,
        margin: 0,
        padding: 0,
        border: "none",
      }}
    >
      <legend style={{ padding: 0, marginBottom: "var(--space-1)" }}>
        <MicroLabel>{m.secretsBringPicks()}</MicroLabel>
      </legend>
      {rows.map((row) => {
        const note = row.cannot
          ? CANNOT[row.cannot]()
          : row.replaces
            ? m.secretsBringReplaces({ version: String(row.replaces.version) })
            : null;
        return (
          <label
            key={row.id}
            htmlFor={`secret-bring-${cardId}-${row.id}`}
            style={{
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              alignItems: "baseline",
              columnGap: "var(--space-2)",
              fontSize: "var(--text-sm)",
              minWidth: 0,
              color: row.cannot ? "var(--fg-3)" : "var(--fg-1)",
            }}
          >
            <input
              id={`secret-bring-${cardId}-${row.id}`}
              data-secret-bring-row={row.id}
              type="checkbox"
              ref={(element) => {
                if (element) boxes.current.set(row.id, element);
                else boxes.current.delete(row.id);
              }}
              checked={ticked.has(row.id)}
              disabled={disabled || Boolean(row.cannot)}
              onChange={(event) => {
                const next = new Set(ticked);
                if (event.target.checked) next.add(row.id);
                else next.delete(row.id);
                setTicked(next);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  onBring();
                  return;
                }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const at = open.findIndex((one) => one.id === row.id);
                const next = open[at + (event.key === "ArrowDown" ? 1 : -1)];
                if (next) boxes.current.get(next.id)?.focus();
              }}
            />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <span style={{ fontFamily: "var(--font-mono)" }}>{row.name}</span>
              {row.place ? (
                <span style={{ color: "var(--fg-3)" }}>
                  {" · "}
                  {row.place}
                </span>
              ) : null}
              {note ? (
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-xs)",
                    color: "var(--fg-3)",
                  }}
                >
                  {note}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
      <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {m.secretsBringNote()}
      </p>
    </fieldset>
  );
}

/** Why a row cannot be ticked, in the person's language. */
const CANNOT: Record<NonNullable<SecretBringRow["cannot"]>, () => string> = {
  empty: m.secretsBringCannotEmpty,
  "too-large": m.secretsBringCannotTooLarge,
  "not-text": m.secretsBringCannotNotText,
};

/** The drawn tick rows, by card id: only Bring reads them. */
const readers = new Map<string, () => string[]>();

/** The ids of the rows ticked on a card now; undefined where none are drawn. */
export function readBringPicks(cardId: string): string[] | undefined {
  return readers.get(cardId)?.();
}
