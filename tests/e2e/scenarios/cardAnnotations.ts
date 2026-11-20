import { POINTED_AT } from "@shared/cardNotes";
import { ANNOTATION_BODY, ANNOTATION_TITLE } from "../../fixtures/cardAnnotations";
import type { Scenario } from "../mockProvider";
import { answering, calledTool, providerMessages } from "../providerRequest";

export const ANNOTATION_FIRSTMATE_PROMPT = "Show the queue-check annotation example";
export const ANNOTATION_CREW_PROMPT = "Prepare the queue-check annotation example";
export const ANNOTATION_ACK = "I read both notes together.";
export function cardAnnotations(readings: string[]): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
      if (!wantsStream || hasToolResults) return undefined;
      const card = { title: ANNOTATION_TITLE, body: ANNOTATION_BODY, actions: [] };
      // The approved annotation flow delivers a quoted card title in a real provider request.
      const served =
        providerMessages(body)
          .filter((message) => message.role === "user")
          .at(-1)?.text ?? "";
      if (served.includes(`${POINTED_AT}:`)) {
        readings.push(served);
        const id =
          served.match(/Card "[^\n]+" \((card-[\w-]+)\)/)?.[1] ??
          served.match(/about: card (card-[\w-]+)/)?.[1];
        if (isFirstmate)
          return {
            calls: [
              {
                name: "emit_card",
                args: {
                  ...card,
                  id: id ?? "annotation-firstmate",
                  reply: ANNOTATION_ACK,
                  ...answering(served),
                },
              },
            ],
          };
        if (id)
          return {
            calls: [
              {
                name: "reply",
                args: { card_id: id, text: ANNOTATION_ACK, ...answering(served) },
              },
            ],
          };
        return { text: ANNOTATION_ACK };
      }
      if (isFirstmate && latestUserTail.includes(ANNOTATION_FIRSTMATE_PROMPT))
        return { calls: [{ name: "emit_card", args: { ...card, id: "annotation-firstmate" } }] };
      if (!isFirstmate && body.includes(ANNOTATION_CREW_PROMPT) && !calledTool(body, "emit_card"))
        return { calls: [{ name: "emit_card", args: { ...card, id: "annotation-crew" } }] };
      return undefined;
    };
}
