import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bindTools, type CrewmateTool, type CrewmateToolDelegate } from "../session/tools";
import { CREWMATE_TOOLS } from "./crewmateTaskTools";
import { piToolsOf } from "./toolSpec";

/**
 * The Pi placement of the shared crewmate spec. Keep the SDK generator
 * here, not in the spec: Claude reads that same spec without loading Pi.
 */
export function createCrewmateTools(
  delegate: CrewmateToolDelegate,
  tools: readonly CrewmateTool[] = CREWMATE_TOOLS,
): ToolDefinition[] {
  return piToolsOf(bindTools(tools, delegate));
}
