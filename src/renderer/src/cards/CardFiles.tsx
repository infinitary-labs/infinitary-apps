import { fileSizeWords } from "@shared/attachments";
import type { CardFile } from "@shared/cardFiles";
import { useState } from "react";
import { Button, MicroLabel } from "../design";
import { CARD_FILE_WORDS, cardFileNotSavedWords, cardFileSavedWords } from "./cardFileWords";

/**
 * A card's files for the captain (docs/card-authoring.md, "Files for the
 * captain"; the design skill's ResponseCard, "Files for the captain"): one
 * row of host chrome per file between the body and the buttons - its name,
 * its size and Save. The card holds only a reference: Save asks this
 * window's own process to read the file from wherever its kept copy is and
 * save it into this computer's Downloads, so the bytes move only on that
 * click. It is never a card action: it answers nothing and runs no effect,
 * and the body's frame never sees it.
 */
export function CardFiles({ cardId, files }: { cardId: string; files: readonly CardFile[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}>
      {files.map((file) => (
        <CardFileRow key={file.id} cardId={cardId} file={file} />
      ))}
    </div>
  );
}

/** Where one row's Save stands: not asked, saving, saved under a name, or why it was not. */
export type CardFileSaving =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; savedAs: string }
  | { state: "refused"; why: string };

function CardFileRow({ cardId, file }: { cardId: string; file: CardFile }) {
  const [saving, setSaving] = useState<CardFileSaving>({ state: "idle" });
  const save = () => {
    setSaving({ state: "saving" });
    window.infinitary.cards.saveFile(cardId, file.id).then(
      (saved) => setSaving({ state: "saved", savedAs: saved.savedAs }),
      (caught: unknown) =>
        setSaving({
          state: "refused",
          why:
            caught instanceof Error && caught.message
              ? caught.message
              : cardFileNotSavedWords(file.name),
        }),
    );
  };
  return <CardFileStrip file={file} saving={saving} onSave={save} />;
}

/** The row itself, drawn from where its Save stands. */
export function CardFileStrip({
  file,
  saving,
  onSave,
}: {
  file: Pick<CardFile, "id" | "name" | "bytes">;
  saving: CardFileSaving;
  onSave: () => void;
}) {
  const refused = saving.state === "refused" ? saving.why : null;
  return (
    <div
      data-card-file={file.id}
      data-card-file-state={saving.state}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
        fontSize: "var(--text-xs)",
      }}
    >
      <MicroLabel style={{ flexShrink: 0 }}>{CARD_FILE_WORDS.label}</MicroLabel>
      <span
        data-card-file-line=""
        title={refused ?? file.name}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: refused ? "var(--fg-2)" : "var(--fg-3)",
        }}
      >
        {refused ?? (
          <>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
              {file.name}
            </span>{" "}
            · {fileSizeWords(file.bytes)}
            {saving.state === "saved" ? ` · ${cardFileSavedWords(saving.savedAs)}` : null}
          </>
        )}
      </span>
      <Button
        variant="secondary"
        size="sm"
        style={{ flexShrink: 0 }}
        disabled={saving.state === "saving"}
        onClick={onSave}
      >
        {saving.state === "saving" ? CARD_FILE_WORDS.saving : CARD_FILE_WORDS.save}
      </Button>
    </div>
  );
}
