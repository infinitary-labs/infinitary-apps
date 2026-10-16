import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { boundTool } from "../session/tools";

vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("Declaring a bound tool loaded Pi's runtime");
});

it("declares and executes bound tools without initializing the Pi runtime", async () => {
  const { piToolsOf } = await import("./toolSpec");
  const run = vi.fn((params: { value: string }) => ({
    text: params.value,
    images: [{ data: "fixture-image", mimeType: "image/png" }],
    details: { recorded: true },
  }));
  const bound = boundTool({
    name: "fixture",
    label: "Fixture",
    description: "Echo the fixture input",
    parameters: Type.Object({ value: Type.String() }),
    run,
  });
  const [tool] = piToolsOf([bound]);
  expect(tool).toMatchObject({
    name: bound.name,
    label: bound.label,
    description: bound.description,
  });
  expect(tool?.parameters).toBe(bound.parameters);
  // The adapter consumes only the first two execute arguments; the real Pi
  // contract suite supplies the SDK's context and exercises this same object.
  const execute = tool?.execute as (id: string, params: unknown) => Promise<unknown>;
  expect(await execute("call-1", { value: "hello" })).toEqual({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "fixture-image", mimeType: "image/png" },
    ],
    details: { recorded: true },
  });
  expect(run).toHaveBeenCalledExactlyOnceWith({ value: "hello" });
});
