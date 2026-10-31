import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { clickInBody, closeQuestion, shownCard, shownEntry } from "./stack";

const evidence = process.env.FM_CARD_DEPARTURE_EVIDENCE;
/** The two seeded cards: the one a choice closes and the successor the stage prepares. */
const CHOSEN_PLAN = "The chosen plan";
const NEXT_PREVIEW = "The next preview";
for (const action of [
  "Approve and build",
  "Build it",
  "Save and defer",
  "Abandon",
  "Close",
  "Discard and close",
]) {
  test(`${action} closes without waiting for the next body`, async () => {
    const userDataDir = scratchDir("infinitary-card-departure-");
    const db = openDatabase(userDataDir);
    const cards = new CardStore(db);
    for (const [id, title, body, createdAt] of [
      [
        "chosen",
        CHOSEN_PLAN,
        '<p>Build the selected plan.</p><label><input type="checkbox" name="trail" value="on"> Leave a trail</label>',
        1,
      ],
      [
        "next",
        NEXT_PREVIEW,
        '<p>The next preview is ready.</p><script>document.documentElement.dataset.preview = "ready";</script>',
        2,
      ],
      // INF-1961: three cards leave a decorative peek after Close. Two
      // cards alone cannot expose the border-first presentation defect.
      ["last", "The final note", "<p>One more note waits behind the preview.</p>", 3],
    ] as const) {
      cards.upsert({
        id,
        title,
        body,
        createdAt,
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        status: "ready",
        actions: [
          { id: "approve", label: action === "Close" ? "Build it" : action, default: true },
          { id: "leave", label: "Leave it" },
        ],
      });
    }
    db.close();
    const launched = await launchApp({ userDataDir });
    try {
      const { app, page } = launched;
      await expect(shownCard(page, CHOSEN_PLAN)).toBeVisible();
      // Hold the real mount request, not the app or renderer: the scripted
      // successor the stage prepares while the chosen plan is read cannot be
      // served until this test releases it. No busy loop or clock race.
      await app.evaluate(({ ipcMain }) => {
        const channel = "inf:frames:mount";
        const handlers = (
          ipcMain as typeof ipcMain & {
            _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
          }
        )._invokeHandlers;
        const mount = handlers.get(channel);
        if (!mount) throw new Error("Frame mount handler missing");
        const probe = { called: false, release: () => {} };
        (globalThis as typeof globalThis & { departureMount: typeof probe }).departureMount = probe;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          probe.called = true;
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
          return mount(event, ...args);
        });
      });
      // The page starts again under the held mount, so the successor it
      // prepares is the one that cannot draw.
      await page.reload();
      await expect(shownCard(page, CHOSEN_PLAN)).toBeVisible();
      await page.evaluate((title) => {
        const probe = { held: false, gone: false, brighterPeek: false };
        (window as typeof window & { departureProbe: typeof probe }).departureProbe = probe;
        const opacity = (element: Element) => {
          let value = 1;
          for (let el: Element | null = element; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return 0;
            value *= Number(style.opacity);
          }
          return value;
        };
        const tick = () => {
          const chosen = document.querySelector(`[data-response-card][aria-label="${title}"]`);
          if (!chosen) probe.gone = true;
          if (chosen && document.querySelector("[data-stage-shield]")) probe.held = true;
          // INF-1961's natural recording exposed peeks even before outgoing
          // opacity reached zero. Decoration cannot outshine every drawing.
          const surface = Math.max(
            0,
            ...Array.from(document.querySelectorAll("[data-stage-entry]"), opacity),
          );
          if (
            Array.from(document.querySelectorAll("[data-card-peek]"), opacity).some(
              (value) => value > surface,
            )
          )
            probe.brighterPeek = true;
          if (!probe.gone) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, CHOSEN_PLAN);
      if (action === "Discard and close") {
        const trail = cardBody(page, CHOSEN_PLAN).getByLabel("Leave a trail");
        await clickInBody(trail);
        await expect(trail).toBeChecked();
        await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
        await expect(closeQuestion(page)).toBeVisible();
        // Asking does not close; only the confirmed discard departs.
        expect(
          (await page.evaluate(() => window.infinitary.cards.list())).some(
            (card) => card.id === "chosen",
          ),
        ).toBe(true);
        await closeQuestion(page).getByRole("button", { name: action, exact: true }).click();
      } else {
        await shownEntry(page).getByRole("button", { name: action, exact: true }).click();
      }
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as typeof globalThis & { departureMount: { called: boolean } })
                .departureMount.called,
          ),
        )
        .toBe(true);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page
          .locator("[data-card-layer]")
          .screenshot({ path: `${evidence}/${action}-departure.png` });
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { departureProbe: { gone: boolean } }).departureProbe.gone,
          ),
        )
        .toBe(true);
      const probe = await page.evaluate(
        () =>
          (
            window as typeof window & {
              departureProbe: { held: boolean; gone: boolean; brighterPeek: boolean };
            }
          ).departureProbe,
      );
      const stack = await page.evaluate(() => window.infinitary.cards.list());
      expect(stack.map((card) => card.id)).toEqual(["next", "last"]);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page
          .locator("[data-card-layer]")
          .screenshot({ path: `${evidence}/${action}-pending.png` });
        writeFileSync(
          `${evidence}/${action}.json`,
          JSON.stringify({ probe, stack: stack.map((card) => card.id) }),
        );
      }
      // A closed card is gone before the blocked successor draws. No empty
      // successor chrome replaces it while that frame still cannot load.
      expect(probe.held, "a closed card must not wait on the successor's drawing").toBe(false);
      expect(probe.brighterPeek, "peeks must depart with the fading card, not outshine it").toBe(
        false,
      );
      await expect(shownEntry(page)).toHaveCSS("opacity", "0");
      // Captain's border-first report (INF-1961): no decorative surface may
      // remain painted after the dismissed drawing retires, while the next
      // body is still held. Read effective opacity through its real parents.
      expect(
        await page.locator("[data-card-peek]").evaluateAll(
          (peeks) =>
            peeks.filter((peek) => {
              for (let el: Element | null = peek; el; el = el.parentElement) {
                const style = getComputedStyle(el);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0
                )
                  return false;
              }
              return true;
            }).length,
        ),
        "No standalone border before the successor draws",
      ).toBe(0);
      await app.evaluate(() =>
        (
          globalThis as typeof globalThis & { departureMount: { release: () => void } }
        ).departureMount.release(),
      );
      await expect(shownCard(page, NEXT_PREVIEW)).toBeVisible();
      // Peeks return with the drawn card; permanently hiding them is not a fix.
      await expect(shownEntry(page).locator("[data-card-peek]")).toBeVisible();
      await expect(cardBody(page, NEXT_PREVIEW).locator("[data-preview]")).toHaveAttribute(
        "data-preview",
        "ready",
      );
      if (evidence)
        await page
          .locator("[data-card-layer]")
          .screenshot({ path: `${evidence}/${action}-ready.png` });
    } finally {
      await launched.close();
    }
  });
}
