import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import { describeSessionContract } from "../../../tests/helpers/sessionContract";

/**
 * Claude's scripted harness for the session contract
 * (`tests/helpers/sessionContract.ts`): Claude's factory on a scripted
 * client that speaks the message shapes the real one does
 * (`scriptedClaudeWorld`). The real client's side of the same suite is
 * `claudeSession.contract.integration.test.ts`.
 */

describeSessionContract({
  name: "Claude, scripted",
  backend: "claude",
  world: scriptedClaudeWorld,
  cleanup: scriptedClaudeCleanup,
});
