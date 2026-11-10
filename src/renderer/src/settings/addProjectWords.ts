import { HERE } from "../../../shared/deviceNames";
/** The words Settings → Projects → Add project says (`AddProject.tsx`). */

/** Said after adding a folder that had no git yet. */
export const STARTED_GIT_WORDS = "Started git in this folder with an empty first commit.";

/** Where a new project starts, and where its changes merge: this computer, or the first mate's by its name. */
export function newProjectWords(folder: string, place: { this: string } = HERE): string {
  return `An empty project in ${folder}. Its changes merge on ${place.this}; you can change that in its row.`;
}

/** The button that adds a folder already on this computer. */
export const FOLDER_HERE_WORDS = `Folder on ${HERE.this}`;

/**
 * On a computer that controls another, a folder is added from that computer
 * by its path there, since a folder picker here shows only this computer's
 * folders (docs/view.md, "Settings on a view").
 */
export const FOLDER_THERE_WORDS = {
  button: (mac: string) => `Folder on ${mac}`,
  label: (mac: string) => `The folder's path on ${mac}`,
  add: "Add folder",
} as const;

/** Said after a pasted link for a host other than the one chosen. */
export const OTHER_HOST_WORDS = "For another host, ask your first mate.";

/** The task key field: the key the next added project's tasks are numbered with. */
export const TASK_KEY_WORDS = {
  label: "Task key",
  placeholder: "From its name",
  next: (key: string) =>
    `Tasks in the next project you add are numbered ${key}-1, ${key}-2 and so on.`,
} as const;

/** What the field keeps of what was typed: up to four letters or digits, in capitals. */
export function taskKeyTyped(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

/** The signed-out host selector opens the same sign-in as its Integration chip. */
export function projectSignInWords(host: string): string {
  return `Sign in to ${host}`;
}
