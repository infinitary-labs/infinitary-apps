import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { TaskDetail } from "@shared/tasks";
import { FORM_RESEND_CAPTAIN_WORDS } from "../../src/core/browser/taskBrowsers";
import { BROWSER_GONE_OPENING, BROWSER_RETURNED_OPENING } from "../../src/core/orchestrator/wakes";
import { CREWMATE_BROWSER_LINE } from "../../src/core/pi/piResources";
import {
  DRIVER_WORDS,
  RETURN_CONTROL_LABEL,
  TAKE_CONTROL_LABEL,
} from "../../src/shared/taskBrowser";
import { launchClaudeCrew } from "./claudeCrew";
import {
  BOOKING_REFERENCE,
  PAY_TOTAL,
  SEARCH_FARE,
  SYNTHETIC_CARD,
  SYNTHETIC_CODE,
  SYNTHETIC_EMAIL,
  SYNTHETIC_EXPIRY,
  SYNTHETIC_PASSWORD,
  startFakeAirline,
} from "./fakeAirline";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import {
  bookedNoteTitle,
  CLAUDE_CREWMATE_MARKER,
  fareRoseWords,
  MOCK_AIRLINE_SIGN_IN_REPORT,
  MOCK_AIRLINE_SIGN_IN_TITLE,
  MOCK_BOOKED_BUTTON,
  MOCK_BOOKED_REPORT_PREFIX,
  MOCK_BROWSER_REPORT_PREFIX,
  MOCK_FARES_ASKED_REPORT,
  MOCK_FARES_BUTTON,
  MOCK_FARES_CARD_TITLE,
  MOCK_FARES_CHOICE,
  MOCK_LOST_ASKED_AGAIN_REPORT,
  MOCK_LOST_ASKED_REPORT,
  MOCK_LOST_CHECK_ACTION,
  MOCK_LOST_NOT_BOOKED_ACTION,
  MOCK_LOST_REPORT_PREFIX,
  MOCK_REVIEW_PAY_ACTION,
  MOCK_REVIEW_REPORT_PREFIX,
  MOCK_REVIEW_STOP_ACTION,
  MOCK_SIGN_IN_CLOSED_REPORT,
  MOCK_UNPAID_ASKED_REPORT,
  MOCK_UNPAID_FIELDS,
  MOCK_UNPAID_PICTURE,
  MOCK_UNPAID_REPORT_PREFIX,
  type MockProviderServer,
  reviewCardTitle,
  SPAWN_PROMPT_MARKER,
  startMockProvider,
  TASK_BROWSER_BOOKING_MARKER,
  TASK_BROWSER_LOST_MARKER,
  TASK_BROWSER_PROMPT_MARKER,
  TASK_BROWSER_UNPAID_MARKER,
  unknownCardTitle,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import { atRest, expandDock, expectRecordBody, pressRow, recordCard, taskFact } from "./rails";
import { SHOWN_ENTRY, showCard, shownCard, shownCardFrame } from "./stack";
import {
  canvasReading,
  clickOnPage,
  closeSite,
  filesHolding,
  pageSays,
  typeOnPage,
  browserView as view,
} from "./taskBrowser";

/**
 * A final submission in a task's browser (docs/task-browser.md, "A final
 * submission"), the captain's answer `submission: captain` on the FI3-835
 * design: a crewmate prepares a booking up to its last step and stops on an
 * ordinary review card; the captain makes the payment himself, on the
 * airline's own page, under his control; handed back, the crewmate reads
 * the confirmation. A payment the airline never confirms is checked and
 * asked about, never sent again - not by the browser, and not by the app
 * redelivering the crewmate's work after a restart.
 *
 * Each journey runs on a Pi crewmate and on a Claude crewmate, whose turns
 * cross the Claude client's real tool protocol (tests/e2e/claudeCrew.ts).
 * The crewmate is the mock provider's script (`taskBrowserBookingStep`,
 * `taskBrowserLostStep`), acting only on refs the real outline gave it.
 * The airline, its account and its card are invented
 * (tests/e2e/fakeAirline.ts); it counts every payment it is sent.
 */

type Runtime = {
  name: "Pi" | "Claude";
  /** What a commission's title carries so its crewmate runs here. */
  suffix: string;
  launch: (
    options: Pick<LaunchOptions, "reuseMockProvider" | "userDataDir" | "homeDir" | "env">,
  ) => Promise<LaunchedApp>;
};

const RUNTIMES: Runtime[] = [
  {
    name: "Pi",
    suffix: "",
    launch: (options) =>
      launchApp(options.reuseMockProvider ? options : { ...options, withMockProvider: true }),
  },
  {
    name: "Claude",
    suffix: ` ${CLAUDE_CREWMATE_MARKER}`,
    launch: (options) => launchClaudeCrew(options),
  },
];

/** Ask Firstmate for one piece of work, and answer its record by the title it was given. */
async function commission(app: LaunchedApp, title: string): Promise<() => Promise<TaskDetail>> {
  const input = promptInput(app.page);
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${title}`);
  await input.press("Enter");
  const read = (): Promise<TaskDetail | null> =>
    app.page.evaluate(
      async (start) => {
        // The board may shorten a long title; its start names this task alone.
        const row = (await window.infinitary.tasks.board()).tasks.find((task) =>
          task.title.startsWith(start),
        );
        return row ? window.infinitary.tasks.detail(row.id) : null;
      },
      title.slice(0, 60),
    );
  await expect.poll(async () => (await read())?.id ?? "", { timeout: 60_000 }).not.toBe("");
  return async () => (await read()) as TaskDetail;
}

/** Wait for the crewmate's latest report to carry these words, and answer the record. */
async function reported(
  detail: () => Promise<TaskDetail>,
  words: string,
  timeout = 90_000,
): Promise<TaskDetail> {
  await expect.poll(async () => (await detail()).outcome ?? "", { timeout }).toContain(words);
  return detail();
}

/** The task's browser while it is open: its page's title and what the crewmate did last. */
function openBrowser(task: TaskDetail) {
  return task.browser?.state === "open" ? task.browser : undefined;
}

/** One of the task's cards, as the app keeps it, by its title. */
async function cardTitled(page: Page, taskId: string, title: string) {
  return (await page.evaluate(() => window.infinitary.cards.list())).find(
    (card) => card.taskId === taskId && card.title === title,
  );
}

/**
 * Whether a model call is a crewmate's whose task has a browser: its
 * instructions carry the browser's one line (docs/axi-commands.md).
 */
function withBrowser(body: string): boolean {
  return body.includes(JSON.stringify(CREWMATE_BROWSER_LINE).slice(1, -1));
}

/** The model calls of a crewmate with a browser on this task: none may go out while the captain holds it. */
function crewmateCalls(app: LaunchedApp, title: string): string[] {
  return (app.mockProvider?.requestBodies() ?? []).filter(
    (body) => body.includes(title) && withBrowser(body),
  );
}

/**
 * Whether every model call of this task's crewmate came through the
 * runtime the journey names: the Claude client says so in its user agent,
 * and Pi never does.
 */
function servedBy(app: LaunchedApp, title: string, runtime: Runtime): boolean {
  const bodies = app.mockProvider?.requestBodies() ?? [];
  const headers = app.mockProvider?.requestHeaders() ?? [];
  const agents = bodies.flatMap((body, index) =>
    body.includes(title) && withBrowser(body) ? [headers[index]?.["user-agent"] ?? ""] : [],
  );
  return (
    agents.length > 0 &&
    agents.every((agent) => agent.startsWith("claude-cli/") === (runtime.name === "Claude"))
  );
}

/** Pictures for the merge card, when a run keeps evidence. */
function photographer(runtime: Runtime): (target: Locator, name: string) => Promise<void> {
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  return async (target, name) => {
    if (evidence) await target.screenshot({ path: join(evidence, `${runtime.name}-${name}`) });
  };
}

/** Take control in a view the captain opened, and wait until the page is his. */
async function takeControl(page: Page, taskId: string): Promise<void> {
  await view(page, taskId)
    .locator("[data-browser-chrome]")
    .getByRole("button", { name: TAKE_CONTROL_LABEL })
    .click();
  await expect(view(page, taskId)).toHaveAttribute("data-browser-state", "captain", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
}

/** Return control, answering the one question it asks. */
async function returnControl(page: Page, taskId: string): Promise<void> {
  await view(page, taskId)
    .locator("[data-browser-chrome]")
    .getByRole("button", { name: RETURN_CONTROL_LABEL })
    .click();
  await view(page, taskId)
    .locator("[data-browser-return-question]")
    .getByRole("button", { name: RETURN_CONTROL_LABEL })
    .click();
}

/** The captain types his card details into the airline's page, and sends nothing. */
async function cardOnPage(app: LaunchedApp, taskId: string, siteUrl: string): Promise<void> {
  await typeOnPage(app.app, app.page, taskId, siteUrl, "card", SYNTHETIC_CARD);
  await typeOnPage(app.app, app.page, taskId, siteUrl, "expiry", SYNTHETIC_EXPIRY);
  await typeOnPage(app.app, app.page, taskId, siteUrl, "code", SYNTHETIC_CODE);
}

/** The captain pays on the airline's page: card details, then Pay. */
async function payOnPage(app: LaunchedApp, taskId: string, siteUrl: string): Promise<void> {
  await cardOnPage(app, taskId, siteUrl);
  await clickOnPage(app.app, app.page, taskId, siteUrl, "pay");
}

/**
 * Whether a crewmate's model calls carry what the captain typed: the card
 * number anywhere, and the expiry and code as words of their own, so a
 * port or a reference that merely contains their digits is not counted.
 */
function callsHoldCard(app: LaunchedApp, title: string): string[] {
  const words = [SYNTHETIC_CARD, SYNTHETIC_EXPIRY, SYNTHETIC_CODE];
  const texts = crewmateCalls(app, title).flatMap((body) =>
    providerMessages(body).map((message) => message.text),
  );
  return words.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return texts.some((text) => new RegExp(`(?<![\\w/])${escaped}(?![\\w/])`).test(text));
  });
}

/** Open a task's record from the Tasks dock, and its browser from the record's Browser line. */
async function openFromRecord(page: Page, task: TaskDetail): Promise<Locator> {
  await expandDock(page, "now");
  await pressRow(page, task.key);
  await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
  const line = taskFact(recordCard(page), "browser");
  await expect(line).toBeVisible();
  // The record lays out around its body's page once that page draws, and a
  // press while the line still moves lands on whatever moved under it.
  await expectRecordBody(page);
  await atRest(page, line);
  return line;
}

/** The sign-up page the local check reads (the same page task-browser.spec.ts checks on Pi). */
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
    <script>
      const app = typeof window.infinitary !== "undefined" || typeof process !== "undefined";
      document.getElementById("reach").textContent = app ? "This page reaches the app" : "This page cannot reach the app";
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

for (const runtime of RUNTIMES) {
  test.describe(`${runtime.name} crewmates`, () => {
    let launched: LaunchedApp;

    test.beforeAll(async () => {
      launched = await runtime.launch({});
      await resizeWindow(launched.app, launched.page, { width: 1280, height: 900 });
    });

    test.afterAll(async () => {
      await launched.close();
    });

    // A Pi crewmate's local check is task-browser.spec.ts's first journey.
    if (runtime.name === "Claude") {
      test("a Claude crewmate checks a local page in its task's own browser", async () => {
        const site = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(SIGN_UP_PAGE);
        });
        await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
        const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
        try {
          const detail = await commission(
            launched,
            `${TASK_BROWSER_PROMPT_MARKER}${siteUrl} as Sam${runtime.suffix}`,
          );
          const task = await reported(detail, MOCK_BROWSER_REPORT_PREFIX);
          // The page's own words through the Claude client's tool protocol:
          // real input, its site data across a reload, and no way into the app.
          expect(task.outcome).toContain(
            `"Not signed up yet" first, "Thanks, Sam" after Send and "Signed up as Sam" after a reload`,
          );
          expect(task.outcome).toContain('"This page cannot reach the app"');
          expect(task.outcome).toContain(`localhost:${new URL(siteUrl).port} on this Mac.`);
          expect(task.browser).toMatchObject({ state: "stopped", stopped: "crewmate" });
          expect(servedBy(launched, `${siteUrl} as Sam`, runtime)).toBe(true);
        } finally {
          await closeSite(site);
        }
      });
    }

    test(`a ${runtime.name} crewmate books a flight, and the captain signs in and pays on the page himself`, async () => {
      // One journey across five crewmate turns, the captain's sign-in and his payment.
      test.setTimeout(420_000);
      const { page } = launched;
      const shoot = photographer(runtime);
      const airline = await startFakeAirline();
      const title = `${TASK_BROWSER_BOOKING_MARKER}${airline.url} for Sam Rivera${runtime.suffix}`;
      const strip = page.locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`);
      try {
        const detail = await commission(launched, title);

        const task =
          await test.step("it compares the fares and asks which to prepare, the search a click away", async () => {
            const current = await reported(detail, MOCK_FARES_ASKED_REPORT);
            expect(current.outcome).not.toContain("Card refused");
            expect(await cardTitled(page, current.id, MOCK_FARES_CARD_TITLE)).toMatchObject({
              attachment: { kind: "browser", label: MOCK_FARES_BUTTON, taskId: current.id },
            });
            await showCard(page, MOCK_FARES_CARD_TITLE);
            await expect(strip.locator("[data-attachment-line]")).toContainText(airline.site);
            await shoot(page.locator(SHOWN_ENTRY), "card-fares-dark.png");
            await shownCard(page, MOCK_FARES_CARD_TITLE)
              .getByRole("button", { name: MOCK_FARES_CHOICE })
              .click();
            return current;
          });

        await test.step("the airline needs a sign-in: the crewmate asks, and closing its card leaves the request reachable", async () => {
          const current = await reported(detail, MOCK_AIRLINE_SIGN_IN_REPORT);
          expect(current.outcome).not.toContain("Card refused");
          expect(current.browser).toMatchObject({
            state: "open",
            site: airline.site,
            control: "waiting",
            request: { reason: "Aurora Air needs your account to hold the fare" },
          });
          await showCard(page, MOCK_AIRLINE_SIGN_IN_TITLE);
          await expect(strip).toHaveAttribute("data-attachment-handoff", "waiting");
          await shoot(page.locator(SHOWN_ENTRY), "card-sign-in-dark.png");
          // The captain dismisses the request without choosing.
          await page.locator(`${SHOWN_ENTRY} button[aria-label="Close"]`).first().click();
          await expect
            .poll(async () => (await cardTitled(page, task.id, MOCK_AIRLINE_SIGN_IN_TITLE))?.status)
            .not.toBe("ready");
          // Its crewmate hears of the close, and its browser stays paused for him.
          const told = await reported(detail, MOCK_SIGN_IN_CLOSED_REPORT);
          expect(told.browser).toMatchObject({ control: "waiting" });
          // The request is still reachable: the record says so, and its Open shows it.
          const line = await openFromRecord(page, told);
          await expect(line).toHaveAttribute("data-browser-driver", "waiting");
          await expect(line).toContainText(DRIVER_WORDS.waiting);
          await line.locator("[data-browser-open]").click();
          await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "waiting");
          await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
          await shoot(view(page, task.id), "view-paused-after-close-dark.png");
        });

        await test.step("he takes control from the view and signs in with an invented account that nothing keeps", async () => {
          await takeControl(page, task.id);
          const calls = crewmateCalls(launched, title).length;
          await typeOnPage(launched.app, page, task.id, airline.url, "email", SYNTHETIC_EMAIL);
          await typeOnPage(
            launched.app,
            page,
            task.id,
            airline.url,
            "password",
            SYNTHETIC_PASSWORD,
          );
          await clickOnPage(launched.app, page, task.id, airline.url, "sign-in");
          await expect
            .poll(async () => (await detail()).browser, { timeout: 30_000 })
            .toMatchObject({ title: "Passenger details", control: "captain" });
          // Hide resumes nothing.
          await view(page, task.id).getByRole("button", { name: "Hide" }).click();
          expect((await detail()).browser).toMatchObject({ control: "captain" });
          const line = await openFromRecord(page, await detail());
          await expect(line).toContainText(DRIVER_WORDS.captain);
          await line.locator("[data-browser-open]").click();
          await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain");
          expect(crewmateCalls(launched, title)).toHaveLength(calls);
          expect(filesHolding(launched.userDataDir, SYNTHETIC_PASSWORD)).toEqual([]);
          expect(JSON.stringify(await detail())).not.toContain(SYNTHETIC_EMAIL);
          await returnControl(page, task.id);
        });

        const review =
          await test.step("woken once, it fills in the passenger and stops at the payment, whose total changed", async () => {
            const current = await reported(detail, MOCK_REVIEW_REPORT_PREFIX);
            expect(current.outcome).toContain(
              `The total is ${PAY_TOTAL}; the search said ${SEARCH_FARE}.`,
            );
            expect(current.outcome).not.toContain("Card refused");
            // One wake for the one return.
            const last = crewmateCalls(launched, title).at(-1) ?? "{}";
            expect(
              providerMessages(last).filter(
                (message) =>
                  message.role === "user" && message.text.includes(BROWSER_RETURNED_OPENING),
              ),
            ).toHaveLength(1);
            // Its browser is paused on the payment page; nothing has been paid.
            expect(current.browser).toMatchObject({
              control: "waiting",
              title: "Review and pay",
              request: { reason: "The final payment is yours to make" },
            });
            expect(airline.payments).toEqual([]);
            const reviewTitle = reviewCardTitle(PAY_TOTAL, airline.site);
            const card = await cardTitled(page, current.id, reviewTitle);
            expect(card?.actions.map((action) => action.label)).toEqual([
              MOCK_REVIEW_STOP_ACTION,
              MOCK_REVIEW_PAY_ACTION,
            ]);
            expect(card?.attachment).toMatchObject({ kind: "browser", handoff: true });
            await showCard(page, reviewTitle);
            const body = shownCardFrame(page);
            for (const fact of [
              "Route",
              "Dates",
              "Passenger",
              "Seller",
              "Total",
              "Baggage",
              "Fare rules",
              "Still uncertain",
            ]) {
              await expect(body.getByRole("cell", { name: fact, exact: true })).toBeVisible();
            }
            await expect(body.locator("mark")).toHaveText(fareRoseWords(SEARCH_FARE, PAY_TOTAL));
            await shoot(page.locator(SHOWN_ENTRY), "card-review-dark.png");
            return reviewTitle;
          });

        await test.step("the captain pays on the airline's page under his control, and it is paid once", async () => {
          await shownCard(page, review)
            .getByRole("button", { name: MOCK_REVIEW_PAY_ACTION })
            .click();
          await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain", {
            timeout: 30_000,
          });
          await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
          await payOnPage(launched, task.id, airline.url);
          await expect
            .poll(async () => openBrowser(await detail())?.title, { timeout: 30_000 })
            .toBe("Booking confirmed");
          expect(airline.payments).toEqual([{ total: PAY_TOTAL, card: SYNTHETIC_CARD }]);
          await shoot(view(page, task.id), "view-paid-dark.png");
          await returnControl(page, task.id);
        });

        await test.step("handed back, it reads the confirmation and keeps only the reference", async () => {
          const current = await reported(detail, MOCK_BOOKED_REPORT_PREFIX);
          expect(current.outcome).toContain(`reference ${BOOKING_REFERENCE}`);
          expect(current.outcome).not.toContain("Card refused");
          const note = await cardTitled(page, current.id, bookedNoteTitle(BOOKING_REFERENCE));
          expect(note?.actions).toEqual([]);
          expect(note?.attachment).toMatchObject({ kind: "browser", label: MOCK_BOOKED_BUTTON });
          // The view goes, and the note is the shown entry, not a page passing by.
          await view(page, task.id).getByRole("button", { name: "Hide" }).click();
          await expect(view(page, task.id)).toHaveCount(0);
          await showCard(page, bookedNoteTitle(BOOKING_REFERENCE));
          await expect(shownCard(page, bookedNoteTitle(BOOKING_REFERENCE))).toBeVisible();
          await expect(page.locator(SHOWN_ENTRY)).toHaveCSS("opacity", "1");
          await shoot(page.locator(SHOWN_ENTRY), "card-booked-dark.png");
          // Paid once, and nothing the captain typed is in a file or a model call.
          expect(airline.payments).toHaveLength(1);
          for (const typed of [SYNTHETIC_PASSWORD, SYNTHETIC_CARD]) {
            expect(filesHolding(launched.userDataDir, typed)).toEqual([]);
            expect(crewmateCalls(launched, title).some((body) => body.includes(typed))).toBe(false);
          }
          expect(servedBy(launched, title, runtime)).toBe(true);
          const lines = current.events.map((event) => event.text);
          expect(
            lines.filter(
              (text) => text === `asked you to take over its browser at ${airline.site}`,
            ),
          ).toHaveLength(2);
          expect(
            lines.filter((text) => text === "you returned control of its browser"),
          ).toHaveLength(2);
          const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
          if (evidence) {
            writeFileSync(
              join(evidence, `${runtime.name}-booking-report.txt`),
              `${current.outcome}\n`,
            );
          }
        });
      } finally {
        await airline.close();
      }
    });

    test(`card details the captain typed and never sent stay his when he hands a ${runtime.name} crewmate the page`, async () => {
      test.setTimeout(240_000);
      const { page } = launched;
      const shoot = photographer(runtime);
      const airline = await startFakeAirline({ guest: true });
      const title = `${TASK_BROWSER_UNPAID_MARKER}${airline.url}pay${runtime.suffix}`;
      try {
        const detail = await commission(launched, title);
        const task =
          await test.step("it prepares the payment and stops on a review card", async () => {
            const current = await reported(detail, MOCK_UNPAID_ASKED_REPORT);
            expect(current.outcome).not.toContain("Card refused");
            expect(current.browser).toMatchObject({ control: "waiting", title: "Review and pay" });
            return current;
          });

        await test.step("the captain types his card details, does not pay, and hands the page back", async () => {
          const reviewTitle = reviewCardTitle(PAY_TOTAL, airline.site);
          await showCard(page, reviewTitle);
          await shownCard(page, reviewTitle)
            .getByRole("button", { name: MOCK_REVIEW_PAY_ACTION })
            .click();
          await expect(view(page, task.id)).toHaveAttribute("data-browser-state", "captain", {
            timeout: 30_000,
          });
          await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
          await cardOnPage(launched, task.id, airline.url);
          await expect
            .poll(() => pageSays(launched.app, airline.url, "code", "value"))
            .toBe(SYNTHETIC_CODE);
          await shoot(view(page, task.id), "view-unpaid-card-dark.png");
          await returnControl(page, task.id);
        });

        await test.step("its fresh look knows each field is filled, and nothing he typed reaches a model call, a file or a picture", async () => {
          const current = await reported(detail, MOCK_UNPAID_REPORT_PREFIX);
          expect(current.outcome).not.toContain("Card refused");
          const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
          if (evidence) {
            writeFileSync(
              join(evidence, `${runtime.name}-unpaid-report.txt`),
              `${current.outcome}\n`,
            );
            writeFileSync(
              join(evidence, `${runtime.name}-unpaid-answers.txt`),
              `${crewmateCalls(launched, title)
                .flatMap((body) => providerMessages(body))
                .filter((message) => message.role === "tool")
                .map((message) => message.text)
                .join("\n---\n")}\n`,
            );
          }
          // The crewmate read the page it was handed: each field is there and filled.
          for (const label of MOCK_UNPAID_FIELDS) {
            expect(current.outcome).toContain(`${label}: hidden`);
          }
          expect(callsHoldCard(launched, title)).toEqual([]);
          expect(filesHolding(launched.userDataDir, SYNTHETIC_CARD)).toEqual([]);
          expect(filesHolding(launched.userDataDir, SYNTHETIC_EXPIRY)).toEqual([]);
          expect(
            existsSync(
              join(
                launched.userDataDir,
                "crewmates",
                task.id,
                "evidence",
                `${MOCK_UNPAID_PICTURE}.png`,
              ),
            ),
          ).toBe(false);
          // His details are still on the airline's page, and nothing was sent.
          expect(await pageSays(launched.app, airline.url, "code", "value")).toBe(SYNTHETIC_CODE);
          expect(airline.payments).toEqual([]);
          expect(servedBy(launched, title, runtime)).toBe(true);
        });
      } finally {
        await airline.close();
      }
    });

    test(`a payment the airline never confirms is checked and never sent again, across a restart, on ${runtime.name}`, async () => {
      // Its own app, since it quits and starts it again; one mock provider across both.
      test.setTimeout(420_000);
      const shoot = photographer(runtime);
      const airline = await startFakeAirline({ guest: true, lose: true });
      const mockProvider: MockProviderServer = await startMockProvider();
      // Every run of the app spaces delivery attempts by a short grace, so the
      // work a quit left in flight is delivered again soon after the next start.
      const env = { INFINITARY_INBOX_GRACE_MS: "5000" };
      let app = await runtime.launch({ reuseMockProvider: mockProvider, env });
      const title = `${TASK_BROWSER_LOST_MARKER}${airline.url}pay${runtime.suffix}`;
      try {
        await resizeWindow(app.app, app.page, { width: 1280, height: 900 });
        let detail = await commission(app, title);

        const task =
          await test.step("it prepares the payment and stops on a review card", async () => {
            const current = await reported(detail, MOCK_LOST_ASKED_REPORT);
            expect(current.outcome).not.toContain("Card refused");
            expect(current.browser).toMatchObject({ control: "waiting", title: "Review and pay" });
            expect(airline.payments).toEqual([]);
            return current;
          });
        const reviewTitle = reviewCardTitle(PAY_TOTAL, airline.site);

        await test.step("the captain pays, the airline never confirms, and his Reload sends nothing", async () => {
          await showCard(app.page, reviewTitle);
          await shownCard(app.page, reviewTitle)
            .getByRole("button", { name: MOCK_REVIEW_PAY_ACTION })
            .click();
          await expect(view(app.page, task.id)).toHaveAttribute("data-browser-state", "captain", {
            timeout: 30_000,
          });
          await expect.poll(async () => (await canvasReading(app.page)).frames).toBeGreaterThan(0);
          await payOnPage(app, task.id, airline.url);
          await expect
            .poll(() => pageSays(app.app, airline.url, "state").catch(() => null), {
              timeout: 30_000,
            })
            .toBe("We could not confirm your payment");
          expect(airline.payments).toHaveLength(1);
          await shoot(view(app.page, task.id), "view-unconfirmed-dark.png");
          // The page answers the form he sent: Reload would send it again, so it says why.
          await view(app.page, task.id)
            .locator("[data-browser-chrome]")
            .getByRole("button", { name: "Reload" })
            .click();
          await expect(view(app.page, task.id).getByRole("status")).toHaveText(
            FORM_RESEND_CAPTAIN_WORDS,
          );
          await shoot(view(app.page, task.id), "view-reload-refused-dark.png");
          expect(airline.payments).toHaveLength(1);
          await returnControl(app.page, task.id);
        });

        await test.step("woken, its reload is refused, and it watches My bookings", async () => {
          await expect
            .poll(async () => openBrowser(await detail())?.did, { timeout: 90_000 })
            .toBe('waited for "Booking confirmed"');
          const answers = crewmateCalls(app, title)
            .flatMap((body) => providerMessages(body))
            .filter((message) => message.role === "tool")
            .map((message) => message.text);
          expect(
            answers.some((text) =>
              text.includes("Did not reload: this page is the answer to a form that was sent"),
            ),
          ).toBe(true);
          expect(answers.some((text) => text.includes("No bookings yet"))).toBe(true);
          expect(airline.payments).toHaveLength(1);
        });

        await test.step("the app quits while that turn runs, and starts again", async () => {
          const { userDataDir, homeDir } = app;
          await app.close();
          app = await runtime.launch({
            reuseMockProvider: mockProvider,
            userDataDir,
            homeDir,
            env,
          });
          await resizeWindow(app.app, app.page, { width: 1280, height: 900 });
          detail = async () =>
            (await app.page.evaluate(
              (id) => window.infinitary.tasks.detail(id),
              task.id,
            )) as TaskDetail;
        });

        await test.step("its redelivered work finds the browser gone, checks again and asks, never paying again", async () => {
          // The quit left the wake in flight, so the next run delivers it again,
          // one inbox grace (shortened above) after its first delivery began (docs/inbox.md).
          const current = await reported(detail, MOCK_LOST_REPORT_PREFIX, 240_000);
          expect(current.outcome).toContain(
            'My bookings said "No bookings yet. A payment may still be processing."',
          );
          expect(current.outcome).toContain("and I did not pay again.");
          expect(current.outcome).toContain(
            'Reloading the unconfirmed page said: "Did not reload: this page is the answer to a form that was sent',
          );
          expect(current.outcome).toContain(
            'After the restart my browser was gone: "No browser is open for this task.',
          );
          expect(current.outcome).not.toContain("Card refused");
          expect(airline.payments).toHaveLength(1);
          expect(servedBy(app, title, runtime)).toBe(true);
          const card = await cardTitled(app.page, current.id, unknownCardTitle(airline.site));
          expect(card?.actions.map((action) => action.label)).toEqual([
            MOCK_LOST_NOT_BOOKED_ACTION,
            MOCK_LOST_CHECK_ACTION,
          ]);
          await showCard(app.page, unknownCardTitle(airline.site));
          await shoot(app.page.locator(SHOWN_ENTRY), "card-unknown-dark.png");
        });

        await test.step("the app quits again before the captain answers, and his click tells the crewmate its browser is gone", async () => {
          const { userDataDir, homeDir } = app;
          await app.close();
          app = await runtime.launch({
            reuseMockProvider: mockProvider,
            userDataDir,
            homeDir,
            env,
          });
          await resizeWindow(app.app, app.page, { width: 1280, height: 900 });
          await showCard(app.page, unknownCardTitle(airline.site));
          const check = shownCard(app.page, unknownCardTitle(airline.site)).getByRole("button", {
            name: MOCK_LOST_CHECK_ACTION,
          });
          // The card is still settling after the launch: press once it is still.
          await atRest(app.page, check);
          await check.click();
          // The card's browser ended with the quit: the view it opens says so.
          // The view opens once the app has answered the choice, which just
          // after a launch took over five seconds on the hosted Linux runner.
          await expect(view(app.page, task.id).locator("[data-browser-notice]")).toHaveAttribute(
            "data-browser-notice",
            "restarted",
            { timeout: 30_000 },
          );
          // Its crewmate hears the choice and that its browser was gone, once, and asks anew.
          const current = await reported(detail, MOCK_LOST_ASKED_AGAIN_REPORT, 120_000);
          expect(current.outcome).not.toContain("Card refused");
          const last = crewmateCalls(app, title).at(-1) ?? "{}";
          expect(
            providerMessages(last).filter(
              (message) => message.role === "user" && message.text.includes(BROWSER_GONE_OPENING),
            ),
          ).toHaveLength(1);
          expect(current.browser).toMatchObject({
            state: "open",
            title: "My bookings",
            control: "waiting",
          });
          // The one card that asks now names its fresh browser.
          const asked = (await app.page.evaluate(() => window.infinitary.cards.list())).filter(
            (card) => card.taskId === task.id && card.status === "ready",
          );
          expect(asked.map((card) => [card.title, card.attachment])).toEqual([
            [
              unknownCardTitle(airline.site),
              expect.objectContaining({
                handoff: true,
                session: openBrowser(current)?.session,
                generation: openBrowser(current)?.generation,
              }),
            ],
          ]);
          expect(airline.payments).toHaveLength(1);
          await shoot(app.page.locator(SHOWN_ENTRY), "view-asked-anew-dark.png");
          await view(app.page, task.id).getByRole("button", { name: "Hide" }).click();
          await expect(view(app.page, task.id)).toHaveCount(0);
          await showCard(app.page, unknownCardTitle(airline.site));
          await shoot(app.page.locator(SHOWN_ENTRY), "card-asked-anew-dark.png");
        });

        await test.step("the captain checks in the browser himself", async () => {
          await shownCard(app.page, unknownCardTitle(airline.site))
            .getByRole("button", { name: MOCK_LOST_CHECK_ACTION })
            .click();
          await expect(view(app.page, task.id)).toHaveAttribute("data-browser-state", "captain", {
            timeout: 30_000,
          });
          await expect
            .poll(async () => openBrowser(await detail())?.title, { timeout: 30_000 })
            .toBe("My bookings");
          expect(airline.payments).toHaveLength(1);
        });
      } finally {
        await app.close();
        await mockProvider.close();
        await airline.close();
      }
    });
  });
}
