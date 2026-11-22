import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { BROWSER_COMMAND } from "../../src/core/browser/commandWords";
import { REF_FROM_BEFORE_HANDBACK } from "../../src/core/browser/outline";
import {
  BROWSER_RETURNED_OPENING,
  BROWSER_RETURNED_WORDS_LEAD,
} from "../../src/core/orchestrator/captainWakes";
import { CARD_SIZES } from "../../src/renderer/src/cards/cardGeometry";
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
import { heroShot } from "./pictures";
import { PASTE_PICTURE_PNG_BASE64, pastePictures, promptInput } from "./prompt";
import { isTaskRequest, providerMessages, providerToolCalls } from "./providerRequest";
import { expandDock, expectRecordBody, hideRecord, pressRow, recordCard, taskFact } from "./rails";
import {
  MOCK_BROWSER_SAID,
  MOCK_HANDOFF_ACTION,
  MOCK_HANDOFF_ASKED_REPORT,
  MOCK_HANDOFF_CARD_TITLE,
  MOCK_HANDOFF_HELD_QUESTION,
  MOCK_HANDOFF_REASON,
  MOCK_HANDOFF_RETURNED_REPORT,
  MOCK_HANDOFF_THREAD_ANSWERS,
  MOCK_LOCAL_RETURN_ASKED_REPORT,
  MOCK_LOCAL_RETURN_CARD_TITLE,
  MOCK_LOCAL_RETURN_REPORT,
  MOCK_LOCAL_RETURN_SAID,
  MOCK_SIGNED_IN_PICTURE,
  MOCK_SIGNED_IN_PICTURE_REASON,
  MOCK_TAKE_REFUSED_REPORT,
  MOCK_TAKE_RETURNED_REPORT,
  TASK_BROWSER_HANDOFF_MARKER,
  TASK_BROWSER_HANDOFF_READY_WORDS,
  TASK_BROWSER_LOCAL_RETURN_MARKER,
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
import { focusOn, pressWindowKey, runFromSearch } from "./windowKeys";

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
  const RETURN_WORDS = "Signed in. Use the second workspace.";
  const DOCKED_REPLIES = [
    "Which workspace should I pick on the next page?",
    "And the plan - should I switch it to Yearly?",
  ];
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
          `${MOCK_BROWSER_SAID.before} "You asked the captain to take over this task's browser, so it is paused:`,
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
        // The click answers nothing: the request docks beside the page, its
        // words and its field in reach while he works (INF-4578).
        expect((await savedCard())?.status).toBe("ready");
        const docked = view(page, task.id).locator("[data-browser-request]");
        await expect(docked).toHaveAttribute("data-browser-request", (await savedCard())?.id ?? "");
        await expect(docked).toContainText(MOCK_HANDOFF_CARD_TITLE);
        // The page beside it is its door, so it draws no choice of its own.
        await expect(docked.getByRole("button", { name: MOCK_HANDOFF_ACTION })).toHaveCount(0);
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
      // The request is still up, so the stack shows it again, its line
      // saying the page is his; its key opens the task's record.
      await showCard(page, MOCK_HANDOFF_CARD_TITLE);
      await expect(strip).toHaveAttribute("data-attachment-handoff", "captain");
      await cardRegion.getByRole("link", { name: task.key }).click();
      await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      await expectRecordBody(page);
      const line = taskFact(recordCard(page), "browser");
      await expect(line).toContainText(DRIVER_WORDS.captain);
      await line.locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      const sharing = view(page, task.id).locator("[data-browser-sharing]");
      await expect(sharing).toContainText(RETURN_CONTROL_NOTICE);
      // Opened from the record, the view still docks the request it holds.
      await expect(view(page, task.id).locator("[data-browser-request]")).toContainText(
        MOCK_HANDOFF_CARD_TITLE,
      );
      await shoot(view(page, task.id), "view-sharing-notice-dark.png");
      expect((await detail())?.browser).toMatchObject({ control: "captain" });
      expect(crewmateCalls()).toHaveLength(calls);
    });

    await test.step("returning wakes the crewmate once, for a fresh look with every old ref gone", async () => {
      const returnControl = view(page, task.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: RETURN_CONTROL_LABEL });
      // The card's one key reaches the docked request's field, and the words
      // he leaves there go with Return control.
      const field = view(page, task.id).locator(
        "[data-browser-request] [data-card-reply] textarea",
      );
      await focusOn(returnControl);
      await pressWindowKey(launched.app, "l", ["meta", "shift"]);
      await expect(field).toBeFocused();
      // Each reply from the field lands in the request's thread beside the
      // page, and the crewmate's answer paints under it while the page stays his.
      const thread = view(page, task.id).locator("[data-browser-request] [data-card-thread]");
      for (const [round, words] of DOCKED_REPLIES.entries()) {
        await field.fill(words);
        await field.press("Enter");
        await expect(thread).toContainText(words);
        await expect(thread).toContainText(MOCK_HANDOFF_THREAD_ANSWERS[round] as string, {
          timeout: 30_000,
        });
      }
      expect((await detail())?.browser).toMatchObject({ control: "captain" });
      await shoot(view(page, task.id), "view-thread-rounds-dark.png");
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-thread-rounds-light.png");
        await setThemeViaSettings(page, "dark");
      }
      // Go to the browser page, chosen from command search, puts his keys
      // back on the page beside the column.
      await runFromSearch(launched.app, page, "browser.page");
      await expect(view(page, task.id).locator("[data-browser-page]")).toBeFocused();
      // INF-4578's direction A: on a narrow window the request folds to its
      // latest line, Command-backslash opens and folds it, and the page
      // keeps up to 1,040px, the column added beside it.
      const pageArea = view(page, task.id).locator("[data-browser-page]");
      const column = view(page, task.id).locator("aside[data-browser-request]");
      const folded = view(page, task.id).locator("[data-browser-request-folded]");
      const pageWidth = async () => Math.round((await pageArea.boundingBox())?.width ?? 0);
      await resizeWindow(app, page, { width: 960, height: 900 });
      await expect(folded).toContainText(MOCK_HANDOFF_THREAD_ANSWERS[1] as string);
      await expect(column).toHaveCount(0);
      if (evidence)
        await heroShot(launched.app, page, {
          region: view(page, task.id),
          name: "browser-request-folds-narrow",
        });
      // The card's one key opens the column and reaches its field.
      await pressWindowKey(launched.app, "l", ["meta", "shift"]);
      await expect(column).toBeVisible();
      await expect(field).toBeFocused();
      // From the field, Command-backslash folds it again, focus on its line.
      await pressWindowKey(launched.app, "\\", ["meta"]);
      await expect(column).toHaveCount(0);
      await expect(folded.locator("[data-thread-cue]")).toBeFocused();
      // Folded by his choice, it stays folded on a wide window, and the page
      // takes the view's whole width.
      await resizeWindow(app, page, { width: 1600, height: 900 });
      await expect(folded).toBeVisible();
      await expect.poll(pageWidth).toBeGreaterThanOrEqual(CARD_SIZES.full - 2);
      const alone = await pageWidth();
      // Opened, the column joins the page without narrowing it.
      await focusOn(pageArea);
      await pressWindowKey(launched.app, "\\", ["meta"]);
      await expect(column).toBeVisible();
      await expect(folded).toHaveCount(0);
      await expect(pageArea).toBeFocused();
      await expect.poll(pageWidth).toBe(alone);
      await resizeWindow(app, page, { width: 1280, height: 900 });
      // A reply that waits on the crewmate goes aside with the view, as a
      // replied-under card does, and the request comes back with its answer;
      // the page is still his.
      const mock = launched.mockProvider;
      if (!mock) throw new Error("This journey needs the mock provider.");
      await field.fill(MOCK_HANDOFF_HELD_QUESTION);
      await field.press("Enter");
      await expect(thread).toContainText(MOCK_HANDOFF_HELD_QUESTION);
      await expect.poll(() => mock.heldThreadAnswers()).toBe(1);
      await view(page, task.id).getByRole("button", { name: "Hide" }).click();
      await expect(page.locator(`[data-task-browser="${task.id}"]`)).toBeHidden();
      await expect.poll(async () => (await savedCard())?.minimized ?? false).toBe(true);
      expect((await detail())?.browser).toMatchObject({ control: "captain" });
      mock.releaseThreadAnswer();
      await expect
        .poll(async () => (await savedCard())?.minimized ?? false, { timeout: 30_000 })
        .toBe(false);
      await showCard(page, MOCK_HANDOFF_CARD_TITLE);
      await expect(page.locator(SHOWN_ENTRY)).toContainText(
        MOCK_HANDOFF_THREAD_ANSWERS[2] as string,
      );
      await shoot(page.locator(SHOWN_ENTRY), "card-back-with-answer-dark.png");
      // The page is still his, so the record's browser line opens it again.
      await cardRegion.getByRole("link", { name: task.key }).click();
      await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      await expect(view(page, task.id).locator("[data-browser-request]")).toContainText(
        MOCK_HANDOFF_CARD_TITLE,
      );
      await field.fill(RETURN_WORDS);
      await shoot(view(page, task.id), "view-request-docked-dark.png");
      if (evidence)
        await heroShot(launched.app, page, {
          region: view(page, task.id),
          name: "browser-request-beside-page",
        });
      await returnControl.click();
      // Return control takes the request down with the column.
      await expect(view(page, task.id).locator("[data-browser-request]")).toHaveCount(0);
      await expect.poll(async () => (await savedCard())?.status ?? "gone").not.toBe("ready");
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
        `${MOCK_BROWSER_SAID.freshLook} "The captain returned control of this browser:`,
      );
      expect(outcome).toContain(`${MOCK_BROWSER_SAID.page} "Signed in as sam@example.com"`);
      // What the page logged and asked for while he held it never reached it.
      expect(outcome).toContain(`It kept ${MOCK_BROWSER_SAID.keptNothing}.`);
      // The page may show his account now: a picture only for a reason the
      // task has, and his record says so.
      expect(outcome).toContain(
        `${MOCK_BROWSER_SAID.noReason} "The captain handed this browser back, so its pages may show the captain's account: a picture is taken only when the task needs one.`,
      );
      expect(outcome).toContain(`${MOCK_BROWSER_SAID.withReason} "Saved the visible page as `);
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
      expect(woken[0]?.text).toContain(`${BROWSER_RETURNED_WORDS_LEAD}\n${RETURN_WORDS}`);
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

// The captain's choice on INF-4587's review: "Both: the plain limit line and
// pictures sent as a reply". A return carries words alone, so a picture in
// the docked field goes first as an ordinary reply, words and all.
test("a picture left in the docked request's field goes to the crewmate as a reply before Return control", async () => {
  test.setTimeout(180_000);
  const { page } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const account = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("yes");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(ACCOUNT_PAGE);
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const accountUrl = `http://127.0.0.1:${(account.address() as AddressInfo).port}/`;
  const title = `${TASK_BROWSER_HANDOFF_MARKER}${accountUrl}`;
  const WORDS = "This is the form I see after signing in.";
  const crewmateCalls = () =>
    (launched.mockProvider?.requestBodies() ?? []).filter((body) => isTaskRequest(body, title));
  try {
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await promptInput(page).press("Enter");
    // Its crewmate asks and pauses its browser, as in the journey above.
    let taskId = "";
    await expect
      .poll(
        async () => {
          taskId = await page.evaluate(async (wanted) => {
            const row = (await window.infinitary.tasks.board()).tasks.find(
              (task) => task.title === wanted,
            );
            const detail = row ? await window.infinitary.tasks.detail(row.id) : null;
            const browser = detail?.browser;
            return browser?.state === "open" && browser.control === "waiting"
              ? (row?.id ?? "")
              : "";
          }, title);
          return taskId;
        },
        { timeout: 60_000 },
      )
      .not.toBe("");
    const requestOf = async () =>
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) =>
          card.taskId === taskId &&
          card.title === MOCK_HANDOFF_CARD_TITLE &&
          card.status === "ready",
      );
    await expect.poll(async () => (await requestOf())?.id ?? "", { timeout: 60_000 }).not.toBe("");
    const request = await requestOf();
    if (!request) throw new Error("The crewmate's request card is missing.");
    await showCard(page, MOCK_HANDOFF_CARD_TITLE);
    await shownCard(page, MOCK_HANDOFF_CARD_TITLE)
      .getByRole("button", { name: MOCK_HANDOFF_ACTION })
      .click();
    await expect(view(page, taskId)).toHaveAttribute("data-browser-state", "captain");
    const field = view(page, taskId).locator("[data-browser-request] [data-card-reply] textarea");
    await field.fill(WORDS);
    await pastePictures(field, [{ name: "form.png" }]);
    await expect(
      view(page, taskId).locator("[data-browser-request] [data-card-reply-picture]"),
    ).toHaveCount(1);
    await shoot(view(page, taskId), "view-return-with-picture-dark.png");
    await view(page, taskId)
      .locator("[data-browser-chrome]")
      .getByRole("button", { name: RETURN_CONTROL_LABEL })
      .click();
    // The reply carried the words and the picture to the crewmate's thread.
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.infinitary.cards.thread(id), request.id)).messages.some(
          (message) => message.who === "captain" && message.text.startsWith(WORDS),
        ),
      )
      .toBe(true);
    await expect
      .poll(() => crewmateCalls().some((body) => body.includes(PASTE_PICTURE_PNG_BASE64)), {
        timeout: 30_000,
      })
      .toBe(true);
    // The return went with no words of its own: its one wake carries none.
    await expect
      .poll(
        () =>
          crewmateCalls().flatMap((body) =>
            providerMessages(body).filter((message) =>
              message.text.startsWith(BROWSER_RETURNED_OPENING),
            ),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const woken = crewmateCalls()
      .flatMap((body) => providerMessages(body))
      .filter((message) => message.text.startsWith(BROWSER_RETURNED_OPENING));
    expect(woken.some((message) => message.text.includes(BROWSER_RETURNED_WORDS_LEAD))).toBe(false);
    await expect(view(page, taskId).locator("[data-browser-request]")).toHaveCount(0);
  } finally {
    await stopTaskBrowsers(page);
    await closeSite(account);
  }

  async function shoot(target: Locator, name: string): Promise<void> {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
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
        `${MOCK_BROWSER_SAID.commandBefore} "Waited 10 seconds; "${TASK_BROWSER_HANDOFF_READY_WORDS}" did not appear.`,
      );
      expect(outcome).toContain(
        `${MOCK_BROWSER_SAID.refusal} "The captain has control of this task's browser:`,
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
        `${MOCK_BROWSER_SAID.freshLook} "The captain returned control of this browser:`,
      );
      expect(outcome).toContain(`${MOCK_BROWSER_SAID.page} "Signed in as sam@example.com"`);
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

// INF-5578's audit, finding 2: a sign-in the captain made ended on a
// program's address on this computer the crewmate never opened, the page
// read only the browser's own "is blocked", and the captain signed in three
// times. The captain then chose ("yeah we should do that") to let a page's
// own move open a local address, while a website's hidden requests to this
// computer stay refused.
test("a sign-in that returns to a program on this computer reaches it on the first try, and a website's hidden request does not", async () => {
  // One journey across two crewmate turns and the captain's own sign-in.
  test.setTimeout(180_000);
  const { page, app } = launched;
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const shoot = async (target: Locator, name: string): Promise<void> => {
    if (evidence) await target.screenshot({ path: join(evidence, name) });
  };
  const CODE = "sign-in-code-7f3a91";
  const SIGNED_IN = "Program signed in";
  // The program on this computer the sign-in returns to: it says it is
  // signed in only when its return brings the code, loads a part of its
  // own, and records each visit. Its empty icon keeps a browser from asking
  // it for one, so its visits are only what its page asks for.
  const visits: string[] = [];
  const program = createServer((request, response) => {
    visits.push(request.url ?? "");
    if (request.url === "/part.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end("#said { font-weight: bold; }");
      return;
    }
    const said = request.url === `/auth/callback?code=${CODE}` ? SIGNED_IN : "Program waiting";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>Program</title><link rel="icon" href="data:,"><style>body { font: 28px sans-serif; margin: 32px; }</style><link rel="stylesheet" href="/part.css"><p id="said">${said}</p>`,
    );
  });
  await new Promise<void>((resolve) => program.listen(0, "127.0.0.1", resolve));
  const programSite = `127.0.0.1:${(program.address() as AddressInfo).port}`;
  // The site's sign-in, whose Sign in redirects to the program with the code,
  // as a real one does; its page also asks the program for something behind
  // the page's back, as a hostile website could, and records each load.
  const accountLoads: string[] = [];
  const account = createServer((request, response) => {
    accountLoads.push(request.url ?? "");
    if (request.url === "/authorize") {
      response.writeHead(302, { location: `http://${programSite}/auth/callback?code=${CODE}` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>Sign in</title><style>body { background: rgb(40, 90, 160); color: white; font: 18px sans-serif; } a { color: white; }</style><h1>Sign in</h1><img alt="" src="http://${programSite}/hidden.png"><p><a id="sign-in" href="/authorize">Sign in and return to the program</a></p>`,
    );
  });
  await new Promise<void>((resolve) => account.listen(0, "127.0.0.1", resolve));
  const accountUrl = `http://127.0.0.1:${(account.address() as AddressInfo).port}/`;
  const title = `${TASK_BROWSER_LOCAL_RETURN_MARKER}${accountUrl}`;
  const detail = async (): Promise<TaskDetail> =>
    page.evaluate(async (wanted) => {
      const row = (await window.infinitary.tasks.board()).tasks.find(
        (task) => task.title === wanted,
      );
      return (row ? await window.infinitary.tasks.detail(row.id) : null) as TaskDetail;
    }, title);
  try {
    await resizeWindow(app, page, { width: 1280, height: 900 });
    await stopTaskBrowsers(page);
    const task = await test.step("its crewmate asks the captain to sign in", async () => {
      await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
      await promptInput(page).press("Enter");
      await expect
        .poll(async () => (await detail().catch(() => null))?.outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_LOCAL_RETURN_ASKED_REPORT);
      return detail();
    });

    await test.step("the sign-in returns to the program, which signs in with the code", async () => {
      await showCard(page, MOCK_LOCAL_RETURN_CARD_TITLE);
      await shownCard(page, MOCK_LOCAL_RETURN_CARD_TITLE)
        .getByRole("button", { name: MOCK_HANDOFF_ACTION })
        .click();
      await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
      await clickOnPage(app, page, task.id, accountUrl, "sign-in");
      await expect
        .poll(async () => (await detail()).browser, { timeout: 30_000 })
        .toMatchObject({ state: "open", site: programSite, control: "captain", title: "Program" });
      expect((await detail()).browser).not.toHaveProperty("blocked");
      await expect(view(page, task.id).locator('[data-browser-notice="blocked"]')).toHaveCount(0);
      // The program's page loaded its own part; the sign-in page's hidden request never reached it.
      await expect.poll(() => visits).toEqual([`/auth/callback?code=${CODE}`, "/part.css"]);
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(1);
      await shoot(view(page, task.id), "view-program-reached-held-dark.png");
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await shoot(view(page, task.id), "view-program-reached-held-light.png");
        await setThemeViaSettings(page, "dark");
      }
    });

    await test.step("Return control: the crewmate's first look reads the signed-in program", async () => {
      await view(page, task.id)
        .locator("[data-browser-chrome]")
        .getByRole("button", { name: RETURN_CONTROL_LABEL })
        .click();
      await expect
        .poll(async () => (await detail()).outcome ?? "", { timeout: 60_000 })
        .toContain(MOCK_LOCAL_RETURN_REPORT);
      expect((await detail()).outcome).toContain(`${MOCK_LOCAL_RETURN_SAID} "${SIGNED_IN}"`);
      // The crewmate opened the sign-in page again after the program was
      // reached, so its hidden request was asked when only the program's own
      // page may reach the program.
      expect(accountLoads.filter((load) => load === "/")).toHaveLength(2);
      // One sign-in: the program was reached once, with the code.
      expect(visits.filter((visit) => visit.startsWith("/auth/callback"))).toEqual([
        `/auth/callback?code=${CODE}`,
      ]);
      expect(visits).not.toContain("/hidden.png");
    });
  } finally {
    await closeSite(account);
    await closeSite(program);
  }
});
