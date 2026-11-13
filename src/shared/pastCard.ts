import { type PastCard, scriptChooser } from "./cards";
import * as m from "./i18n/messages.generated.ts";

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
 * in their name. It speaks the process's language; served text words it
 * with `inLanguage(SOURCE_LANGUAGE, ...)` (docs/i18n.md, "What stays English").
 */
export function pastEndingWords(ending: NamedEnding): string {
  switch (ending.how) {
    case "chose": {
      const label = ending.label ?? m.pastEndingAnOption();
      if (ending.by === "firstmate") return m.pastEndingFirstmateChose({ label });
      if (ending.by === "crewmate") return m.pastEndingCrewmateChose({ label });
      return m.pastEndingYouChose({ label });
    }
    case "dismissed":
      return m.pastEndingDismissed();
    case "author-withdrawal":
      return m.pastEndingAuthorWithdrawal();
    case "host-withdrawal":
      return m.pastEndingHostWithdrawal();
    case "task-retired":
      return m.pastEndingTaskRetired();
    case "duplicate":
      return m.pastEndingDuplicate();
    case "unknown":
      return m.pastEndingUnknown();
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
