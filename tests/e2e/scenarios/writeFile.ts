import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/**
 * A crewmate that makes one real change: a brief carrying "write the file
 * <path> with <text>" writes <text> into <path> in its working copy with
 * Pi's own write tool, then reports. The change is left uncommitted, the
 * way a crewmate stopped mid-work leaves it, so whatever reads the working
 * copy afterwards reads the tree, not only the branch. The benchmark's
 * dry-run attempt (`scripts/bench/run-attempt.ts`) names it.
 */
export const WRITE_FILE_PROMPT_MARKER = "write the file ";
export const MOCK_WRITE_FILE_REPORT = "Wrote the file the task asked for.";

/** Its brief rides every leg of the tool loop, so the marker is matched across the whole conversation. */
export const writeFile: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(WRITE_FILE_PROMPT_MARKER)) return undefined;
    if (!calledTool(body, "write")) {
      const [, path, text] = body.match(/write the file (\S+) with ([^"\\]+)/) ?? ([] as string[]);
      return {
        calls: [
          { name: "write", args: { path: path ?? "change.txt", content: `${text ?? ""}\n` } },
        ],
      };
    }
    if (!calledTool(body, "report")) {
      return { calls: [{ name: "report", args: { text: MOCK_WRITE_FILE_REPORT } }] };
    }
    return { text: "done" };
  };
