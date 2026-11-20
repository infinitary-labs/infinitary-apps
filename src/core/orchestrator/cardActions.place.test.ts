/**
 * Where the captain is, as a crewmate hears it (docs/devices.md, "Where the
 * captain is"; the session audit's finding 5): a check that needed the
 * captain at the Mac mini ran while they clicked from their MacBook, because
 * nothing told the crewmate which window the click came from. Each case
 * clicks or replies through the card actions' public door, inside the
 * captain input the dispatcher runs for a window, and reads what the
 * crewmate heard and what emit_card answered it.
 */

import { HOME } from "@shared/deviceNames";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { asAView } from "../askedFromAView";
import { CaptainPlaces } from "../devices/captainPlaces";

fakeCrewTimersEachTest();

/** The captain's paired devices: a Mac mini that runs work and a phone. */
const MINI = { id: "device-mini", name: "Sam's Mac mini", system: "macos" as const };
/** The first mate's own computer, by the name macOS gives it. */
const HOME_NAME = "Sam's MacBook Pro";
const PHONE = { id: "device-phone", name: "Sam's iPhone", system: "ios" as const };

/** A started task whose crewmate asks the captain to be at the Mac mini. */
async function askedAtTheMini(devices: (typeof MINI | typeof PHONE)[]) {
  // The crew's own clock, which emit_card's answer reads too.
  const places = new CaptainPlaces({
    devices: () => devices,
    homeName: HOME_NAME,
    now: () => Date.now(),
  });
  const crewmate: FakeCrewmate = fakeCrewmate();
  const h = setup(crewmate, { captainPlaces: places });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Confirm one system dialog",
    intent: intentOf("confirm the system dialog on the Mac mini"),
  });
  await tick();
  const card = {
    title: "Ready to confirm one dialog at the Mac mini?",
    body: "<p>The dialog opens on the Mac mini's screen.</p>",
    actions: [
      { id: "ready", label: "I'm at the Mac mini", default: true },
      { id: "later", label: "Not now" },
    ],
  };
  const emit = () => h.specs[0]?.onCard?.(card);
  const firstAnswer = await emit();
  await endTurn(crewmate, taskId, "Asked the captain to be at the Mac mini.");
  const shown = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
  if (!shown) throw new Error(`the crewmate's card did not go up: ${JSON.stringify(firstAnswer)}`);
  return {
    ...h,
    crewmate,
    places,
    cardId: shown.id,
    firstAnswer,
    emit,
    later: (ms: number) => vi.setSystemTime(Date.now() + ms),
  };
}

/** The captain's input as the dispatcher runs it for a window: a paired view's, or this computer's. */
function fromWindow<T>(h: { places: CaptainPlaces }, view: string | undefined, work: () => T): T {
  const input = () => h.places.during(work);
  return view ? asAView(input, { view }) : input();
}

describe("where the captain is, as a crewmate hears it", () => {
  it("names the window a choice came from, so a click from another computer is not taken for being at the Mac mini", async () => {
    const h = await askedAtTheMini([MINI, PHONE]);
    const prompts = h.crewmate.promptCalls.length;

    fromWindow(h, undefined, () => h.supervisor.cardActions.act(h.cardId, "ready"));
    await tick();

    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    const heard = h.crewmate.promptCalls.at(-1) ?? "";
    expect(heard).toContain(`chose "I'm at the Mac mini" (ready).`);
    expect(heard).toContain(`The captain chose it in their window on ${HOME_NAME}, ${HOME.the}.`);
  });

  it("names the phone a reply came from, and emit_card's next answer names it as the latest", async () => {
    const h = await askedAtTheMini([MINI, PHONE]);
    const prompts = h.crewmate.promptCalls.length;

    fromWindow(h, PHONE.id, () =>
      h.supervisor.cardActions.replyToCard(h.cardId, "give me ten minutes"),
    );
    await tick();

    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    const heard = h.crewmate.promptCalls.at(-1) ?? "";
    expect(heard).toContain(`The captain wrote it in their window on ${PHONE.name}, a phone.`);
    expect(heard).toContain("give me ten minutes");

    h.later(3 * 60_000);
    const answer = await h.emit();
    expect(answer).toContain(
      `The captain's latest click or words came from their window on ${PHONE.name}, a phone, 3 minutes ago.`,
    );
  });

  it("names the Mac mini when its own window clicks", async () => {
    const h = await askedAtTheMini([MINI]);

    fromWindow(h, MINI.id, () => h.supervisor.cardActions.act(h.cardId, "ready"));
    await tick();

    expect(h.crewmate.promptCalls.at(-1) ?? "").toContain(
      `The captain chose it in their window on ${MINI.name}.`,
    );
  });

  it("names no computer when the captain has only one", async () => {
    const h = await askedAtTheMini([]);
    expect(h.firstAnswer).not.toContain("their window on");

    fromWindow(h, undefined, () => h.supervisor.cardActions.act(h.cardId, "ready"));
    await tick();

    expect(h.crewmate.promptCalls.at(-1) ?? "").not.toContain("their window on");
    expect(await h.emit()).not.toContain("their window on");
  });
});
