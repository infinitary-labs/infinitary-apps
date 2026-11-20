import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { type ReleaseNotesView, type ShownReleaseNote, versionName } from "@shared/releaseTracking";
import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { showReleaseNote } from "../app/shellCommands";
import { useShellStore } from "../app/store";
import { useUpdateState } from "../app/updateState";
import { Button } from "../design";
import { focusWithRing } from "../design/focus";
import { SettingRow } from "./settingRows";
import { UpdateRowControl, UpdateRowLine } from "./UpdateCheck";
import "./version.css";

/**
 * Settings → General → Version (docs/release-notes.md "Reading a note
 * again"): the version running now and every release note the app showed,
 * newest first, with three visible until Show more. Each opens its note as
 * it was shown, through the same door as What's new in the Help menu.
 * The list is one Tab stop, and ↑, ↓, Home
 * and End move through it (docs/keyboard.md, "Lists and Settings").
 * The update step's buttons sit in its control, with the update line under
 * the version (UpdateCheck.tsx). The version running is named from the
 * update status, which the row reads each time it opens, so it never waits
 * on the notes.
 */

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The day a note was shown, as the Mac writes a short date. */
export function shownOn(at: number): string {
  return formatDate(at, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Where a key moves the list's stop from `at`, or null for a key the list does not take. */
export function noteStop(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return Math.min(at + 1, count - 1);
  if (key === "ArrowUp") return Math.max(at - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function NoteRow({
  note,
  stop,
  onFocus,
}: {
  note: ShownReleaseNote;
  stop: boolean;
  onFocus: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="fm-version-note"
        data-release-note={note.version}
        tabIndex={stop ? 0 : -1}
        onFocus={onFocus}
        onClick={() => showReleaseNote(note.version)}
      >
        <span>
          {capitalized(note.name)}
          {!note.listed && (
            <span className="fm-version-note-quiet"> {m.settingsVersionNoNewChanges()}</span>
          )}
        </span>
        <span className="fm-version-note-date">{shownOn(note.shownAt)}</span>
      </button>
    </li>
  );
}

export function VersionRow() {
  return (
    <VersionRowView
      releaseNotes={useShellStore((s) => s.releaseNotes)}
      running={useUpdateState((s) => s.status?.currentVersion ?? null)}
      update={{ line: <UpdateRowLine />, control: <UpdateRowControl /> }}
    />
  );
}

/**
 * The row for the notes as read, null while they are still being read; the
 * version running from the update status, null until that is read.
 */
export function VersionRowView({
  releaseNotes,
  running = null,
  update,
}: {
  releaseNotes: ReleaseNotesView | null;
  running?: string | null;
  /** The update line and the step's buttons, read from the update store. */
  update?: { line: React.ReactNode; control: React.ReactNode };
}) {
  const [expanded, setExpanded] = useState(false);
  const allNotes = releaseNotes?.notes ?? [];
  const notes = expanded ? allNotes : allNotes.slice(0, 3);
  const [stop, setStop] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  // The disclosure leaves the screen; keep focus on the first row it revealed.
  useEffect(() => {
    if (!expanded) return;
    const firstNew = list.current?.querySelectorAll<HTMLElement>("[data-release-note]")[3];
    if (firstNew) focusWithRing(firstNew);
  }, [expanded]);
  const at = Math.min(stop, Math.max(0, notes.length - 1));

  const onKeyDown = (event: React.KeyboardEvent) => {
    const next = noteStop(event.key, at, notes.length);
    if (next === null) return;
    event.preventDefault();
    setStop(next);
    const row = list.current?.querySelectorAll<HTMLElement>("[data-release-note]")[next];
    if (row) focusWithRing(row);
  };

  return (
    <SettingRow
      id="version"
      title={m.settingsVersionTitle()}
      description={
        releaseNotes
          ? notes.length > 0
            ? m.settingsVersionNotes({ name: capitalized(releaseNotes.name) })
            : m.settingsVersionNoNotes({ name: capitalized(releaseNotes.name) })
          : running
            ? m.settingsVersionRunning({ name: capitalized(versionName(running)) })
            : m.settingsVersionReading()
      }
      detail={
        <>
          {update?.line}
          {notes.length > 0 && (
            <>
              <ul
                id={listId}
                ref={list}
                aria-label={m.settingsVersionReleaseNotes()}
                className="fm-version-notes"
                onKeyDown={onKeyDown}
              >
                {notes.map((note, index) => (
                  <NoteRow
                    key={note.version}
                    note={note}
                    stop={index === at}
                    onFocus={() => setStop(index)}
                  />
                ))}
              </ul>
              {!expanded && allNotes.length > 3 && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-release-notes-more=""
                  aria-controls={listId}
                  aria-expanded={false}
                  style={{ marginTop: "var(--space-3)", paddingInline: 0 }}
                  onClick={() => {
                    setStop(3);
                    setExpanded(true);
                  }}
                >
                  {m.settingsVersionShowMore()}
                </Button>
              )}
            </>
          )}
        </>
      }
      control={update?.control ?? null}
      controlOnTitle
    />
  );
}
