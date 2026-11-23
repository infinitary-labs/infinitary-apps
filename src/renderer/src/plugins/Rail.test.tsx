import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { SidePanelContribution } from "./contributions";
import { panelRail } from "./panelRail";
import { createPanelSource } from "./panelSource";
import { Rail } from "./Rail";
import { railStore } from "./railStore";

/**
 * D5 rules 1 and 4 at the component level: an empty rail is an empty
 * element (the stylesheet gives a rail with no shown panel zero width,
 * checked against the built app in tests/e2e/side-rails.spec.ts), and the
 * chrome around a panel body is the host's, drawn from manifest data.
 */

function panel(
  id: string,
  content: string | null,
  overrides: Partial<SidePanelContribution<string>> = {},
): SidePanelContribution {
  const { source } = createPanelSource<string>(content);
  const contribution = {
    id,
    pluginId: "acme",
    attribution: "Acme",
    title: `Panel ${id}`,
    preferredPlacement: { x: "left", y: "top" },
    order: 0,
    size: "content",
    source,
    Body: ({ content }: { content: string }) => (
      <p>
        <strong>body:</strong> {content}
      </p>
    ),
    ...overrides,
  };
  return contribution as unknown as SidePanelContribution;
}

beforeEach(() => {
  railStore.reset();
  panelRail.forget("board");
});

describe("Rail", () => {
  it("draws the busy dot in the header only while a panel's running source says so", () => {
    const running = createPanelSource<boolean>(true);
    const html = renderToStaticMarkup(
      <Rail side="right" panels={[panel("mine", "x", { running: running.source })]} theme="dark" />,
    );
    expect(html).toContain('data-side-panel-running=""');
    expect(html).toContain('aria-label="Still working on this"');
    // INF-27 (FI3-1540): the dot alone says it, so it is a keyboard stop
    // whose words show on rest, never a native title.
    const dot = html.match(/<span[^>]*aria-label="Still working on this"[^>]*>/)?.[0] ?? "";
    expect(dot).toContain('tabindex="0"');
    expect(dot).not.toContain("title=");
    const idle = renderToStaticMarkup(
      <Rail side="right" panels={[panel("mine", "x")]} theme="dark" />,
    );
    expect(idle).not.toContain("data-side-panel-running");
  });

  it("renders an empty element with no panels: nothing inside for :empty to miss", () => {
    expect(renderToStaticMarkup(<Rail side="left" panels={[]} theme="dark" />)).toBe(
      '<div data-rail="left"></div>',
    );
  });

  it("renders nothing for a panel whose source has no content - visibility is data", () => {
    const html = renderToStaticMarkup(
      <Rail side="right" panels={[panel("quiet", null)]} theme="dark" />,
    );
    expect(html).toBe('<div data-rail="right"></div>');
  });

  it("frames a panel with host-owned title, attribution, placement, and collapse around the body", () => {
    const html = renderToStaticMarkup(
      <Rail
        side="left"
        panels={[panel("board", "three open", { preferredPlacement: { x: "left", y: "bottom" } })]}
        theme="dark"
      />,
    );
    expect(html).toContain(
      '<section data-side-panel="board" data-side-panel-size="content" data-side-panel-placement-y="bottom" aria-label="Panel board"',
    );
    expect(html).toContain("Panel board");
    // One of the window's parts F6 moves between.
    expect(html).toContain('data-window-region="panel"');
    expect(html).toContain('data-side-panel-attribution=""');
    expect(html).toContain(">Acme<");
    expect(html).toContain('aria-label="Collapse Panel board"');
    expect(html).toContain('aria-expanded="true"');
    // The plugin's output sits inside the body region and nowhere else.
    const bodyStart = html.indexOf('data-side-panel-body=""');
    expect(bodyStart).toBeGreaterThan(html.indexOf("Collapse Panel board"));
    expect(html.indexOf("<strong>body:</strong>")).toBeGreaterThan(bodyStart);
  });

  it("keeps the header and drops the body when collapsed, so the rail stays non-empty", () => {
    railStore.toggleCollapsed("board");
    const html = renderToStaticMarkup(
      <Rail side="left" panels={[panel("board", "three open")]} theme="dark" />,
    );
    expect(html).toContain('aria-label="Expand Panel board"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("transform:rotate(180deg)");
    expect(html).not.toContain("data-side-panel-body");
    expect(html).not.toContain("three open");
  });

  it("keeps a panel that speaks for itself running while collapsed, drawing what it said it holds (FI3-1014 piece 5)", () => {
    railStore.toggleCollapsed("board");
    panelRail.summarize("board", [{ text: "2 waiting", strong: true }, { text: "1 working" }]);
    const html = renderToStaticMarkup(
      <Rail
        side="left"
        panels={[panel("board", "three open", { rail: { decides: false } })]}
        theme="dark"
      />,
    );
    // Its body is still there, out of sight, so its page runs on.
    expect(html).toContain('data-side-panel-body="" hidden=""');
    expect(html).toContain("three open");
    expect(html).toContain('data-panel-summary=""');
    expect(html).toContain(
      '<span data-panel-summary-part="" data-strong="" style="color:var(--fg-1)">2 waiting</span> · <span data-panel-summary-part="">1 working</span>',
    );
    railStore.toggleCollapsed("board");
    const open = renderToStaticMarkup(
      <Rail
        side="left"
        panels={[panel("board", "three open", { rail: { decides: false } })]}
        theme="dark"
      />,
    );
    expect(open).not.toContain("data-panel-summary");
    expect(open).not.toContain('data-side-panel-body="" hidden=""');
  });

  it("draws a line the panel said in its title's place, as a button that opens the panel, its name kept", () => {
    railStore.toggleCollapsed("board");
    const draw = () =>
      renderToStaticMarkup(
        <Rail
          side="left"
          panels={[panel("board", "three open", { rail: { decides: false } })]}
          theme="dark"
        />,
      );
    panelRail.summarize("board", [{ text: "quiet" }]);
    expect(draw()).toContain(">Panel board</span>");

    panelRail.summarize("board", [
      { line: "reported: Steady as she goes.", lead: "SCR-1", tone: "info" },
      { text: "now" },
    ]);
    const html = draw();
    expect(html).not.toContain(">Panel board</span>");
    expect(html).toContain('aria-label="Panel board"');
    expect(html).toContain('aria-label="Expand Panel board"');
    expect(html).toContain('aria-description="SCR-1 reported: Steady as she goes."');
    expect(html).toMatch(
      /<button type="button" aria-label="Open Panel board" aria-description="SCR-1 reported: Steady as she goes\." data-panel-summary-line=""/,
    );
    expect(html).toContain("var(--fg-2)");
    expect(html).toContain('<span data-panel-summary-part="">now</span>');

    railStore.toggleCollapsed("board");
    const open = draw();
    expect(open).toContain(">Panel board</span>");
    expect(open).not.toContain("data-panel-summary-line");
  });

  it("keeps a panel whose own code decides off its rail, still mounted, until it says to show", () => {
    const draw = () =>
      renderToStaticMarkup(
        <Rail
          side="left"
          panels={[panel("board", "three open", { rail: { decides: true } })]}
          theme="dark"
        />,
      );
    expect(draw()).toContain('<section hidden="" data-side-panel="board"');
    expect(draw()).toContain("three open");
    panelRail.show("board", true, true);
    expect(draw()).not.toContain("<section hidden");
    panelRail.show("board", false, true);
    expect(draw()).toContain('<section hidden="" data-side-panel="board"');
  });

  it("attributes a third party's panel and never the host's own", () => {
    const html = renderToStaticMarkup(
      <Rail
        side="left"
        panels={[panel("board", "open", { attribution: null }), panel("queue", "two")]}
        theme="dark"
      />,
    );
    const board = html.slice(
      html.indexOf('data-side-panel="board"'),
      html.indexOf('data-side-panel="queue"'),
    );
    expect(board).not.toContain("data-side-panel-attribution");
    expect(html.slice(html.indexOf('data-side-panel="queue"'))).toContain(">Acme<");
  });

  it("marks a fill panel for the stylesheet and drops the mark when collapsed", () => {
    const fill = panel("feed", "lines", { size: "fill" });
    expect(renderToStaticMarkup(<Rail side="left" panels={[fill]} theme="dark" />)).toContain(
      'data-side-panel="feed" data-side-panel-size="fill" data-side-panel-placement-y="top" aria-label',
    );
    railStore.toggleCollapsed("feed");
    expect(renderToStaticMarkup(<Rail side="left" panels={[fill]} theme="dark" />)).toContain(
      'data-side-panel-size="fill" data-side-panel-placement-y="top" data-side-panel-collapsed=""',
    );
  });

  it("mounts a Tier-2 panel's template in the frame vehicle inside the same chrome", () => {
    const framed = panel("feed", "lines", {
      frame: { html: "<p>feed</p>", script: "void 0;" },
      Body: undefined,
    });
    const html = renderToStaticMarkup(<Rail side="left" panels={[framed]} theme="dark" />);
    expect(html).toContain('<section data-side-panel="feed"');
    // Before the host answers the mount request there is a placeholder in
    // the body region, never the template's markup in the app document.
    expect(html).toContain('data-frame-mount-pending=""');
    expect(html).not.toContain("<p>feed</p>");
  });

  it("stacks only the panels with content, in the order given", () => {
    const html = renderToStaticMarkup(
      <Rail
        side="left"
        panels={[panel("a", "first"), panel("b", null), panel("c", "third")]}
        theme="dark"
      />,
    );
    expect(html).toContain('data-side-panel="a"');
    expect(html).not.toContain('data-side-panel="b"');
    expect(html.indexOf('data-side-panel="a"')).toBeLessThan(html.indexOf('data-side-panel="c"'));
  });
});

describe("INF-609's own expand and lasting More choice", () => {
  // INF-2344, captain: "Yes, to the end of its slot, saved in the layout
  // where you can see it." A More pick moves the panel to its slot's edge
  // (the bottom of a bottom group) and stays through hydration.
  it("pins an explicit expand in the existing collapse record and keeps a More pick at its slot's edge through hydration", () => {
    const known = [
      { id: "board", preferred: { x: "left", y: "bottom" }, order: 0 },
      { id: "another", preferred: { x: "left", y: "bottom" }, order: 1 },
    ] as const;
    railStore.expand("board");
    expect(railStore.isCollapsed("board")).toBe(false);
    expect(railStore.layout().collapsedPanels.board).toBe(false);
    railStore.promote("board", known);
    railStore.promote("another", known);
    railStore.promote("board", known);
    const saved = railStore.layout();
    railStore.reset();
    railStore.hydrate(saved);
    expect(railStore.layout().arrangement?.left.bottom).toEqual(["another", "board"]);
    expect(railStore.morePick()).toBe("board");
    expect(railStore.isCollapsed("board")).toBe(false);
  });
});
