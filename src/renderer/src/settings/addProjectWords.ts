import * as m from "@shared/i18n/messages.generated";
import { HERE } from "../../../shared/deviceNames";
/** The words Settings → Projects → Add project says (`AddProject.tsx`). */

export const ADD_PROJECT_WORDS = {
  /** Said after adding a folder that had no git yet. */
  get startedGit() {
    return m.settingsAddProjectStartedGit();
  },
  /** The button that adds a folder already on this computer. */
  get folderHere() {
    return m.settingsAddProjectFolderHere();
  },
  /** Said after a pasted link for a host other than the one chosen. */
  get otherHost() {
    return m.settingsAddProjectOtherHost();
  },
} as const;

/** Where a new project starts, and where its changes merge: this computer, or the first mate's by its name. */
export function newProjectWords(folder: string, place: { this: string } = HERE): string {
  return m.settingsAddProjectNewProject({ folder, place: place.this });
}

/**
 * On a computer that controls another, a folder is added from that computer
 * by its path there, since a folder picker here shows only this computer's
 * folders (docs/view.md, "Settings on a view").
 */
export const FOLDER_THERE_WORDS = {
  button: (mac: string) => m.settingsAddProjectFolderOn({ computer: mac }),
  label: (mac: string) => m.settingsAddProjectFolderPathOn({ computer: mac }),
  get add() {
    return m.settingsAddProjectAddFolder();
  },
} as const;

/** The task key field: the key the next added project's tasks are numbered with. */
export const TASK_KEY_WORDS = {
  get label() {
    return m.settingsAddProjectTaskKey();
  },
  get placeholder() {
    return m.settingsAddProjectTaskKeyPlaceholder();
  },
  next: (key: string) => m.settingsAddProjectTaskKeyNext({ key }),
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
  return m.settingsAddProjectSignIn({ host });
}
