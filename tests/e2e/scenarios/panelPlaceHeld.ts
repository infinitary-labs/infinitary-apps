import { panelCrewmateAnswer } from "../crewScripts";
import type { Scenario } from "../mockProvider";

/**
 * The panel crewmate's place, held until the journey lets it go
 * (`releaseThreadAnswer`). Until the place, the build's draft stays drawn out
 * of sight and the rail keeps what it had (docs/personal-panels.md, "Built
 * apart"), so a journey reads the draft before the place as an order. Sent at
 * once, the place could drop the draft between two of the journey's looks at
 * it on a loaded computer, and the journey never saw the draft it promises.
 */
export const panelPlaceHeld: Scenario = () => (request) => {
  const answer = panelCrewmateAnswer(request);
  if (!answer || !("calls" in answer)) return undefined;
  if (!answer.calls.some((call) => call.name === "place_panel")) return undefined;
  return { threadHeld: answer.calls };
};
