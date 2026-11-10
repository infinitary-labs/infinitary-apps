import {
  type AnyCommandId,
  allCommandIds,
  type Bindings,
  bindingLabel,
  chordLabel,
  commandEntry,
  isCatalogCommand,
  type KeyBinding,
  keysOf,
  type PanelCommand,
} from "@shared/keyboard";
import {
  isChanged,
  type KeymapSnapshot,
  keymapRefusal,
  type SavedKeymap,
  SCOPE_WORDS,
  unknownCommands,
  withAllCatalogKeys,
  withCatalogKeys,
  withKeys,
} from "@shared/keymap";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { commandMatches, commandOffered } from "../app/commandRows";
import { useShellStore } from "../app/store";
import { markWindowKeys } from "../app/windowKeysMark";
import { Badge, Button, Input, KeyCap } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { setInstalledKeymap, useInstalledKeymap } from "../design/core/installedKeys";
import {
  keysAfterPress,
  recorderKey,
  recorderVerdict,
  savedAfterRecording,
  takesSecondKey,
} from "./keyRecorder";
import { ROW_GAP, SectionLabel, SettingError } from "./settingRows";

/**
 * Settings → Keyboard (docs/keyboard.md, "Changing keys"; design
 * skill `components/core/KeyboardSettings.prompt.md`): every command with
 * where it works, its keys and whether a person changed them, and on each
 * row Record, Remove and Reset; Reset all keys under the search. The keys
 * shown are the window's installed ones, so this list, the hints, command
 * search and the app menu never disagree.
 */

/** The row being recorded, and the keys pressed so far. */
type Recording = { id: AnyCommandId; keys: KeyBinding | null };

/** A command's words, the catalog's or its panel's. */
function labelOf(id: AnyCommandId, panels: readonly PanelCommand[]): string {
  return commandEntry(id, panels)?.label ?? id;
}

/**
 * Where a command works, as its row says: a panel's command names its panel
 * too, but the app's own panels' read as the window's own.
 */
function whereOf(id: AnyCommandId, panels: readonly PanelCommand[]): string {
  const panel = panels.find((command) => command.id === id);
  if (panel && !panel.own) return `${panel.panel} · ${SCOPE_WORDS.window.toLowerCase()}`;
  return SCOPE_WORDS[commandEntry(id, panels)?.scope ?? "window"];
}

/**
 * A row's words and keys, for the search: a command is found by either, a
 * panel's by its panel too - but not the app's own, which read as the window's.
 */
function rowText(id: AnyCommandId, bindings: Bindings, panels: readonly PanelCommand[]): string {
  const command = panels.find((candidate) => candidate.id === id);
  const panel = command && !command.own ? command.panel : undefined;
  return [
    labelOf(id, panels),
    ...(panel ? [panel] : []),
    ...keysOf(bindings, id).map((binding) => bindingLabel(binding, thisDesktop().keys)),
  ].join(" ");
}

export function KeyboardTab() {
  const snapshot = useInstalledKeymap();
  // A command whose section this build does not offer is not listed here either.
  const sections = {
    devices: useShellStore((s) => s.devicesShown),
    secrets: useShellStore((s) => s.secretsShown),
  };
  const [query, setQuery] = useState("");
  const [recording, setRecordingState] = useState<Recording | null>(null);
  // Keys arrive faster than the section draws: each reads the last one's keys here.
  const recordingNow = useRef<Recording | null>(null);
  const setRecording = (next: Recording | null) => {
    recordingNow.current = next;
    setRecordingState(next);
  };
  const [error, setError] = useState<{ at: AnyCommandId | "all"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const recordingId = recording?.id ?? null;

  /** Saves a change whole; a refusal stays beside the row it came from. */
  const write = (next: SavedKeymap, at: AnyCommandId | "all") => {
    const refusal = keymapRefusal(next, snapshot.saved, snapshot.panels, thisDesktop().keys);
    if (refusal) {
      setError({ at, text: refusal });
      return;
    }
    setSaving(true);
    setError(null);
    void window.infinitary.keyboard
      .save(next)
      .then((installed) => {
        setInstalledKeymap(installed);
        setRecording(null);
      })
      .catch((caught: unknown) => {
        setError({
          at,
          text: caught instanceof Error ? caught.message : "Could not save these keys.",
        });
      })
      .finally(() => setSaving(false));
  };

  const latest = useRef({ snapshot, write, setRecording });
  latest.current = { snapshot, write, setRecording };

  // While a row records, the window's keys pass to it alone (docs/keyboard.md),
  // marked on the document once the main process has started or stopped.
  useEffect(() => {
    if (recordingId === null) return;
    let current = true;
    useShellStore.setState({ recordingKeys: true });
    void window.infinitary.keyboard
      .record(true)
      .then(() => {
        if (current) markWindowKeys("recording");
      })
      .catch(() => {});
    const stop = () => latest.current.setRecording(null);
    window.addEventListener("blur", stop);
    return () => {
      current = false;
      window.removeEventListener("blur", stop);
      useShellStore.setState({ recordingKeys: false });
      void window.infinitary.keyboard
        .record(false)
        .then(() => markWindowKeys("commands"))
        .catch(() => {});
    };
  }, [recordingId]);

  useEffect(
    () =>
      window.infinitary.keyboard.onRecorded((key) => {
        const { snapshot: installed, write: save, setRecording: record } = latest.current;
        const now = recordingNow.current;
        if (!now) return;
        const action = recorderKey(key);
        if (action.kind === "cancel") record(null);
        else if (action.kind === "press")
          record({
            id: now.id,
            keys: keysAfterPress(
              now.id,
              now.keys,
              action.key,
              installed.panels,
              thisDesktop().keys,
            ),
          });
        else {
          const next = savedAfterRecording(
            installed.saved,
            installed.bindings,
            now.id,
            now.keys,
            action.mode,
            installed.panels,
            thisDesktop().keys,
          );
          if (next) save(next, now.id);
          else if (
            recorderVerdict(
              now.id,
              now.keys,
              installed.bindings,
              installed.panels,
              thisDesktop().keys,
            ).kind === "own"
          )
            record(null);
        }
      }),
    [],
  );

  const { panels } = snapshot;
  // The catalog's commands, then each panel's under its own (docs/keyboard.md).
  const ids = allCommandIds(panels);
  const changed = ids.some((id) => isChanged(snapshot.saved, id));
  const shown = ids.filter(
    (id) =>
      (!isCatalogCommand(id) || commandOffered(id, sections)) &&
      commandMatches(rowText(id, snapshot.bindings, panels), query),
  );
  const unknown = unknownCommands(snapshot.saved, panels);

  return (
    <div data-keyboard-settings="">
      <SectionLabel>Keyboard</SectionLabel>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginBottom: ROW_GAP,
        }}
      >
        <div data-keyboard-search="" style={{ flex: 1, minWidth: 0 }}>
          <Input
            aria-label="Search keys"
            placeholder="Search keys"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <Button
          variant={resetArmed ? "danger" : "ghost"}
          size="sm"
          data-keyboard-reset-all=""
          disabled={(!changed && !resetArmed) || saving || recording !== null}
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true);
              return;
            }
            setResetArmed(false);
            write(withAllCatalogKeys(snapshot.saved, panels), "all");
          }}
          onBlur={() => setResetArmed(false)}
        >
          {resetArmed ? "Confirm reset" : "Reset all keys"}
        </Button>
      </div>
      {snapshot.unreadable && (
        <p
          data-keyboard-unreadable=""
          style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-sm)", color: "var(--warn)" }}
        >
          Your saved keys could not be read, so Infinitary's own keys are in use. Changing a key
          saves over them.
        </p>
      )}
      {error?.at === "all" && <SettingError error={error.text} surface="keyboard" />}
      <ul style={LIST}>
        {shown.map((id, index) => (
          <CommandRow
            key={id}
            id={id}
            first={index === 0}
            snapshot={snapshot}
            recording={recording?.id === id ? recording : null}
            busy={saving}
            error={error?.at === id ? error.text : null}
            onRecord={() => {
              setError(null);
              setRecording({ id, keys: null });
            }}
            onCancel={() => setRecording(null)}
            onSave={(mode) => {
              const next = savedAfterRecording(
                snapshot.saved,
                snapshot.bindings,
                id,
                recording?.keys ?? null,
                mode,
                panels,
                thisDesktop().keys,
              );
              if (next) write(next, id);
            }}
            onRemove={() => write(withKeys(snapshot.saved, id, [], panels, thisDesktop().keys), id)}
            onReset={() => write(withCatalogKeys(snapshot.saved, id), id)}
          />
        ))}
        {shown.length === 0 && (
          <li
            style={{ ...ROW, borderTop: "none", color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
          >
            No command matches
          </li>
        )}
      </ul>
      {unknown.length > 0 && (
        <ul data-keyboard-unknown="" style={{ ...LIST, marginTop: 10 }}>
          {unknown.map((id, index) => (
            <li key={id} style={{ ...ROW, ...(index === 0 ? { borderTop: "none" } : {}) }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: "var(--fg-2)",
                  }}
                >
                  {id}
                </div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  Not in this version of Infinitary. Its keys stay saved for the version that has
                  it, and run nothing here.
                </div>
              </div>
              <Keys keys={snapshot.saved.keys[id] ?? []} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const LIST: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--space-3) var(--space-4)",
  padding: "var(--space-3) var(--space-4)",
  borderTop: "1px solid var(--line-1)",
};

function CommandRow({
  id,
  first,
  snapshot,
  recording,
  busy,
  error,
  onRecord,
  onCancel,
  onSave,
  onRemove,
  onReset,
}: {
  id: AnyCommandId;
  first: boolean;
  snapshot: KeymapSnapshot;
  recording: Recording | null;
  busy: boolean;
  error: string | null;
  onRecord: () => void;
  onCancel: () => void;
  onSave: (mode: "replace" | "add") => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  const label = labelOf(id, snapshot.panels);
  const keys = keysOf(snapshot.bindings, id);
  const changed = isChanged(snapshot.saved, id);
  return (
    <li
      data-keyboard-command={id}
      data-keyboard-changed={changed || undefined}
      style={{ ...ROW, ...(first ? { borderTop: "none" } : {}) }}
    >
      <div style={{ flex: "1 1 calc(var(--space-9) * 2)", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}>
            {label}
          </span>
          {changed && <Badge>Changed</Badge>}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {whereOf(id, snapshot.panels)}
        </div>
        {error && <SettingError error={error} surface="keyboard" />}
      </div>
      <Keys keys={keys} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Record a key for ${label}`}
          aria-pressed={recording !== null}
          disabled={busy}
          onClick={recording ? onCancel : onRecord}
        >
          Record
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove the keys of ${label}`}
          disabled={busy || keys.length === 0}
          onClick={onRemove}
        >
          Remove
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reset ${label} to its own keys`}
          disabled={busy || !changed}
          onClick={onReset}
        >
          Reset
        </Button>
      </div>
      {recording && (
        <Recorder
          id={id}
          keys={recording.keys}
          bindings={snapshot.bindings}
          panels={snapshot.panels}
          busy={busy}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
    </li>
  );
}

/** A command's keys as key caps: a two-key shortcut's two side by side, or no key at all. */
function Keys({ keys }: { keys: readonly KeyBinding[] }) {
  if (keys.length === 0)
    return (
      <span data-keyboard-keys="" style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        No key
      </span>
    );
  return (
    <span
      data-keyboard-keys=""
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: "var(--space-2)",
      }}
    >
      {keys.map((binding) => (
        <BindingCaps key={bindingLabel(binding, thisDesktop().keys)} binding={binding} />
      ))}
    </span>
  );
}

function BindingCaps({ binding }: { binding: KeyBinding }) {
  const { keys } = thisDesktop();
  return (
    <span
      data-keyboard-key={bindingLabel(binding, keys)}
      style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
    >
      <KeyCap>{chordLabel(binding, keys)}</KeyCap>
      {binding.second && <KeyCap>{chordLabel(binding.second, keys)}</KeyCap>}
    </span>
  );
}

/**
 * A row's recorder: the keys pressed so far, what saving them would do, and
 * the buttons a pointer uses for what Enter, ⇧Enter and Escape do.
 */
function Recorder({
  id,
  keys,
  bindings,
  panels,
  busy,
  onSave,
  onCancel,
}: {
  id: AnyCommandId;
  keys: KeyBinding | null;
  bindings: Bindings;
  panels: readonly PanelCommand[];
  busy: boolean;
  onSave: (mode: "replace" | "add") => void;
  onCancel: () => void;
}) {
  const system = thisDesktop().keys;
  const verdict = recorderVerdict(id, keys, bindings, panels, system);
  const words =
    verdict.kind === "empty"
      ? "Press the keys you want."
      : verdict.kind === "refused"
        ? verdict.reason
        : verdict.kind === "own"
          ? "That is already its key."
          : verdict.kind === "moves"
            ? verdict.words
            : "No other command uses it.";
  const canSave = verdict.kind === "free" || verdict.kind === "moves" || verdict.kind === "own";
  const canAdd = verdict.kind === "free" || verdict.kind === "moves";
  const hint = [
    "Enter saves",
    `${system === "mac" ? "⇧Enter" : "Shift+Enter"} adds it beside the other keys`,
    "Esc cancels",
    ...(takesSecondKey(id, keys, panels, system) ? ["Another key now makes it two keys"] : []),
  ].join(" · ");
  return (
    <fieldset
      data-keyboard-recorder=""
      aria-label={`Recording a key for ${labelOf(id, panels)}`}
      style={{
        margin: 0,
        minWidth: 0,
        flex: "1 1 100%",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: "var(--bg-2)",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-m)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minHeight: 28 }}>
        {keys ? (
          <BindingCaps binding={keys} />
        ) : (
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>Recording…</span>
        )}
      </div>
      <div
        data-keyboard-verdict={verdict.kind}
        aria-live="polite"
        style={{
          fontSize: "var(--text-sm)",
          color: verdict.kind === "refused" ? "var(--warn)" : "var(--fg-2)",
        }}
      >
        {words}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{hint}</div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          size="sm"
          disabled={!canSave || busy}
          pending={busy}
          pendingLabel="Saving..."
          onClick={() => onSave("replace")}
        >
          Save
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canAdd || busy}
          onClick={() => onSave("add")}
        >
          Add beside the others
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
