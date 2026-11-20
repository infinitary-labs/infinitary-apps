import type { TimelineActor } from "./timeline";

export const TIMELINE_BRIEF_REVISED = "The brief was revised.";

/** The recorded opening reason is not another lifecycle event on each metadata change. */
export function timelineConversationWords(began: string, alreadyObserved = false): string {
  if (alreadyObserved) return "The conversation's details were recorded.";
  switch (began) {
    case "start":
      return "The conversation started.";
    case "resume":
      return "The conversation resumed.";
    case "move":
      return "The conversation moved.";
    default:
      return "The conversation was recorded.";
  }
}

/** One wording owner for the actor a retained source actually recorded. */
export function timelineActorWords(actor: TimelineActor | null): string {
  if (!actor) return "Author unknown";
  const names = {
    captain: "you",
    firstmate: "the first mate",
    crewmate: "the crewmate",
    supervisor: "the app",
    host: "the app",
    frame: "the card's script",
  };
  return `Recorded by ${names[actor.kind]}`;
}
