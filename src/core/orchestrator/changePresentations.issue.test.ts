import { describe, expect, it } from "vitest";
import { arrange, BRANCH, TASK } from "../../../tests/helpers/changePresentationsHarness";

// Intent: INF-6776's approved plan, part 1 ("Either way"): the app writes no
// closing line of its own for a change linked to an outside issue. An outside
// action, such as closing an issue, is its own task waiting on the work, and
// the intake round closes an outside reporter's issue with its thank-you.

describe("a change linked to an outside issue", () => {
  it("publishes the crewmate's words and the story with no closing line from the app", async () => {
    const issue = { number: 7, url: "https://github.com/example-studio/evidence-sample/issues/7" };
    const at = await arrange({ shape: { kind: "fix", issue } });
    await at.prepare();
    await at.service.publish(TASK, 1, at.forge, BRANCH, at.draft.title, "pending");
    const body = at.change?.body ?? "";
    // The crewmate's projectText, then the story: nothing of the app's own between them.
    expect(body.startsWith(`Closes #24\n\n<!-- `)).toBe(true);
    expect(body).not.toContain("#7");
  });
});
