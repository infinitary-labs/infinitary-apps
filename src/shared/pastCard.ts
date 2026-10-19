import { type PastCard, scriptChooser } from "./cards";

/**
 * A past card's ending with whoever chose named. `frame` is the channel a
 * body's own script used, never a chooser, so it is not one of these:
 * `pastCardEndingWords` names that script's author first.
 */
export type NamedEnding = Omit<PastCard["ending"], "by"> & {
  by?: Exclude<PastCard["ending"]["by"], "frame">;
};

/**
 * How a past card says it ended, in the captain's words (design skill,
 * "Past card"): the one phrase the strip, the turn context and the tests
 * share. The captain's own choice reads "You chose"; another author's reads
 * in their name.
 */
export function pastEndingWords(ending: NamedEnding): string {
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

/**
 * How a closed card says it ended (INF-500): a choice its body's own script
 * made reads in the name the resolution credited (`scriptChooser`), never
 * as the captain's. The saved ending keeps `frame`.
 */
export function pastCardEndingWords(past: Pick<PastCard, "ending" | "author">): string {
  const { by } = past.ending;
  return pastEndingWords({ ...past.ending, by: by === "frame" ? scriptChooser(past.author) : by });
}
