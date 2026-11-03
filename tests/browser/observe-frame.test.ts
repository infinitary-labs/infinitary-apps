import { beforeEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import colors from "../../.claude/skills/infinitary-design/tokens/colors.css?raw";
import effects from "../../.claude/skills/infinitary-design/tokens/effects.css?raw";
import spacing from "../../.claude/skills/infinitary-design/tokens/spacing.css?raw";
import typography from "../../.claude/skills/infinitary-design/tokens/typography.css?raw";
import script from "../../src/renderer/src/plugins/builtin/observe/observe.frame.js?raw";
import html from "../../src/renderer/src/plugins/builtin/observe/observe.html?raw";

/**
 * The Observe frame program and its stylesheet, the very text the app's own
 * panel imports, driven through its bridge contract in Chromium. Scroll
 * height, wrapping, resize, focus and node lifetime must be measured by a
 * layout engine, so these replaced the fake-DOM tests (docs/dev-observe.md).
 *
 * Each test draws the program in a frame of its own, as the app draws it in
 * a frame, so no test sees a document, listener or scroll another left.
 */

const tokens = [colors, typography, spacing, effects].join("\n");
const main = {
  id: "firstmate",
  kind: "orchestrator",
  title: "First mate",
  taskId: "firstmate",
  repo: null,
  model: null,
  status: "streaming",
  startedAt: null,
  endedAt: null,
  usage: null,
  error: null,
  authFailure: false,
  backend: "pi",
  transcriptNote: null,
  routing: null,
};
const crew = (id: string) => ({ ...main, id, taskId: id, title: `Crew ${id}`, kind: "crewmate" });
const turns = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    at: 1000 + i,
    kind: "assistant",
    text: `Message ${i}\n${"Wrapped evidence. ".repeat(i % 17)}`,
  }));

type Callback = (value: unknown) => void;
/** The frame's world as this test plays the host: each read's newest callback, and the one it replaced for a session. */
type ObserveWindow = Window & {
  inf: unknown;
  callbacks: Record<string, Callback>;
  oldDetail: Callback | undefined;
};

/** The frame the program runs in, for this test. */
let frame: HTMLIFrameElement;
const view = () => frame.contentWindow as ObserveWindow;
const doc = () => frame.contentDocument as Document;
const one = (selector: string) => doc().querySelector<HTMLElement>(selector);
const scroller = () => one("[data-observe-transcript]") as HTMLElement;
const list = () => one("[data-observe-session-list]") as HTMLElement;
/** An element's words as a reader sees them, whitespace collapsed. */
const words = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ");

/** Windowing measures newly mounted rows, then fills the corrected range. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((done) => view().requestAnimationFrame(done));
}

async function publish(read: string, value: unknown): Promise<void> {
  view().callbacks[read]?.(value);
  await settle();
}

/** Sizes the frame, as the window the program fills. */
function size(width: number, height: number): void {
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
}

/** Whether any of `element` shows in the frame's viewport, clipped by its scrollers, as an intersection observer reads it. */
function inViewport(element: Element | null | undefined): Promise<boolean> {
  if (!element) return Promise.resolve(false);
  return new Promise((done) => {
    const observer = new (view() as unknown as typeof globalThis).IntersectionObserver(
      ([entry]) => {
        observer.disconnect();
        done((entry?.intersectionRatio ?? 0) > 0);
      },
    );
    observer.observe(element);
  });
}

/** The row in the transcript whose words include `text`. */
function transcriptRow(text: string): HTMLElement | undefined {
  return [...scroller().querySelectorAll<HTMLElement>("[data-observe-turn]")].find((row) =>
    words(row).includes(text),
  );
}

function visibleAnchor() {
  const el = scroller();
  const top = el.getBoundingClientRect().top;
  const row = [...el.querySelectorAll<HTMLElement>("[data-window-id]")].find(
    (row) => row.getBoundingClientRect().bottom > top,
  );
  return { id: row?.dataset.windowId, offset: (row?.getBoundingClientRect().top ?? 0) - top };
}

beforeEach(async () => {
  frame?.remove();
  frame = document.createElement("iframe");
  frame.style.border = "0";
  frame.srcdoc = `<!doctype html><style>${tokens}\n* { box-sizing: border-box; } body { margin: 0; font-family: var(--font-ui); background: var(--bg-0); color: var(--fg-1); }</style>${html}`;
  const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
  size(1000, 650);
  document.body.replaceChildren(frame);
  await loaded;
  const win = view();
  win.callbacks = {};
  win.inf = {
    subscribe(read: string, _args: unknown, onNext: Callback) {
      if (read === "observe.session") win.oldDetail = win.callbacks[read];
      win.callbacks[read] = onNext;
      return { ready: Promise.resolve(), unsubscribe: async () => {} };
    },
  };
  const program = doc().createElement("script");
  program.textContent = script;
  doc().body.append(program);
  await publish("observe.sessions", [main]);
});

test("follows the live bottom, keeps the reader's place through updates, and follows again only at the bottom", async () => {
  const history = turns(1000);
  await publish("observe.session", { ...main, turns: history });
  await expect.poll(() => inViewport(transcriptRow("Message 999"))).toBe(true);
  await publish("observe.live", {
    id: main.id,
    text: "streaming answer",
    tools: [{ callId: "c1", toolName: "emit_card" }],
  });
  await expect.poll(() => inViewport(transcriptRow("streaming answer"))).toBe(true);
  // The reader scrolls up into history; what they read stays in view while
  // the answer grows and new turns land below.
  scroller().scrollTop = scroller().scrollHeight / 2;
  await settle();
  const { id } = visibleAnchor();
  await publish("observe.live", {
    id: main.id,
    text: "streaming answer with many more lines\n".repeat(30),
    tools: [],
  });
  await publish("observe.session", {
    ...main,
    turns: [...history, ...turns(2).map((t) => ({ ...t, id: `new-${t.id}` }))],
  });
  await expect.poll(() => inViewport(one(`[data-window-id="${id}"]`))).toBe(true);
  // Back at the bottom, the live answer is followed again.
  scroller().scrollTop = scroller().scrollHeight;
  await settle();
  await publish("observe.live", { id: main.id, text: "finished answer", tools: [] });
  await expect.poll(() => inViewport(transcriptRow("finished answer"))).toBe(true);
});

test("keeps the reading anchor on resize, replaces history on compaction, and ignores an old session's late response", async () => {
  await publish("observe.session", { ...main, turns: turns(1500) });
  scroller().scrollTop = scroller().scrollHeight / 2;
  await settle();
  const before = visibleAnchor();
  size(800, 600);
  await settle();
  const after = visibleAnchor();
  expect(after.id).toBe(before.id);
  await publish("observe.session", {
    ...main,
    turns: [{ id: "compact", kind: "compaction", at: 1000, text: "Compacted history" }],
  });
  await expect.poll(() => words(scroller())).toContain("Compacted history");
  expect(doc().querySelectorAll("[data-observe-turn]")).toHaveLength(1);
  await publish("observe.sessions", [main, crew("other")]);
  // Switch while a replacement of the OLD transcript is queued for paint.
  // No old node or late read may survive under the new session's header.
  view().callbacks["observe.session"]?.({ ...main, turns: turns(10) });
  one('[data-observe-session="other"]')?.click();
  await settle();
  await expect.poll(() => words(scroller())).toContain("Loading the transcript");
  view().oldDetail?.({ ...main, turns: turns(10) });
  await expect.poll(() => words(scroller())).not.toContain("Message");
  await publish("observe.session", { ...crew("other"), turns: [] });
  await expect.poll(() => words(scroller())).toContain("No turns recorded yet");
  expect(scroller().querySelectorAll("[data-observe-turn]")).toHaveLength(0);
});

test("keeps the visible crew in view across prepends, and the keyboard reaches crew rows offscreen", async () => {
  const fleet = Array.from({ length: 500 }, (_, i) => crew(String(i)));
  await publish("observe.sessions", [main, ...fleet]);
  list().scrollTop = list().scrollHeight / 2;
  await settle();
  const top = list().getBoundingClientRect().top;
  const read = [...list().querySelectorAll("[data-observe-session]")]
    .find((row) => row.getBoundingClientRect().bottom > top)
    ?.getAttribute("data-observe-session");
  await publish("observe.sessions", [main, crew("new"), ...fleet]);
  // A crewmate joining above leaves the row the reader was at in view.
  const current = () => one(`[data-observe-session="${read}"]`);
  await expect.poll(() => inViewport(current())).toBe(true);
  current()?.focus();
  await expect.poll(() => doc().activeElement === current()).toBe(true);
  await userEvent.keyboard("{End}");
  await settle();
  await expect.poll(() => doc().activeElement?.getAttribute("data-observe-session")).toBe("499");
  // Select, then navigate in the SAME frame. The explicit Home must win
  // over the selected-row update's queued reading anchor in the crew group.
  const last = one('[data-observe-session="499"]') as HTMLButtonElement;
  last.click();
  // A key event of the frame's own realm, as the frame's own key would be.
  const { KeyboardEvent: FrameKeyboardEvent } = view() as unknown as typeof globalThis;
  last.dispatchEvent(new FrameKeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await expect.poll(() => words(one("[data-observe-detail-header]"))).toContain("Crew 499");
  await settle();
  await expect
    .poll(() => doc().activeElement?.getAttribute("data-observe-session"))
    .toBe("firstmate");
});

test("unchanged pushes and unrelated summary changes leave the reader's text selection intact", async () => {
  const detail = { ...main, turns: turns(1200) };
  await publish("observe.session", detail);
  scroller().scrollTop = 0;
  await settle();
  const first = one("[data-observe-turn-text]") as HTMLElement;
  const range = doc().createRange();
  range.selectNodeContents(first);
  view().getSelection()?.removeAllRanges();
  view().getSelection()?.addRange(range);
  const selected = view().getSelection()?.toString();
  expect(selected).not.toBe("");
  for (let i = 0; i < 3; i++) {
    await publish("observe.sessions", [main, { ...crew("one"), title: `Changed ${i}` }]);
    await publish("observe.session", detail);
  }
  expect(view().getSelection()?.toString()).toBe(selected);
});

// Focused copy checks exercise the real frame program, not source strings.
test("discloses category and price coverage without turning ledger rows into turns", async () => {
  const usage = {
    input: 47,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.000001,
    turns: 3,
    records: 3,
    priced: 1,
    reported: { input: 2, output: 1, cacheRead: 0, cacheWrite: 3 },
    models: [
      {
        provider: "test",
        model: "historical",
        attribution: "historical",
        input: 47,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.000001,
        records: 3,
        priced: 1,
        reported: { input: 2, output: 1, cacheRead: 0, cacheWrite: 3 },
      },
    ],
  };
  const session = { ...main, model: "test/transcript", usage };
  await publish("observe.sessions", [session]);
  await publish("observe.session", { ...session, turns: [] });
  const header = () => words(one("[data-observe-detail-header]"));
  const row = () => words(one('[data-observe-session="firstmate"]'));
  for (const region of [header, row]) {
    await expect.poll(region).toContain("47 in (2/3 records)");
    expect(region()).toContain("0 out (1/3 records)");
    expect(region()).toContain("Not available cache read");
    expect(region()).toContain("0 cache write");
    expect(region()).toContain("Estimated <$0.0001 (1/3 records priced)");
    expect(region()).toContain("3 usage records");
    expect(region()).not.toContain("3 turns");
  }
  expect(header()).toContain("Session model: test/transcript");
  expect(header()).toContain("test/historical (historical label; may combine models)");
  const unknown = {
    ...main,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
      records: 1,
      priced: 0,
      reported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  await publish("observe.sessions", [unknown]);
  await publish("observe.session", { ...unknown, turns: [] });
  await expect.poll(header).toContain("Not available in");
  expect(header()).toContain("Estimated Not available (0/1 records priced)");
  expect(header()).not.toContain("$0.0000");
  // An older producer has no coverage facts. Never infer completeness from its numeric zeroes.
  const legacy = { ...main, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 3 } };
  await publish("observe.sessions", [legacy]);
  await publish("observe.session", { ...legacy, turns: [] });
  await expect.poll(header).toContain("coverage unknown");
  expect(header()).toContain("Usage record count unavailable");
  expect(header()).not.toContain("3 turns");
});
