import type { RecordFact } from "@shared/recordFacts";
import type { TaskActivityRow, TaskDetail, TaskEventView } from "@shared/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordScript as script } from "./recordScript";

class Node {
  #text = "";
  hidden = false;
  open = false;
  dataset: Record<string, string> = {};
  className = "";
  href = "";
  listeners: Record<string, () => void> = {};
  addEventListener(type: string, listener: () => void) {
    this.listeners[type] = listener;
  }
  children: (Node | string)[] = [];
  attrs: Record<string, string> = {};
  get textContent() {
    return this.#text;
  }
  // As in the DOM: setting the text replaces the children.
  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  toggleAttribute(name: string, force: boolean) {
    if (force) this.attrs[name] = "";
    else delete this.attrs[name];
  }
  parentNode: Node | null = null;
  get childNodes() {
    return this.children;
  }
  get firstChild(): Node | string | null {
    return this.children[0] ?? null;
  }
  get firstElementChild(): Node | null {
    return this.children.find((child): child is Node => child instanceof Node) ?? null;
  }
  get lastElementChild(): Node | null {
    return this.children.findLast((child): child is Node => child instanceof Node) ?? null;
  }
  get nextSibling(): Node | string | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  insertBefore(node: Node | string, before: Node | string | null) {
    if (node instanceof Node) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
    }
    this.children.splice(
      before === null ? this.children.length : this.children.indexOf(before),
      0,
      node,
    );
  }
  removeChild(node: Node | string) {
    this.children.splice(this.children.indexOf(node), 1);
    if (node instanceof Node) node.parentNode = null;
  }
  append(...nodes: (Node | string)[]) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  appendChild(child: Node) {
    this.append(child);
    return child;
  }
  replaceChildren(...nodes: (Node | string)[]) {
    this.#text = "";
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...nodes);
  }
  cloneNode() {
    return new Node();
  }
  /** The text a reader sees, children joined as the DOM would render them. */
  flat(): string {
    return (
      this.#text +
      this.children.map((child) => (typeof child === "string" ? child : child.flat())).join("")
    );
  }
  text(): string {
    return (
      this.#text +
      this.children.map((child) => (typeof child === "string" ? child : child.text())).join(" ")
    );
  }
}

function mount(options: { knowledge?: boolean; state?: unknown } = {}) {
  const nodes = new Map<string, Node>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector) as Node;
  };
  // The root as the template stamps it: whether the window has knowledge.
  node("[data-record]").setAttribute("data-knowledge", options.knowledge ? "on" : "off");
  const listeners = new Map<string, (value: unknown) => void>();
  /** Reads of other tasks' records (a parent the board does not list), by id. */
  const others = new Map<string, { callback: (value: unknown) => void; stopped: boolean }>();
  let fail = () => {};
  let tick = () => {};
  let state = (_value: unknown) => {};
  const action = vi.fn((_id: string) => Promise.resolve());
  new Function("window", "document", script)(
    {
      setInterval: (callback: () => void) => {
        tick = callback;
      },
      inf: {
        action,
        state: options.state ?? null,
        onState: (callback: (value: unknown) => void) => {
          state = callback;
          return () => {};
        },
        subscribe: (
          read: string,
          params: { id?: string },
          callback: (value: unknown) => void,
          onError: () => void,
        ) => {
          // The record's own read is the first; any later one reads another task.
          if (read === "tasks.detail" && listeners.has(read)) {
            const other = { callback, stopped: false };
            others.set(params.id ?? "", other);
            return {
              unsubscribe: () => {
                other.stopped = true;
                return Promise.resolve();
              },
            };
          }
          listeners.set(read, callback);
          if (read === "tasks.detail") fail = onError;
          return { unsubscribe: () => Promise.resolve() };
        },
      },
    },
    { querySelector: node, querySelectorAll: () => [], createElement: () => new Node() },
  );
  return {
    node: (name: string) => node(`[data-record-${name}]`),
    /** The line under Details that says how to change them. */
    helper: () => node("[data-policy-helper]"),
    section: (name: string) => node(`[data-record-section="${name}"]`),
    fact: (id: RecordFact) =>
      node("[data-record-facts]").children.find(
        (child): child is Node =>
          child instanceof Node && child.getAttribute("data-record-fact") === id,
      ),
    push: (detail: TaskDetail) => listeners.get("tasks.detail")?.(detail),
    uses: (value: unknown) => listeners.get("knowledge.uses")?.(value),
    reads: () => [...listeners.keys()],
    board: (tasks: { id: string; key: string }[] = []) => listeners.get("tasks.board")?.({ tasks }),
    /** Another task's record read, answered with its key; whether it was asked. */
    other: (id: string, key: string) => {
      const read = others.get(id);
      read?.callback({ ...task(), id, key });
      return read;
    },
    asked: () => [...others.keys()],
    fail: () => fail(),
    /** The host's state pushed after birth, as a tab change pushes it. */
    state: (value: unknown) => state(value),
    /** The tab the document shows, as its root names it. */
    view: () => node("[data-record]").dataset.view,
    tick: () => tick(),
    /** Every region the script reached for, to press whatever it listens on. */
    regions: () => [...nodes.values()],
    action,
  };
}

const now = new Date("2026-09-16T14:30:00Z").getTime();
function event(kind: TaskEventView["kind"], text: string, at = now - 120_000): TaskEventView {
  return { id: at, at, actor: "crewmate", kind, text, data: null, ref: null, feed: false };
}
/** The whole text an Activity line opens to, or null when the line is plain. */
function wholeOf(line: Node | string | undefined): string | null {
  if (!(line instanceof Node)) return null;
  const whole = line.children.find(
    (child): child is Node =>
      child instanceof Node && child.getAttribute("data-record-whole") === "",
  );
  return whole ? whole.textContent : null;
}
function row(kind: TaskActivityRow["kind"], text: string, at = now - 120_000): TaskActivityRow {
  return { id: at, at, kind, text };
}
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
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("compact task record frame", () => {
  it("leaves the newest line to the shared facts above it, and opens the report from its Activity line", () => {
    const frame = mount();
    frame.push(
      task({
        outcome: "Fixed. Full evidence.",
        outcomeSummary: "Fixed.",
        events: [event("report", "Fixed. Full evidence.")],
        activityLog: [row("report", "Fixed.")],
      }),
    );
    // Now is the host's shared fact, and the attention sentence the
    // window's (INF-2261): the body has no second newest line.
    expect(wholeOf(frame.node("timeline").children[0])).toBe("Fixed. Full evidence.");
  });

  it("shows the tab the host names, Info until it names another (INF-2261)", () => {
    const frame = mount({ state: { openSections: [], view: "activity" } });
    expect(frame.view()).toBe("activity");
    frame.state({ openSections: [], view: "cards" });
    expect(frame.view()).toBe("cards");
    frame.state({ openSections: [] });
    expect(frame.view()).toBe("info");
  });

  it("opens every report from its own Activity line, the older one beside its age", () => {
    const frame = mount();
    const first = now - 28 * 60_000;
    const second = now - 4 * 60_000;
    const after = now - 2 * 60_000;
    frame.push(
      task({
        outcome: "Added scrolling.\n\nVerified\nTests pass.",
        outcomeSummary: "Added scrolling.",
        events: [
          event("report", "Added the toggle.\n\nVerified\nTests pass.", first),
          event("report", "Added scrolling.\n\nVerified\nTests pass.", second),
          event("progress", "Waiting on the checks.", after),
        ],
        activityLog: [
          row("report", "Added the toggle.", first),
          row("report", "Added scrolling.", second),
          row("progress", "Waiting on the checks.", after),
        ],
      }),
    );
    const [older, newer, progress] = frame.node("timeline").children;
    expect(wholeOf(older)).toBe("Added the toggle.\n\nVerified\nTests pass.");
    expect((older as Node).text()).toContain("28m Added the toggle.");
    expect(wholeOf(newer)).toBe("Added scrolling.\n\nVerified\nTests pass.");
    expect(wholeOf(progress)).toBeNull();
    expect((progress as Node).text()).toBe("2m Waiting on the checks.");
  });

  // INF-27 (FI3-1540): the exact time behind each age reaches the keyboard
  // and assistive technology, not the native title alone.
  it("makes an age a stop named by its exact time, and an opening line's age part of its line's name", () => {
    const frame = mount();
    const reportAt = now - 28 * 60_000;
    const progressAt = now - 2 * 60_000;
    const exact = (at: number) => new Date(at).toLocaleString();
    frame.push(
      task({
        events: [event("report", "Added the toggle.\n\nVerified\nTests pass.", reportAt)],
        activityLog: [
          row("report", "Added the toggle.", reportAt),
          row("progress", "Waiting on the checks.", progressAt),
        ],
      }),
    );
    const [opening, plain] = frame.node("timeline").children as [Node, Node];
    const age = plain.children[0] as Node;
    expect(age.getAttribute("tabindex")).toBe("0");
    expect(age.getAttribute("aria-label")).toBe(`2m · ${exact(progressAt)}`);
    expect(age.getAttribute("title")).toBeNull();
    // The line that opens is the control: its age is no stop of its own,
    // and its name carries the exact time into the line's.
    const inside = (opening.children[0] as Node).children[0] as Node;
    expect(inside.getAttribute("tabindex")).toBeNull();
    expect(inside.getAttribute("aria-label")).toBe(`28m · ${exact(reportAt)}`);
    expect(inside.getAttribute("title")).toBeNull();
    // The minute's repaint keeps the name in step with the words.
    vi.setSystemTime(now + 60_000);
    frame.tick();
    expect(age.getAttribute("aria-label")).toBe(`3m · ${exact(progressAt)}`);
  });

  it("opens a line to the events folded under it, the ones before the line ahead of its whole text", () => {
    const frame = mount();
    const at = (minutes: number) => now - minutes * 60_000;
    const report = "The rerun failed again.\n\nVerified\nRead its log.";
    frame.push(
      task({
        status: "done",
        closedReason: "merged",
        outcome: report,
        events: [event("report", report, at(30))],
        activityLog: [
          {
            ...row("report", "The rerun failed again.", at(30)),
            folded: [
              row("note", "dependencies installed", at(50)),
              row("progress", "Reading the rerun's log.", at(32)),
            ],
          },
          {
            ...row("status", "merged", at(5)),
            folded: [row("note", "working copy removed", at(4))],
          },
        ],
      }),
    );
    const [reported, closing] = frame.node("timeline").children as Node[];
    const parts = (line: Node | undefined) =>
      (line?.children ?? []).flatMap((child) => {
        if (!(child instanceof Node)) return [];
        if (child.getAttribute("data-record-whole") === "") return ["whole"];
        const kind = child.getAttribute("data-record-folded");
        return kind ? [`${kind}: ${child.text()}`] : [];
      });
    expect(parts(reported)).toEqual([
      "note: 50m dependencies installed",
      "progress: 32m Reading the rerun's log.",
      "whole",
    ]);
    expect(wholeOf(reported)).toBe(report);
    // The line says how many events fold under it.
    expect(reported?.text()).toContain("+2");
    // A line with nothing to say beyond itself still opens to what folded under it.
    expect(parts(closing)).toEqual(["note: 4m working copy removed"]);
    expect(closing?.text()).toContain("+1");
  });

  it("opens a line to what the crewmate did, in time order with the events folded under it", () => {
    const frame = mount();
    const at = (minutes: number) => now - minutes * 60_000;
    const report = "The journey passes.\n\nVerified\nThree runs.";
    frame.push(
      task({
        events: [event("report", report, at(30))],
        activityLog: [
          row("dispatched", "crewmate 3 started.", at(60)),
          {
            ...row("report", "The journey passes.", at(30)),
            folded: [row("progress", "Running it three times.", at(40))],
            actions: [
              { at: at(45), text: "Edited tests/e2e/knowledge.spec.ts" },
              { at: at(35), text: "Run the journey three times in a row" },
              { at: at(20), text: "Push the branch" },
            ],
          },
        ],
      }),
    );
    const [, reported] = frame.node("timeline").children as Node[];
    const parts = (line: Node | undefined) =>
      (line?.children ?? []).flatMap((child) => {
        if (!(child instanceof Node)) return [];
        if (child.getAttribute("data-record-whole") === "") return ["whole"];
        const kind = child.getAttribute("data-record-folded");
        return kind ? [`${kind}: ${child.text()}`] : [];
      });
    expect(parts(reported)).toEqual([
      "action: 45m Edited tests/e2e/knowledge.spec.ts",
      "progress: 40m Running it three times.",
      "action: 35m Run the journey three times in a row",
      "whole",
      // What it did after the newest line comes after that line's whole text.
      "action: 20m Push the branch",
    ]);
    expect(reported?.text()).toContain("+4");
  });

  it("keeps a report's line plain when its summary already says all of it", () => {
    const frame = mount();
    frame.push(
      task({
        outcome: "Fixed the search.",
        outcomeSummary: "Fixed the search.",
        events: [event("report", "Fixed the search.")],
        activityLog: [row("report", "Fixed the search.")],
      }),
    );
    expect(wholeOf(frame.node("timeline").children[0])).toBeNull();
    frame.push(
      task({
        outcome: "Fixed the search. It reads keys.",
        outcomeSummary: "Fixed the search.",
        events: [event("report", "Fixed the search. It reads keys.")],
        activityLog: [row("report", "Fixed the search.")],
      }),
    );
    expect(wholeOf(frame.node("timeline").children[0])).toBe("Fixed the search. It reads keys.");
  });

  it("opens an operation's result from the line that closed it, since no report carries it", () => {
    const frame = mount();
    const result = "Set up the project Harbour.\nThe first task can start now.";
    frame.push(
      task({
        kind: "operation",
        status: "done",
        closedReason: "settled",
        outcome: result,
        outcomeSummary: "Set up the project Harbour.",
        // INF-1484 E1: canonical status text must not override the closing result.
        timeline: [
          {
            entry: {
              schemaVersion: 1,
              id: `task-event:test:${now - 50_000}`,
              taskId: "test",
              at: now - 50_000,
              actor: { kind: "host" },
              summary: "settled",
              content: {
                kind: "status",
                version: 1,
                ref: { source: "task-event", taskId: "test", eventId: now - 50_000 },
              },
              aliases: [],
              links: [],
              quiet: false,
            },
            actorLabel: "Recorded by the app",
            text: "settled",
          },
        ],
        events: [
          event("created", "created", now - 60_000),
          event("status", "settled", now - 50_000),
        ],
        activityLog: [
          row("created", "created", now - 60_000),
          row("status", "settled", now - 50_000),
        ],
      }),
    );
    const [created, closing] = frame.node("timeline").children;
    expect(wholeOf(created)).toBeNull();
    expect(wholeOf(closing)).toBe(result);
  });

  it("keeps an opened line open across live updates", () => {
    const frame = mount();
    const detail = task({
      outcome: "Fixed. Full evidence.",
      events: [event("report", "Fixed. Full evidence.")],
      activityLog: [row("report", "Fixed.")],
    });
    frame.push(detail);
    const line = frame.node("timeline").children[0] as Node;
    expect(line.open).toBe(false);
    line.open = true;
    line.listeners.toggle?.();
    frame.push({ ...detail, updatedAt: now + 1 });
    const again = frame.node("timeline").children[0] as Node;
    // INF-1140: preserve the node too, so an in-flight pointer press can finish.
    expect(again).toBe(line);
    expect(again.open).toBe(true);
    again.open = false;
    again.listeners.toggle?.();
    frame.push({ ...detail, updatedAt: now + 2 });
    expect((frame.node("timeline").children[0] as Node).open).toBe(false);
  });

  // INF-1138: a click opens a line at once and fires its toggle event a task
  // later, and an update between the two drew the line closed again - the
  // report's whole text in custom-api.spec.ts stayed hidden on the Mac. A
  // script's click on a line it found just before an update lands on the
  // line the update replaced.
  it("keeps a line as a click left it when an update lands before the click's toggle event", () => {
    const frame = mount();
    const detail = task({
      outcome: "Fixed. Full evidence.",
      events: [event("report", "Fixed. Full evidence.")],
      activityLog: [row("report", "Fixed.")],
    });
    const line = () => frame.node("timeline").children[0] as Node;
    frame.push(detail);
    const opened = line();
    opened.open = true;
    frame.push({ ...detail, updatedAt: now + 1 });
    opened.listeners.toggle?.();
    // INF-1140 strengthens this: the same disclosure survives, not only its open state.
    expect(line()).toBe(opened);
    expect(line().open).toBe(true);
    const closed = line();
    closed.open = false;
    frame.push({ ...detail, updatedAt: now + 2 });
    closed.listeners.toggle?.();
    expect(line().open).toBe(false);
    // The click lands on the line found before the update: the line drawn in its place opens.
    const found = line();
    frame.push({ ...detail, updatedAt: now + 3 });
    found.open = true;
    found.listeners.toggle?.();
    expect(line().open).toBe(true);
    frame.push({ ...detail, updatedAt: now + 4 });
    expect(line().open).toBe(true);
    // When the summary itself changes, INF-1138's late-toggle handoff still applies.
    const replaced = line();
    frame.push({ ...detail, activityLog: [row("report", "Fixed the search.")] });
    expect(line()).not.toBe(replaced);
    expect(line().open).toBe(true);
    replaced.open = false;
    replaced.listeners.toggle?.();
    expect(line().open).toBe(false);
  });

  // INF-1140: retained summaries must not freeze the content or lose the
  // minute's age refresh, and a row leaving the tail keeps its open state.
  it("keeps a summary mounted as its folded content grows and reconciles the tail by event", () => {
    const frame = mount();
    const reported = row("report", "Fixed.");
    const detail = task({
      events: [event("report", "Fixed. Full evidence.")],
      activityLog: [reported],
    });
    frame.push(detail);
    const original = frame.node("timeline").children[0] as Node;
    const summary = original.firstElementChild as Node;
    const age = summary.firstElementChild as Node;
    const count = summary.lastElementChild?.firstElementChild as Node;
    expect(count.hidden).toBe(true);
    original.open = true;
    const changed = {
      ...detail,
      events: [event("report", "Fixed. Updated evidence.")],
      activityLog: [{ ...reported, folded: [row("note", "Working copy removed.", now - 60_000)] }],
    };
    frame.push(changed);
    expect(frame.node("timeline").children[0]).toBe(original);
    expect(original.firstElementChild).toBe(summary);
    expect(summary.lastElementChild?.firstElementChild).toBe(count);
    expect(count.hidden).toBe(false);
    expect(count.textContent).toBe("+1");
    expect(original.open).toBe(true);
    expect(wholeOf(original)).toBe("Fixed. Updated evidence.");
    expect(original.text()).toContain("Working copy removed.");
    vi.setSystemTime(now + 60_000);
    frame.push(changed);
    expect(age.textContent).toBe("3m");
    vi.setSystemTime(now + 120_000);
    frame.tick();
    expect(age.textContent).toBe("4m");
    // New rows move the same disclosure behind Show earlier, not a stale clone.
    const later = Array.from({ length: 8 }, (_, i) => row("note", `Check ${i} finished.`, now + i));
    frame.push({ ...changed, activityLog: [...changed.activityLog, ...later] });
    expect(frame.node("history").children[0]).toBe(original);
    expect(original.open).toBe(true);
    expect(frame.node("timeline").children).toHaveLength(8);
    frame.push(task());
    expect(frame.node("history").children).toHaveLength(0);
    expect(frame.node("timeline").children).toHaveLength(0);
    frame.push(detail);
    expect(frame.node("timeline").children[0]).not.toBe(original);
    expect((frame.node("timeline").children[0] as Node).open).toBe(false);
  });

  it("has no buttons of its own: Show the card is the host bar's", () => {
    const frame = mount();
    for (const detail of [
      task({ waitingCardId: "card-test-1" }),
      task({ blockedBy: ["DEMO-38"], waitingCardId: "card-test-1" }),
      task({ activity: "interrupted", waitingCardId: "card-test-1" }),
    ]) {
      frame.push(detail);
      for (const region of frame.regions()) region.listeners.click?.();
    }
    expect(frame.action).not.toHaveBeenCalled();
  });

  it("shows the condensed activity with the start behind a Show earlier link", () => {
    const frame = mount();
    frame.push(
      task({
        activityLog: Array.from({ length: 12 }, (_, i) =>
          row("progress", `Progress ${i}`, now - 3_600_000 - i),
        ),
      }),
    );
    expect(frame.node("timeline").children).toHaveLength(8);
    expect(frame.node("history").children).toHaveLength(4);
    expect(frame.node("earlier-label").text()).toBe("Show earlier · 4");
    expect(frame.node("timeline").text()).toContain("1h Progress 11");
  });

  it("lists the task's cards newest first and asks the host to open the one pressed, writing nothing itself", () => {
    const frame = mount();
    frame.push(task());
    expect(frame.section("cards").hidden).toBe(true);

    frame.push(
      task({
        cards: [
          { id: "n1", kind: "note", title: "Folded note", state: "open", at: now - 60_000 },
          {
            id: "d2",
            kind: "decision",
            title: "Merge the fix",
            state: "closed",
            ending: "Closed without choosing",
            at: now - 7_200_000,
          },
          {
            id: "d1",
            kind: "decision",
            title: "How to build it",
            state: "closed",
            ending: "You chose Approve and build",
            at: now - 4 * 86_400_000,
          },
        ],
      }),
    );
    expect(frame.section("cards").hidden).toBe(false);
    const lines = frame.node("cards").children as Node[];
    expect(lines.map((line) => line.flat())).toEqual([
      "NoteFolded noteOn the stage",
      "DecisionMerge the fixClosed without choosing · 2h",
      "DecisionHow to build itYou chose Approve and build · 4d",
    ]);
    // Each line says whether its card is still on the stage, for a reader that does not read words.
    expect(lines.map((line) => line.attrs["data-record-card-state"])).toEqual([
      "open",
      "closed",
      "closed",
    ]);
    // The title is a button; pressing it asks the host to open that card by id.
    const link = lines[1]?.children[1] as Node;
    expect(link.attrs.type).toBe("button");
    link.listeners.click?.();
    expect(frame.action).toHaveBeenCalledTimes(1);
    expect(frame.action).toHaveBeenCalledWith("open-card", { id: "d2" });
  });

  it("lists what the work declared it used, by the revision it used, and asks the host to open that one", () => {
    const frame = mount({ knowledge: true });
    expect(frame.reads()).toContain("knowledge.uses");
    frame.push(task());
    frame.uses({ state: "ready", uses: [], total: 0 });
    expect(frame.section("knowledge").hidden).toBe(true);
    frame.uses({
      state: "ready",
      total: 2,
      uses: [
        {
          id: "f-abc123",
          kind: "finding",
          scope: "repo-harbor",
          revision: 1,
          title: "Closing a task keeps its evidence.",
          current: 2,
          currentTitle: "Closing a task keeps its supporting evidence.",
          retired: false,
          standing: "unchecked",
          purpose: "Kept the evidence when the task closed.",
          at: now - 60_000,
        },
        {
          id: "c-def456",
          kind: "concept",
          scope: "repo-harbor",
          revision: 3,
          title: "Retry policy",
          current: 3,
          currentTitle: "Retry policy",
          retired: false,
          standing: null,
          purpose: "",
          at: now - 120_000,
        },
      ],
    });
    expect(frame.section("knowledge").hidden).toBe(false);
    expect(frame.node("knowledge-count").text()).toBe("2");
    const lines = frame.node("knowledge").children as Node[];
    // The words of the revision it used, never the current one's in their place.
    expect(lines.map((line) => line.flat())).toEqual([
      "Closing a task keeps its evidence.Finding · used revision 1 · current revision 2Kept the evidence when the task closed.",
      "Retry policyConcept · used revision 3, the current one",
    ]);
    const [used, current] = lines.map((line) => line.children[0] as Node);
    used?.listeners.click?.();
    expect(frame.action).toHaveBeenLastCalledWith("open-knowledge", {
      id: "f-abc123",
      scope: "repo-harbor",
      revision: 1,
    });
    current?.listeners.click?.();
    expect(frame.action).toHaveBeenLastCalledWith("open-knowledge", {
      id: "c-def456",
      scope: "repo-harbor",
    });
    expect(frame.node("knowledge-more").hidden).toBe(true);
  });

  it("reads nothing of knowledge where the window has none", () => {
    const frame = mount();
    frame.push(task());
    expect(frame.reads()).not.toContain("knowledge.uses");
    expect(frame.section("knowledge").hidden).toBe(true);
  });

  it("hides unreadable data until a successful detail push, not a board update", () => {
    const frame = mount();
    frame.push(task());
    frame.fail();
    frame.board();
    expect(frame.node("content").hidden).toBe(true);
    expect(frame.node("note").text()).toBe("This record could not be read.");
    frame.push(task());
    expect(frame.node("content").hidden).toBe(false);
    expect(frame.node("note").hidden).toBe(true);
  });

  it("paints stable fact identities independently of their displayed labels", () => {
    const frame = mount();
    frame.push(
      task({
        assignee: "crewmate 21",
        model: "openai/gpt-6-sol",
        modelLabel: "GPT-6 Sol",
        repo: { name: "firstmate-3000", branch: "fm/task-ab12" },
        rigor: "standard",
        delivery: { mode: "direct-pr" },
        parentId: "task-parent",
        blockedBy: ["DEMO-38"],
        blocks: ["DEMO-43"],
        children: { total: 3, closed: 1 },
      }),
    );
    // The project and the relations are the Info tab's own rows above this
    // body (INF-2261), so More reads nothing of the parent.
    expect(frame.asked()).toEqual([]);
    const pairs = frame.node("facts").children as Node[];
    expect(
      pairs
        .filter((node) => node.getAttribute("data-record-fact") !== null)
        .map((value) => [
          value.getAttribute("data-record-fact"),
          pairs[pairs.indexOf(value) - 1]?.text(),
          value.text(),
        ]),
    ).toEqual([
      ["crewmate", "Crewmate", "crewmate 21 on GPT-6 Sol"],
      ["branch", "Branch", "fm/task-ab12"],
      ["delivery", "Delivery", "As a pull request · care: Default"],
    ]);
    // The closed More row names what it holds beside its label.
    expect(frame.node("more-preview").text()).toBe("branch · delivery");
    const facts = frame.node("facts").text();
    expect(facts).toContain("Crewmate crewmate 21 on GPT-6 Sol");
    expect(facts).toContain("Branch fm/task-ab12");
    expect(facts).toContain("Delivery As a pull request · care: Default");
    expect(facts).not.toContain("openai/gpt-6-sol");
    frame.push(task({ rigor: "quick" }));
    expect(frame.section("details").hidden).toBe(false);
    expect(frame.node("facts").text()).toBe("Delivery care: Quick");
    expect(frame.fact("delivery")?.text()).toBe("care: Quick");
    expect(frame.fact("crewmate")).toBeUndefined();
    frame.push(task());
    expect(frame.fact("delivery")).toBeUndefined();
    expect(frame.section("details").hidden).toBe(true);
  });

  it.each([
    ["direct-pr", "quick", "As a pull request · care: Quick"],
    ["local-only", "standard", "Merged locally, no pull request · care: Default"],
    ["in-place", "reviewed", "Built in place · care: Careful"],
  ] as const)(
    "reads %s delivery and %s care through the same fact identity",
    (mode, rigor, words) => {
      const frame = mount();
      frame.push(task({ delivery: { mode }, rigor }));
      expect(frame.fact("delivery")?.text()).toBe(words);
      expect(frame.section("details").hidden).toBe(false);
    },
  );

  it("says where a task runs and where that came from, with the helper while it is open", () => {
    const frame = mount();
    frame.push(task({ runsOn: { label: "Mac mini", source: "task" } }));
    expect(frame.fact("runs-on")?.text()).toBe("Mac miniThis task");
    expect(frame.node("facts").text()).toBe("Runs on Mac miniThis task");
    expect(frame.helper().text()).toBe("Ask your first mate to change these for this task.");
    frame.push(task({ runsOn: { label: "Running as Builder", source: "parent" } }));
    expect(frame.fact("runs-on")?.text()).toBe("Running as BuilderParent task");
    frame.push(task({ status: "done", runsOn: { label: "This Mac", source: "project" } }));
    expect(frame.fact("runs-on")?.text()).toBe("This MacProject setting");
    expect(frame.helper().text()).toBe("");
    frame.push(task());
    expect(frame.fact("runs-on")).toBeUndefined();
  });

  it("ends another task's Activity line in that task's key as words, and asks the host nothing", () => {
    const frame = mount();
    frame.push(
      task({
        activityLog: [
          { ...row("status", "SCR-4 waits for this task."), from: { id: "task-4", key: "SCR-4" } },
        ],
      }),
    );
    const line = frame.node("timeline").children[0];
    if (!(line instanceof Node)) throw new Error("The line is not drawn");
    expect(line.getAttribute("data-record-from")).toBe("SCR-4");
    // The key is plain text the bridge links, like every key the record writes.
    expect(line.text()).toBe("2m SCR-4 waits for this task. from SCR-4");
    for (const region of frame.regions()) region.listeners.click?.();
    for (const child of line.children) if (child instanceof Node) child.listeners.click?.();
    expect(frame.action).not.toHaveBeenCalled();
  });

  it("links the words that name a pull request to its page, on a line, a line that opens, a folded one and a linked one", () => {
    const frame = mount();
    const page = "https://github.com/o/r/pull/965";
    const named = (text: string, words: string, url = page) => ({
      url,
      from: text.indexOf(words),
      to: text.indexOf(words) + words.length,
    });
    const opened = "Opened pull request #965.";
    const failed = "The checks failed on pull request #965.";
    const fixed = "Fixed the lint the checks found on #965.";
    const merged = "SCR-9, filed by this task, merged pull request #977.";
    frame.push(
      task({
        activityLog: [
          {
            ...row("pr_opened", opened, now - 300_000),
            change: named(opened, "pull request #965"),
          },
          {
            ...row("ci", failed, now - 200_000),
            change: named(failed, "pull request #965"),
            folded: [{ ...row("progress", fixed, now - 250_000), change: named(fixed, "#965") }],
          },
          {
            ...row("merged", merged, now - 100_000),
            from: { id: "task-9", key: "SCR-9" },
            change: named(merged, "pull request #977", "https://github.com/o/r/pull/977"),
          },
        ],
      }),
    );
    /** Every link a node draws, by its words and its page. */
    const links = (node: Node | string | undefined): [string, string][] =>
      node instanceof Node
        ? [
            ...(node.getAttribute("data-record-change") === ""
              ? [[node.textContent, node.href] as [string, string]]
              : []),
            ...node.children.flatMap(links),
          ]
        : [];
    const [first, second, third] = frame.node("timeline").children;
    expect(links(first)).toEqual([["pull request #965", page]]);
    // The line itself, then what folded under it.
    expect(links(second)).toEqual([
      ["pull request #965", page],
      ["#965", page],
    ]);
    expect(links(third)).toEqual([["pull request #977", "https://github.com/o/r/pull/977"]]);
    // The words read as they did: the link is part of the line, nothing more.
    expect((first as Node).flat()).toBe(`5m${opened}`);
  });
});

// Approved INF-2215 reconciles waits into the existing explanation, preserving errors first.
