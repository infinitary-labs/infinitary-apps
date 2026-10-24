import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { BROWSER_COMMAND } from "../../src/core/browser/commandWords";
import { REF_FROM_BEFORE_HANDBACK, REF_FROM_EARLIER_PAGE } from "../../src/core/browser/outline";
import { BROWSER_RETURNED_OPENING } from "../../src/core/orchestrator/wakes";
import { MAXIMIZE_LABEL, RESTORE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { CREWMATE_TAB_LABEL } from "../../src/shared/crewTranscript";
import { HERE } from "../../src/shared/deviceNames";
import {
  BROWSER_DOOR_LABEL,
  browserTabLabel,
  DRIVER_WORDS,
  FRESH_LOOK_WORDS,
  INFO_TAB_LABEL,
  RETURN_CONTROL_LABEL,
  RETURN_CONTROL_NOTICE,
  RETURNED_CAPTION,
  rememberSignInLabel,
  SIGN_IN_MYSELF_LABEL,
  savedCaption,
  savedSignInLabel,
  TAKE_CONTROL_LABEL,
  TASK_BROWSER_PAGE,
  VIEW_DRIVER_WORDS,
} from "../../src/shared/taskBrowser";
import { customApiCaFixture } from "../helpers/customApiCaFixture";
import { scratchDir } from "../helpers/scratchDirs";
import { crewmateView } from "./crewmateTab";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  MOCK_BROWSER_PICTURE,
  MOCK_BROWSER_REPORT_PREFIX,
  SPAWN_PROMPT_MARKER,
  TASK_BROWSER_PROMPT_MARKER,
} from "./mockProvider";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { expandDock, expectRecordBody, hideRecord, pressRow, recordCard, taskFact } from "./rails";
import {
  MOCK_BROWSER_BUTTON,
  MOCK_BROWSER_CARD_REPORT,
  MOCK_BROWSER_CARD_TITLE,
  MOCK_BROWSER_LONG_REPORT_PREFIX,
  MOCK_BROWSER_READING_PICTURE,
  MOCK_BROWSER_READING_REPORT_PREFIX,
  MOCK_BROWSER_WATCH_REPORT_PREFIX,
  MOCK_FENCE_A_REPORT,
  MOCK_FENCE_B_REPORT,
  MOCK_HANDOFF_ACTION,
  MOCK_HANDOFF_ASKED_REPORT,
  MOCK_HANDOFF_CARD_TITLE,
  MOCK_HANDOFF_REASON,
  MOCK_HANDOFF_RETURNED_REPORT,
  MOCK_PAGES_REPORT_PREFIX,
  MOCK_SAVED_ACTION,
  MOCK_SAVED_ASKED_REPORT,
  MOCK_SAVED_CARD_TITLE,
  MOCK_SAVED_REPORT_PREFIX,
  MOCK_SIGNED_IN_PICTURE,
  MOCK_SIGNED_IN_PICTURE_REASON,
  MOCK_TAKE_REFUSED_REPORT,
  MOCK_TAKE_RETURNED_REPORT,
  TASK_BROWSER_APPROVE_WORDS,
  TASK_BROWSER_CARD_MARKER,
  TASK_BROWSER_FENCE_MARKER,
  TASK_BROWSER_HANDOFF_MARKER,
  TASK_BROWSER_HANDOFF_READY_WORDS,
  TASK_BROWSER_LONG_LAST_WORDS,
  TASK_BROWSER_LONG_MARKER,
  TASK_BROWSER_PAGES_MARKER,
  TASK_BROWSER_READING_MARKER,
  TASK_BROWSER_READY_WORDS,
  TASK_BROWSER_SAVED_MARKER,
  TASK_BROWSER_TAKE_MARKER,
  TASK_BROWSER_WATCH_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  canvasReading,
  clickOnPage,
  closeSite,
  filesHolding,
  pageLaidOutAt,
  pageSays,
  stopTaskBrowsers,
  taskTabs,
  typeOnPage,
  browserView as view,
  windowCount,
} from "./taskBrowser";
import { setThemeViaSettings } from "./theme";
import { pressKey, runFromSearch, untilFocused } from "./windowKeys";

/**
 * A task's own browser (docs/task-browser.md). A project serves a sign-up
 * page on this Mac; the captain asks for it to be checked, and the
 * crewmate opens its task's browser there, types a name, clicks Send,
 * reloads, photographs the page and closes the browser. The page counts
 * only a real click (`isTrusted`), keeps the name in its own site data,
 * says whether it can reach the app, and asks for a logo from a public name
 * that leads to this Mac, one from a website over plain http, and data from
 * another server on this Mac, which the browser must all refuse - the first
 * at the connection itself, since its address names a public host.
 *
 * The crewmate is the mock provider's script (`taskBrowserStep`): it acts
 * only on refs the real outline gave it and reports what the real page
 * said, so the report is the page's own words passed through the product.
 */

const SIGN_UP_PAGE = `<!doctype html>
<html>
  <head><title>Sign up</title></head>
  <body>
    <h1>Sign up</h1>
    <p id="state"></p>
    <label>Name <input id="name"></label>
    <button id="send">Send</button>
    <p id="out"></p>
    <p id="reach"></p>
    <img src="https://rebind.example/logo.png" alt="">
    <img src="http://plain.example/logo.png" alt="">
    <script>
      const app = typeof window.infinitary !== "undefined" || typeof process !== "undefined";
      document.getElementById("reach").textContent = app ? "This page reaches the app" : "This page cannot reach the app";
      // The same server under another name is another origin the crewmate never opened.
      void fetch("http://localhost:" + location.port + "/api").catch(() => undefined);
      const saved = localStorage.getItem("name");
      document.getElementById("state").textContent = saved ? "Signed up as " + saved : "Not signed up yet";
      document.getElementById("send").addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        const name = document.getElementById("name").value;
        localStorage.setItem("name", name);
        document.getElementById("out").textContent = "Thanks, " + name;
      });
    </script>
  </body>
</html>`;

let launched: LaunchedApp;
let site: Server;
let siteUrl: string;

const READING_NOTES_TAIL = "anything stays secret in the notes";
const READING_FEED_TAIL = "feed ends with the atom tail";
const READING_PAGE = `<!doctype html>
<html>
  <head><title>Releases</title><style>pre { white-space: pre-wrap; word-break: break-all; }</style></head>
  <body>
    <h1 id="title">Releases</h1>
    <a id="rel" href="/reading/one">Firstmate 3000 0.2.1-alpha.52 (private alpha, alpha channel)</a>
    <p id="when"><time datetime="2026-10-08T21:52:52Z" title="Oct 8, 2026, 2:52 PM PDT">2 hours ago</time></p>
    <pre id="notes"></pre>
    <div id="pad" style="height: 2000px"></div>
    <script>
      document.getElementById("rel").addEventListener("click", (event) => {
        event.preventDefault();
        setTimeout(() => {
          history.pushState({}, "", "/reading/one");
          // The release's page leads with a link of its own, so an old ref
          // counted from the top would land on it.
          const back = document.createElement("a");
          back.href = "/reading";
          back.textContent = "Back to releases";
          document.body.prepend(back);
          document.title = "Firstmate 3000 0.2.1-alpha.52";
          document.getElementById("title").textContent = "Firstmate 3000 0.2.1-alpha.52";
          document.getElementById("notes").textContent = "${"a".repeat(2100)} ${READING_NOTES_TAIL}";
        }, 700);
      });
    </script>
  </body>
</html>`;
const READING_FEED = `${"b".repeat(2100)} ${READING_FEED_TAIL}`;

/**
 * A changelog too long for one answer: forty releases, each a region with
 * the same long paragraph, so the whole page is past one answer's bound
 * even with its repeats folded. Only the last release holds its own words.
 */
const LONG_PARAGRAPH =
  "Every release in this changelog ships the same reminder: back up your work, read the notes before you upgrade, and tell us what broke. The upgrade keeps your settings and your projects where they are, and nothing you saved moves.";
const LONG_PAGE = `<!doctype html>
<html>
  <head><title>Changelog</title></head>
  <body>
    <h1>Changelog</h1>
    <nav aria-label="Versions"><a href="#r1">Newest</a> <a href="#r40">Oldest</a></nav>
    <main>
      ${Array.from(
        { length: 40 },
        (_, index) => `<section id="r${index + 1}" aria-label="Release ${index + 1}">
        <h2>Release ${index + 1}</h2>
        <p>${LONG_PARAGRAPH}</p>
        <ul><li>Fixed item ${index + 1}a in the list of fixes</li><li>Fixed item ${index + 1}b in the list of fixes</li><li>Fixed item ${index + 1}c in the list of fixes</li></ul>
        <a href="/long/${index + 1}">Download release ${index + 1}</a>
        ${index === 39 ? `<p>And ${TASK_BROWSER_LONG_LAST_WORDS}.</p>` : ""}
      </section>`,
      ).join("\n")}
    </main>
  </body>
</html>`;

test.beforeAll(async () => {
  site = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/reading/feed") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(READING_FEED);
      return;
    }
    if (path === "/long") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(LONG_PAGE);
      return;
    }
    if (path === "/reading" || path === "/reading/one") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(READING_PAGE);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SIGN_UP_PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [taskBrowserJourneys],
    // A public name that leads to this Mac, as a rebinding name server would answer.
    env: { INFINITARY_TASK_BROWSER_HOSTS: JSON.stringify({ "rebind.example": ["127.0.0.1"] }) },
  });
});

test.afterAll(async () => {
  await launched.close();
  await closeSite(site);
});

/**
 * Whether a task's page fills its view: the size the page lays out at, as
 * its own document reads it, when it is the view's room and the picture the
 * view drew; otherwise all three, for the poll's message.
 */
async function pageFillsView(
  page: Page,
  app: ElectronApplication,
  taskId: string,
  pageUrl: string,
): Promise<string> {
  const room = await view(page, taskId)
    .locator("[data-browser-page]")
    .evaluate((node) => `${node.clientWidth}x${node.clientHeight}`);
  const laidOut = await pageLaidOutAt(app, pageUrl);
  const drawn = (await canvasReading(page)).size;
  return room === laidOut && laidOut === drawn ? laidOut : `${room} / ${laidOut} / ${drawn}`;
}

const SIZE = /^(\d+)x(\d+)$/;

/** Ask for one check, and wait for the crewmate's report on the task's record. */
async function check(name: string): Promise<TaskDetail> {
  const { page } = launched;
  const title = `${TASK_BROWSER_PROMPT_MARKER}${siteUrl} as ${name}`;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const detail = async (): Promise<TaskDetail | null> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return row ? window.infinitary.tasks.detail(row.id) : null;
    }, title);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
    .toContain(MOCK_BROWSER_REPORT_PREFIX);
  return (await detail()) as TaskDetail;
}

test("a crewmate checks a local page in its task's own browser, and the next task's starts empty", async () => {
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const before = await windowCount(launched.app);

  const first = await test.step("the crewmate uses the page with real input", async () => {
    const task = await check("Sam");
    // The page's own words, step by step: empty, then a real click's
    // answer, then the name kept in the browser's site data across a reload.
    expect(task.outcome).toContain(
      `"Not signed up yet" first, "Thanks, Sam" after Send and "Signed up as Sam" after a reload`,
    );
    // The page has no way into the app: no bridge, no Node.
    expect(task.outcome).toContain('"This page cannot reach the app"');
    // One logo's public name leads to this Mac, the other comes over plain
    // http, and the data is on a server the crewmate never opened: the
    // task's browser reaches none of them, the first refused by its
    // connection guard, since the address itself names a public host.
    expect(task.outcome).toContain(
      "It blocked rebind.example on a private network at the connection, plain.example over plain http,",
    );
    expect(task.outcome).toContain(`and localhost:${new URL(siteUrl).port} on this Mac.`);
    if (evidence)
      writeFileSync(join(evidence, "task-browser-change-answers.txt"), task.outcome ?? "");
    return task;
  });

  await test.step("its picture is in the task's evidence folder, at the check's size", async () => {
    const picture = join(
      launched.userDataDir,
      "crewmates",
      first.id,
      "evidence",
      `${MOCK_BROWSER_PICTURE}.png`,
    );
    expect(existsSync(picture)).toBe(true);
    const png = readFileSync(picture);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
      TASK_BROWSER_PAGE.width,
      TASK_BROWSER_PAGE.height,
    ]);
    if (evidence) {
      copyFileSync(picture, join(evidence, "task-browser-signed-up.png"));
      writeFileSync(join(evidence, "task-browser-first-report.txt"), `${first.outcome}\n`);
      // What the crewmate read, answer by answer: the product's own words.
      const served = (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
        body.includes(`${siteUrl} as Sam`),
      );
      const answers = providerMessages(served.at(-1) ?? "{}")
        .filter((message) => message.role === "tool")
        .map((message, index) => `--- answer ${index + 1}\n${message.text}`);
      writeFileSync(join(evidence, "task-browser-first-answers.txt"), `${answers.join("\n")}\n`);
    }
  });

  await test.step("closing the browser leaves no page behind", async () => {
    expect(await windowCount(launched.app)).toBe(before);
  });

  await test.step("the next task's browser starts with nothing the first one kept", async () => {
    const second = await check("Robin");
    expect(second.outcome).toContain(`"Not signed up yet" first, "Thanks, Robin" after Send`);
    if (evidence) {
      writeFileSync(join(evidence, "task-browser-second-report.txt"), `${second.outcome}\n`);
    }
    expect(await windowCount(launched.app)).toBe(before);
  });
});

/**
 * The page the captain watches: green, so its own pixels can be told from
 * the app's in the view; it keeps a name in its site data, and it says
 * "Ready to send" only once the spec tells its server so, which is what
 * keeps the crewmate's turn - its driving - running until then.
 */
const WATCHED_PAGE = `<!doctype html>
<html>
  <head><title>Sign up</title><style>body { background: rgb(43, 138, 62); color: white; }</style></head>
  <body>
    <h1>Sign up</h1>
    <p id="state"></p>
    <label>Name <input id="name"></label>
    <button id="send">Send</button>
    <p id="ready"></p>
    <p id="out"></p>
    <script>
      const saved = localStorage.getItem("name");
      document.getElementById("state").textContent = saved ? "Signed up as " + saved : "Not signed up yet";
      setInterval(async () => {
        const ready = await (await fetch("/ready")).text();
        if (ready === "yes") document.getElementById("ready").textContent = "${TASK_BROWSER_READY_WORDS}";
      }, 200);
      document.getElementById("send").addEventListener("click", () => {
        const name = document.getElementById("name").value;
        localStorage.setItem("name", name);
        document.getElementById("out").textContent = "Thanks, " + name;
      });
    </script>
  </body>
</html>`;

test("a click that opens a page without a full reload reads that page, refuses a ref from before it, and reads a long passage and the exact time", async () => {
  const { page } = launched;
  const title = `${TASK_BROWSER_READING_MARKER}${siteUrl}reading`;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const detail = async (): Promise<TaskDetail | null> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return row ? window.infinitary.tasks.detail(row.id) : null;
    }, title);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 90_000 })
    .toContain(MOCK_BROWSER_READING_REPORT_PREFIX);
  const task = (await detail()) as TaskDetail;
  expect(task.outcome).toContain(
    "moved, new title, exact time, title tooltip, notes in full, feed in full",
  );
  // The release link's ref from before the move is refused, never used on
  // the link that took its place at the top of the release's page.
  expect(task.outcome).toContain(REF_FROM_EARLIER_PAGE);
  const picture = join(
    launched.userDataDir,
    "crewmates",
    task.id,
    "evidence",
    `${MOCK_BROWSER_READING_PICTURE}.png`,
  );
  expect(existsSync(picture)).toBe(true);
  const png = readFileSync(picture);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    copyFileSync(picture, join(evidence, "task-browser-release-page.png"));
    writeFileSync(
      join(evidence, "task-browser-reading-report.txt"),
      `${task.outcome}\n${png.readUInt32BE(16)}x${png.readUInt32BE(20)}\n`,
    );
  }
  // The scrollbar is not left out of a whole-page picture's width.
  expect(png.readUInt32BE(16)).toBe(TASK_BROWSER_PAGE.width);
  expect(png.readUInt32BE(20)).toBeGreaterThan(TASK_BROWSER_PAGE.height);
});

test("a crewmate reads a page too long for one answer by its map, finds words past the cut, reads on and scrolls", async () => {
  const { page } = launched;
  const title = `${TASK_BROWSER_LONG_MARKER}${siteUrl}long`;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const detail = async (): Promise<TaskDetail | null> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return row ? window.infinitary.tasks.detail(row.id) : null;
    }, title);
  await expect
    .poll(async () => (await detail())?.outcome ?? "", { timeout: 90_000 })
    .toContain(MOCK_BROWSER_LONG_REPORT_PREFIX);
  const task = (await detail()) as TaskDetail;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) {
    // What the crewmate read, answer by answer: the product's own words.
    const served = (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
      body.includes(title),
    );
    const answers = providerMessages(served.at(-1) ?? "{}")
      .filter((message) => message.role === "tool")
      .map((message, index) => `--- answer ${index + 1}\n${message.text}`);
    writeFileSync(
      join(evidence, "task-browser-long-answers.txt"),
      `${task.outcome}\n${answers.join("\n")}\n`,
    );
  }
  expect(task.outcome).toContain(
    "a map, folded repeats, found the end, read on, scrolled past the top",
  );
});

test("the captain opens a task's browser from its record and watches the crewmate drive it", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let ready = false;
  const watched = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(WATCHED_PAGE);
  });
  await new Promise<void>((resolve) => watched.listen(0, "127.0.0.1", resolve));
  const watchedUrl = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const before = await windowCount(launched.app);
    const title = `${TASK_BROWSER_WATCH_MARKER}${watchedUrl} as Sam`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);

    const task =
      await test.step("the crewmate opens its browser and keeps driving it", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.browser?.state ?? "", { timeout: 60_000 })
          .toBe("open");
        // The name is typed and the crewmate waits on the page: its turn runs.
        await expect
          .poll(() => pageSays(launched.app, watchedUrl, "name").catch(() => null))
          .not.toBeNull();
        await expect
          .poll(async () => (await detail())?.browser, { timeout: 30_000 })
          .toMatchObject({ state: "open", site: new URL(watchedUrl).host });
        return (await detail()) as TaskDetail;
      });

    await test.step("its record's Browser line names the site and who drives, and Open shows the view", async () => {
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      const line = taskFact(recordCard(page), "browser");
      await expect(line).toHaveAttribute("data-browser-driver", "crewmate");
      await expect(line).toContainText(new URL(watchedUrl).host);
      await shoot(recordCard(page), "record-after-dark.png");
      await line.locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
    });

    await test.step("the card's tabs read Info, Crewmate and Browser with the page's title, and the keys and command search move between them", async () => {
      const { tabs, selected } = taskTabs(page);
      await expect(tabs).toHaveText([
        INFO_TAB_LABEL,
        CREWMATE_TAB_LABEL,
        browserTabLabel("Sign up"),
      ]);
      await shoot(view(page, task.id), "tabs-browser-dark.png");
      // Home to Info, Enter shows it in the card's place: one entry per task.
      await pressKey(selected, "Home");
      await pressKey(tabs.first(), "Enter");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      await expect(selected).toHaveText(INFO_TAB_LABEL);
      // The strip the swap drew holds focus on the shown tab.
      await untilFocused(selected);
      await shoot(recordCard(page), "tabs-info-dark.png");
      if (evidence) await heroShot(app, page, { region: recordCard(page), name: "task-card-tabs" });
      await runFromSearch(app, page, "cards.show-browser");
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
      await expect(selected).toHaveText(browserTabLabel("Sign up"));
      // The tab before Browser is the crewmate's session.
      await runFromSearch(app, page, "cards.previous-tab");
      await expect(crewmateView(page, task.id)).toBeVisible();
      await runFromSearch(app, page, "cards.next-tab");
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
    });

    await test.step("the view draws the task's own page, live, at the check's size", async () => {
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      const reading = await canvasReading(page);
      expect(reading.size).toBe(`${TASK_BROWSER_PAGE.width}x${TASK_BROWSER_PAGE.height}`);
      // The page's own green, not the app's surface: the pixels are the page's.
      const [red = 0, green = 0, blue = 0] = reading.centre;
      expect(green).toBeGreaterThan(110);
      expect(red).toBeLessThan(80);
      expect(blue).toBeLessThan(100);
      // Watching sends nothing: Back, Forward and Reload are the controller's,
      // marked off and still reachable, their labels saying who drives.
      await expect(
        view(page, task.id).locator('[data-browser-chrome] button[aria-disabled="true"]'),
      ).toHaveCount(3);
      await shoot(view(page, task.id), "view-watching-dark.png");
    });

    await test.step("maximized, the page lays out in the view's room and follows the window; restored, it is the check's size again", async () => {
      const checkSize = `${TASK_BROWSER_PAGE.width}x${TASK_BROWSER_PAGE.height}`;
      await resizeWindow(app, page, { width: 1600, height: 1000 });
      await view(page, task.id).getByRole("button", { name: MAXIMIZE_LABEL, exact: true }).click();
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).toMatch(SIZE);
      const wide = await pageFillsView(page, app, task.id, watchedUrl);
      // The room is the page's own layout, not a stretched picture of the check's size.
      expect(wide).not.toBe(checkSize);
      await shoot(view(page, task.id), "view-maximized-dark.png");
      await resizeWindow(app, page, { width: 1440, height: 900 });
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).not.toBe(wide);
      await expect.poll(() => pageFillsView(page, app, task.id, watchedUrl)).toMatch(SIZE);
      await view(page, task.id).getByRole("button", { name: RESTORE_LABEL, exact: true }).click();
      await expect.poll(() => pageLaidOutAt(app, watchedUrl)).toBe(checkSize);
      await expect.poll(async () => (await canvasReading(page)).size).toBe(checkSize);
      await resizeWindow(app, page, { width: 1280, height: 900 });
    });

    await test.step("the Firstmate input under the view carries the task", async () => {
      await promptInput(page).fill("how is the check going?");
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail())?.asks.map((ask) => ask.text) ?? [], { timeout: 20_000 })
        .toContain("how is the check going?");
      await expect(view(page, task.id)).toBeVisible();
    });

    await test.step("once the crewmate's turn ends, nobody drives and its browser stays", async () => {
      ready = true;
      await expect
        .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_BROWSER_WATCH_REPORT_PREFIX} "Thanks, Sam"`);
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody", {
        timeout: 30_000,
      });
      expect((await detail())?.browser?.state).toBe("open");
      expect(await windowCount(launched.app)).toBe(before + 1);
      await shoot(view(page, task.id), "view-nobody-dark.png");
    });

    await test.step("More holds Fit; Stop browser stops it, and the view says so", async () => {
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      const menu = page.locator('[role="menu"]');
      if (evidence) {
        await expect(menu).toHaveCSS("opacity", "1");
        await shoot(page.locator(SHOWN_ENTRY), "view-more-dark.png");
      }
      await menu.locator('[data-menu-item="fit"]').click();
      await expect(view(page, task.id).locator("[data-browser-canvas]")).toHaveAttribute(
        "data-browser-fit",
        "actual",
      );
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await menu.locator('[data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      await expect(view(page, task.id).locator("[data-browser-stopped]")).toHaveAttribute(
        "data-browser-stopped",
        "captain",
      );
      await expect.poll(() => windowCount(launched.app)).toBe(before);
      await shoot(view(page, task.id), "view-stopped-dark.png");
    });

    await test.step("Open again starts a fresh browser at the same page, with nothing it kept", async () => {
      await view(page, task.id).locator("[data-browser-open-again] button").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      // The first browser saved the name; the fresh one has none of it.
      await expect
        .poll(() => pageSays(launched.app, watchedUrl, "state").catch(() => null))
        .toBe("Not signed up yet");
      expect(await windowCount(launched.app)).toBe(before + 1);
    });

    await test.step("Hide puts the view away and the browser keeps running", async () => {
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-nobody-light.png");
        await setThemeViaSettings(page, "dark");
      }
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      expect((await detail())?.browser?.state).toBe("open");
      expect(await windowCount(launched.app)).toBe(before + 1);
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(watched);
  }
});

test("a crewmate's card opens its task's browser and answers nothing", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const watched = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("yes");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(WATCHED_PAGE);
  });
  await new Promise<void>((resolve) => watched.listen(0, "127.0.0.1", resolve));
  const watchedUrl = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/`;
  const site = new URL(watchedUrl).host;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const title = `${TASK_BROWSER_CARD_MARKER}${watchedUrl} as Sam`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);
    const savedCard = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === MOCK_BROWSER_CARD_TITLE,
      );
    const strip = page.locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`);
    const cardRegion = shownCard(page, MOCK_BROWSER_CARD_TITLE);

    const task =
      await test.step("the crewmate leaves its browser open and a card whose button reads Try it", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
          .toContain(MOCK_BROWSER_CARD_REPORT);
        const current = (await detail()) as TaskDetail;
        // The host named the browser the task holds, and the crewmate only the label.
        expect(await savedCard()).toMatchObject({
          taskId: current.id,
          attachment: {
            kind: "browser",
            label: MOCK_BROWSER_BUTTON,
            taskId: current.id,
            session: current.browser?.session,
            generation: current.browser?.generation,
          },
        });
        await showCard(page, MOCK_BROWSER_CARD_TITLE);
        await expect(strip).toHaveAttribute("data-attachment-standing", "same");
        // The site and who drives it, as the record reads them: the turn has ended.
        await expect(strip.locator("[data-attachment-line]")).toHaveAttribute(
          "data-browser-driver",
          "nobody",
        );
        await expect(strip.locator("[data-attachment-line]")).toContainText(site);
        await shoot(page.locator(SHOWN_ENTRY), "card-after-dark.png");
        return current;
      });

    await test.step("Try it opens the task's browser view, and the card stays unanswered behind it", async () => {
      const before = await savedCard();
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveCount(0);
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, task.id), "view-from-card-dark.png");
      // The same card, the same offer, nothing said under it, and the task where it was.
      const after = await savedCard();
      expect(after).toMatchObject({
        id: before?.id,
        offerId: before?.offerId,
        lifecycleId: before?.lifecycleId,
        status: "ready",
      });
      expect(after?.awaiting).toBeUndefined();
      const thread = await page.evaluate(
        (id) => window.infinitary.cards.thread(id),
        after?.id ?? "",
      );
      expect(thread.messages).toEqual([]);
      expect((await detail())?.status).toBe(task.status);
    });

    await test.step("Hide returns to the card, its buttons as they were", async () => {
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toHaveCount(0);
      await expect(cardRegion).toBeVisible();
      await expect(cardRegion.getByRole("button", { name: "Looks right" })).toBeEnabled();
    });

    await test.step("once its browser is replaced, the card says so, and so does the view it opens", async () => {
      await strip.getByRole("button", { name: MOCK_BROWSER_BUTTON }).click();
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await page.locator('[role="menu"] [data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      // Still the card's browser, stopped: no line.
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveCount(0);
      await view(page, task.id).locator("[data-browser-open-again] button").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "nobody");
      await expect(view(page, task.id).locator("[data-browser-notice]")).toHaveAttribute(
        "data-browser-notice",
        "replaced",
      );
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, task.id), "view-replaced-dark.png");
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(strip).toHaveAttribute("data-attachment-standing", "replaced");
      await shoot(page.locator(SHOWN_ENTRY), "card-replaced-dark.png");
      expect(await savedCard()).toMatchObject({ status: "ready" });
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(watched);
  }
});

/**
 * The account page a crewmate cannot sign in to itself: blue, so its own
 * pixels show in the view; it signs in only on a real click, keeps who
 * signed in in its site data, clears its form as a sign-in that moves on
 * does, and at that moment logs a private line and asks a tracker on the
 * internet for a picture - both while the captain holds the page, so
 * neither may reach the crewmate. It says "Ready to go on" only once the
 * spec tells its server so, which keeps the crewmate's fresh look - its
 * driving - running until then.
 */
const ACCOUNT_PAGE = `<!doctype html>
<html>
  <head><title>Sign in</title><style>body { background: rgb(40, 90, 160); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Sign in</h1>
    <p id="state"></p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <p id="ready"></p>
    <script>
      const show = () => {
        const who = localStorage.getItem("who");
        document.getElementById("state").textContent = who ? "Signed in as " + who : "Not signed in";
      };
      show();
      document.getElementById("sign-in").addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        const email = document.getElementById("email").value;
        localStorage.setItem("who", email);
        console.error("private sign-in note for " + email);
        void fetch("https://tracker.example/pixel").catch(() => undefined);
        document.getElementById("email").value = "";
        document.getElementById("password").value = "";
        show();
      });
      setInterval(async () => {
        const ready = await (await fetch("/ready")).text();
        if (ready === "yes") document.getElementById("ready").textContent = "${TASK_BROWSER_HANDOFF_READY_WORDS}";
      }, 200);
    </script>
  </body>
</html>`;

test("a crewmate asks the captain to sign in, and he takes its browser, signs in and hands it back", async () => {
  // One journey across two crewmate turns and the captain's own sign-in.
  test.setTimeout(180_000);
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let ready = false;
  const account = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(ACCOUNT_PAGE);
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const accountUrl = `http://127.0.0.1:${(account.address() as AddressInfo).port}/`;
  const site = new URL(accountUrl).host;
  const PASSWORD = "hunter2-correct-horse";
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const title = `${TASK_BROWSER_HANDOFF_MARKER}${accountUrl}`;
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find(
          (task) => task.title === wanted,
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);
    const savedCard = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.title === MOCK_HANDOFF_CARD_TITLE,
      );
    /** The crewmate's own model calls: none may go out while the captain holds its browser. */
    const crewmateCalls = () =>
      (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
        providerMessages(body)[0]?.text.startsWith(`Goal: Complete the task "${title}"`),
      );
    const strip = page.locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`);
    const cardRegion = shownCard(page, MOCK_HANDOFF_CARD_TITLE);
    const task =
      await test.step("the crewmate asks on an ordinary decision, and its browser pauses first", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
          .toContain(MOCK_HANDOFF_ASKED_REPORT);
        const current = (await detail()) as TaskDetail;
        // Its browser refused it the moment its card went up.
        expect(current.outcome).toContain(
          "My browser then said: \"You asked the captain to take over this task's browser, so it is paused:",
        );
        expect(current.browser).toMatchObject({
          state: "open",
          site,
          control: "waiting",
          request: { reason: MOCK_HANDOFF_REASON },
        });
        // The host names the browser and the site; the crewmate only asked.
        expect(await savedCard()).toMatchObject({
          taskId: current.id,
          attachment: {
            kind: "browser",
            label: BROWSER_DOOR_LABEL,
            taskId: current.id,
            session: current.browser?.session,
            generation: current.browser?.generation,
            handoff: true,
          },
        });
        await showCard(page, MOCK_HANDOFF_CARD_TITLE);
        await expect(strip).toHaveAttribute("data-attachment-handoff", "waiting");
        await expect(strip.locator("[data-attachment-line]")).toContainText(
          `${site} · ${DRIVER_WORDS.waiting}`,
        );
        await shoot(page.locator(SHOWN_ENTRY), "card-request-dark.png");
        if (evidence) {
          await setThemeViaSettings(page, "light");
          await showCard(page, MOCK_HANDOFF_CARD_TITLE);
          await shoot(page.locator(SHOWN_ENTRY), "card-request-light.png");
          await setThemeViaSettings(page, "dark");
        }
        return current;
      });

    await test.step("the card's line has no door beside its action, and the record shows the paused page on an ember row", async () => {
      // The captain's words on INF-155's sign-in card: "there are two "open
      // browser" buttons here, so it's confusing". The card's action is its one way in.
      await expect(strip).toHaveAttribute("data-attachment-handoff", "waiting");
      await expect(strip.getByRole("button")).toHaveCount(0);
      await expect(cardRegion.getByRole("button", { name: MOCK_HANDOFF_ACTION })).toBeVisible();
      // The card's key opens its task's record, where the browser's line keeps its own Open.
      await cardRegion.getByRole("link", { name: task.key }).click();
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "waiting");
      await expect(view(page, task.id).locator("[data-browser-did]")).toHaveText(
        `· ${MOCK_HANDOFF_REASON}`,
      );
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, task.id), "view-paused-dark.png");
      // Looking takes nothing over.
      expect((await detail())?.browser).toMatchObject({ control: "waiting" });
      await view(page, task.id).locator("[data-browser-foot] [data-browser-record]").click();
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expect(recordCard(page)).toHaveCSS("opacity", "1");
      await expectRecordBody(page);
      // The view it came from has left the stage.
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toBeHidden();
      const line = taskFact(recordCard(page), "browser");
      await expect(line).toHaveAttribute("data-browser-driver", "waiting");
      await expect(line).toContainText(DRIVER_WORDS.waiting);
      await shoot(recordCard(page), "record-paused-dark.png");
      await hideRecord(page).click();
      await expect(recordCard(page)).toHaveCount(0);
      // Neither looking nor putting the view away resumes anything.
      expect((await detail())?.browser).toMatchObject({ control: "waiting" });
    });

    const calls =
      await test.step("Open browser and sign in hands him the page, and the crewmate hears nothing", async () => {
        await showCard(page, MOCK_HANDOFF_CARD_TITLE);
        await cardRegion.getByRole("button", { name: MOCK_HANDOFF_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect(view(page, task.id).locator("[data-browser-status]")).toContainText(
          VIEW_DRIVER_WORDS.captain,
        );
        // The card is answered; the browser's own state holds the request.
        await expect.poll(async () => (await savedCard())?.status).not.toBe("ready");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        // Back, Forward and Reload are his now.
        await expect(
          view(page, task.id).locator(
            '[data-browser-chrome] button:is(:disabled, [aria-disabled="true"])',
          ),
        ).toHaveCount(0);
        await shoot(view(page, task.id), "view-captain-dark.png");
        return crewmateCalls().length;
      });

    await test.step("he signs in on the page itself, and nothing he types is kept", async () => {
      await typeOnPage(launched.app, page, task.id, accountUrl, "email", "sam@example.com");
      await typeOnPage(launched.app, page, task.id, accountUrl, "password", PASSWORD);
      // Escape is the page's while he drives: the view stays.
      await page.keyboard.press("Escape");
      await expect(view(page, task.id)).toBeVisible();
      await clickOnPage(launched.app, page, task.id, accountUrl, "sign-in");
      await expect
        .poll(() => pageSays(launched.app, accountUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(1);
      await shoot(view(page, task.id), "view-signed-in-dark.png");
      const current = (await detail()) as TaskDetail;
      // No line names what he typed, the crewmate's last action still stands, and no file holds his password.
      expect(JSON.stringify(current)).not.toContain(PASSWORD);
      expect(JSON.stringify(current)).not.toContain("sam@example.com");
      expect(current.browser).toMatchObject({ control: "captain" });
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
      expect(crewmateCalls()).toHaveLength(calls);
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-captain-light.png");
        await setThemeViaSettings(page, "dark");
      }
    });

    await test.step("Hide resumes nothing; the sharing notice appears before the one-click return", async () => {
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      expect((await detail())?.browser).toMatchObject({ control: "captain" });
      expect(crewmateCalls()).toHaveLength(calls);
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      const line = taskFact(recordCard(page), "browser");
      await expect(line).toContainText(DRIVER_WORDS.captain);
      await line.locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      const sharing = view(page, task.id).locator("[data-browser-sharing]");
      await expect(sharing).toContainText(RETURN_CONTROL_NOTICE);
      await shoot(view(page, task.id), "view-sharing-notice-dark.png");
      expect((await detail())?.browser).toMatchObject({ control: "captain" });
      expect(crewmateCalls()).toHaveLength(calls);
    });

    await test.step("returning wakes the crewmate once, for a fresh look with every old ref gone", async () => {
      await view(page, task.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: RETURN_CONTROL_LABEL })
        .click();
      const status = view(page, task.id).locator("[data-browser-status]");
      await expect(status).toHaveAttribute("data-browser-driver", "crewmate", { timeout: 30_000 });
      await expect(status).toContainText(VIEW_DRIVER_WORDS.crewmate);
      await expect(view(page, task.id).locator("[data-browser-did]")).toHaveText(
        `· ${FRESH_LOOK_WORDS}`,
      );
      // The page keeps what he signed in to until it stops, and says so.
      await expect(view(page, task.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${RETURNED_CAPTION}`,
      );
      await shoot(view(page, task.id), "view-returned-dark.png");
      ready = true;
      await expect
        .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_HANDOFF_RETURNED_REPORT);
      const outcome = (await detail())?.outcome ?? "";
      // Its ref from before the handoff is refused, never used on the page he handed back.
      expect(outcome).toContain(REF_FROM_BEFORE_HANDBACK);
      // Its first look says control came back, and reads what he signed in to.
      expect(outcome).toContain(
        'The fresh look said "The captain returned control of this browser:',
      );
      expect(outcome).toContain('the page said "Signed in as sam@example.com"');
      // What the page logged and asked for while he held it never reached it.
      expect(outcome).toContain("It kept nothing from the captain's time.");
      // The page may show his account now: a picture only for a reason the
      // task has, and his record says so.
      expect(outcome).toContain(
        "A picture without a reason: \"The captain handed this browser back, so its pages may show the captain's account: a picture is taken only when the task needs one.",
      );
      expect(outcome).toContain('With one: "Saved the visible page as ');
      expect(
        existsSync(
          join(
            launched.userDataDir,
            "crewmates",
            task.id,
            "evidence",
            `${MOCK_SIGNED_IN_PICTURE}.png`,
          ),
        ),
      ).toBe(true);
      // One wake, through its lane: the steer is in the conversation once.
      const woken = providerMessages(crewmateCalls().at(-1) ?? "{}").filter((message) =>
        message.text.startsWith(BROWSER_RETURNED_OPENING),
      );
      expect(woken).toHaveLength(1);
      expect(crewmateCalls().some((body) => body.includes(PASSWORD))).toBe(false);
      const lines = ((await detail())?.events ?? []).map((event) => event.text);
      expect(lines).toEqual(
        expect.arrayContaining([
          `asked you to take over its browser at ${site}`,
          "you took control of its browser",
          "you returned control of its browser",
          `photographed its browser's page at ${site} after you returned control: ${MOCK_SIGNED_IN_PICTURE_REASON}`,
        ]),
      );
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
    });
  } finally {
    await closeSite(account);
  }
});

test("the captain takes a task's browser while its crewmate's command runs, and nothing he types is kept", async () => {
  // One journey across two crewmate turns and the captain's own sign-in.
  test.setTimeout(180_000);
  const { page, app } = launched;
  // The account page never says it is ready: the crewmate keeps waiting on it.
  const account = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(ACCOUNT_PAGE);
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const accountUrl = `http://127.0.0.1:${(account.address() as AddressInfo).port}/`;
  const PASSWORD = "take-synthetic-correct-horse";
  const title = `${TASK_BROWSER_TAKE_MARKER}${accountUrl} open`;
  const detail = async (): Promise<TaskDetail> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return (row ? await window.infinitary.tasks.detail(row.id) : null) as TaskDetail;
    }, title);
  const crewmateCalls = () =>
    (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
      providerMessages(body)[0]?.text.startsWith(`Goal: Complete the task "${title}"`),
    );
  const openView = async (task: TaskDetail): Promise<void> => {
    await expandDock(page, "now");
    await pressRow(page, task.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await expectRecordBody(page);
    await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
  };
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    await stopTaskBrowsers(page);
    const task =
      await test.step("its crewmate waits on the page, a command in flight", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail().catch(() => null))?.browser, { timeout: 60_000 })
          .toMatchObject({
            state: "open",
            did: `waited for "${TASK_BROWSER_HANDOFF_READY_WORDS}"`,
          });
        return detail();
      });

    await test.step("Take control lets that command finish, refuses the next, then hands him the page", async () => {
      await openView(task);
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "watching");
      await view(page, task.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: TAKE_CONTROL_LABEL })
        .click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain", {
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await detail()).outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_TAKE_REFUSED_REPORT);
      const outcome = (await detail()).outcome ?? "";
      // The wait in flight ran to its end and answered; the one after it refused as it started.
      expect(outcome).toContain(
        `The command before it answered "Waited 10 seconds; "${TASK_BROWSER_HANDOFF_READY_WORDS}" did not appear.`,
      );
      expect(outcome).toContain(
        "Then my browser said \"The captain has control of this task's browser:",
      );
      // The wait ran past its Pi shell's 3-second limit: the command said it
      // was still running, the crewmate's next looks read its answer, and no
      // look ran it again - its only waits are that one and the one refused.
      const last = crewmateCalls().at(-1) ?? "{}";
      const heard = providerMessages(last)
        .filter((message) => message.role === "tool")
        .map((message) => message.text);
      expect(heard.some((text) => /^running: wait$/m.test(text))).toBe(true);
      expect(heard.some((text) => /^earlier: Your earlier wait finished$/m.test(text))).toBe(true);
      expect(last.split(`${BROWSER_COMMAND} wait `)).toHaveLength(3);
      expect((await detail()).events.map((event) => event.text)).toContain(
        "you took control of its browser",
      );
    });

    await test.step("he maximizes the view and signs in on the page at its new size with an invented account, and nothing keeps it", async () => {
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await view(page, task.id).getByRole("button", { name: MAXIMIZE_LABEL, exact: true }).click();
      await expect.poll(() => pageFillsView(page, app, task.id, accountUrl)).toMatch(SIZE);
      expect(await pageFillsView(page, app, task.id, accountUrl)).not.toBe(
        `${TASK_BROWSER_PAGE.width}x${TASK_BROWSER_PAGE.height}`,
      );
      const calls = crewmateCalls().length;
      await typeOnPage(launched.app, page, task.id, accountUrl, "email", "sam@example.com");
      await typeOnPage(launched.app, page, task.id, accountUrl, "password", PASSWORD);
      await clickOnPage(launched.app, page, task.id, accountUrl, "sign-in");
      await expect
        .poll(() => pageSays(launched.app, accountUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      expect(crewmateCalls()).toHaveLength(calls);
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
      expect(JSON.stringify(await detail())).not.toContain(PASSWORD);
      expect(JSON.stringify(await detail())).not.toContain("sam@example.com");
    });

    await test.step("Hide resumes nothing, and Return control wakes the crewmate once", async () => {
      const calls = crewmateCalls().length;
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      expect((await detail()).browser).toMatchObject({ control: "captain" });
      expect(crewmateCalls()).toHaveLength(calls);
      await openView(await detail());
      await view(page, task.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: RETURN_CONTROL_LABEL })
        .click();
      await expect
        .poll(async () => (await detail()).outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_TAKE_RETURNED_REPORT);
      const outcome = (await detail()).outcome ?? "";
      expect(outcome).toContain(
        'The fresh look said "The captain returned control of this browser:',
      );
      expect(outcome).toContain('the page said "Signed in as sam@example.com"');
      const woken = providerMessages(crewmateCalls().at(-1) ?? "{}").filter(
        (message) => message.role === "user" && message.text.includes(BROWSER_RETURNED_OPENING),
      );
      expect(woken).toHaveLength(1);
      expect(crewmateCalls().some((body) => body.includes(PASSWORD))).toBe(false);
    });
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(account);
  }
});

/** A page that counts its visits in its own site data: each task's browser counts its own. */
const VISITS_PAGE = `<!doctype html>
<html>
  <head><title>Visits</title></head>
  <body>
    <h1>Visits</h1>
    <p id="visits"></p>
    <script>
      const visits = Number(localStorage.getItem("visits") || 0) + 1;
      localStorage.setItem("visits", String(visits));
      document.getElementById("visits").textContent =
        "Visited " + visits + (visits === 1 ? " time" : " times") + " in this browser";
    </script>
  </body>
</html>`;

/** A page that reaches for another task's server: its data and its picture. */
const neighbourPage = (other: string): string => `<!doctype html>
<html>
  <head><title>Neighbour</title></head>
  <body>
    <h1>Neighbour</h1>
    <img src="${other}logo.png" alt="">
    <script>void fetch(${JSON.stringify(`${other}visits`)}).catch(() => undefined);</script>
  </body>
</html>`;

test("one task's browser reaches nothing of another's, nor a private address a redirect leads to", async () => {
  test.setTimeout(120_000);
  const { page } = launched;
  const visits = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(VISITS_PAGE);
  });
  await new Promise<void>((resolve) => visits.listen(0, "127.0.0.1", resolve));
  const otherUrl = `http://127.0.0.1:${(visits.address() as AddressInfo).port}/`;
  // Its own page, and two redirects of its own: to a public name the
  // resolver map sends to this Mac, and to a private address written out.
  const neighbour = createServer((request, response) => {
    const to =
      request.url === "/leave"
        ? "https://rebind.example/landing"
        : request.url === "/intranet"
          ? "http://10.1.2.3/admin"
          : undefined;
    if (to) {
      response.writeHead(302, { location: to });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(neighbourPage(otherUrl));
  });
  await new Promise<void>((resolve) => neighbour.listen(0, "127.0.0.1", resolve));
  const ownUrl = `http://127.0.0.1:${(neighbour.address() as AddressInfo).port}/`;
  const otherSite = new URL(otherUrl).host;
  const ownSite = new URL(ownUrl).host;
  // The board shortens a long title; its start names each task alone.
  const detail = async (title: string): Promise<TaskDetail | null> =>
    page.evaluate(
      async (start) => {
        const row = (await window.infinitary.tasks.board()).tasks.find((task) =>
          task.title.startsWith(start),
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      },
      title.slice(0, 60),
    );
  const commission = async (title: string, words: string): Promise<TaskDetail> => {
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await promptInput(page).press("Enter");
    await expect
      .poll(async () => (await detail(title))?.outcome ?? "", { timeout: 60_000 })
      .toContain(words);
    return (await detail(title)) as TaskDetail;
  };
  try {
    // Two browsers of its own, under the cap of four.
    await stopTaskBrowsers(page);
    const first =
      await test.step("one task's browser opens a page on this Mac and keeps its visits", async () => {
        const task = await commission(
          `${TASK_BROWSER_FENCE_MARKER}${otherUrl} for task A`,
          MOCK_FENCE_A_REPORT,
        );
        expect(task.outcome).toContain('"Visited 2 times in this browser"');
        expect(task.browser).toMatchObject({ state: "open", site: otherSite });
        return task;
      });

    await test.step("another task's browser reaches none of it, and its redirects to private addresses are refused", async () => {
      const task = await commission(
        `${TASK_BROWSER_FENCE_MARKER}${ownUrl} beside ${otherUrl}`,
        MOCK_FENCE_B_REPORT,
      );
      const outcome = task.outcome ?? "";
      // The other task's server is only that task's: this page's data and picture from it were refused.
      expect(outcome).toContain(
        `"Blocked what the page asked for from other servers on ${HERE.this}: ${otherSite} (2).`,
      );
      // A request to take over the other task's site is refused, and nothing paused.
      expect(outcome).toContain(
        `The request: "Card refused: browser_handoff names ${otherSite}, but this task's browser is on ${ownSite}. Name the site it is on."`,
      );
      expect(
        (await page.evaluate(() => window.infinitary.cards.list())).some(
          (card) => card.title === "Sign in to the other task's page",
        ),
      ).toBe(false);
      expect(task.browser).not.toHaveProperty("control");
      // A redirect to a public name that leads to this Mac is refused at the connection.
      expect(outcome).toContain(
        `The redirect to a public name: "Blocked what the page asked for on ${HERE.this}'s network or another private one: rebind.example.`,
      );
      // One to a private address is refused before it leaves.
      expect(outcome).toContain(
        `The redirect to a private address: "Blocked what the page asked for on ${HERE.this}'s network or another private one: 10.1.2.3.`,
      );
      // Opening the other task's page itself starts with none of that task's site data.
      expect(outcome).toContain('The other task\'s page: "Visited 1 time in this browser"');
      // The first task's browser is where it was.
      expect((await detail(first.title))?.browser).toMatchObject({
        state: "open",
        site: otherSite,
      });
    });
  } finally {
    await stopTaskBrowsers(page);
    await Promise.all([visits, neighbour].map(closeSite));
  }
});

/**
 * A shop and its bank, on two servers this Mac serves under two names, so
 * each page has a site of its own. The shop's Pay opens the bank's check as
 * a second page and says it was paid once the bank answers it. The check is
 * green, so its pixels show in the view; it says "Ready to approve" only
 * once the spec tells its server so, which keeps the crewmate's turn - and
 * both pages - up until then, and closes itself a moment after Approve.
 */
const shopPage = (bank: string): string => `<!doctype html>
<html>
  <head><title>Payment</title></head>
  <body>
    <h1>Payment</h1>
    <p id="state">Waiting for payment</p>
    <button id="pay">Pay</button>
    <script>
      document.getElementById("pay").addEventListener("click", () => {
        window.open(${JSON.stringify(`${bank}check`)}, "bank-check");
      });
      window.addEventListener("message", (event) => {
        if (event.data === "approved") {
          document.getElementById("state").textContent = "Paid with the bank's approval";
        }
      });
    </script>
  </body>
</html>`;

const BANK_HOME = `<!doctype html><html><head><title>Bank</title></head><body><h1>Bank</h1><p>Bank ready</p></body></html>`;

const BANK_CHECK = `<!doctype html>
<html>
  <head><title>Verify payment</title><style>body { background: rgb(43, 138, 62); color: white; font: 18px sans-serif; }</style></head>
  <body>
    <h1>Verify this payment</h1>
    <p>Payment of 312.00</p>
    <p id="ready"></p>
    <button id="approve">Approve</button>
    <script>
      setInterval(async () => {
        const ready = await (await fetch("/ready")).text();
        if (ready === "yes" && !document.body.dataset.approved) {
          document.getElementById("ready").textContent = "${TASK_BROWSER_APPROVE_WORDS}";
        }
      }, 200);
      document.getElementById("approve").addEventListener("click", () => {
        document.body.dataset.approved = "yes";
        document.getElementById("ready").textContent = "Approved";
        window.opener?.postMessage("approved", "*");
        setTimeout(() => window.close(), 1000);
      });
    </script>
  </body>
</html>`;

test("a page's second page opens inside the task's browser, named by its own site", async () => {
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let ready = false;
  const bank = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/check" ? BANK_CHECK : BANK_HOME);
  });
  await new Promise<void>((resolve) => bank.listen(0, "127.0.0.1", resolve));
  const bankUrl = `http://localhost:${(bank.address() as AddressInfo).port}/`;
  const shop = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(shopPage(bankUrl));
  });
  await new Promise<void>((resolve) => shop.listen(0, "127.0.0.1", resolve));
  const shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}/`;
  // A site whose certificate no authority this Mac trusts signed.
  const certificates = customApiCaFixture(scratchDir("task-browser-ca-"));
  const untrusted = createSecureServer(
    { key: certificates.leafKey, cert: certificates.leaf },
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Untrusted</title><p>This page should not open</p>");
    },
  );
  await new Promise<void>((resolve) => untrusted.listen(0, "127.0.0.1", resolve));
  const untrustedUrl = `https://localhost:${(untrusted.address() as AddressInfo).port}/`;
  const shopSite = new URL(shopUrl).host;
  const bankSite = new URL(bankUrl).host;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const before = await windowCount(launched.app);
    const title = `${TASK_BROWSER_PAGES_MARKER}${shopUrl} with the bank at ${bankUrl} after ${untrustedUrl}`;
    // The board shortens a long title; its start names this task alone.
    const detail = async (): Promise<TaskDetail | null> =>
      page.evaluate(async (start) => {
        const row = (await window.infinitary.tasks.board()).tasks.find((task) =>
          task.title.startsWith(start),
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, `${TASK_BROWSER_PAGES_MARKER}${shopUrl}`);

    const task =
      await test.step("the shop's Pay opens the bank's check as the browser's second page", async () => {
        await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
        await promptInput(page).press("Enter");
        await expect
          .poll(async () => (await detail())?.browser, { timeout: 60_000 })
          .toMatchObject({
            state: "open",
            site: bankSite,
            page: 2,
            pages: [
              { site: shopSite, title: "Payment" },
              { site: bankSite, title: "Verify payment" },
            ],
          });
        // Two hidden pages of one browser, never a window of the app's.
        expect(await windowCount(launched.app)).toBe(before + 2);
        return (await detail()) as TaskDetail;
      });

    await test.step("the view names each page by its title, and picking one is the controller's", async () => {
      await expandDock(page, "now");
      await pressRow(page, task.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
      const shown = view(page, task.id);
      await expect(shown).toHaveAttribute("data-browser-state", "watching");
      const tabs = shown.locator("[data-browser-page-tab]");
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(0)).toHaveText(browserTabLabel("Payment"));
      await expect(tabs.nth(1)).toHaveText(browserTabLabel("Verify payment"));
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      // Watching is not control: the crewmate's page stays its own.
      await expect(tabs.nth(0)).toBeDisabled();
      await expect(shown.locator("[data-browser-site]")).toHaveText(bankSite);
      // The view draws the bank's own page: its green.
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await expect
        .poll(async () => (await canvasReading(page)).centre[1] ?? 0)
        .toBeGreaterThan(110);
      await shoot(shown, "view-two-pages-dark.png");
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-two-pages-light.png");
        await setThemeViaSettings(page, "dark");
      }
    });

    await test.step("once approved, the check closes itself and the crewmate is back on the shop", async () => {
      ready = true;
      await expect
        .poll(async () => (await detail())?.outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_PAGES_REPORT_PREFIX);
      const outcome = (await detail())?.outcome ?? "";
      if (evidence) writeFileSync(join(evidence, "task-browser-pages-report.txt"), `${outcome}\n`);
      // A certificate no one trusts is refused in words, never gone past.
      expect(outcome).toMatch(
        /"localhost:\d+'s certificate did not verify \(ERR_CERT_[A-Z_]+\), so the browser did not open it\."/,
      );
      expect(outcome).toContain(
        `The page opened a second page at ${bankSite}, page 2, and your commands act on it now.`,
      );
      expect(outcome).toContain('The check: "page 2 of 2"');
      expect(outcome).toContain(
        `Page 2 (${bankSite}) closed itself; your commands act on page 1 again.`,
      );
      expect(outcome).toContain(`The shop: "Paid with the bank's approval"`);
      // The second page's tab goes with it; the view is on the shop.
      await expect(view(page, task.id).locator("[data-browser-page-tab]")).toHaveCount(1);
      await expect(view(page, task.id).locator("[data-browser-site]")).toHaveText(shopSite);
      await expect.poll(() => windowCount(launched.app)).toBe(before + 1);
      await shoot(view(page, task.id), "view-one-page-after-dark.png");
    });

    await test.step("Stop browser closes it, its last page and all", async () => {
      await view(page, task.id).locator('[aria-haspopup="menu"]').click();
      await page.locator('[role="menu"] [data-menu-item="stop"]').click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "stopped");
      await expect.poll(() => windowCount(launched.app)).toBe(before);
    });
  } finally {
    await Promise.all([bank, shop, untrusted].map(closeSite));
  }
});

/** A saved sign-in's file, as the store wrote it. */
type SavedSignInFile = {
  site: string;
  cookies: { name: string; value: string }[];
  storage?: { origin: string; items: [string, string][] }[];
};

/** The saved sign-ins' files on this Mac, each as the store wrote it. */
function savedSignInFiles(): SavedSignInFile[] {
  const store = join(launched.userDataDir, "web-sign-ins");
  return existsSync(store)
    ? readdirSync(store)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(store, name), "utf8")))
    : [];
}

/** A task's record by its title, or nothing before it is filed. */
function detailTitled(title: string): Promise<TaskDetail | null> {
  return launched.page.evaluate(async (wanted) => {
    const row = (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted);
    return row ? window.infinitary.tasks.detail(row.id) : null;
  }, title);
}

/** A task's request to sign in to the club page, as the card stack holds it. */
async function savedCardOf(taskId: string) {
  return (await launched.page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.title === MOCK_SAVED_CARD_TITLE && card.taskId === taskId,
  );
}

/** The request to sign in to the club page, as the stack shows it. */
function savedCardRegion(): Locator {
  return shownCard(launched.page, MOCK_SAVED_CARD_TITLE);
}

/** A crewmate's own model calls, by its task's title. */
function crewmateCalls(title: string): string[] {
  return (launched.mockProvider?.requestBodies() ?? []).filter((body) =>
    providerMessages(body)[0]?.text.startsWith(`Goal: Complete the task "${title}"`),
  );
}

/** Ask for a club page task, and wait for its crewmate to ask the captain to sign in. */
async function askToSignIn(title: string): Promise<TaskDetail> {
  const { page } = launched;
  await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await promptInput(page).press("Enter");
  await expect
    .poll(async () => (await detailTitled(title))?.outcome ?? "", { timeout: 60_000 })
    .toContain(MOCK_SAVED_ASKED_REPORT);
  return (await detailTitled(title)) as TaskDetail;
}

/** Settings › General's Website sign-ins. */
async function openGeneralSettings(): Promise<Locator> {
  const { page } = launched;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const section = page.locator("[data-website-sign-ins]");
  await expect(section).toBeVisible();
  return section;
}

async function closeSettings(): Promise<void> {
  const { page } = launched;
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
    "data-screen-label",
    "Settings",
  );
}

/**
 * A club page whose sign-in its server keeps in a cookie: it reads `who`,
 * and counts each signed-in visit in a `visit` cookie it sets anew, so a
 * session the site refreshed is a cookie that changed. Its Sign in button
 * counts only a real click; the password never leaves the page.
 */
const clubPage = (who: string | undefined): string => `<!doctype html>
<html>
  <head><title>Club</title><style>body { background: rgb(30, 110, 80); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Club</h1>
    <p id="state">${who ? `Signed in as ${who.replace(/[<&"]/g, "")}` : "Not signed in"}</p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <script>
      document.getElementById("sign-in").addEventListener("click", async (event) => {
        if (!event.isTrusted) return;
        await fetch("/sign-in", { method: "POST", body: document.getElementById("email").value });
        location.reload();
      });
    </script>
  </body>
</html>`;

test("without future-task permission a saved sign-in reaches a later task only on the captain's click, and Settings removes it", async () => {
  // One journey: a sign-in saved as one task's browser is handed back, its
  // grant to a second task, and its removal while that task uses it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  let visits = 0;
  const club = createServer((request, response) => {
    const cookies = new Map(
      (request.headers.cookie ?? "")
        .split(/;\s*/)
        .filter(Boolean)
        .map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const;
        }),
    );
    if (request.method === "POST" && request.url === "/sign-in") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.writeHead(204, {
          "set-cookie": `who=${encodeURIComponent(body)}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end();
      });
      return;
    }
    const who = cookies.get("who");
    const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    if (who) {
      visits += 1;
      headers["set-cookie"] = `visit=${visits}; Path=/; HttpOnly; SameSite=Lax`;
    }
    response.writeHead(200, headers);
    response.end(clubPage(who));
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const PASSWORD = "club-hunter2-correct-horse";
  /** The cookies a task's hidden page holds now, by name. */
  const pageCookies = (): Promise<string[]> =>
    app.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(url));
      return contents ? (await contents.session.cookies.get({})).map((cookie) => cookie.name) : [];
    }, clubUrl);
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("the first task");
    const second = titled("the second task");

    const a =
      await test.step("with nothing saved, the request offers only the captain's own sign-in", async () => {
        const task = await askToSignIn(first);
        expect((await savedCardOf(task.id))?.actions.map((action) => action.label)).toEqual([
          "Leave waiting",
          MOCK_SAVED_ACTION,
        ]);
        expect(await page.evaluate(() => window.infinitary.browser.signIns())).toEqual({
          available: true,
          signIns: [],
        });
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        return task;
      });

    await test.step("the captain signs in, and Return control's tick saves the site's sign-in on this Mac", async () => {
      await typeOnPage(launched.app, page, a.id, clubUrl, "email", "sam@example.com");
      await typeOnPage(launched.app, page, a.id, clubUrl, "password", PASSWORD);
      await clickOnPage(launched.app, page, a.id, clubUrl, "sign-in");
      await expect
        .poll(() => pageSays(launched.app, clubUrl, "state").catch(() => null))
        .toBe("Signed in as sam@example.com");
      const question = view(page, a.id).locator("[data-browser-sharing]");
      const tick = question.getByRole("checkbox", {
        name: rememberSignInLabel(site),
      });
      const asking = async (): Promise<void> => {
        // Nothing is saved without the tick, and it never starts ticked.
        await expect(tick).not.toBeChecked();
      };
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await asking();
        await tick.check();
        await shoot(view(page, a.id), "view-return-remember-ticked-light.png");
        await tick.uncheck();
        await setThemeViaSettings(page, "dark");
      }
      await asking();
      await shoot(view(page, a.id), "view-return-remember-dark.png");
      await tick.check();
      await shoot(view(page, a.id), "view-return-remember-ticked-dark.png");
      expect(savedSignInFiles()).toEqual([]);
      await view(page, a.id)
        .getByRole("button", { name: RETURN_CONTROL_LABEL, exact: true })
        .click();
      await expect
        .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      expect((await detailTitled(first))?.browser).toMatchObject({ saved: [site], returned: true });
      await expect(view(page, a.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      await shoot(view(page, a.id), "view-saved-in-use-dark.png");
      // The site's own cookies are saved, never what the captain typed.
      expect(savedSignInFiles()).toEqual([
        expect.objectContaining({
          site,
          cookies: expect.arrayContaining([
            expect.objectContaining({ name: "who", value: "sam%40example.com" }),
          ]),
        }),
      ]);
      expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
      const listed = await page.evaluate(() => window.infinitary.browser.signIns());
      expect(listed.signIns).toEqual([
        { site, savedAt: expect.any(Number), id: expect.any(String) },
      ]);
    });

    await test.step("Settings lists it, and the browser copies it back when it stops", async () => {
      const section = await openGeneralSettings();
      const row = section.locator(`[data-website-sign-in="${site}"]`);
      await expect(row).toContainText(site);
      await shoot(section, "settings-website-sign-ins-dark.png");
      await closeSettings();
      // The crewmate opened the page again after the return, so the club counted a new visit.
      const latest = String(visits);
      expect(
        savedSignInFiles()[0]?.cookies.find((cookie) => cookie.name === "visit")?.value,
      ).not.toBe(latest);
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect
        .poll(() => savedSignInFiles()[0]?.cookies.find((cookie) => cookie.name === "visit")?.value)
        .toBe(latest);
    });

    const b =
      await test.step("a later task's request offers the saved sign-in as its default", async () => {
        const task = await askToSignIn(second);
        const card = await savedCardOf(task.id);
        expect(
          card?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
            savedSignIn: action.effect?.kind === "open" && action.effect.savedSignIn === true,
          })),
        ).toEqual([
          { label: "Leave waiting", default: false, savedSignIn: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false, savedSignIn: false },
          { label: savedSignInLabel(site), default: true, savedSignIn: true },
        ]);
        // Its browser started empty: the card is up on a page that is not signed in.
        expect(await pageSays(launched.app, clubUrl, "state")).toBe("Not signed in");
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-saved-sign-in-dark.png");
        if (evidence) {
          await setThemeViaSettings(page, "light");
          await showCard(page, MOCK_SAVED_CARD_TITLE);
          await shoot(page.locator(SHOWN_ENTRY), "card-saved-sign-in-light.png");
          await setThemeViaSettings(page, "dark");
          await showCard(page, MOCK_SAVED_CARD_TITLE);
        }
        return task;
      });

    await test.step("one click signs its browser in and hands it back, and the crewmate carries on", async () => {
      await savedCardRegion()
        .getByRole("button", { name: savedSignInLabel(site) })
        .click();
      await expect(view(page, b.id)).toBeVisible();
      await expect
        .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
        .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
      const current = (await detailTitled(second)) as TaskDetail;
      expect(current.outcome).toContain(
        `The wake said "The captain let this task use the sign-in saved on ${HERE.this} for ${site}, and your browser is yours again:"`,
      );
      expect(current.browser).toMatchObject({ state: "open", saved: [site] });
      expect(current.browser).not.toHaveProperty("control");
      const lines = current.events.map((event) => event.text);
      expect(lines).toContain(`you let it use your saved sign-in at ${site}`);
      // The captain never took the page: the grant is the one line beside the handoffs.
      expect(lines).not.toContain("you took control of its browser");
      await expect(view(page, b.id).locator("[data-browser-sign-ins]")).toHaveText(
        `· ${savedCaption([site])}`,
      );
      // The view watches the page the saved sign-in reloaded, signed in.
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
      await shoot(view(page, b.id), "view-saved-granted-dark.png");
      expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
      expect(await pageCookies()).toEqual(expect.arrayContaining(["who"]));
    });

    await test.step("Remove in Settings signs out the browser using it, and nothing copies it back", async () => {
      const section = await openGeneralSettings();
      await section
        .locator(`[data-website-sign-in="${site}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(section.locator("[data-website-sign-ins-empty]")).toBeVisible();
      await expect(section.locator(`[data-website-sign-in="${site}"]`)).toHaveCount(0);
      await shoot(section, "settings-website-sign-ins-removed-dark.png");
      await closeSettings();
      expect(savedSignInFiles()).toEqual([]);
      await expect.poll(pageCookies).not.toContain("who");
      const current = (await detailTitled(second)) as TaskDetail;
      expect(current.browser).not.toHaveProperty("saved");
      expect(current.events.map((event) => event.text)).toContain(
        `your saved sign-in at ${site} was removed, and its browser signed out of it`,
      );
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
      expect(savedSignInFiles()).toEqual([]);
    });
  } finally {
    await closeSite(club);
  }
});

/**
 * A club page that keeps its sign-in in its own page storage, never in a
 * cookie: its server sets none. Sign in (a real click only) keeps the
 * session in local storage and reloads, and each signed-in visit counts
 * itself there, so a session the page refreshed is storage that changed.
 * The password never leaves the page.
 */
const STORED_CLUB_PAGE = `<!doctype html>
<html>
  <head><title>Club</title><style>body { background: rgb(40, 70, 130); color: white; font: 18px sans-serif; } input, button { font: inherit; margin: 8px; }</style></head>
  <body>
    <h1>Club</h1>
    <p id="state">Not signed in</p>
    <p id="visit"></p>
    <p><label>Email <input id="email" type="email"></label></p>
    <p><label>Password <input id="password" type="password"></label></p>
    <p><button id="sign-in">Sign in</button></p>
    <script>
      const session = JSON.parse(localStorage.getItem("session") || "null");
      if (session) {
        document.getElementById("state").textContent = "Signed in as " + session.who;
        const visit = Number(localStorage.getItem("visit") || "0") + 1;
        localStorage.setItem("visit", String(visit));
        document.getElementById("visit").textContent = "Visit " + visit;
      }
      document.getElementById("sign-in").addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        const who = document.getElementById("email").value;
        localStorage.setItem("session", JSON.stringify({ who, token: Math.random().toString(36).slice(2) }));
        location.reload();
      });
    </script>
  </body>
</html>`;

test("a site that keeps its sign-in in its own page storage is saved, used and removed like one in cookies", async () => {
  // One journey: the page storage saved as one task's browser is handed
  // back, copied back when it stops, granted to a second task, and removed
  // while that task uses it.
  test.setTimeout(240_000);
  const { page, app } = launched;
  await stopTaskBrowsers(page);
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const club = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(STORED_CLUB_PAGE);
  });
  await new Promise<void>((resolve) => club.listen(0, "127.0.0.1", resolve));
  const clubUrl = `http://127.0.0.1:${(club.address() as AddressInfo).port}/`;
  const site = new URL(clubUrl).host;
  const origin = new URL(clubUrl).origin;
  const PASSWORD = "stored-club-hunter2-battery-staple";
  /** What a saved file keeps of the club's own page storage, by key. */
  const savedStorage = (): Record<string, string> =>
    Object.fromEntries(
      savedSignInFiles()[0]?.storage?.find((held) => held.origin === origin)?.items ?? [],
    );
  /** The page storage a task's hidden page on the club holds now, by key. */
  const pageStorage = (): Promise<Record<string, string> | null> =>
    app.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith(url));
      return contents
        ? JSON.parse(await contents.executeJavaScript("JSON.stringify({ ...localStorage })"))
        : null;
    }, clubUrl);
  const titled = (who: string) => `${TASK_BROWSER_SAVED_MARKER}${clubUrl} as ${who}`;
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    const first = titled("stored task one");
    const second = titled("stored task two");

    const a =
      await test.step("the captain signs in, and Return control's tick saves the page's own storage", async () => {
        const task = await askToSignIn(first);
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await savedCardRegion().getByRole("button", { name: MOCK_SAVED_ACTION }).click();
        await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await typeOnPage(app, page, task.id, clubUrl, "email", "sam@example.com");
        await typeOnPage(app, page, task.id, clubUrl, "password", PASSWORD);
        await clickOnPage(app, page, task.id, clubUrl, "sign-in");
        await expect
          .poll(() => pageSays(app, clubUrl, "state").catch(() => null))
          .toBe("Signed in as sam@example.com");
        const sharing = view(page, task.id).locator("[data-browser-sharing]");
        await sharing.getByRole("checkbox", { name: rememberSignInLabel(site) }).check();
        await runFromSearch(app, page, "browser.control");
        await expect
          .poll(async () => (await detailTitled(first))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        expect((await detailTitled(first))?.browser).toMatchObject({
          saved: [site],
          returned: true,
        });
        // The site keeps no cookie: its sign-in is the page's own storage, for its own origin alone.
        expect(savedSignInFiles()).toEqual([
          expect.objectContaining({
            site,
            cookies: [],
            storage: [expect.objectContaining({ origin })],
          }),
        ]);
        expect(JSON.parse(savedStorage().session ?? "{}")).toMatchObject({
          who: "sam@example.com",
        });
        expect(filesHolding(launched.userDataDir, PASSWORD)).toEqual([]);
        const section = await openGeneralSettings();
        await expect(section.locator(`[data-website-sign-in="${site}"]`)).toContainText(site);
        await shoot(section, "settings-stored-sign-in-after-dark.png");
        await closeSettings();
        return task;
      });

    await test.step("the browser copies the page's refreshed storage back when it stops", async () => {
      // The crewmate opened the page again after the return, so the page counted a new visit.
      const latest = (await pageStorage())?.visit;
      expect(latest).toBeTruthy();
      expect(savedStorage().visit).not.toBe(latest);
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), a.id)).toEqual({
        ok: true,
      });
      await expect.poll(() => savedStorage().visit).toBe(latest);
    });

    const b =
      await test.step("a later task's request offers it, and one click signs its page in from storage", async () => {
        const task = await askToSignIn(second);
        expect(
          (await savedCardOf(task.id))?.actions.map((action) => ({
            label: action.label,
            default: action.default === true,
          })),
        ).toEqual([
          { label: "Leave waiting", default: false },
          { label: SIGN_IN_MYSELF_LABEL, default: false },
          { label: savedSignInLabel(site), default: true },
        ]);
        // Its browser started empty: nothing of the club's storage is in it yet.
        expect(await pageSays(app, clubUrl, "state")).toBe("Not signed in");
        expect(await pageStorage()).toEqual({});
        await showCard(page, MOCK_SAVED_CARD_TITLE);
        await shoot(page.locator(SHOWN_ENTRY), "card-stored-sign-in-after-dark.png");
        await savedCardRegion()
          .getByRole("button", { name: savedSignInLabel(site) })
          .click();
        await expect(view(page, task.id)).toBeVisible();
        await expect
          .poll(async () => (await detailTitled(second))?.outcome ?? "", { timeout: 60_000 })
          .toContain(`${MOCK_SAVED_REPORT_PREFIX} "Signed in as sam@example.com"`);
        const current = (await detailTitled(second)) as TaskDetail;
        expect(current.browser).toMatchObject({ state: "open", saved: [site] });
        expect(current.events.map((event) => event.text)).toContain(
          `you let it use your saved sign-in at ${site}`,
        );
        expect(await pageStorage()).toMatchObject({ session: expect.stringContaining("sam@") });
        await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
        await shoot(view(page, task.id), "view-stored-sign-in-granted-after-dark.png");
        expect(crewmateCalls(second).some((body) => body.includes(PASSWORD))).toBe(false);
        return task;
      });

    await test.step("Remove in Settings clears the page's storage in the browser using it", async () => {
      const section = await openGeneralSettings();
      await section
        .locator(`[data-website-sign-in="${site}"]`)
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(section.locator(`[data-website-sign-in="${site}"]`)).toHaveCount(0);
      await closeSettings();
      expect(savedSignInFiles()).toEqual([]);
      await expect.poll(pageStorage).toEqual({});
      expect(await page.evaluate((id) => window.infinitary.browser.stop(id), b.id)).toEqual({
        ok: true,
      });
      await expect.poll(async () => (await detailTitled(second))?.browser?.state).toBe("stopped");
      expect(savedSignInFiles()).toEqual([]);
    });
  } finally {
    await closeSite(club);
  }
});
