import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  savedWhen,
  WEBSITE_SIGN_INS_EMPTY,
  WEBSITE_SIGN_INS_LEAD,
  WebsiteSignInsSectionView,
} from "./WebsiteSignInsSection";

/**
 * Settings -> General's Website sign-ins (docs/task-browser.md, "Saved
 * sign-ins"; the design skill's components/cards/TaskBrowser): one row per
 * site with when it was saved and Remove, and nothing at all where this
 * build keeps no task browsers.
 */

const NOW = new Date(2026, 9, 4, 15, 0).getTime();
/** Words as the static markup writes them. */
const markup = (text: string) => text.replace(/'/g, "&#x27;");
const noop = () => {};

function render(view: Parameters<typeof WebsiteSignInsSectionView>[0]["view"], removing = null) {
  return renderToStaticMarkup(
    <WebsiteSignInsSectionView
      view={view}
      now={NOW}
      removing={removing}
      error={null}
      onRemove={noop}
    />,
  );
}

describe("the website sign-ins saved on this Mac, in Settings", () => {
  it("lists one row per site, with when it was saved and Remove", () => {
    const html = render({
      available: true,
      signIns: [
        { site: "aurora.example", savedAt: new Date(2026, 9, 2, 9, 0).getTime() },
        { site: "localhost:5173", savedAt: new Date(2026, 9, 4, 11, 0).getTime() },
      ],
    });
    expect(html).toContain("Website sign-ins");
    expect(html).toContain(markup(WEBSITE_SIGN_INS_LEAD));
    expect(html).toContain('data-website-sign-in="aurora.example"');
    expect(html).toContain('data-website-sign-in="localhost:5173"');
    expect(html).toContain("saved today");
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html).not.toContain(markup(WEBSITE_SIGN_INS_EMPTY));
  });

  it("says how one is saved while none is", () => {
    const html = render({ available: true, signIns: [] });
    expect(html).toContain(markup(WEBSITE_SIGN_INS_EMPTY));
    expect(html).not.toContain(">Remove<");
  });

  it("draws nothing where this build keeps no task browsers", () => {
    expect(render({ available: false, signIns: [] })).toBe("");
    expect(render(null)).toBe("");
  });

  it("says when each was saved: today, yesterday, or the day", () => {
    expect(savedWhen(new Date(2026, 9, 4, 0, 5).getTime(), NOW)).toBe("saved today");
    expect(savedWhen(new Date(2026, 9, 3, 23, 55).getTime(), NOW)).toBe("saved yesterday");
    expect(savedWhen(new Date(2026, 9, 1, 12, 0).getTime(), NOW)).toBe(
      `saved ${new Date(2026, 9, 1).toLocaleDateString([], { month: "short", day: "numeric" })}`,
    );
  });
});
