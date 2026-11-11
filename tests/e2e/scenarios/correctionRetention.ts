import { CORRECTION_OFFER_WORDS, keptProjectDirection } from "@shared/correctionWords";
import { renderAdapterState } from "../../../src/core/decisions/decisionModel";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario, ScenarioAnswer, ScenarioRequest } from "../mockProvider";
import { providerMessages, sinceLastUser } from "../providerRequest";

/** Intent: the accepted project-only offer plumbing, not model recognition.
 * This scenario names every scripted captain input and closed answer. No real
 * session text, credentials or live-model judgment appears in its fixtures. */
export const CORRECTION_PROJECT = {
  id: "repo-correction-harbor",
  name: "Harbor",
  key: "HAR",
} as const;
export const CORRECTION_CAPTION = "In Harbor, for the next 3 reviews, ask me before adding scope.";
export const CORRECTION_RULE = "For the next 3 reviews, ask me before adding scope.";
export const CORRECTION_REVISED =
  "For the next 3 reviews, ask me before adding scope, including extra tests.";
export const CORRECTION_REWORD = `Use this wording instead: ${CORRECTION_REVISED}`;
export const CORRECTION_EXPLICIT = `Keep this instruction for Harbor: ${CORRECTION_RULE}`;
export const CORRECTION_DELIVERED = "I will ask before adding scope to the current review.";

type Offer = { id: string; text: string; scope: string; expectedRevision?: number };
type Packet = {
  offer?: {
    directionId: string;
    text: string;
    projectId: string;
    expectedRevision?: number;
    savedRevision?: number;
  };
  latestWrittenSource?: { messageId?: number };
};
export type CorrectionRetentionSeen = {
  questions: string[];
  saved: string[];
  inputId?: number;
  offer?: Offer;
};
const call = (name: string, args: Record<string, unknown>): ScenarioAnswer => ({
  calls: [{ name, args } as ScriptedCall],
});
function decoded(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function correctionRetention(seen: CorrectionRetentionSeen): Scenario {
  const start = () => {
    let packet: Packet | undefined;
    let writing = false;
    return ({ body, replyCheck, isFirstmate }: ScenarioRequest): ScenarioAnswer | undefined => {
      if (replyCheck) {
        const words = providerMessages(body).findLast((entry) => entry.role === "user")?.text ?? "";
        const latest = words.split("\n")[0] ?? "";
        seen.questions.push(latest);
        const positive = renderAdapterState({
          facts: { latest_captain_reply: CORRECTION_CAPTION },
        });
        return { text: latest === positive ? "review" : "ordinary" };
      }
      if (!isFirstmate) return undefined;
      const { user, results } = sinceLastUser(body);
      const result = decoded(results.at(-1));
      const caseMatch = user.match(/(?:input: |inputId )(\d+)/);
      if (caseMatch?.[1]) seen.inputId = Number(caseMatch[1]);
      const caseTurn = Boolean(caseMatch);
      const reword = !caseTurn && user.includes(CORRECTION_REWORD);
      if (!caseTurn && !reword) {
        if (user.includes(CORRECTION_EXPLICIT)) {
          if (!results.length)
            return call("app_change", {
              action: "direction",
              value: {
                op: "add",
                id: "explicit-correction-rule",
                scope: CORRECTION_PROJECT.id,
                text: CORRECTION_RULE,
              },
              evidence: "The captain explicitly asked to keep this project instruction.",
            });
          return { text: keptProjectDirection(CORRECTION_PROJECT.name, CORRECTION_RULE) };
        }
        if (user.includes(CORRECTION_CAPTION)) return { text: CORRECTION_DELIVERED };
        if (user.includes(CORRECTION_OFFER_WORDS.keep))
          return { text: "I am checking the requested project instruction." };
        return undefined;
      }
      const inputId = seen.inputId;
      if (inputId === undefined) return { text: "No source case is available." };
      if (!results.length) return call("correction_case", { op: "inspect", inputId });
      if (result?.source) {
        packet = result as Packet;
        if (reword)
          return call("correction_case", {
            op: "offer",
            inputId,
            projectId: CORRECTION_PROJECT.id,
            text: CORRECTION_REVISED,
            reply: "I changed the proposed wording.",
            answersMessage: packet.latestWrittenSource?.messageId,
          });
        if (!packet.offer)
          return call("correction_case", {
            op: "offer",
            inputId,
            projectId: CORRECTION_PROJECT.id,
            text: CORRECTION_RULE,
          });
        return call("correction_case", { op: "recover", inputId });
      }
      if (result?.status === "offered") {
        seen.offer = result.direction as Offer;
        return {
          text: "The current review can continue while you choose whether to keep the instruction.",
        };
      }
      if (result?.status === "not-kept" && packet?.offer) {
        writing = true;
        const offer = packet.offer;
        return call("app_change", {
          action: "direction",
          value: {
            op: offer.expectedRevision === undefined ? "add" : "revise",
            id: offer.directionId,
            scope: offer.projectId,
            text: offer.text,
            ...(offer.expectedRevision === undefined
              ? {}
              : { expectedRevision: offer.expectedRevision }),
          },
          evidence: "The captain kept this exact project offer.",
        });
      }
      if (writing) {
        writing = false;
        return call("correction_case", { op: "recover", inputId });
      }
      if (result?.status === "kept") {
        seen.saved.push(JSON.stringify(result.direction));
        return call("correction_case", { op: "guide", inputId, affectedTaskIds: [] });
      }
      if (result?.status === "complete")
        return { text: "The saved project instruction needs no additional running-work guidance." };
      if (result?.status === "choice-pending") return { text: "No instruction has been kept." };
      return { text: "The project instruction remains pending verification." };
    };
  };
  return Object.assign(start, { answersReplyCheck: true as const });
}
