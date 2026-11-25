import type { CardAction } from "@shared/cards";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome, subscribed } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Unsent picks follow you, recommended ones too (INF-6671). The captain's
 * words: "the selections i made on my desktop aren't synced to my ios app. i
 * thought we'd sync it." A pick of the option a card recommends matches the
 * card's proposal, so its answer reads unchanged; it is still the captain's
 * pick, and goes to the card's shared draft like any other.
 */

const CARD_ID = "card-drafts-recommended";
const TITLE = "Plan outside contributions";
const ACTIONS: CardAction[] = [{ id: "go", label: "Approve and build", default: true }];
const BODY = `
  <fieldset><legend>When does a round read new issues?</legend>
    <label><input type="radio" name="intake" value="weekdays" data-inf-recommended> Weekdays</label>
    <label><input type="radio" name="intake" value="on-ask"> Only when you ask</label>
  </fieldset>
  <fieldset><legend>Who merges an outside pull request?</legend>
    <label><input type="radio" name="merge" value="you" data-inf-recommended> You</label>
    <label><input type="radio" name="merge" value="anyone"> Anyone with write access</label>
  </fieldset>`;

const pick = (value: string) =>
  inCardBody(
    TITLE,
    (picked) => (document.querySelector(`input[value="${picked}"]`) as HTMLInputElement).click(),
    value,
  );

test("a pick of a card's recommended option goes to the card's shared draft, keeping its answer unchanged", async () => {
  const home = subscribed(await seededHome({ title: TITLE, body: BODY, actions: ACTIONS }));
  const drafts = draftStandIn([]);
  const bridge = fakeBridge(home);
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:draft", drafts.change);
  await openSize();
  await openWindow(bridge);
  await bodyDrawn(TITLE);
  await stageAtRest();
  expect(bridge.requests("inf:cards:draft")).toEqual([]);

  // Section: the recommended option, picked alone, goes once the captain pauses.
  await pick("weekdays");
  await expect.poll(() => bridge.requests("inf:cards:draft").length).toBe(1);
  const [cardId, change] = bridge.requests("inf:cards:draft")[0] ?? [];
  expect(cardId).toBe(CARD_ID);
  expect(change?.answers).toEqual([
    { name: "intake", values: ["weekdays"], labels: ["Weekdays"], changed: false },
  ]);

  // Section: picked again after another option, before the pause, it still goes.
  await pick("you");
  await pick("anyone");
  await pick("you");
  await expect.poll(() => bridge.requests("inf:cards:draft").length).toBe(2);
  expect(bridge.requests("inf:cards:draft")[1]?.[1]?.answers).toEqual([
    { name: "merge", values: ["you"], labels: ["You"], changed: false },
  ]);
  expect(
    drafts
      .elsewhere(CARD_ID, {})
      .answers.map((answer) => answer.name)
      .sort(),
  ).toEqual(["intake", "merge"]);
  expect(bridge.unanswered).toEqual([]);
});
