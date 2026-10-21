import { CLAUDE_CREW_MODEL, CLAUDE_CREW_PROMPT_MARKER, type Scenario } from "../mockProvider";

/**
 * INF-721 friction 1: the captain chooses on an answer task's card while
 * its crewmate is still working. A captain message carrying the marker has
 * the first mate start a task that only answers, on the Claude crew. Its
 * crewmate shows INF-648's card and reports, and the stand-in holds its
 * next step open, as it does every Claude crewmate's
 * (`CLAUDE_CREW_PROMPT_MARKER`), so the choice lands mid-turn.
 */
export const ANSWER_MID_TURN_MARKER = "answer while you keep working:";
export const ANSWER_MID_TURN_TITLE = `why two Mac journey jobs stall ${CLAUDE_CREW_PROMPT_MARKER}`;
/** INF-648's card, whose choice the cancel of its running turn swallowed. */
export const ANSWER_MID_TURN_CARD_TITLE =
  "Both Mac journey jobs are stuck at the check lock and have run nothing";
export const ANSWER_MID_TURN_CHOICE = "Free the lock and restart both";

export const answerMidTurn: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream || hasToolResults) return undefined;
    if (isFirstmate) {
      if (!latestUserTail.includes(ANSWER_MID_TURN_MARKER)) return undefined;
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title: ANSWER_MID_TURN_TITLE,
              goal: "Explain why both Mac journey jobs stall and name the safe next move.",
              user_words: `${ANSWER_MID_TURN_MARKER} ${ANSWER_MID_TURN_TITLE}`,
              constraints: [{ kind: "read-only" }],
              shape: { override_model_id: CLAUDE_CREW_MODEL },
            },
          },
        ],
      };
    }
    if (!body.includes(ANSWER_MID_TURN_MARKER)) return undefined;
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: ANSWER_MID_TURN_CARD_TITLE,
            body: "<p>Both jobs have waited at the Mac mini's check lock since 9:52 AM.</p><p>Six leftover helpers from finished phone recordings hold that lock.</p>",
            actions: [
              { id: "free-only", label: "Only free the lock" },
              { id: "leave", label: "Leave them" },
              { id: "free-and-restart", label: ANSWER_MID_TURN_CHOICE, default: true },
            ],
          },
        },
        { name: "report", args: { text: "Both jobs are stuck at the check lock, not slow." } },
      ],
    };
  };
