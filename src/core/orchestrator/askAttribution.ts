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

// Distribute over the tool union so each name keeps its own argument schema.
type AttributedTool<Tool> =
  Tool extends BoundTool<infer Name, infer Params>
    ? Params extends TObject
      ? BoundTool<Name, TObject<Params["properties"] & { ask_id: typeof ASK_ID }>>
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
    properties: { ...tool.parameters.properties, ask_id: ASK_ID },
  };
  return {
    ...tool,
    parameters: ATTRIBUTING_TOOLS.has(tool.name) ? parameters : tool.parameters,
    run: (params: Parameters<Tool["run"]>[0], signal?: AbortSignal) => {
      if (!ATTRIBUTING_TOOLS.has(tool.name)) return tool.run(params, signal);
      const { ask_id: declared, ...input } = params as Record<string, unknown>;
      if (declared !== undefined && typeof declared !== "string")
        throw new Error("ask_id must name a read message, or be empty for unrelated work.");
      if (declared && !witnessed(declared))
        throw new Error("ask_id must name a message this turn has read.");
      const askId = declared === undefined ? capture.current()?.id : declared || undefined;
      return capture.withAsk(askId, () => tool.run(input, signal));
    },
  } as unknown as AttributedTool<Tool>;
}
