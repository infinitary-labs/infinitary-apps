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
      "Only for the correction-review wake's case: inspect reads its source; offer proposes exact wording for a known project on an independent first-mate card; ignore finishes an unneeded candidate or, with a reply explaining why, a chosen instruction that cannot be saved. After Keep, app_change direction uses offered id/text/scope and expectedRevision. recover reads storage before retry and confirms only a matching saved revision. After verified saving, guide declares affected running task ids; empty finishes without interrupting anyone. Never writes directions or authorizes work.",
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
            "On offer, answer a wording reply on the same ordinary card.",
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
            "On recover, declare latestWrittenSource.sourceId from inspect when those captain words explicitly ask to keep the offered instruction.",
        }),
      ),
    }),
    run: async (value) => ({
      text: JSON.stringify(await handle(correctionCaseRequestSchema.parse(value))),
    }),
  });
}
