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
      "Find a project directory on disk by name when the user names a project that is",
      "not yet managed. Case-insensitive match over the usual project locations; returns",
      "up to 8 candidates with whether each is a git repo, its origin remote, and its",
      "repo_id when already managed. With the captain's sign-in where projects live, it",
      "also searches all of them (up to 1,000), exact owner/name or pasted address included, and says how many it searched; matches are listed first, else the newest, each with the",
      "origin app_change project-setup kind clone takes. Not found, or only described: spawn a read-only investigation using github_read before asking for a link.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String(),
    }),
    run: async (params) => {
      return { text: await locate(params.name) };
    },
  });
}
