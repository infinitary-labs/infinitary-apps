import { fileSizeWords } from "@shared/attachments";
import type { CardFile, SavedCardFiles } from "@shared/cardFiles";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, MicroLabel } from "../design";
import {
  CARD_FILE_WORDS,
  cardFileInFolderWords,
  cardFileMissingWords,
  cardFileNotSavedWords,
  cardFileRevealedWords,
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
      key={`${cardId} ${files.map((file) => file.id).join(" ")}`}
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
  const [saved, setSaved] = useState<SavedCardFiles | null>(null);
  const [pending, setPending] = useState<{ id: string | null; saving: boolean } | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const ids = files.map((file) => file.id);
  // The keyed list remounts when the card or its file IDs change.
  useEffect(() => {
    let live = true;
    window.infinitary.cards
      .savedFiles(
        cardId,
        files.map((file) => file.id),
      )
      .then(
        (snapshot) => {
          if (live) setSaved(snapshot);
        },
        () => {
          if (live) setSaved({ files: [], batch: null });
        },
      );
    return () => {
      live = false;
    };
  }, [cardId, files]);
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
  const act = async (id: string | null, opening: boolean, name: string) => {
    const key = id ?? "";
    const api = window.infinitary.cards;
    const tell = (line: string) => setNotices((was) => ({ ...was, [key]: line }));
    setPending({ id, saving: !opening });
    tell("");
    try {
      if (opening) {
        const result = await api.openSavedFile(cardId, id);
        if (result === "missing") {
          setSaved(await api.savedFiles(cardId, ids));
          tell(cardFileMissingWords(name));
        } else if (result === "revealed") {
          tell(cardFileRevealedWords(name));
        } else if (result === "failed") {
          tell(CARD_FILE_WORDS.openFailed);
        }
      } else if (id === null) {
        await api.saveFiles(cardId, ids, folderName);
        setSaved(await api.savedFiles(cardId, ids));
        setNotices({});
      } else {
        await api.saveFile(cardId, id);
        setSaved(await api.savedFiles(cardId, ids));
      }
    } catch (error) {
      tell(
        opening
          ? CARD_FILE_WORDS.openFailed
          : error instanceof Error && error.message
            ? error.message
            : cardFileNotSavedWords(name),
      );
    } finally {
      setPending(null);
    }
  };
  const busy = saved === null || pending !== null;
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
        {shown.map((file) => {
          const entry = saved?.files.find(({ id }) => id === file.id);
          return (
            <CardFileStrip
              key={file.id}
              file={file}
              saved={entry}
              saving={pending?.id === file.id && pending.saving}
              busy={busy}
              notice={notices[file.id]}
              onPress={() => void act(file.id, !!entry, entry?.savedAs ?? file.name)}
            />
          );
        })}
      </div>
      {folds && (
        <CardFilesCount
          files={files}
          hidden={open ? 0 : files.length - SHOWN_FOLDED}
          open={open}
          saved={saved?.batch}
          saving={pending?.id === null && pending.saving}
          notice={notices[""]}
          busy={busy}
          onToggle={() => setOpen((was) => !was)}
          onPress={() => void act(null, !!saved?.batch, saved?.batch?.savedAs ?? folderName)}
        />
      )}
    </div>
  );
}

/** The counting row under a folded or opened file list. */
function CardFilesCount({
  files,
  hidden,
  open,
  saved,
  saving,
  busy,
  notice,
  onToggle,
  onPress,
}: {
  files: readonly CardFile[];
  hidden: number;
  open: boolean;
  saved: SavedCardFiles["batch"] | undefined;
  saving: boolean;
  busy: boolean;
  notice?: string;
  onToggle: () => void;
  onPress: () => void;
}) {
  const counted = open ? files : files.slice(files.length - hidden);
  const bytes = counted.reduce((sum, file) => sum + file.bytes, 0);
  const count = open ? cardFilesAllWords(files.length) : cardFilesMoreWords(hidden);
  const failed = saved?.failed[0];
  const problem =
    notice ||
    (saved && failed
      ? cardFilesPartlySavedWords({
          saved: saved.saved,
          total: saved.saved + saved.failed.length,
          folder: saved.savedAs,
          name: files.find((file) => file.id === failed.id)?.name ?? failed.id,
          why: failed.why,
        })
      : null);
  const line = problem || (saved ? cardFilesSavedAllWords(saved.savedAs) : null);
  return (
    <div
      data-card-files-count=""
      data-card-files-save-state={saving ? "saving" : saved ? "saved" : notice ? "refused" : "idle"}
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
        off={busy}
        onClick={onPress}
      >
        {saving
          ? CARD_FILE_WORDS.saving
          : saved
            ? CARD_FILE_WORDS.openFolder
            : CARD_FILE_WORDS.saveAll}
      </Button>
    </div>
  );
}

/** The same host button stays focused when Save becomes Open. */
function CardFileStrip({
  file,
  saved,
  saving,
  busy,
  notice,
  onPress,
}: {
  file: CardFile;
  saved?: SavedCardFiles["files"][number];
  saving: boolean;
  busy: boolean;
  notice?: string;
  onPress: () => void;
}) {
  const detail =
    saved &&
    (saved.folder ? cardFileInFolderWords(saved.folder) : cardFileSavedWords(saved.savedAs));
  return (
    <div
      data-card-file={file.id}
      data-card-file-state={saving ? "saving" : saved ? "saved" : notice ? "refused" : "idle"}
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
        title={notice || (detail ? `${file.name} · ${detail}` : file.name)}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: notice ? "var(--fg-2)" : "var(--fg-3)",
        }}
      >
        {notice || (
          <>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
              {file.name}
            </span>{" "}
            · {fileSizeWords(file.bytes)}
            {detail ? ` · ${detail}` : null}
          </>
        )}
      </span>
      <Button variant="secondary" size="sm" style={{ flexShrink: 0 }} off={busy} onClick={onPress}>
        {saving ? CARD_FILE_WORDS.saving : saved ? CARD_FILE_WORDS.open : CARD_FILE_WORDS.save}
      </Button>
    </div>
  );
}
