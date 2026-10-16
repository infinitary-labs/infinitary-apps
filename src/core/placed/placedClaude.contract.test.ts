import {
  placedContractCleanup,
  placedContractWorld,
} from "../../../tests/helpers/placedContractWorld";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import { describeSessionContract } from "../../../tests/helpers/sessionContract";

/**
 * The session contract for a crewmate's conversation held on a computer that
 * runs work (`placedContractWorld`): Claude's factory on the scripted client,
 * held by the computer's `SessionHost` and driven from the home's
 * `PlacedSessions` over the real connection. A placed conversation is only
 * ever a crewmate's, so the crewmate's cases are the ones it passes.
 */

describeSessionContract({
  name: "Claude, scripted, held on a computer that runs work",
  backend: "claude",
  roles: ["crewmate"],
  world: async () => placedContractWorld(await scriptedClaudeWorld()),
  cleanup: async () => {
    await placedContractCleanup();
    await scriptedClaudeCleanup();
  },
});
