import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { inShown, SHOWN_ENTRY } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * Card changes, moved from `tests/e2e/card-changes.spec.ts`: each revision
 * in a card's thread keeps the links to the areas it changed, and a link to
 * an area the current card no longer has says so where it is, without
 * moving the current card. One window with the first mate's card, revised
 * three times, the last taking the sign-in area away.
 */

const TITLE = "Review the project checks";
const SIGN_IN = '<h2 id="signin">Sign-in</h2><p>Use another account.</p>';
const FIRST_BODY = `<h2>What you asked</h2><p>Review the project before starting work.</p><h2>What stays the same</h2>${Array.from({ length: 6 }, (_, i) => `<p>The review keeps your project and your connected accounts unchanged. Item ${i + 1} stays as it was.</p>`).join("")}${SIGN_IN}<h2 id="checks">Checks</h2><details data-checks><summary>What I will check</summary><p data-check-result>Check the account after starting work.</p></details><h2>Next</h2><p>Nothing starts until you choose.</p><label>Review note <input name="note" value="Keep this draft"></label><details data-unrelated><summary>Other information</summary><p>Unrelated disclosure stays closed.</p></details>`;
const ACCOUNT_BODY = FIRST_BODY.replace("Use another account.", "Use your connected account.");
const CHECKS_BODY = ACCOUNT_BODY.replace(
  "Check the account after starting work.",
  "I will check the connected account before starting work.",
);
const REMOVED_BODY = CHECKS_BODY.replace(
  '<h2 id="signin">Sign-in</h2><p>Use your connected account.</p>',
  "",
);
const REPLY = "Done.";

/** The links of every revision row under the shown card, in order. */
const revisionLinks = () =>
  document.querySelectorAll<HTMLButtonElement>(
    `${SHOWN_ENTRY} [data-revision-links] [data-revision-link]`,
  );

test("an older missing area keeps its link and does not move the current card", async () => {
  const bridge = fakeBridge(
    subscribed(
      await seededHome({
        first: { title: TITLE, body: FIRST_BODY },
        captain: "Check the connected account before starting.",
        revisions: [ACCOUNT_BODY, CHECKS_BODY, REMOVED_BODY].map((body) => ({
          write: { title: TITLE, body },
          reply: REPLY,
        })),
      }),
    ),
  );
  bridge.answer("inf:cards:seen-update", { ok: true });
  await openSize();
  await openWindow(bridge);
  await expect.poll(() => revisionLinks()[0]?.checkVisibility()).toBe(true);
  const link = revisionLinks()[0] as HTMLButtonElement;
  const scroller = inShown("[data-card-body]");
  scroller.scrollTop = 0;
  await userEvent.click(link);
  const status = () =>
    document.querySelector<HTMLElement>(`${SHOWN_ENTRY} [data-revision-links] [role="status"]`);
  await expect.poll(() => status()?.checkVisibility()).toBe(true);
  expect(status()?.closest("[data-revision-links]")).toBe(link.closest("[data-revision-links]"));
  expect(inShown("[data-card-body]").scrollTop).toBe(0);
  expect(link.isConnected && link.checkVisibility()).toBe(true);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
