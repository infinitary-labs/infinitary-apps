import type { ComposerNotice } from "@shared/composer";
import * as m from "@shared/i18n/messages.generated";
import type { RepoSetupResult } from "@shared/repos";
import { create } from "zustand";

/**
 * A folder chosen in the system's picker and added as a project, as
 * Settings -> Projects adds one (docs/first-launch.md, "The welcome";
 * docs/fleet.md, "A folder that is not there"): the welcome's folder starter
 * and a card's Choose folder button share it. Only a window on the first
 * mate's own computer runs it, since the picker shows this computer's
 * folders; a view keeps its typed way.
 */
export type FolderPick =
  /** The picker was cancelled: nothing changed. */
  | { kind: "cancelled" }
  | { kind: "added"; result: RepoSetupResult }
  /** The picker or the add refused, in its own words. */
  | { kind: "refused"; text: string };

export async function pickProjectFolder(): Promise<FolderPick> {
  let path: string | null;
  try {
    path = await window.infinitary.app.chooseFolder();
  } catch {
    return { kind: "refused", text: m.settingsProjectsFolderPickerFailed() };
  }
  if (!path) return { kind: "cancelled" };
  try {
    return { kind: "added", result: await window.infinitary.repos.setup({ kind: "adopt", path }) };
  } catch (caught) {
    return { kind: "refused", text: caught instanceof Error ? caught.message : String(caught) };
  }
}

/** What the welcome says under its title once its folder starter added a project. */
export function folderAddedWords(result: RepoSetupResult): string {
  const name = result.repo.name;
  if (!result.created) return m.welcomeFolderAlreadyAdded({ name });
  return result.initializedGit ? m.welcomeFolderAddedGit({ name }) : m.welcomeFolderAdded({ name });
}

/**
 * The line a card shows under its title after its folder pick added a
 * project, by card id: the welcome stays up and names it. Shell state only.
 */
export const useFolderPickStore = create<{ said: Record<string, string> }>()(() => ({
  said: {},
}));

export function sayFolderAdded(cardId: string, words: string | null): void {
  useFolderPickStore.setState((s) => {
    const said = { ...s.said };
    if (words === null) delete said[cardId];
    else said[cardId] = words;
    return { said };
  });
}

/**
 * A folder dropped on the main message box (docs/composer.md, "Files"): its
 * setup card goes up with Add project, where the captain adds it; a folder
 * already on the list, or one the app refuses, answers the notice the box shows.
 */
export async function offerDroppedFolder(path: string): Promise<ComposerNotice | null> {
  try {
    const offered = await window.infinitary.repos.offerFolder(path);
    return offered.kind === "already" ? "folder-project" : null;
  } catch {
    return "folder-not-project";
  }
}
