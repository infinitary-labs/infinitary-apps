/**
 * The label-fit facts on a real send (docs/card-authoring.md, "Type"): the
 * first mate's emit_card tool and a crewmate's onCard, each over the real
 * card store, so the receipt is read beside the card the host stored. The
 * drawing is INA-34's made-up houseplant steps: 160-unit boxes in a
 * 750-unit drawing, labels 12 units in.
 */
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import type { CrewmateToolDelegate } from "../session/tools";

fakeCrewTimersEachTest();

function steps(titles: string[]): string {
  const boxes = titles
    .map((title, i) => {
      const x = 10 + (i % 4) * 190;
      return `<rect x="${x}" y="10" width="160" height="70" rx="8" fill="none"/><text x="${x + 12}" y="36" font-size="13">${title}</text>`;
    })
    .join("");
  return `<p>Repot the plant.</p><figure aria-label="Steps"><svg viewBox="0 0 750 100" width="100%">${boxes}</svg></figure>`;
}

const SPILLING = steps(["1  Water the plant", "2  Loosen the roots (if root-bound)"]);
const FITTING = steps(["1  Water", "2  Loosen roots"]);
const NO_FIGURE = "<p>Water the plant the day before.</p>";
const FACTS = "\n\nLabel fit: SVG text does not wrap.";

describe("a crewmate's emit_card receipt", () => {
  it("names the spilling label beside the card it stored, and stays quiet for the others", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, cards, specs } = setup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "steps",
      intent: intentOf("show the steps"),
    });
    await tick();
    const onCard = specs[0]?.onCard;
    if (!onCard) throw new Error("the crewmate has no onCard");
    // The crewmate's own emit_card, bound as the session binds it.
    const tool = EMIT_CARD_TOOL.bind({ ...specs[0], onCard } as unknown as CrewmateToolDelegate);
    if (!tool) throw new Error("the crewmate has no emit_card");
    const send = async (id: string, body: string) =>
      (await tool.run({ id, title: "Repotting steps", body } as never)).text;

    const spilling = await send("steps", SPILLING);
    expect(spilling).toContain(`Card shown: Repotting steps (card-${taskId}-steps)${FACTS}`);
    expect(spilling).toContain('"2 Loosen the roots (if root-bound)"');
    expect(await send("fits", FITTING)).toBe(`Card shown: Repotting steps (card-${taskId}-fits)`);
    expect(await send("plain", NO_FIGURE)).toBe(
      `Card shown: Repotting steps (card-${taskId}-plain)`,
    );
    supervisor.cards.flushBroadcast();
    const stored = (title: string) => cards().filter((card) => card.title === title);
    expect(
      stored("Repotting steps")
        .map((card) => card.body)
        .sort(),
    ).toEqual([FITTING, NO_FIGURE, SPILLING].sort());
  });
});
