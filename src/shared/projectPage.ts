import { PROJECT_PAGE_PATH_MAX } from "./cards";

/**
 * A page from a task's project (docs/task-browser.md, "A page from the
 * project"): an HTML file a crewmate names on its card's browser button
 * with `browser_page`, which the captain's click opens in that task's own
 * browser. The path is the crewmate's, relative to the project folder;
 * these are the typed rules it must meet before the host looks at any file.
 * The host checks the file itself, inside the folder, at emit, at every
 * click and for every file the page asks for (`projectFile`,
 * src/core/workspace/projectPage.ts).
 */

/** What the strip says a click on its button does, after the file's path. */
export const PAGE_ATTACHMENT_WORDS = "opens in this task's browser";

/** The file kinds a page may be: the ones a browser opens as a page. */
export const PROJECT_PAGE_EXTENSIONS = [".html", ".htm"] as const;

/** What a page's path must name, as the host says it when a path is not one it opens. */
export const PROJECT_PAGE_RULE =
  "an HTML file (.html or .htm) inside the project folder, named relative to it such as index.html or game/index.html, with no .. and no .git";

/**
 * Whether a path is written as one inside a folder: relative, with forward
 * slashes, no empty, `.` or `..` part, no part named `.git` and no control
 * character. It says nothing of the file kind.
 */
export function isProjectPath(path: string): boolean {
  if (!path || path.length > PROJECT_PAGE_PATH_MAX) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path
    .split("/")
    .some((part) => part === "" || part === "." || part === ".." || part === ".git");
}

/**
 * Why a path is not one a page may have, in words, or undefined when it may:
 * a path inside the folder (`isProjectPath`) that ends in an HTML extension.
 */
export function projectPagePathRefusal(path: string): string | undefined {
  if (!isProjectPath(path)) return PROJECT_PAGE_RULE;
  const lower = path.toLowerCase();
  if (!PROJECT_PAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return PROJECT_PAGE_RULE;
  }
  return undefined;
}
