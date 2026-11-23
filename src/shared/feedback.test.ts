import { describe, expect, it } from "vitest";
import { typingSlashCommand } from "./composer";
import { feedbackMark, isFeedbackRequest } from "./feedback";

/**
 * Intent: the approved /feedback plan - "a leading /feedback (any letter
 * case)" from any message box is a feedback request, and typing a slash
 * shows the slash hint. The words are lines a person types.
 */
describe("a feedback request", () => {
  it.each([
    "/feedback the merge card never showed its checks",
    "/Feedback the merge card never showed its checks",
    "  /FEEDBACK\nThe reply box loses focus",
    "/feedback",
  ])("is a message that starts with /feedback: %j", (text) => {
    expect(isFeedbackRequest(text)).toBe(true);
  });

  it.each([
    "please send /feedback about this",
    "/feedbacks are welcome",
    "feedback: the card is slow",
    "/review the change",
  ])("is not %j", (text) => {
    expect(isFeedbackRequest(text)).toBe(false);
  });

  it("marks a draft with its kind and a version that holds nothing else", () => {
    expect(feedbackMark("idea", "0.8.6-alpha.23")).toBe(
      "<!-- infinitary-feedback v1 kind=idea version=0.8.6-alpha.23 -->",
    );
    expect(feedbackMark("bug", "1.0.0 --><script>")).toBe(
      "<!-- infinitary-feedback v1 kind=bug version=1.0.0--script -->",
    );
  });
});

describe("the slash hint", () => {
  it.each(["/", "/fe", "/FEEDBACK", "/feedback the card is slow"])("shows for %j", (text) => {
    expect(typingSlashCommand(text)).toBe(true);
  });

  it.each(["", "hello", "/review", "/feedbackx", "a /feedback"])("does not show for %j", (text) => {
    expect(typingSlashCommand(text)).toBe(false);
  });
});
