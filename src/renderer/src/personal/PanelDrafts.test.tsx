import type { PersonalExtensionView } from "@shared/personal/manifest";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelDrafts, panelDrafts } from "./PanelDrafts";

/**
 * The stage a crewmate's capture photographs (docs/personal-panels.md,
 * "Built apart"): each draft in the chrome a rail gives it, under its
 * draft id, inert and hidden from assistive technology so nothing of the
 * captain's reaches it. Whether it is out of sight is the stylesheet's
 * (`[data-panel-draft]` in design/styles.css), and the capture of it is
 * tests/e2e/personal-panels.spec.ts's.
 */
function draft(overrides: Partial<PersonalExtensionView> & { id: string }): PersonalExtensionView {
  return {
    source: "yours",
    by: null,
    frame: null,
    title: overrides.id,
    placement: { x: "left", y: "top" },
    order: 100,
    size: "content",
    present: true,
    ownPresence: false,
    moves: false,
    running: true,
    reads: [],
    sql: [],
    panel: {
      url: `app-plugin://personal/${overrides.id}/0123456789abcdef/panel.mjs`,
      version: "0123456789abcdef",
    },
    server: null,
    cardViews: [],
    cards: {},
    header: [],
    commands: [],
    error: null,
    ...overrides,
  };
}

describe("PanelDrafts", () => {
  afterEach(() => {
    panelDrafts.set([]);
    vi.unstubAllGlobals();
  });

  it("draws each draft that shows in a rail's chrome under its draft id, inert and hidden", () => {
    vi.stubGlobal("window", { infinitary: { plugins: { db: {}, invoke: async () => ({}) } } });
    panelDrafts.set([
      draft({ id: "clock", title: "Tokyo clock" }),
      draft({ id: "quiet", present: false }),
      draft({ id: "broken", panel: null }),
    ]);
    const html = renderToStaticMarkup(<PanelDrafts />);
    expect(html.match(/data-panel-draft="[^"]+"/g)).toEqual(['data-panel-draft="clock"']);
    expect(html).toContain('<div data-panel-draft="clock" aria-hidden="true" inert="">');
    expect(html).toContain('data-side-panel="clock.draft"');
    expect(html).toContain('aria-label="Tokyo clock"');
    expect(html).toContain("data-side-panel-attribution");
    expect(html).not.toContain("data-side-panel-running");
  });
});
