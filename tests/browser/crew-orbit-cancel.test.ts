import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { openCrewWindow, paint, ringSize } from "./crewOrbit";

test("a cancelled crewmate leaves the ring", async () => {
  await commands.emulateReducedMotion("no-preference");
  const crew = await openCrewWindow();
  await expect.poll(ringSize).toBe(0);
  expect(paint().count).toBe(0);

  crew.arrive();
  await expect.poll(ringSize).toBe(1);
  await expect.poll(() => paint().count).toBeGreaterThan(40);

  crew.cancel();
  await expect.poll(ringSize).toBe(0);
  await expect.poll(() => paint().count).toBe(0);
});
