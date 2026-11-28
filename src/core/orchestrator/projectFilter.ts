/**
 * The project filter a captain's message came with (docs/project-focus.md):
 * a project, All projects while the window's pill shows, or the phone at All
 * projects. A project focused on the phone says so (`phone`), since the
 * phone keeps a focus of its own (INF-2820 piece 2).
 */
export type ProjectFilter = { project: string; phone?: true } | "all" | "phone";

/**
 * The filter a message from a window or the phone says. Where it came from
 * is the connection's typed fact (`CaptainPlaces.fromPhone`): a phone
 * message names the project it is focused on, or covers every project when
 * it names none, whatever else it carries; a window that names no filter,
 * such as one with a single project, says none (null).
 */
export function projectFilterOf(
  message: string | { focusedProjectId?: string; allProjects?: boolean },
  fromPhone: boolean,
): ProjectFilter | null {
  const fields = typeof message === "string" ? {} : message;
  const project = fields.focusedProjectId?.trim();
  if (fromPhone) return project ? { project, phone: true } : "phone";
  if (project) return { project };
  return fields.allProjects ? "all" : null;
}
