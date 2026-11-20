import { describe, expect, it } from "vitest";
import type { BrowserNode } from "./outline";
import {
  applyMarks,
  applyScreen,
  fullPageClip,
  isPageNoise,
  marksFromSnapshot,
  screenFromSnapshot,
} from "./reading";

/**
 * Facts the host reads off a page before the outline is written: a time,
 * a title tooltip, which elements the window shows, a whole-page
 * picture's width, and one noisy error.
 */

const strings = [
  "time",
  "datetime",
  "2026-10-08T21:52:52Z",
  "title",
  "Oct 8, 2026, 2:52 PM PDT",
  "div",
];

describe("marks read off a page", () => {
  it("reads a time element's datetime and a title tooltip, and ignores the rest", () => {
    const marks = marksFromSnapshot({
      strings,
      documents: [
        {
          nodes: {
            nodeName: [0, 5],
            backendNodeId: [40, 41],
            attributes: [
              [1, 2, 3, 4],
              [3, 4],
            ],
          },
        },
      ],
    });
    expect(marks.get(40)).toEqual({
      datetime: "2026-10-08T21:52:52Z",
      title: "Oct 8, 2026, 2:52 PM PDT",
    });
    expect(marks.get(41)).toEqual({ title: "Oct 8, 2026, 2:52 PM PDT" });
    expect(marks.has(99)).toBe(false);
  });

  it("copies a time onto the text inside it, which is what the outline names", () => {
    const marks = marksFromSnapshot({
      strings: ["time", "datetime", "2026-10-08T21:52:52Z", "#text"],
      documents: [
        {
          nodes: {
            nodeName: [0, 3],
            backendNodeId: [40, 80],
            attributes: [[1, 2], []],
            parentIndex: [-1, 0],
          },
        },
      ],
    });
    expect(marks.get(80)).toEqual({ datetime: "2026-10-08T21:52:52Z" });
  });

  it("copies those marks onto the accessibility node they belong to", () => {
    const nodes: BrowserNode[] = [
      {
        id: "1",
        role: "StaticText",
        name: "2 hours ago",
        ignored: false,
        childIds: [],
        target: 40,
        properties: {},
      },
    ];
    const marked = applyMarks(nodes, new Map([[40, { datetime: "2026-10-08T21:52:52Z" }]]));
    expect(marked[0]?.properties.datetime).toBe("2026-10-08T21:52:52Z");
    expect(nodes[0]?.properties.datetime).toBeUndefined();
  });
});

describe("a whole-page picture", () => {
  it("is at least as wide as the window, so the scrollbar is not left out", () => {
    expect(
      fullPageClip({ width: 1280, height: 800 }, { width: 1265, height: 2400 }, 8_000),
    ).toEqual({
      width: 1280,
      height: 2400,
    });
    expect(
      fullPageClip({ width: 1280, height: 800 }, { width: 2000, height: 9_000 }, 8_000),
    ).toEqual({
      width: 2000,
      height: 8_000,
    });
  });
});

describe("a page error that says nothing about the page", () => {
  it("leaves out a signed-out navigation payload 404, and keeps a real error", () => {
    expect(
      isPageNoise(
        "Failed to load resource: the server responded with a status of 404 () (https://github.com/_global-navigation/payloads.json)",
      ),
    ).toBe(true);
    expect(isPageNoise("TypeError: x is undefined")).toBe(false);
    expect(isPageNoise("Failed to load resource: 404 (https://example.com/missing)")).toBe(false);
  });
});

describe("which elements the window shows", () => {
  const viewport = { width: 1280, height: 800 };
  // Four laid-out elements on a page scrolled 1,000 pixels down; a fifth is not laid out.
  const snapshot = {
    documents: [
      {
        nodes: { backendNodeId: [10, 11, 12, 13, 14] },
        layout: {
          nodeIndex: [0, 1, 2, 3],
          bounds: [
            [0, 0, 1280, 3000],
            [8, 200, 600, 40],
            [8, 1200, 600, 40],
            [8, 1900, 600, 40],
          ],
        },
        scrollOffsetY: 1000,
      },
      // A frame's own document is not read.
      { nodes: { backendNodeId: [20] }, layout: { nodeIndex: [0], bounds: [[0, 0, 10, 10]] } },
    ],
  };

  it("reads an element on screen when its box meets the window once the scroll is taken off", () => {
    const screen = screenFromSnapshot(snapshot, viewport);
    expect([...screen.onScreen].sort()).toEqual([10, 12]);
    expect([...screen.laidOut].sort()).toEqual([10, 11, 12, 13]);
  });

  it("marks only the nodes the page lays out, leaving the rest to their parent", () => {
    const node = (target: number): BrowserNode => ({
      id: String(target),
      role: "StaticText",
      name: "",
      ignored: false,
      childIds: [],
      properties: {},
      target,
    });
    const marked = applyScreen(
      [node(11), node(12), node(14)],
      screenFromSnapshot(snapshot, viewport),
    );
    expect(marked.map((each) => each.onScreen)).toEqual([false, true, undefined]);
    // A snapshot with no layout marks nothing.
    expect(applyScreen([node(11)], screenFromSnapshot({}, viewport))[0]?.onScreen).toBeUndefined();
  });
});
