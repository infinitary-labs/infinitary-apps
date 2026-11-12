import * as m from "@shared/i18n/messages.generated";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  savedWhen,
  signInsInSecrets,
  WEBSITE_SIGN_INS_EMPTY,
  WEBSITE_SIGN_INS_LEAD,
  WebsiteSignInsSectionView,
} from "./WebsiteSignInsSection";

/**
 * Settings' Website sign-ins (docs/task-browser.md, "Saved sign-ins"; the
 * design skill's components/cards/TaskBrowser): one row per site with when it
 * was saved and Remove, and nothing at all where this build keeps no task
 * browsers. Last in Secrets wherever that tab is offered, else in General.
 */

const NOW = new Date(2026, 9, 4, 15, 0).getTime();
/** Words as the static markup writes them. */
const markup = (text: string) => text.replace(/'/g, "&#x27;");
const noop = () => {};

function render(
  view: Parameters<typeof WebsiteSignInsSectionView>[0]["view"],
  removing = null,
  inSecrets = false,
) {
  return renderToStaticMarkup(
    <WebsiteSignInsSectionView
      view={view}
      now={NOW}
      removing={removing}
      error={null}
      onRemove={noop}
      inSecrets={inSecrets}
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

  // INF-1493's approved direction A: in Secrets the lead says the sign-ins keep their own storage.
  it("says in Secrets, and only there, that the sign-ins are not in protected storage", () => {
    const view = { available: true, signIns: [] };
    const storage = markup(m.settingsWebsiteSignInsStorage());
    expect(render(view, null, true)).toContain(storage);
    expect(render(view, null, false)).not.toContain(storage);
  });

  // INF-1493's approved direction A, placement end: the section moves with the Secrets tab
  // and stays in General wherever that tab is not offered.
  it("sits in Secrets only where this window offers that tab", () => {
    const view = {
      role: "view",
      name: "MacBook Pro",
      address: "192.168.1.20",
      joinedAt: 0,
      contact: "in-reach",
      readOnly: null,
      heardAt: null,
      caughtUp: 1,
    } as const;
    expect(signInsInSecrets(true, { role: "home", left: null })).toBe(true);
    expect(signInsInSecrets(true, null)).toBe(true);
    expect(signInsInSecrets(false, { role: "home", left: null })).toBe(false);
    expect(signInsInSecrets(true, view)).toBe(false);
  });

  it("says when each was saved: today, yesterday, or the day", () => {
    expect(savedWhen(new Date(2026, 9, 4, 0, 5).getTime(), NOW)).toBe("saved today");
    expect(savedWhen(new Date(2026, 9, 3, 23, 55).getTime(), NOW)).toBe("saved yesterday");
    expect(savedWhen(new Date(2026, 9, 1, 12, 0).getTime(), NOW)).toBe(
      `saved ${new Date(2026, 9, 1).toLocaleDateString([], { month: "short", day: "numeric" })}`,
    );
  });
});
