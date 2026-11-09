// The top of the task record's Info tab (INF-2261, the captain's pick:
// "Folded under the goal, closed, with their count in the fold's name").
// The filing, plan-skip and words cases moved here from the record's frame
// tests with the parts they read.
import { taskCostWords } from "@shared/costLimit";
import { DELIVERY_BASIS_WORDS, DELIVERY_FACTS_LABEL } from "@shared/deliveryFacts";
import type { TaskDetail } from "@shared/tasks";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordCost } from "./RecordCost";
import {
  RecordAttention,
  RecordDelivered,
  RecordGoal,
  RecordRelations,
  recordWordsFoldName,
} from "./RecordHead";

type Node = { type: string; data?: string; attribs?: Record<string, string>; children?: Node[] };

function find(html: string, attribute: string): Node | undefined {
  let found: Node | undefined;
  const walk = (node: Node) => {
    if (!found && node.type === ElementType.Tag && node.attribs?.[attribute] !== undefined)
      found = node;
    for (const child of node.children ?? []) walk(child);
  };
  walk(parseDocument(html) as unknown as Node);
  return found;
}
function textOf(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === ElementType.Text) return node.data ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const now = Date.now();
function task(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "test",
    key: "DEMO-42",
    projectId: "demo",
    parentId: null,
    kind: "work",
    title: "Fix search",
    goal: "Find tasks by key.",
    priority: 2,
    status: "active",
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: null,
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: now - 600_000,
    updatedAt: now,
    startedAt: now - 300_000,
    closedAt: null,
    intent: null,
    rigor: null,
    deliverable: null,
    basis: null,
    skippedPlanBecause: null,
    brief: "",
    outcome: null,
    modelLabel: null,
    cards: [],
    events: [],
    plan: null,
    activityLog: [],
    closing: null,
    problem: null,
    asks: [],
    ...patch,
  } as TaskDetail;
}
const ask = (id: string, text: string, at: number) => ({
  id,
  at,
  text,
  images: 0,
  attachedVia: null,
  turnState: "closed" as const,
});

const goal = (detail: TaskDetail, open = false) =>
  renderToStaticMarkup(<RecordGoal detail={detail} open={open} onToggle={() => {}} />);

describe("the goal and the fold under it", () => {
  it("shows the goal whole, the captain's words folded closed with their count in its name", () => {
    const words = '<script>alert("not HTML")</script>\nKeep this verbatim.';
    const detail = task({
      intent: { goal: "Ship", userWords: words } as TaskDetail["intent"],
      asks: [ask("first", words, now - 600_000), ask("later", "Later request", now - 300_000)],
    });
    const html = goal(detail);
    expect(textOf(find(html, "data-record-goal"))).toBe("Find tasks by key.");
    const fold = find(html, "data-record-section");
    expect(fold?.attribs?.["data-record-section"]).toBe("words");
    expect(fold?.attribs?.open).toBeUndefined();
    // The words that started it and one later ask: two messages.
    expect(textOf(find(html, "data-record-words-fold"))).toBe("Your 2 messages");
    // Task-authored strings are text, never HTML.
    expect(textOf(find(html, "data-record-words"))).toBe(words);
    expect(html).not.toContain("<script>");
    expect(textOf(find(html, "data-record-asks"))).toContain("Later request");
    expect(find(goal(detail, true), "data-record-section")?.attribs?.open).toBe("");
  });

  it("keeps a filing's reason in the fold once it is no longer charted, its verdict until it closes", () => {
    const filing = {
      why: "it failed twice while I ran the suite",
      originKey: "FI3-1",
      verdict: null,
    };
    const live = goal(task({ filing: { ...filing, verdict: "still real on main" } }));
    expect(textOf(find(live, "data-record-words-fold"))).toBe("Why it was filed");
    expect(textOf(find(live, "data-record-filed-why"))).toBe(filing.why);
    expect(textOf(find(live, "data-record-filed-verdict"))).toBe("First mate: still real on main");
    // A closed filing has nothing left to decide: no verdict line.
    const closed = goal(task({ status: "done", closedReason: "finished", filing }));
    expect(find(closed, "data-record-filed-why")).toBeDefined();
    expect(find(closed, "data-record-filed-verdict")).toBeUndefined();
    // While charted, the reason leads the tab instead, above the goal.
    expect(
      find(goal(task({ status: "open", activity: null, filing })), "data-record-filed-why"),
    ).toBe(undefined);
  });

  it("keeps the first mate's declared plan-skip reason in the fold", () => {
    const html = goal(task({ skippedPlanBecause: "One title; inspect it" }));
    expect(textOf(find(html, "data-record-plan-skip"))).toBe("One title; inspect it");
    expect(textOf(find(html, "data-record-words-fold"))).toBe("Why there was no plan");
    expect(find(goal(task()), "data-record-plan-skip")).toBeUndefined();
  });

  it("names every part the fold holds, and draws no fold when it holds nothing", () => {
    expect(
      recordWordsFoldName(
        task({
          status: "active",
          filing: { why: "flaky", originKey: "FI3-1", verdict: null },
          asks: [ask("one", "why does this wait?", now)],
        }),
      ),
    ).toBe("Why it was filed and your 1 message");
    expect(recordWordsFoldName(task())).toBeNull();
    expect(find(goal(task()), "data-record-section")).toBeUndefined();
  });
});

describe("the head above the goal", () => {
  it("leads with a charted filing's reason and the first mate's verdict", () => {
    const filing = {
      why: "it failed twice while I ran the suite",
      originKey: "FI3-1",
      verdict: null,
    };
    const html = renderToStaticMarkup(
      <RecordAttention
        detail={task({ status: "open", activity: null, filing })}
        onOpenChange={() => {}}
      />,
    );
    expect(textOf(find(html, "data-record-why"))).toBe(filing.why);
    expect(textOf(find(html, "data-record-verdict"))).toBe("Your first mate has not said yet.");
  });

  it("puts a failure's sentence first and says nothing when nothing needs saying", () => {
    const failed = renderToStaticMarkup(
      <RecordAttention
        detail={task({ activity: "interrupted", problem: "The connection dropped - try again." })}
        onOpenChange={() => {}}
      />,
    );
    const box = find(failed, "data-record-attention");
    expect(box?.attribs?.["data-danger"]).toBe("");
    expect(textOf(find(failed, "data-record-attention-title"))).toBe("Work was interrupted");
    expect(renderToStaticMarkup(<RecordAttention detail={task()} onOpenChange={() => {}} />)).toBe(
      "",
    );
  });

  // INF-3169's plan, piece 3: "the facts on the record" - each delivery fact
  // the close as done recorded with how it is known, in the record's own
  // labelled rows (the captain: the first drawing was "too inconsistent with
  // surrounding UI"), under the closed line that says whose word closed it.
  it("lists a close as done's delivery facts as the record's Delivered row, each with how it is known", () => {
    const facts = [
      { basis: "checked" as const, text: "Its own pull request #55 is still open" },
      {
        basis: "stated" as const,
        text: "Result named by the first mate: The meter reads on time.",
      },
      { basis: "unread" as const, text: "Its working copy could not be read" },
    ];
    const closed = task({
      status: "done",
      activity: null,
      closedReason: "finished",
      closedAt: now,
      closing: { at: now, note: null, onWord: true, facts },
    });
    const head = renderToStaticMarkup(<RecordAttention detail={closed} onOpenChange={() => {}} />);
    expect(textOf(find(head, "data-record-context"))).toMatch(/^Finished on your word .*\.$/);
    expect(find(head, "data-record-delivery-facts")).toBeUndefined();

    const html = renderToStaticMarkup(<RecordDelivered detail={closed} />);
    expect(textOf(find(html, "data-task-fact-label"))).toBe(DELIVERY_FACTS_LABEL);
    const list = find(html, "data-record-delivery-facts");
    const rows = (list?.children ?? []).filter((node) => node.type === ElementType.Tag);
    expect(rows.map((row) => [row.attribs?.["data-record-delivery-fact"], textOf(row)])).toEqual(
      facts.map((fact) => [fact.basis, `${fact.text}${DELIVERY_BASIS_WORDS[fact.basis]}`]),
    );

    // A closed task with no facts draws no row, and only its line.
    const plain = task({
      status: "done",
      activity: null,
      closedReason: "finished",
      closedAt: now,
      closing: { at: now, note: "The shoal is sounded." },
    });
    expect(renderToStaticMarkup(<RecordDelivered detail={plain} />)).toBe("");
    expect(
      textOf(
        find(
          renderToStaticMarkup(<RecordAttention detail={plain} onOpenChange={() => {}} />),
          "data-record-context",
        ),
      ),
    ).toMatch(/^Finished .*: The shoal is sounded\.$/);
  });

  // The approved cost-limit plan promises "$12 of $50" in the record.
  // The queue regression requires a compact cell, with its full explanation
  // still available to a person focusing the amount rather than a new row.
  it("keeps the spend amount visible and the family/source explanation accessible in a focusable cell", () => {
    const cost = { usd: 12, unpriced: 1, limit: { usd: 50 }, source: "project" as const };
    const html = renderToStaticMarkup(<RecordCost cost={cost} />);
    const amount = find(html, "data-record-cost");
    const words = taskCostWords(cost);
    expect(textOf(amount)).toBe(words.amount);
    expect(amount?.attribs?.["aria-label"]).toBe(`${words.amount} · ${words.detail}`);
    expect(amount?.attribs?.tabindex).toBe("0");
    expect(amount?.attribs?.role).toBe("img");
  });

  it("names a parent, what it waits on and holds up, and its parts as rows", () => {
    const html = renderToStaticMarkup(
      <RecordRelations
        detail={task({
          parentId: "task-parent",
          blockedBy: ["DEMO-38"],
          blocks: ["DEMO-43"],
          children: { total: 3, closed: 1 },
        })}
        parentKey="DEMO-1"
      />,
    );
    expect(textOf(find(html, "data-record-fact"))).toBe("DEMO-1");
    expect(html.indexOf('data-record-fact="parent"')).toBeLessThan(
      html.indexOf('data-record-fact="blocked-by"'),
    );
    expect(html).toContain("DEMO-38");
    expect(html).toContain("DEMO-43");
    expect(html).toContain("1 of 3 closed");
    // Part of names a key, never an id: until the parent's key is read, no row.
    expect(
      renderToStaticMarkup(
        <RecordRelations detail={task({ parentId: "task-parent" })} parentKey={undefined} />,
      ),
    ).toBe("");
  });
});
