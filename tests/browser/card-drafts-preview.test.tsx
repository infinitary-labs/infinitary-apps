import type { CardAction } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome, subscribed } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Unsent picks follow you (INF-5446), for a playable preview. The captain's
 * ask: "it would be cool if the answers you selected on cards showed up on
 * other devices too (like if you don't finish the card completely)"; they
 * chose to apply synced settings through the preview's own controls, so a
 * preview that gives the bridge no way to apply a setting keeps what it
 * shows (tests/browser/card-preview-settings.test.ts drives one that does).
 * Against a real home holding the card, another window's settings arrive
 * while such a preview shows: a press sends what the preview holds, now and
 * after the body is born again, and nothing goes back to the other window.
 */

const CARD_ID = "card-drafts";
const TITLE = "Choose how fast the survey boat goes";
const START = "Start the survey";
const ACTIONS: CardAction[] = [{ id: "go", label: START, default: true }];
// A body with no script, as a preview that gives no way to apply a setting:
// a script of its own needs the host's content policy, which this window's
// stand-in frames do not keep.
const BODY = "<p>The survey boat</p>";
const REVISED = "<p>The survey boat, revised</p>";
const FASTER: FrameAnswer = { name: "boat", values: ['{"knots":5}'], changed: true, json: true };

test("a preview that cannot apply another window's settings sends what it holds, now and at its next birth", async () => {
  const home = subscribed(
    await seededHome({ title: TITLE, body: BODY, actions: ACTIONS, answers: [], words: "" }),
  );
  const saved = home["inf:cards:drafts"];
  const listed = home["inf:cards:list"];
  if (!Array.isArray(listed) || !listed[0]) throw new Error("The seeded home read no card");
  const drafts = draftStandIn(Array.isArray(saved) ? saved : []);
  const bridge = fakeBridge(home);
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:draft", drafts.change);
  // The press is refused, so the card stays to be pressed again.
  bridge.answer("inf:cards:act", { refusal: "Not this time." });
  await openSize();
  await openWindow(bridge);
  await bodyDrawn(TITLE);
  await stageAtRest();
  const press = async () => {
    const before = bridge.requests("inf:cards:act").length;
    await userEvent.click(
      page
        .getByRole("region", { name: TITLE, exact: true })
        .getByRole("button", { name: START, exact: true }),
    );
    await expect.poll(() => bridge.requests("inf:cards:act").length).toBe(before + 1);
    const [, , , sent] = bridge.requests("inf:cards:act")[before] ?? [];
    const answers = (sent as { answers?: FrameAnswer[] } | undefined)?.answers ?? [];
    return answers.find((answer) => answer.name === FASTER.name)?.values ?? null;
  };

  // Section: another window's settings arrive while the preview is on screen,
  // and a press sends what the preview on screen holds, which is none of them.
  bridge.push("inf:cards:draft", drafts.elsewhere(CARD_ID, { answers: [FASTER] }));
  expect(await press()).toBeNull();

  // Section: the body's next birth cannot show them either, so it sends none of them.
  bridge.push("inf:cards", [{ ...listed[0], body: REVISED }]);
  await expect
    .poll(() => inCardBody(TITLE, () => document.body.textContent?.includes("revised")))
    .toBe(true);
  expect(await press()).toBeNull();
  // The settings came from the other window, so this window sent nothing back.
  expect(bridge.requests("inf:cards:draft")).toEqual([]);
});
