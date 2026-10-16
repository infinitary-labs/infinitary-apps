import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { rendererTest as test } from "./renderer";
import { focusOn } from "./windowKeys";

// The real frame program and stylesheet, driven through its bridge contract
// in Chromium. This replaces the fake-DOM tests: scroll height, wrapping,
// resize, focus and node lifetime must be measured by a layout engine.
const html = readFileSync("src/renderer/src/plugins/builtin/observe/observe.html", "utf8");
const script = readFileSync("src/renderer/src/plugins/builtin/observe/observe.frame.js", "utf8");
const tokens = ["colors", "typography", "spacing", "effects"]
  .map((name) => readFileSync(`.claude/skills/infinitary-design/tokens/${name}.css`, "utf8"))
  .join("\n");
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
type FrameTest = typeof window & {
  callbacks: Record<string, (value: unknown) => void>;
  oldDetail: ((value: unknown) => void) | undefined;
};
async function publish(page: Page, read: string, value: unknown) {
  await page.evaluate(({ read, value }) => (window as FrameTest).callbacks[read]?.(value), {
    read,
    value,
  });
  await settle(page);
}
async function settle(page: Page) {
  // Windowing measures newly mounted rows, then fills the corrected range.
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
}
const scroll = (page: Page) => page.locator("[data-observe-transcript]");
async function visibleAnchor(page: Page) {
  return scroll(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-window-id]")].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    return { id: row?.dataset.windowId, offset: (row?.getBoundingClientRect().top ?? 0) - top };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.setContent(
    `<style>${tokens}\n* { box-sizing: border-box; } body { margin: 0; font-family: var(--font-ui); background: var(--bg-0); color: var(--fg-1); }</style>${html}`,
  );
  await page.evaluate(() => {
    const win = window as FrameTest;
    win.callbacks = {};
    Object.assign(window, {
      inf: {
        subscribe(read: string, _args: unknown, onNext: (value: unknown) => void) {
          if (read === "observe.session") win.oldDetail = win.callbacks[read];
          win.callbacks[read] = onNext;
          return { ready: Promise.resolve(), unsubscribe: async () => {} };
        },
      },
    });
  });
  await page.addScriptTag({ content: script });
  await publish(page, "observe.sessions", [main]);
});

test("follows the live bottom, keeps the reader's place through updates, and follows again only at the bottom", async ({
  page,
}) => {
  const history = turns(1000);
  await publish(page, "observe.session", { ...main, turns: history });
  await expect(scroll(page).getByText("Message 999")).toBeInViewport();
  await publish(page, "observe.live", {
    id: main.id,
    text: "streaming answer",
    tools: [{ callId: "c1", toolName: "emit_card" }],
  });
  await expect(scroll(page).getByText("streaming answer")).toBeInViewport();
  // The reader scrolls up into history; what they read stays in view while
  // the answer grows and new turns land below.
  await scroll(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await settle(page);
  const { id } = await visibleAnchor(page);
  await publish(page, "observe.live", {
    id: main.id,
    text: "streaming answer with many more lines\n".repeat(30),
    tools: [],
  });
  await publish(page, "observe.session", {
    ...main,
    turns: [...history, ...turns(2).map((t) => ({ ...t, id: `new-${t.id}` }))],
  });
  await expect(page.locator(`[data-window-id="${id}"]`)).toBeInViewport();
  // Back at the bottom, the live answer is followed again.
  await scroll(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await settle(page);
  await publish(page, "observe.live", { id: main.id, text: "finished answer", tools: [] });
  await expect(scroll(page).getByText("finished answer")).toBeInViewport();
});

test("keeps the reading anchor on resize, replaces history on compaction, and ignores an old session's late response", async ({
  page,
}) => {
  await publish(page, "observe.session", { ...main, turns: turns(1500) });
  await scroll(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await settle(page);
  const before = await visibleAnchor(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await settle(page);
  const after = await visibleAnchor(page);
  expect(after.id).toBe(before.id);
  await publish(page, "observe.session", {
    ...main,
    turns: [{ id: "compact", kind: "compaction", at: 1000, text: "Compacted history" }],
  });
  await expect(scroll(page)).toContainText("Compacted history");
  expect(await page.locator("[data-observe-turn]").count()).toBe(1);
  await publish(page, "observe.sessions", [main, crew("other")]);
  // Switch while a replacement of the OLD transcript is queued for paint.
  // No old node or late read may survive under the new session's header.
  await page.evaluate(
    (old) => {
      (window as FrameTest).callbacks["observe.session"]?.(old);
      document.querySelector<HTMLButtonElement>('[data-observe-session="other"]')?.click();
    },
    { ...main, turns: turns(10) },
  );
  await settle(page);
  await expect(scroll(page)).toContainText("Loading the transcript");
  await page.evaluate((old) => (window as FrameTest).oldDetail?.(old), {
    ...main,
    turns: turns(10),
  });
  await expect(scroll(page)).not.toContainText("Message");
  await publish(page, "observe.session", { ...crew("other"), turns: [] });
  await expect(scroll(page)).toContainText("No turns recorded yet");
  await expect(scroll(page).locator("[data-observe-turn]")).toHaveCount(0);
});

test("keeps the visible crew in view across prepends, and the keyboard reaches crew rows offscreen", async ({
  page,
}) => {
  const fleet = Array.from({ length: 500 }, (_, i) => crew(String(i)));
  await publish(page, "observe.sessions", [main, ...fleet]);
  const list = page.locator("[data-observe-session-list]");
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await settle(page);
  const read = await list.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    return [...el.querySelectorAll("[data-observe-session]")]
      .find((row) => row.getBoundingClientRect().bottom > top)
      ?.getAttribute("data-observe-session");
  });
  await publish(page, "observe.sessions", [main, crew("new"), ...fleet]);
  // A crewmate joining above leaves the row the reader was at in view.
  const current = page.locator(`[data-observe-session="${read}"]`);
  await expect(current).toBeInViewport();
  await focusOn(current);
  await current.press("End");
  await settle(page);
  await expect(page.locator('[data-observe-session="499"]')).toBeFocused();
  // Select, then navigate in the SAME frame. The explicit Home must win
  // over the selected-row update's queued reading anchor in the crew group.
  await page.locator('[data-observe-session="499"]').evaluate((row) => {
    (row as HTMLButtonElement).click();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  await expect(page.locator("[data-observe-detail-header]")).toContainText("Crew 499");
  await settle(page);
  await expect(page.locator('[data-observe-session="firstmate"]')).toBeFocused();
});

test("unchanged pushes and unrelated summary changes leave the reader's text selection intact", async ({
  page,
}) => {
  const detail = { ...main, turns: turns(1200) };
  await publish(page, "observe.session", detail);
  await scroll(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  await settle(page);
  await page
    .locator("[data-observe-turn-text]")
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  for (let i = 0; i < 3; i++) {
    await publish(page, "observe.sessions", [main, { ...crew("one"), title: `Changed ${i}` }]);
    await publish(page, "observe.session", detail);
  }
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
});

// Focused copy checks exercise the real frame program, not source strings.
test("discloses category and price coverage without turning ledger rows into turns", async ({
  page,
}) => {
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
  await publish(page, "observe.sessions", [session]);
  await publish(page, "observe.session", { ...session, turns: [] });
  const header = page.locator("[data-observe-detail-header]");
  const row = page.locator('[data-observe-session="firstmate"]');
  for (const region of [header, row]) {
    await expect(region).toContainText("47 in (2/3 records)");
    await expect(region).toContainText("0 out (1/3 records)");
    await expect(region).toContainText("Not available cache read");
    await expect(region).toContainText("0 cache write");
    await expect(region).toContainText("Estimated <$0.0001 (1/3 records priced)");
    await expect(region).toContainText("3 usage records");
    await expect(region).not.toContainText("3 turns");
  }
  await expect(header).toContainText("Session model: test/transcript");
  await expect(header).toContainText("test/historical (historical label; may combine models)");
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
  await publish(page, "observe.sessions", [unknown]);
  await publish(page, "observe.session", { ...unknown, turns: [] });
  await expect(header).toContainText("Not available in");
  await expect(header).toContainText("Estimated Not available (0/1 records priced)");
  await expect(header).not.toContainText("$0.0000");
  // An older producer has no coverage facts. Never infer completeness from its numeric zeroes.
  const legacy = { ...main, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 3 } };
  await publish(page, "observe.sessions", [legacy]);
  await publish(page, "observe.session", { ...legacy, turns: [] });
  await expect(header).toContainText("coverage unknown");
  await expect(header).toContainText("Usage record count unavailable");
  await expect(header).not.toContainText("3 turns");
});
