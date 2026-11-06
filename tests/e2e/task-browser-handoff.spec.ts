import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { BROWSER_COMMAND } from "../../src/core/browser/commandWords";
import { REF_FROM_BEFORE_HANDBACK } from "../../src/core/browser/outline";
import { BROWSER_RETURNED_OPENING } from "../../src/core/orchestrator/captainWakes";
import { MAXIMIZE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import {
  BROWSER_DOOR_LABEL,
  DRIVER_WORDS,
  FRESH_LOOK_WORDS,
  RETURN_CONTROL_LABEL,
  RETURN_CONTROL_NOTICE,
  RETURNED_CAPTION,
  TAKE_CONTROL_LABEL,
  TASK_BROWSER_PAGE,
  VIEW_DRIVER_WORDS,
} from "../../src/shared/taskBrowser";
import { browserShellMessages } from "./browserScript";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { isTaskRequest, providerMessages, providerToolCalls } from "./providerRequest";
import { expandDock, expectRecordBody, hideRecord, pressRow, recordCard, taskFact } from "./rails";
import {
  MOCK_HANDOFF_ACTION,
  MOCK_HANDOFF_ASKED_REPORT,
  MOCK_HANDOFF_CARD_TITLE,
  MOCK_HANDOFF_REASON,
  MOCK_HANDOFF_RETURNED_REPORT,
  MOCK_SIGNED_IN_PICTURE,
  MOCK_SIGNED_IN_PICTURE_REASON,
  MOCK_TAKE_REFUSED_REPORT,
  MOCK_TAKE_RETURNED_REPORT,
  TASK_BROWSER_HANDOFF_MARKER,
  TASK_BROWSER_HANDOFF_READY_WORDS,
  TASK_BROWSER_TAKE_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  canvasReading,
  clickOnPage,
  closeSite,
  filesHolding,
  onPage,
  pageFillsView,
  pageSays,
  pasteOnView,
  SIZE,
  stopTaskBrowsers,
  typeOnPage,
  browserView as view,
} from "./taskBrowser";
import { setThemeViaSettings } from "./theme";

/**
 * A task's browser handed between its crewmate and the captain
 * (docs/task-browser.md, "Taking control" and "Asking for help"). A
 * crewmate asks the captain to sign in, and the captain takes its browser,
 * signs in and hands it back; and the captain takes a task's browser while
 * its crewmate's command runs, and nothing the captain types is kept. Each
 * journey serves its own account page on this Mac.
 *
 * The crewmate is the mock provider's script (`taskBrowserJourneys`): it
 * acts only on refs the real outline gave it and reports what the real page
 * said, so the report is the page's own words passed through the product.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true, scenarios: [taskBrowserJourneys] });
});

test.afterAll(async () => {
  await launched.close();
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
    <p><label>Plan <select id="plan"><option id="plan-monthly" value="monthly">Monthly</option><option id="plan-yearly" value="yearly">Yearly</option></select></label></p>
    <p><label>Note <input id="note"></label></p>
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
      (launched.mockProvider?.requestBodies() ?? []).filter((body) => isTaskRequest(body, title));
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
    (launched.mockProvider?.requestBodies() ?? []).filter((body) => isTaskRequest(body, title));
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
      // What the crewmate heard is read the way it reads it: on a loaded Mac
      // a look may itself pass the shell's limit, and its answer then arrives
      // as a background job's message rather than a tool result (INF-1597).
      const last = crewmateCalls().at(-1) ?? "{}";
      const heard = browserShellMessages(providerMessages(last))
        .readings.filter((message) => message.role === "tool")
        .map((message) => message.text);
      const running = heard.findIndex((text) => /^running: wait$/m.test(text));
      const earlier = heard.findIndex((text) =>
        /^earlier: Your earlier wait finished$/m.test(text),
      );
      expect(running).toBeGreaterThanOrEqual(0);
      expect(earlier).toBeGreaterThan(running);
      const waits = providerToolCalls(last).filter((call) =>
        String(call.args.command ?? "").startsWith(`${BROWSER_COMMAND} wait `),
      );
      expect(waits).toHaveLength(2);
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

    // The captain's words (INF-1742): "dropdown inputs can't actually show the
    // dropdown... when clicked, they do nothing", and "i can't paste text in
    // clipboard into the task browser".
    await test.step("he opens a dropdown on the picture and picks from its list, and pastes words from the captain's own computer", async () => {
      await clickOnPage(launched.app, page, task.id, accountUrl, "plan");
      // The list is drawn in the page, so its option has a place to press.
      await expect
        .poll(() =>
          onPage(launched.app, accountUrl, 'document.getElementById("plan-yearly").offsetHeight'),
        )
        .toBeGreaterThan(0);
      await clickOnPage(launched.app, page, task.id, accountUrl, "plan-yearly");
      await expect.poll(() => pageSays(launched.app, accountUrl, "plan", "value")).toBe("yearly");

      // The paste carries the captain's own computer's words, which need not
      // be on the clipboard of the computer the page runs on.
      const words = "pasted from the captain's own computer";
      await clickOnPage(launched.app, page, task.id, accountUrl, "note");
      await expect
        .poll(() => onPage(launched.app, accountUrl, "document.activeElement?.id ?? null"))
        .toBe("note");
      await pasteOnView(view(page, task.id).locator("[data-browser-page]"), words);
      await expect.poll(() => pageSays(launched.app, accountUrl, "note", "value")).toBe(words);
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
