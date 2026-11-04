import { type TObject, Type } from "typebox";
import type { BoundTool } from "../session/tools";
import type { AskCapture } from "./askCapture";

// These actions reach AskCapture.attach, including operation/card filing.
const ATTRIBUTING_TOOLS = new Set([
  "spawn_crewmate",
  "steer_crewmate",
  "interrupt_crewmate",
  "settle_task",
  "create_task",
  "update_task",
  "link_tasks",
  "emit_card",
  "app_change",
  "use_integration",
  "schedule_prompt",
  "record_knowledge",
  "flag_missed_escalation",
  "flag_duplicate",
  "personalize",
  "install_plugin",
]);

const ASK_ID = Type.Optional(
  Type.String({
    description:
      "The read message this action addresses (open_asks id). Empty for unrelated operational work, even in a captain turn. Omit uses the latest read message.",
  }),
);

// These file or start work, so they may name the wake they answer (INF-2326).
const FILING_TOOLS = new Set(["spawn_crewmate", "create_task"]);

const ORIGIN = Type.Optional(
  Type.String({
    description:
      "When this turn read several automation runs, card choices or crewmate reports and none of the captain's messages: the one this answers, by automation id, card id or reporting task key. The task's cards name it as where the work came from.",
  }),
);

// Distribute over the tool union so each name keeps its own argument schema.
type AttributedTool<Tool> =
  Tool extends BoundTool<infer Name, infer Params>
    ? Params extends TObject
      ? BoundTool<
          Name,
          TObject<
            Params["properties"] & { ask_id: typeof ASK_ID } & (Name extends
                | "spawn_crewmate"
                | "create_task"
                ? { origin: typeof ORIGIN }
                : unknown)
          >
        >
      : never
    : never;

/** One action's source, shared by both session backends and every attachment writer. */
export function withAskAttribution<Tool extends BoundTool>(
  tool: Tool,
  capture: AskCapture,
  witnessed: (askId: string) => boolean,
): AttributedTool<Tool> {
  const parameters = {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      ask_id: ASK_ID,
      ...(FILING_TOOLS.has(tool.name) ? { origin: ORIGIN } : {}),
    },
  };
  return {
    ...tool,
    parameters: ATTRIBUTING_TOOLS.has(tool.name) ? parameters : tool.parameters,
    run: (params: Parameters<Tool["run"]>[0], signal?: AbortSignal) => {
      if (!ATTRIBUTING_TOOLS.has(tool.name)) return tool.run(params, signal);
      const { ask_id: declared, ...rest } = params as Record<string, unknown>;
      const filing = FILING_TOOLS.has(tool.name);
      const { origin, ...input } = rest;
      const named = filing ? origin : undefined;
      if (declared !== undefined && typeof declared !== "string")
        throw new Error("ask_id must name a read message, or be empty for unrelated work.");
      if (declared && !witnessed(declared))
        throw new Error("ask_id must name a message this turn has read.");
      const askId = declared === undefined ? capture.current()?.id : declared || undefined;
      if (named === undefined || named === "")
        return capture.withAsk(askId, () => tool.run(filing ? input : rest, signal));
      const answered = typeof named === "string" ? capture.readOrigin(named) : undefined;
      if (!answered)
        throw new Error(
          "origin must name an automation run, card choice or crewmate report this turn has read.",
        );
      return capture.withAsk(askId, () => tool.run(input, signal), answered);
    },
  } as unknown as AttributedTool<Tool>;
}
