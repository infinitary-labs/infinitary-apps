import type { Scenario } from "../mockProvider";

/**
 * INF-1103, the reply note (docs/composer.md "The reply note"): a captain
 * message carrying the marker has the first mate salute, then close with
 * words over several lines - a list, as the captain's screenshot on
 * INF-1102 showed - so the reply line joins them into one and the note
 * shows them as written.
 */
export const REPLY_NOTE_MARKER = "and answer with a list";
export const REPLY_NOTE_WORDS = [
  "I've started a read-only crewmate to check the Mac mini. It's looking at:",
  "- which Linux checks your project runs today;",
  "- whether the Mac mini has room alongside the Mac checks;",
  "- the security risk of running other people's pull request code.",
  "It won't change anything on the Mac mini.",
].join("\n");

export const replyNote: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(REPLY_NOTE_MARKER))
      return undefined;
    return hasToolResults
      ? { text: REPLY_NOTE_WORDS }
      : { calls: [{ name: "emote", args: { emote: "salute" } }] };
  };
