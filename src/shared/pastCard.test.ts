import { describe, expect, it } from "vitest";
import { pastEndingWords } from "./pastCard";

describe("pastEndingWords", () => {
  it("says each way a card ended in the captain's words", () => {
    const at = 1;
    expect(pastEndingWords({ how: "chose", at, actionId: "go", label: "Approve and build" })).toBe(
      "You chose Approve and build",
    );
    expect(pastEndingWords({ how: "chose", at, label: "Merge", by: "crewmate" })).toBe(
      "Its crewmate chose Merge",
    );
    expect(pastEndingWords({ how: "dismissed", at })).toBe("Closed without choosing");
    expect(pastEndingWords({ how: "author-withdrawal", at })).toBe("Withdrawn by its author");
    expect(pastEndingWords({ how: "host-withdrawal", at })).toBe("Taken down by the app");
    expect(pastEndingWords({ how: "task-retired", at })).toBe("Taken down when the task ended");
    expect(pastEndingWords({ how: "duplicate", at })).toBe("Closed as a duplicate");
    expect(pastEndingWords({ how: "unknown", at })).toBe("Closed");
  });
});
