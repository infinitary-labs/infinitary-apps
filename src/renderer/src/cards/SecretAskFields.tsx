import { SECRET_ASK_CARD_WORDS, type SecretAskField } from "@shared/secrets";
import type React from "react";
import { useEffect, useRef } from "react";
import { SecretField, type SecretFieldHandle } from "../design";

/**
 * The masked fields of an ask to keep a secret (docs/secrets.md, "Asking to
 * keep a secret"): host chrome between Infinitary's own ask card's body and
 * its buttons, one write-only field per secret the Save secret button names
 * (`secretKeepFields`), each under its secret's name with its place and the
 * version it replaces, at the body's measure (INF-5516's plan). The values
 * stay in these inputs alone, never in a store, a card answer or the body's
 * frame, until Save reads them (`readSecretValues`) and sends them with the
 * button's one-time pass. Tab reaches each field; Enter moves to the next
 * and, in the last, saves. Each field keeps the line breaks of a pasted key
 * (`SecretField`).
 */
export function SecretAskFields({
  cardId,
  fields,
  disabled,
  onKeep,
}: {
  cardId: string;
  fields: readonly SecretAskField[];
  disabled?: boolean;
  onKeep: () => void;
}) {
  const inputs = useRef(new Map<string, SecretFieldHandle>());
  useEffect(() => {
    const reader: SecretFieldsReader = {
      read: () =>
        fields.map((field) => ({
          field: field.id,
          value: inputs.current.get(field.id)?.value ?? "",
        })),
      clear: () => {
        for (const input of inputs.current.values()) input.value = "";
      },
    };
    readers.set(cardId, reader);
    return () => {
      if (readers.get(cardId) === reader) readers.delete(cardId);
    };
  }, [cardId, fields]);
  // A field the card no longer asks for leaves nothing behind.
  useEffect(
    () => () => {
      for (const input of inputs.current.values()) input.value = "";
    },
    [],
  );
  const words = SECRET_ASK_CARD_WORDS;
  return (
    <fieldset
      data-secret-ask={cardId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        minWidth: 0,
        // The body's measure and left edge (`secretAskBody`): the card's body
        // pads 20px and its frame one step more, 8px past this row's own pad.
        maxWidth: "44rem",
        margin: 0,
        marginInlineStart: "var(--space-2)",
        padding: "var(--space-1) 0 0",
        border: "none",
      }}
    >
      <legend style={HIDDEN}>{words.fields}</legend>
      {fields.map((field, at) => {
        const id = `secret-ask-${cardId}-${field.id}`;
        return (
          <div key={field.id} style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                columnGap: 10,
                marginBottom: 6,
                fontSize: "var(--text-sm)",
                minWidth: 0,
              }}
            >
              <label
                htmlFor={id}
                style={{ fontWeight: 500, color: "var(--fg-1)", overflowWrap: "anywhere" }}
              >
                {field.name}
              </label>
              {field.place ? (
                <span style={{ color: "var(--fg-3)", minWidth: 0, overflowWrap: "anywhere" }}>
                  {words.place(field.place)}
                </span>
              ) : null}
              {field.replaces ? (
                <span style={{ color: "var(--fg-3)" }}>
                  {words.replaces(field.replaces.version)}
                </span>
              ) : null}
            </div>
            <SecretField
              id={id}
              data-secret-ask-field={field.id}
              placeholder={words.placeholder}
              handle={(handle) => {
                if (handle) inputs.current.set(field.id, handle);
                else inputs.current.delete(field.id);
              }}
              disabled={disabled}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                const next = fields[at + 1];
                if (next) inputs.current.get(next.id)?.focus();
                else onKeep();
              }}
            />
          </div>
        );
      })}
      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {words.note(fields.length > 1)}
      </p>
    </fieldset>
  );
}

/** The fields' group name, read by a screen reader and drawn nowhere: each field's own name labels it. */
const HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

type SecretFieldsReader = {
  read: () => { field: string; value: string }[];
  clear: () => void;
};

/** The drawn ask fields, by card id: only Save reads them. */
const readers = new Map<string, SecretFieldsReader>();

/** What the captain typed into a card's ask fields, read now; undefined where none are drawn. */
export function readSecretValues(cardId: string): { field: string; value: string }[] | undefined {
  return readers.get(cardId)?.read();
}

/** Empties a card's ask fields once Infinitary kept what they held. */
export function clearSecretValues(cardId: string): void {
  readers.get(cardId)?.clear();
}
