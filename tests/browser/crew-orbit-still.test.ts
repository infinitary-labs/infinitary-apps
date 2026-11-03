import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { openCrewWindow, paint, ringSize } from "./crewOrbit";

test("under reduced motion a crewmate appears settled: one still frame", async () => {
  await commands.emulateReducedMotion("reduce");
  const crew = await openCrewWindow();
  await expect.poll(ringSize).toBe(0);
  crew.arrive();
  await expect.poll(ringSize).toBe(1);
  await expect.poll(() => paint().count).toBeGreaterThan(0);
  // Counted in drawing frames, not time: across them nothing on the ring moves.
  const first = paint().digest;
  for (let frames = 0; frames < 30; frames++)
    await new Promise((done) => requestAnimationFrame(done));
  expect(paint().digest).toBe(first);
});
