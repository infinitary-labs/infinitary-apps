/*
 * What a launch refused the folder's lock keeps in the data folder for the copy of the app that
 * shows the person a word (src/main/personWord.ts, docs/run.md, "Opened while it runs"): a profile
 * made under a name no one else chose, and a record naming it, which is the app's evidence that the
 * profile is its own. Kept apart from the person's saved work, so a folder move neither counts nor
 * deletes them (src/core/folderMove/due.ts).
 */

/** The records naming the profile, the first, or the next where something else is at a name. */
export const WORD_RECORDS = [
  "word-profile.json",
  "word-profile-2.json",
  "word-profile-3.json",
] as const;

/** The start of a profile's name; the rest is six letters or digits chosen as it is made. */
export const WORD_PROFILE_PREFIX = "word-profile-";

const PROFILE_NAME = /^word-profile-[A-Za-z0-9]{6}$/;

/** Whether `name` is a profile's name, as made with `WORD_PROFILE_PREFIX`. */
export function isWordProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

/** Whether an entry of the data folder is the copy's: a profile, a record or a record being written. */
export function isWordState(name: string): boolean {
  return (
    isWordProfileName(name) ||
    WORD_RECORDS.some((record) => name === record || name.startsWith(`${record}.`))
  );
}
