import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { CLAIMED_PORTS, portClaims } from "./claimedPort";

// INF-267: the guardrail's home must listen where no other process in the
// run can, so two workers' claimers stand in for two Playwright workers.
describe("portClaims", () => {
  it("never hands two claimers the same port, even from the same start", async () => {
    const first = portClaims(0);
    const second = portClaims(0);
    try {
      const ports = [];
      for (let round = 0; round < 3; round++) {
        ports.push(await first.claim(), await second.claim());
      }
      expect(new Set(ports).size).toBe(ports.length);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(CLAIMED_PORTS.first);
        expect(port).toBeLessThan(CLAIMED_PORTS.first + CLAIMED_PORTS.count);
      }
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  it("passes over a port another listener already holds", async () => {
    const finder = portClaims();
    const held = await finder.claim();
    await finder.release();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(held, "127.0.0.1", resolve));
    const claimer = portClaims(held - CLAIMED_PORTS.first);
    try {
      expect(await claimer.claim()).not.toBe(held);
    } finally {
      await claimer.release();
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
