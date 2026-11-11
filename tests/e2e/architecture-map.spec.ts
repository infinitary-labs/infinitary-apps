import { readFileSync } from "node:fs";
import { expect, type FrameLocator, type Locator, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { Card } from "../../src/shared/cards";
import { fillMapPart, MAP_DATA } from "../helpers/architectureMap";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { showCard } from "./stack";
import { pressKey, runFromSearch } from "./windowKeys";

/**
 * The Advanced architecture runbook's map on a card, from the keyboard alone
 * (the approved plan's "What done looks like": a journey goes in by keys,
 * opens a state machine and turns on a comparison; the captain's 2026-10-04
 * rule that every feature works from the keyboard). The card body is the part
 * the runbook ships, filled as its skill says with this project's own map
 * files and a comparison read from its history, in the window's own card
 * frame. A key inside a card's frame goes through Playwright's keyboard: the
 * window's own input path reaches the main process, not a hidden window's frames.
 */

const PART = readFileSync(
  new URL(
    "../../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
    import.meta.url,
  ),
  "utf8",
);
const TITLE = "How the project fits together";

/** A comparison as the map part reads it: its label, the map files it was drawn against and renamed states. */
type Comparison = {
  label: string;
  was: Record<string, { machines?: { name: string; states: string[] }[] } | null>;
  names?: Record<string, Record<string, string>>;
};

/** The comparison that rebuilt a machine, and the way down to that machine from the top. */
const rebuild = MAP_DATA.compare[0] as Comparison | undefined;
const [machineName = ""] = Object.keys(rebuild?.names ?? {});
const core = MAP_DATA.maps["src/core"];
const machine = core.machines.find((each) => each.name === machineName);
const holder = core.parts.find((each) => each.name === machine?.in);
const top = MAP_DATA.maps[""];
const coreOnTop = top.parts.find((each) => each.path === "src/core");
const was = rebuild?.was["src/core"]?.machines?.find((each) => each.name === machineName);
if (!rebuild || !machine || !holder?.group || !coreOnTop?.group || !was)
  throw new Error("the map fixture no longer holds the rebuilt machine this journey walks to");
const renamed = new Set(Object.keys(rebuild.names?.[machineName] ?? {}));
const added = machine.states.filter((state) => !was.states.includes(state) && !renamed.has(state));
const kept = machine.states.filter((state) => was.states.includes(state));

function mapCard(): Card {
  return {
    id: "card-fm-architecture-map",
    author: "firstmate",
    meta: "firstmate",
    priority: 20,
    title: TITLE,
    body: fillMapPart(
      PART,
      JSON.stringify({ maps: MAP_DATA.maps, counts: MAP_DATA.counts, compare: MAP_DATA.compare }),
    ),
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

function seed(userDataDir: string): void {
  const db = openDatabase(userDataDir);
  try {
    seedTask(new TaskService({ db, strict: true }), {
      id: "architecture-map",
      title: "Show the project's map",
      status: "queued",
      startPolicy: "on-request",
    });
    new CardStore(db).upsert(mapCard());
  } finally {
    db.close();
  }
}

/** Where the map stands: the place its trail marks current, and what it says about the chosen box. */
const here = (body: FrameLocator): Locator => body.locator("[data-crumbs] [aria-current]");
const said = (body: FrameLocator): Promise<string> =>
  body
    .locator("[data-live]")
    .textContent()
    .then((text) => text ?? "");

/**
 * Chooses the box named `label` with the arrows alone, as a reader looking
 * around would: a few presses each way in turn until the map names it.
 */
async function choose(map: Locator, body: FrameLocator, label: string): Promise<void> {
  const ways = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
  for (let press = 0; press < 24; press++) {
    if ((await said(body)).startsWith(`${label}:`)) return;
    await pressKey(map, ways[Math.floor(press / 3) % ways.length] as string);
  }
  throw new Error(`the arrows never chose ${label}; the map says: ${await said(body)}`);
}

/** Chooses each box of `labels` in turn and goes into it with Enter. */
async function goIn(map: Locator, body: FrameLocator, labels: string[]): Promise<void> {
  for (const label of labels) {
    await choose(map, body, label);
    await pressKey(map, "Enter");
    await expect(here(body)).toHaveText(label);
  }
}

test("the map on a card goes in by keys, opens a state machine and turns on a comparison", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-architecture-map-");
  seed(userDataDir);
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 900 });
    await showCard(page, TITLE);
    const body = cardBody(page, TITLE);
    const map = body.getByRole("application");

    await test.step("Tab from the card's body lands on the map, which opens at the project's top", async () => {
      await expect(here(body)).toHaveText(top.name);
      await runFromSearch(app, page, "focus.card-body");
      await page.keyboard.press("Tab");
      await expect(map).toBeFocused();
    });

    await test.step("the arrows and Enter go down to the part that holds the machine, and on into the machine", async () => {
      await goIn(map, body, [coreOnTop.group as string, coreOnTop.name, holder.group as string]);
      await goIn(map, body, [holder.name, machine.name]);
      for (const state of machine.states)
        await expect(body.locator(`[data-box="${state}"]`)).toHaveCount(1);
    });

    await test.step("Escape lets go of the choice, then climbs back to the part", async () => {
      await choose(map, body, machine.states[0] as string);
      await pressKey(map, "Escape");
      await expect(here(body)).toHaveText(machine.name);
      await pressKey(map, "Escape");
      await expect(here(body)).toHaveText(holder.name);
    });

    await test.step("Enter on a comparison turns it on, and the machine tags its new states added", async () => {
      const button = body.locator("[data-cmps]").getByRole("button", { name: rebuild.label });
      await pressKey(button, "Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await choose(map, body, machine.name);
      await pressKey(map, "Enter");
      await expect(here(body)).toHaveText(machine.name);
      expect(added.length).toBeGreaterThan(0);
      for (const state of added)
        await expect(body.locator(`[data-box="${state}"]`)).toContainText("added");
      for (const state of kept)
        await expect(body.locator(`[data-box="${state}"]`)).not.toContainText(
          /added|removed|changed/,
        );
    });
  } finally {
    await launched.close();
  }
});
