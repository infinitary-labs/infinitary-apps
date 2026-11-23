import {
  type AutomationRule,
  type AutomationNotes as NotesPage,
  RULE_NOTES_MAX_CHARS,
} from "@shared/automation";
import { formatDateTime, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyedText } from "../cards/TaskKey";
import { Button } from "../design";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { messageOf, NOTE_STYLE, PromptBox, TEXTAREA_STYLE } from "./automationParts";
import { ROW_GAP, SettingError } from "./settingRows";

/**
 * A rule's notes (docs/automation.md, "A rule's notes"): what its runs
 * learned, which a crewmate a run starts edits as a file. The captain reads,
 * edits or clears them here, and reads every earlier version. Saving them
 * makes no new revision of the rule; a page past the limit is never sent.
 */
export function AutomationNotes({ rule }: { rule: AutomationRule }) {
  const [standing, setStanding] = useState<NotesPage | undefined>(undefined);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether any version was ever saved, a cleared one included: Earlier versions shows then.
  const [saved, setSaved] = useState(false);
  // A crewmate's newer page replaces the field unless the captain is editing it.
  const shown = useRef("");
  const show = useCallback((notes: NotesPage | undefined) => {
    // Cleared notes read as none.
    const page = notes?.text ? notes : undefined;
    setStanding(page);
    // The updater runs at render, after `shown` moves on, so it compares with the page shown before.
    const before = shown.current;
    setText((current) => (current === before ? (page?.text ?? "") : current));
    shown.current = page?.text ?? "";
  }, []);
  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.notes",
        { id: rule.id, versions: "current" },
        {
          onValue: (value) => {
            const newest = (value as NotesPage[])[0];
            setSaved(newest !== undefined);
            show(newest);
          },
          onError: () => {},
        },
      ),
    [rule.id, show],
  );
  const over = text.trim().length > RULE_NOTES_MAX_CHARS;
  const changed = text.trim() !== (standing?.text ?? "");
  const save = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const version = await window.infinitary.automation.saveNotes(rule.id, next);
      // The saved page replaces the field, edited or not.
      shown.current = text;
      if (version) setSaved(true);
      show(version ?? undefined);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-automation-notes style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {m.settingsAutomationNotesNote()}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {standing && (
          <span style={NOTE_STYLE}>
            {notesVersionWords(standing)}
            {standing.revision < rule.revision && (
              <span data-automation-notes-older> · {m.settingsAutomationNotesOlder()}</span>
            )}
          </span>
        )}
        <textarea
          id="automation-notes"
          aria-label={m.settingsAutomationNotes()}
          value={text}
          rows={8}
          onChange={(event) => setText(event.target.value)}
          style={TEXTAREA_STYLE}
        />
        <SettingError error={error} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || over || !changed}
            onClick={() => void save(text)}
            data-automation-notes-save
          >
            {m.settingsAutomationNotesSave()}
          </Button>
          {standing && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void save("")}
              data-automation-notes-clear
            >
              {m.settingsAutomationNotesClear()}
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <span
            data-automation-notes-count
            style={{
              ...NOTE_STYLE,
              fontFamily: "var(--font-mono)",
              ...(over ? { color: "var(--danger)" } : {}),
            }}
          >
            {m.settingsAutomationNotesCount({
              count: formatNumber(text.trim().length),
              max: formatNumber(RULE_NOTES_MAX_CHARS),
            })}
          </span>
        </div>
      </div>
      {saved && <EarlierNotes id={rule.id} />}
    </div>
  );
}

/**
 * Every version of a rule's notes, newest first, each naming who wrote it
 * and when. Read only while it is open: versions are never pruned.
 */
function EarlierNotes({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<NotesPage[]>([]);
  useEffect(() => {
    if (!open) return;
    return appReadExecutor().subscribe(
      "automation.notes",
      { id, versions: "all" },
      {
        onValue: (value) => setVersions(value as NotesPage[]),
        onError: () => setVersions([]),
      },
    );
  }, [id, open]);
  return (
    <details
      data-automation-notes-earlier
      style={{ fontSize: "var(--text-sm)" }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary style={{ cursor: "pointer", width: "fit-content", color: "var(--fg-2)" }}>
        {m.settingsAutomationNotesEarlier()}
      </summary>
      {open && (
        <ul
          style={{
            margin: "var(--space-2) 0 0",
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {versions.map((version) => (
            <li
              key={version.version}
              data-automation-notes-version={version.version}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
            >
              <div style={{ color: "var(--fg-3)" }}>
                {notesVersionWords(version)}
                {version.task && (
                  <>
                    {" · "}
                    <KeyedText text={`${version.task.key} ${version.task.title}`} />
                  </>
                )}
              </div>
              {version.text ? (
                <PromptBox prompt={version.text} />
              ) : (
                <div style={{ color: "var(--fg-3)" }}>{m.settingsAutomationNotesEmpty()}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function notesVersionWords(version: NotesPage): string {
  const words = {
    version: formatNumber(version.version),
    date: formatDateTime(version.at, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  };
  return version.by === "captain"
    ? m.settingsAutomationNotesByYou(words)
    : m.settingsAutomationNotesByCrew(words);
}
