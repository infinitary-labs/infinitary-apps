import { expect, it } from "vitest";
import { cache } from "./cache";

it("sees the preceding file's module cache", () => {
  expect(++cache.visits).toBe(2);
});
