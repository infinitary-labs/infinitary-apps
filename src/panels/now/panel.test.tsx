import type { PanelProject, PanelTaskBoard, PanelTaskRow } from "@infinitary/contracts";
import { PanelExpandChevron } from "@infinitary/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Group } from "./panel";

/**
 * A group of the Tasks panel as it paints (./panel.tsx), rendered: the
 * earlier group, a row's mark, key, title and accessible label, and the
 * expand mark a group that opens and closes wears - the panel library's
 * own, the one the rail's panel header wears.
 */

function task(overrides: Partial<PanelTaskRow> = {}): PanelTaskRow {
  return {
    id: "t1",
    key: "FI3-12",
    projectId: "proj-r1",
    parentId: null,
    kind: "work",
    title: "Ship the row chrome",
    goal: null,
    priority: 2,
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: true },
    blockedBy: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    repo: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 1,
    startedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function board(): PanelTaskBoard {
  const project: PanelProject = {
    id: "proj-r1",
    key: "FI3",
    name: "firstmate-3000",
    repo: { name: "firstmate-3000" },
    archived: false,
    counts: { needsYou: 0, waitingOnYou: 0, open: 1, active: 0, doneRecent: 0 },
  };
  return { seq: 1, at: 1, projects: [project], tasks: [task()] };
}

function group(
  name: "backlog" | "landed" | "earlier",
  open: boolean,
  row = task(),
  litTaskId: string | null = null,
): string {
  return renderToStaticMarkup(
    <Group
      group={name}
      rows={[{ task: row, group: name, depth: 0 }]}
      board={board()}
      open={open}
      selectedTaskIds={[]}
      litTaskId={litTaskId}
      onToggle={() => {}}
      onOpen={() => {}}
    />,
  );
}

/** The expand mark as painted in a header. */
function expandChevron(html: string): string {
  const mark = html.match(/<span data-panel-expand-chevron=""[\s\S]*?<\/span>/)?.[0];
  if (!mark) throw new Error(`header has no panel expand chevron: ${html}`);
  return mark;
}

describe("the earlier group", () => {
  const earlierTask = task({
    id: "t9",
    key: "FI3-81",
    title: "Investigate idle answer-task cleanup",
    status: "done",
    closedAt: 5,
  });

  it("is labelled earlier, has no expand control, and is open", () => {
    const html = group("earlier", true, earlierTask);
    expect(html).toContain('data-now-group="earlier"');
    expect(html).toContain(">earlier<");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("data-now-caret");
    expect(html).toContain('data-now-row="t9"');
  });

  it("paints a row like any other: status mark, key, title and an accessible label with its status", () => {
    const html = group("earlier", true, earlierTask);
    // The status is in the name too: the keyboard and a screen reader get
    // what the pointer reads in the row's tooltip.
    expect(html).toContain(
      'aria-label="FI3-81 · Investigate idle answer-task cleanup · firstmate-3000 · Done"',
    );
    expect(html).toContain("data-now-dot");
    expect(html).toContain('data-now-status="done"');
  });
});

describe("a row lit by a rest elsewhere in the window (INF-237)", () => {
  it("marks only the lit task's row, as the view hands it", () => {
    expect(group("backlog", true, task(), "t1")).toContain("data-now-lit");
    expect(group("backlog", true, task(), "t2")).not.toContain("data-now-lit");
    expect(group("backlog", true, task(), null)).not.toContain("data-now-lit");
  });
});

describe("a group that opens and closes", () => {
  it("wears the panel library's expand mark, up while closed and down while open", () => {
    const closed = renderToStaticMarkup(<PanelExpandChevron collapsed />);
    const opened = renderToStaticMarkup(<PanelExpandChevron collapsed={false} />);
    expect(expandChevron(group("backlog", false))).toBe(closed);
    expect(expandChevron(group("landed", false))).toBe(closed);
    expect(expandChevron(group("backlog", true))).toBe(opened);
  });
});
