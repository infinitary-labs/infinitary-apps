import { DEFAULT_LAYOUT, type Layout } from "@shared/preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railStore } from "./railStore";

/**
 * Collapse is a preference the CORE holds (the `layout` KV), not a window
 * detail: a toggle is written through, and the next launch adopts whatever
 * the core kept. `core` below stands in for that store, so a "restart" here
 * is the same round trip the app makes - write, relaunch, hydrate.
 */
function installCore() {
  const core = { layout: DEFAULT_LAYOUT as Layout };
  vi.stubGlobal("window", {
    infinitary: {
      settings: {
        setLayout: (layout: Layout) => {
          core.layout = layout;
          return Promise.resolve(layout);
        },
      },
    },
  });
  return core;
}

describe("railStore", () => {
  let core: { layout: Layout };

  beforeEach(() => {
    core = installCore();
    railStore.reset();
  });
  afterEach(() => {
    railStore.reset();
    vi.unstubAllGlobals();
  });

  it("starts Activity and Tasks collapsed and every other panel open", () => {
    expect(railStore.isCollapsed("activity")).toBe(true);
    expect(railStore.isCollapsed("now")).toBe(true);
    expect(railStore.isCollapsed("board")).toBe(false);
  });

  it("persists a toggle across a relaunch", () => {
    railStore.toggleCollapsed("activity");
    expect(railStore.isCollapsed("activity")).toBe(false);
    expect(railStore.isCollapsed("now")).toBe(true);

    railStore.reset();
    railStore.hydrate(core.layout);
    expect(railStore.isCollapsed("activity")).toBe(false);
    expect(railStore.isCollapsed("now")).toBe(true);
  });

  it("persists a collapse after an expand", () => {
    railStore.toggleCollapsed("activity");
    railStore.toggleCollapsed("activity");

    railStore.reset();
    railStore.hydrate(core.layout);
    expect(railStore.isCollapsed("activity")).toBe(true);
  });

  it("records only the panels the captain moved, so a default can still change", () => {
    railStore.toggleCollapsed("activity");
    expect(core.layout).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: {},
      placements: {},
    });
  });

  it("notifies subscribers when the core's record arrives", () => {
    const seen: boolean[] = [];
    const stop = railStore.subscribe(() => seen.push(railStore.isCollapsed("activity")));
    railStore.hydrate({ collapsedPanels: { activity: false }, hiddenPanels: {}, placements: {} });
    stop();
    expect(seen).toEqual([false]);
  });

  it("counts F6's asks for a panel's body to take focus, telling subscribers and changing no layout", () => {
    const heard = vi.fn();
    const stop = railStore.subscribe(heard);
    const before = railStore.bodyFocusAsk("now");
    railStore.askBodyFocus("now");
    railStore.askBodyFocus("now");
    expect(railStore.bodyFocusAsk("now")).toBe(before + 2);
    expect(railStore.bodyFocusAsk("activity")).toBe(0);
    expect(heard).toHaveBeenCalledTimes(2);
    // Focus is not a choice the captain made: nothing is written.
    expect(railStore.isCollapsed("now")).toBe(true);
    expect(core.layout).toEqual(DEFAULT_LAYOUT);
    stop();
  });

  it("survives a core that refuses the write", () => {
    vi.stubGlobal("window", {
      infinitary: { settings: { setLayout: () => Promise.reject(new Error("no core")) } },
    });
    railStore.toggleCollapsed("activity");
    expect(railStore.isCollapsed("activity")).toBe(false);
  });
});

describe("railStore visibility and placement (talk-to-personalize Step 1)", () => {
  beforeEach(() => {
    installCore();
    railStore.reset();
  });
  afterEach(() => {
    railStore.reset();
    vi.unstubAllGlobals();
  });

  it("reads hidden and placement from the hydrated record and defaults without one", () => {
    const preferred = { x: "left" as const, y: "bottom" as const };
    expect(railStore.isHidden("now")).toBe(false);
    expect(railStore.placementOf("activity", preferred)).toBe(preferred);
    railStore.hydrate({
      collapsedPanels: {},
      hiddenPanels: { now: true },
      placements: { activity: { x: "right", y: "top" } },
    });
    expect(railStore.isHidden("now")).toBe(true);
    expect(railStore.placementOf("activity", preferred)).toEqual({ x: "right", y: "top" });
    expect(railStore.layout().hiddenPanels).toEqual({ now: true });
  });

  it("carries the hidden and placement records through a collapse toggle's write", () => {
    const core = installCore();
    railStore.hydrate({
      collapsedPanels: {},
      hiddenPanels: { now: true },
      placements: { activity: { x: "right", y: "top" } },
    });
    railStore.toggleCollapsed("activity");
    expect(core.layout).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: { now: true },
      placements: { activity: { x: "right", y: "top" } },
    });
  });

  it("reveal ends with the panel on screen from any state: hidden and collapsed clear together", () => {
    const core = installCore();
    railStore.hydrate({
      collapsedPanels: { activity: true },
      hiddenPanels: { activity: true, now: true },
      placements: {},
    });
    railStore.reveal("activity");
    expect(railStore.isHidden("activity")).toBe(false);
    expect(railStore.isCollapsed("activity")).toBe(false);
    // The hidden record keeps only its deviations, and the write reaches
    // the core so a relaunch keeps the reveal; the other panel's records
    // ride along untouched.
    expect(core.layout).toEqual({
      collapsedPanels: { activity: false },
      hiddenPanels: { now: true },
      placements: {},
    });
  });

  it("reveal of a panel already on screen is a harmless restatement", () => {
    const core = installCore();
    railStore.reveal("activity");
    expect(railStore.isCollapsed("activity")).toBe(false);
    expect(railStore.isHidden("activity")).toBe(false);
    expect(core.layout.hiddenPanels).toEqual({});
  });
});
