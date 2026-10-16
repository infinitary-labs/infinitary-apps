import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { connectionSentence } from "../../src/panels/knowledge/words";
import { scratchDir } from "../helpers/scratchDirs";
import { frameIn } from "./frames";
import {
  browser,
  browserCard,
  browsersOnStage,
  camera,
  clickConcept,
  concept,
  connection,
  dragGraph,
  drawnAt,
  filterDirections,
  focusInBrowser,
  graph,
  inspector,
  KNOWLEDGE_TITLE,
  knowledgeHeader,
  knowledgePanel,
  knowledgeSummary,
  OPEN_KNOWLEDGE,
  pressIn,
  pressKnowledgeGraph,
  row,
  section,
  tab,
  wheelOnGraph,
} from "./knowledgeBrowser";
import { PINS_CLAIM, seedKnowledge, WEBSITE } from "./knowledgeSeed";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { restOnTaskKey, rowSummary, taskKeyLinks } from "./rails";
import { dragCardTo, SHOWN_ENTRY } from "./stack";
import {
  commandSearch,
  focusOn,
  pressKey,
  pressWindowKey,
  runFromSearch,
  typeInto,
} from "./windowKeys";

/**
 * The knowledge browser (docs/knowledge.md, "The browser"; FI3-1110's
 * approved design and its camera revision), in a development build, over a
 * collection two crewmates recorded through the real owner: Open Knowledge
 * from command search and from the Knowledge panel, the 3D graph and its
 * camera by keys and by either mouse button, a claim and its evidence, the
 * Concepts and Findings lists with Find and the filters, the inspector's
 * sections, the narrow card's Back, and Esc in its order - while browsing
 * writes no knowledge and starts no task. The stable side of the gate is
 * tests/e2e/knowledge-gate.spec.ts.
 */

const HOME = { yaw: 0.18, pitch: -0.12, zoom: 1 };

/** Every row the collection holds, by table: what a write would change. */
function knowledgeRows(userDataDir: string): Record<string, number> {
  const db = new Database(join(userDataDir, "knowledge", "knowledge.db"), { readonly: true });
  try {
    return Object.fromEntries(
      ["entries", "revisions", "sources", "assessments", "relations", "uses", "requests"].map(
        (table) => [
          table,
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ],
      ),
    );
  } finally {
    db.close();
  }
}

/** How many tasks the record holds: browsing never files one. */
async function taskCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.infinitary.tasks.board()).tasks.length);
}

type Drawn = { x: number; y: number; depth: number };

/** Every concept's drawn place, by id. */
async function places(page: Page, ids: readonly string[]): Promise<Record<string, Drawn>> {
  const drawn: Record<string, Drawn> = {};
  for (const id of ids) drawn[id] = await drawnAt(page, id);
  return drawn;
}

test("Open Knowledge by name, then the keys walk the graph, orbit and zoom it, open a claim's evidence, and search the lists", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-browser-");
  const k = await seedKnowledge(userDataDir);
  const rowsBefore = knowledgeRows(userDataDir);
  const { app, page } = await launchApp({
    userDataDir,
    withMockProvider: true,
    gpuBenchmarking: true,
  });
  try {
    await test.step("the Knowledge panel docks under Tasks, collapsed, and says how many concepts are kept beside its title", async () => {
      await expect(knowledgePanel(page)).toBeAttached({ timeout: 30_000 });
      await expect(knowledgePanel(page)).toHaveAttribute("data-side-panel-collapsed", "");
      await expect(knowledgeSummary(page)).toContainText("9 concepts");
      await expect(knowledgeHeader(page)).toContainText(KNOWLEDGE_TITLE);
      const search = commandSearch(page);
      await pressWindowKey(app, "k", ["meta"]);
      await search.field.fill("knowledge");
      await expect(search.row(OPEN_KNOWLEDGE)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(search.dialog).toHaveCount(0);
    });
    const tasksBefore = await taskCount(page);

    await test.step("Open Knowledge puts the browser up on your graph, focus on its graph", async () => {
      await runFromSearch(app, page, OPEN_KNOWLEDGE);
      await expect(browserCard(page)).toBeVisible();
      await expect(browser(page)).toHaveAttribute("data-knowledge-scope", "captain");
      await expect.poll(() => focusInBrowser(page)).toBe("graph");
      // Concepts only: both projects' saved references now belong to the captain.
      await expect(browser(page).locator("[data-knowledge-node]")).toHaveCount(9);
      await expect(concept(page, k.website)).toBeVisible();
      await expect(browser(page).locator("[data-knowledge-connection]")).toHaveCount(6);
      expect(await camera(page)).toEqual(HOME);
    });

    await test.step("the arrows choose concepts, Enter inspects, Esc comes back, and the Connections list names the selected concept's", async () => {
      // By name: Evidence comes first.
      await page.keyboard.press("ArrowRight");
      await expect(concept(page, k.evidence)).toHaveAttribute("aria-selected", "true");
      await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.evidence);
      await expect(browser(page).locator("[data-knowledge-explanation]")).toBeVisible();
      for (const id of [
        `claim:${k.pins}`,
        `claim:${k.retains}`,
        `context:${k.reuse}:${k.evidence}`,
      ]) {
        await expect(row(page, id)).toBeVisible();
      }
      await page.keyboard.press("ArrowRight");
      await expect(concept(page, k.reuse)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowLeft");
      await expect(concept(page, k.evidence)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect.poll(() => focusInBrowser(page)).toBe("section:overview");
      await page.keyboard.press("Escape");
      await expect.poll(() => focusInBrowser(page)).toBe("graph");
      await expect(browsersOnStage(page)).toHaveCount(1);
    });

    await test.step("Shift and the arrows orbit as the pointer does, + and − zoom, and Home resets to the neutral camera", async () => {
      const ids = [
        k.evidence,
        k.versions,
        k.retry,
        k.identity,
        k.delivery,
        k.failures,
        k.lifecycle,
        k.reuse,
      ];
      const before = await places(page, ids);
      const depths = Object.entries(before).sort((a, b) => b[1].depth - a[1].depth);
      const [farthest] = depths[0] ?? [];
      const [nearest] = depths.at(-1) ?? [];
      await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(async () => (await camera(page)).yaw).toBeCloseTo(HOME.yaw - 0.16, 5);
      // The camera turns right: the far side sweeps left, the near side right.
      // The seed pins its ids, so the graph lays out the same on every run,
      // its nearest concept in front of the center: perspective draws a near
      // concept far off to one side inward as the camera turns.
      const after = await places(page, ids);
      expect(after[farthest as string]?.x).toBeLessThan(before[farthest as string]?.x ?? 0);
      expect(after[nearest as string]?.x).toBeGreaterThan(before[nearest as string]?.x ?? 0);
      await page.keyboard.press("Shift+ArrowLeft");
      await expect.poll(async () => (await camera(page)).yaw).toBeCloseTo(HOME.yaw, 5);
      await page.keyboard.press("Shift+ArrowDown");
      await expect.poll(async () => (await camera(page)).pitch).toBeGreaterThan(HOME.pitch);
      await page.keyboard.press("+");
      await expect.poll(async () => (await camera(page)).zoom).toBe(1.1);
      await page.keyboard.press("-");
      await page.keyboard.press("-");
      await expect.poll(async () => (await camera(page)).zoom).toBe(0.9);
      await page.keyboard.press("Home");
      await expect.poll(() => camera(page)).toEqual(HOME);
      // The camera never moved the selection.
      await expect(concept(page, k.evidence)).toHaveAttribute("aria-selected", "true");
    });

    await test.step("Orbit right, pressed from the keyboard, turns the camera the way the pointer and Shift → do", async () => {
      await browser(page).getByRole("button", { name: "Orbit right", exact: true }).press("Enter");
      await expect.poll(async () => (await camera(page)).yaw).toBeCloseTo(HOME.yaw - 0.22, 5);
      await browser(page).getByRole("button", { name: "Reset view", exact: true }).press("Enter");
      await expect.poll(() => camera(page)).toEqual(HOME);
    });

    await test.step("the Connections list opens a claim: its line and ends lit, its sentence and standing at once, then its evidence", async () => {
      await focusOn(
        browser(page).locator('[data-knowledge-connections] [data-knowledge-row][tabindex="0"]'),
      );
      for (let i = 0; i < 4 && (await focusInBrowser(page)) !== `row:claim:${k.pins}`; i++) {
        await page.keyboard.press("ArrowDown");
      }
      await expect.poll(() => focusInBrowser(page)).toBe(`row:claim:${k.pins}`);
      await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", `claim:${k.pins}`);
      await expect(browser(page).locator("[data-knowledge-heading]")).toHaveText(
        connectionSentence({
          kind: "claim",
          from: { title: PINS_CLAIM.from },
          predicate: PINS_CLAIM.predicate,
          to: { title: PINS_CLAIM.to },
        }),
      );
      // Its finding's cited file changed after it was kept: that shows at once.
      await expect(inspector(page).locator('[data-knowledge-standing="recheck"]')).toBeVisible();
      await expect(connection(page, `claim:${k.pins}`)).toHaveAttribute("data-lit", "");
      await expect(connection(page, `claim:${k.retains}`)).not.toHaveAttribute("data-lit", "");
      await expect(concept(page, k.evidence)).toHaveAttribute("aria-selected", "true");
      await expect(concept(page, k.versions)).toHaveAttribute("aria-selected", "true");
      await expect(
        browser(page).locator(`[data-knowledge-predicate="claim:${k.pins}"]`),
      ).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect.poll(() => focusInBrowser(page)).toBe("section:overview");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focusInBrowser(page)).toBe("section:evidence");
      const source = inspector(page).locator("[data-knowledge-source]");
      await expect(source).toHaveCount(1);
      await expect(source.locator('[data-knowledge-check="changed"]')).toBeVisible();
      await expect(source.locator("pre")).toContainText(PINS_CLAIM.cited);
    });

    await test.step("Concepts keeps the selection, and Find narrows it by an alias", async () => {
      await pressKey(tab(page, "graph"), "ArrowRight");
      await expect.poll(() => focusInBrowser(page)).toBe("tab:concepts");
      await expect(tab(page, "concepts")).toHaveAttribute("aria-selected", "true");
      const rows = browser(page).locator('[data-knowledge-list="concepts"] [data-knowledge-row]');
      await expect(rows).toHaveCount(9);
      await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", `claim:${k.pins}`);
      await focusOn(browser(page).locator("[data-knowledge-find]"));
      await typeInto(browser(page).locator("[data-knowledge-find]"), "retries");
      await expect(rows).toHaveCount(1);
      await expect(row(page, k.retry)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(browser(page).locator("[data-knowledge-find]")).toHaveValue("");
      await expect(rows).toHaveCount(9);
    });

    await test.step("Findings shows each finding's standing, and filters for rechecking and for differing evidence", async () => {
      await pressKey(tab(page, "concepts"), "ArrowRight");
      await expect(tab(page, "findings")).toHaveAttribute("aria-selected", "true");
      const rows = browser(page).locator('[data-knowledge-list="findings"] [data-knowledge-row]');
      await expect(rows).toHaveCount(4);
      await expect(row(page, k.pins)).toHaveAttribute("data-knowledge-standing", "recheck");
      await expect(row(page, k.keeps)).toHaveAttribute("data-knowledge-standing", "checked");
      await expect(row(page, k.returns)).toHaveAttribute("data-knowledge-standing", "differing");
      await expect(row(page, k.retains)).toHaveAttribute("data-knowledge-standing", "unchecked");
      const filter = browser(page).locator("[data-knowledge-filter]");
      await filter.selectOption("recheck");
      await expect(rows).toHaveCount(1);
      await expect(row(page, k.pins)).toBeVisible();
      await filter.selectOption("differing");
      await expect(rows).toHaveCount(1);
      await expect(row(page, k.returns)).toBeVisible();
      await filter.selectOption("all");
      await expect(rows).toHaveCount(4);
    });

    await test.step("the inspector's History and Used in read a revised finding's revisions and its declared use", async () => {
      await focusOn(
        browser(page).locator(
          '[data-knowledge-list="findings"] [data-knowledge-row][tabindex="0"]',
        ),
      );
      for (let i = 0; i < 4 && (await focusInBrowser(page)) !== `row:${k.retains}`; i++) {
        await page.keyboard.press("ArrowDown");
      }
      await expect.poll(() => focusInBrowser(page)).toBe(`row:${k.retains}`);
      await page.keyboard.press("Enter");
      await expect.poll(() => focusInBrowser(page)).toBe("section:overview");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focusInBrowser(page)).toBe("section:history");
      await expect(inspector(page).locator("[data-knowledge-revision]")).toHaveCount(2);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => focusInBrowser(page)).toBe("section:used");
      const use = inspector(page).locator("[data-knowledge-use]");
      await expect(use).toHaveCount(1);
      await expect(use).toContainText(k.taskKey);
      // The task that used it is a link to that task (FI3-1271): a rest opens its summary.
      const key = taskKeyLinks(use);
      await expect(key).toHaveText([k.taskKey]);
      await restOnTaskKey(page, key);
      await expect(rowSummary(page).locator("[data-crew-summary-key]")).toHaveText(k.taskKey);
      await page.mouse.move(4, 400);
      await expect(rowSummary(page)).toHaveCount(0);
      await focusOn(section(page, "used"));
    });

    await test.step("Esc goes back to the list, clears Find, then hides the browser; browsing wrote no knowledge and filed no task", async () => {
      await page.keyboard.press("Escape");
      await expect.poll(() => focusInBrowser(page)).toBe(`row:${k.retains}`);
      await focusOn(browser(page).locator("[data-knowledge-find]"));
      await typeInto(browser(page).locator("[data-knowledge-find]"), "evidence");
      await page.keyboard.press("Escape");
      await expect(browser(page).locator("[data-knowledge-find]")).toHaveValue("");
      await expect(browsersOnStage(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(browsersOnStage(page)).toHaveCount(0);
      expect(await taskCount(page)).toBe(tasksBefore);
    });
  } finally {
    await app.close();
  }
  expect(knowledgeRows(userDataDir)).toEqual(rowsBefore);
});

test("the graph orbits like a game camera with either button, a drag never selects, and the wheel zooms only while the graph has focus", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-camera-");
  const k = await seedKnowledge(userDataDir);
  const { app, page } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    await expect(knowledgePanel(page)).toBeAttached({ timeout: 30_000 });
    // The header's Open Knowledge, which shows in its collapsed header too.
    await knowledgePanel(page).locator('[data-panel-header-button="open"] button').click();
    await expect(browserCard(page)).toBeVisible();
    await expect(concept(page, k.evidence)).toBeVisible();

    await clickConcept(page, k.evidence);
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.evidence);
    const ids = [
      k.evidence,
      k.versions,
      k.retry,
      k.identity,
      k.delivery,
      k.failures,
      k.lifecycle,
      k.reuse,
    ];
    const before = await places(page, ids);
    const [farthest] = Object.entries(before).sort((a, b) => b[1].depth - a[1].depth)[0] ?? [];

    // A rightward drag with the left button turns the camera right, keeps
    // the selection, and the context menu stays shut over the graph.
    const left = await dragGraph(page, 70, 0, 0);
    expect(left.contextMenuSuppressed).toBe(true);
    const afterLeft = await camera(page);
    expect(afterLeft.pitch).toBeCloseTo(HOME.pitch, 5);
    expect((await drawnAt(page, farthest as string)).x).toBeLessThan(
      before[farthest as string]?.x ?? 0,
    );
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.evidence);

    // The right button orbits the same way.
    await graph(page).press("Home");
    await expect.poll(() => camera(page)).toEqual(HOME);
    await dragGraph(page, 70, 0, 2);
    expect((await camera(page)).yaw).toBeCloseTo(afterLeft.yaw, 5);

    // A drag that starts on a concept orbits; it never selects that concept.
    await graph(page).press("Home");
    // One a press can land on: the status line under the graph can cover
    // a concept drawn at its foot, where no pointer reaches it either.
    const pressable = await graph(page).evaluate((svg, ids) => {
      const box = svg.getBoundingClientRect();
      for (const id of ids) {
        const node = svg.querySelector(`[data-knowledge-node="${id}"]`);
        const x = Number(node?.getAttribute("data-x"));
        const y = Number(node?.getAttribute("data-y"));
        const hit = svg.ownerDocument.elementFromPoint(box.left + x, box.top + y);
        if (node && id !== ids[0] && hit && node.contains(hit)) return { id, x, y };
      }
      return null;
    }, ids);
    if (!pressable) throw new Error("No concept is drawn where a press can reach it");
    await dragGraph(page, -60, 30, 0, { x: pressable.x, y: pressable.y });
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.evidence);
    await expect(concept(page, pressable.id)).not.toHaveAttribute("aria-selected", "true");
    const tilted = await camera(page);
    expect(tilted.yaw).toBeGreaterThan(HOME.yaw);
    expect(tilted.pitch).toBeGreaterThan(HOME.pitch);

    // The wheel zooms while the graph has focus, never takes the window's
    // own zoom, and before the graph has focus it scrolls the card as ever.
    await graph(page).press("Home");
    expect(await wheelOnGraph(page, -100)).toEqual({ taken: true });
    await expect.poll(async () => (await camera(page)).zoom).toBe(1.1);
    expect(await wheelOnGraph(page, 100)).toEqual({ taken: true });
    await expect.poll(async () => (await camera(page)).zoom).toBe(1);
    expect(await wheelOnGraph(page, -100, { ctrlKey: true })).toEqual({ taken: false });
    expect(await wheelOnGraph(page, -100, { metaKey: true })).toEqual({ taken: false });
    await focusOn(browser(page).locator("[data-knowledge-find]"));
    expect(await wheelOnGraph(page, -100)).toEqual({ taken: false });
    expect((await camera(page)).zoom).toBe(1);
    // Outside the graph the context menu is the page's own.
    const elsewhere = await browser(page).evaluate((root) => {
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      root.dispatchEvent(menu);
      return menu.defaultPrevented;
    });
    expect(elsewhere).toBe(false);
  } finally {
    await app.close();
  }
});

test("the panel’s Graph link opens the graph, the browser keeps its place while it pages, a narrow card shows detail with Back, and Hide starts it fresh", async () => {
  const userDataDir = scratchDir("infinitary-knowledge-place-");
  const k = await seedKnowledge(userDataDir);
  const { app, page } = await launchApp({ userDataDir, withMockProvider: true });
  try {
    // Room for a wide card beside both docks.
    await resizeWindow(app, page, { width: 1600, height: 1000 });
    await expect(knowledgePanel(page)).toBeAttached({ timeout: 30_000 });
    await knowledgePanel(page).getByRole("button", { name: "Expand Knowledge" }).click();
    await pressKnowledgeGraph(page);
    await expect(browserCard(page)).toBeVisible();
    await expect(browser(page)).toHaveAttribute("data-knowledge-scope", "captain");
    await expect(concept(page, k.website)).toBeVisible();
    await expect(concept(page, k.evidence)).toBeVisible();

    // A project with no directions remains a readable empty filter.
    await filterDirections(page, WEBSITE.id);
    await expect(browser(page).locator('[data-knowledge-list="directions"]')).toBeVisible();
    await expect(browser(page).locator("[data-knowledge-row]")).toHaveCount(0);

    // The captain's Findings, the recheck filter and a finding selected.
    await filterDirections(page, "all");
    await pressIn(tab(page, "findings"));
    await browser(page).locator("[data-knowledge-filter]").selectOption("recheck");
    await pressIn(row(page, k.pins));
    await pressIn(section(page, "evidence"));
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.pins);

    // Another card comes to the front, and paging back finds the browser as it was.
    await runFromSearch(app, page, "panel:now/board");
    await expect(browserCard(page)).toHaveCount(0);
    for (let i = 0; i < 6 && (await browserCard(page).count()) === 0; i++) {
      await pressWindowKey(app, "]", ["meta", "shift"]);
      await page.waitForTimeout(150);
    }
    await expect(browserCard(page)).toBeVisible();
    await expect(browser(page)).toHaveAttribute("data-knowledge-scope", "captain");
    await expect(tab(page, "findings")).toHaveAttribute("aria-selected", "true");
    await expect(browser(page).locator("[data-knowledge-filter]")).toHaveValue("recheck");
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.pins);
    await expect(section(page, "evidence")).toHaveAttribute("aria-selected", "true");

    // A narrow card: the inspector takes the pane's place, with Back.
    await dragCardTo(page, 600);
    await expect(browser(page)).toHaveAttribute("data-narrow", "");
    await expect(browser(page).locator("[data-knowledge-aside]")).toHaveCount(0);
    // The drag left the window's focus on the card's edge: the keyboard comes back into the page.
    await focusOn(frameIn(browserCard(page)));
    await pressKey(row(page, k.pins), "Enter");
    await expect(browser(page).locator("[data-knowledge-pane]")).toHaveCount(0);
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", k.pins);
    await expect.poll(() => focusInBrowser(page)).toBe("section:evidence");
    await page.keyboard.press("Escape");
    await expect(browser(page).locator("[data-knowledge-pane]")).toHaveCount(1);
    await expect(browsersOnStage(page)).toHaveCount(1);

    // Hide lets the place go: the next browser starts on the first
    // collection with an entry, its Graph and the neutral camera.
    await page
      .locator(`${SHOWN_ENTRY} [data-panel-card-chrome]`)
      .getByRole("button", { name: "Hide", exact: true })
      .click();
    await expect(browsersOnStage(page)).toHaveCount(0);
    await runFromSearch(app, page, OPEN_KNOWLEDGE);
    await expect(browser(page)).toHaveAttribute("data-knowledge-scope", "captain");
    await expect(tab(page, "graph")).toHaveAttribute("aria-selected", "true");
    expect(await camera(page)).toEqual(HOME);
    await expect(inspector(page)).toHaveAttribute("data-knowledge-inspector", "");
  } finally {
    await app.close();
  }
});
