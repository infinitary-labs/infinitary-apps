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

// Its rule is said once, in the first mate's core (FIRSTMATE_PROMPT_CORE's
// "EVERY TURN is about a task"), not on each of the sixteen tools that carry it.
const ASK_ID = Type.Optional(Type.String());

// emit_card alone may name several messages: one answer can answer a
// question and its correction, and each message then counts it (INF-6769).
// i18n-exempt: a tool description served to the first mate
const ANSWER_ASK_IDS = Type.Optional(
  Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
    description:
      "The open_asks id this card or line answers, or a list of every one it answers, such as a question and its correction.",
  }),
);

// The tool whose ask_id may list several messages.
const ANSWERING_TOOL = "emit_card";

// i18n-exempt: served to the first mate as a refusal, never shown to a person
const UNREAD = "ask_id must name a message this turn has read.";

// These file or start work, so they may name the wake they answer (INF-2326).
const FILING_TOOLS = new Set(["spawn_crewmate", "create_task"]);

// i18n-exempt: a tool description served to the first mate
const ORIGIN = Type.Optional(
  Type.String({
    description:
      "When this turn read several automation runs, card choices or crewmate reports and no captain message: the one answered, by automation id, card id or reporting task key.",
  }),
);

/** Names each read run by id and the name it ran under, so the retry can copy one. */
function severalRunsRefusal(runs: ReturnType<AskCapture["severalRuns"]>): string {
  const named = runs.map((run) => (run.name ? `${run.ruleId} ("${run.name}")` : run.ruleId));
  // i18n-exempt: a refusal served to the first mate, never shown to a person
  return `This turn read several automation runs: name the one this work answers with origin, one of ${named.join(", ")}, or name the captain's message with ask_id.`;
}

// spawn_crewmate's points at create_task's, as its title does, so the rule is said once.
// i18n-exempt: a tool description served to the first mate
const ORIGIN_AS_CREATE_TASK = Type.Optional(
  Type.String({ description: "As create_task's origin." }),
);

// Distribute over the tool union so each name keeps its own argument schema.
type AttributedTool<Tool> =
  Tool extends BoundTool<infer Name, infer Params>
    ? Params extends TObject
      ? BoundTool<
          Name,
          TObject<
            Params["properties"] & {
              ask_id: Name extends typeof ANSWERING_TOOL ? typeof ANSWER_ASK_IDS : typeof ASK_ID;
            } & (Name extends "spawn_crewmate" | "create_task"
                ? { origin: typeof ORIGIN }
                : unknown)
          >
        >
      : never
    : never;

/**
 * One action's source, shared by both session backends and every attachment
 * writer. `witnessed` says whether this step read the message; one it did
 * not read may still be named when `nameRefusal` gives no reason against
 * it (INF-2664: any open message a finished reply has read).
 */
export function withAskAttribution<Tool extends BoundTool>(
  tool: Tool,
  capture: AskCapture,
  witnessed: (askId: string) => boolean,
  nameRefusal: (askId: string) => string | undefined = () => UNREAD,
): AttributedTool<Tool> {
  const parameters = {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      ask_id: tool.name === ANSWERING_TOOL ? ANSWER_ASK_IDS : ASK_ID,
      ...(FILING_TOOLS.has(tool.name)
        ? { origin: tool.name === "create_task" ? ORIGIN : ORIGIN_AS_CREATE_TASK }
        : {}),
    },
  };
  return {
    ...tool,
    parameters: ATTRIBUTING_TOOLS.has(tool.name) ? parameters : tool.parameters,
    run: (params: Parameters<Tool["run"]>[0], signal?: AbortSignal) => {
      if (!ATTRIBUTING_TOOLS.has(tool.name)) return tool.run(params, signal);
      const { ask_id: given, ...rest } = params as Record<string, unknown>;
      const filing = FILING_TOOLS.has(tool.name);
      const { origin, ...input } = rest;
      const named = filing ? origin : undefined;
      const list = Array.isArray(given) && tool.name === ANSWERING_TOOL;
      if (
        given !== undefined &&
        typeof given !== "string" &&
        !(list && given.length > 0 && given.every((id) => typeof id === "string" && id !== ""))
      )
        throw new Error("ask_id must name a read message, or be empty for unrelated work.");
      const declaredIds = list ? [...new Set(given as string[])] : given ? [given as string] : [];
      for (const declared of declaredIds) {
        if (witnessed(declared)) continue;
        const refusal = nameRefusal(declared);
        if (refusal) throw new Error(refusal);
      }
      const [first, ...also] = declaredIds;
      const askId = given === undefined ? capture.current()?.id : first;
      const declares = declaredIds.length > 0;
      if (named === undefined || named === "") {
        const runs = filing && !askId ? capture.severalRuns() : [];
        if (runs.length > 0) throw new Error(severalRunsRefusal(runs));
        return capture.withAsk(
          askId,
          () => tool.run(filing ? input : rest, signal),
          undefined,
          declares,
          also,
        );
      }
      const answered = typeof named === "string" ? capture.readOrigin(named) : undefined;
      if (!answered)
        throw new Error(
          "origin must name an automation run, card choice or crewmate report this turn has read.",
        );
      return capture.withAsk(askId, () => tool.run(input, signal), answered, declares, also);
    },
  } as unknown as AttributedTool<Tool>;
}
