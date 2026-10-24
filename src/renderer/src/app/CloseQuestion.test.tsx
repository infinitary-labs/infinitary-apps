import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloseQuestion } from "./CloseQuestion";
import {
  CLOSE_ANYWAY,
  closeQuestionWords,
  closeRestWords,
  PUT_ASIDE_INSTEAD,
  unansweredReplyWords,
} from "./closeQuestionWords";

/**
 * The close's question says closing discards what the captain picked (the
 * captain's Build it on the close-question prototype, 2026-10-04).
 */
describe("closeQuestionWords", () => {
  it("counts picked answers on a decision", () => {
    expect(closeQuestionWords(2, false)).toBe("You picked 2 answers. Closing will discard them.");
    expect(closeQuestionWords(1, false)).toBe("You picked 1 answer. Closing will discard it.");
  });

  it("names the words in the card's one field, alone or beside picks (INF-680, INF-924)", () => {
    expect(closeQuestionWords(0, false, true)).toBe("You wrote a reply. Closing will discard it.");
    expect(closeQuestionWords(2, false, true)).toBe(
      "You picked 2 answers and wrote a reply. Closing will discard them.",
    );
  });

  it("counts changed settings on a preview", () => {
    expect(closeQuestionWords(3, true)).toBe("You changed 3 settings. Closing will discard them.");
    expect(closeQuestionWords(1, true)).toBe("You changed 1 setting. Closing will discard it.");
  });
});

// INF-770: the × says where a closed card stays, and closing with a reply
// unanswered says where that answer goes.
describe("where a closed card and its answer stay", () => {
  it("names the task's record, or Tasks for a card about none", () => {
    expect(closeRestWords("INF-770")).toBe("Close · stays on INF-770's record");
    expect(closeRestWords(undefined)).toBe("Close · stays readable in Tasks");
  });

  it("names who has not answered and where the answer goes", () => {
    expect(unansweredReplyWords("crewmate 7", "INF-770")).toBe(
      "Crewmate 7 has not answered your reply yet. Closed, its answer stays on INF-770's record.",
    );
    expect(unansweredReplyWords("your first mate", undefined)).toBe(
      "Your first mate has not answered your reply yet. Closed, its answer stays readable in Tasks.",
    );
  });
});

describe("CloseQuestion", () => {
  const trigger = { current: null };
  const ask = { onClose: () => {}, onKeep: () => {}, onPutAside: () => {} };

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
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replaceAll("&#x27;", "'");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Close this card?"');
    expect(text).toContain("You picked 2 answers. Closing will discard them.");
    expect(text.indexOf("Keep answering")).toBeLessThan(text.indexOf("Discard and close"));
  });

  it("asks about an unanswered reply with Put aside instead before Close anyway", () => {
    const unanswered = { author: "crewmate 7", taskKey: "INF-770" };
    const html = renderToStaticMarkup(
      <CloseQuestion
        ask={ask}
        count={0}
        unanswered={unanswered}
        preview={false}
        trigger={trigger}
      />,
    );
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replaceAll("&#x27;", "'");
    expect(text).toContain(unansweredReplyWords("crewmate 7", "INF-770"));
    expect(text.indexOf(PUT_ASIDE_INSTEAD)).toBeLessThan(text.indexOf(CLOSE_ANYWAY));
    expect(text).not.toContain("Keep answering");
  });

  it("keeps the picks question's words and choices when a reply is unanswered too, one popover", () => {
    const html = renderToStaticMarkup(
      <CloseQuestion
        ask={ask}
        count={1}
        unanswered={{ author: "crewmate 7" }}
        preview={false}
        trigger={trigger}
      />,
    );
    const text = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .replaceAll("&#x27;", "'");
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(text).toContain(
      `${closeQuestionWords(1, false)} ${unansweredReplyWords("crewmate 7", undefined)}`,
    );
    expect(text.indexOf("Keep answering")).toBeLessThan(text.indexOf("Discard and close"));
    expect(text).not.toContain(CLOSE_ANYWAY);
  });
});
