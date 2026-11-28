/**
 * The label-fit facts on a real first mate send (docs/card-authoring.md,
 * "Type"): the first mate's own emit_card tool over the real card store, so
 * the receipt is read beside the card the host stored, with INA-34's
 * made-up houseplant steps.
 */
import { describe, expect, it } from "vitest";
import {
  drained,
  fakeClockEachTest,
  firstmateCard,
  setup,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";

fakeClockEachTest();

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

describe("the first mate's emit_card receipt", () => {
  it("names the spilling label beside the card it stored, and stays quiet for the others", async () => {
    const { agent, specs, supervisor } = setup();
    await agent.converse("show the steps");
    const emit = toolsOf(specs).get("emit_card");
    if (!emit) throw new Error("the first mate has no emit_card");
    const send = async (id: string, body: string) =>
      (await emit.execute("c", { id, title: "Repotting steps", body })).content[0]?.text ?? "";

    const spilling = await send("steps", SPILLING);
    expect(spilling).toContain(`Card shown: Repotting steps (card-fm-steps)${FACTS}`);
    expect(spilling).toContain('"2 Loosen the roots (if root-bound)"');
    expect(await send("fits", FITTING)).toBe("Card shown: Repotting steps (card-fm-fits)");
    expect(await send("plain", NO_FIGURE)).toBe("Card shown: Repotting steps (card-fm-plain)");
    supervisor.cards.flushBroadcast();
    expect(supervisor.cards.shown("card-fm-steps")?.body).toBe(SPILLING);
    expect(supervisor.cards.shown("card-fm-fits")?.body).toBe(FITTING);
    expect(supervisor.cards.shown("card-fm-plain")?.body).toBe(NO_FIGURE);
  });

  it("adds the facts, and saves the line, when an accepted revision answers the captain's message", async () => {
    const seeded = {
      ...firstmateCard("card-fm-steps", "t1", "Repotting steps", []),
      body: FITTING,
    };
    const { specs, supervisor, session } = setup({
      seedTasks: [{ id: "t1", title: "Repot the plant", status: "idle" }],
      seedCards: [seeded],
    });
    supervisor.cardActions.replyToCard("card-fm-steps", "Can the second step name the roots?");
    await drained(session, 1);
    const emit = toolsOf(specs).get("emit_card");
    if (!emit) throw new Error("the first mate has no emit_card");
    const asked = supervisor.cards.thread("card-fm-steps").messages[0]?.id;
    expect(asked).toBeDefined();

    const text =
      (
        await emit.execute("c2", {
          id: "card-fm-steps",
          title: "Repotting steps",
          body: SPILLING,
          reply: "I named the roots in step 2.",
          answers_message: asked,
        })
      ).content[0]?.text ?? "";

    expect(text).toMatch(/^Card shown: Repotting steps \(card-fm-steps\)\. .+\n\nLabel fit: /);
    expect(supervisor.cards.stored("card-fm-steps")?.body).toBe(SPILLING);
    expect(
      supervisor.cards.thread("card-fm-steps").messages.map((message) => message.text),
    ).toContain("I named the roots in step 2.");
  });
});
