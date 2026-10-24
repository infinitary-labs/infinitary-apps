import { MOCK_FOLLOWUP_TITLE, type Scenario } from "../mockProvider";

/**
 * Marker prompt (task-system P2): the mock crewmate files a follow-up under
 * its own task and notes progress before it reports. The follow-up's title
 * stays in the shared stand-in, whose kind classifier sorts it as research.
 */
export const FILE_FOLLOWUP_PROMPT_MARKER = "file a follow-up for the meter test";
export const MOCK_FOLLOWUP_GOAL = "The meter test passes ten runs in a row.";
export const MOCK_FOLLOWUP_WHY = "It failed twice while I ran the suite.";
export const MOCK_PROGRESS_TEXT = "Filed the follow-up; finishing the note now.";

/** The crewmate files its follow-up and notes progress, then reports on the follow-up leg like any other turn. */
export const fileFollowup: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes(FILE_FOLLOWUP_PROMPT_MARKER)) return undefined;
    // The follow-up's own brief names the task it was found on; the
    // crewmate that takes it up does not file it again.
    if (latestUserTail.includes("Filed as a follow-up by")) return undefined;
    return {
      calls: [
        {
          name: "file_followup",
          args: { title: MOCK_FOLLOWUP_TITLE, goal: MOCK_FOLLOWUP_GOAL, why: MOCK_FOLLOWUP_WHY },
        },
        { name: "note_progress", args: { text: MOCK_PROGRESS_TEXT } },
      ],
    };
  };
