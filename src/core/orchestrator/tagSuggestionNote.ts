import type { TagCheckReach } from "@shared/tagCheck";

/**
 * The facts a Suggest tags press carries into the first mate's turn
 * (docs/task-tags.md, "Suggesting tags"), read when the home took the
 * press: which project, how many tasks each check reach holds, and whether
 * Tag tasks automatically asks now and who answers.
 */
export type TagSuggestionFacts = {
  projectId: string;
  key: string;
  name: string;
  /** Tasks each reach of Check existing tasks holds: one decision model request each once tags exist. */
  reaches: Record<TagCheckReach, number>;
  /** Whether Tag tasks automatically asks now. */
  auto: boolean;
  /** The Jev or OpenRouter model answering, by name; null while the person's own models answer. */
  answerer: string | null;
};

/** The note's opening words, which a scripted stand-in reads to know the press sent the turn. */
// i18n-exempt: a marker served only to the first mate
export const TAG_SUGGESTION_MARKER = "[tag suggestion request]";

/**
 * The line under the person's words when they pressed Suggest tags. It is
 * added because of the press, never by reading the words, and it is the one
 * home of the steps, so they cost nothing until someone presses it.
 */
export function tagSuggestionNote(facts: TagSuggestionFacts): string {
  // i18n-exempt: served only to the first mate, which reads English
  const who = facts.answerer ?? "the captain's own models";
  // i18n-exempt: served only to the first mate, which reads English
  const check = facts.auto
    ? `Tag tasks automatically is on, answered by ${who}. Check existing tasks would make one decision model request per task: open tasks ${facts.reaches.open}; open and done in the last 7 days ${facts.reaches.week}; every task ${facts.reaches.all}.`
    : "Tag tasks automatically is off, so new tasks get no tags on their own and nothing can check existing tasks: say so on the card and leave the check question out.";
  // i18n-exempt: served only to the first mate, which reads English
  return [
    `${TAG_SUGGESTION_MARKER} The captain pressed Suggest tags for project ${facts.name} (key ${facts.key}, id ${facts.projectId}), which has no tags. ${check}`,
    "1. Read the project's open tasks with the tasks tool, most recently updated first; add tasks done in the last 30 days when fewer than 20 are open.",
    "2. Propose 8 to 14 tags. Kind tags (such as bug and feature, and others the tasks show, such as idea or cleanup), worded so a task fits at most one kind. Part tags for the areas the tasks keep naming, under the names the project itself uses; when one part has siblings the project ships, such as one platform among several, propose the siblings too.",
    "3. Each description is one to three sentences: which tasks qualify, judged from a task's title, goal and the person's words alone, then the nearest work that does not qualify.",
    "4. Give each tag two or three example task keys and how many open tasks it would fit.",
    "5. Put up one decision card: a checkbox per tag, the recommended ones marked, then one question on which existing tasks to check - open tasks (recommended), open and done in the last 7 days, every task, or not now - each with its request count and who answers.",
    "6. A reply changes the suggestions: revise the same card. If your card for this project is already up, revise it rather than raise another.",
    "7. On the captain's click, add each ticked tag with project-tags, then start project-tag-check at the chosen reach, and say in one line how many tags you added.",
    "Never set a tag on a task yourself: a tag the first mate sets is fixed for good, so the check sets them and a later description change can still correct them. If the project has tags by the time you act, say so and add nothing. If it has few tasks, still suggest kind tags and the themes you see, and say you had little to go on.",
  ].join("\n");
}
