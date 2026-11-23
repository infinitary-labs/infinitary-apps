import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { inShown, SHOWN_ENTRY } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Card changes, moved from `tests/e2e/card-changes.spec.ts`: a revision
 * that changed the card's title and its buttons links to those real
 * regions, and following a link by keyboard focuses the region without
 * choosing anything; Escape returns to the link. One window with the first
 * mate's card, revised three times, the last renaming it and giving it its
 * choices.
 */

const EARLIER_TITLE = "Earlier project checks";
const TITLE = "Review the project checks";
const FIRST_BODY = `<h2>What you asked</h2><p>Review the project before starting work.</p><h2>What stays the same</h2>${Array.from({ length: 6 }, (_, i) => `<p>The review keeps your project and your connected accounts unchanged. Item ${i + 1} stays as it was.</p>`).join("")}<h2 id="signin">Sign-in</h2><p>Use another account.</p><h2 id="checks">Checks</h2><details data-checks><summary>What I will check</summary><p data-check-result>Check the account after starting work.</p></details><h2>Next</h2><p>Nothing starts until you choose.</p><label>Review note <input name="note" value="Keep this draft"></label><details data-unrelated><summary>Other information</summary><p>Unrelated disclosure stays closed.</p></details>`;
const ACCOUNT_BODY = FIRST_BODY.replace("Use another account.", "Use your connected account.");
const CHECKS_BODY = ACCOUNT_BODY.replace(
  "Check the account after starting work.",
  "I will check the connected account before starting work.",
);
const ACTIONS = [
  { id: "keep", label: "Keep waiting", default: true },
  { id: "leave", label: "Leave it" },
];
const REPLY = "Done.";

const newestLinks = () => {
  const rows = document.querySelectorAll(`${SHOWN_ENTRY} [data-revision-links]`);
  return [...(rows[rows.length - 1]?.querySelectorAll<HTMLElement>("[data-revision-link]") ?? [])];
};

const focused = (element: Element) => document.activeElement === element;

test("title and button revision links focus their real regions without choosing", async () => {
  const bridge = fakeBridge(
    subscribed(
      await seededHome({
        first: { title: EARLIER_TITLE, body: FIRST_BODY },
        captain: "Check the connected account before starting.",
        revisions: [
          { write: { title: EARLIER_TITLE, body: ACCOUNT_BODY }, reply: REPLY },
          { write: { title: EARLIER_TITLE, body: CHECKS_BODY }, reply: REPLY },
          { write: { title: TITLE, body: CHECKS_BODY, actions: ACTIONS }, reply: REPLY },
        ],
      }),
    ),
  );
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => newestLinks().length).toBe(2);
  const scroller = inShown("[data-card-body]");
  scroller.scrollTop = scroller.scrollHeight;

  const title = newestLinks()[0] as HTMLElement;
  title.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => focused(inShown("[data-card-title]"))).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => focused(title)).toBe(true);

  const buttons = newestLinks()[1] as HTMLElement;
  buttons.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => focused(inShown("[data-card-actions]"))).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => focused(buttons)).toBe(true);

  expect(inShown("[data-card-title]").textContent).toContain(TITLE);
  expect(bridge.requests("inf:cards:act")).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
