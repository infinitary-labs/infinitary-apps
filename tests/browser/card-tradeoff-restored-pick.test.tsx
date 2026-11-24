import type { CardAction } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { draftStandIn, seededHome, subscribed } from "./freshHome";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * A pick a card's draft restores shows on its tradeoff chart. The captain's
 * report: "the recommended option was not clickable until i clicked the other
 * option and then switched back to the recommended option ... we need to fix
 * this for all users". They had picked the recommended option, replied, and
 * the card's revision drew a new body: the bridge restored the pick, but the
 * option's mark on the chart still showed unpicked, and a press on it did
 * nothing, since its option was already picked. Against a real home holding
 * the card and the picks left on it, each new body shows every restored pick
 * on its mark, and a question the captain may skip drops its Default ring.
 */

const TITLE = "What to do with a test check that cannot fail";
const ACTIONS: CardAction[] = [{ id: "send", label: "Send my choice", default: true }];
const NARROW = "Rename the case to what it proves, drop the no-fix check";
const PLACE_CHART = `
    <table data-inf-tradeoff>
      <tr><td></td><th>Maintainability</th><th>Ship fast</th></tr>
      <tr data-inf-option="own-file"><td>Its own file</td>
        <td data-inf-level="medium">one more file</td><td data-inf-level="high">no move</td></tr>
      <tr data-inf-option="intake-file"><td>Beside the intake cases</td>
        <td data-inf-level="high">one place to read</td><td data-inf-level="medium">a move</td></tr>
    </table>`;
const PLACE = `
  <fieldset>
    <legend>Where should the renamed case live?</legend>
    <label><input type="radio" name="place" value="own-file" data-inf-recommended> Keep it in its own file</label>
    <label><input type="radio" name="place" value="intake-file"> Move it beside the other intake cases</label>
    <label><input type="radio" name="place" value="other" data-inf-write-in> Something else</label>
    ${PLACE_CHART}
  </fieldset>`;
const body = (asBuilt: string) => `
  <p>The review found a test check that passes whether or not a fix starts.</p>
  <fieldset>
    <legend>What should the builder do with a test check that can never fail?</legend>
    ${asBuilt}
    <label><input type="radio" name="never-fails" value="narrow" required data-inf-recommended> ${NARROW}</label>
    <label><input type="radio" name="never-fails" value="make-fail" required> Make the check catch a started fix with a new test helper</label>
    <label><input type="radio" name="never-fails" value="other" required data-inf-write-in> Something else</label>
    <table data-inf-tradeoff>
      <tr><td></td><th>Maintainability</th><th>Ship fast</th></tr>
      ${asBuilt ? '<tr data-inf-option="keep"><td>Leave as built</td><td data-inf-level="low">a check that proves nothing</td><td data-inf-level="high">nothing to do</td></tr>' : ""}
      <tr data-inf-option="narrow"><td>Rename and drop</td>
        <td data-inf-level="high">no check that proves nothing</td><td data-inf-level="high">small</td></tr>
      <tr data-inf-option="make-fail"><td>Make it fail</td>
        <td data-inf-level="low">a new helper to keep</td><td data-inf-level="medium">medium</td></tr>
    </table>
  </fieldset>
  ${PLACE}`;
const KEEP =
  '<label><input type="radio" name="never-fails" value="keep" required data-inf-current> Leave as built</label>';
// The picks the captain left: the recommended option of the question they
// must answer, as proposed, and the other option of the one they may skip.
const PICKS: FrameAnswer[] = [
  { name: "never-fails", values: ["narrow"], labels: [NARROW], changed: false },
  {
    name: "place",
    values: ["intake-file"],
    labels: ["Move it beside the other intake cases"],
    changed: true,
  },
];

/** How the card's body shows the option `value` of the question `name`: its own control, its mark on the chart, and its Default ring. */
const shown = (name: string, value: string) =>
  inCardBody(
    TITLE,
    ([question, option]) => {
      const control = document.querySelector<HTMLInputElement>(
        `input[name="${question}"][value="${option}"]`,
      );
      const mark = control
        ?.closest("fieldset")
        ?.querySelector(`[data-inf-tradeoff-pick="${option}"]`);
      return {
        picked: control?.checked ?? null,
        markPicked: mark ? mark.hasAttribute("data-inf-tradeoff-picked") : null,
        ring: control?.hasAttribute("data-inf-default-ring") ?? null,
      };
    },
    [name, value] as const,
  );
const PICKED = { picked: true, markPicked: true, ring: false };
/** A press on the mark of the option `value`, which the chart draws in the option's place. */
const press = (value: string) =>
  inCardBody(
    TITLE,
    (option) =>
      document.querySelector<HTMLElement>(`[data-inf-tradeoff-pick="${option}"]`)?.click(),
    value,
  );

test("a body born with picks a draft restores shows each pick on its tradeoff mark, and a press there keeps it picked", async () => {
  const home = subscribed(
    await seededHome({
      title: TITLE,
      body: body(KEEP),
      actions: ACTIONS,
      answers: PICKS,
      words: "",
    }),
  );
  const saved = home["inf:cards:drafts"];
  const listed = home["inf:cards:list"];
  if (!Array.isArray(saved) || !saved[0]) throw new Error("The seeded home read no draft");
  if (!Array.isArray(listed) || !listed[0]) throw new Error("The seeded home read no card");
  const drafts = draftStandIn(saved);
  const bridge = fakeBridge(home);
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:draft", drafts.change);
  await openSize();
  await openWindow(bridge);
  await bodyDrawn(TITLE);
  await stageAtRest();

  // Section: the window opens on the picks left on the card, and each shows
  // on its mark, the recommended one included; the question the captain may
  // skip, answered, shows no Default ring.
  await expect.poll(() => shown("never-fails", "narrow")).toEqual(PICKED);
  expect(await shown("place", "intake-file")).toEqual(PICKED);
  expect(await shown("place", "own-file")).toEqual({
    picked: false,
    markPicked: false,
    ring: false,
  });

  // Section: a press on the recommended option's mark leaves it picked.
  await press("narrow");
  expect(await shown("never-fails", "narrow")).toEqual(PICKED);

  // Section: the card's revision takes out an option, as in the captain's
  // card, and its new body shows the restored pick on its mark.
  bridge.push("inf:cards", [{ ...listed[0], body: body("") }]);
  await expect
    .poll(() => inCardBody(TITLE, () => document.querySelector('input[value="keep"]') === null))
    .toBe(true);
  await expect.poll(() => shown("never-fails", "narrow")).toEqual(PICKED);
  expect(await shown("never-fails", "make-fail")).toEqual({
    picked: false,
    markPicked: false,
    ring: false,
  });
  expect(bridge.unanswered).toEqual([]);
});
