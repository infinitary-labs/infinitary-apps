import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The words a fenced session's read hears when its path leaves the working copy. */
export function outsideWorkingCopyText(path: string): string {
  // i18n-exempt: a refusal served to the crewmate's read tool
  return `Refused: ${path} is outside this task's working copy. An unsafe data reader reads only its own project's files.`;
}

/**
 * The real path of `path`, or of its nearest existing ancestor joined with
 * the rest: a path that does not exist yet still resolves through the links
 * above it, so a missing file under a link out of the working copy is still
 * outside.
 */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(realOf(parent), relative(parent, path));
  }
}

/**
 * The refusal for a read of `path` (absolute, or relative to `cwd`) in a
 * fenced session (`SessionSpec.fenced`), or undefined when it stays inside
 * the working copy. Links are followed before the check, so a link inside
 * the working copy that points out of it is outside. A `~` path is refused
 * whole: each backend expands it its own way.
 */
export function outsideWorkingCopy(cwd: string, path: string): string | undefined {
  if (path === "~" || path.startsWith("~/") || path.startsWith(`~${sep}`))
    return outsideWorkingCopyText(path);
  const root = realOf(resolve(cwd));
  const target = realOf(isAbsolute(path) ? path : resolve(cwd, path));
  const rel = relative(root, target);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return undefined;
  return outsideWorkingCopyText(path);
}
