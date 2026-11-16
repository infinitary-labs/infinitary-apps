import { Type } from "typebox";
import { boundTool } from "../session/tools";

/**
 * locate_project (contract v1, spec section 1.4 + G-2): typed project
 * lookup on disk, replacing prompt-steered shell exploration. Read-only,
 * bounded roots, fails soft with an honest not-found.
 */

export const LOCATE_PROJECT_TOOL_NAME = "locate_project";

export function createLocateProjectTool(locate: (name: string) => string | Promise<string>) {
  return boundTool({
    name: LOCATE_PROJECT_TOOL_NAME,
    label: "Locate project",
    description: [
      "Find a named project directory on disk when not yet managed. Match usual locations case-insensitively;",
      "return up to 8 candidates with git repo status, origin remote and repo_id when managed.",
      "With the captain's sign-in, search up to 1,000 hosted projects too, including exact owner/name or pasted address;",
      "matches first, else newest, each with the origin app_change project-setup kind clone takes.",
      "Not found or only described: spawn a read-only investigation using github_read before asking for a link.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String(),
    }),
    run: async (params) => {
      return { text: await locate(params.name) };
    },
  });
}
