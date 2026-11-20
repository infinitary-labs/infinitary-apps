import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import {
  ANSWER_MISSING_ENDED_OPENING,
  ANSWER_MISSING_OPENING,
} from "../../src/core/orchestrator/captainWakes";
import { personalPanelRemovedLine } from "../../src/core/personal/panelLines";
import { mountLine } from "../../src/core/personal/panelMounts";
import { MANAGED_FILES } from "../../src/core/personal/workspace";
import { PANEL_STOPPED_LINE } from "../../src/renderer/src/personal/panelBoundaryWords";
import { PROJECT_ROW_WORDS } from "../../src/renderer/src/settings/projectsWords";
import { DEFAULT_PERSONAL_PLACEMENT } from "../../src/shared/personal/manifest";
import { AUTONOMY_SWITCH_NAME, AUTONOMY_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import {
  MOCK_PANEL_ID,
  MOCK_PANEL_NOTE_TITLE,
  MOCK_PANEL_REPORT,
  MOCK_PANEL_REVISED_REPORT,
  MOCK_PANEL_TITLE,
} from "./crewScripts";
import { panelBody, readFrameNow } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { type MockProviderServer, startMockProvider } from "./mockProvider";
import { openProject, projectLine } from "./projects";
import { promptInput } from "./prompt";
import { expandDock, feedLine, reportLine, statusLine, taskKey } from "./rails";
import { readSavedData } from "./savedData";
import { oneNewSavePoint, savePointCount } from "./savePoints";
import { panelPlaceHeld } from "./scenarios/panelPlaceHeld";
import {
  PERSONAL_CHANGE_PROMPT_MARKER,
  personalPanelChange,
} from "./scenarios/personalPanelChange";
import {
  PERSONAL_PANEL_PROMPT_MARKER,
  PERSONAL_REMOVE_PROMPT_MARKER,
  personalPanels,
} from "./scenarios/personalPanels";
import { clickInBody } from "./stack";
import { setThemeViaSettings } from "./theme";

/**
 * The personal extension host, end to end (talk-to-personalize Step 2,
 * docs/ui-plugins.md "Personal extensions"): the built app boots against a
 * userData whose personal workspace already holds the three fixture
 * extensions under tests/fixtures/personal/, and the spec drives them the
 * way a crewmate and the captain would - through the store, a server
 * action, and a file saved on disk.
 */
type Snapshot = Awaited<ReturnType<Window["firstmate"]["plugins"]["personal"]["list"]>>;

/** The line tests/fixtures/personal/shaky/panel.tsx draws, and the one the spec saves over it. */
const SHAKY_LINE = "steady as she goes";
const SHAKY_REVISED_LINE = "steadier still";

test.describe("the personal extension host (Step 2)", () => {
  let launched: LaunchedApp;
  let workspace: string;

  function snapshot(): Promise<Snapshot> {
    return launched.page.evaluate(() => window.infinitary.plugins.personal.list());
  }

  test.beforeAll(async () => {
    const userDataDir = scratchDir("infinitary-e2e-personal-");
    workspace = join(userDataDir, "fleet", "personal");
    mkdirSync(workspace, { recursive: true });
    cpSync(join(process.cwd(), "tests", "fixtures", "personal"), workspace, { recursive: true });
    launched = await launchApp({ userDataDir });
    await expect
      .poll(async () => (await snapshot()).extensions.map((e) => e.id), { timeout: 30_000 })
      .toEqual(["bad", "open-items", "shaky"]);
  });

  test.afterAll(async () => {
    await launched.close();
  });

  test("seeds every file the app manages with the very text the app was built from", () => {
    // Read from what the built bundle wrote, not from the source: a build step
    // that edits a string (electron-vite's CommonJS shim, docs/architecture.md
    // section 10) breaks the workspace's types and shows up nowhere else.
    for (const file of MANAGED_FILES) {
      expect(readFileSync(join(workspace, file.path), "utf8"), file.path).toBe(file.content);
    }
  });

  test("a fixture renders on the rail from the app's own components while its presence source holds data, and disappears when it is empty", async () => {
    const { page } = launched;
    const panel = page.locator('[data-side-panel="open-items"]');
    // Its body draws in a frame of its own (INF-2205 piece C).
    const body = panelBody(page, "open-items");
    await expect(panel).toHaveCount(0);

    const filled = await page.evaluate(() =>
      window.infinitary.plugins.invoke("open-items", "fill", ["alpha", "beta", "gamma"]),
    );
    expect(filled).toEqual({ ok: true, result: { filled: 3, host: "string" } });

    await expect(panel).toBeVisible();
    await expect(panel.locator("header")).toContainText("Open items");
    await expect(panel.locator("[data-side-panel-attribution]")).toHaveText("yours");
    await expect(body.locator("[data-fixture-item]")).toHaveCount(3);
    await expect(body.getByText("3 open")).toBeVisible();
    // It sits in the right rail, docked at a real width beside the stage.
    await expect(page.locator('[data-rail="right"] [data-side-panel="open-items"]')).toHaveCount(1);

    // The panel's own button calls its server action; the store change hides it.
    await clickInBody(body.locator("[data-fixture-clear]"));
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () => (await snapshot()).extensions.find((e) => e.id === "open-items")?.present)
      .toBe(false);
  });

  test("a thrown render shows the quiet line and the rail stays; saving the file on disk reloads it", async () => {
    const { page } = launched;
    const panel = page.locator('[data-side-panel="shaky"]');
    // Its body, and the quiet line its boundary draws, are in its own frame.
    const body = panelBody(page, "shaky");
    await expect(panel).toBeVisible();
    await expect(body.locator("[data-fixture]")).toHaveText(SHAKY_LINE);
    await expect(body.locator("[data-fixture]")).toHaveAttribute("data-fixture-theme", "dark");
    await expect(panel.locator("[data-side-panel-running]")).toHaveCount(0);

    await page.evaluate(() =>
      window.infinitary.plugins.db.request({
        op: "set",
        extensionId: "shaky",
        key: "explode",
        value: true,
      }),
    );
    await expect(body.locator("[data-personal-stopped]")).toHaveText(PANEL_STOPPED_LINE);
    await expect(panel.locator("header")).toContainText("Shaky");
    // The chrome and the rail stay (Activity docks there by default too).
    await expect(page.locator('[data-rail="left"] [data-side-panel="shaky"]')).toHaveCount(1);
    await expect(page.locator('[data-rail="left"] [data-side-panel="activity"]')).toHaveCount(1);

    // The crewmate fixes forward: a save is a new version, and the boundary resets.
    const source = join(workspace, "shaky", "panel.tsx");
    writeFileSync(
      source,
      readFileSync(source, "utf8")
        .replace('if (explode) throw new Error("shaky panel asked to fail");', "")
        .replace(SHAKY_LINE, SHAKY_REVISED_LINE),
    );
    await expect(body.locator("[data-fixture]")).toHaveText(SHAKY_REVISED_LINE, {
      timeout: 15_000,
    });
    await expect(body.locator("[data-personal-stopped]")).toHaveCount(0);
  });
});

/**
 * The build loop, end to end (talk-to-personalize Step 4, report section 7
 * Step 4 row): through the mock provider, an ask becomes a panel. The mock
 * Firstmate spawns with personal_ui; the mock crewmate writes the
 * extension with Pi's own write tool, lints, captures, and reports; the
 * host stamps the task onto the manifest (the running dot) and commits the
 * workspace with the report as the message. The crewmate's answering note
 * shows the result, and the report reaches the first mate, which closes
 * the task as finished (INF-1677). The build runs apart from the rails
 * (docs/personal-panels.md, "Built apart"): the crewmate's version is drawn
 * out of sight, where its capture photographs it, and the rail takes it at
 * the report. The panel persists across a relaunch, a second ask is a
 * second commit on the same directory that the rail takes only at its
 * report, and "remove it" is the host removing and committing.
 * Screenshots in both themes ride along.
 */
type TaskRow = {
  id: string;
  key: string;
  status: string;
  closed_reason: string | null;
  worktree_dir: string;
  branch: string;
  repo_dir: string;
  outcome: string | null;
};

function readTasks(userDataDir: string): TaskRow[] {
  return readSavedData(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT id, key, status, closed_reason, worktree_dir, branch, repo_dir, outcome FROM tasks WHERE kind = 'work' ORDER BY created_at",
        )
        .all() as TaskRow[],
  );
}

/**
 * What the host's commit at the end of a live turn left on the task's
 * timeline (`commitLiveTurn`): the commit it made, or git's own words for
 * why it made none. A failed commit keeps the task open and its panel off
 * the rail, so a journey reads this first to say why in git's words.
 */
function turnCommit(
  userDataDir: string,
  taskId: string,
): { commit: string } | { commitFailed: string } | null {
  const notes = readSavedData(
    userDataDir,
    (db) =>
      db
        .prepare(
          "SELECT data_json FROM task_events WHERE task_id = ? AND kind = 'note' ORDER BY at, id",
        )
        .all(taskId) as { data_json: string | null }[],
  );
  for (const { data_json } of notes) {
    const data = JSON.parse(data_json ?? "{}") as { commit?: string; commitFailed?: string };
    if (typeof data.commitFailed === "string") return { commitFailed: data.commitFailed };
    if (typeof data.commit === "string") return { commit: data.commit };
  }
  return null;
}

/** The turn's commit note on the task with this key, once the host has written it. */
async function awaitTurnCommit(
  userDataDir: string,
  key: string,
): Promise<ReturnType<typeof turnCommit>> {
  const read = () => {
    const task = readTasks(userDataDir).find((row) => row.key === key);
    return task ? turnCommit(userDataDir, task.id) : null;
  };
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull();
  return read();
}

/**
 * A panel build's ordinary ending (INF-1677): its crewmate's one answering
 * note, with no actions, stays after the task closes; putting it away as
 * read acknowledges the already-completed build's message without ending
 * work (INF-1879). No answer retry ever reaches the first mate.
 */
async function acceptNote(page: Page, mockProvider: MockProviderServer): Promise<void> {
  const notes = () =>
    page.evaluate(() =>
      window.infinitary.cards
        .list()
        .then((cards) =>
          cards.map(({ id, title, actions, answering }) => ({ id, title, actions, answering })),
        ),
    );
  await expect
    .poll(notes)
    .toEqual([
      { id: expect.any(String), title: MOCK_PANEL_NOTE_TITLE, actions: [], answering: true },
    ]);
  const [note] = await notes();
  await page.evaluate((id) => window.infinitary.cards.noteDone(id), note?.id ?? "");
  await expect.poll(notes).toEqual([]);
  const answerRetrySent = mockProvider
    .requestBodies()
    .some(
      (body) =>
        body.includes(ANSWER_MISSING_OPENING) || body.includes(ANSWER_MISSING_ENDED_OPENING),
    );
  expect(answerRetrySent).toBe(false);
  console.log(
    JSON.stringify({
      intent: "INF-1879 completed workspace answer acknowledgement",
      readNote: note?.id,
      remainingCards: await notes(),
      answerRetrySent,
    }),
  );
}

/** A PNG's width and height from its IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Mean luminance, and the share of pixels that are not the corner color. */
function pngPaint(file: string): { lum: number; contrast: number } {
  const bytes = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels, `png color type ${colorType}`).toBeGreaterThan(0);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src] ?? 0;
    src += 1;
    const row = Buffer.from(raw.subarray(src, src + stride));
    src += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (row[i - channels] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= channels ? (prev[i - channels] ?? 0) : 0;
      const value = row[i] ?? 0;
      if (filter === 1) row[i] = (value + left) & 255;
      else if (filter === 2) row[i] = (value + up) & 255;
      else if (filter === 3) row[i] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        // biome-ignore lint/plugin/e2e-measured-box: PNG Paeth decoding compares byte values, not layout gaps.
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[i] = (value + pr) & 255;
      } else row[i] = value;
    }
    row.copy(pixels, y * stride);
    prev = row;
  }
  const count = width * height;
  const bgR = pixels[0] ?? 0;
  const bgG = pixels[1] ?? 0;
  const bgB = pixels[2] ?? 0;
  let lumSum = 0;
  let contrast = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    lumSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 48) contrast += 1;
  }
  return { lum: lumSum / count, contrast: contrast / count };
}

/**
 * Records, in order, every distinct state of a panel on its rail and of its
 * draft out of sight - whether each is drawn, its mock rows, and the
 * running dot - so a journey can say what the rail drew while a build went
 * on, as an order rather than a moment. Each body draws in a frame of its
 * own (INF-2205 piece C), which the window's script cannot read, so the
 * journey reads the rail, the draft and their bodies itself, one state
 * after another, until `buildStates` asks.
 */
const builds = new WeakMap<Page, { states: string[]; stop: () => Promise<void> }>();

async function panelState(page: Page, chrome: string): Promise<string> {
  // One look, never a wait: a sample that waits for a frame misses a draft
  // that lives only while its capture runs.
  const holder = await page.$(chrome);
  if (!holder) return "none";
  const rows = await readFrameNow(
    holder,
    () => document.querySelector("[data-mock-rows]")?.getAttribute("data-mock-rows") ?? "-",
    "-",
  );
  const running = (await holder.$("[data-side-panel-running]")) !== null;
  return `rows=${rows}${running ? " running" : ""}`;
}

async function watchBuild(page: Page, id: string): Promise<void> {
  await builds.get(page)?.stop();
  const states: string[] = [];
  let stopped = false;
  const record = async () => {
    const rail = await panelState(page, `[data-rail] [data-side-panel="${id}"]`);
    const draft = await panelState(page, `[data-panel-draft="${id}"] [data-side-panel]`);
    const now = `rail ${rail} | draft ${draft}`;
    if (states[states.length - 1] !== now) states.push(now);
  };
  await record();
  const loop = (async () => {
    while (!stopped) await record().catch(() => undefined);
  })();
  builds.set(page, {
    states,
    stop: async () => {
      stopped = true;
      await loop;
    },
  });
}

/** The states recorded so far, while the recorder goes on. */
function seenStates(page: Page): string[] {
  return [...(builds.get(page)?.states ?? [])];
}

async function buildStates(page: Page): Promise<string[]> {
  const build = builds.get(page);
  if (!build) return [];
  await build.stop();
  builds.delete(page);
  return build.states;
}

/** Where, in the recorded order, the draft was last drawn: -1 when it never was. */
function lastDrafted(states: readonly string[]): number {
  return states.map((state) => !state.endsWith("draft none")).lastIndexOf(true);
}

type FlashSample = { theme: string; bg: string; lum: number };

/**
 * Records every distinct body background while a panel is built. The e2e
 * window stays hidden, so this is the page's own painted background (the
 * surface a shown window would flash), sampled from a mutation observer
 * plus a timer rather than an OS screen recording.
 */
async function watchPageBackground(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as Window & { __fmFlash?: FlashSample[] };
    target.__fmFlash = [];
    const record = () => {
      const theme = document.body?.dataset.theme ?? "";
      const bg = getComputedStyle(document.body).backgroundColor;
      const nums = bg.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      const lum =
        (0.2126 * (nums[0] ?? 0) + 0.7152 * (nums[1] ?? 0) + 0.0722 * (nums[2] ?? 0)) / 255;
      const samples = target.__fmFlash ?? [];
      const last = samples[samples.length - 1];
      if (!last || last.theme !== theme || Math.abs(last.lum - lum) > 0.02) {
        samples.push({ theme, bg, lum });
      }
    };
    record();
    new MutationObserver(record).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    window.setInterval(record, 32);
  });
}

async function pageBackgroundSamples(
  page: import("@playwright/test").Page,
): Promise<FlashSample[]> {
  return page.evaluate(() => {
    const target = window as Window & { __fmFlash?: FlashSample[] };
    return target.__fmFlash ?? [];
  });
}

test.describe("the build loop: an ask becomes a panel (Step 4)", () => {
  let mockProvider: MockProviderServer;
  /** The personal workspace's repo id, for the Projects row locator. */
  const repoId = (dir: string): string =>
    readSavedData(dir, (db) => (db.prepare("SELECT id FROM repos").get() as { id: string }).id);
  let live: LaunchedApp;
  let userDataDir: string;
  let workspace: string;

  const panel = () => live.page.locator(`[data-side-panel="${MOCK_PANEL_ID}"]`);
  /** The panel's body, drawn in its own frame (INF-2205 piece C). */
  const body = () => panelBody(live.page, MOCK_PANEL_ID);
  const ask = async (text: string) => {
    const input = promptInput(live.page);
    await input.click();
    await input.fill(text);
    await input.press("Enter");
  };
  /**
   * Lets the crewmate's held place go (`scenarios/panelPlaceHeld.ts`) once
   * the recorder has read `drafted`, the draft drawn out of sight beside
   * what the rail had: the draft stays until the place, so the journey reads
   * it as an order and never samples past it.
   */
  const placeOnceDrafted = async (page: Page, drafted: string) => {
    await expect.poll(() => mockProvider.heldThreadAnswers(), { timeout: 45_000 }).toBe(1);
    await expect.poll(() => seenStates(page), { timeout: 30_000 }).toContain(drafted);
    mockProvider.releaseThreadAnswer();
  };

  test.beforeAll(async () => {
    mockProvider = await startMockProvider({
      scenarios: [personalPanelChange, personalPanels, panelPlaceHeld],
    });
    live = await launchApp({ reuseMockProvider: mockProvider });
    userDataDir = live.userDataDir;
    workspace = join(userDataDir, "fleet", "personal");
  });

  test.afterAll(async () => {
    await live.close();
    await mockProvider.close();
  });

  test("an ask becomes a panel, persists, reads in both themes, takes a follow-up and is removed", async () => {
    // One story, so one test: each step starts where the last one left the
    // panel. The budget is the six one-minute tests these steps replace.
    test.setTimeout(6 * 60_000);
    let panelTaskId = "";
    /** The first build's capture, of its regular rows, for the follow-up's to compare with. */
    let regularCaptureHeight = 0;
    await test.step("an ask builds the panel out of sight, the crewmate places it on the rail and photographs it there, the report commits it, and the task closes done", async () => {
      const { page } = live;
      const before = savePointCount(workspace);
      await watchPageBackground(page);
      await watchBuild(page, MOCK_PANEL_ID);
      await ask(`${PERSONAL_PANEL_PROMPT_MARKER} ${MOCK_PANEL_TITLE}`);
      // Mount the Activity frame before the delayed report and close so both
      // lifecycle pushes are rendered before their assertions begin.
      await expandDock(page, "activity");
      await placeOnceDrafted(page, "rail none | draft rows=regular");

      // The panel is on its rail, on the app's own components.
      const key = await taskKey(page, MOCK_PANEL_TITLE);
      await expect(
        reportLine(page, key).filter({ hasText: reportSummary(MOCK_PANEL_REPORT) }),
      ).toBeVisible({ timeout: 45_000 });
      // The report's commit, or git's own words for why there is none.
      expect(await awaitTurnCommit(userDataDir, key)).toEqual({ commit: expect.any(String) });
      await expect(panel()).toBeVisible({ timeout: 30_000 });
      await expect(panel().locator("header")).toContainText(MOCK_PANEL_TITLE);
      await expect(panel().locator("[data-side-panel-attribution]")).toHaveText("yours");
      await expect(body().locator("[data-mock-rows='regular']")).toHaveCount(1);
      // It was built apart, then placed (docs/personal-panels.md, "Placed on
      // the rail"): drawn out of sight while the rail had nothing of it, then
      // on the captain's own rail with the running dot before the report, a
      // draft no more.
      const states = await buildStates(page);
      expect(states, states.join("\n")).toContain("rail none | draft rows=regular");
      expect(states, states.join("\n")).toContain("rail rows=regular running | draft none");
      expect(
        states.findIndex((state) => !state.startsWith("rail none")),
        states.join("\n"),
      ).toBeGreaterThan(lastDrafted(states));
      // The window's answer reached the crewmate: its place_panel heard the
      // panel drawn on its rail, in the words the core composes from it.
      const drawn = mountLine({
        id: MOCK_PANEL_ID,
        kind: "personal",
        version: null,
        state: "drawn",
        rail: DEFAULT_PERSONAL_PLACEMENT.x,
        why: null,
      });
      expect(
        mockProvider
          .requestBodies()
          .some((body) => body.includes(`The window says it is ${drawn}.`)),
      ).toBe(true);
      // The declared `feed.recent` read reaches the panel: the feed already
      // holds the spawn line, so the count is a real number, never a blank.
      await expect(body().getByText("Activity")).toBeVisible();
      await expect
        .poll(async () =>
          (await body().locator("[data-mock-panel] span").allInnerTexts()).some((text) =>
            /^[1-9]\d*$/.test(text.trim()),
          ),
        )
        .toBe(true);

      // The report is the feed line; the close is the record's own line.
      await expect(statusLine(page, key)).toBeVisible({ timeout: 30_000 });
      await expect(panel().locator("[data-side-panel-running]")).toHaveCount(0);
      await expect(page.locator("[data-panel-draft]")).toHaveCount(0);
      // The build already ended (INF-1677); its one answering note stays.
      // Reading it acknowledges the message, not a new task ending.
      await acceptNote(page, mockProvider);

      // The record: done, finished, on the personal repo, with no worktree.
      const tasks = readTasks(userDataDir);
      expect(tasks).toHaveLength(1);
      const task = tasks[0] as TaskRow;
      panelTaskId = task.id;
      expect(task).toMatchObject({
        status: "done",
        closed_reason: "finished",
        // The feed is capped, not the saved report.
        outcome: MOCK_PANEL_REPORT,
        worktree_dir: "",
        branch: "",
      });
      expect(task.repo_dir).toBe(workspace);

      // One save point holds the panel, named as the host's guard wants and
      // keeping the report whole, with nothing left unsaved. The subject it
      // makes of an untyped report is liveWorkspace.test.ts's.
      const built = await oneNewSavePoint(workspace, before);
      expect(built.paths).toContain(`${MOCK_PANEL_ID}/manifest.json`);
      expect(built.message).toContain(MOCK_PANEL_REPORT);
      const manifest = JSON.parse(
        readFileSync(join(workspace, MOCK_PANEL_ID, "manifest.json"), "utf8"),
      ) as { title: string; reads: string[]; origin?: { taskId?: string } };
      expect(manifest.title).toBe(MOCK_PANEL_TITLE);
      expect(manifest.reads).toEqual(["feed.recent"]);
      expect(manifest.origin?.taskId).toBe(task.id);

      // The last capture, of the panel placed on the rail, wrote both themes
      // under the task's own directory; the words the lint, the place and
      // the capture answer with are pluginLint.test.ts's and
      // personalExtensions.test.ts's.
      const paints: Record<string, { lum: number; contrast: number }> = {};
      for (const theme of ["dark", "light"]) {
        const file = join(
          userDataDir,
          "crewmates",
          task.id,
          "captures",
          `${MOCK_PANEL_ID}-${theme}.png`,
        );
        expect(existsSync(file), file).toBe(true);
        const size = pngSize(file);
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
        if (theme === "dark") regularCaptureHeight = size.height;
        paints[theme] = pngPaint(file);
        // A blank window of the theme color has no contrasting pixels. The
        // panel's own text and chrome have to be in the picture.
        expect(paints[theme]?.contrast ?? 0).toBeGreaterThan(0.005);
      }
      expect(paints.dark?.lum ?? 1).toBeLessThan(0.35);
      expect(paints.light?.lum ?? 0).toBeGreaterThan(0.6);
      // The captain's own theme was left alone by the captures, and the
      // window never passed through a light or blank frame while the panel
      // was built. Dark void (#05070d) sits near luminance 0.03; the light
      // theme (#eef1f7) and an unstyled white document sit above 0.5.
      expect(await page.evaluate(() => document.body.dataset.theme)).toBe("dark");
      const flash = await pageBackgroundSamples(page);
      const lightFrames = flash.filter((sample) => sample.theme === "light" || sample.lum > 0.5);
      expect(
        lightFrames,
        `page background while the panel was built: ${JSON.stringify(flash)}`,
      ).toEqual([]);

      // Settings -> Projects shows that workspace as what it is: one locked
      // row that reads "builds in place" (the captain's words, primitives/projects-and-working-copies.md)
      // instead of a delivery posture, an autonomy switch or a rigor tier.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Projects" }).click();
      const line = projectLine(page, repoId(userDataDir));
      await expect(line).toBeVisible();
      await expect(line.getByText(PROJECT_ROW_WORDS.personal).first()).toBeVisible();
      const row = await openProject(page, repoId(userDataDir));
      await expect(row.getByText(AUTONOMY_WORDS.putsInItself)).toBeVisible();
      await expect(row.getByRole("switch", { name: AUTONOMY_SWITCH_NAME })).toHaveCount(0);
      // Nothing on the row is writable: no posture pills, no autonomy
      // switch, no rigor pills.
      await expect(row.locator('input[type="radio"]')).toHaveCount(0);
      await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("projects-personal-row.png") });
      // Escape goes back to the list, then closes Settings.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await test.step("the panel persists across a relaunch, with no running dot", async () => {
      await live.close();
      live = await launchApp({ userDataDir, reuseMockProvider: mockProvider });
      await expect(panel()).toBeVisible({ timeout: 45_000 });
      await expect(panel().locator("[data-side-panel-running]")).toHaveCount(0);
      await expect
        .poll(async () =>
          live.page.evaluate(() =>
            window.infinitary.plugins.personal
              .list()
              .then((snapshot) => snapshot.extensions.map((e) => [e.id, e.present, e.running])),
          ),
        )
        .toEqual([[MOCK_PANEL_ID, true, false]]);
    });

    await test.step("reads as one surface in both themes", async () => {
      const testInfo = test.info();
      const { page } = live;
      await expect(panel()).toBeVisible();
      const dark = await panel().screenshot();
      await testInfo.attach(`${MOCK_PANEL_ID}-dark.png`, { body: dark, contentType: "image/png" });
      await setThemeViaSettings(page, "light");
      await expect.poll(() => page.evaluate(() => document.body.dataset.theme)).toBe("light");
      const light = await panel().screenshot();
      await testInfo.attach(`${MOCK_PANEL_ID}-light.png`, {
        body: light,
        contentType: "image/png",
      });
      await setThemeViaSettings(page, "dark");
      await expect.poll(() => page.evaluate(() => document.body.dataset.theme)).toBe("dark");
    });

    await test.step("a follow-up ask resolves to the same surface, is built apart, is placed on the rail, and is a second commit at its report", async () => {
      const { page } = live;
      const before = savePointCount(workspace);
      await watchBuild(page, MOCK_PANEL_ID);
      await ask(`${PERSONAL_CHANGE_PROMPT_MARKER}${MOCK_PANEL_ID}: make the rows smaller`);
      const key = await taskKey(page, `Change the ${MOCK_PANEL_ID} panel`);
      await placeOnceDrafted(page, "rail rows=regular running | draft rows=small");
      await expect(
        reportLine(page, key).filter({ hasText: reportSummary(MOCK_PANEL_REVISED_REPORT) }),
      ).toBeVisible({ timeout: 45_000 });
      // The report's commit, or git's own words for why there is none.
      expect(await awaitTurnCommit(userDataDir, key)).toEqual({ commit: expect.any(String) });
      await expect(body().locator("[data-mock-rows='small']")).toHaveCount(1, { timeout: 30_000 });
      // While the change was built the rail kept the panel as it was, with
      // the running dot, and drew the smaller rows once the crewmate placed
      // them, before the report, a draft no more.
      const states = await buildStates(page);
      expect(states, states.join("\n")).toContain("rail rows=regular running | draft rows=small");
      expect(states, states.join("\n")).toContain("rail rows=small running | draft none");
      expect(
        states.findIndex((state) => state.startsWith("rail rows=small")),
        states.join("\n"),
      ).toBeGreaterThan(lastDrafted(states));
      // The close follows the commit.
      await expect(statusLine(page, key)).toBeVisible({ timeout: 30_000 });
      const revisedTask = readTasks(userDataDir).find((task) => task.key === key) as TaskRow;
      // Its last capture photographed the version it placed on the rail:
      // smaller rows make a shorter picture than the first build's.
      const changed = pngSize(
        join(userDataDir, "crewmates", revisedTask.id, "captures", `${MOCK_PANEL_ID}-dark.png`),
      );
      expect(changed.height).toBeLessThan(regularCaptureHeight);
      const revised = await oneNewSavePoint(workspace, before);
      expect(revised.paths.some((path) => path.startsWith(`${MOCK_PANEL_ID}/`))).toBe(true);
      expect(revised.message).toContain(MOCK_PANEL_REVISED_REPORT);
      await expect
        .poll(() => readTasks(userDataDir).map((task) => task.status))
        .toEqual(["done", "done"]);
      const tasks = readTasks(userDataDir);
      expect(tasks[1]?.id).not.toBe(panelTaskId);
      const manifest = JSON.parse(
        readFileSync(join(workspace, MOCK_PANEL_ID, "manifest.json"), "utf8"),
      ) as { origin?: { taskId?: string } };
      expect(manifest.origin?.taskId).toBe(tasks[1]?.id);
      await expect(panel().locator("[data-side-panel-running]")).toHaveCount(0);
      await expect(page.locator("[data-panel-draft]")).toHaveCount(0);
      await acceptNote(page, mockProvider);
    });

    await test.step("remove it: the host takes the panel off the rails and commits the removal", async () => {
      const { page } = live;
      const before = savePointCount(workspace);
      await ask(`${PERSONAL_REMOVE_PROMPT_MARKER}${MOCK_PANEL_ID}`);
      await expect(panel()).toHaveCount(0, { timeout: 30_000 });
      await expect(feedLine(page, personalPanelRemovedLine(MOCK_PANEL_TITLE))).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => existsSync(join(workspace, MOCK_PANEL_ID))).toBe(false);
      // One save point removes the panel's files, so git keeps them one
      // revert away; its words are personalExtensions.test.ts's.
      const removed = await oneNewSavePoint(workspace, before);
      expect(removed.paths).toContain(`${MOCK_PANEL_ID}/panel.tsx`);
      expect(await page.evaluate(() => window.infinitary.cards.list())).toEqual([]);
    });
  });
});
