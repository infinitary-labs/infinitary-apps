import { anythingElseOf } from "@shared/cards";
import type { InboxRow } from "../storage/inboxStore";
import type { TurnOrigin } from "./askCapture";

/**
 * The origin one served wake offers the work a turn files or starts
 * (INF-2326): an automation run names its automation as it was named when
 * it ran; the captain's click on a first mate card, or the choice that
 * closed an answer task, names the card, the button's words and what they
 * wrote with it; a crewmate's report names its task. A script's click is not
 * the captain's, and every other wake offers none.
 */
export function turnOriginOf(
  row: InboxRow,
  keyOf: (taskId: string) => string | undefined,
): TurnOrigin | undefined {
  const facts = row.facts;
  switch (facts?.kind) {
    case "scheduled":
      return facts.rule
        ? {
            origin: {
              kind: "automation",
              ruleId: facts.rule.id,
              ...(facts.rule.name ? { name: facts.rule.name } : {}),
            },
            refs: [facts.rule.id],
          }
        : undefined;
    case "card-choice": {
      if (facts.to !== "firstmate" || facts.source === "frame") return undefined;
      const written = anythingElseOf(facts.choice.answers);
      return {
        origin: {
          kind: "chose",
          cardId: facts.card.id ?? "",
          card: facts.card.title,
          choice: facts.choice.label,
          ...(written ? { written } : {}),
        },
        refs: facts.card.id ? [facts.card.id] : [],
      };
    }
    case "answer-closed": {
      const { card, choice } = facts.handoff;
      return {
        origin: { kind: "chose", cardId: card.id, card: card.title, choice: choice.label },
        refs: [card.id],
      };
    }
    case "report": {
      const key = keyOf(facts.task.id);
      return {
        origin: { kind: "report", taskId: facts.task.id },
        refs: [facts.task.id, ...(key ? [key] : [])],
      };
    }
    default:
      return undefined;
  }
}
