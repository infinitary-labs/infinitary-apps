import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloseQuestion, closeQuestionWords } from "./CloseQuestion";

/**
 * The close's question says closing discards what the captain picked (the
 * captain's Build it on the close-question prototype, 2026-10-04).
 */
describe("closeQuestionWords", () => {
  it("counts picked answers on a decision", () => {
    expect(closeQuestionWords(2, false)).toBe("You picked 2 answers. Closing will discard them.");
    expect(closeQuestionWords(1, false)).toBe("You picked 1 answer. Closing will discard it.");
  });

  it("counts changed settings on a preview", () => {
    expect(closeQuestionWords(3, true)).toBe("You changed 3 settings. Closing will discard them.");
    expect(closeQuestionWords(1, true)).toBe("You changed 1 setting. Closing will discard it.");
  });
});

describe("CloseQuestion", () => {
  const trigger = { current: null };
  const ask = { onClose: () => {}, onKeep: () => {} };

  it("draws nothing while the close is not asking", () => {
    expect(
      renderToStaticMarkup(
        <CloseQuestion ask={undefined} count={2} preview={false} trigger={trigger} />,
      ),
    ).toBe("");
  });

  it("asks with Keep answering beside Discard and close", () => {
    const html = renderToStaticMarkup(
      <CloseQuestion ask={ask} count={2} preview={false} trigger={trigger} />,
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Close this card?"');
    expect(text).toContain("You picked 2 answers. Closing will discard them.");
    expect(text.indexOf("Keep answering")).toBeLessThan(text.indexOf("Discard and close"));
  });
});
