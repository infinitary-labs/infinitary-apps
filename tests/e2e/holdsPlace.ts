import { expect } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import type { LaunchedApp } from "./launch";
import { FM_THREAD_CARD_TITLE } from "./mockProvider";
import { served } from "./providerRequest";

/** A marked version of the existing thread fixture, through the real emitted-card interface. */
export async function emitContinuityCard(app: LaunchedApp, words: string): Promise<void> {
  await waitForFirstmateIdle(app.page);
  if (!app.mockProvider) throw new Error("Card continuity requires the mock provider");
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    [
      {
        name: "emit_card",
        args: {
          id: "fm-thread-card",
          title: FM_THREAD_CARD_TITLE,
          body: '<p>Lead with the caption, not the chips.</p><p>The chips are still there; they just are not the first thing you read.</p><label for="tone">Tone</label><input id="tone" name="tone" value="calm">',
          holds_place: true,
          actions: [
            { id: "chips-first", label: "Lead with the chips" },
            { id: "caption-first", label: "Lead with the caption", default: true },
          ],
          standalone: true,
        },
      },
    ],
  );
  await askFirstmate(app.page, words);
  await expect.poll(answer.outcome).toMatchObject({ state: "closed" });
}
