import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { keyboardPresets, MIGRATIONS } from "../../src/core/storage/migrations";
import { bindingLabel, type CommandId, type KeyBinding } from "../../src/shared/keyboard";
import { type PresetId, presetKeys } from "../../src/shared/keyPresets";
import { scratchDir } from "../helpers/scratchDirs";
import { THIS_DESKTOP } from "./desktop";
import { launchApp } from "./launch";
import { promptInput } from "./prompt";
import { boardCard } from "./taskBoard";
import {
  commandSearch,
  endRecording,
  focusOn,
  keyboardSettings,
  pressKey,
  pressWindowKey,
  runFromSearch,
  startRecording,
} from "./windowKeys";

/**
 * Keyboard presets (docs/keyboard.md, "Presets"; INF-3547's accepted plan,
 * piece 4: "Each preset keeps its own changes, and Reset all keys returns
 * to the chosen preset", "Each preset has its own e2e journey driven by its
 * keys"). One journey per preset in the real app: the Preset row picked by
 * the arrows, the preset's keys shown on its rows, a key of a person's own
 * kept through another preset and back, Reset all keys returning to the
 * preset's, and the preset's own keys pressed through the window's input
 * path doing what they promise. Completion is the screen: the row's checked
 * pill, the keys each row shows, and the dialog, section or field a key
 * opens. No sign-in, personal data or shared resource, and no platform
 * prerequisite: each system presses its own preset keys (`presetKeys`).
 */

/** A key no preset gives, which a person records in each journey. */
const OWN_KEY: KeyBinding = { key: "F9" };

/** The keys a row shows, as this computer draws them. */
function labels(bindings: readonly KeyBinding[]): string[] {
  return bindings.map((binding) => bindingLabel(binding, THIS_DESKTOP.keys));
}

/** Expects a command's row to show exactly these keys. */
async function showsKeys(page: Page, id: CommandId, bindings: readonly KeyBinding[]) {
  await expect(keyboardSettings(page).row(id).locator("[data-keyboard-key]")).toHaveCount(
    bindings.length,
  );
  const shown = await keyboardSettings(page)
    .row(id)
    .locator("[data-keyboard-key]")
    .evaluateAll((keys) => keys.map((key) => key.getAttribute("data-keyboard-key")));
  expect(shown).toEqual(labels(bindings));
}

/** Expects a command's row to show a preset's own keys for it, unchanged. */
async function showsPresetKeys(page: Page, preset: PresetId, id: CommandId) {
  await expect(keyboardSettings(page).row(id)).not.toHaveAttribute("data-keyboard-changed");
  await showsKeys(page, id, presetKeys(preset, id, THIS_DESKTOP.keys));
}

/** Picks a preset in the Preset row by the arrows, as a person does from the keyboard. */
async function pickPreset(page: Page, preset: PresetId) {
  const keyboard = keyboardSettings(page);
  const count = await keyboard.presets.count();
  for (let i = 0; i < count; i++) {
    if (await keyboard.preset(preset).isChecked()) break;
    await pressKey(keyboard.presets.and(page.locator(":checked")), "ArrowRight");
  }
  await expect(keyboard.preset(preset)).toBeChecked();
}

/**
 * The plan's "each preset keeps its own changes": a key recorded in the
 * preset stays through another preset and back, and Reset all keys puts
 * the preset's own keys back with the preset still chosen.
 */
async function keepsItsChanges(
  app: ElectronApplication,
  page: Page,
  preset: PresetId,
  other: PresetId,
) {
  const keyboard = keyboardSettings(page);
  await startRecording(page, "settings.open");
  await pressWindowKey(app, OWN_KEY.key);
  await endRecording(app, page, "Enter");
  await expect(keyboard.row("settings.open")).toHaveAttribute("data-keyboard-changed", "true");
  await showsKeys(page, "settings.open", [OWN_KEY]);

  await pickPreset(page, other);
  await showsPresetKeys(page, other, "settings.open");
  await pickPreset(page, preset);
  await expect(keyboard.row("settings.open")).toHaveAttribute("data-keyboard-changed", "true");
  await showsKeys(page, "settings.open", [OWN_KEY]);

  await pressKey(keyboard.resetAll, "Enter");
  await pressKey(keyboard.resetAll, "Enter");
  await showsPresetKeys(page, preset, "settings.open");
  await expect(keyboard.preset(preset)).toBeChecked();
}

/** Settings' first tab, which shows while Settings is open. */
function settingsOpen(page: Page) {
  return page.getByRole("tab", { name: "General", exact: true });
}

test("Vim: a new profile starts on it, with no Legacy, and moves by its plain keys", async () => {
  const launched = await launchApp({ withMockProvider: true, keys: "new-profile" });
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const prompt = promptInput(page);
  try {
    await test.step("the Preset row offers Vim, chosen, and no Legacy", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await expect(keyboard.preset("vim")).toBeChecked();
      await expect(keyboard.preset("vscode")).toBeVisible();
      await expect(keyboard.preset("emacs")).toBeVisible();
      await expect(keyboard.preset("legacy")).toHaveCount(0);
      await showsPresetKeys(page, "vim", "move.down");
      await showsPresetKeys(page, "vim", "regions.left");
    });

    await test.step("Vim's keys go to Settings and back to the main message", async () => {
      await runFromSearch(app, page, "focus.main-message");
      await expect(prompt).toBeFocused();
      await pressWindowKey(app, "Escape");
      await expect(prompt).not.toBeFocused();
      await pressWindowKey(app, "g");
      await pressWindowKey(app, "s");
      await expect(settingsOpen(page)).toBeVisible();
      await runFromSearch(app, page, "focus.main-message");
      await pressWindowKey(app, "Escape");
      await expect(prompt).not.toBeFocused();
      await pressWindowKey(app, "i");
      await expect(prompt).toBeFocused();
    });

    await test.step("Vim keeps its own changes, and Reset all keys returns to it", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await keepsItsChanges(app, page, "vim", "vscode");
    });
  } finally {
    await launched.close();
  }
});

test("Emacs: picked in the Preset row, and driven by ⌥X, ⌃G, ⌃H, ⌃X and ⌃K", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const search = commandSearch(page);
  const prompt = promptInput(page);
  try {
    await test.step("the Preset row picks Emacs and shows its keys", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await pickPreset(page, "emacs");
      await showsPresetKeys(page, "emacs", "cancel");
      await showsPresetKeys(page, "emacs", "regions.next");
    });

    await test.step("Emacs keeps its own changes, and Reset all keys returns to it", async () => {
      await keepsItsChanges(app, page, "emacs", "vim");
    });

    await test.step("⌥X searches commands, ⌃G cancels it, and ⌃H B opens the keys", async () => {
      // ⌘L (Ctrl+L on Linux) goes to the main message in Emacs on both systems;
      // command search's Ctrl+K deletes a line there on Linux.
      await pressWindowKey(app, "l", ["meta"]);
      await expect(prompt).toBeFocused();
      await pressWindowKey(app, "x", ["alt"]);
      await expect(search.dialog).toBeVisible();
      await pressWindowKey(app, "g", ["control"]);
      await expect(search.dialog).toHaveCount(0);
      await focusOn(prompt);
      await pressWindowKey(app, "Escape");
      await expect(prompt).not.toBeFocused();
      await pressWindowKey(app, "h", ["control"]);
      await pressWindowKey(app, "b");
      await expect(keyboard.section).toBeVisible();
      await expect(keyboard.preset("emacs")).toBeChecked();
    });

    // INF-3547's later piece 5, the captain's approved Linux keys: outside a
    // message Ctrl+X starts Emacs's commands, and in one Ctrl+K deletes to the
    // end of the line, on Linux as on a Mac.
    await test.step("⌃K deletes to the end of the line, and ⌃X ⌃B opens the task board", async () => {
      await pressWindowKey(app, "l", ["meta"]);
      await expect(prompt).toBeFocused();
      await prompt.fill("keep this line");
      // The caret at the line's start: Home there scrolls on a Mac and moves it on Linux.
      await prompt.evaluate((field) => (field as HTMLTextAreaElement).setSelectionRange(0, 0));
      await expect(prompt).toBeFocused();
      await pressWindowKey(app, "k", ["control"]);
      await expect(prompt).toHaveValue("");
      await pressWindowKey(app, "Escape");
      await expect(prompt).not.toBeFocused();
      await pressWindowKey(app, "x", ["control"]);
      await pressWindowKey(app, "b", ["control"]);
      await expect(boardCard(page)).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

test("VS Code: picked in the Preset row, and driven by ⇧⌘P and ⌘K ⌘S", async () => {
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const search = commandSearch(page);
  const prompt = promptInput(page);
  try {
    await test.step("the Preset row picks VS Code and shows its keys", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await pickPreset(page, "vscode");
      await showsPresetKeys(page, "vscode", "commands.search");
      await showsPresetKeys(page, "vscode", "settings.keyboard");
    });

    await test.step("VS Code keeps its own changes, and Reset all keys returns to it", async () => {
      await keepsItsChanges(app, page, "vscode", "legacy");
    });

    await test.step("⇧⌘P searches commands, and ⌘K waits for ⌘S to open the keys", async () => {
      await pressWindowKey(app, "l", ["meta"]);
      await expect(prompt).toBeFocused();
      await expect(keyboard.section).toHaveCount(0);
      await pressWindowKey(app, "p", ["meta", "shift"]);
      await expect(search.dialog).toBeVisible();
      await pressWindowKey(app, "Escape");
      await expect(search.dialog).toHaveCount(0);
      await pressWindowKey(app, "k", ["meta"]);
      await expect(search.dialog).toHaveCount(0);
      await pressWindowKey(app, "s", ["meta"]);
      await expect(keyboard.section).toBeVisible();
      await expect(keyboard.preset("vscode")).toBeChecked();
    });
  } finally {
    await launched.close();
  }
});

test("Legacy: a profile updated from before presets stays on it with its changed key", async () => {
  // A profile an older version kept, with a key its person changed in it.
  const userDataDir = scratchDir("infinitary-keyboard-presets-");
  // Saved as it stood just before the presets migration, wherever later migrations put it.
  const db = openDatabase(userDataDir, MIGRATIONS.indexOf(keyboardPresets));
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "keyboard",
    JSON.stringify({ version: 1, keys: { "settings.open": [OWN_KEY] } }),
  );
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true, keys: "new-profile" });
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const prompt = promptInput(page);
  try {
    await test.step("Legacy is offered and chosen, with the key it changed", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await expect(keyboard.preset("legacy")).toBeChecked();
      await expect(keyboard.preset("vim")).toBeVisible();
      await expect(keyboard.row("settings.open")).toHaveAttribute("data-keyboard-changed", "true");
      await showsKeys(page, "settings.open", [OWN_KEY]);
      await showsPresetKeys(page, "legacy", "commands.search");
    });

    await test.step("the changed key opens Settings", async () => {
      await runFromSearch(app, page, "focus.main-message");
      await expect(prompt).toBeFocused();
      await pressWindowKey(app, OWN_KEY.key);
      await expect(settingsOpen(page)).toBeVisible();
    });

    await test.step("Legacy keeps its change through Vim and back, and Reset all keys returns to it", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await pickPreset(page, "vim");
      await showsPresetKeys(page, "vim", "settings.open");
      await pickPreset(page, "legacy");
      await showsKeys(page, "settings.open", [OWN_KEY]);
      await pressKey(keyboard.resetAll, "Enter");
      await pressKey(keyboard.resetAll, "Enter");
      await showsPresetKeys(page, "legacy", "settings.open");
      await expect(keyboard.preset("legacy")).toBeChecked();
    });
  } finally {
    await launched.close();
  }
});
