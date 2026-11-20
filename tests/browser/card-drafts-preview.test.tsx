import type { CardAction } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome, subscribed } from "./freshHome";
import { bodyDrawn, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Unsent picks follow you (INF-5446), for a playable preview. The captain's
 * ask: "it would be cool if the answers you selected on cards showed up on
 * other devices too (like if you don't finish the card completely)"; on
 * settings that arrive while a preview is on screen they chose to keep them
 * for the preview's next birth, since its script reads them only then.
 * Against a real home holding the card, another window's settings arrive
 * while the preview shows, and a press then carries them.
 */

const CARD_ID = "card-drafts";
const TITLE = "Choose how fast the survey boat goes";
const START = "Start the survey";
const ACTIONS: CardAction[] = [{ id: "go", label: START, default: true }];
// The body as the bridge holds a preview's settings: staged by name beside
// its form, whatever script stages them (a script of its own needs the
// host's content policy, which this window's stand-in frames do not keep).
const BODY = "<p>Speed: 2 knots</p>";
const FASTER: FrameAnswer = { name: "boat", values: ['{"knots":5}'], changed: true, json: true };

test("another window's preview settings are kept for the body's next birth and go with a press", async () => {
  const home = subscribed(
    await seededHome({ title: TITLE, body: BODY, actions: ACTIONS, answers: [], words: "" }),
  );
  const saved = home["inf:cards:drafts"];
  const drafts = draftStandIn(Array.isArray(saved) ? saved : []);
  const bridge = fakeBridge(home);
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:draft", drafts.change);
  bridge.answer("inf:cards:act", { refusal: "Not this time." });
  await openSize();
  await openWindow(bridge);
  await bodyDrawn(TITLE);
  await stageAtRest();

  // Section: another window's settings arrive while the preview is on screen.
  bridge.push("inf:cards:draft", drafts.elsewhere(CARD_ID, { answers: [FASTER] }));

  // Section: a press carries them, as the preview's next birth reads them.
  await userEvent.click(
    page
      .getByRole("region", { name: TITLE, exact: true })
      .getByRole("button", { name: START, exact: true }),
  );
  await expect.poll(() => bridge.requests("inf:cards:act").length).toBe(1);
  const [, , , sent] = bridge.requests("inf:cards:act")[0] ?? [];
  const answers = (sent as { answers?: FrameAnswer[] } | undefined)?.answers ?? [];
  expect(answers.find((answer) => answer.name === FASTER.name)?.values).toEqual(FASTER.values);
});
