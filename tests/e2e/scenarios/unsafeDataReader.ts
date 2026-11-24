import { FOLLOWUP_PROVENANCE_OPENING } from "../../../src/core/orchestrator/intentBrief";
import {
  UNSAFE_DATA_READER_ASK,
  UNSAFE_DATA_READER_BUILD_ROW,
  UNSAFE_DATA_READER_CARD,
  UNSAFE_DATA_READER_CARD_WORDS,
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
 * file read and two reads where its project lives, a Build row, two writes and a
 * follow-up, then a report asking the first mate to start that follow-up; once the captain's
 * click answers, a decision card with a question, its own reply under it and a report of what it answered;
 * once the captain answers that card, a last report.
 * Its kept writes and Build row go on the app's own approval card, never its own.
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
      // Its decision card goes up only now: while one is open its report
      // waits on the captain and never wakes the first mate (`sortReport`).
      if (!results.length) return { calls: [{ name: "emit_card", args: UNSAFE_DATA_READER_CARD }] };
      if (results.length === 1) {
        const card = results[0]?.match(/card-[\w-]+/)?.[0];
        if (!card) throw new Error("The reader's card was not shown");
        return {
          calls: [
            { name: "reply", args: { card_id: card, text: UNSAFE_DATA_READER_CARD_WORDS.reply } },
          ],
        };
      }
      if (results.length > 2) return { text: "The answered writes are reported." };
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
    if (user.includes(UNSAFE_DATA_READER_CARD.title)) {
      if (results.length) return { text: "The captain's answer is reported." };
      return {
        calls: [{ name: "report", args: { text: "The captain answered the card." } }],
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
    // Its Build row raises the approval card, and the writes join it after.
    if (results.length === reads)
      return { calls: [{ name: "file_followup", args: UNSAFE_DATA_READER_BUILD_ROW }] };
    const write = UNSAFE_DATA_READER_WRITES[results.length - reads - 1];
    if (write) return { calls: [{ name: "github_write", args: write }] };
    const asked = reads + 1 + UNSAFE_DATA_READER_WRITES.length;
    if (results.length === asked)
      return { calls: [{ name: "file_followup", args: UNSAFE_DATA_READER_FOLLOWUP }] };
    if (results.length === asked + 1)
      return {
        calls: [
          {
            name: "report",
            args: {
              text: results.join("\n---\n"),
              summary: "Two writes wait on the captain's card.",
              // The app's approval card is up, so only an ask wakes the first mate (`sortReport`).
              needs_firstmate: UNSAFE_DATA_READER_ASK,
            },
          },
        ],
      };
    return { text: "The writes wait on the captain." };
  };
