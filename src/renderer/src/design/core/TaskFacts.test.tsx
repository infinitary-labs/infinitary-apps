import { modelNames } from "@shared/modelDisplayName";
import { TASK_FACTS, taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecordPaneChrome } from "../../cards/RecordPaneChrome";
import { CrewSummary } from "../../character/crew/CrewSummary";
import { TaskFactRows, TaskFactStrip } from "./TaskFacts";

let boardRows: readonly unknown[] = [];
vi.mock("../../character/crew/useCrewBoard", async (original) => ({
  ...(await original<typeof import("../../character/crew/useCrewBoard")>()),
  useBoardTasks: () => boardRows,
}));

type Node = {
  type: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node: Node): string {
  if (node.type === ElementType.Text) return node.data ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** Every shared fact a surface shows, in its order, with its words; the status by its mark's reading. */
function factsOf(html: string): [string, string][] {
  const facts: [string, string][] = [];
  let status = "";
  walk(parseDocument(html) as unknown as Node, (node) => {
    if (node.type !== ElementType.Tag) return;
    if (node.attribs?.["data-task-mark"]) status = node.attribs["aria-label"] ?? "";
    const id = node.attribs?.["data-task-fact"];
    if (id) facts.push([id, id === "status" ? "" : textOf(node)]);
  });
  return facts.map(([id, text]) => [id, id === "status" ? status : text]);
}

const now = Date.now();
const task = {
  id: "t1",
  key: "SCR-3",
  projectId: "p1",
  parentId: null,
  kind: "work",
  title: "Speed up the first paint",
  goal: null,
  priority: 2,
  status: "active",
  activity: "idle",
  workPosture: { state: "idle", reason: "checks" },
  closedReason: null,
  startPolicy: "when-ready",
  flags: { blocked: false, held: false, needsYou: false, ready: false },
  blockedBy: [],
  blocks: [],
  children: { total: 0, closed: 0 },
  assignee: "crewmate 3",
  model: "openrouter/google/gemini-3-pro-image",
  tier: "medium",
  repo: null,
  delivery: {
    mode: "direct-pr",
    prNumber: 57,
    changeLabel: "#57",
    prUrl: "https://github.com/demo/repo/pull/57",
    ci: "pending",
    ciAt: now - 60_000,
    // The first check started 15 minutes ago, by GitHub's own time (INF-587).
    ciStartedAt: now - 15 * 60_000,
    reviewVerdict: "pass",
    reviewRisk: "low",
  },
  outcomeSummary: null,
  waitingCardId: null,
  createdAt: now - 600_000,
  updatedAt: now,
  startedAt: now - 500_000,
  closedAt: null,
  modelLabel: "Nano Banana Pro",
  reasoning: { level: "xhigh", lower: "quick" },
  modelReason: { rule: "R4", asked: "high", served: "high", basis: "SCR-1" },
  activityLog: [
    { id: 1, at: now - 300_000, kind: "progress", text: "Measured the paint at 410 ms" },
    {
      id: 2,
      at: now - 120_000,
      kind: "pr_opened",
      text: "Opened pull request #57.",
      change: { url: "https://github.com/demo/repo/pull/57", from: 7, to: 23 },
    },
  ],
  // The plan its crewmate reported (FI3-734): dots on the summary, the list on the record.
  plan: {
    at: now - 300_000,
    items: [
      { label: "Measure the paint", short: "Measure", state: "done", since: now - 400_000 },
      { label: "Cut the first request", short: "Cut", state: "current", since: now - 300_000 },
      { label: "Open the pull request", short: "PR", state: "next", since: now - 300_000 },
    ],
  },
} as unknown as TaskDetail;
const modelName = modelNames([
  { provider: "openrouter", id: "google/gemini-3-pro-image", label: "Google: Nano Banana Pro" },
]);

describe("one task's facts on the crew summary and the task record", () => {
  it("are the same values, the record adding the details the summary leaves out, its fact strip after its rows", () => {
    const summary = renderToStaticMarkup(
      <CrewSummary taskId={task.id} facts={{ task, modelName }} />,
    );
    const facts = taskFactsOf(task, modelName);
    const record = renderToStaticMarkup(
      <>
        <RecordPaneChrome
          reading={facts.status}
          pillTone="neutral"
          taskKey={facts.key}
          title={facts.title}
        />
        <TaskFactRows facts={facts} planView="list" omitStrip onOpenChange={() => {}} />
        <div data-record-rows="" />
        <div className="fm-task-facts fm-record-strip" data-record-strip="">
          <TaskFactStrip facts={facts} onOpenChange={() => {}} why />
        </div>
      </>,
    );
    const shown = factsOf(summary);
    // The task's own browser is the record's alone: no read here carries one.
    // Why this model is the full record's alone too (INF-1714, the captain's
    // ruling: "don't show this in the hover preview of a task"), and so are
    // the reasoning and its footnote (INF-2528, the captain's direction B:
    // "more details should be shown in the task card, not in the preview").
    const recordOnly = ["browser", "why", "reasoning", "reason"];
    expect(shown.map(([id]) => id)).toEqual(TASK_FACTS.filter((id) => !recordOnly.includes(id)));
    const onRecord = factsOf(record);
    const { why, reasoning, reason, ...recordShared } = Object.fromEntries(onRecord);
    expect(recordShared).toEqual(Object.fromEntries(shown));
    expect(reasoning).toBe("Extra high");
    expect(reason).toBe("Reasoning one step lower for Quick rigor.");
    expect(why).toBe("Why this modelBuilding from the plan in SCR-1.Comparison not recorded");
    // One order on both: the record only moves its strip below its rows.
    expect(onRecord.map(([id]) => id)).toEqual(TASK_FACTS.filter((id) => id !== "browser"));
    const stripAt = record.indexOf("data-record-strip");
    const rowsAt = record.indexOf("data-record-rows");
    expect(rowsAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(rowsAt);
    expect(Object.fromEntries(shown)).toMatchObject({
      status: "Idle · Waiting for checks",
      task: "Speed up the first paint",
      now: "Opened pull request #57.",
      plan: "1 of 3Cut the first request5m",
      model: "Nano Banana Pro",
      change: "#57",
      checks: "running for 15m",
      review: "passed · risk low",
    });
    // Every strip cell has its micro label over its value, as the merge card's do.
    // The Info tab's row (INF-2261) keeps the preview's shape: the model carries
    // its badge and the change carries its checks, so neither has a cell of its own.
    const labels = (html: string) =>
      [...html.matchAll(/data-task-fact-label="">([^<]+)</g)].map((match) => match[1]);
    expect(labels(record)).toEqual(expect.arrayContaining(["Model", "Reasoning", "Pull request"]));
    expect(labels(record)).not.toContain("Intelligence");
    expect(labels(record)).not.toContain("Checks");
    expect(record).toContain('data-fact-dot="running"');
    // The summary draws the plan as one dot per item, the record as the whole list.
    expect(summary.match(/data-plan-item="/g)).toHaveLength(3);
    expect(summary).toContain('data-task-plan-dots="3"');
    expect(record).toContain('data-task-plan-list="3"');
    expect(record.match(/data-plan-label=""/g)).toHaveLength(3);
    // The record's pull request is a link in Now's words and on the strip;
    // the read-only summary's is plain text.
    expect(record.match(/href="https:\/\/github.com\/demo\/repo\/pull\/57"/g)).toHaveLength(2);
    expect(record).toContain('href="https://github.com/demo/repo/pull/57">pull request #57</a>');
    expect(summary).not.toContain("href=");
  });

  // INF-2528, the captain's words: "the preview should remain concise and
  // only the most critical information. more details should be shown in the
  // task card, not in the preview."
  it("keeps the summary's footer to one row: the model with its badge, the change with its checks as one state", () => {
    const counted = {
      ...task,
      delivery: {
        ...task.delivery,
        headSha: "abc",
        checks: {
          headSha: "abc",
          at: now - 60_000,
          items: [
            { name: "lint", state: "skipped" },
            { name: "unit", state: "success" },
            { name: "phone", state: "pending" },
            { name: "journeys", state: "pending" },
          ],
        },
      },
      waits: [
        {
          id: "checks:abc",
          kind: "checks",
          label: "Checks",
          since: now - 600_000,
          next: { kind: "next-read", at: now + 60_000 },
        },
      ],
    } as unknown as TaskDetail;
    const summary = renderToStaticMarkup(
      <CrewSummary taskId={task.id} facts={{ task: counted, modelName }} />,
    );
    const facts = taskFactsOf(counted, modelName);
    const record = renderToStaticMarkup(<TaskFactStrip facts={facts} why />);
    const labels = (html: string) =>
      [...html.matchAll(/data-task-fact-label="">([^<]+)</g)].map((match) => match[1]);
    // One row of two cells, then the review's own row.
    const doc = parseDocument(summary) as unknown as Node;
    const rows: string[][] = [];
    walk(doc, (node) => {
      if (!node.attribs?.class?.split(" ").includes("cells")) return;
      const row: string[] = [];
      walk(node, (child) => {
        if (child.attribs?.["data-task-fact-label"] !== undefined) row.push(textOf(child));
      });
      rows.push(row);
    });
    expect(rows).toEqual([["Model", "Pull request"], ["Review"]]);
    expect(labels(summary)).not.toContain("Intelligence");
    expect(Object.fromEntries(factsOf(summary))).toMatchObject({
      model: "Nano Banana Pro",
      change: "#57",
      checks: "running for 15m",
    });
    expect(summary).toContain('data-slot="medium"');
    // The counts and each watch's next read are the task card's.
    expect(summary).not.toContain("skipped");
    expect(summary).not.toContain("next read");
    expect(Object.fromEntries(factsOf(record)).checks).toContain(
      "1 skipped · 1 passed · 2 running",
    );
    expect(Object.fromEntries(factsOf(record)).checks).toContain("next read");
  });

  it("dates Progress from the list, not the newer Now line, on both surfaces", () => {
    for (const planView of ["dots", "list"] as const) {
      const html = renderToStaticMarkup(
        <TaskFactRows facts={taskFactsOf(task, modelName)} planView={planView} />,
      );
      let planAge: Node | undefined;
      walk(parseDocument(html) as unknown as Node, (node) => {
        if (node.attribs?.["data-task-fact"] !== "plan") return;
        walk(node, (child) => {
          if (child.attribs?.["data-task-fact-age"] !== undefined) planAge = child;
        });
      });
      expect(planAge?.attribs?.datetime).toBe(new Date(task.plan?.at ?? 0).toISOString());
      expect(textOf(planAge as Node)).toBe("5m");
      expect(Object.fromEntries(factsOf(html)).now).toBe("Opened pull request #57.");
    }
  });

  it("cuts a long plan on the summary's line and lists it whole on the record (INF-484 move 5)", () => {
    // A release crewmate's plan as E16 found them: more items than the line holds.
    const items = Array.from({ length: 15 }, (_, i) => ({
      label: `Release step ${i}, written out in full by the crewmate`,
      short: `Step ${i}`,
      state: i < 2 ? "done" : i === 2 ? "current" : "next",
      since: now - 300_000,
    }));
    const long = { ...task, plan: { at: now - 300_000, items } } as unknown as TaskDetail;
    const dots = renderToStaticMarkup(
      <TaskFactRows facts={taskFactsOf(long, modelName)} planView="dots" />,
    );
    expect(dots).toContain('data-task-plan-dots="12"');
    expect(dots).toContain(">4 more</span>");
    expect(dots).toContain(
      `title="${items
        .slice(11)
        .map((item) => item.label)
        .join(", ")}"`,
    );
    const list = renderToStaticMarkup(
      <TaskFactRows facts={taskFactsOf(long, modelName)} planView="list" />,
    );
    expect(list.match(/data-plan-label=""/g)).toHaveLength(15);
    for (const item of items) expect(list).toContain(item.label);
  });

  it("ends the record's rows with the task's own browser and Open, which the summary leaves out", () => {
    const browsing = {
      ...task,
      activity: "running",
      workPosture: { state: "active", reason: "turn" },
      browser: {
        state: "open",
        site: "localhost:5173",
        url: "http://localhost:5173/",
        title: "Sign up",
      },
    } as unknown as TaskDetail;
    const facts = taskFactsOf(browsing, modelName);
    const record = renderToStaticMarkup(
      <TaskFactRows facts={facts} planView="list" omitStrip onOpenBrowser={() => {}} />,
    );
    const shown = factsOf(record);
    expect(shown.at(-1)).toEqual(["browser", "localhost:5173the crewmate is drivingOpen"]);
    expect(record).toContain('data-browser-driver="crewmate"');
    expect(record).toContain("data-browser-open");
    const summary = renderToStaticMarkup(
      <CrewSummary taskId={browsing.id} facts={{ task: browsing, modelName }} />,
    );
    expect(summary).not.toContain('data-task-fact="browser"');
  });
});

// INF-51: a reviewer's summary names what it reviews in every placement.
describe("the crew summary of a reviewer", () => {
  const reviewer = { ...task, id: "r1", key: "SCR-4", reviewOf: "t1" };
  const render = () =>
    renderToStaticMarkup(
      <CrewSummary taskId={reviewer.id} facts={{ task: reviewer, modelName }} />,
    );

  it("names its builder by key once the board answers", () => {
    boardRows = [task, reviewer];
    const html = render();
    expect(html).toContain("data-crew-reviewing");
    expect(html).toContain("Reviewing");
    expect(html).toContain("SCR-3");
  });

  it("still names the relation before the board answers or when the builder is gone", () => {
    boardRows = [];
    const html = render();
    expect(html).toContain("Reviewing");
    expect(html).toContain("another task");
  });

  it("shows no Reviewing row for a task that reviews nothing", () => {
    boardRows = [task];
    expect(
      renderToStaticMarkup(<CrewSummary taskId={task.id} facts={{ task, modelName }} />),
    ).not.toContain("data-crew-reviewing");
  });
});
