import type { RecordBar } from "@shared/recordBar";
import { DROP_TASK_LABEL, HIDE_RECORD_LABEL } from "@shared/recordDrop";
import type { TaskStatusReading } from "@shared/taskPresentation";
import type { DropEffects } from "@shared/tasks";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordPaneChrome, RecordPaneFooter } from "./RecordPaneChrome";
import type { RecordPillTone } from "./recordFooter";

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function rendered(props: {
  pillTone?: RecordPillTone;
  reading?: TaskStatusReading | null;
  taskKey?: string | null;
  title?: string;
}): Node {
  const html = renderToStaticMarkup(
    <RecordPaneChrome
      pillTone={props.pillTone ?? "neutral"}
      reading={
        props.reading === undefined
          ? { mark: "idle", word: "Idle", reason: "Waiting for checks" }
          : props.reading
      }
      taskKey={props.taskKey === undefined ? "FI3-84" : props.taskKey}
      title={props.title ?? "Prototype translucent app window variants"}
      onClose={() => {}}
    />,
  );
  return parseDocument(html) as unknown as Node;
}

function marked(root: Node, name: string): Node | undefined {
  let found: Node | undefined;
  walk(root, (node) => {
    if (node.type === ElementType.Tag && node.attribs && name in node.attribs) found = node;
  });
  return found;
}

function textOf(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === ElementType.Text) return node.data ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function contains(ancestor: Node | undefined, name: string): boolean {
  if (!ancestor) return false;
  let found = false;
  walk(ancestor, (node) => {
    if (node.type === ElementType.Tag && node.attribs && name in node.attribs) found = true;
  });
  return found;
}

describe("task record chrome", () => {
  it("puts the key on the top row and the title alone beneath, with no model there", () => {
    const root = rendered({});
    const chrome = marked(root, "data-record-chrome");
    const key = marked(root, "data-record-key");
    const title = marked(root, "data-record-title");

    expect(textOf(key)).toBe("FI3-84");
    expect(textOf(title)).toBe("Prototype translucent app window variants");
    expect(contains(chrome, "data-record-key")).toBe(true);
    expect(contains(title, "data-record-key")).toBe(false);
    // The model is a fact in the body's readout (FI3-565 piece 2), named once.
    expect(contains(root, "data-model-chip")).toBe(false);
    // The status and the task carry their shared fact identities, in order.
    const facts: string[] = [];
    walk(root, (node) => {
      const id = node.attribs?.["data-task-fact"];
      if (node.type === ElementType.Tag && id) facts.push(id);
    });
    expect(facts).toEqual(["status", "task"]);
  });

  it("uses the same lifecycle mark even on a tinted pill, with its reason beside it", () => {
    const idle = rendered({});
    expect(marked(idle, "data-task-mark")?.attribs?.["data-task-mark"]).toBe("idle");
    expect(textOf(marked(idle, "data-record-status-reason"))).toBe("Waiting for checks");
    const waiting = rendered({
      pillTone: "accent",
      reading: { mark: "waiting", word: "Waiting on you", reason: "A decision card is ready" },
    });
    expect(marked(waiting, "data-task-mark")?.attribs?.["data-task-mark"]).toBe("waiting");
  });

  it("names the top cross Hide, so it is not the control that drops the task", () => {
    const root = rendered({});
    const buttons = [] as string[];
    walk(root, (node) => {
      if (node.type === ElementType.Tag && node.name === "button") {
        buttons.push(node.attribs?.["aria-label"] ?? "");
      }
    });
    expect(buttons).toContain(HIDE_RECORD_LABEL);
    expect(buttons).not.toContain(DROP_TASK_LABEL);
  });
});

const emptyEffects: DropEffects = { parts: [], waiting: [], underway: [] };

function bar(state: RecordBar | null, extra: { effects?: DropEffects | null } = {}): Node {
  const html = renderToStaticMarkup(
    <RecordPaneFooter
      bar={state}
      effects={extra.effects === undefined ? emptyEffects : extra.effects}
      taskId="task-84"
      taskKey="FI3-84"
      revision={0}
      onRun={() => Promise.resolve()}
      onShowCard={() => {}}
    />,
  );
  return parseDocument(html) as unknown as Node;
}

/** The visible label of a button, without a pending-capable button's hidden pending label. */
function label(node: Node): string {
  const visible = (child: Node): string =>
    child.attribs && "aria-hidden" in child.attribs
      ? ""
      : child.type === ElementType.Text
        ? (child.data ?? "")
        : (child.children ?? []).map(visible).join("");
  return visible(node).trim();
}

/** Each slot's one button, marked when it is disabled; "" for an empty slot. */
function slots(root: Node): { end: string; next: string } {
  const found = { end: "", next: "" };
  walk(root, (node) => {
    const slot = node.attribs?.["data-record-slot"] as "end" | "next" | undefined;
    if (node.type !== ElementType.Tag || !slot) return;
    walk(node, (child) => {
      if (child.name !== "button") return;
      found[slot] = `${label(child)}${"disabled" in (child.attribs ?? {}) ? " (disabled)" : ""}`;
    });
  });
  return found;
}

/** The bar's buttons in document order, which is the order Tab reaches them. */
function buttons(root: Node): string[] {
  const found: string[] = [];
  walk(root, (node) => {
    if (node.name === "button") found.push(label(node));
  });
  return found;
}

/** The bar's words outside its buttons. */
function words(root: Node): string {
  const text = (node: Node): string =>
    node.name === "button"
      ? ""
      : node.type === ElementType.Text
        ? (node.data ?? "")
        : (node.children ?? []).map(text).join("");
  return text(root).trim();
}

const open = (patch: Partial<RecordBar>): RecordBar => ({
  end: "drop-task",
  next: "start",
  blocked: false,
  ...patch,
});

describe("task record action bar", () => {
  it("renders Start again alone in the next slot without confirmation", () => {
    const root = bar({ end: null, next: "start-again", blocked: false });
    expect(slots(root)).toEqual({ end: "", next: "Start again" });
    expect(buttons(root)).toEqual(["Start again"]);
    expect(words(root)).toBe("");
  });

  it("puts Drop task in the end slot and the one next step in the next slot, in every open state", () => {
    expect(slots(bar(open({})))).toEqual({ end: DROP_TASK_LABEL, next: "Start" });
    expect(slots(bar(open({ blocked: true })))).toEqual({
      end: DROP_TASK_LABEL,
      next: "Start (disabled)",
    });
    expect(slots(bar(open({ end: "stop-task", next: "continue" })))).toEqual({
      end: DROP_TASK_LABEL,
      next: "Continue",
    });
    expect(slots(bar(open({ end: "stop-task", next: "show-card" })))).toEqual({
      end: DROP_TASK_LABEL,
      next: "Show the card",
    });
    // An empty next slot: nothing needs the captain.
    expect(slots(bar(open({ end: "stop-task", next: null })))).toEqual({
      end: DROP_TASK_LABEL,
      next: "",
    });
    // A row no host op ends keeps its end slot, empty.
    expect(slots(bar(open({ end: null, next: "show-card" })))).toEqual({
      end: "",
      next: "Show the card",
    });
  });

  it("says nothing of its own at rest and names its slots for a reader", () => {
    const root = bar(open({ blocked: true }));
    const footer = marked(root, "data-record-footer");
    expect(footer?.attribs?.["data-record-footer"]).toBe("bar");
    expect(footer?.attribs?.["data-record-end"]).toBe("drop-task");
    expect(footer?.attribs?.["data-record-next"]).toBe("start");
    // The status reason and the body's attention box say what happens next.
    expect(words(root)).toBe("");
    expect(marked(root, "data-record-confirm")).toBeUndefined();
    const idle = bar(open({ end: "stop-task", next: null }));
    expect(marked(idle, "data-record-footer")?.attribs?.["data-record-next"]).toBe("none");
    expect(words(idle)).toBe("");
  });

  it("puts Drop task first and the next step last, so Tab reaches them in the order shown", () => {
    expect(buttons(bar(open({})))).toEqual([DROP_TASK_LABEL, "Start"]);
    expect(buttons(bar(open({ end: "stop-task", next: "continue" })))).toEqual([
      DROP_TASK_LABEL,
      "Continue",
    ]);
    // Each slot sits at its own edge of one row: the end slot first, the next slot last.
    const row = marked(bar(open({})), "data-record-footer")?.children?.[0];
    const order = (row?.children ?? []).map((child) => child.attribs?.["data-record-slot"] ?? "");
    expect(order).toEqual(["end", "", "next"]);
  });

  it("draws no bar on an open row with no button", () => {
    expect(marked(bar(open({ end: null, next: null })), "data-record-footer")).toBeUndefined();
  });

  it("has no bar on a closed record", () => {
    expect(marked(bar(null), "data-record-footer")).toBeUndefined();
  });
});
