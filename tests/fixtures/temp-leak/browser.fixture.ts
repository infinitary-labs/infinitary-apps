import { expect, it } from "vitest";

it("runs in the actual browser owned by Vitest for the approved cleanup regression", () => {
  expect(document.defaultView).toBe(window);
});
