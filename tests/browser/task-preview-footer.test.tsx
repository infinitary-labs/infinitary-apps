import { modelNames } from "@shared/modelDisplayName";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { CREW_HOVER } from "../../src/renderer/src/character/crew/hoverMeasures";
import { TaskFactRows } from "../../src/renderer/src/design/core/TaskFacts";
import "../../src/renderer/src/design/styles.css";
import "../../src/renderer/src/character/crew/summary.css";
import { intersects, within } from "./layout";

/**
 * The hover preview's footer is one row that never wraps (INF-2528, the
 * captain's direction B): the model's name gives way first, and the change
 * and its checks keep their width. The captain's report: a task's branch,
 * longer than the preview has room for, ran past the preview's right edge,
 * and the Model label drew over Difficulty. The model now gives way down to
 * its label's width, then the branch ends in an ellipsis.
 */

/** The branch in the captain's picture. */
const BRANCH = "inf/continue-key-reminder-for-controls-inside-a-030e";

/** Two catalog rows as OpenRouter serves them: a short name and the bundled catalog's longest. */
const SHORT = {
  provider: "openrouter",
  id: "~anthropic/claude-opus-latest",
  label: "Anthropic: Claude Opus Latest",
};
const LONG = {
  provider: "openrouter",
  id: "google/gemini-3-pro-image",
  label: "Google: Nano Banana Pro (Gemini 3 Pro Image)",
};
const modelName = modelNames([SHORT, LONG]);

/** The captain's task as the preview read it: its checks running for 3h 02m and a passed review. */
function taskWith(model: typeof SHORT, delivery: Record<string, unknown>): TaskDetail {
  const now = Date.now();
  return {
    id: "t1",
    key: "INF-4608",
    title: "Continue: Key reminder for controls inside a panel's page",
    status: "active",
    activity: "idle",
    workPosture: { state: "idle", reason: "checks" },
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    model: `${model.provider}/${model.id}`,
    tier: "high",
    delivery: {
      ...delivery,
      ci: "pending",
      ciAt: now - 60_000,
      ciStartedAt: now - (3 * 60 + 2) * 60_000,
      reviewVerdict: "pass",
      reviewSha: "052e34a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
      reviewRisk: "low",
    },
    activityLog: [],
  } as unknown as TaskDetail;
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/** The preview at its widest, the task's facts in it as the summary draws them; its footer row. */
async function footerOf(task: TaskDetail): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmounts.push(() => {
    root.unmount();
    host.remove();
  });
  flushSync(() =>
    root.render(
      <div
        className="fm-crew-summary"
        style={{ "--crew-summary-max": `${CREW_HOVER.maxWidthPx}px` } as CSSProperties}
      >
        <TaskFactRows facts={taskFactsOf(task, modelName)} withTask strip="summary" />
      </div>,
    ),
  );
  await document.fonts.ready;
  const row = host.querySelector<HTMLElement>('[data-task-fact-strip="summary"]');
  if (!row) throw new Error("The preview drew no footer row");
  return row;
}

/** Every character shows: nothing inside it is cut or drawn past its box. */
const readsWhole = (el: Element) => el.scrollWidth <= el.clientWidth + 1;

const factIn = (row: HTMLElement, fact: string) => {
  const el = row.querySelector(`[data-task-fact="${fact}"]`);
  if (!el) throw new Error(`The footer row has no ${fact}`);
  return el;
};

/** Each cell and the checks inside the row, each label whole and clear of the others. */
function expectRowHolds(row: HTMLElement) {
  const box = row.getBoundingClientRect();
  const cells = [...row.children];
  expect(cells.length).toBe(3);
  for (const cell of cells) expect(within(cell.getBoundingClientRect(), box)).toEqual([]);
  expect(within(factIn(row, "checks").getBoundingClientRect(), box)).toEqual([]);
  expect(readsWhole(factIn(row, "checks"))).toBe(true);
  const labels = cells.map((cell) => cell.querySelector("[data-task-fact-label]"));
  for (const [index, label] of labels.entries()) {
    if (!label) throw new Error("A footer cell has no label");
    expect(readsWhole(label), `${label.textContent} reads whole`).toBe(true);
    for (const other of labels.slice(index + 1))
      if (other)
        expect(
          intersects(label.getBoundingClientRect(), other.getBoundingClientRect()),
          `${label.textContent} is clear of ${other.textContent}`,
        ).toBe(false);
  }
}

test("a branch longer than the preview ends in an ellipsis inside it, every label clear of the next", async () => {
  const row = await footerOf(taskWith(SHORT, { mode: "queue-pr", changeLabel: BRANCH }));
  expectRowHolds(row);
  const branch = factIn(row, "change");
  expect(branch.textContent).toBe(BRANCH);
  expect(readsWhole(branch), "the branch gives way").toBe(false);
});

test("beside a long model name a pull request's number stays whole while the model gives way", async () => {
  const row = await footerOf(
    taskWith(LONG, {
      mode: "direct-pr",
      prNumber: 612,
      changeLabel: "#612",
      prUrl: "https://github.com/example/crew/pull/612",
    }),
  );
  expectRowHolds(row);
  expect(readsWhole(factIn(row, "change")), "#612 reads whole").toBe(true);
  expect(readsWhole(factIn(row, "model")), "the model's name gives way").toBe(false);
});
