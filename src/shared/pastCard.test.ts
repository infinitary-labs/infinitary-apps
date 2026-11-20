import { describe, expect, it } from "vitest";
import { pastCardEndingWords, pastEndingWords } from "./pastCard";

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

describe("pastCardEndingWords", () => {
  // INF-500: the home's own receipt of a body-script choice on a first mate
  // card (INF-81's past-frame-main-reproduction.json) read "You chose".
  const scripted = {
    author: "firstmate" as const,
    ending: {
      how: "chose" as const,
      at: 1792413753302,
      actionId: "body",
      label: "Keep this chart",
      by: "frame" as const,
    },
  };

  it("credits a body script's choice to its card's author, never the captain", () => {
    expect(pastCardEndingWords(scripted)).toBe("Your first mate chose Keep this chart");
    expect(pastCardEndingWords({ ...scripted, author: "crewmate" })).toBe(
      "Its crewmate chose Keep this chart",
    );
    // A host card's script chooses for the first mate, as its resolution does.
    expect(pastCardEndingWords({ ...scripted, author: "host" })).toBe(
      "Your first mate chose Keep this chart",
    );
  });

  it("keeps the captain's own click his, whoever wrote the card", () => {
    const clicked = { ...scripted, ending: { ...scripted.ending, by: "captain" as const } };
    expect(pastCardEndingWords(clicked)).toBe("You chose Keep this chart");
    expect(pastCardEndingWords({ ...clicked, author: "crewmate" })).toBe(
      "You chose Keep this chart",
    );
  });
});
