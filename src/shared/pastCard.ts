import type { PastCard } from "./cards";

/**
 * How a past card says it ended, in the captain's words (design skill,
 * "Past card"): the one phrase the strip, the turn context and the tests
 * share. The captain's own choice reads "You chose"; a script's or another
 * author's reads in their name.
 */
export function pastEndingWords(ending: PastCard["ending"]): string {
  switch (ending.how) {
    case "chose": {
      const what = ending.label ?? "an option";
      if (ending.by === "firstmate") return `Your first mate chose ${what}`;
      if (ending.by === "crewmate") return `Its crewmate chose ${what}`;
      return `You chose ${what}`;
    }
    case "dismissed":
      return "Closed without choosing";
    case "author-withdrawal":
      return "Withdrawn by its author";
    case "host-withdrawal":
      return "Taken down by the app";
    case "task-retired":
      return "Taken down when the task ended";
    case "duplicate":
      return "Closed as a duplicate";
    case "unknown":
      return "Closed";
  }
}
