import type { ScriptedCall } from "../../helpers/scriptedCalls";
import {
  UNSAFE_DATA_READER_MARKER,
  UNSAFE_DATA_READER_NAMED_PAGE,
  UNSAFE_DATA_READER_OTHER_PAGE,
  UNSAFE_DATA_READER_WEB_MARKER,
  WRITE_ASK_SENT_WAKE,
} from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * An unsafe data reader that reads web pages (docs/agents-reach.md, "Web
 * pages"): it reads its project, so it holds something of the captain's, then
 * the page its brief names and one it does not, and reports both answers.
 * Once the captain's click opens the second, it reports what came back.
 */
export const unsafeDataReaderWeb: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(UNSAFE_DATA_READER_WEB_MARKER))
      return undefined;
    const { user, results } = sinceLastUser(body);
    if (user.includes(WRITE_ASK_SENT_WAKE)) {
      if (results.length) return { text: "The opened page is reported." };
      return {
        calls: [{ name: "report", args: { text: `Opened: ${user}`, summary: "A page opened." } }],
      };
    }
    if (!user.includes(UNSAFE_DATA_READER_MARKER)) return undefined;
    const calls: ScriptedCall[] = [
      { name: "github_read", args: { path: "/repos/octo/meterlab/pulls" } },
      { name: "web_read", args: { url: UNSAFE_DATA_READER_NAMED_PAGE } },
      { name: "web_read", args: { url: UNSAFE_DATA_READER_OTHER_PAGE } },
    ];
    const next = calls[results.length];
    if (next) return { calls: [next] };
    if (results.length === calls.length)
      return {
        calls: [
          {
            name: "report",
            args: { text: results.join("\n---\n"), summary: "One page waits on the captain." },
          },
        ],
      };
    return { text: "The page waits on the captain." };
  };
