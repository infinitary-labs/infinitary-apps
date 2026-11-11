import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fillMapPart, MAP_DATA } from "../../../tests/helpers/architectureMap";
import { MAX_CARD_BODY_LENGTH } from "../pi/cardBodyFile";
import { lintCrewmateCard } from "../pi/cardLint";

const part = readFileSync(
  join(
    __dirname,
    "../../../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
  ),
  "utf8",
);

// The approved Advanced architecture plan: "what changed since ..." gives a
// card with the change view, and the runbook's skill has a crewmate copy the
// map part into that card's body and fill only its data block. A part the
// card checks refuse, or one too large to leave room for a project's maps,
// would leave the crewmate no card to show.
it("the map part filled with a project's maps and comparisons is a card body a crewmate's card goes through", () => {
  const body = fillMapPart(part, JSON.stringify(MAP_DATA));
  expect(body.length).toBeLessThanOrEqual(MAX_CARD_BODY_LENGTH);
  expect(
    lintCrewmateCard({ title: "What changed in the core since the release", body, actions: [] }),
  ).toBeUndefined();
});
