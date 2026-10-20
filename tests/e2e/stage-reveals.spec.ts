import { writeFileSync } from "node:fs";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement, frameIn, warmBody, warmElement } from "./frames";
import { launchApp } from "./launch";
import {
  ANSWER_PROMPT_MARKER,
  FM_THREAD_CARD_TITLE,
  FM_THREAD_PROMPT_MARKER,
  FM_THREAD_PROSE_ANSWER,
  MOCK_ANSWER_TITLE,
  THREAD_PROSE_REPLY,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { expandDock, hideRecord, nowFrame, pressRow, recordCard } from "./rails";
import {
  cardReply,
  cardSurface,
  closeQuestion,
  expectNoCard,
  pagerAt,
  showCard,
  shownCard,
  shownCardFrame,
  shownEntry,
  stagePrepared,
} from "./stack";
import { typeInto } from "./windowKeys";

/** A plain card seeded straight into the store, oldest first by `at`. */
function seededCard(
  id: string,
  title: string,
  body: string,
  at: number,
  actions: Parameters<CardStore["upsert"]>[0]["actions"] = [],
) {
  return {
    id,
    author: "firstmate" as const,
    priority: 25,
    title,
    meta: "firstmate",
    body,
    actions,
    status: "ready" as const,
    createdAt: 1000 + at,
  };
}

/** Launches the app on a stack of seeded cards. */
async function launchWithCards(cards: ReturnType<typeof seededCard>[]) {
  const userDataDir = scratchDir("infinitary-next-card-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  for (const card of cards) store.upsert(card);
  db.close();
  return launchApp({ userDataDir, withMockProvider: true });
}

/** A new card behind the shown one: Firstmate's answer, unread until shown. */
async function receiveUnreadCard(page: Page): Promise<void> {
  const input = promptInput(page);
  await input.fill(ANSWER_PROMPT_MARKER);
  await input.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "1 new" })).toBeVisible({
    timeout: 30_000,
  });
}

const surface = (page: Page) => shownEntry(page);

/** The seeded cards' titles, each named once where it is filed and where it is found. */
const HARBOUR_NOTES = [
  "First harbour note",
  "Second harbour note",
  "Third harbour note",
  "Fourth harbour note",
] as const;
const READ_NOTE = "Already read harbour note";
const CLOSING_NOTE = "Close this harbour note";
const REPLYING_NOTE = "Reply under this harbour note";
const LAST_CARD = "The last card";
const READING_NOTE = "The harbour note you are reading";
const NEXT_PLAN = "The next harbour plan";
const BERTH_CARD = "Choose a berth";
const TIDE_TABLE = "The tide table";

test("under reduced motion a new reply arrives without moving, and stays after a reload", async () => {
  const app = await launchApp({ withMockProvider: true });
  try {
    const { page } = app;
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Each Firstmate message's transform the moment it is inserted: a reveal
    // that moves would show its first, displaced frame here.
    await page.evaluate(() => {
      const seen = new WeakSet<Element>();
      const moved: string[] = [];
      (window as unknown as { moved: string[] }).moved = moved;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-thread-message="firstmate"]')) {
          if (seen.has(el)) continue;
          seen.add(el);
          moved.push(getComputedStyle(el).transform);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const input = promptInput(page);
    await input.fill(FM_THREAD_PROMPT_MARKER);
    await input.press("Enter");
    await expect(shownCard(page, FM_THREAD_CARD_TITLE)).toBeVisible();
    await cardReply(page).field.fill(THREAD_PROSE_REPLY);
    await page.getByRole("button", { name: "Send reply" }).click();
    const answer = page
      .locator('[data-thread-message="firstmate"]')
      .filter({ hasText: FM_THREAD_PROSE_ANSWER });
    await expect(answer).toBeVisible();
    await expect(answer).toHaveCSS("opacity", "1");
    const moved = await page.evaluate(() => (window as unknown as { moved: string[] }).moved);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.filter((transform) => transform !== "none")).toEqual([]);
    // The reply is the card's history now: a reload still shows it.
    await page.reload();
    await expect(answer).toBeVisible();
  } finally {
    await app.close();
  }
});

// This case owns its entire stack; no earlier journey supplies a card or record.
test("closing a middle card or hiding a record reveals the oldest card, not the next entry", async () => {
  const userDataDir = scratchDir("infinitary-reveal-first-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db, strict: true });
  const records = ["harbour", "tides"].map((id) =>
    seedTask(tasks, { id, title: id, status: "queued", startPolicy: "on-request" }),
  );
  const cards = new CardStore(db);
  // Deliberately write out of age order: the real core must sort oldest first.
  for (const index of [3, 1, 2, 0] as const) {
    const title = HARBOUR_NOTES[index];
    cards.upsert({
      id: `harbour-note-${index}`,
      author: "firstmate",
      priority: 25,
      title,
      meta: "firstmate",
      body: "<p>The oldest harbour note should show after a dismissal.</p>",
      actions: [],
      status: "ready",
      createdAt: 1000 + index,
    });
  }
  db.close();
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expect(shownCard(page, HARBOUR_NOTES[0])).toBeVisible();
    await expandDock(page, "now");
    await nowFrame(page)
      .locator('[data-now-group-header="backlog"]')
      .evaluate((el) => (el as HTMLElement).click());
    for (const record of records) {
      await pressRow(page, record.key);
      await expect(recordCard(page)).toHaveAttribute("data-task-record", record.id);
    }
    await showCard(page, HARBOUR_NOTES[2]);
    await expect(surface(page)).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath("before-middle-dismiss.png") });
    await shownEntry(page).locator('button[aria-label="Close"]').click();
    await expect(shownCard(page, HARBOUR_NOTES[0])).toBeVisible();
    await expect(pagerAt(page, 3, 5)).toBeVisible();
    await expect(surface(page)).toHaveCSS("opacity", "1");
    await expect(
      cardBody(page, HARBOUR_NOTES[0]).getByText(
        "The oldest harbour note should show after a dismissal.",
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("after-middle-dismiss.png") });
    await page.getByRole("button", { name: "Previous card" }).click();
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "harbour");
    await hideRecord(page).evaluate((el) => (el as HTMLElement).click());
    await expect(shownCard(page, HARBOUR_NOTES[0])).toBeVisible();
    await expect(pagerAt(page, 2, 4)).toBeVisible();
    await expect(surface(page)).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath("after-hide-record.png") });
    await test.info().attach("remaining ordered cards", {
      body: JSON.stringify(await page.evaluate(() => window.infinitary.cards.list())),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});

// The captain's FI3-711 answers: the first unread card comes up next, after a
// close and after a reply alike; with none unread, the first card does.
test("closing a card or replying under it brings up the first unread card, not the first card", async () => {
  const app = await launchWithCards([
    seededCard("seen-first", READ_NOTE, "<p>Read before.</p>", 0),
    seededCard("closing", CLOSING_NOTE, "<p>Closed next.</p>", 1),
    seededCard("replying", REPLYING_NOTE, "<p>Answered next.</p>", 2),
  ]);
  try {
    const { page } = app;
    const answers = async () =>
      (await page.evaluate(() => window.infinitary.cards.list()))
        .filter((card) => card.title === MOCK_ANSWER_TITLE)
        .map((card) => card.id);
    const unreadBadge = page.getByRole("status").filter({ hasText: "new" });
    await showCard(page, CLOSING_NOTE);
    await receiveUnreadCard(page);
    await test.step("a close skips the first card for the unread one", async () => {
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
      await expect(unreadBadge).toHaveCount(0);
    });
    await test.step("a reply sends its card back and brings up the unread one", async () => {
      await showCard(page, REPLYING_NOTE);
      const earlier = await answers();
      await receiveUnreadCard(page);
      const arrived = (await answers()).find((id) => !earlier.includes(id));
      if (!arrived) throw new Error("No second answer arrived");
      await cardReply(page).field.fill("Which tide is this for?");
      await page.getByRole("button", { name: "Send reply", exact: true }).click();
      // The card on the stage is the answer that just arrived, not the first card.
      await expect(cardReply(page).row).toHaveAttribute("data-card-reply", arrived);
      // The focus the departing card's reply field held goes to the prompt,
      // never to the incoming card's controls.
      await expect(promptInput(page)).toBeFocused();
    });
    await test.step("the card whose author answered is news: a close brings it up", async () => {
      await expect(page.getByRole("status").filter({ hasText: "1 new" })).toBeVisible({
        timeout: 30_000,
      });
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, REPLYING_NOTE)).toBeVisible();
      await expect(unreadBadge).toHaveCount(0);
    });
    await test.step("with nothing unread, a close brings up the first card", async () => {
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, READ_NOTE)).toBeVisible();
    });
  } finally {
    await app.close();
  }
});

// FI3-596: the card a reply is typed under keeps its body when its thread
// opens beside it - what the captain did in the body is still there.
test("after the last card closes, the stage empties and the next card arrives with its body showing", async () => {
  const app = await launchWithCards([
    seededCard("last", LAST_CARD, "<p>Nothing else is waiting.</p>", 0),
  ]);
  try {
    const { page } = app;
    await expect(shownCard(page, LAST_CARD)).toBeVisible();
    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    // The closed card leaves the stack at once; its drawing may still be on
    // its way out, but no card is up.
    await expectNoCard(page, LAST_CARD);
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);
    await expect(page.locator("[data-card-layer-leaving]")).toHaveCount(0);

    const input = promptInput(page);
    await input.fill(ANSWER_PROMPT_MARKER);
    await input.press("Enter");
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 30_000 });
    // Its body draws while the card grows into place, and shows.
    const frame = cardBodyElement(page, MOCK_ANSWER_TITLE);
    await expect(frame).toHaveCSS("opacity", "1");
    await expect(cardBody(page, MOCK_ANSWER_TITLE).locator("body")).not.toHaveText("");
  } finally {
    await app.close();
  }
});

test("a reply under a lone card keeps its body as the captain left it", async () => {
  const body =
    '<p>Count the soundings.</p><button id="advance" type="button">Advance</button> <output id="count">0</output>' +
    "<details><summary>Reading details</summary><p>Keep this open while replying.</p></details>" +
    '<script>let n=0;document.getElementById("advance").onclick=()=>document.getElementById("count").textContent=String(++n);</script>';
  const app = await launchWithCards([seededCard("lone", "Sound the channel", body, 0)]);
  try {
    const { page } = app;
    const frame = cardBody(page, "Sound the channel");
    for (let i = 0; i < 3; i++)
      await frame.locator("#advance").evaluate((button) => (button as HTMLElement).click());
    await frame.locator("summary").evaluate((summary) => (summary as HTMLElement).click());
    await expect(frame.locator("#count")).toHaveText("3");
    const reply = cardReply(page).field;
    await reply.fill(THREAD_PROSE_REPLY);
    await reply.press("Enter");
    await expect(shownEntry(page).locator("[data-card-thread]")).toBeVisible();
    await expect(
      shownEntry(page)
        .locator('[data-thread-message="captain"]')
        .filter({ hasText: THREAD_PROSE_REPLY }),
    ).toBeVisible();
    // The same body: its count and its open disclosure.
    await expect(frame.locator("#count")).toHaveText("3");
    await expect(frame.locator("details")).toHaveAttribute("open", "");
    await expect(reply).toHaveValue("");
  } finally {
    await app.close();
  }
});

// FI3-722: the reply field keeps the focus through a send, by Enter or by the
// send control, so the captain types the next reply straight away. The keys
// go to whatever holds the focus; nothing clicks the field again.
test("after a reply under a lone card, the next reply is typed straight away", async () => {
  const app = await launchWithCards([
    seededCard("lone", "Plot the next leg", "<p>Two questions follow.</p>", 0),
  ]);
  try {
    const { page } = app;
    const reply = cardReply(page).field;
    const sent = (text: string) =>
      shownEntry(page).locator('[data-thread-message="captain"]').filter({ hasText: text });
    const byEnter = `By Enter: ${THREAD_PROSE_REPLY}`;
    const bySend = `By the send control: ${THREAD_PROSE_REPLY}`;
    await reply.click();
    await typeInto(reply, byEnter);
    await page.keyboard.press("Enter");
    await expect(sent(byEnter)).toBeVisible();
    await expect(reply).toHaveValue("");
    await expect(reply).toBeFocused();

    await typeInto(reply, bySend);
    await expect(reply).toHaveValue(bySend);
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(sent(bySend)).toBeVisible();
    await expect(reply).toHaveValue("");
    await expect(reply).toBeFocused();

    await typeInto(reply, "And the tide table?");
    await expect(reply).toHaveValue("And the tide table?");
  } finally {
    await app.close();
  }
});

for (const held of ["record", "past"] as const) {
  test(`Hide on a ${held} reuses the prepared first live card despite an unread arrival`, async () => {
    const userDataDir = scratchDir("infinitary-hide-successor-");
    const db = openDatabase(userDataDir);
    const tasks = new TaskService({ db, strict: true });
    const task = seedTask(tasks, {
      id: "harbour",
      title: "Plan the harbour",
      status: "queued",
      startPolicy: "on-request",
    });
    const cards = new CardStore(db);
    cards.upsert(seededCard("first", READ_NOTE, "<p>Return to this first live card.</p>", 0));
    cards.upsert(seededCard("past", "Earlier harbour plan", "<p>The earlier plan.</p>", 1));
    cards.resolve("past", "close");
    db.close();
    const app = await launchApp({ userDataDir, withMockProvider: true });
    try {
      const { page } = app;
      await expect(shownCard(page, READ_NOTE)).toBeVisible();
      if (held === "record") {
        await expandDock(page, "now");
        await nowFrame(page)
          .locator('[data-now-group-header="backlog"]')
          .evaluate((el) => (el as HTMLElement).click());
        await pressRow(page, task.key);
        await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
      } else {
        await page.evaluate(() => window.infinitary.cards.showPast("past"));
        await expect(page.locator('[data-past-card="past"]')).toBeVisible();
      }
      await receiveUnreadCard(page);
      const warm = warmElement(page);
      await expect(warm).toHaveAttribute("title", `${READ_NOTE} body`);
      // A marker in the live document proves Hide promoted it without remounting.
      await warmBody(page)
        .locator("html")
        .evaluate((html) => {
          html.dataset.hidePrepared = "same-document";
        });
      await expect(shownEntry(page)).toHaveCSS("opacity", "1");
      if (process.env.FM_HIDE_EVIDENCE)
        await page
          .locator("[data-card-layer]")
          .screenshot({ path: `${process.env.FM_HIDE_EVIDENCE}/${held}-held.png` });
      const preparedTitle = await warm.getAttribute("title");
      await shownEntry(page).getByRole("button", { name: "Hide", exact: true }).click();
      await expect(shownCard(page, READ_NOTE)).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "1 new" })).toBeVisible();
      await expect(cardBody(page, READ_NOTE).locator("html")).toHaveAttribute(
        "data-hide-prepared",
        "same-document",
      );
      await expect(shownEntry(page)).toHaveCSS("opacity", "1");
      if (process.env.FM_HIDE_EVIDENCE)
        await page
          .locator("[data-card-layer]")
          .screenshot({ path: `${process.env.FM_HIDE_EVIDENCE}/${held}-destination.png` });
      if (process.env.FM_HIDE_EVIDENCE) {
        writeFileSync(
          `${process.env.FM_HIDE_EVIDENCE}/${held}.json`,
          JSON.stringify(
            {
              held,
              preparedTitle,
              shownTitle: await frameIn(shownEntry(page)).getAttribute("title"),
              documentMarker: await cardBody(page, READ_NOTE)
                .locator("html")
                .getAttribute("data-hide-prepared"),
              unread: await page.getByRole("status").filter({ hasText: "1 new" }).textContent(),
            },
            null,
            2,
          ),
        );
      }
      // Ordinary close still selects the unread answer, not the held entry.
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

// INF-624: the card after the next one is prepared once the next card's
// height easing has finished (docs/renderer.md). On a MacBook the easing's
// animation clock started 1.85 ms ahead of the page clock its deadline was
// read on, so it finished 1.2 ms before that deadline, the card never
// settled and nothing was prepared. Here the easing starts 100 ms ahead, so
// its finish comes before the deadline whatever the display's frame rate.
const EASING_LEAD_MS = 100;
const SHORT_NOTE = "A short harbour note";
const TALL_NOTE = "A tall harbour note";
const LATER_NOTE = "A later harbour note";

test("the card after next is prepared when the height easing finishes ahead of the page clock", async () => {
  const berths = Array.from(
    { length: 8 },
    (_, index) => `<p>Berth ${index + 1} is free at high tide.</p>`,
  ).join("");
  const app = await launchWithCards([
    seededCard("short", SHORT_NOTE, "<p>Close me.</p>", 0),
    seededCard("tall", TALL_NOTE, berths, 1),
    seededCard("later", LATER_NOTE, "<p>Waiting its turn.</p>", 2),
  ]);
  try {
    const { page } = app;
    await expect(shownCard(page, SHORT_NOTE)).toBeVisible();
    await expect(warmElement(page)).toHaveAttribute("title", `${TALL_NOTE} body`);
    await stagePrepared(page);
    await page.evaluate((lead) => {
      const easings: string[] = [];
      (window as unknown as { easings: string[] }).easings = easings;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        const animation = animate.call(this, keyframes, options);
        if (this.hasAttribute("data-card-presentation")) {
          animation.startTime = Number(document.timeline.currentTime) - lead;
          easings.push("started");
          animation.addEventListener("finish", () => easings.push("finished"));
        }
        return animation;
      };
    }, EASING_LEAD_MS);
    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(shownCard(page, TALL_NOTE)).toBeVisible();
    // The close eased the card's height, and the easing finished.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { easings: string[] }).easings))
      .toContain("finished");
    await expect(cardSurface(page)).not.toHaveAttribute("data-card-geometry", "animating");
    await expect(warmElement(page)).toHaveAttribute("title", `${LATER_NOTE} body`);
    await stagePrepared(page);
  } finally {
    await app.close();
  }
});

// FI3-871: the next card is prepared even when its body has a script. Its
// page loads while the captain reads, and nothing of its own runs until it
// is shown - no timer, animation, timeline or sound - then it all starts on
// the same page.
const HELD_PROBE = `<p>The next harbour plan, drawn by its own script.</p>
<output id="ticks">0</output>
<style>@keyframes harbour-in { from { opacity: 0 } to { opacity: 1 } } #fade { animation: harbour-in 1s linear forwards }</style>
<div id="fade">Fading in</div>
<svg id="timeline" viewBox="0 0 10 10" width="10"><rect width="10" height="10"><animate attributeName="x" from="0" to="10" dur="1s" fill="freeze"/></rect></svg>
<figure aria-label="Harbour figure"><svg viewBox="0 0 10 10" width="10"></svg><script>document.documentElement.dataset.figure = document.currentScript.closest("figure") ? "found" : "missing";</script></figure>
<script>
document.documentElement.dataset.started = "yes";
let n = 0;
const clock = setInterval(() => { document.getElementById("ticks").textContent = String(++n); if (n === 4) clearInterval(clock); }, 50);
try { document.documentElement.dataset.audio = new AudioContext().state; } catch (error) { document.documentElement.dataset.audio = "unavailable"; }
document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.ready = "yes"; });
window.onload = () => { document.documentElement.dataset.loaded = "yes"; };
</script>`;

/** What a card's page is doing: its script's marks, its animations, its timeline. */
function pageState(frame: FrameLocator) {
  return frame.locator("html").evaluate((html) => {
    const fade = document.getElementById("fade")?.getAnimations()[0];
    const timeline = document.getElementById("timeline") as unknown as SVGSVGElement | null;
    const marks = html.dataset;
    return {
      preparedPage: marks.preparedPage,
      started: marks.started,
      figure: marks.figure,
      ready: marks.ready,
      loaded: marks.loaded,
      audio: marks.audio,
      ticks: document.getElementById("ticks")?.textContent,
      fade: fade ? { state: fade.playState, time: Number(fade.currentTime) } : null,
      timelinePaused: timeline?.animationsPaused() ?? null,
      timelineTime: timeline?.getCurrentTime() ?? null,
    };
  });
}

test("a scripted next card is prepared while you read and starts only once shown, on the same page", async () => {
  const app = await launchWithCards([
    seededCard("reading", READING_NOTE, "<p>Close me.</p>", 0),
    seededCard("next", NEXT_PLAN, HELD_PROBE, 1),
  ]);
  try {
    const { page } = app;
    await expect(shownCard(page, READING_NOTE)).toBeVisible();
    // Prepared: its page drew, held, while the card above it is read.
    const prepared = warmElement(page);
    await expect(prepared).toHaveAttribute("title", `${NEXT_PLAN} body`);
    await expect(prepared).toHaveAttribute("data-frame-held", "", { timeout: 15_000 });
    const warm = warmBody(page);
    // Long enough for anything that ran ahead to show it.
    await page.waitForTimeout(300);
    const before = await pageState(warm);
    expect(before.started).toBeUndefined();
    expect(before.audio).toBeUndefined();
    expect(before.ticks).toBe("0");
    expect(before.fade).toEqual({ state: "paused", time: 0 });
    expect(before.timelinePaused).toBe(true);
    await warm.locator("html").evaluate((html) => {
      html.dataset.preparedPage = "same";
    });

    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(shownCard(page, NEXT_PLAN)).toBeVisible();
    await expect(shownEntry(page)).toHaveCSS("opacity", "1");
    const shown = shownCardFrame(page);
    await expect(shown.locator("#ticks")).toHaveText("4");
    const after = await pageState(shown);
    // The same page the stage prepared, its own behavior started once shown.
    expect(after).toMatchObject({
      preparedPage: "same",
      started: "yes",
      figure: "found",
      ready: "yes",
      loaded: "yes",
      timelinePaused: false,
    });
    expect(after.audio).toBeDefined();
    expect(after.fade?.state).not.toBe("paused");
    expect(after.timelineTime).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

// FI3-871's first pitfall: a value a prepared body's own script fills in is
// what the body shows, never a change the captain made, so closing it does
// not ask about discarding one.
test("a prepared scripted card whose script fills in its settings closes without asking", async () => {
  const preview = `<p>Choose the berth for the night.</p>
<fieldset><legend>Which berth?</legend>
<label><input type="radio" name="berth" value="north"> North</label>
<label><input type="radio" name="berth" value="south"> South</label></fieldset>
<input type="hidden" name="settings" value="">
<script>document.querySelector('[name="settings"]').value = JSON.stringify({ depth: 4 });</script>`;
  const app = await launchWithCards([
    seededCard("reading", READING_NOTE, "<p>Close me.</p>", 0),
    seededCard("berth", BERTH_CARD, preview, 1, [{ id: "keep", label: "Keep it", default: true }]),
  ]);
  try {
    const { page } = app;
    await expect(warmElement(page)).toHaveAttribute("data-frame-held", "", { timeout: 15_000 });
    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(shownCard(page, BERTH_CARD)).toBeVisible();
    await expect(shownCardFrame(page).locator('[name="settings"]')).toHaveValue('{"depth":4}');
    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    await expectNoCard(page, BERTH_CARD);
    await expect(closeQuestion(page)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// FI3-871: a prepared card without a script holds its animations the same way.
test("a plain next card's animation waits until it is shown", async () => {
  const fading =
    "<style>@keyframes harbour-in { from { opacity: 0 } to { opacity: 1 } } #fade { animation: harbour-in 1s linear forwards }</style>" +
    '<p id="fade">The tide table, fading in.</p>';
  const app = await launchWithCards([
    seededCard("reading", READING_NOTE, "<p>Close me.</p>", 0),
    seededCard("tides", TIDE_TABLE, fading, 1),
  ]);
  try {
    const { page } = app;
    const prepared = warmElement(page);
    await expect(prepared).toHaveAttribute("title", `${TIDE_TABLE} body`);
    await expect(prepared).toHaveAttribute("data-frame-drawn", "", { timeout: 15_000 });
    const fade = (frame: FrameLocator) =>
      frame.locator("#fade").evaluate((element) => {
        const animation = element.getAnimations()[0];
        return animation
          ? { state: animation.playState, time: Number(animation.currentTime) }
          : null;
      });
    await page.waitForTimeout(300);
    expect(await fade(warmBody(page))).toEqual({
      state: "paused",
      time: 0,
    });
    await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(shownCard(page, TIDE_TABLE)).toBeVisible();
    await expect.poll(async () => (await fade(shownCardFrame(page)))?.state).not.toBe("paused");
  } finally {
    await app.close();
  }
});
