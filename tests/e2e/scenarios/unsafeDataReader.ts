import { FOLLOWUP_PROVENANCE_OPENING } from "../../../src/core/orchestrator/intentBrief";
import {
  UNSAFE_DATA_READER_CARD,
  UNSAFE_DATA_READER_FILE,
  UNSAFE_DATA_READER_FOLLOWUP,
  UNSAFE_DATA_READER_MARKER,
  UNSAFE_DATA_READER_READS,
  UNSAFE_DATA_READER_WRITES,
  WRITE_ASK_SENT_WAKE,
} from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * An unsafe data reader's turn (docs/agents-reach.md, "An unsafe data reader"): a
 * file read and two reads where its project lives, two writes, a decision card and a
 * follow-up, then a report, and later a report of what the captain's click answered.
 * Its kept writes go on the app's own approval card, never its own.
 */
export const unsafeDataReader: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(UNSAFE_DATA_READER_MARKER)) return undefined;
    // The last words a person or the app said, past tool results, which
    // Claude's client sends as user messages and Pi as tool messages.
    const { user, results } = sinceLastUser(body);
    // The follow-up it filed names it in its brief; that crewmate is no reader.
    if (user.includes(FOLLOWUP_PROVENANCE_OPENING)) return undefined;
    if (user.includes(WRITE_ASK_SENT_WAKE)) {
      if (results.length) return { text: "The answered writes are reported." };
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `Answered: ${(user.match(/GitHub answered \d{3}|sent nothing: [^.]*\./g) ?? []).join(" | ")}`,
              summary: "The captain answered.",
            },
          },
        ],
      };
    }
    if (!user.includes(UNSAFE_DATA_READER_MARKER)) return undefined;
    if (!results.length)
      // Claude's client serves its own read as Read, where Pi serves read.
      return {
        calls: [
          body.includes('"name":"Read"')
            ? { name: "Read", args: { file_path: UNSAFE_DATA_READER_FILE } }
            : { name: "read", args: { path: UNSAFE_DATA_READER_FILE } },
        ],
      };
    const reads = UNSAFE_DATA_READER_READS.length + 1;
    const read = UNSAFE_DATA_READER_READS[results.length - 1];
    if (read) return { calls: [{ name: "github_read", args: { path: read } }] };
    const write = UNSAFE_DATA_READER_WRITES[results.length - reads];
    if (write) return { calls: [{ name: "github_write", args: write }] };
    const asked = reads + UNSAFE_DATA_READER_WRITES.length;
    if (results.length === asked)
      return { calls: [{ name: "emit_card", args: UNSAFE_DATA_READER_CARD }] };
    if (results.length === asked + 1)
      return { calls: [{ name: "file_followup", args: UNSAFE_DATA_READER_FOLLOWUP }] };
    if (results.length === asked + 2)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: results.join("\n---\n"),
              summary: "Two writes wait on the captain's card.",
            },
          },
        ],
      };
    return { text: "The writes wait on the captain." };
  };
