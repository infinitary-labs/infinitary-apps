import { describe, expect, it } from "vitest";
import { APP_PANEL_COMMAND_WORDS } from "./appPanelWords.ts";
import { inLanguage } from "./i18n/current.ts";
import { SOURCE_LANGUAGE } from "./i18n/languages.ts";
import * as m from "./i18n/messages.generated.ts";
import { type PanelCommand, panelCommandEntry, panelCommandId } from "./keyboard.ts";
import { APP_PANEL_FOLDERS } from "./surfaces.ts";

/**
 * The app's own panels' command names come from the catalog in every
 * language, so command search and Keyboard settings show them translated
 * (INF-5299, the captain's "Translate the names in both the app and docs").
 * Each panel's manifest keeps its English as its author's format; these
 * hold the manifests and the catalog's table to one another.
 */

/** Every command the app's own panel folders name, as the window installs them. */
const appPanelCommands: PanelCommand[] = APP_PANEL_FOLDERS.flatMap((folder) =>
  (folder.manifest.commands ?? []).map(
    (command): PanelCommand => ({
      id: panelCommandId(folder.id, command.id),
      label: command.label,
      panel: folder.manifest.title ?? folder.id,
      keys: [],
      ...(command.words?.length ? { words: [...command.words] } : {}),
      own: true,
    }),
  ),
);

describe("the app's own panels' command words", () => {
  it("word every app panel's command from the catalog, its English the manifest's", () => {
    expect(appPanelCommands.length).toBeGreaterThan(0);
    for (const command of appPanelCommands) {
      expect(APP_PANEL_COMMAND_WORDS[command.id], command.id).toBeDefined();
      const entry = panelCommandEntry(command);
      const english = inLanguage(SOURCE_LANGUAGE, () => ({
        label: entry.label,
        words: entry.searchWords,
      }));
      expect(english, command.id).toEqual({ label: command.label, words: command.words });
    }
  });

  it("name no command an app panel does not have", () => {
    const named = new Set<string>(appPanelCommands.map((command) => command.id));
    expect(Object.keys(APP_PANEL_COMMAND_WORDS).filter((id) => !named.has(id))).toEqual([]);
  });

  it("read in the language of the moment, and another panel's command as its manifest names it", () => {
    const board = appPanelCommands.find((command) => command.id === "panel:now/board");
    if (!board) throw new Error("the Tasks panel has no board command");
    const own = panelCommandEntry(board);
    const arabic = inLanguage("ar", () => ({ label: own.label, words: own.searchWords }));
    expect(arabic.label).toBe(inLanguage("ar", () => m.commandPanelNowBoard()));
    expect(arabic.label).not.toBe(board.label);
    expect(arabic.words).not.toEqual(board.words);
    expect(inLanguage(SOURCE_LANGUAGE, () => own.label)).toBe(board.label);

    const { own: _, ...elsewhere } = board;
    const copy = panelCommandEntry(elsewhere);
    expect(inLanguage("ar", () => ({ label: copy.label, words: copy.searchWords }))).toEqual({
      label: board.label,
      words: board.words,
    });
  });
});
