import type { Locator, Page } from "@playwright/test";
import { CREWMATE_WORDS } from "../../src/shared/crewTranscript";
import { SHOWN_ENTRY } from "./stack";

/**
 * The task card's Crewmate tab as the journeys read it
 * (docs/task-card-tabs.md, "The Crewmate tab"): the view on the stage and
 * its parts by their typed hooks, never by their words.
 */

/** The Crewmate tab of `taskId` on the stage. */
export const crewmateView = (page: Page, taskId: string): Locator =>
  page.locator(`${SHOWN_ENTRY} [data-task-crewmate="${taskId}"]`);

/** Its transcript's lines of one kind, in order (`CrewLine["kind"]`, or `result` for a call's answer). */
export const crewLines = (view: Locator, kind: string): Locator =>
  view.locator(`[data-crew-log] [data-crew-line="${kind}"]`);

/** The kinds of every line the transcript draws, in order. */
export const crewLineKinds = (view: Locator): Promise<string[]> =>
  view
    .locator("[data-crew-log] [data-crew-line]")
    .evaluateAll((lines) => lines.map((line) => line.getAttribute("data-crew-line") ?? ""));

/** A line someone sent the crewmate: the captain's, Firstmate's or the app's. */
export const sentBy = (view: Locator, from: "captain" | "firstmate" | "app"): Locator =>
  view.locator(`[data-crew-line="sent"][data-crew-from="${from}"]`);

/** The words of a line someone sent, without its mark or its queued word. */
export const sentWords = (view: Locator, from: "captain" | "firstmate" | "app"): Locator =>
  sentBy(view, from).locator("[data-crew-words]");

/** The call to a tool by its name, and the line under it with what it answered. */
export function callTo(view: Locator, tool: string): { call: Locator; result: Locator } {
  const call = view.locator(`[data-crew-line="tool"][data-crew-tool="${tool}"]`);
  return { call, result: call.locator("xpath=following-sibling::*[1]") };
}

/** A block the app's own tools draw: the plan, a report, a card, the pull request. */
export const crewBlock = (view: Locator, kind: "plan" | "report" | "card" | "change"): Locator =>
  view.locator(`[data-crew-block="${kind}"]`);

/** The boxed prompt's field, by its accessible name. */
export const crewComposer = (view: Locator): Locator =>
  view.getByRole("textbox", { name: CREWMATE_WORDS.field });
