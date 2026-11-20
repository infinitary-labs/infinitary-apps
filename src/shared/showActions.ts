import { z } from "zod";
import type { ActionLine } from "./actions";

/**
 * The built-in Settings sections by id, with the name the window shows each
 * (`src/renderer/src/plugins/builtin`), for the first mate's words. Observe
 * is a development and alpha build's own. What opens is decided where it
 * opens: a section the window offers now, the same check a panel's
 * `point.openSettings` meets, which opens nothing for one it does not offer.
 */
export const SETTINGS_SECTION_NAMES = {
  general: "General",
  appearance: "Appearance",
  panels: "Panels",
  keyboard: "Keyboard",
  projects: "Projects",
  subscriptions: "Intelligence",
  runbooks: "Runbooks",
  usage: "Usage",
  automation: "Automation",
  integrations: "Integrations",
  secrets: "Secrets",
  devices: "Devices",
  observe: "Observe",
} as const;

/** A Settings section by the id it was registered with, built in or a plugin's. */
export const settingsSectionSchema = z.string().trim().min(1).max(64);

/**
 * What a section shows on arrival, as a panel's `point.openSettings` names
 * it: one line of at most 128 characters.
 */
export const settingsItemSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\r\n]*$/);

/**
 * The request that opens Settings in the captain's window, a section and
 * what it shows: one shape for a panel's `point.openSettings` and the first
 * mate's `show-settings`.
 */
export const settingsShowSchema = z.strictObject({
  section: settingsSectionSchema,
  item: settingsItemSchema.optional(),
});
export type SettingsShow = z.infer<typeof settingsShowSchema>;

/**
 * Pointing, as `show-card` points at a card (primitives/app-actions.md):
 * the first mate opens what a panel already can with `point.openTask` and
 * `point.openSettings`. Each changes nothing, and each leaves one feed line
 * saying what it showed.
 */
export const showLines = {
  "show-task": {
    area: "general",
    tier: "asked",
    change: "inf:tasks:show",
    current: "inf:app:healthcheck",
    value: z.strictObject({ task: z.string().trim().min(1).max(64) }),
    line: "Open a task's record in the captain's window when they ask to see it: task is its key (INF-12) or id. It changes nothing and makes no card; show-card brings a card forward instead.",
    alwaysTrail: true,
    toRequest: (v) => [v.task],
    readValue: () => ({}),
    done: (v) => `opened the record of ${String(v.key || v.title)}`,
  },
  "show-settings": {
    area: "general",
    tier: "asked",
    change: "inf:settings:show",
    current: "inf:app:healthcheck",
    value: settingsShowSchema,
    line: `Open Settings in the captain's window on a section when they ask to see it: section is one of ${Object.keys(SETTINGS_SECTION_NAMES).join(", ")} (subscriptions is Intelligence; observe only on a build that has it). A window that does not offer that section opens nothing. item opens one thing there: a project's or repository's id in projects, a computer's id in devices, a page in secrets (decisions, phone, history, copy), an automation's id, or kept:<id> for a kept job, in automation. It changes nothing; every control there stays the captain's.`,
    alwaysTrail: true,
    toRequest: (v) => [{ section: v.section, ...(v.item ? { item: v.item } : {}) }],
    readValue: () => ({}),
    done: (v) =>
      `asked the window to open Settings → ${SETTINGS_SECTION_NAMES[v.section as keyof typeof SETTINGS_SECTION_NAMES] ?? v.section}`,
  },
} as const satisfies Record<string, ActionLine>;
