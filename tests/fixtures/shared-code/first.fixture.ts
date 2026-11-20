import { afterAll, expect, it } from "vitest";
import { cache } from "./cache";

it("shares loaded code without changing process state", () => {
  expect(++cache.visits).toBeGreaterThan(0);
  if (process.env.INFINITARY_FIXTURE_STATE_LEAK === "env")
    process.env.INFINITARY_LEAK_SENTINEL = "leak";
  if (process.env.INFINITARY_FIXTURE_STATE_LEAK === "clock") Date.now = () => 0;
});
afterAll(() => {
  if (process.env.INFINITARY_FIXTURE_STATE_LEAK === "teardown")
    process.env.INFINITARY_LEAK_SENTINEL = "leak";
});
