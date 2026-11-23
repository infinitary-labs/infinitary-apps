import * as m from "@shared/i18n/messages.generated";
import {
  type AnyCommandId,
  allCommandIds,
  type Bindings,
  bindingLabel,
  chordLabel,
  commandEntry,
  isCatalogCommand,
  type KeyBinding,
  type KeyChord,
  keysOf,
  type PanelCommand,
} from "@shared/keyboard";
import {
  bindingWarning,
  chordOfPress,
  isChanged,
  type KeymapSnapshot,
  keymapRefusal,
  legacyOffered,
  prefixOf,
  prefixProblem,
  type SavedKeymap,
  SCOPE_WORDS,
  sameBinding,
  unknownCommands,
  withAllCatalogKeys,
  withCatalogKeys,
  withKeys,
  withPrefix,
  withPreset,
} from "@shared/keymap";
import {
  PRESET_LABELS,
  type PresetId,
  presetsOffered,
  sameChord,
  TMUX_PREFIX,
} from "@shared/keyPresets";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { commandMatches, commandOffered } from "../app/commandRows";
import { setKeyReminders, useKeyReminders } from "../app/keyReminderState";
import { useShellStore } from "../app/store";
import { markWindowKeys } from "../app/windowKeysMark";
import { Badge, Button, GroupedPills, Input, KeyCap, Switch } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { setInstalledKeymap, useInstalledKeymap } from "../design/core/installedKeys";
import {
  keysAfterPress,
  recorderKey,
  recorderVerdict,
  savedAfterRecording,
  takesSecondKey,
} from "./keyRecorder";
import { ROW_GAP, SectionLabel, SettingError, SettingRow } from "./settingRows";

/**
 * Settings → Keyboard (docs/keyboard.md, "Changing keys"; design
 * skill `components/core/KeyboardSettings.prompt.md`): every command with
 * where it works, its keys and whether a person changed them, and on each
 * row Record, Remove and Reset; the Preset row above the search, with
 * tmux's Prefix row under it while tmux is chosen, and Reset all keys
 * beside the search, which returns to the chosen preset's keys. The keys
 * shown are the window's installed ones, so this list, the hints, command
 * search and the app menu never disagree.
 */

/** `typed`: the character the last recorded press types, which an ⌥ key stops typing. */
type Recording = { id: AnyCommandId; keys: KeyBinding | null; typed?: string };

/** tmux's prefix being recorded (docs/keyboard.md, "Presets"), and the key pressed so far. */
type PrefixRecording = { chord: KeyChord | null };

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
  const [prefixRecording, setPrefixRecordingState] = useState<PrefixRecording | null>(null);
  const prefixRecordingNow = useRef<PrefixRecording | null>(null);
  const setPrefixRecording = (next: PrefixRecording | null) => {
    prefixRecordingNow.current = next;
    setPrefixRecordingState(next);
  };
  const [error, setError] = useState<{
    at: AnyCommandId | "all" | "prefix";
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const recordingId = recording?.id ?? (prefixRecording ? "prefix" : null);
  const anyRecording = recording !== null || prefixRecording !== null;

  /** Saves a change whole; a refusal stays beside the row it came from. */
  const write = (next: SavedKeymap, at: AnyCommandId | "all" | "prefix") => {
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
        setPrefixRecording(null);
      })
      .catch((caught: unknown) => {
        setError({
          at,
          text: caught instanceof Error ? caught.message : m.settingsKeyboardSaveFailed(),
        });
      })
      .finally(() => setSaving(false));
  };

  const latest = useRef({ snapshot, write, setRecording, setPrefixRecording });
  latest.current = { snapshot, write, setRecording, setPrefixRecording };

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
    const stop = () => {
      latest.current.setRecording(null);
      latest.current.setPrefixRecording(null);
    };
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
        const prefixNow = prefixRecordingNow.current;
        if (prefixNow) {
          const action = recorderKey(key);
          const { setPrefixRecording: recordPrefix } = latest.current;
          if (action.kind === "cancel") recordPrefix(null);
          else if (action.kind === "press")
            recordPrefix({
              chord: chordOfPress({ ...action.key, composing: false, repeat: false }),
            });
          else if (prefixNow.chord && prefixProblem(prefixNow.chord, thisDesktop().keys) === null)
            save(withPrefix(installed.saved, prefixNow.chord), "prefix");
          return;
        }
        const now = recordingNow.current;
        if (!now) return;
        const prefix = prefixOf(installed.saved);
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
              prefix,
            ),
            ...(action.key.key.length === 1 ? { typed: action.key.key } : {}),
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
            prefix,
          );
          if (next) save(next, now.id);
          else if (
            recorderVerdict(
              now.id,
              now.keys,
              installed.bindings,
              installed.panels,
              thisDesktop().keys,
              prefix,
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
  const prefix = prefixOf(snapshot.saved);
  const changed =
    ids.some((id) => isChanged(snapshot.saved, id)) ||
    (prefix !== undefined && !sameChord(prefix, TMUX_PREFIX));
  const shown = ids.filter(
    (id) =>
      (!isCatalogCommand(id) || commandOffered(id, sections)) &&
      commandMatches(rowText(id, snapshot.bindings, panels), query),
  );
  const unknown = unknownCommands(snapshot.saved, panels);

  return (
    <div data-keyboard-settings="">
      <SectionLabel>{m.settingsKeyboardHeading()}</SectionLabel>
      <div style={{ marginBottom: ROW_GAP }}>
        <SettingRow
          id="keyboard-preset"
          title={m.settingsKeyboardPreset()}
          description={m.settingsKeyboardPresetDescription()}
          control={
            <GroupedPills<PresetId>
              name={m.settingsKeyboardPreset()}
              htmlName="keyboard-preset"
              value={snapshot.saved.preset}
              // Not while saving: a disabled pill drops the focus an arrow just moved.
              disabled={anyRecording}
              options={presetsOffered(legacyOffered(snapshot.saved), snapshot.saved.preset).map(
                (value) => ({ value, label: PRESET_LABELS[value] }),
              )}
              onChange={(next) => {
                setResetArmed(false);
                write(withPreset(snapshot.saved, next), "all");
              }}
            />
          }
        />
      </div>
      <div style={{ marginBottom: ROW_GAP }}>
        <KeyReminderRow />
      </div>
      {prefix && (
        <div style={{ marginBottom: ROW_GAP }}>
          <PrefixRow
            prefix={prefix}
            recording={prefixRecording}
            busy={saving}
            error={error?.at === "prefix" ? error.text : null}
            onRecord={() => {
              setError(null);
              setRecording(null);
              setPrefixRecording({ chord: null });
            }}
            onCancel={() => setPrefixRecording(null)}
            onSave={() => {
              if (prefixRecording?.chord)
                write(withPrefix(snapshot.saved, prefixRecording.chord), "prefix");
            }}
            onReset={() => write(withPrefix(snapshot.saved, TMUX_PREFIX), "prefix")}
          />
        </div>
      )}
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
            aria-label={m.settingsKeyboardSearch()}
            placeholder={m.settingsKeyboardSearch()}
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
          disabled={(!changed && !resetArmed) || saving || anyRecording}
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
          {resetArmed ? m.settingsKeyboardResetAllConfirm() : m.settingsKeyboardResetAll()}
        </Button>
      </div>
      {snapshot.unreadable && (
        <p
          data-keyboard-unreadable=""
          style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-sm)", color: "var(--warn)" }}
        >
          {m.settingsKeyboardUnreadable()}
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
            prefix={prefix}
            error={error?.at === id ? error.text : null}
            onRecord={() => {
              setError(null);
              setPrefixRecording(null);
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
                prefix,
              );
              if (next) write(next, id);
            }}
            onPlace={(binding, when) =>
              write(
                withKeys(
                  snapshot.saved,
                  id,
                  keysOf(snapshot.bindings, id).map((key) => {
                    if (!sameBinding(key, binding)) return key;
                    const { when: _old, ...chord } = key;
                    return when ? { ...chord, when } : chord;
                  }),
                  snapshot.panels,
                  thisDesktop().keys,
                ),
                id,
              )
            }
            onRemove={() => write(withKeys(snapshot.saved, id, [], panels, thisDesktop().keys), id)}
            onReset={() => write(withCatalogKeys(snapshot.saved, id), id)}
          />
        ))}
        {shown.length === 0 && (
          <li
            style={{ ...ROW, borderTop: "none", color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
          >
            {m.settingsKeyboardNoMatch()}
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
                  {m.settingsKeyboardUnknownCommand()}
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
  prefix,
  error,
  onRecord,
  onCancel,
  onSave,
  onRemove,
  onReset,
  onPlace,
}: {
  id: AnyCommandId;
  first: boolean;
  snapshot: KeymapSnapshot;
  recording: Recording | null;
  busy: boolean;
  prefix: KeyChord | undefined;
  error: string | null;
  onRecord: () => void;
  onCancel: () => void;
  onSave: (mode: "replace" | "add") => void;
  onPlace: (binding: KeyBinding, when: "not-typing" | undefined) => void;
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
          {changed && <Badge>{m.settingsKeyboardChanged()}</Badge>}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {whereOf(id, snapshot.panels)}
        </div>
        {error && <SettingError error={error} surface="keyboard" />}
      </div>
      <Keys
        keys={keys}
        place={
          commandEntry(id, snapshot.panels)?.scope === "window"
            ? {
                label,
                busy: busy || recording !== null,
                onChange: onPlace,
              }
            : undefined
        }
      />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        <Button
          variant="secondary"
          size="sm"
          aria-label={m.settingsKeyboardRecordLabel({ command: label })}
          aria-pressed={recording !== null}
          disabled={busy}
          onClick={recording ? onCancel : onRecord}
        >
          {m.settingsKeyboardRecord()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsKeyboardRemoveLabel({ command: label })}
          disabled={busy || keys.length === 0}
          onClick={onRemove}
        >
          {m.settingsKeyboardRemove()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.settingsKeyboardResetLabel({ command: label })}
          disabled={busy || !changed}
          onClick={onReset}
        >
          {m.settingsKeyboardReset()}
        </Button>
      </div>
      {recording && (
        <Recorder
          id={id}
          keys={recording.keys}
          typed={recording.typed}
          bindings={snapshot.bindings}
          panels={snapshot.panels}
          prefix={prefix}
          busy={busy}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
    </li>
  );
}

type PlaceControl = {
  label: string;
  busy: boolean;
  onChange: (binding: KeyBinding, when: "not-typing" | undefined) => void;
};
function Keys({ keys, place }: { keys: readonly KeyBinding[]; place?: PlaceControl }) {
  if (keys.length === 0)
    return (
      <span data-keyboard-keys="" style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {m.settingsKeyboardNoKey()}
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
        <span
          key={bindingLabel(binding, thisDesktop().keys)}
          style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
        >
          <BindingCaps binding={binding} />
          {place && (binding.meta || binding.ctrl || binding.alt || /^F\d+$/.test(binding.key)) && (
            <select
              aria-label={m.settingsKeyboardWhereLabel({
                key: bindingLabel(binding, thisDesktop().keys),
                command: place.label,
              })}
              value={binding.when ?? "anywhere"}
              disabled={place.busy}
              onChange={(event) =>
                place.onChange(
                  binding,
                  event.target.value === "not-typing" ? "not-typing" : undefined,
                )
              }
              style={{
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-s)",
                padding: "var(--space-1)",
              }}
            >
              <option value="anywhere">{m.settingsKeyboardAnywhere()}</option>
              <option value="not-typing">{m.settingsKeyboardNotTyping()}</option>
            </select>
          )}
        </span>
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
      {binding.when === "not-typing" && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
          {m.settingsKeyboardNotTyping()}
        </span>
      )}
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
  typed,
  bindings,
  panels,
  prefix,
  busy,
  onSave,
  onCancel,
}: {
  id: AnyCommandId;
  keys: KeyBinding | null;
  typed?: string;
  bindings: Bindings;
  panels: readonly PanelCommand[];
  prefix: KeyChord | undefined;
  busy: boolean;
  onSave: (mode: "replace" | "add") => void;
  onCancel: () => void;
}) {
  const system = thisDesktop().keys;
  const verdict = recorderVerdict(id, keys, bindings, panels, system, prefix);
  const words =
    verdict.kind === "empty"
      ? m.settingsKeyboardPress()
      : verdict.kind === "refused"
        ? verdict.reason
        : verdict.kind === "own"
          ? m.settingsKeyboardOwn()
          : verdict.kind === "moves"
            ? verdict.words
            : m.settingsKeyboardFree();
  const canSave = verdict.kind === "free" || verdict.kind === "moves" || verdict.kind === "own";
  const canAdd = verdict.kind === "free" || verdict.kind === "moves";
  const warning = keys && canSave ? bindingWarning(keys, id, panels, system, typed) : null;
  // i18n-exempt: key names
  const addKey = system === "mac" ? "⇧Enter" : "Shift+Enter";
  const hint = takesSecondKey(id, keys, panels, system, prefix)
    ? m.settingsKeyboardRecorderKeysSecond({ addKey })
    : m.settingsKeyboardRecorderKeys({ addKey });
  return (
    <fieldset
      data-keyboard-recorder=""
      aria-label={m.settingsKeyboardRecordingLabel({ command: labelOf(id, panels) })}
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
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
            {m.settingsKeyboardRecordingWait()}
          </span>
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
      {warning && (
        <p
          data-keyboard-warning=""
          aria-live="polite"
          style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--warn)" }}
        >
          {warning}
        </p>
      )}
      <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{hint}</div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button
          size="sm"
          disabled={!canSave || busy}
          pending={busy}
          pendingLabel={m.settingsKeyboardSaving()}
          onClick={() => onSave("replace")}
        >
          {m.settingsKeyboardSave()}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canAdd || busy}
          onClick={() => onSave("add")}
        >
          {m.settingsKeyboardAddBeside()}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {m.settingsKeyboardCancel()}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * tmux's Prefix row (docs/keyboard.md, "Presets"): the one key every key of
 * tmux's prefix layer starts with, recorded in this one place; Reset puts
 * ⌃B back. A recorded prefix shows why it cannot be one before it is saved.
 */
function PrefixRow({
  prefix,
  recording,
  busy,
  error,
  onRecord,
  onCancel,
  onSave,
  onReset,
}: {
  prefix: KeyChord;
  recording: PrefixRecording | null;
  busy: boolean;
  error: string | null;
  onRecord: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const system = thisDesktop().keys;
  const changed = !sameChord(prefix, TMUX_PREFIX);
  const problem = recording?.chord ? prefixProblem(recording.chord, system) : null;
  const canSave = recording?.chord != null && problem === null;
  return (
    <SettingRow
      id="keyboard-prefix"
      title={m.settingsKeyboardPrefix()}
      description={m.settingsKeyboardPrefixDescription({ key: chordLabel(prefix, system) })}
      control={
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span data-keyboard-prefix={chordLabel(prefix, system)}>
            <KeyCap>{chordLabel(prefix, system)}</KeyCap>
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-label={m.settingsKeyboardPrefixRecordLabel()}
            aria-pressed={recording !== null}
            disabled={busy}
            onClick={recording ? onCancel : onRecord}
          >
            {m.settingsKeyboardPrefixRecord()}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={m.settingsKeyboardPrefixResetLabel()}
            disabled={busy || !changed}
            onClick={onReset}
          >
            {m.settingsKeyboardPrefixReset()}
          </Button>
        </div>
      }
      error={error}
      detail={
        recording && (
          <fieldset
            data-keyboard-prefix-recorder=""
            aria-label={m.settingsKeyboardPrefixRecording()}
            style={{
              margin: "var(--space-2) 0 0",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              background: "var(--bg-2)",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-m)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", minHeight: 28 }}>
              {recording.chord ? (
                <KeyCap>{chordLabel(recording.chord, system)}</KeyCap>
              ) : (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  {m.settingsKeyboardPrefixRecordingWait()}
                </span>
              )}
            </div>
            <div
              data-keyboard-verdict={recording.chord ? (problem ? "refused" : "free") : "empty"}
              aria-live="polite"
              style={{ fontSize: "var(--text-sm)", color: problem ? "var(--warn)" : "var(--fg-2)" }}
            >
              {!recording.chord
                ? m.settingsKeyboardPrefixPress()
                : (problem ?? m.settingsKeyboardPrefixFree())}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
              {m.settingsKeyboardPrefixKeys()}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button
                size="sm"
                disabled={!canSave || busy}
                pending={busy}
                pendingLabel={m.settingsKeyboardPrefixSaving()}
                onClick={onSave}
              >
                {m.settingsKeyboardPrefixSave()}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {m.settingsKeyboardPrefixCancel()}
              </Button>
            </div>
          </fieldset>
        )
      }
    />
  );
}

/**
 * The key reminder's one switch (docs/keyboard.md, "The key reminder"): on,
 * a mouse click on a control whose command has a key names that key at the
 * bottom of the window; off, no reminder shows, from the next click on.
 */
function KeyReminderRow() {
  const { on } = useKeyReminders();
  return (
    <SettingRow
      id="keyboard-reminders"
      title={m.settingsKeyboardReminders()}
      description={m.settingsKeyboardRemindersDescription()}
      control={
        <span data-keyboard-reminders="">
          <Switch
            checked={on}
            aria-label={m.settingsKeyboardReminders()}
            onChange={(next) => {
              void setKeyReminders(next).catch(() => {});
            }}
          />
        </span>
      }
    />
  );
}
