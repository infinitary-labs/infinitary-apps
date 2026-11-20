import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { staleGeneratedFile } from "./github-errors.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * The docs site's Keyboard page (docs/docs-site.md, "Generated pages"),
 * written from the app's own command list so it never says a key the app
 * does not have: every command a person can run from the keyboard, with the
 * keys Keyboard settings gives it in each preset, on a Mac and on Linux. The
 * keys are the window's own resolution (`resolveBindings`) of a preset with
 * nothing changed, the app's own panels' commands included, so a key a
 * preset suggests that another command already holds is left out here as it
 * is in the app.
 *
 *   node scripts/docs-site-keyboard.ts           writes the page
 *   node scripts/docs-site-keyboard.ts --check   fails when the page is out of step
 */

export const KEYBOARD_PAGE = "docs-site/src/content/docs/keyboard.mdx";

/** The app's own panels whose commands read as the window's, in the order the app adds them. */
const OWN_PANELS = ["src/panels/now/manifest.json", "src/panels/knowledge/manifest.json"];

type Chord = { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean };
type Binding = Chord & { second?: Chord; when?: "not-typing" };
type System = "mac" | "ctrl";
type Scope = "window" | "message-field" | "main-message";
type PanelCommand = {
  id: `panel:${string}`;
  label: string;
  panel: string;
  keys: Binding[];
  words?: string[];
  own?: true;
};
type ManifestCommand = { id: string; label: string; key?: string; words?: string[] };

/** What the page reads from the app's keyboard modules. */
export type KeyboardModules = {
  keyboard: {
    KEYBOARD_COMMANDS: Record<string, { label: string; scope: Scope; section?: string }>;
    allCommandIds: (panels: readonly PanelCommand[]) => string[];
    isCatalogCommand: (id: string) => boolean;
    bindingLabel: (binding: Binding, system: System) => string;
    keysOf: (bindings: unknown, id: string) => readonly Binding[];
  };
  keymap: {
    presetKeymap: (preset: string) => unknown;
    resolveBindings: (saved: unknown, panels: readonly PanelCommand[], system: System) => unknown;
    SCOPE_WORDS: Record<Scope, string>;
  };
  presets: {
    PRESET_IDS: readonly string[];
    PRESET_LABELS: Record<string, string>;
    NEW_PROFILE_PRESET: string;
  };
  panelCards: { parseSuggestedKey: (text: string) => Chord | null };
};

/** The app's own panels' commands, as the window installs them (`panelCommandsOf`). */
export function ownPanelCommands(modules: KeyboardModules): PanelCommand[] {
  return OWN_PANELS.flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as {
      title: string;
      commands?: ManifestCommand[];
    };
    const panel = path.split("/").at(-2) ?? "";
    return (manifest.commands ?? []).map((command): PanelCommand => {
      const chord = command.key === undefined ? null : modules.panelCards.parseSuggestedKey(command.key);
      return {
        id: `panel:${panel}/${command.id}` as const,
        label: command.label,
        panel: manifest.title,
        keys: chord ? [chord] : [],
        ...(command.words?.length ? { words: [...command.words] } : {}),
        own: true,
      };
    });
  });
}

/** One row of the page: a command, where it works, and its keys on each system, each drawn as key caps. */
export type KeyRow = { id: string; label: string; scope: Scope; mac: string[]; linux: string[] };

/**
 * Every command a preset gives a person, in the order Keyboard settings
 * lists them. A command that acts in a Settings section some builds do not
 * offer (`section`) is left out, as those builds leave it out.
 */
export function presetRows(modules: KeyboardModules, preset: string): KeyRow[] {
  const panels = ownPanelCommands(modules);
  const saved = modules.keymap.presetKeymap(preset);
  const mac = modules.keymap.resolveBindings(saved, panels, "mac");
  const linux = modules.keymap.resolveBindings(saved, panels, "ctrl");
  const words = (binding: Binding, system: System) =>
    `<kbd>${cell(modules.keyboard.bindingLabel(binding, system))}</kbd>` +
    (binding.when === "not-typing" ? " when not typing" : "");
  return modules.keyboard.allCommandIds(panels).flatMap((id): KeyRow[] => {
    const catalog = modules.keyboard.isCatalogCommand(id)
      ? modules.keyboard.KEYBOARD_COMMANDS[id]
      : undefined;
    if (catalog?.section) return [];
    const label = catalog?.label ?? panels.find((command) => command.id === id)?.label ?? id;
    return [
      {
        id,
        label,
        scope: catalog?.scope ?? "window",
        mac: modules.keyboard.keysOf(mac, id).map((binding) => words(binding, "mac")),
        linux: modules.keyboard.keysOf(linux, id).map((binding) => words(binding, "ctrl")),
      },
    ];
  });
}

/** Text inside a table cell, with nothing Markdown or HTML would read as its own. */
function cell(text: string): string {
  return text.replace(/[^\p{L}\p{N}\p{S} ’'.,()+=-]|[\\|<>&`^~{}[\]*_#]/gu, (character) => `&#${character.codePointAt(0)};`);
}

function keys(list: string[]): string {
  return list.length === 0 ? "—" : list.join(", ");
}

function table(rows: KeyRow[]): string[] {
  return [
    "| Command | Mac | Linux |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${cell(row.label)} | ${keys(row.mac)} | ${keys(row.linux)} |`),
  ];
}

/** The whole page, from the app's modules. */
export function keyboardPage(modules: KeyboardModules): string {
  const { PRESET_IDS, PRESET_LABELS, NEW_PROFILE_PRESET } = modules.presets;
  const ordered = [NEW_PROFILE_PRESET, ...PRESET_IDS.filter((id) => id !== NEW_PROFILE_PRESET)];
  const scopes: Scope[] = ["window", "message-field", "main-message"];
  const tabs = ordered.flatMap((preset) => {
    const rows = presetRows(modules, preset);
    const sections = scopes.flatMap((scope) => {
      const here = rows.filter((row) => row.scope === scope);
      return here.length === 0
        ? []
        : ["", `**${cell(modules.keymap.SCOPE_WORDS[scope])}**`, "", ...table(here)];
    });
    return [`<TabItem label="${PRESET_LABELS[preset]}">`, ...sections, "", "</TabItem>"];
  });
  const presetNames = ordered.map((id) => PRESET_LABELS[id]).join(", ");
  return [
    "---",
    "title: Keyboard",
    "description: Every command you can run from the keyboard in Infinitary, and its keys in each preset on a Mac and on Linux.",
    "---",
    "",
    "{/* Written by node scripts/docs-site-keyboard.ts from the app's own command list. Do not edit by hand. */}",
    "",
    "import { TabItem, Tabs } from '@astrojs/starlight/components';",
    "",
    "Everything in Infinitary works from the keyboard.",
    "Tab moves between controls, and the arrows move inside a list.",
    "",
    "## Command search",
    "",
    "Press <kbd>⌘K</kbd> on a Mac, or <kbd>Ctrl+K</kbd> on Linux, to open command search.",
    "Type a few words, choose a command with the arrows and press Enter.",
    "Every command on this page is there, with its key beside it, including the ones that have no key.",
    "",
    "## Presets",
    "",
    `Infinitary comes with sets of keys called presets: ${presetNames}.`,
    `A new installation starts on ${PRESET_LABELS[NEW_PROFILE_PRESET]}.`,
    "Legacy is offered only if you used Infinitary before presets existed.",
    "Choose a preset in **Settings**, under **Keyboard**.",
    "",
    "## Change a key",
    "",
    "In **Settings**, under **Keyboard**, every command has **Record**, **Remove** and **Reset**.",
    "Press **Record**, then the keys you want, then Enter to save them.",
    "If another command already uses those keys, Infinitary says which one before anything changes.",
    "",
    "## Every command and its keys",
    "",
    "A dash means the command has no key yet: run it from command search, or give it a key of your own.",
    "Two keys with a space between them are pressed one after the other.",
    "",
    "<Tabs syncKey=\"keyboard-preset\">",
    ...tabs,
    "</Tabs>",
    "",
  ].join("\n");
}

/** Loads the app's keyboard modules the way the app's tests do. */
export async function loadKeyboardModules(): Promise<{ modules: KeyboardModules; close: () => Promise<void> }> {
  const runner = await openModuleRunner();
  const modules: KeyboardModules = {
    keyboard: await runner.import("/src/shared/keyboard.ts"),
    keymap: await runner.import("/src/shared/keymap.ts"),
    presets: await runner.import("/src/shared/keyPresets.ts"),
    panelCards: await runner.import("/src/shared/plugins/panelCards.ts"),
  };
  return { modules, close: runner.close };
}

if (process.argv[1]?.endsWith("docs-site-keyboard.ts")) {
  const { modules, close } = await loadKeyboardModules();
  const page = keyboardPage(modules);
  await close();
  const path = join(REPO_ROOT, KEYBOARD_PAGE);
  if (!process.argv.includes("--check")) writeFileSync(path, page);
  else if (readFileSync(path, "utf8") !== page)
    throw staleGeneratedFile(KEYBOARD_PAGE, "node scripts/docs-site-keyboard.ts");
}
