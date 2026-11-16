import { fileSizeWords } from "@shared/attachments";
import type { CardFile, CardFilesSaved } from "@shared/cardFiles";
import { useLayoutEffect, useRef, useState } from "react";
import { Button, MicroLabel } from "../design";
import {
  CARD_FILE_WORDS,
  cardFileNotSavedWords,
  cardFileSavedWords,
  cardFilesAllWords,
  cardFilesMoreWords,
  cardFilesPartlySavedWords,
  cardFilesSavedAllWords,
} from "./cardFileWords";

/**
 * How many rows a card's files fold to: up to `FOLD_AT` files show one row
 * each; more show the first `SHOWN_FOLDED`, then one counting row for the
 * rest, so the folded strip is never taller than four rows (INF-4427's
 * plan, direction A, as the captain approved it).
 */
const FOLD_AT = 4;
const SHOWN_FOLDED = 3;
/** Rows the open list shows before it scrolls. */
const OPEN_ROWS = 6;

/**
 * A card's files for the captain (docs/card-authoring.md, "Files for the
 * captain"; the design skill's ResponseCard, "Files for the captain"): one
 * row of host chrome per file between the body and the buttons - its name,
 * its size and Save. The card holds only a reference: Save asks this
 * window's own process to read the file from wherever its kept copy is and
 * save it into this computer's Downloads, so the bytes move only on that
 * click. It is never a card action: it answers nothing and runs no effect,
 * and the body's frame never sees it.
 *
 * Five or more files fold: the first three in the crewmate's order, then a
 * counting row with Show all and Save all. Show all opens every row in a
 * list that scrolls after six; the counting row stays below it with Show
 * fewer. Save all saves every file into one new folder in Downloads named
 * `folderName`, the task's title. A revision's new list folds again.
 */
export function CardFiles({
  cardId,
  files,
  folderName,
}: {
  cardId: string;
  files: readonly CardFile[];
  folderName: string;
}) {
  // A revision's list is a new list: it folds again from its own count.
  return (
    <CardFileList
      key={files.map((file) => file.id).join(" ")}
      cardId={cardId}
      files={files}
      folderName={folderName}
    />
  );
}

function CardFileList({
  cardId,
  files,
  folderName,
}: {
  cardId: string;
  files: readonly CardFile[];
  folderName: string;
}) {
  const [open, setOpen] = useState(false);
  const [savingAll, setSavingAll] = useState<CardFilesSaving>({ state: "idle" });
  const list = useRef<HTMLDivElement>(null);
  const folds = files.length > FOLD_AT;
  const shown = folds && !open ? files.slice(0, SHOWN_FOLDED) : files;
  // The open list stops growing at its sixth row, measured from the rows
  // themselves so it follows the type size, and scrolls past it.
  useLayoutEffect(() => {
    const box = list.current;
    if (!box) return;
    const rows = box.children;
    if (!open || rows.length <= OPEN_ROWS) {
      box.style.maxHeight = "";
      return;
    }
    const first = (rows[0] as HTMLElement).offsetTop;
    const last = rows[OPEN_ROWS - 1] as HTMLElement;
    const padding = Number.parseFloat(getComputedStyle(box).paddingBlockEnd) || 0;
    box.style.maxHeight = `${last.offsetTop + last.offsetHeight - first + 2 * padding}px`;
  }, [open]);
  const saveAll = () => {
    setSavingAll({ state: "saving" });
    window.infinitary.cards
      .saveFiles(
        cardId,
        files.map((file) => file.id),
        folderName,
      )
      .then(
        (saved) => setSavingAll({ state: "saved", saved }),
        (caught: unknown) =>
          setSavingAll({
            state: "refused",
            why:
              caught instanceof Error && caught.message
                ? caught.message
                : cardFileNotSavedWords(folderName),
          }),
      );
  };
  return (
    <div
      data-card-files={folds ? (open ? "open" : "folded") : "whole"}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 }}
    >
      <div
        ref={list}
        data-card-files-list=""
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
          minWidth: 0,
          ...(open
            ? {
                overflowY: "auto",
                // Room inside the scroller for a Save's focus ring, which it would cut.
                padding: "var(--space-1)",
                margin: "calc(-1 * var(--space-1))",
              }
            : {}),
        }}
      >
        {shown.map((file) => (
          <CardFileRow key={file.id} cardId={cardId} file={file} />
        ))}
      </div>
      {folds && (
        <CardFilesCount
          files={files}
          hidden={open ? 0 : files.length - SHOWN_FOLDED}
          open={open}
          saving={savingAll}
          onToggle={() => setOpen((was) => !was)}
          onSaveAll={saveAll}
        />
      )}
    </div>
  );
}

/** Where Save all stands: not asked, saving, saved (all or some), or why the folder was not made. */
export type CardFilesSaving =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; saved: CardFilesSaved }
  | { state: "refused"; why: string };

/**
 * The counting row under a folded or opened list: how many files the fold
 * hides (or how many there are, open) and their size, then Show all or Show
 * fewer and Save all.
 */
export function CardFilesCount({
  files,
  hidden,
  open,
  saving,
  onToggle,
  onSaveAll,
}: {
  files: readonly Pick<CardFile, "id" | "name" | "bytes">[];
  hidden: number;
  open: boolean;
  saving: CardFilesSaving;
  onToggle: () => void;
  onSaveAll: () => void;
}) {
  const counted = open ? files : files.slice(files.length - hidden);
  const bytes = counted.reduce((sum, file) => sum + file.bytes, 0);
  const count = open ? cardFilesAllWords(files.length) : cardFilesMoreWords(hidden);
  const problem =
    saving.state === "refused"
      ? saving.why
      : saving.state === "saved" && saving.saved.failed.length > 0
        ? (() => {
            const failed = saving.saved.failed[0] as CardFilesSaved["failed"][number];
            return cardFilesPartlySavedWords({
              saved: saving.saved.saved,
              total: saving.saved.saved + saving.saved.failed.length,
              folder: saving.saved.savedAs,
              name: files.find((file) => file.id === failed.id)?.name ?? failed.id,
              why: failed.why,
            });
          })()
        : null;
  // Once saved, the line names the folder in place of the count, so a long task title still shows.
  const savedIn =
    saving.state === "saved" && !problem ? cardFilesSavedAllWords(saving.saved.savedAs) : null;
  const line = problem ?? savedIn;
  return (
    <div
      data-card-files-count=""
      data-card-files-save-state={saving.state}
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
        data-card-files-count-line=""
        title={line ?? undefined}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: problem ? "var(--fg-2)" : "var(--fg-3)",
        }}
      >
        {line ?? (
          <>
            <span style={{ color: "var(--fg-1)" }}>{count}</span> · {fileSizeWords(bytes)}
          </>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        style={{ flexShrink: 0 }}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? CARD_FILE_WORDS.showFewer : CARD_FILE_WORDS.showAll}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        style={{ flexShrink: 0 }}
        // Off, not disabled, while it saves: it keeps the focus a key press gave it.
        off={saving.state === "saving"}
        onClick={onSaveAll}
      >
        {saving.state === "saving" ? CARD_FILE_WORDS.saving : CARD_FILE_WORDS.saveAll}
      </Button>
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
