import { GIF_LOOP_WORDS } from "../../../src/core/gifFormat";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { demoCardCall, pictureFile, writeChangePicturesCalls, writeFilesCalls } from "../crewCards";
import { DEMO_POSTER, GIF_DEMO_RECORDING, LOOPING_GIF_DEMO } from "../demoFixtures";
import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/**
 * Marker prompt (GIF demos, `tests/e2e/card-demo-gif.spec.ts`): the mock
 * crewmate could make no MP4, so it attaches the single-play GIF fallback.
 * It offers its completion decision with a GIF told to loop first - which
 * the host refuses - then, reading the refusal, with the one that plays once.
 */
export const GIF_DEMO_PROMPT_MARKER = "show the gif fallback";

export const GIF_DEMO_CARD_TITLE = "Dragging the box moves it, shown once";

export const GIF_DEMO_REFUSAL = GIF_LOOP_WORDS;

function writeGifDemoCalls(): ScriptedCall[] {
  return writeFilesCalls([
    { path: GIF_DEMO_RECORDING.path, bytes: GIF_DEMO_RECORDING.bytes },
    { path: LOOPING_GIF_DEMO.path, bytes: LOOPING_GIF_DEMO.bytes },
    pictureFile(DEMO_POSTER),
  ]);
}

/**
 * The GIF demo crewmate: write the files, offer the card with a GIF that
 * loops, then with the single-play one once the host refused it.
 */
export const gifDemoCard: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    // The GIF demo crewmate: write the files, offer the card with a GIF
    // that loops, then with the single-play one once the host refused it.
    if (!isFirstmate && latestUserTail.includes(GIF_DEMO_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return { calls: [...writeChangePicturesCalls(), ...writeGifDemoCalls()] };
      }
      if (!calledTool(latestUserTail, "emit_card")) {
        return { calls: [demoCardCall(LOOPING_GIF_DEMO.path, GIF_DEMO_CARD_TITLE)] };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => latestUserTail.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      if (emits === 1 && latestUserTail.includes(GIF_DEMO_REFUSAL)) {
        return { calls: [demoCardCall(GIF_DEMO_RECORDING.path, GIF_DEMO_CARD_TITLE)] };
      }
    }
    return undefined;
  };
