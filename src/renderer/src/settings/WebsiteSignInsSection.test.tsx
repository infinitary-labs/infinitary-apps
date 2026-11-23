import * as m from "@shared/i18n/messages.generated";
import { ASK_EACH_TIME_LABEL, USE_WITHOUT_ASKING_LABEL } from "@shared/taskBrowser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  savedWhen,
  signInsInSecrets,
  WEBSITE_SIGN_INS_WORDS,
  WebsiteSignInsSectionView,
} from "./WebsiteSignInsSection";

/**
 * Settings' Website sign-ins (docs/task-browser.md, "Signed-in sites"; the
 * design skill's components/cards/TaskBrowser): one row per site with when
 * the captain signed in, the rule for later tasks and Remove, one list per
 * computer, and nothing at all where this build keeps no task browsers. Last
 * in Secrets wherever that tab is offered, else in General.
 */

const NOW = new Date(2026, 9, 4, 15, 0).getTime();
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

describe("the signed-in sites each computer keeps, in Settings", () => {
  it("lists one row per site, with when the captain signed in, the rule and Remove", () => {
    const html = render({
      available: true,
      signIns: [
        { site: "aurora.example", savedAt: new Date(2026, 9, 2, 9, 0).getTime(), id: "a" },
        {
          site: "localhost:5173",
          savedAt: new Date(2026, 9, 4, 11, 0).getTime(),
          id: "b",
          automatic: true,
        },
      ],
    });
    expect(html).toContain("Website sign-ins");
    expect(html).toContain(markup(WEBSITE_SIGN_INS_WORDS.lead));
    expect(html).toContain('data-website-sign-in="aurora.example"');
    expect(html).toContain('data-website-sign-in="localhost:5173"');
    expect(html).toContain("signed in today");
    expect(html.match(/>Remove</g)).toHaveLength(2);
    // The captain's plan: ask me each time, or use it without asking, per site.
    expect(html.match(/data-website-sign-in-rule=""/g)).toHaveLength(2);
    expect(html).toContain(markup(ASK_EACH_TIME_LABEL));
    expect(html).toContain(markup(USE_WITHOUT_ASKING_LABEL));
    expect(html.match(/<option value="automatic" selected="">/g)).toHaveLength(1);
    expect(html).not.toContain(markup(WEBSITE_SIGN_INS_WORDS.empty));
  });

  // INF-4585's plan: Settings lists the sites you are signed in to on each computer.
  it("lists each computer that runs work under its own name", () => {
    const html = render({
      available: true,
      signIns: [],
      computers: [
        {
          deviceId: "mini",
          name: "Mac mini",
          signIns: [{ site: "aurora.example", savedAt: NOW, id: "a" }],
        },
        { deviceId: "pc", name: "Windows PC", signIns: [], unreachable: true },
      ],
    });
    expect(html).toContain(markup(m.settingsWebsiteSignInsOn({ computer: "Mac mini" })));
    expect(html).toContain('data-website-sign-ins-computer="mini"');
    expect(html).toContain('data-website-sign-in="aurora.example"');
    expect(html).toContain(markup(m.settingsWebsiteSignInsUnreachable({ computer: "Windows PC" })));
  });

  // The captain's answer on INF-4597's review: "Say the sign-in stays, and add Remove all to Settings."
  it("offers Remove all under each computer's list, an empty one too, naming the computer", () => {
    const html = renderToStaticMarkup(
      <WebsiteSignInsSectionView
        view={{
          available: true,
          signIns: [],
          computers: [
            {
              deviceId: "mini",
              name: "Mac mini",
              signIns: [{ site: "aurora.example", savedAt: NOW, id: "a" }],
            },
          ],
        }}
        now={NOW}
        removing={null}
        error={null}
        onRemove={noop}
        onRemoveAll={noop}
      />,
    );
    expect(html.match(/>Remove all</g)).toHaveLength(2);
    expect(html).toContain(markup(m.settingsWebsiteSignInsRemoveAllHint({ computer: "Mac mini" })));
  });

  it("says how one is added while none is", () => {
    const html = render({ available: true, signIns: [] });
    expect(html).toContain(markup(WEBSITE_SIGN_INS_WORDS.empty));
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

  it("says when the captain signed in to each: today, yesterday, or the day", () => {
    expect(savedWhen(new Date(2026, 9, 4, 0, 5).getTime(), NOW)).toBe("signed in today");
    expect(savedWhen(new Date(2026, 9, 3, 23, 55).getTime(), NOW)).toBe("signed in yesterday");
    expect(savedWhen(new Date(2026, 9, 1, 12, 0).getTime(), NOW)).toBe(
      `signed in ${new Date(2026, 9, 1).toLocaleDateString([], { month: "short", day: "numeric" })}`,
    );
  });
});
