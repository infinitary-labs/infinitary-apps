import type { PanelProject, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Group } from "../../src/panels/now/panel";
import panelCss from "../../src/panels/now/panel.css?raw";
import { foldRows, type NowRow } from "../../src/panels/now/rows";
import { panelStylesheet } from "../../src/renderer/src/plugins/frames/frameStylesheet";

// The panel's build reads its stylesheet as text (src/panels/stylesheet.d.ts);
// this page lays it out from the same file, read as text below.
vi.mock("../../src/panels/now/panel.css", () => ({ default: "" }));

/**
 * A task's parts count, and its chevron where its parts list under it, never
 * covers the words before it on its Tasks row (the captain's report: the
 * count drew over the row's words). The row keeps room for the control, and
 * keeps it when the control changes: a count that gains its chevron, a row
 * first drawn while the panel was not shown, and a count that grows.
 */

const project: PanelProject = {
  id: "p1",
  key: "INF",
  name: "infinitary",
  repo: { name: "infinitary" },
  archived: false,
  counts: { needsYou: 0, waitingOnYou: 0, open: 1, active: 1, doneRecent: 0 },
} as PanelProject;

function task(overrides: Partial<PanelTaskRow>): PanelTaskRow {
  return {
    id: "parent",
    key: "INF-2271",
    projectId: "p1",
    parentId: null,
    kind: "work",
    title: "Make pnpm dev take the installed app's place on this computer",
    goal: null,
    priority: 2,
    status: "active",
    activity: "working",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    children: { total: 4, closed: 3 },
    assignee: null,
    model: null,
    repo: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 1,
    startedAt: 1,
    closedAt: null,
    // Its computer is out of reach, so the row ends with words of its own.
    place: { name: "Mac mini", where: "on Mac mini", reach: "out-of-reach" },
    ...overrides,
  } as PanelTaskRow;
}

const part = task({
  id: "part",
  key: "INF-5646",
  parentId: "parent",
  title: "pnpm dev 3: hand the folder back",
  children: { total: 0, closed: 0 },
  place: undefined,
});

let mounted: { host: HTMLElement; root: Root } | null = null;

afterEach(() => {
  mounted?.root.unmount();
  mounted?.host.remove();
  mounted = null;
});

function mount(shown: boolean) {
  const style = document.createElement("style");
  style.textContent = `${panelStylesheet()}\n${panelCss}`;
  document.head.append(style);
  const host = document.createElement("div");
  host.style.width = "404px";
  if (!shown) host.style.display = "none";
  document.body.append(host);
  mounted = { host, root: createRoot(host) };
  return mounted;
}

/** Draws the Working group with the parent, and its part listed under it when given. */
function draw(root: Root, parent: PanelTaskRow, listed: PanelTaskRow | null) {
  const rows: NowRow[] = [{ task: parent, group: "working", depth: 0 }];
  if (listed) rows.push({ task: listed, group: "working", depth: 1 });
  const board: PanelTaskBoard = {
    seq: 1,
    at: 1,
    projects: [project],
    tasks: listed ? [parent, listed] : [parent],
  };
  flushSync(() =>
    root.render(
      <div data-now="">
        <div data-now-groups="">
          <Group
            group="working"
            rows={rows}
            fold={foldRows(rows, new Set())}
            onFold={() => {}}
            onPin={() => {}}
            board={board}
            open
            selectedTaskIds={[]}
            litTaskId={null}
            onToggle={() => {}}
            onOpen={() => {}}
          />
        </div>
      </div>,
    ),
  );
}

const nextFrames = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

/** How far the parent's control reaches over the words before it, px; 0 or less is clear. */
function overlap(host: HTMLElement): number {
  const item = host.querySelector<HTMLElement>('[data-now-item]:has([data-now-row="parent"])');
  const fold = item?.querySelector<HTMLElement>("[data-now-fold]");
  const words = [
    ...(item?.querySelectorAll<HTMLElement>("[data-now-row] > .title, [data-now-row] > .key") ??
      []),
  ];
  if (!fold || words.length === 0) throw new Error("the parent row drew no control or no words");
  const end = Math.max(...words.map((word) => word.getBoundingClientRect().right));
  return end - fold.getBoundingClientRect().left;
}

test("a parts count that gains its chevron keeps clear of the row's words", async () => {
  const { host, root } = mount(true);
  draw(root, task({}), null);
  await nextFrames();
  expect(host.querySelector("span[data-now-fold]")).not.toBeNull();
  expect(overlap(host)).toBeLessThanOrEqual(0);

  draw(root, task({}), part);
  await nextFrames();
  expect(host.querySelector("button[data-now-fold]")).not.toBeNull();
  expect(overlap(host)).toBeLessThanOrEqual(0);
});

test("a row first drawn while the panel is not shown keeps clear of its control once shown", async () => {
  const { host, root } = mount(false);
  draw(root, task({}), null);
  await nextFrames();
  draw(root, task({}), part);
  await nextFrames();
  host.style.display = "";
  await nextFrames();
  expect(overlap(host)).toBeLessThanOrEqual(0);
});

test("a parts count that grows keeps clear of the row's words", async () => {
  const { host, root } = mount(true);
  draw(root, task({ children: { total: 9, closed: 9 } }), part);
  await nextFrames();
  draw(root, task({ children: { total: 12, closed: 10 } }), part);
  await nextFrames();
  expect(host.querySelector("[data-now-parts]")?.textContent).toBe("10/12");
  expect(overlap(host)).toBeLessThanOrEqual(0);
});
