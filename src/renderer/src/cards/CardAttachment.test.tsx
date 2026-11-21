import type { LiveAttachment } from "@shared/cards";
import { STALE_ATTACHMENT_LINE } from "@shared/taskBrowser";
import type { TaskDetail } from "@shared/tasks";
import { ElementType, parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attachmentReading, CardAttachmentStrip, pressReopens } from "./CardAttachment";

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

function textOf(node: Node | undefined): string {
  if (!node) return "";
  if (node.type === ElementType.Text) return node.data ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function marked(root: Node, name: string): Node | undefined {
  let found: Node | undefined;
  walk(root, (node) => {
    if (!found && node.type === ElementType.Tag && node.attribs && name in node.attribs)
      found = node;
  });
  return found;
}

function buttons(root: Node): Node[] {
  const found: Node[] = [];
  walk(root, (node) => {
    if (node.type === ElementType.Tag && node.name === "button") found.push(node);
  });
  return found;
}

const ATTACHMENT: LiveAttachment = {
  kind: "browser",
  label: "Try it",
  taskId: "t1",
  session: "run-1",
  generation: 2,
};

/** A task's record as the strip reads it: its work posture and its browser. */
function detail(browser: TaskDetail["browser"], turn = false): TaskDetail {
  return {
    activity: turn ? "running" : "idle",
    workPosture: turn ? { state: "active", reason: "turn" } : { state: "idle", reason: "idle" },
    ...(browser ? { browser } : {}),
  } as unknown as TaskDetail;
}

const OPEN = {
  state: "open" as const,
  site: "localhost:5173",
  url: "http://localhost:5173/signup",
  title: "Sign up",
  session: "run-1",
  generation: 2,
};

function strip(reading: ReturnType<typeof attachmentReading>): Node {
  return parseDocument(
    renderToStaticMarkup(
      <CardAttachmentStrip attachment={ATTACHMENT} reading={reading} onOpen={() => {}} />,
    ),
  ) as unknown as Node;
}

describe('a card\'s live attachment (docs/task-browser.md, "From a card")', () => {
  it("names the site and who drives the card's browser, with the crewmate's label as its one button", () => {
    const root = strip(attachmentReading(ATTACHMENT, detail(OPEN)));
    const box = marked(root, "data-card-attachment");
    expect(box?.attribs?.["data-card-attachment"]).toBe("browser");
    expect(box?.attribs?.["data-attachment-standing"]).toBe("same");
    expect(textOf(marked(root, "data-attachment-line"))).toBe("localhost:5173 · nobody is driving");
    expect(textOf(strip(attachmentReading(ATTACHMENT, detail(OPEN, true))))).toContain(
      "localhost:5173 · the crewmate is driving",
    );
    // One host button, the crewmate's words on it, and nothing a body script could name.
    expect(buttons(root).map(textOf)).toEqual(["Try it"]);
    expect(
      renderToStaticMarkup(
        <CardAttachmentStrip
          attachment={ATTACHMENT}
          reading={attachmentReading(ATTACHMENT, detail(OPEN))}
          onOpen={() => {}}
        />,
      ),
    ).not.toContain("data-inf-action");
  });

  it("says what stopped the card's browser while it is still the task's", () => {
    const stopped = { ...OPEN, state: "stopped" as const, stopped: "idle" as const, at: 1 };
    const reading = attachmentReading(ATTACHMENT, detail(stopped));
    expect(reading.standing).toBe("same");
    expect(textOf(marked(strip(reading), "data-attachment-line"))).toBe(
      "localhost:5173 · stopped after 30 minutes unused",
    );
  });

  it("says the card's browser has stopped once a newer one took its place or Firstmate quit", () => {
    const newer = attachmentReading(ATTACHMENT, detail({ ...OPEN, generation: 3 }));
    expect(newer.standing).toBe("replaced");
    const afterQuit = attachmentReading(ATTACHMENT, detail({ ...OPEN, session: "run-2" }));
    expect(afterQuit.standing).toBe("restarted");
    const none = attachmentReading(ATTACHMENT, detail(undefined));
    expect(none.standing).toBe("restarted");
    for (const reading of [newer, afterQuit, none]) {
      const root = strip(reading);
      expect(textOf(marked(root, "data-attachment-line"))).toBe(STALE_ATTACHMENT_LINE);
      // The door still opens the view, which says the same.
      expect(buttons(root).map(textOf)).toEqual(["Try it"]);
    }
  });

  it("draws a request card's strip as attention while it waits, his violet while he drives, then plain, never with a door beside the card's own action (docs/task-browser.md, \"Asking for help\")", () => {
    const request: LiveAttachment = { ...ATTACHMENT, label: "Open browser", handoff: true };
    const box = (control?: "waiting" | "captain") => {
      const reading = attachmentReading(
        request,
        detail(control ? { ...OPEN, control } : OPEN, true),
      );
      const root = parseDocument(
        renderToStaticMarkup(
          <CardAttachmentStrip attachment={request} reading={reading} onOpen={() => {}} />,
        ),
      ) as unknown as Node;
      return {
        handoff: marked(root, "data-card-attachment")?.attribs?.["data-attachment-handoff"],
        style: marked(root, "data-card-attachment")?.attribs?.style ?? "",
        line: textOf(marked(root, "data-attachment-line")),
        buttons: buttons(root).map(textOf),
      };
    };
    expect(box("waiting")).toMatchObject({
      handoff: "waiting",
      line: "localhost:5173 · paused for your help",
    });
    expect(box("waiting").style).toContain("var(--warn-dim)");
    expect(box("captain")).toMatchObject({
      handoff: "captain",
      line: "localhost:5173 · you have control",
    });
    expect(box("captain").style).toContain("var(--captain-dim)");
    // Returned, the request is done and the strip is the ordinary one.
    expect(box()).toMatchObject({
      handoff: "done",
      line: "localhost:5173 · the crewmate is driving",
    });
    expect(box().style).not.toContain("-dim");
    // The captain's words on INF-155's sign-in card: "there are two "open
    // browser" buttons here, so it's confusing". The card's own action is
    // the one way in, whoever holds the browser.
    for (const control of ["waiting", "captain", undefined] as const) {
      expect(box(control).buttons).toEqual([]);
    }
    // A card that asked nothing is never tinted, whoever holds its browser, and keeps its door.
    const plain = strip(attachmentReading(ATTACHMENT, detail({ ...OPEN, control: "waiting" })));
    expect(marked(plain, "data-card-attachment")?.attribs?.style ?? "").not.toContain("-dim");
    expect(buttons(plain).map(textOf)).toEqual(["Try it"]);
  });

  it('says a browser open at Infinitary\'s quit stopped when it quit (docs/task-browser.md, "After a restart")', () => {
    const quit = {
      ...OPEN,
      state: "stopped" as const,
      stopped: "gone" as const,
      quit: true as const,
      at: 1,
    };
    expect(
      textOf(marked(strip(attachmentReading(ATTACHMENT, detail(quit))), "data-attachment-line")),
    ).toBe("localhost:5173 · stopped when Infinitary quit");
  });

  it("opens a stopped browser again on the press only while it may be opened again", () => {
    const stopped = { ...OPEN, state: "stopped" as const, stopped: "idle" as const, at: 1 };
    const record = (browser: TaskDetail["browser"], status = "open") =>
      ({ ...detail(browser), status }) as TaskDetail;
    expect(pressReopens(record(stopped), false)).toBe(true);
    // Open: the press only opens the view.
    expect(pressReopens(record(OPEN), false)).toBe(false);
    // Stopped by the task's close, or the task done: nothing is started again.
    expect(pressReopens(record({ ...stopped, stopped: "task-closed" }), false)).toBe(false);
    expect(pressReopens(record(stopped, "done"), false)).toBe(false);
    // Changes on the first mate's computer are off, or the record has not answered.
    expect(pressReopens(record(stopped), true)).toBe(false);
    expect(pressReopens(null, false)).toBe(false);
  });

  it("draws no line until the task's record answers", () => {
    const reading = attachmentReading(ATTACHMENT, null);
    expect(reading).toEqual({ standing: "same", line: null });
    expect(textOf(marked(strip(reading), "data-attachment-line"))).toBe("");
  });
});
