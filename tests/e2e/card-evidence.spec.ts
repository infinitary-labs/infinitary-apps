import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type FrameLocator, test } from "@playwright/test";
import type { Episode, HumanSupervisionManifest } from "../../scripts/human-supervision";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { CardObservation, CardQuestion } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import {
  STALE_OFFER_CHOICE_LABEL,
  STALE_OFFER_PROMPT_MARKER,
  STALE_OFFER_REVISED_TITLE,
  STALE_OFFER_TITLE,
  staleOffer,
} from "./scenarios/staleOffer";
import {
  cardAnswersLine,
  cardLeave,
  closeQuestion,
  expectNoCard,
  showCard,
  shownCard,
} from "./stack";

/**
 * Card evidence (docs/card-evidence.md). What the captain chose is recorded
 * against the offer the stage showed him, with the questions that offer
 * asked, and nothing he only drafted is kept.
 *
 * Through the real path: a real crewmate session on the mock provider, the
 * real bridge in the card's frame, the real chrome and core, and the real
 * export command run on the userData the app left behind. Picks are made
 * inside the frame by dispatching there, since Chromium drops native clicks
 * into a hidden window's sandboxed frames.
 */

/** Runs `pnpm export:corpus --human-supervision` on a closed app's userData. */
function exportPack(userDataDir: string) {
  const out = scratchDir("infinitary-card-evidence-pack-");
  const run = spawnSync(
    process.execPath,
    ["scripts/export-corpus.ts", "--user-data", userDataDir, "--out", out, "--human-supervision"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "" },
    },
  );
  const lines = (file: string) =>
    readFileSync(join(out, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    status: run.status,
    printed: `${run.stdout}${run.stderr}`,
    episodes: () => lines("human-supervision.jsonl") as Episode[],
    manifest: () =>
      (
        JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
          human_supervision: HumanSupervisionManifest;
        }
      ).human_supervision,
  };
}

/** The evidence one card left, read back through its one store. */
function observationsOf(userDataDir: string, cardId: string): CardObservation[] {
  const db = openDatabase(userDataDir);
  try {
    return new CardStore(db).observations(cardId);
  } finally {
    db.close();
  }
}

test("a choice names the offer the stage showed, not the head its crewmate wrote after it", async () => {
  const launched = await launchApp({ withMockProvider: true, scenarios: [staleOffer] });
  const { page, mockProvider, userDataDir } = launched;
  let cardId = "";
  let taskId = "";
  try {
    const prompt = page.getByRole("textbox", { name: "Task prompt" });
    await prompt.fill(`${SPAWN_PROMPT_MARKER} ${STALE_OFFER_PROMPT_MARKER}`);
    await prompt.press("Enter");
    await expect(shownCard(page, STALE_OFFER_TITLE)).toBeVisible({ timeout: 30_000 });
    // The crewmate revised the card after its report and is still working,
    // so the stage keeps the offer it showed.
    await expect.poll(() => mockProvider?.heldRequests(), { timeout: 30_000 }).toBe(1);
    await expect(shownCard(page, STALE_OFFER_TITLE)).toBeVisible();
    await expectNoCard(page, STALE_OFFER_REVISED_TITLE);
    const shown = await page.evaluate(
      async (title) => (await window.infinitary.cards.list()).find((card) => card.title === title),
      STALE_OFFER_TITLE,
    );
    cardId = shown?.id ?? "";
    taskId = shown?.taskId ?? "";
    expect(shown?.offerId).toBeTruthy();

    await page.getByRole("button", { name: STALE_OFFER_CHOICE_LABEL, exact: true }).click();
    await expectNoCard(page, STALE_OFFER_TITLE);
  } finally {
    await launched.close();
  }

  // The row the choice resolved holds the newer head; the evidence keeps both.
  const db = openDatabase(userDataDir);
  try {
    expect(new CardStore(db).get(cardId)?.title).toBe(STALE_OFFER_REVISED_TITLE);
  } finally {
    db.close();
  }

  const pack = exportPack(userDataDir);
  expect(pack.status, pack.printed).toBe(0);
  // The command prints counts, never a card's words.
  expect(pack.printed).toContain("human supervision: ");
  expect(pack.printed).not.toContain("Ten runs in a row");
  const episode = pack.episodes().find((entry) => entry.card_id === cardId);
  expect(episode?.basis).toBe("captured");
  expect(episode?.task_id).toBe(taskId);
  const [first, revised] = episode?.offers ?? [];
  expect(episode?.offers.map((offer) => offer.title)).toEqual([
    STALE_OFFER_TITLE,
    STALE_OFFER_REVISED_TITLE,
  ]);
  // The revision waited on its author's close-out, which never came.
  expect(episode?.stage).toContainEqual(
    expect.objectContaining({
      offer_id: revised?.offer_id,
      state: "waiting",
      waitingOn: "close-out",
      cause: "revise",
    }),
  );
  expect(episode?.interactions).toHaveLength(1);
  const choice = episode?.interactions[0];
  expect(choice).toMatchObject({
    offer_id: first?.offer_id,
    actor: "captain",
    source: "chrome",
    actionId: "retry-flush",
    recognized: true,
    label: STALE_OFFER_CHOICE_LABEL,
    closes: true,
    display: { fidelity: "matched", reportedOfferId: first?.offer_id },
    interactionSource: "shell",
    outcome: "unknown",
    context: { taskId, kind: expect.any(String), status: expect.any(String) },
  });
  expect(choice?.eligibility).toMatchObject({ human_source: true, display_matched: true });
  expect(episode?.end).toMatchObject({ kind: "action", interaction_id: choice?.interaction_id });
  expect(episode?.rights).toEqual({ scope: "owner-local", external_use: "not-authorized" });
  expect(pack.manifest().counts.by_display).toMatchObject({ matched: 1 });
});

/** Clicks a control inside the card's frame, where the captain would. */
async function pick(frame: FrameLocator, selector: string) {
  await frame.locator(selector).evaluate((control: HTMLInputElement) => control.click());
}

/** Sets a field inside the card's frame, as the captain's input would. */
async function enter(frame: FrameLocator, selector: string, value: string) {
  await frame.locator(selector).evaluate((field: HTMLInputElement, text) => {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

const ROLLOUT = "Settle the rollout";
const NAME_RELEASE = "Name the release";
const PICK_WASH = "Pick a wash";
const CLOSED_DRAFT = "Moonlit harbour";
const RESTART_DRAFT = "A note that never went";

/** Every way a body asks, and the definition the footer click should record for it. */
const ROLLOUT_BODY = [
  "<p>Each proposal is picked; change what you like.</p>",
  "<fieldset><legend>Which projects can a task read?</legend>",
  '<label><input type="radio" name="read-scope" value="registered" checked> Its registered project</label>',
  '<label><input type="radio" name="read-scope" value="all-visible"> Every project your sign-in can see</label>',
  "</fieldset>",
  '<div role="group" aria-label="Which checks must pass?">',
  '<label><input type="checkbox" name="checks" value="unit" checked> Unit tests</label>',
  '<label><input type="checkbox" name="checks" value="e2e"> End-to-end tests</label>',
  "</div>",
  '<p id="speed-question">How fast should it roll?</p>',
  '<div role="radiogroup" aria-labelledby="speed-question">',
  '<label><input type="radio" name="speed" value="slow" checked> One project a day</label>',
  '<label><input type="radio" name="speed" value="fast"> All at once</label>',
  "</div>",
  '<p><label>Where it runs <select name="region"><option value="us">United States</option><option value="eu">Europe</option></select></label></p>',
  '<p><label>Which days <select name="days" multiple><option value="mon" selected>Monday</option><option value="fri">Friday</option></select></label></p>',
  '<p><label>Anything else <textarea name="notes"></textarea></label></p>',
  "<p>How loud should it be?</p>",
  '<label><input type="radio" name="tone" value="quiet"> Quiet</label>',
  '<label><input type="radio" name="tone" value="loud"> Loud</label>',
  '<input type="hidden" name="source" value="rollout-v1">',
  '<label>Tilt <input id="tilt" type="range" min="0" max="90" value="16"></label>',
  "<script>document.getElementById('tilt').oninput = (event) => inf.stage('look', { tiltDeg: Number(event.target.value) });</script>",
].join("");

function option(value: string, label: string, authoredDefault = false) {
  return { value, label, authoredDefault, disabled: false, hidden: false };
}

const ROLLOUT_QUESTIONS: CardQuestion[] = [
  {
    name: "read-scope",
    kind: "single",
    control: "radio",
    prompt: "Which projects can a task read?",
    promptBasis: "legend",
    options: [
      option("registered", "Its registered project", true),
      option("all-visible", "Every project your sign-in can see"),
    ],
    defaultBasis: "authored",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "checks",
    kind: "multiple",
    control: "checkbox",
    prompt: "Which checks must pass?",
    promptBasis: "aria-label",
    options: [option("unit", "Unit tests", true), option("e2e", "End-to-end tests")],
    defaultBasis: "authored",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "speed",
    kind: "single",
    control: "radio",
    prompt: "How fast should it roll?",
    promptBasis: "labelledby",
    options: [option("slow", "One project a day", true), option("fast", "All at once")],
    defaultBasis: "authored",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "region",
    kind: "single",
    control: "select",
    prompt: "Where it runs",
    promptBasis: "label",
    options: [option("us", "United States"), option("eu", "Europe")],
    defaultBasis: "implicit-first",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "days",
    kind: "multiple",
    control: "select-multiple",
    prompt: "Which days",
    promptBasis: "label",
    options: [option("mon", "Monday", true), option("fri", "Friday")],
    defaultBasis: "authored",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "notes",
    kind: "text",
    control: "textarea",
    prompt: "Anything else",
    promptBasis: "label",
    options: [],
    defaultBasis: "none",
    required: false,
    gaps: [],
    complete: true,
  },
  {
    name: "tone",
    kind: "single",
    control: "radio",
    prompt: null,
    promptBasis: null,
    options: [option("quiet", "Quiet"), option("loud", "Loud")],
    defaultBasis: "none",
    required: false,
    gaps: ["no-prompt"],
    complete: false,
  },
  {
    name: "source",
    kind: "opaque",
    control: "hidden",
    prompt: null,
    promptBasis: null,
    options: [],
    defaultBasis: "authored",
    required: false,
    gaps: ["opaque"],
    complete: false,
  },
  {
    name: "look",
    kind: "opaque",
    control: "staged",
    prompt: null,
    promptBasis: null,
    options: [],
    defaultBasis: "none",
    required: false,
    gaps: ["opaque"],
    complete: false,
  },
];

test("a footer click records what each question asked; a draft the captain never sent is kept nowhere", async () => {
  const userDataDir = scratchDir("infinitary-card-evidence-");
  const db = openDatabase(userDataDir);
  const store = new CardStore(db);
  const decision = (id: string, title: string, body: string, action: string) =>
    store.upsert({
      id,
      title,
      author: "firstmate",
      priority: 50,
      meta: "firstmate",
      body,
      status: "ready",
      createdAt: Date.now(),
      actions: [
        { id: "not-yet", label: "Not yet", variant: "secondary" },
        { id: "go", label: action, variant: "primary", default: true },
      ],
    });
  decision("card-fm-rollout", ROLLOUT, ROLLOUT_BODY, "Roll it out");
  decision(
    "card-fm-release-name",
    NAME_RELEASE,
    '<p>Say what to call it.</p><p><label>Release name <input type="text" name="release-name"></label></p>',
    "Use this name",
  );
  decision(
    "card-fm-wash",
    PICK_WASH,
    '<p>Clear is proposed.</p><p><label>Why <textarea name="why"></textarea></label></p>',
    "Use clear",
  );
  db.close();

  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [staleOffer],
  });
  const { page } = launched;
  try {
    await showCard(page, ROLLOUT);
    const rollout = cardBody(page, ROLLOUT);
    await pick(rollout, 'input[name="read-scope"][value="all-visible"]');
    await pick(rollout, 'input[name="checks"][value="e2e"]');
    await rollout.locator('select[name="region"]').evaluate((select: HTMLSelectElement) => {
      select.value = "eu";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await enter(rollout, 'textarea[name="notes"]', "Keep it short");
    await enter(rollout, "#tilt", "42");
    await expect(page.locator("[data-card-answers]")).toContainText("5 changed");
    await page.getByRole("button", { name: "Roll it out", exact: true }).click();
    await expectNoCard(page, ROLLOUT);

    // A changed field closed without sending.
    await showCard(page, NAME_RELEASE);
    await enter(cardBody(page, NAME_RELEASE), "input", CLOSED_DRAFT);
    await cardLeave(page).first().click();
    await expect(closeQuestion(page)).toHaveCount(0);
    await expect(shownCard(page, NAME_RELEASE)).toBeHidden();

    // A changed field the app quits on.
    await showCard(page, PICK_WASH);
    await enter(cardBody(page, PICK_WASH), "textarea", RESTART_DRAFT);
    await expect(cardAnswersLine(page)).toContainText("1 changed");
  } finally {
    await launched.close();
  }

  const [chosen, ...others] = observationsOf(userDataDir, "card-fm-rollout").filter(
    (observation) => observation.kind === "action",
  );
  expect(others).toHaveLength(0);
  if (chosen?.kind !== "action") throw new Error("the rollout choice left no evidence");
  expect(chosen.actor).toBe("captain");
  expect(chosen.payload).toMatchObject({
    actionId: "go",
    closes: true,
    reading: "fresh",
    display: { fidelity: "matched" },
  });
  expect(chosen.payload.questions).toEqual(ROLLOUT_QUESTIONS);
  expect(chosen.payload.answers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "read-scope", values: ["all-visible"], changed: true }),
      expect.objectContaining({ name: "checks", values: ["unit", "e2e"], changed: true }),
      expect.objectContaining({ name: "region", values: ["eu"], changed: true }),
      expect.objectContaining({ name: "notes", values: ["Keep it short"], changed: true }),
      expect.objectContaining({ name: "look", values: ['{"tiltDeg":42}'], changed: true }),
    ]),
  );

  // The dismissal is recorded as one, against the offer shown; its draft is not.
  const named = observationsOf(userDataDir, "card-fm-release-name");
  expect(named.filter((observation) => observation.kind === "exit")).toEqual([]);
  expect(JSON.stringify(named)).not.toContain(CLOSED_DRAFT);
  const washed = observationsOf(userDataDir, "card-fm-wash");
  // Shown, so seen - and nothing the captain picked and never sent.
  expect(washed.map((observation) => observation.kind).sort()).toEqual([
    "availability",
    "offer",
    "seen",
  ]);
  expect(JSON.stringify(washed)).not.toContain(RESTART_DRAFT);
});
