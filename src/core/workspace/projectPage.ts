import { lstatSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isProjectPath, projectPagePathRefusal } from "@shared/projectPage";

/**
 * The real file a path names inside a folder (docs/task-browser.md, "A page
 * from the project"), or why there is none, in words the captain or the
 * crewmate reads. The folder is resolved once; below it every part of the
 * path is read without following it, so a link anywhere on the way - to a
 * file outside the folder or inside it - is refused, and so is anything at
 * the end that is not a regular file. The rules on the path's words come
 * first (`isProjectPath`), so no file is read for a path that could not be
 * one. A few reads of the path's own parts, in turn, so a card's emit stays
 * synchronous.
 */
export function projectFile(
  folder: string,
  path: string,
  place = "the project folder",
): { file: string } | { refusal: string } {
  if (!isProjectPath(path)) return { refusal: `Only a file inside ${place} opens.` };
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return { refusal: `${capitalized(place)} is not on this Mac.` };
  }
  const parts = path.split("/");
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    const last = index === parts.length - 1;
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return { refusal: `There is no ${path} in ${place} yet.` };
    if (stat.isSymbolicLink()) {
      return {
        refusal: `${path} goes through a link in ${place}, and a page never opens through one.`,
      };
    }
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      return { refusal: `${path} in ${place} is not a file.` };
    }
  }
  const inside = relative(root, at);
  if (!inside || inside.startsWith(`..${sep}`) || inside === "..") {
    return { refusal: `Only a file inside ${place} opens.` };
  }
  return { file: at };
}

/** `projectFile` for a page itself: the same checks, and an HTML file. */
export function projectPageFile(
  folder: string,
  path: string,
  place = "the project folder",
): { file: string } | { refusal: string } {
  if (projectPagePathRefusal(path)) {
    return { refusal: `Only an HTML file inside ${place} opens.` };
  }
  return projectFile(folder, path, place);
}

function capitalized(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
