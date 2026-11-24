import { UNSAFE_DATA_READER_ALONE_MARKER, UNSAFE_DATA_READER_ALONE_READ } from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * An unsafe data reader with no project (docs/agents-reach.md, "An unsafe data
 * reader"): it lists the folder it runs in, reads where a project would live,
 * and reports both answers.
 */
export const unsafeDataReaderAlone: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(UNSAFE_DATA_READER_ALONE_MARKER))
      return undefined;
    const { user, results } = sinceLastUser(body);
    if (!user.includes(UNSAFE_DATA_READER_ALONE_MARKER)) return undefined;
    if (!results.length) return { calls: [{ name: "ls", args: { path: "." } }] };
    if (results.length === 1)
      return { calls: [{ name: "github_read", args: { path: UNSAFE_DATA_READER_ALONE_READ } }] };
    if (results.length === 2)
      return {
        calls: [
          {
            name: "report",
            args: { text: results.join("\n---\n"), summary: "The folder and the read." },
          },
        ],
      };
    return { text: "The folder and the read are reported." };
  };
