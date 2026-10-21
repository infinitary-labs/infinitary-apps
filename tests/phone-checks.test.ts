import { describe, expect, it } from "vitest";
import { runEveryCheck } from "../scripts/phone-checks";

// INF-663 (captain: "will that discover all the test failures across all journeys, or will it
// only discover the first one that failed?"): a failed check before the simulator tests no
// longer hides the checks after it. The messages are the native gate's own, from scripts/test-phone.ts.
const failed = (command: string, log: string) => async () => {
  throw new Error(`${command} failed (1); see ${log}`);
};

describe("the native gate's checks before its simulator tests", () => {
  it("runs every check after a failed one and reports each failure", async () => {
    const ran: string[] = [];
    const passed = (name: string) => async () => {
      ran.push(name);
    };
    const failures = await runEveryCheck(
      [
        failed("node", "/tmp/phone/iphone/1-node.log"),
        passed("theme"),
        passed("cards"),
        failed("swift", "/tmp/phone/iphone/4-swift.log"),
      ],
      () => false,
    );
    expect(ran).toEqual(["theme", "cards"]);
    expect(failures).toEqual([
      "node failed (1); see /tmp/phone/iphone/1-node.log",
      "swift failed (1); see /tmp/phone/iphone/4-swift.log",
    ]);
  });
  it("stops at once when the gate is interrupted", async () => {
    let after = false;
    await expect(
      runEveryCheck(
        [
          async () => {
            throw new Error("The native gate was interrupted");
          },
          async () => {
            after = true;
          },
        ],
        () => true,
      ),
    ).rejects.toThrow("The native gate was interrupted");
    expect(after).toBe(false);
  });
});
