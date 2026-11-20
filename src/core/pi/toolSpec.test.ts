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
  // Declaration does not require provider cancellation; the next case
  // keeps ordinary Pi turn cancellation local to that runtime.
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

// Intent: The captain limited INF-312 F3 to Claude giving up, not Pi turn cancellation.
it("does not forward Pi turn cancellation to a bound tool", async () => {
  const { piToolsOf } = await import("./toolSpec");
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const [tool] = piToolsOf([
    boundTool({
      name: "cancel",
      label: "Cancel",
      description: "Observe cancellation.",
      parameters: Type.Object({}),
      run: (_params, signal) => {
        received = signal;
        return { text: "Observed." };
      },
    }),
  ]);
  const execute = tool?.execute as (
    id: string,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  await execute("cancel-1", {}, controller.signal);
  expect(received).toBeUndefined();
});
