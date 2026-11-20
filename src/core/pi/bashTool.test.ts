import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createEventBashTool, type EventBashInput } from "./bashTool";

describe("the crewmate's event-driven bash", () => {
  it("takes the line the record shows for a command, and runs the command alone", async () => {
    const ran: EventBashInput[] = [];
    const tool = createEventBashTool(async (input) => {
      ran.push(input);
      return { kind: "done", exitCode: 0, output: "ok" };
    });
    const parameters = tool.parameters as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(parameters.properties.description?.type).toBe("string");
    expect(parameters.required ?? []).not.toContain("description");

    const result = await tool.execute(
      "c1",
      { command: "pnpm test", description: "Run the unit tests" },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    expect(ran).toEqual([{ command: "pnpm test" }]);
    expect(result.content).toEqual([{ type: "text", text: "exit 0\nok" }]);
  });
});
