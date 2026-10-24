import { describe, expect, it } from "vitest";
import { createDarwinFreshAuthentication } from "./darwinFreshAuthentication";

// Intent: INF-1105 - fresh system authentication for a human Allow: the macOS
// binding reaches LocalAuthentication, and a confirmation the system could not
// ask the person for approves nothing (docs/secrets.md, "Trusted approvals").
// No prompt appears: interaction is refused, so the system answers at once.
describe.skipIf(process.platform !== "darwin")("macOS fresh authentication", () => {
  it("answers whether this Mac can confirm its owner, and approves nothing it could not ask", async () => {
    const silent = createDarwinFreshAuthentication({ interactionNotAllowed: true });
    expect(silent).toBeDefined();
    expect(typeof (await silent?.available())).toBe("boolean");
    expect(await silent?.confirm("Check the Secrets binding")).toBe(false);
    // A second confirmation gets a new context of its own and answers the same.
    expect(await silent?.confirm("Check the Secrets binding again")).toBe(false);
  });
});
