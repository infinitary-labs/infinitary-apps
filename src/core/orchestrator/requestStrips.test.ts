import type { ForgeWriteAsk } from "@shared/writeAsk";
import { describe, expect, it } from "vitest";
import { writeAskStrip } from "./requestStrips";

/**
 * Intent: the approved /feedback plan's review strip - the captain reads the
 * issue's exact title and body as text before the click, with where and
 * under which account it is published (the captain: "the report should be
 * reviewed by the user before getting published"). The ask is the one
 * `keepFeedback` keeps for a draft.
 */
const BODY = [
  "The reply box lost focus after the first word while the checks ran.",
  "",
  "<details><summary>Diagnostics from the app</summary>",
  "",
  "- App: Infinitary 0.8.6-alpha.23 · alpha · app · en",
  "",
  "</details>",
  "",
  "<!-- infinitary-feedback v1 kind=bug version=0.8.6-alpha.23 -->",
].join("\n");

function ask(feedback: ForgeWriteAsk["feedback"], path: string, body: object): ForgeWriteAsk {
  return {
    id: "ask-1",
    kind: "github",
    host: "github.com",
    place: "GitHub",
    via: "account",
    method: "POST",
    path,
    body: JSON.stringify(body),
    feedback,
    at: 1,
  };
}

describe("a feedback write's strip", () => {
  it("draws the title and body as text, publicly, under the account", () => {
    const strip = writeAskStrip(
      ask(
        { kind: "bug", title: "Reply box loses focus while checks run", login: "octo-reader" },
        "/repos/infinitary-labs/infinitary-apps/issues",
        { title: "Reply box loses focus while checks run", body: BODY },
      ),
    );
    expect(strip).toContain("Your click publishes this on GitHub, publicly, once");
    expect(strip).toContain("A new problem report");
    expect(strip).toContain("<strong>Reply box loses focus while checks run</strong>");
    // The body as written, escaped once, never as JSON.
    expect(strip).toContain(
      "<pre data-inf-call-body>The reply box lost focus after the first word while the checks ran.\n\n&lt;details&gt;",
    );
    expect(strip).not.toContain('\\"body\\"');
    expect(strip).toContain(
      "&lt;!-- infinitary-feedback v1 kind=bug version=0.8.6-alpha.23 --&gt;",
    );
    expect(strip).toContain("POST /repos/infinitary-labs/infinitary-apps/issues");
    expect(strip).toContain("It goes under your GitHub account octo-reader.");
  });

  it("names a comment by its issue and draws no title", () => {
    const strip = writeAskStrip(
      ask(
        { kind: "idea", title: "Pin a card", commentOn: 412 },
        "/repos/infinitary-labs/infinitary-apps/issues/412/comments",
        { body: BODY },
      ),
    );
    expect(strip).toContain("A comment on issue #412");
    expect(strip).not.toContain("data-inf-call-title");
    expect(strip).toContain("It goes under your GitHub account.");
  });
});
