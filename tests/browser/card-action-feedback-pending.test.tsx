import type { CardAction } from "@shared/cards";
import type { InvokeChannel, InvokeResponse } from "@shared/ipc";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PENDING_LABEL } from "../../src/renderer/src/design/core/Button";
import { type FakeBridge, fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import type { Rect } from "./layout";
import { bodyDrawn, inCardBody, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Card action feedback, moved from `tests/e2e/card-action-feedback.spec.ts`:
 * a card's choice acknowledges at the first frame, before its answer, in the
 * place it was pressed - the row does not shift, a second press in the same
 * tick and a press on the body's own action send nothing more - and a
 * refusal says why and gives the choices back. Receipt alone lets the card
 * go. The answer is held as the test chooses, not on a timer, and a refusal
 * reaches the window as Electron hands it a handler's rejection, wrapped in
 * the remote method's name. One window with the first mate's card, in the
 * dark theme a fresh home opens on.
 */

const CHOOSE_TITLE = "Choose a course";
const CHOOSE = "Choose";
const WAIT = "Wait";
const ACTIONS: CardAction[] = [
  { id: "choose", label: CHOOSE },
  { id: "wait", label: WAIT },
];
const HOOK = "data-fm-action"; // Firstmate 3000's hook, as a card saved before the rename writes it.
const BODY = `<p>Choose what happens next.</p><button ${HOOK}="choose">${CHOOSE}</button>`;

const REQUEST_REASON = "The request could not be completed.";

/** What Electron hands the window for a handler that rejected with `name: message`. */
function transported(channel: InvokeChannel, name: string, message: string): Error {
  return new Error(
    `Error invoking remote method '${channel}': ${message ? `${name}: ${message}` : name}`,
  );
}

/**
 * Holds `channel`'s answers until the test lets each one go: controlled
 * latency, not a timer. `reply` answers the newest request with `result`, or
 * rejects it as Electron would.
 */
function hold<C extends InvokeChannel>(bridge: FakeBridge, channel: C, result: InvokeResponse<C>) {
  const probe = {
    calls: 0,
    settle: (_fail: boolean) => {},
    reply(fail = false) {
      probe.settle(fail);
    },
  };
  bridge.answer(channel, () => {
    probe.calls += 1;
    return new Promise<InvokeResponse<C>>((resolve, reject) => {
      probe.settle = (fail) =>
        fail ? reject(transported(channel, "Error", REQUEST_REASON)) : resolve(result);
    });
  });
  return probe;
}

const box = (element: Element): Rect => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const footerAction = (name: string) =>
  page
    .getByRole("region", { name: CHOOSE_TITLE, exact: true })
    .getByRole("button", { name, exact: true });

test("pending card actions acknowledge at the first frame without shifting the row (dark)", async () => {
  const bridge = fakeBridge(
    subscribed(await seededHome({ title: CHOOSE_TITLE, body: BODY, actions: ACTIONS })),
  );
  bridge.answer("inf:cards:seen-update", { ok: true });
  const act = hold(bridge, "inf:cards:act", {});
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => document.body.dataset.theme).toBe("dark");
  await expect.element(footerAction(CHOOSE)).toBeVisible();
  await bodyDrawn(CHOOSE_TITLE);
  await expect
    .poll(() =>
      inCardBody(
        CHOOSE_TITLE,
        (name) =>
          [...document.querySelectorAll("button")].some(
            (button) => button.textContent === name && button.checkVisibility(),
          ),
        CHOOSE,
      ),
    )
    .toBe(true);
  await document.fonts.ready;
  // The stage's entrance has ended, so the row is measured once it holds
  // still: the click, not that move, must leave it in place.
  await stageAtRest();
  const choose = footerAction(CHOOSE).element() as HTMLButtonElement;
  const keep = footerAction(WAIT).element() as HTMLButtonElement;
  const before = box(choose);
  const siblingBefore = box(keep);

  choose.click();
  choose.click(); // Same-tick click, before React paints.
  await nextFrame();
  expect({ disabled: choose.disabled, busy: choose.getAttribute("aria-busy") }).toEqual({
    disabled: true,
    busy: "true",
  });
  const pending = footerAction(PENDING_LABEL);
  await expect.element(pending).toBeDisabled();
  await expect.element(footerAction(WAIT)).toBeDisabled();
  expect(box(pending.element())).toEqual(before);
  expect(box(keep)).toEqual(siblingBefore);
  // Body actions ride the same store guard as the host's footer.
  await inCardBody(
    CHOOSE_TITLE,
    (name) =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === name)
        ?.click(),
    CHOOSE,
  );
  await expect.poll(() => act.calls).toBe(1);

  act.reply(true);
  const alert = page.getByRole("alert");
  await expect.element(alert).toBeVisible();
  await expect.element(alert).toHaveTextContent(REQUEST_REASON);
  expect(alert.element().textContent).toBe(REQUEST_REASON);
  await expect.element(footerAction(CHOOSE)).toBeEnabled();
  await expect.element(footerAction(WAIT)).toBeEnabled();

  // Retrying an unaccepted request works. Receipt alone closes it, with no
  // cards push from the core.
  await userEvent.click(footerAction(CHOOSE));
  await expect.poll(() => act.calls).toBe(2);
  act.reply();
  // The core still holds the card in its list: the stage let it go.
  await expect
    .poll(() => page.getByRole("region", { name: CHOOSE_TITLE, exact: true }).query())
    .toBeNull();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
