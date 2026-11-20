import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerNoticeView } from "./ComposerNotice";

describe("ComposerNoticeView", () => {
  it("names its dismiss button without duplicating a card's close button", () => {
    const html = renderToStaticMarkup(
      <ComposerNoticeView width="100%" notice="picture-too-big" onDismiss={() => {}} />,
    );
    expect(html).toContain("Dismiss notice");
    expect(html).not.toContain(">Close</button>");
  });
});
