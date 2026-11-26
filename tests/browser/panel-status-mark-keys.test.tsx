import type { PersonalExtensionView } from "@shared/personal/manifest";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import {
  BACKGROUND_RETRY,
  BACKGROUND_STOPPED_LINE,
  FAILING_ASK,
  FAILING_HEADING,
  MARK_STOPPED,
} from "../../src/renderer/src/personal/panelBoundaryWords";
import { fakeBridge } from "./bridge";
import { freshHome, subscribed } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A panel's status mark from the keyboard (the captain's plan for the mark;
 * the captain's rule that every feature works from the keyboard): focus on
 * the mark shows its most urgent line, Enter opens its details with
 * focus on their first button, Esc closes them with focus back on the mark,
 * Space opens them again, and a button sends its request.
 */

const GROWTH: PersonalExtensionView = {
  id: "growth",
  source: "yours",
  by: null,
  title: "Growth",
  placement: { x: "left", y: "top" },
  order: 0,
  size: "content",
  present: true,
  ownPresence: false,
  moves: false,
  running: false,
  reads: [],
  sql: [],
  panel: null,
  frame: { version: "0123456789abcdef" },
  server: null,
  cardViews: [],
  cards: {},
  header: [],
  commands: [],
  error: null,
  stopped: { reason: "unresponsive", at: "2026-11-24T10:00:00.000Z", version: "s1" },
  failing: [
    {
      read: { kind: "background", task: "refresh" },
      since: "2026-11-24T09:00:00.000Z",
      tries: 6,
      answer: "Error: 429 Too Many Requests: the connector allows 150 reads a day",
      asked: false,
    },
  ],
};

const mark = () => document.querySelector<HTMLElement>('[data-panel-status-mark="growth"]');
const details = () => document.querySelector<HTMLElement>('[data-panel-status-details="growth"]');
const label = () => document.querySelector<HTMLElement>("[data-icon-label]")?.textContent ?? null;

test("a panel's status mark opens, closes and presses from the keyboard", async () => {
  const home = subscribed(freshHome());
  const bridge = fakeBridge({
    ...home,
    "inf:plugins:personal:list": { extensions: [GROWTH] },
    "inf:plugins:retry": true,
    "inf:plugins:ask-firstmate": true,
  });
  await openSize();
  await openWindow(bridge);
  await expect.poll(mark).not.toBeNull();
  expect(mark()?.getAttribute("aria-label")).toBe(MARK_STOPPED);

  // Section: the keyboard's focus on the mark shows its most urgent line.
  (mark() as HTMLElement).focus();
  await expect.poll(label).toContain(MARK_STOPPED);
  expect(details()).toBeNull();

  // Section: Enter opens the details, most urgent first, focus on the first button.
  await userEvent.keyboard("{Enter}");
  await expect.poll(details).not.toBeNull();
  const sections = [...(details() as HTMLElement).querySelectorAll("[data-panel-status-section]")];
  expect(sections.map((section) => section.getAttribute("data-panel-status-section"))).toEqual([
    "stopped",
    "failing",
  ]);
  expect(sections[0]?.textContent).toContain(BACKGROUND_STOPPED_LINE);
  expect(sections[1]?.textContent).toContain(FAILING_HEADING);
  expect(sections[1]?.textContent).toContain("429 Too Many Requests");
  await expect.poll(() => document.activeElement?.textContent).toBe(BACKGROUND_RETRY);
  expect(mark()?.getAttribute("aria-expanded")).toBe("true");

  // Section: Esc closes them and gives focus back to the mark.
  await userEvent.keyboard("{Escape}");
  await expect.poll(details).toBeNull();
  expect(document.activeElement).toBe(mark());

  // Section: Space opens them again; Tab to Ask the first mate and Enter sends it once.
  await userEvent.keyboard(" ");
  await expect.poll(details).not.toBeNull();
  await expect.poll(() => document.activeElement?.textContent).toBe(BACKGROUND_RETRY);
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement?.textContent).toBe(FAILING_ASK);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => bridge.requests("inf:plugins:ask-firstmate")).toEqual([["growth"]]);
  expect(bridge.requests("inf:plugins:retry")).toEqual([]);
});
