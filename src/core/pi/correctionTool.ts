import { Type } from "typebox";
import {
  type CorrectionCaseRequest,
  correctionCaseRequestSchema,
} from "../decisions/correctionCases";
import { boundTool, stringEnum } from "../session/tools";

/** Reach for an already flagged case, not a duty to inspect other replies. */
export function createCorrectionTool(handle: (request: CorrectionCaseRequest) => Promise<unknown>) {
  return boundTool({
    name: "correction_case",
    label: "Handle a flagged correction",
    description:
      "Handle only the case a correction-review wake names. inspect reads its source; offer proposes exact wording for a known project on an independent first-mate card; ignore finishes an unneeded candidate, or, with reply telling the captain why, a chosen instruction that cannot be saved. After Keep, use app_change direction with the offered id/text/scope and expectedRevision. recover reads storage before any retry; it confirms only a matching saved revision. guide declares only affected running task ids after verified saving; empty finishes without interrupting anyone. Never writes directions or authorizes work.",
    parameters: Type.Object({
      op: stringEnum(["inspect", "offer", "ignore", "recover", "guide"]),
      inputId: Type.Integer(),
      projectId: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      directionId: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.Integer()),
      affectedTaskIds: Type.Optional(Type.Array(Type.String())),
      reply: Type.Optional(
        Type.String({
          description:
            "On offer, answer a wording reply on the same ordinary card. On ignore of a chosen instruction, tell the captain why it cannot be saved.",
        }),
      ),
      answersMessage: Type.Optional(
        Type.Integer({
          description:
            "The actual latestWrittenSource.messageId from inspect that your reply answers.",
        }),
      ),
      explicitSourceId: Type.Optional(
        Type.String({
          description:
            "On recover, declare the latestWrittenSource.sourceId from inspect when those actual captain words explicitly ask to keep the offered instruction; the existing writer still saves it, with no extra choice.",
        }),
      ),
    }),
    run: async (value) => ({
      text: JSON.stringify(await handle(correctionCaseRequestSchema.parse(value))),
    }),
  });
}
