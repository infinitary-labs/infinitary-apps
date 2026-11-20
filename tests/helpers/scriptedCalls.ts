import type { ClaudeCodingBuiltinCall } from "@core/claude/claudeTaskTools";
import type { buildFirstmateTools } from "@core/orchestrator/firstmateTools";
import type { CREWMATE_TOOLS } from "@core/pi/crewmateTaskTools";
import type { PiCodingBuiltinCall } from "@core/pi/session";
import type { ToolCallOf } from "@core/session/tools";
import type { ActionName, ActionValue } from "@shared/actions";

/**
 * A tool call a stand-in model scripts, typed against the live tool set:
 * the Firstmate's tools as `buildFirstmateTools` builds them, every crewmate
 * tool in `CREWMATE_TOOLS`, and the coding builtins of Pi and of the
 * Claude client. Each call's
 * arguments are the static type of that tool's own parameter schema, and
 * an `app_change` value is the one its action-catalog line accepts. A
 * script that names a retired tool, argument or action fails `pnpm
 * typecheck` in the PR checks instead of only the Mac e2e run.
 */
export type ScriptedCall =
  | FirstmateCall
  | CrewmateCall
  | PiCodingBuiltinCall
  | ClaudeCodingBuiltinCall;

type FirstmateTool = ReturnType<typeof buildFirstmateTools>[number];
type CrewmateBoundTool = NonNullable<ReturnType<(typeof CREWMATE_TOOLS)[number]["bind"]>>;

/** app_change's value is an open object on the wire; the catalog line types it per action. */
type AppChangeCall = {
  [A in ActionName]: {
    name: "app_change";
    args: { action: A; value: ActionValue<A>; evidence: string; on_words?: boolean };
  };
}[ActionName];

export type FirstmateCall =
  | Exclude<ToolCallOf<FirstmateTool>, { name: "app_change" }>
  | AppChangeCall;
export type CrewmateCall = ToolCallOf<CrewmateBoundTool>;

/** The arguments the live tool of this name takes. */
export type ScriptedArgs<N extends ScriptedCall["name"]> = Extract<
  ScriptedCall,
  { name: N }
>["args"];

/** One action a scripted card declares, as emit_card takes it. */
export type ScriptedCardAction = NonNullable<ScriptedArgs<"emit_card">["actions"]>[number];

/** A Firstmate call in Ollama's native wire shape, for a local-model stand-in. */
export function nativeCall(id: string, call: FirstmateCall) {
  return { id, function: { name: call.name, arguments: call.args } };
}
