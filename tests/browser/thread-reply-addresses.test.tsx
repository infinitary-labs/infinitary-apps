import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { answerStack, SHOWN_ENTRY } from "./stack";
import { openWindow } from "./window";

/**
 * An address a card's thread reply writes as words is a link (INF-7045's
 * plan, part 2: the captain picked "Card bodies and the card's thread
 * replies" after a Secrets ask's step "Open https://openrouter.ai/settings/keys
 * and sign in." showed its address as plain text). A click and an Enter, the
 * captain's own, ask the opener for exactly the address; a script's click
 * asks nothing. The opener's rule decides what links: a public http address
 * and words with no scheme stay text, and the reply's task key still links.
 */

const TITLE = "Add OpenRouter API key to Secrets?";
const ADDRESS = "https://openrouter.ai/settings/keys";
const ANSWER = `Open ${ADDRESS} and sign in.`;
const REPLY =
  "The old page http://openrouter.ai/keys and openrouter.ai/keys both sent me there. It is for {key}.";

const shown = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(`${SHOWN_ENTRY} ${selector}`),
];
const answerLinks = () => shown('[data-thread-message="firstmate"] a[href]');
const replyLine = () => shown('[data-thread-message="captain"]')[0];

test("an address in a card's thread reply opens on the captain's own press, and only what the opener takes links", async () => {
  const home = subscribed(await seededHome({ title: TITLE, answer: ANSWER, reply: REPLY }));
  const bridge = fakeBridge(home);
  answerStack(bridge, home);
  bridge.answer("inf:app:open-external", { ok: true });
  await page.viewport(1280, 820);
  await openWindow(bridge);
  await expect.element(page.getByRole("region", { name: TITLE, exact: true })).toBeVisible();

  // Section: the answer's address is the link's words and its address, the sentence's end outside it.
  await expect.poll(() => answerLinks().map((link) => link.textContent)).toEqual([ADDRESS]);
  const [link] = answerLinks();
  if (!link) throw new Error("The answer drew no link");
  expect(link.getAttribute("href")).toBe(ADDRESS);
  expect(link.parentElement?.textContent).toContain(`${ADDRESS} and sign in.`);

  // Section: public http and scheme-less words stay text; the task key still links to its task.
  await expect.poll(() => replyLine()?.querySelector("[data-task-key]")?.textContent).toBe("SCR-1");
  expect(replyLine()?.querySelectorAll("a[href]").length).toBe(0);

  // Section: a script's click opens nothing; a click and an Enter each ask the opener once.
  link.click();
  await userEvent.click(link);
  link.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => bridge.requests("inf:app:open-external")).toEqual([[ADDRESS], [ADDRESS]]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
