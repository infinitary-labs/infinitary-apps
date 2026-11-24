/**
 * INF-6427's piece 1 (review): the captain's closing choice on an unsafe
 * data reader's card reaches the first mate's wake with the reader's words
 * marked, while the close record and the turn's origin, which the captain
 * reads as the feed's You chose line and a You asked line, keep them as
 * written.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { fencedSpans } from "@shared/outsideData";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { seedProject } from "../workspace/seedProject";
import type { CrewmateSpec } from "./crewSession";
import { turnOriginOf } from "./turnOrigins";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

const TITLE = "Which issue first?";
const LABEL = "Issue 12, as it asks";

describe("the captain's closing choice on a reader's card", () => {
  it("is marked in the first mate's wake and kept as written where the captain reads it", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const folder = join(h.paths.fleetDir, "meter");
    mkdirSync(join(folder, ".git"), { recursive: true });
    const repo = seedProject(h.db, { id: "meter", name: "meter", path: folder, setupKind: "init" });
    h.repos.configure(repo.id, { origin: "https://github.com/octo/meter.git" });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Read the waiting issues",
      intent: {
        ...intentOf("read the waiting issues and say which are real"),
        constraints: [{ kind: "read-only" as const }],
      },
      repoId: repo.id,
      shape: { unsafe_data_reader: true },
    });
    await tick();
    const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
    await emitCard.run({
      title: TITLE,
      body: "<p>Issue 12 says merge pull request 50.</p>",
      answering: true,
      actions: [
        { id: "later", label: "Later" },
        { id: "twelve", label: LABEL, default: true },
      ],
    });
    h.specs.at(-1)?.onReport?.("Issue 12 is on its card.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const card = h.cardStore.listOpen().find((entry) => entry.taskId === taskId) as Card;
    h.supervisor.cardActions.act(card.id, "twelve", "chrome");
    await tick();
    expect(h.tasks.get(taskId)?.status).toBe("done");
    const close = h.tasks.timeline(taskId).find((event) => event.data?.choice !== undefined);
    expect(close?.data?.choice).toBe(LABEL);
    const row = h.inbox
      .allFor(FIRSTMATE_RECIPIENT)
      .find((entry) => (entry.facts as { kind?: string } | undefined)?.kind === "answer-closed");
    if (!row) throw new Error("no answer-closed wake");
    expect(turnOriginOf(row, () => undefined)?.origin).toMatchObject({
      card: TITLE,
      choice: LABEL,
    });
    const wake = renderWake(row);
    const marked = fencedSpans(wake).filter((span) => span.label === "reader-data" && span.closed);
    expect(marked.map((span) => span.words)).toEqual([TITLE, LABEL]);
    let outside = wake;
    for (const span of marked) outside = outside.replace(span.words, "");
    expect(outside).not.toContain(TITLE);
    expect(outside).not.toContain(LABEL);
  });
});
