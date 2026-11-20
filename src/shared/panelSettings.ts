import type { ActionName } from "./actions";
import type { AppCostLimitView } from "./costLimit";
import type { PanelSettingName } from "./panelSettingNames";
import {
  type Appearance,
  ambientStyleOf,
  DEFAULT_AMBIENT_VOLUME,
  DEFAULT_APPEARANCE,
  type ShellPreferences,
  type UiSize,
} from "./preferences";

/**
 * Why an action catalog line has no panel value, so `settings.current`
 * refuses it: one ground from this closed set for every such line.
 */
export const PANEL_UNREADABLE = {
  act: "an act, a hand-over or a card: it holds no setting to read",
  names:
    "its value names projects, folders, computers, accounts, sign-ins, sites, integrations, runbooks, directions or an install",
  layout: "its value places every panel, not only the panel reading it",
  home: "only the computer that holds it reads it, never a view of it",
  read: "a panel reads it through a read of its own (quota.snapshot, automation.list or automation.kept)",
  unchecked: "how the crew's models are chosen: not yet checked field by field for a panel",
} as const;
export type PanelUnreadable = keyof typeof PANEL_UNREADABLE;

/**
 * What a panel reads of one catalog line: its panel value, read from the
 * line's own `current` answer as `readValue` reads it for the first mate,
 * but cut to what a panel may see; or the ground it is unreadable on.
 */
export type PanelSetting =
  | { value: (current: unknown) => Record<string, unknown> }
  | { unreadable: PanelUnreadable };

const look = (current: unknown) => current as Appearance;
/** The app's own look sets both, so a panel never reads either as missing. */
const DEFAULT_WASH = DEFAULT_APPEARANCE.washStrength as number;
const DEFAULT_SIZE = DEFAULT_APPEARANCE.size as UiSize;

const readable = {
  theme: { value: (c) => ({ theme: look(c).theme }) },
  font: { value: (c) => ({ fonts: look(c).fonts ?? {} }) },
  "window-wash": {
    value: (c) => ({ strength: look(c).washStrength ?? DEFAULT_WASH }),
  },
  "window-size": { value: (c) => ({ size: look(c).size ?? DEFAULT_SIZE }) },
  "crew-model-names": { value: (c) => ({ visible: look(c).showCrewModelNames ?? true }) },
  // A momentary hush stays inside the window; a pause is saved, so it reads.
  "ambient-music": {
    value: (c) => ({
      on: look(c).ambientMusic ?? false,
      paused: look(c).ambientPaused ?? false,
      style: ambientStyleOf(look(c).ambientStyle),
      volume: look(c).ambientVolume ?? DEFAULT_AMBIENT_VOLUME,
    }),
  },
  notifications: { value: (c) => ({ enabled: c as boolean }) },
  "cost-limit": { value: (c) => ({ limit: (c as AppCostLimitView).limit }) },
  "personal-resources": { value: (c) => ({ enabled: c as boolean }) },
  "panels-switch": { value: (c) => ({ enabled: (c as ShellPreferences).panels.enabled }) },
} satisfies Record<PanelSettingName, PanelSetting>;

/** The value each readable line answers, as the core builds it. */
export type PanelSettingValuesRead = {
  [K in PanelSettingName]: ReturnType<(typeof readable)[K]["value"]>;
};

/**
 * Every action catalog line, with what a panel may read of it
 * (primitives/live-reads.md, "settings.current"). A line added to the
 * catalog does not compile until it is named here: a panel value, or a
 * ground from `PANEL_UNREADABLE`.
 */
export const PANEL_SETTINGS: Record<ActionName, PanelSetting> = {
  ...readable,
  "project-setup": { unreadable: "names" },
  "project-remove": { unreadable: "names" },
  "project-settings": { unreadable: "names" },
  "project-move": { unreadable: "names" },
  "project-name": { unreadable: "names" },
  "project-runs-on": { unreadable: "names" },
  "device-invite": { unreadable: "names" },
  "private-site-allow": { unreadable: "names" },
  "device-remove": { unreadable: "names" },
  "device-update": { unreadable: "names" },
  "device-sign-in": { unreadable: "names" },
  "device-address": { unreadable: "act" },
  panel: { unreadable: "layout" },
  "voice-model": { unreadable: "home" },
  "account-sign-in": { unreadable: "act" },
  "custom-connection": { unreadable: "act" },
  "decision-key": { unreadable: "act" },
  "panel-remove": { unreadable: "act" },
  "task-actions": { unreadable: "act" },
  settle: { unreadable: "act" },
  "card-close": { unreadable: "act" },
  "plugin-consent": { unreadable: "act" },
  recovery: { unreadable: "act" },
  "ask-first-merge": { unreadable: "act" },
  "show-card": { unreadable: "act" },
  "show-whats-new": { unreadable: "home" },
  direction: { unreadable: "names" },
  "start-at-login": { unreadable: "home" },
  "show-in-dock": { unreadable: "home" },
  "release-page": { unreadable: "home" },
  "integration-add": { unreadable: "names" },
  "integration-add-mcp": { unreadable: "names" },
  "integration-remove": { unreadable: "names" },
  "delete-outside": { unreadable: "names" },
  "integration-settings": { unreadable: "names" },
  "integration-action-rule": { unreadable: "names" },
  "integration-key": { unreadable: "act" },
  "integration-check": { unreadable: "names" },
  "forge-sign-out": { unreadable: "names" },
  diagnostics: { unreadable: "names" },
  contribution: { unreadable: "names" },
  "sharing-ask": { unreadable: "names" },
  purge: { unreadable: "act" },
  dictation: { unreadable: "home" },
  "firstmate-model": { unreadable: "unchecked" },
  "firstmate-account": { unreadable: "names" },
  "crew-slots": { unreadable: "unchecked" },
  "crew-speed": { unreadable: "unchecked" },
  "crew-reasoning": { unreadable: "unchecked" },
  "crew-slots-reset": { unreadable: "unchecked" },
  "model-pins": { unreadable: "unchecked" },
  "decision-model": { unreadable: "unchecked" },
  "refresh-usage": { unreadable: "read" },
  "account-rename": { unreadable: "names" },
  "account-pause": { unreadable: "names" },
  "account-prefer": { unreadable: "names" },
  "account-keep-going": { unreadable: "names" },
  "account-disconnect": { unreadable: "names" },
  "projects-folder": { unreadable: "names" },
  "project-batch-answer": { unreadable: "names" },
  runbook: { unreadable: "names" },
  "runbook-copy": { unreadable: "names" },
  "panel-collapse": { unreadable: "layout" },
  "automation-edit": { unreadable: "read" },
  "automation-state": { unreadable: "read" },
  "automation-pause-all": { unreadable: "read" },
  "automation-notes": { unreadable: "read" },
  "automation-delete": { unreadable: "read" },
  "kept-job-remove": { unreadable: "read" },
};

/** The panel value of each named line from its `current` answer, by that answer's channel. */
export async function panelSettingsNow(
  names: readonly PanelSettingName[],
  readCurrent: (name: PanelSettingName) => Promise<unknown>,
): Promise<Record<string, Record<string, unknown>>> {
  const answer: Record<string, Record<string, unknown>> = {};
  for (const name of new Set(names)) answer[name] = readable[name].value(await readCurrent(name));
  return answer;
}
