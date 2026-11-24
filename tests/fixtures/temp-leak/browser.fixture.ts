import { expect, it } from "vitest";
import { commands } from "vitest/browser";

it("runs in the actual browser owned by Vitest for the approved cleanup regression", async () => {
  expect(document.defaultView).toBe(window);
  await commands.leaveInRunRoot();
});
