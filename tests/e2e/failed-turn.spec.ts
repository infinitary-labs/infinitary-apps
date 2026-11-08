import { expect, test } from "@playwright/test";
import {
  FIRSTMATE_FAILURE_TITLE,
  PROVIDER_SIGN_IN_TITLE,
} from "../../src/core/orchestrator/hostCards";
import { feedLineFrom } from "../../src/shared/feed";
import { FIRSTMATE_SESSION_ID } from "../../src/shared/observe";
import { PLAIN_PROBLEM_FALLBACK } from "../../src/shared/plainProblem";
import { type LaunchedApp, launchApp } from "./launch";
import { FAIL_AUTH_PROMPT_MARKER, FAIL_PROVIDER_PROMPT_MARKER } from "./mockProvider";

/**
 * A turn that fails AT THE PROVIDER must be user-visible (scout report
 * fm3000-devmode-auth-message-s1, REPRO A): Pi resolves such turns instead
 * of throwing, so before the turn_failed event existed the app showed no
 * card, no feed line, no log - a message the captain sent simply never got
 * an answer. These runs drive the real dev binary against a provider that
 * rejects the HTTP request, exactly like the reproduction harness.
 */

/**
 * The words the feed's own line for a failed first-mate turn leads with,
 * before its plain problem: `feedLineFrom`'s line with the fallback problem
 * taken off its end.
 */
const failedTurnLine = feedLineFrom({
  type: "turn_failed",
  taskId: FIRSTMATE_SESSION_ID,
  error: "",
})?.text;
if (!failedTurnLine?.endsWith(PLAIN_PROBLEM_FALLBACK))
  throw new Error("A failed first-mate turn writes no feed line with its fallback problem");
const FAILED_TURN_LEAD = failedTurnLine.slice(0, -PLAIN_PROBLEM_FALLBACK.length);

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ withMockProvider: true });
});

test.afterAll(async () => {
  await launched.close();
});

test("a provider 401 raises the sign-in decision card and a feed line, not silence", async () => {
  const { page } = launched;
  await page.evaluate(
    (marker) => window.infinitary.conversation.send(marker),
    FAIL_AUTH_PROMPT_MARKER,
  );

  // The real auth signal (401 invalid_api_key) routes to the same sign-in
  // decision the pre-flight path raises - one credential problem, one
  // user experience.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const cards = await window.infinitary.cards.list();
        return cards.map((card) => card.title);
      }),
    )
    .toContain(PROVIDER_SIGN_IN_TITLE);

  // The feed carries the failure durably; the receipt is no longer the
  // last anyone hears of the message.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const feed = await window.infinitary.feed.recent();
        return feed.map((line) => line.text);
      }),
    )
    .toContainEqual(expect.stringContaining(FAILED_TURN_LEAD));
});

test("a non-auth provider failure raises the retryable error card, never the sign-in card", async () => {
  const { page } = launched;
  await page.evaluate(
    (marker) => window.infinitary.conversation.send(marker),
    FAIL_PROVIDER_PROMPT_MARKER,
  );

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const cards = await window.infinitary.cards.list();
        return cards.map((card) => card.title);
      }),
    )
    .toContain(FIRSTMATE_FAILURE_TITLE);

  const cards = await page.evaluate(() => window.infinitary.cards.list());
  const errorCard = cards.find((card) => card.title === FIRSTMATE_FAILURE_TITLE);
  expect(errorCard?.body).toContain("mock deterministic provider failure");
  // The retry is the host's own effect on the host's own card (cards/tasks/agents P1).
  expect(errorCard?.author).toBe("host");
  expect(errorCard?.actions.map((action) => action.effect)).toEqual([
    { kind: "host", op: "retry-firstmate" },
  ]);
});
