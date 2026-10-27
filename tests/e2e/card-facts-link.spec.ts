import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type Card, SETTLE_FACTS_OPEN } from "../../src/shared/cards";
import { checksRestWords, checksSpanOf, checksSpanWords } from "../../src/shared/checksSpan";
import { CHECK_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { atRest, holdPointer } from "./layout";
import { MOCK_MODEL_ID, MOCK_PROVIDER_ID } from "./mockProvider";
import { promptInput } from "./prompt";
import { factsStrip, showCard } from "./stack";
import { focusOn } from "./windowKeys";

/**
 * A merge card's fact strip refreshes while it is up (FI3-1093): the host
 * rewrites its facts whenever the task's record changes - a new checks
 * reading - and the stage hands the strip the new
 * facts. A press the captain has started on the strip's pull request link
 * when that happens still opens the pull request when he lets go.
 *
 * The host's refresh is the card list it pushes, with the strip's checks
 * read a minute later; the press is Chromium's own pointer, held down
 * while the refresh lands and let go after it (`holdPointer`).
 */

const PR = "https://github.com/octo/meterlab/pull/58";
const TITLE = "The meter fix is ready to merge";
const TASK = "task-meter-fix";

function mergeCard(): Card {
  return {
    id: "card-meter-fix",
    taskId: TASK,
    author: "crewmate",
    meta: "crewmate",
    priority: 30,
    title: TITLE,
    // The host writes its fact strip where its marker stands.
    body: `<h2>Why</h2><p>The meter read the wrong unit.</p>${SETTLE_FACTS_OPEN}</div>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [
      {
        id: "merge",
        label: "Merge the pull request",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
      { id: "discard", label: "Discard", effect: { kind: "settle", mode: "discard" } },
    ],
  };
}

test("a press on the fact strip's pull request link opens it though the strip refreshes under it", async () => {
  const userDataDir = scratchDir("infinitary-card-facts-link-");
  // Checks that ran for 14 minutes, read 93 s ago (INF-587).
  const delivery = {
    mode: "direct-pr" as const,
    prNumber: 58,
    prUrl: PR,
    ci: "green" as const,
    ciAt: Date.now() - 93_000,
    ciStartedAt: Date.now() - 20 * 60_000,
    ciFinishedAt: Date.now() - 6 * 60_000,
  };
  const db = openDatabase(userDataDir);
  try {
    const tasks = new TaskService({ db });
    // A crewmate that finished its work, its working copy kept (INF-568).
    // A record with no working copy is a start that did not finish: the app
    // puts it back on the queue at launch and starts it again, and its model
    // leaves the strip until the new start names it - a cell coming and
    // going before the link, which moves the link under the press. The model
    // is on the record from the start, so the strip has every cell before
    // the first press and keeps them.
    const worktreeDir = join(userDataDir, "worktrees", TASK);
    mkdirSync(worktreeDir, { recursive: true });
    seedTask(tasks, {
      id: TASK,
      title: "Fix the meter",
      status: "completed",
      worktreeDir,
      model: { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
    });
    // The strip names when they started and when they were read, which the
    // host's own refreshes leave as they are while the test runs.
    seedDelivery(tasks, TASK, delivery);
    new CardStore(db).upsert(mergeCard());
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { app, page } = launched;
    // The system browser, replaced by a recorder: nothing here opens a page.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __fmOpened?: string[] }).__fmOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const opened = () =>
      app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

    await showCard(page, TITLE);
    const facts = factsStrip(cardBody(page, TITLE));
    const link = facts.change.locator(`a[href="${PR}"]`);
    await expect(link).toBeVisible();
    const span = checksSpanOf(delivery);
    if (!span) throw new Error("The seeded checks have a start and a finish");
    await expect(facts.cell("checks")).toContainText(
      checksSpanWords(CHECK_WORDS.green, span, Date.now()),
    );
    const title = await facts.cell("checks").getAttribute("title");
    expect(title).toMatch(/^Started .+ · read .+$/);
    // The host's next reading, a minute later.
    const later = checksRestWords(span, delivery.ciAt + 60_000);
    expect(later).not.toBe(title);

    // INF-92: the captain asked to repair repeated completion facts without
    // changing the rigor-standard journey. Replay this real document with
    // its parser stopped before the care value. The host's initial markup
    // refresh must arrive before the parser finishes, without a timed race.
    const parseState = await facts.care.evaluate(
      (value) =>
        new Promise<DocumentReadyState>((resolve) => {
          const doc = value.ownerDocument;
          const view = doc.defaultView;
          if (!view) throw new Error("The fact document has no window");
          const html = doc.documentElement.outerHTML;
          const valueHtml = value.outerHTML;
          const at = html.indexOf(valueHtml);
          if (at < 0 || html.indexOf(valueHtml, at + valueHtml.length) !== -1)
            throw new Error("The care value must identify one parser position");
          doc.open();
          doc.write(html.slice(0, at));
          // Install after the bridge: it receives the refresh first, while
          // the original parser still has these same facts left to read.
          const refreshed = (event: MessageEvent) => {
            if (event.source !== view.parent || event.data?.type !== "markup") return;
            view.removeEventListener("message", refreshed);
            const state = doc.readyState;
            doc.write(html.slice(at));
            doc.close();
            resolve(state);
          };
          view.addEventListener("message", refreshed);
        }),
    );
    expect(parseState).toBe("loading");
    await expect(facts.care).toHaveCount(1);
    await expect(facts.change).toHaveCount(1);
    await expect(facts.checks).toHaveCount(1);

    // The card grows into place as it arrives; the press goes where it rests.
    await atRest(page.locator("[data-card-facts]"));

    // A press with nothing refreshing opens the pull request.
    const release = await holdPointer(page, link);
    await release();
    await expect.poll(opened).toEqual([PR]);

    // The captain's focus is back in the main message, as it is when he
    // reaches for the link. The strip's own document notes, in order, the
    // button going down, the refresh reaching its checks cell and the click
    // the release makes.
    await focusOn(promptInput(page));
    await link.evaluate((anchor, later) => {
      const strip = anchor.ownerDocument;
      const seen: string[] = [];
      (strip.defaultView as unknown as { __fmPress: string[] }).__fmPress = seen;
      strip.addEventListener("pointerdown", () => seen.push("down"), true);
      strip.addEventListener("click", () => seen.push("click"), true);
      new MutationObserver(() => {
        const checks = strip.querySelector('[data-fact="checks"]');
        if (checks?.getAttribute("title") === later && !seen.includes("refreshed"))
          seen.push("refreshed");
      }).observe(strip.body, { subtree: true, childList: true, attributes: true });
    }, later);
    const noted = () =>
      link.evaluate(
        (anchor) =>
          (anchor.ownerDocument.defaultView as unknown as { __fmPress?: string[] }).__fmPress,
      );
    // The host's refresh: the card list with the strip's checks read a
    // minute later, pushed while the button is down.
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    const refreshed = cards.map((card) =>
      card.id === "card-meter-fix"
        ? { ...card, body: card.body.replace(`title="${title}"`, `title="${later}"`) }
        : card,
    );
    expect(refreshed).not.toEqual(cards);
    const letGo = await holdPointer(page, link);
    // The strip has the button down before the refresh is pushed.
    await expect.poll(noted).toEqual(["down"]);
    await app.evaluate(({ BrowserWindow }, refreshed) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("inf:cards", refreshed);
    }, refreshed);
    await expect(facts.cell("checks")).toHaveAttribute("title", later);
    await letGo();
    await expect.poll(opened).toEqual([PR, PR]);
    // The strip refreshed while the button was down: after it went down and
    // before the click its release made, all in the one document the strip
    // keeps.
    expect(await noted()).toEqual(["down", "refreshed", "click"]);
  } finally {
    await launched.close();
  }
});
