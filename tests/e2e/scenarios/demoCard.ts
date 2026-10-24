import { DEMO_UNPLAYED_WORDS } from "../../../src/core/pi/cardImages";
import { mp4 } from "../../helpers/mp4Fixture";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { DEMO_POSTER, DEMO_RECORDING } from "../demoFixtures";
import {
  calledTool,
  demoCardCall,
  pictureFile,
  type Scenario,
  writeChangePicturesCalls,
  writeFilesCalls,
} from "../mockProvider";

/**
 * Marker prompt (demo recordings, `tests/e2e/card-demo.spec.ts`): the mock
 * crewmate writes a demo recording and its poster into its working copy,
 * beside a recording whose boxes are sound and whose pictures are filler.
 * It offers its completion decision with that recording first - which the
 * host's decoder refuses - then, reading the refusal, with the real one: a
 * still picture under Before, the demo under After.
 */
export const DEMO_PROMPT_MARKER = "show the demo";

export const DEMO_REFUSAL = DEMO_UNPLAYED_WORDS;

const BROKEN_DEMO = "shots/filler-demo.mp4";

function writeDemoCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: DEMO_RECORDING.path, bytes: DEMO_RECORDING.bytes },
    pictureFile(DEMO_POSTER),
    {
      path: BROKEN_DEMO,
      bytes: mp4({ width: DEMO_RECORDING.width, height: DEMO_RECORDING.height, seconds: 3 }),
    },
  ]);
}

/**
 * The demo crewmate: write the files, offer the card with the filler
 * recording, then with the real one once the decoder refused it.
 */
export const demoCard: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    // The demo crewmate: write the files, offer the card with the filler
    // recording, then with the real one once the decoder refused it.
    if (!isFirstmate && latestUserTail.includes(DEMO_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return { calls: [...writeChangePicturesCalls(), ...writeDemoCalls()] };
      }
      if (!calledTool(latestUserTail, "emit_card")) {
        return { calls: [demoCardCall(BROKEN_DEMO)] };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => latestUserTail.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      if (emits === 1 && latestUserTail.includes(DEMO_REFUSAL)) {
        return { calls: [demoCardCall(DEMO_RECORDING.path)] };
      }
    }
    return undefined;
  };
