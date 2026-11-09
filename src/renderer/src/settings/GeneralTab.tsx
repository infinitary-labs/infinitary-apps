import { isCustomApiProvider } from "@shared/customApi";
import { HERE } from "@shared/deviceNames";
import {
  DICTATION_KEY_PICKING,
  type DictationSettings,
  dictationKeyCap,
  dictationKeyChoices,
  dictationKeyLabel,
  dictationKeySchema,
} from "@shared/dictation";
import { catalogEntry, providerServesRole } from "@shared/providers";
import type { PiModelRefView } from "@shared/quota";
import type { PresenceSettings } from "@shared/update";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input, KeyCap, Switch } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { isView } from "../devices/viewWords";
import { purgedTasksText, YOUR_PANELS_WORDS } from "./generalWords";
import { LocalSeatSection } from "./LocalSeatSection";
import { PrivateSitesSection } from "./PrivateSitesSection";
import { SharingSection } from "./SharingSection";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingRow } from "./settingRows";
import { UpdateChannelRow } from "./UpdateChannelRow";
import { useSettingSave } from "./useSettingSave";
import { VersionRow } from "./VersionRow";
import { WebsiteSignInsSection } from "./WebsiteSignInsSection";

// Re-exported for the sections that grew up importing them from here.
export { SectionLabel, SettingRow } from "./settingRows";

/**
 * The General section of Settings (phase 7 persisted settings, D-17
 * presence, D-13 purge), registered through the built-in plugin manifest
 * like every other settings section.
 */

/**
 * The host-owned switch over the captain's panels (talk-to-personalize
 * Step 5): his own and, since one plugin vehicle (Phase A, A3a), the ones
 * he added. It is the ONE control that takes back the trust a panel runs
 * on: off, the core stops every one of them and the module behind it, in
 * one tick. It follows the core's push rather than its own state,
 * because a safe-mode boot writes the same row - which is why the row says
 * WHY they are off instead of reading as a setting the captain forgot.
 */
function YourPanelsRow() {
  const save = useSettingSave(
    async () => (await window.infinitary.settings.getPreferences()).panels,
  );
  const panels = save.value;

  useEffect(() => {
    void save.refresh();
    try {
      return window.infinitary.settings.onPreferences((preferences) => {
        save.apply(preferences.panels);
      });
    } catch {
      // Without a push the row keeps what it read; its own writes still apply.
      return undefined;
    }
  }, [save.refresh, save.apply]);

  const description =
    panels && !panels.enabled && panels.offReason === "safe-mode"
      ? YOUR_PANELS_WORDS.safeMode
      : YOUR_PANELS_WORDS.on;

  return (
    <SettingRow
      id="your-panels"
      error={save.error}
      title={YOUR_PANELS_WORDS.title}
      description={description}
      control={
        <Switch
          checked={panels?.enabled ?? true}
          disabled={!panels || save.saving}
          onChange={(checked) => {
            void save.save(() => window.infinitary.settings.setPanels(checked));
          }}
        />
      }
    />
  );
}

export function firstmateModelKey(model: PiModelRefView): string {
  return `${model.provider}/${model.id}`;
}

/** Provider catalog name and model id; never the raw provider id. */
export function firstmateModelOptionLabel(model: PiModelRefView): string {
  const name = isCustomApiProvider(model.provider)
    ? "Custom API"
    : (catalogEntry(model.provider)?.name ?? model.provider);
  return `${name} · ${model.id}`;
}

/** The Firstmate picker uses the shared role gate; custom providers pass it. */
export function firstmateModelChoices(models: readonly PiModelRefView[]): PiModelRefView[] {
  return models.filter((model) => providerServesRole(model.provider, "firstmate"));
}

export function firstmatePinIsOffered(
  chosen: PiModelRefView | null,
  choices: readonly PiModelRefView[],
): boolean {
  if (!chosen) return true;
  const key = firstmateModelKey(chosen);
  return choices.some((model) => firstmateModelKey(model) === key);
}

/** Auto is empty string and always clears. A stranded pin stays selectable. */
export function nextFirstmateModel(
  value: string,
  chosen: PiModelRefView | null,
  choices: readonly PiModelRefView[],
): PiModelRefView | null {
  if (value === "") return null;
  const pool =
    chosen && !firstmatePinIsOffered(chosen, choices) ? [chosen, ...choices] : [...choices];
  return pool.find((model) => firstmateModelKey(model) === value) ?? null;
}

/** The native select Firstmate's own model and account pickers share. */
export const FIRSTMATE_SELECT_STYLE = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  maxWidth: "calc(var(--space-9) * 3)",
} as const;

/** The select's value for "Another model by name…" - never a model key. */
const BY_NAME_VALUE = "\u0000by-name";

/** An unlisted model a subscription serves, as the by-name field offers it. */
export type ByNameModel = PiModelRefView & { label: string };

/**
 * The model the by-name field names: a typed or picked `provider/id` that
 * one of the offered unlisted models answers to, else nothing. A name no
 * subscription serves is never set.
 */
export function firstmateModelByName(
  value: string,
  byName: readonly ByNameModel[],
): PiModelRefView | null {
  const key = value.trim();
  const match = byName.find((model) => firstmateModelKey(model) === key);
  return match ? { provider: match.provider, id: match.id } : null;
}

export function FirstmateModelSelect({
  chosen,
  available,
  byName = [],
  disabled = false,
  onChange,
}: {
  chosen: PiModelRefView | null;
  /** null while the model list is still loading - a pin is not judged yet. */
  available: readonly PiModelRefView[] | null;
  /**
   * What the subscriptions serve beyond the listed models (docs/model-lists
   * .md): reachable by name, never an option of its own.
   */
  byName?: readonly ByNameModel[];
  /** While the saved choice is unread or a change is still being saved. */
  disabled?: boolean;
  onChange: (model: PiModelRefView | null) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const choices = firstmateModelChoices(available ?? []);
  const nameable = byName.filter((model) => providerServesRole(model.provider, "firstmate"));
  // "Cannot run Firstmate" is a verdict, not a loading state: until the
  // list arrives the pin renders plainly rather than flashing the label.
  const stranded = available !== null && chosen !== null && !firstmatePinIsOffered(chosen, choices);
  const pending = available === null && chosen !== null;
  // A model chosen by name is kept, so the next list read carries it; until
  // then it renders as itself rather than as a stranded pin.
  const namedPin =
    chosen !== null && !firstmatePinIsOffered(chosen, choices)
      ? nameable.some((model) => firstmateModelKey(model) === firstmateModelKey(chosen))
      : false;
  if (naming) {
    const commit = () => {
      const model = firstmateModelByName(draft, nameable);
      if (!model) return;
      onChange(model);
      setNaming(false);
      setDraft("");
    };
    return (
      <span style={{ display: "inline-flex", maxWidth: "calc(var(--space-9) * 3)", width: "100%" }}>
        <Input
          mono
          autoFocus
          aria-label="First mate model by name"
          placeholder="provider/model-id"
          list="fm-firstmate-by-name"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            // A pick from the list is a whole key: take it at once.
            const picked = firstmateModelByName(event.target.value, nameable);
            if (picked) {
              onChange(picked);
              setNaming(false);
              setDraft("");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              event.stopPropagation();
              setNaming(false);
              setDraft("");
            }
          }}
          style={{ fontSize: "var(--text-sm)", padding: "var(--space-2) var(--space-3)" }}
        />
        <datalist id="fm-firstmate-by-name">
          {nameable.map((model) => (
            <option key={firstmateModelKey(model)} value={firstmateModelKey(model)}>
              {model.label}
            </option>
          ))}
        </datalist>
      </span>
    );
  }
  return (
    <select
      aria-label="First mate model"
      disabled={disabled}
      value={chosen ? firstmateModelKey(chosen) : ""}
      onChange={(event) => {
        if (event.target.value === BY_NAME_VALUE) {
          setNaming(true);
          return;
        }
        onChange(nextFirstmateModel(event.target.value, chosen, choices));
      }}
      style={FIRSTMATE_SELECT_STYLE}
    >
      <option value="">Auto (from subscriptions)</option>
      {stranded && chosen && !namedPin ? (
        <option value={firstmateModelKey(chosen)}>
          {firstmateModelOptionLabel(chosen)} — cannot run your first mate
        </option>
      ) : null}
      {namedPin && chosen ? (
        <option value={firstmateModelKey(chosen)}>{firstmateModelOptionLabel(chosen)}</option>
      ) : null}
      {pending && chosen ? (
        <option value={firstmateModelKey(chosen)}>{firstmateModelOptionLabel(chosen)}</option>
      ) : null}
      {choices.map((model) => (
        <option key={firstmateModelKey(model)} value={firstmateModelKey(model)}>
          {firstmateModelOptionLabel(model)}
        </option>
      ))}
      {nameable.length > 0 ? <option value={BY_NAME_VALUE}>Another model by name…</option> : null}
    </select>
  );
}

/**
 * Firstmate's account picker, when there is a choice, which sits beside the
 * model's in the same row (the captain, FI3-215): its select, the provider
 * it chooses within, and a refusal to show.
 */
export type FirstmateAccountSlot = {
  select: ReactNode;
  providerName: string;
  error: string | null;
};

/** What the Firstmate model row says, with or without the account beside it. */
export function firstmateSeatDescription(providerName?: string): string {
  return providerName
    ? `The model your first mate itself answers with, and the ${providerName} account it answers on; crew work keeps its own preferred account. Auto tries high, medium, premium, then low across your subscriptions; a change applies at the next idle moment.`
    : "The model your first mate itself answers with. Auto tries high, medium, premium, then low across your subscriptions; a change applies at the next idle moment.";
}

/**
 * The fixed Firstmate model (captain decision Q2): one explicit pick, with
 * a subscription-derived default the agent persists on first use - never
 * dynamic routing for the orchestrator's own turns. When there is an
 * account to choose, its picker is a second dropdown beside the model.
 */
export function FirstmateModelRow({ account }: { account?: FirstmateAccountSlot } = {}) {
  const [available, setAvailable] = useState<PiModelRefView[] | null>(null);
  const [byName, setByName] = useState<ByNameModel[]>([]);
  // Auto is a saved choice too, so the saved value is boxed: null is "not read yet".
  const save = useSettingSave(async () => ({
    model: await window.infinitary.settings.getFirstmateModel(),
  }));
  const chosen = save.value?.model ?? null;

  const readLists = useCallback(() => {
    void window.infinitary.models.available().then(setAvailable);
    void window.infinitary.models.slots().then((view) =>
      setByName(
        view.byName.map((model) => ({
          provider: model.provider,
          id: model.id,
          label: `${model.providerLabel} · ${model.label}`,
        })),
      ),
    );
  }, []);

  useEffect(() => {
    const refresh = () => {
      readLists();
      void save.refresh();
    };
    refresh();
    return window.infinitary.models.onChanged(refresh);
  }, [readLists, save.refresh]);

  const choose = (model: PiModelRefView | null) => {
    void save
      .save(async () => ({ model: await window.infinitary.settings.setFirstmateModel(model) }))
      .then((saved) => {
        if (!saved) return;
        // A model chosen by name is kept now, so it joins the listed choices.
        readLists();
        void useShellStore.getState().loadFirstRun();
      });
  };

  const model = (
    <FirstmateModelSelect
      chosen={chosen}
      available={available}
      byName={byName}
      disabled={!save.value || save.saving}
      onChange={choose}
    />
  );
  const error = [save.error, account?.error].filter(Boolean).join(" ");
  return (
    <SettingRow
      id="firstmate-model"
      title={account ? "First mate model and account" : "First mate model"}
      description={firstmateSeatDescription(account?.providerName)}
      error={error || null}
      control={
        account ? (
          // Side by side at every window width; the words beside them wrap.
          <span style={{ display: "inline-flex", gap: "var(--space-2)", flexShrink: 0 }}>
            {model}
            {account.select}
          </span>
        ) : (
          model
        )
      }
    />
  );
}

function DictationRow() {
  const desktop = thisDesktop();
  const key = useShellStore((s) => s.dictation?.key) ?? desktop.dictationKey;
  const dictation = useShellStore((s) => s.dictation);
  const picking = useShellStore((s) => s.pickingDictationKey);
  const save = useSettingSave(async () => {
    const saved = await window.infinitary.settings.getDictation();
    useShellStore.getState().applyDictation(saved);
    return saved;
  });
  const write = useCallback(
    (next: DictationSettings) => {
      void save.save(async () => {
        const saved = await window.infinitary.settings.setDictation(next);
        useShellStore.getState().applyDictation(saved);
        return saved;
      });
    },
    [save.save],
  );

  useEffect(() => {
    void save.refresh();
    return () => useShellStore.setState({ pickingDictationKey: false });
  }, [save.refresh]);
  useEffect(() => {
    if (!picking || !dictation) return;
    const pick = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        useShellStore.setState({ pickingDictationKey: false });
        return;
      }
      const key = dictationKeySchema.safeParse(event.code);
      if (!key.success || event.repeat) return;
      useShellStore.setState({ pickingDictationKey: false });
      write({ ...dictation, key: key.data });
    };
    // Capture before the app's dictation and Escape listeners.
    window.addEventListener("keydown", pick, true);
    return () => window.removeEventListener("keydown", pick, true);
  }, [picking, dictation, write]);

  return (
    <SettingRow
      id="dictation"
      title="Dictation"
      error={save.error}
      description={
        picking
          ? `Press ${dictationKeyChoices(desktop.keys)} to hold for dictation. Esc keeps ${dictationKeyLabel(key, desktop.keys)}.`
          : `Press or hold the key to talk instead of typing, transcribed on ${HERE.this}. Off leaves the key and the microphone to other apps.`
      }
      control={
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexShrink: 0 }}
        >
          <Button
            variant="secondary"
            size="sm"
            aria-label="Dictation key"
            disabled={!dictation?.enabled || save.saving}
            onClick={() => useShellStore.setState({ pickingDictationKey: true })}
          >
            {picking ? (
              DICTATION_KEY_PICKING
            ) : (
              <>
                right <KeyCap size="sm">{dictationKeyCap(key, desktop.keys)}</KeyCap>
              </>
            )}
          </Button>
          <Switch
            aria-label="Dictation"
            checked={dictation?.enabled ?? true}
            disabled={!dictation || save.saving}
            onChange={(enabled) => dictation && write({ ...dictation, enabled })}
          />
        </div>
      }
    />
  );
}

export function GeneralTab() {
  // On a computer that controls a first mate a command started, its login,
  // Dock, dictation and panels are that computer's own, with nobody there:
  // their rows stay off this tab (docs/run.md, "Control from another computer").
  const remote = isView(useShellStore((s) => s.thisMac));
  // Presence (D-17): dock on, start-at-login off by default; both live in
  // main (login item with the OS, dock visibility persisted).
  const presenceSave = useSettingSave(() => window.infinitary.presence.get());
  const notificationSave = useSettingSave(() => window.infinitary.settings.getNotifications());
  const [presenceField, setPresenceField] = useState<keyof PresenceSettings>("startAtLogin");
  const presence = presenceSave.value;
  const notifications = notificationSave.value;
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [purgedNote, setPurgedNote] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const purgeInFlight = useRef(false);
  // Knowledge, where this build keeps it, goes with a purge: the row says so
  // before the first click (docs/knowledge.md).
  const [purgesKnowledge, setPurgesKnowledge] = useState(false);

  useEffect(() => {
    if (!remote) void presenceSave.refresh();
    void notificationSave.refresh();
  }, [remote, presenceSave.refresh, notificationSave.refresh]);

  useEffect(() => {
    let live = true;
    void window.infinitary.retention
      .scope()
      .then(({ knowledge }) => {
        if (!live) return;
        setPurgesKnowledge(knowledge);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const saveNotifications = (enabled: boolean) => {
    void notificationSave.save(() => window.infinitary.settings.setNotifications(enabled));
  };

  const savePresence = (next: PresenceSettings, field: keyof PresenceSettings) => {
    setPresenceField(field);
    void presenceSave.save(() => window.infinitary.presence.set(next));
  };

  const purge = () => {
    if (purgeInFlight.current) return;
    if (!purgeArmed) {
      setPurgeArmed(true);
      return;
    }
    purgeInFlight.current = true;
    setPurging(true);
    setPurgedNote(null);
    void window.infinitary.retention
      .purge()
      .then(({ purgedTasks }) => {
        setPurgedNote(purgedTasksText(purgedTasks));
      })
      .catch((caught) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        setPurgedNote(message);
      })
      .finally(() => {
        purgeInFlight.current = false;
        setPurging(false);
        setPurgeArmed(false);
      });
  };

  return (
    <div>
      <SectionLabel>General</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        {!remote && (
          <SettingRow
            id="start-at-login"
            error={presenceField === "startAtLogin" ? presenceSave.error : null}
            title="Start at login"
            description="Launch Infinitary when you sign in."
            control={
              <Switch
                checked={presence?.startAtLogin ?? false}
                disabled={!presence || presenceSave.saving}
                onChange={(checked) =>
                  presence && savePresence({ ...presence, startAtLogin: checked }, "startAtLogin")
                }
              />
            }
          />
        )}
        {/* Only a Mac has a Dock (design skill readme, "Linux desktop conventions"). */}
        {!remote && thisDesktop().dock && (
          <SettingRow
            id="show-in-dock"
            error={presenceField === "showInDock" ? presenceSave.error : null}
            title="Show in dock"
            description="Off hides the dock icon while the window stays."
            control={
              <Switch
                checked={presence?.showInDock ?? true}
                disabled={!presence || presenceSave.saving}
                onChange={(checked) =>
                  presence && savePresence({ ...presence, showInDock: checked }, "showInDock")
                }
              />
            }
          />
        )}
        <SettingRow
          id="notifications"
          error={notificationSave.error}
          title="Notify me when my first mate needs me"
          description="A quiet notification for decisions and reports while the window is in the background."
          control={
            <Switch
              checked={notifications ?? true}
              disabled={notifications === null || notificationSave.saving}
              onChange={saveNotifications}
            />
          }
        />
        {!remote && <DictationRow />}
        {!remote && <YourPanelsRow />}
        <SettingRow
          id="purge-task-data"
          title="Purge task data"
          description={
            purgedNote ??
            (purgesKnowledge
              ? "Removes every task, with its working copy, its notes and its cards, and all the knowledge the crew recorded."
              : "Removes every task, with its working copy, its notes and its cards.")
          }
          control={
            <Button
              variant={purgeArmed ? "danger" : "ghost"}
              size="sm"
              onClick={purge}
              pending={purging}
              pendingLabel="Purging..."
            >
              {purgeArmed ? "Confirm purge" : "Purge"}
            </Button>
          }
        />
      </div>
      <SharingSection />
      <WebsiteSignInsSection />
      <PrivateSitesSection />
      <LocalSeatSection />
      <div style={{ marginTop: SECTION_GAP, display: "grid", gap: ROW_GAP }}>
        <VersionRow />
        <UpdateChannelRow />
      </div>
    </div>
  );
}
