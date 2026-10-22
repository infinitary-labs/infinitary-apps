import { validateToolArguments } from "@earendil-works/pi-ai";
import { fixedHoldWords, softHoldWords } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { claudeToolsOf } from "../claude/claudeTaskTools";
import { createTaskTools, type TaskToolsDelegate } from "./taskTools";
import { piToolsOf } from "./toolSpec";

// Loading Claude's tool server runs the SDK's import-time environment write,
// so this file runs as unit-isolated (docs/test-cohorts.md).

function toolset() {
  const delegate: TaskToolsDelegate = {
    plan: vi.fn(() => ({ taskId: "ab12cd34", key: "SCR-3", text: "Planned SCR-3" })),
    update: vi.fn(() => ({ text: "Updated SCR-3: title", ok: true })),
    drop: vi.fn(() => "Dropped SCR-3"),
    withdrawMerge: vi.fn(() => "Withdrew the captain's kept merge approval on SCR-3."),
    override: vi.fn(() => "Recorded the captain's override on SCR-3."),
    withdrawOverride: vi.fn(() => "Took back the captain's override on SCR-3."),
    link: vi.fn(() => "Recorded: SCR-1 blocks SCR-3"),
    query: vi.fn(() => ({ rows: [], total: 0 })),
    startAgain: vi.fn(async () => "SCR-4 replaces SCR-3. Started SCR-4."),
    startNow: vi.fn(async () => 'Started SCR-3 "Fix meter".'),
  };
  return { delegate };
}

/**
 * INF-762, found running the agent's-reach story (INF-495): "Every refusal
 * ends with its hold's sentence" (docs/delivery-rigor.md, "The holds"). An
 * override naming a hold it cannot pass reaches the tool on both runtimes
 * and is refused in that hold's own words, with nothing recorded, rather
 * than stopped by the schema with no hold named.
 */
describe("update_task override", () => {
  /** The first mate's call through each runtime's own check of its arguments, then the tool. */
  async function onBothRuntimes(override: { holds: string[]; until: string }) {
    const call = { id: "call-1", name: "update_task", arguments: { task: "SCR-3", override } };
    const pi = toolset();
    const piTool = piToolsOf(createTaskTools(pi.delegate)).find(
      (tool) => tool.name === "update_task",
    );
    // What Pi's agent loop hands the tool after checking the call against its schema.
    const piArgs = validateToolArguments(piTool as never, { type: "toolCall", ...call } as never);
    const piResult = await piTool?.execute("call-1", piArgs, undefined, undefined, {} as never);
    const claude = toolset();
    const claudeTool = claudeToolsOf(createTaskTools(claude.delegate)).find(
      (tool) => tool.name === "update_task",
    );
    // What the Claude client hands the tool after parsing the call with the served schema.
    const claudeArgs = z
      .object(claudeTool?.inputSchema as Record<string, z.ZodType>)
      .parse(call.arguments);
    const claudeResult = await claudeTool?.handler(claudeArgs as never, {});
    const textOf = (content: unknown) => (content as { text: string }[] | undefined)?.[0]?.text;
    return [
      { runtime: "pi", text: textOf(piResult?.content), delegate: pi.delegate },
      { runtime: "claude", text: textOf(claudeResult?.content), delegate: claude.delegate },
    ];
  }

  it("refuses a fixed limit in its own sentence and records nothing", async () => {
    // The first mate's call when GitHub's own rule holds the merge and the
    // captain said to merge anyway.
    for (const { runtime, text, delegate } of await onBothRuntimes({
      holds: ["checks", "host-rules"],
      until: "version",
    })) {
      expect(text, runtime).toMatch(/nothing was recorded/);
      expect(text?.endsWith(fixedHoldWords("host-rules")), runtime).toBe(true);
      expect(delegate.override, runtime).not.toHaveBeenCalled();
    }
  });

  it("refuses a soft hold with its own way in that way's sentence", async () => {
    for (const { runtime, text, delegate } of await onBothRuntimes({
      holds: ["escalation"],
      until: "task",
    })) {
      expect(text?.endsWith(softHoldWords("escalation", "firstmate")), runtime).toBe(true);
      expect(delegate.override, runtime).not.toHaveBeenCalled();
    }
  });

  it("still records the soft holds an override passes", async () => {
    for (const { runtime, text, delegate } of await onBothRuntimes({
      holds: ["review", "live-proof"],
      until: "task",
    })) {
      expect(text, runtime).toBe("Recorded the captain's override on SCR-3.");
      expect(delegate.override, runtime).toHaveBeenCalledWith({
        task: "SCR-3",
        holds: ["review", "live-proof"],
        until: "task",
      });
    }
  });
});
