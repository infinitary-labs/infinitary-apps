import { isAbsolute } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { outsideWorkingCopy, outsideWorkingCopyText } from "../session/fencedReads";

/** The client's own tools a fenced session keeps: reads, and no shell, web or subagent. */
// i18n-exempt: the client's own tool names
export const CLAUDE_FENCED_TOOLS = ["Read", "Grep", "Glob"] as const;

function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The refusal for one call of the client's reads, or undefined when every
 * path it names stays in the working copy. Glob's pattern is a path too: an
 * absolute one, or one that climbs, searches outside.
 */
export function claudeFenceRefusal(cwd: string, tool: string, input: unknown): string | undefined {
  const paths =
    tool === "Read"
      ? [stringField(input, "file_path")]
      : tool === "Grep" || tool === "Glob"
        ? [stringField(input, "path")]
        : [];
  for (const path of paths) {
    const refused = path === undefined ? undefined : outsideWorkingCopy(cwd, path);
    if (refused) return refused;
  }
  if (tool === "Glob") {
    const pattern = stringField(input, "pattern");
    if (
      pattern !== undefined &&
      (isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes(".."))
    )
      return outsideWorkingCopyText(pattern);
  }
  return undefined;
}

/** The fenced session's gate, asked by the client before each call it would run. */
export function claudeFenceHook(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const refused = claudeFenceRefusal(cwd, input.tool_name, input.tool_input);
    return refused
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: refused,
          },
        }
      : {};
  };
}
