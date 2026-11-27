/**
 * The project filter a captain's message came with (docs/project-focus.md):
 * a project, All projects while the window's pill shows, or the phone,
 * which has none and shows every project.
 */
export type ProjectFilter = { project: string } | "all" | "phone";

/**
 * The filter a message from a window or the phone says. Where it came from
 * is the connection's typed fact (`CaptainPlaces.fromPhone`), so a phone
 * message covers every project whatever fields it carries; a window that
 * names no filter, such as one with a single project, says none (null).
 */
export function projectFilterOf(
  message: string | { focusedProjectId?: string; allProjects?: boolean },
  fromPhone: boolean,
): ProjectFilter | null {
  if (fromPhone) return "phone";
  const fields = typeof message === "string" ? {} : message;
  const project = fields.focusedProjectId?.trim();
  if (project) return { project };
  return fields.allProjects ? "all" : null;
}
