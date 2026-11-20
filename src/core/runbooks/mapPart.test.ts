import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardDataNames } from "@shared/cardPictures";
import { expect, it } from "vitest";
import { fillMapPart, MAP_DATA, mapPartNaming } from "../../../tests/helpers/architectureMap";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { MAX_CARD_BODY_LENGTH } from "../pi/cardBodyFile";
import { verifyCardImages } from "../pi/cardImages";
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

// The captain, on the map grown too large for a card: "the actual data should
// live in a file, and the renderer loads from the file". The skill has the
// crewmate name a JSON file in the data block, and the host keeps its copy.
it("the map part naming its data file is a card body a crewmate's card goes through, holding the part alone", async () => {
  const base = scratchDir("fm-map-card-");
  const worktree = join(base, "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "map-data.json"), JSON.stringify(MAP_DATA));
  const { body } = await verifyCardImages(mapPartNaming(part, "map-data.json"), {
    worktree,
    dir: join(base, "crewmates", "t1", "cards"),
    taskId: "t1",
  });
  expect(cardDataNames(body)).toHaveLength(1);
  expect(body.length).toBeLessThanOrEqual(MAX_CARD_BODY_LENGTH);
  expect(
    lintCrewmateCard({ title: "What changed in the core since the release", body, actions: [] }),
  ).toBeUndefined();
});
