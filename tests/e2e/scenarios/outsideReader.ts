import {
  OUTSIDE_READER_MARKER,
  OUTSIDE_READER_READS,
  OUTSIDE_READER_WRITES,
  WRITE_ASK_SENT_WAKE,
} from "../apiWriteCases";
import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * An outside reader's turn (docs/agents-reach.md, "An outside reader"): two
 * reads, two writes and a report, then a report of what the captain's click
 * answered. It emits no card: the app shows its kept writes on its own.
 */
export const outsideReader: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (isFirstmate || !wantsStream || !body.includes(OUTSIDE_READER_MARKER)) return undefined;
    const { results } = sinceLastUser(body);
    if (latestUserTail.includes(WRITE_ASK_SENT_WAKE)) {
      if (results.length) return { text: "The answered writes are reported." };
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `Answered: ${(latestUserTail.match(/GitHub answered \d{3}|sent nothing: [^.]*\./g) ?? []).join(" | ")}`,
              summary: "The captain answered.",
            },
          },
        ],
      };
    }
    if (!latestUserTail.includes(OUTSIDE_READER_MARKER)) return undefined;
    const reads = OUTSIDE_READER_READS.length;
    const read = OUTSIDE_READER_READS[results.length];
    if (read) return { calls: [{ name: "github_read", args: { path: read } }] };
    const write = OUTSIDE_READER_WRITES[results.length - reads];
    if (write) return { calls: [{ name: "github_write", args: write }] };
    if (results.length === reads + OUTSIDE_READER_WRITES.length)
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
