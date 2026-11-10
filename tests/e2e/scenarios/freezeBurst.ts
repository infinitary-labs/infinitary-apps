import { captainTurn, renderWake } from "../../../src/core/orchestrator/wakes";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { type MockProviderServer, mockSpawnGoal, SPAWN_PROMPT_MARKER } from "../mockProvider";
import { served } from "../providerRequest";

/** The reported nine-start case, against the freeze journey's real long record. */
export const FREEZE_BURST_WORDS = "Start the session audits together.";
export const FREEZE_BURST_TITLES = Array.from(
  { length: 9 },
  (_, index) => `Measure open messages for session audit ${index + 1}`,
);

/** One first-mate turn issues every start; the host owns placement ordering. */
export function scriptFreezeBurst(provider: Pick<MockProviderServer, "scriptFirstmateTurn">) {
  return provider.scriptFirstmateTurn(
    served({
      kind: "user",
      origin: "captain",
      body: renderWake(captainTurn(FREEZE_BURST_WORDS, false)),
    }),
    FREEZE_BURST_TITLES.map(
      (title): ScriptedCall => ({
        name: "spawn_crewmate",
        args: {
          title,
          goal: mockSpawnGoal(title),
          user_words: `${SPAWN_PROMPT_MARKER} ${title}`,
          shape: { rigor_ask: "quick" },
        },
      }),
    ),
  );
}
