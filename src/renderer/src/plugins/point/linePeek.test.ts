import { feedLineFrom } from "@shared/feed";
import type { PanelFeedLine } from "@shared/personal/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { framePanelActions } from "../panelActions";
import { panelPoint } from "../panelPoint";
import { taskPeek } from "./taskPeek";

// INF-1761's approved line summary must read only a line feed.recent actually presented.
const words = feedLineFrom({
  type: "user_turn",
  text: "Check the release notes before publishing the next alpha.",
});
if (!words) throw new Error("The captain's turn must author a feed line");
const line: PanelFeedLine = {
  ...words,
  at: new Date("2026-10-21T16:05:00-07:00").getTime(),
};
vi.mock("../reads/appExecutor", () => ({
  boardOnScreen: () => undefined,
  feedOnScreen: () => [line],
  searchedTaskByKey: () => undefined,
}));
afterEach(() => {
  taskPeek.set(null);
  vi.unstubAllGlobals();
});

it("opens a recorded task-less line in its frame, rejects an invented line, and releases it", () => {
  const where = {} as HTMLElement;
  const frame = {} as HTMLIFrameElement;
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("document", { querySelector: () => where });
  const page = { reads: ["feed.recent"], frame: () => frame, gate: async () => false };
  const point = panelPoint("activity", page);
  const box = { top: 10, right: 250, bottom: 30, left: 10 };
  point.peekLine({ line, box });
  expect(taskPeek.get()).toEqual({ taskId: null, line, box, page: where, pageFrame: frame });
  point.peekLine({ line: { ...line, text: "This line was never recorded." }, box });
  expect(taskPeek.get()).toBeNull();
  point.peekLine({ line, box });
  point.peekLine(null);
  expect(taskPeek.get()).toBeNull();
  expect(() => panelPoint("other", { ...page, reads: [] }).peekLine({ line, box })).toThrow(
    'name "feed.recent"',
  );
});

it("grants line pointing to a feed reader without granting task pointing", () => {
  const actions = framePanelActions({
    panel: { id: "activity", title: "Activity" },
    frame: () => null,
    reads: ["feed.recent"],
    moves: false,
    decides: false,
  }).actions;
  expect(actions).toContain("point.peekLine");
  expect(actions).not.toContain("point.peekTask");
  expect(
    framePanelActions({
      panel: { id: "other", title: "Other" },
      frame: () => null,
      reads: [],
      moves: false,
      decides: false,
    }).actions,
  ).not.toContain("point.peekLine");
});
