import type { CardAction, CardPressInput, CardSubmission } from "@shared/cards";
import { DEFAULT_BINDINGS, keyHint } from "@shared/keyboard";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { thisDesktop } from "../../src/renderer/src/design/core/desktop";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { bodyDrawn, stageAtRest } from "./stack";
import { openSize, openWindow } from "./window";

/**
 * What pressed a card's button rides the press (INF-4175): the record of an
 * unclicked Start could not tell a click from a key, so a choice now says
 * whether a pointer, Enter or Space on the button, ⌘1, or command search
 * pressed it, and a click a script made says nothing rather than a guess.
 * The core refuses each press here, so the card stays for the next one.
 */

const TITLE = "Start the checked fixes";
const START = "Start";
const ACTIONS: CardAction[] = [
  { id: "file", label: "File" },
  { id: "start", label: START, default: true },
];
const BODY = "<p>Two fixes to file or start.</p>";
const HELD = "Not this time.";

const start = () =>
  page
    .getByRole("region", { name: TITLE, exact: true })
    .getByRole("button", { name: START, exact: true });

test("each press of a card's choice says what pressed it: pointer, Enter, Space, ⌘1 or command search", async () => {
  const bridge = fakeBridge(
    subscribed(await seededHome({ title: TITLE, body: BODY, actions: ACTIONS })),
  );
  bridge.answer("inf:cards:seen-update", { ok: true });
  bridge.answer("inf:cards:act", { refusal: HELD });
  await openSize();
  await openWindow(bridge);
  await expect.element(start()).toBeVisible();
  await bodyDrawn(TITLE);
  await stageAtRest();

  /** The input the newest press sent, once the `count`th press went and its choices came back. */
  const pressed = async (count: number): Promise<CardPressInput | undefined> => {
    await expect.poll(() => bridge.requests("inf:cards:act").length).toBe(count);
    await expect.element(start()).toBeEnabled();
    const [, actionId, , , submission] = bridge.requests("inf:cards:act")[count - 1] ?? [];
    expect(actionId).toBe("start");
    return (submission as CardSubmission | undefined)?.input;
  };

  // Section: a pointer's click.
  await userEvent.click(start());
  expect(await pressed(1)).toEqual({ kind: "pointer", pointer: "mouse" });

  // Section: the focused button's own keys.
  (start().element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(await pressed(2)).toEqual({ kind: "key", key: "Enter" });
  (start().element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  expect(await pressed(3)).toEqual({ kind: "key", key: "Space" });

  // Section: ⌘1, heard by the main process, which names its command alone.
  bridge.push("inf:keyboard:command", { command: "cards.choice-1" });
  const choiceKey = keyHint("cards.choice-1", DEFAULT_BINDINGS, thisDesktop().keys);
  expect(await pressed(4)).toEqual({
    kind: "key",
    command: "cards.choice-1",
    keys: [choiceKey],
  });

  // Section: the same command, chosen in command search.
  bridge.push("inf:keyboard:command", { command: "commands.search" });
  const row = () => document.querySelector<HTMLElement>('[data-command="cards.choice-1"]');
  await expect.poll(row).not.toBeNull();
  await userEvent.click(page.elementLocator(row() as HTMLElement));
  expect(await pressed(5)).toEqual({ kind: "command-search", command: "cards.choice-1" });

  // Section: a click a script made names nothing, never a guess.
  (start().element() as HTMLElement).click();
  expect(await pressed(6)).toBeUndefined();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
