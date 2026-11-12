import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { launchClaudeSeat, say } from "./claudeSeat";
import type { LaunchedApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, startMockProvider } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { CONTEXT_OVERFLOW_PROMPT_MARKER, contextOverflow } from "./scenarios/contextOverflow";
import { slowShortening } from "./scenarios/slowShortening";
import { closeOpenCards, shownCard } from "./stack";

/** INF-3011: while the first mate shortens its conversation, the character draws itself tight (the cinch) for the whole shortening, then springs back.
 * Fixture: real boxed Claude client, dummy subscription, isolated HOME/userData and a loopback provider that refuses the conversation as too long, then takes its time over the summary.
 * Completion: the window hears the shortening start and end inside the turn, the character's ink draws in between them, and the turn ends (the busy state falls) after the answer card arrives.
 * Prerequisites: Electron and the SDK's client on macOS/Linux; no shared resources or real sign-in.
 */

declare global {
  interface Window {
    /** Each firstmate_state the window hears, in order. */
    __fmStates?: { busy: boolean; folding?: boolean }[];
    /** The character's ink reach on each sampled frame, with whether a shortening was running. */
    __fmReach?: { folding: boolean; reach: number }[];
  }
}

/**
 * Records what the window hears and, every few drawing frames, how far the
 * character's solid ink reaches from the canvas's centre as a share of its half width.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const states: { busy: boolean; folding?: boolean }[] = [];
    const reach: { folding: boolean; reach: number }[] = [];
    window.__fmStates = states;
    window.__fmReach = reach;
    let folding = false;
    window.infinitary.events.on((event) => {
      if (event.type !== "firstmate_state") return;
      states.push(
        event.folding === undefined
          ? { busy: event.busy }
          : { busy: event.busy, folding: event.folding },
      );
      folding = event.folding === true;
    });
    let frame = 0;
    const sample = () => {
      frame += 1;
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[aria-label^="First mate - "]',
      );
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx && frame % 3 === 0 && canvas.width > 0) {
        const { width, height } = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        const cx = width / 2;
        const cy = height / 2;
        let far = 0;
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            if ((data[(y * width + x) * 4 + 3] ?? 0) < 160) continue;
            far = Math.max(far, Math.hypot(x - cx, y - cy));
          }
        }
        if (far > 0) reach.push({ folding, reach: far / cx });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const states = (page: Page) => page.evaluate(() => window.__fmStates ?? []);
const reaches = (page: Page) => page.evaluate(() => window.__fmReach ?? []);

/** Starts the record over, so it holds the next turn alone. */
const restart = (page: Page) =>
  page.evaluate(() => {
    window.__fmStates?.splice(0);
    window.__fmReach?.splice(0);
  });

/**
 * Returns once the last state the window heard is the first mate falling idle: the turn's end.
 * The answer card is filed inside the turn and shown while the first mate still asks
 * for its closing words, so a shown card is not the turn's end; reading the record
 * at the card raced that last request and missed the turn's end on a loaded run.
 */
const turnEnded = (page: Page) =>
  expect.poll(async () => (await states(page)).at(-1)?.busy, { timeout: 45_000 }).toBe(false);

test("the first mate draws itself tight while it shortens its conversation", async () => {
  const evidence = process.env.INFINITARY_CINCH_EVIDENCE_DIR;
  const mockProvider = await startMockProvider({ scenarios: [contextOverflow, slowShortening] });
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchClaudeSeat({ mockProvider });
    const { app, page } = launched;
    await watch(page);
    await say(page, `hello ${ANSWER_PROMPT_MARKER}`);
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible();
    // The first turn has ended before the record starts over, so none of it reaches the next.
    await turnEnded(page);
    await closeOpenCards(page);
    await restart(page);
    const character = page.getByRole("img", { name: /^First mate - / });

    await say(page, `hello ${CONTEXT_OVERFLOW_PROMPT_MARKER} ${ANSWER_PROMPT_MARKER}`);
    // The shortening starts inside the turn, and the stand-in holds its summary.
    await expect
      .poll(async () => (await states(page)).some((state) => state.folding === true), {
        timeout: 45_000,
      })
      .toBe(true);
    // Before it: the character as it works, at its own size.
    const before = (await reaches(page)).filter((sample) => !sample.folding);
    expect(before.length).toBeGreaterThan(0);
    const rest = Math.min(...before.map((sample) => sample.reach));
    // While it runs, the body is drawn tight: its ink pulls well inside where it reached.
    await expect
      .poll(async () =>
        Math.min(
          ...(await reaches(page)).filter((sample) => sample.folding).map((sample) => sample.reach),
        ),
      )
      .toBeLessThan(rest * 0.8);
    if (evidence) {
      await regionShot(character, join(evidence, "character-cinch-after.png"));
      await heroShot(app, page, { region: character, name: "character-cinch" });
    }

    // It ends inside the same turn, and the answer comes.
    await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 45_000 });
    await turnEnded(page);
    expect(await states(page)).toEqual([
      { busy: true },
      { busy: true, folding: true },
      { busy: true, folding: false },
      { busy: false },
    ]);
    // The answer card hides the character, which may stop it mid spring-back;
    // with the card put away it is drawn back out past the line it drew in under.
    await closeOpenCards(page);
    await expect
      .poll(async () => (await reaches(page)).at(-1)?.reach ?? 0)
      .toBeGreaterThanOrEqual(rest * 0.8);
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});
