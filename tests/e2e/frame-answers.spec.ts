import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { CARD_BODY_WORDS } from "../../src/renderer/src/cards/cardBodyWords";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodySelector } from "./frames";
import { launchApp } from "./launch";
import { shownEntry } from "./stack";

/**
 * Every frame request is answered by its correlation id, and each new
 * document of a mount numbers its requests from 1 again
 * (docs/ui-plugins.md, "The bridge"). An answer the host finishes after the
 * page that asked was replaced belongs to no one: it must never settle the
 * replacement page's own request of the same number.
 */

const TITLE = "Check the tide before sailing";
const REQUEST_REASON = "The request could not be completed.";

type Held = { calls: number; release: (fail: boolean) => void };
type HeldHost = typeof globalThis & { held?: Record<string, Held> };

/**
 * Holds a real IPC channel: each call waits until the test releases it, then
 * fails with the transport's plain reason or runs the app's own handler.
 * Controlled latency, not a timer.
 */
async function hold(app: ElectronApplication, channel: string) {
  await app.evaluate(
    ({ ipcMain }, { channel, reason }) => {
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
        }
      )._invokeHandlers;
      const real = handlers.get(channel);
      if (!real) throw new Error(`${channel} handler missing`);
      const held: Held = { calls: 0, release: () => {} };
      const host = globalThis as HeldHost;
      host.held = { ...host.held, [channel]: held };
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        held.calls += 1;
        const fail = await new Promise<boolean>((resolve) => {
          held.release = resolve;
        });
        if (fail) throw new Error(reason);
        return real(event, ...args);
      });
    },
    { channel, reason: REQUEST_REASON },
  );
}

function heldCalls(app: ElectronApplication, channel: string) {
  return app.evaluate(
    (_electron, channel) => (globalThis as HeldHost).held?.[channel]?.calls ?? 0,
    channel,
  );
}

async function release(app: ElectronApplication, channel: string, fail: boolean) {
  await app.evaluate(
    (_electron, { channel, fail }) => (globalThis as HeldHost).held?.[channel]?.release(fail),
    { channel, fail },
  );
}

test("an answer to a replaced card page never settles the request of the page that replaced it", async () => {
  const userDataDir = scratchDir("infinitary-frame-answers-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "tide-check",
    title: TITLE,
    author: "firstmate",
    priority: 50,
    meta: "firstmate",
    // Each settled request writes one line, so the list is every answer
    // this page's requests received, in order.
    body: `<p>Choose once the harbour office has answered.</p>
      <button id="choose">Choose in the card</button>
      <button id="lookup">Look up the tide</button>
      <button id="freeze">Freeze this card</button>
      <ol data-settled></ol>
      <script>
        var settled = document.querySelector('[data-settled]');
        function note(line) {
          var item = document.createElement('li');
          item.textContent = line;
          settled.appendChild(item);
        }
        document.getElementById('choose').onclick = function () {
          inf.action('choose').then(
            function () { note('choice answered'); },
            function (error) { note('choice ' + error.code); });
        };
        document.getElementById('lookup').onclick = function () {
          inf.fetch('tides', { path: '/today' }).then(
            function () { note('lookup answered'); },
            function (error) { note('lookup ' + error.code); });
        };
        document.getElementById('freeze').onclick = function () { for (;;) {} };
      </script>`,
    status: "ready",
    createdAt: Date.now(),
    actions: [{ id: "choose", label: "Choose" }],
  });
  db.close();
  const launched = await launchApp({ userDataDir });
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  const transcript: string[] = [];
  const { app, page } = launched;
  const frame = cardBody(page, TITLE);
  const settled = frame.locator("[data-settled] li");
  try {
    // Chromium drops native clicks into a hidden window's sandboxed frames.
    const press = (name: string) =>
      frame
        .getByRole("button", { name, exact: true })
        .evaluate((button) => setTimeout(() => (button as HTMLButtonElement).click()));
    const choose = page.getByRole("button", { name: "Choose", exact: true });

    await test.step("the first page's choice waits on the app", async () => {
      await expect(frame.getByRole("button", { name: "Choose in the card" })).toBeVisible();
      await hold(app, "inf:cards:act");
      await press("Choose in the card");
      await expect.poll(() => heldCalls(app, "inf:cards:act")).toBe(1);
      await expect(page.getByRole("button", { name: "Working...", exact: true })).toBeDisabled();
    });

    await test.step("the first page stops responding and Retry draws a new one", async () => {
      await press("Freeze this card");
      await expect(shownEntry(page).getByText(CARD_BODY_WORDS.stopped)).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(frame.getByRole("button", { name: "Look up the tide" })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("the new page's own lookup is its first request", async () => {
      await hold(app, "inf:plugins:fetch");
      await press("Look up the tide");
      await expect.poll(() => heldCalls(app, "inf:plugins:fetch")).toBe(1);
      await expect(settled).toHaveCount(0);
    });

    await test.step("an answer naming another page settles nothing on this one", async () => {
      // What the host would post if the frame navigated under it: the new
      // page's request id, addressed to the page before it.
      await page.evaluate((selector) => {
        const target = document.querySelector<HTMLIFrameElement>(selector);
        target?.contentWindow?.postMessage(
          { fm: 2, type: "response", id: 1, ok: true, document: "an-earlier-page" },
          "*",
        );
      }, cardBodySelector(TITLE));
    });

    await test.step("the first page's late answer settles nothing on the new page", async () => {
      await release(app, "inf:cards:act", true);
      // The app has taken the refused choice back: its own button works again.
      await expect(choose).toBeEnabled();
      transcript.push(
        `after the first page's answer: [${(await settled.allTextContents()).join(", ")}]`,
      );
      await expect(settled).toHaveCount(0);
    });

    await test.step("the new page's lookup is settled by its own answer", async () => {
      await release(app, "inf:plugins:fetch", false);
      // The app's own answer: a card frame holds no fetch grant.
      await expect(settled).toHaveText(["lookup capability_not_granted"]);
    });
  } finally {
    if (evidence) {
      transcript.push(
        `at the end: [${(await settled.allTextContents().catch(() => [])).join(", ")}]`,
      );
      await page.screenshot({ path: join(evidence, "frame-answers.png") });
      writeFileSync(join(evidence, "frame-answers-transcript.txt"), `${transcript.join("\n")}\n`);
    }
    await launched.close();
  }
});
