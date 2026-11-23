import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type BoundTool, toolContent } from "../session/tools";

/**
 * The Pi half of the one tool spec (primitives P7): Pi's tool for a bound
 * tool. The spec itself - every entry, the bound-tool shape and the
 * Firstmate's tool set - is runtime-neutral and lives in
 * `src/core/session/tools.ts`; the Claude generator is `claudeToolOf`
 * (`src/core/claude/claudeTaskTools.ts`).
 */

export function piToolOf(tool: BoundTool): ToolDefinition {
  // defineTool is the SDK's parameter-inference identity helper. This adapter
  // already has a concrete return type: declaring data must not boot the SDK.
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, params) => {
      const output = await tool.run(params);
      return { content: toolContent(output), details: output.details ?? {} };
    },
  };
}

export function piToolsOf(tools: readonly BoundTool[]): ToolDefinition[] {
  return tools.map(piToolOf);
}
