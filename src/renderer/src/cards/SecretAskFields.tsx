import * as m from "@shared/i18n/messages.generated";
import type { SecretAskField } from "@shared/secrets";
import { useEffect, useRef } from "react";
import { Input, MicroLabel } from "../design";

/**
 * The masked fields of an ask to keep a secret (docs/secrets.md, "Asking to
 * keep a secret"): host chrome between Infinitary's own ask card's body and
 * its buttons, one write-only field per secret the Keep in Secrets button
 * names (`secretKeepFields`). The values stay in these inputs alone, never
 * in a store, a card answer or the body's frame, until Keep reads them
 * (`takeSecretValues`) and sends them with the button's one-time pass. Tab
 * reaches each field; Enter moves to the next and, in the last, keeps.
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
  const inputs = useRef(new Map<string, HTMLInputElement>());
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
  return (
    <fieldset
      data-secret-ask={cardId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        minWidth: 0,
        margin: 0,
        padding: 0,
        border: "none",
      }}
    >
      <legend style={{ padding: 0, marginBottom: "var(--space-1)" }}>
        <MicroLabel>{m.secretsAskFields()}</MicroLabel>
      </legend>
      {fields.map((field, at) => (
        <label
          key={field.id}
          htmlFor={`secret-ask-${cardId}-${field.id}`}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 11rem) minmax(0, 1fr)",
            alignItems: "center",
            columnGap: "var(--space-3)",
            fontSize: "var(--text-sm)",
            minWidth: 0,
          }}
        >
          <span style={{ minWidth: 0, overflowWrap: "anywhere", color: "var(--fg-1)" }}>
            {field.name}
            {field.place ? (
              <span style={{ color: "var(--fg-3)" }}>
                {" · "}
                {field.place}
              </span>
            ) : null}
          </span>
          <Input
            id={`secret-ask-${cardId}-${field.id}`}
            data-secret-ask-field={field.id}
            ref={(element) => {
              if (element) inputs.current.set(field.id, element);
              else inputs.current.delete(field.id);
            }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const next = fields[at + 1];
              if (next) inputs.current.get(next.id)?.focus();
              else onKeep();
            }}
          />
        </label>
      ))}
      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
        {m.secretsAskNote()}
      </p>
    </fieldset>
  );
}

type SecretFieldsReader = {
  read: () => { field: string; value: string }[];
  clear: () => void;
};

/** The drawn ask fields, by card id: only Keep reads them. */
const readers = new Map<string, SecretFieldsReader>();

/** What the captain typed into a card's ask fields, read now; undefined where none are drawn. */
export function readSecretValues(cardId: string): { field: string; value: string }[] | undefined {
  return readers.get(cardId)?.read();
}

/** Empties a card's ask fields once Infinitary kept what they held. */
export function clearSecretValues(cardId: string): void {
  readers.get(cardId)?.clear();
}
