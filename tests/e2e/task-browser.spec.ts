import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { REF_FROM_EARLIER_PAGE } from "../../src/core/browser/outline";
import { HERE } from "../../src/shared/deviceNames";
import { TASK_BROWSER_PAGE } from "../../src/shared/taskBrowser";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import {
  MOCK_BROWSER_PICTURE,
  MOCK_BROWSER_REPORT_PREFIX,
  TASK_BROWSER_PROMPT_MARKER,
  taskBrowser,
} from "./scenarios/taskBrowser";
import {
  MOCK_BROWSER_LONG_PICTURE,
  MOCK_BROWSER_LONG_REPORT_PREFIX,
  MOCK_BROWSER_READING_PICTURE,
  MOCK_BROWSER_READING_REPORT_PREFIX,
  MOCK_FENCE_A_REPORT,
  MOCK_FENCE_B_REPORT,
  TASK_BROWSER_FENCE_MARKER,
  TASK_BROWSER_LONG_LAST_WORDS,
  TASK_BROWSER_LONG_MARKER,
  TASK_BROWSER_READING_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { closeSite, stopTaskBrowsers, windowCount } from "./taskBrowser";

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
  <head>
    <title>Changelog</title>
    <style>
      html, body, main { margin: 0; background: white; }
      h1, nav, section { display: flow-root; margin: 0; padding: 8px 16px; background: #e0f3ff; color: #003366; }
    </style>
  </head>
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
    scenarios: [taskBrowserJourneys, taskBrowser],
    // A public name that leads to this Mac, as a rebinding name server would answer.
    env: { INFINITARY_TASK_BROWSER_HOSTS: JSON.stringify({ "rebind.example": ["127.0.0.1"] }) },
  });
});

test.afterAll(async () => {
  await launched.close();
  await closeSite(site);
});

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
  // The picture taken after the scroll shows the rows on screen, never the
  // rows above them as a blank band (INF-2375): every release fills its row
  // with color, so a row that is white from edge to edge was not drawn.
  const picture = join(
    launched.userDataDir,
    "crewmates",
    task.id,
    "evidence",
    `${MOCK_BROWSER_LONG_PICTURE}.png`,
  );
  expect(existsSync(picture)).toBe(true);
  if (evidence) copyFileSync(picture, join(evidence, "task-browser-scrolled-picture.png"));
  const rows = await launched.app.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path);
    const { width, height } = image.getSize();
    const pixels = image.toBitmap();
    let blank = 0;
    for (let y = 0; y < height; y += 1) {
      let drawn = false;
      for (let x = 0; x < width && !drawn; x += 1) {
        const at = (y * width + x) * 4;
        drawn = [0, 1, 2].some((channel) => (pixels[at + channel] ?? 255) < 245);
      }
      if (!drawn) blank += 1;
    }
    return { height, blank };
  }, picture);
  expect(rows.height).toBeGreaterThan(0);
  expect(rows.blank).toBe(0);
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
