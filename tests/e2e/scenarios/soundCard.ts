import { readFileSync } from "node:fs";
import { SOUND_HOLDS_PICTURES } from "../../../src/core/soundFormat";
import { MOVING_BOX_SOUND_MP4, mp4 } from "../../helpers/mp4Fixture";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { pictureFile, writeFilesCalls } from "../crewCards";
import { DEMO_POSTER } from "../demoFixtures";
import type { Scenario } from "../mockProvider";
import { calledTool } from "../providerRequest";

/**
 * Marker prompt (sound clips, `tests/e2e/card-sound.spec.ts`): the mock
 * crewmate writes a narration clip a local voice tool would make, a
 * recording with pictures beside it, and a demo about a sound, which keeps
 * its sound track. It offers its note naming the recording as its sound
 * first - which the host refuses - then, reading the refusal, the clip,
 * with the demo under it.
 */
export const SOUND_PROMPT_MARKER = "play the narration";

export const SOUND_CARD_TITLE = "The narration for this week is ready";

export const SOUND_CAPTION = "Narration: what changed this week";

/** A real two-second clip at a voice tool's 24 kHz mono (`tests/fixtures/sound/`). */
export const SOUND_CLIP = {
  path: "shots/narration.m4a",
  bytes: readFileSync(new URL("../../fixtures/sound/tone.m4a", import.meta.url)),
};

/**
 * A demo about something that needs to be heard (INF-4543's ruling): the
 * real moving-box recording with a 3-second AAC tone beside its pictures.
 */
export const SOUND_DEMO = {
  path: "shots/alert-demo.mp4",
  bytes: readFileSync(MOVING_BOX_SOUND_MP4),
};

const PICTURES_AS_SOUND = "shots/narration-with-pictures.mp4";

function soundNote(clip: string): ScriptedCall {
  return {
    name: "emit_card",
    args: {
      title: SOUND_CARD_TITLE,
      body: `<p>I made this week's narration with the local voice.</p><figure data-inf-sound="${clip}"><figcaption>${SOUND_CAPTION}</figcaption></figure><figure data-inf-demo="${SOUND_DEMO.path}"><img src="${DEMO_POSTER.path}" alt="${DEMO_POSTER.alt}"><figcaption>The alert sounds as the box slides in.</figcaption></figure>`,
    },
  };
}

/** The sound crewmate: write the files, offer the recording, then the clip once it was refused. */
export const soundCard: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !latestUserTail.includes(SOUND_PROMPT_MARKER)) return;
    if (!hasToolResults) {
      return {
        calls: writeFilesCalls([
          SOUND_CLIP,
          SOUND_DEMO,
          pictureFile(DEMO_POSTER),
          { path: PICTURES_AS_SOUND, bytes: mp4({ width: 64, height: 64, seconds: 2 }) },
        ]),
      };
    }
    if (!calledTool(latestUserTail, "emit_card")) return { calls: [soundNote(PICTURES_AS_SOUND)] };
    const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
      .map((call) => latestUserTail.split(call).length - 1)
      .reduce((sum, count) => sum + count, 0);
    if (emits === 1 && latestUserTail.includes(SOUND_HOLDS_PICTURES)) {
      return { calls: [soundNote(SOUND_CLIP.path)] };
    }
    return undefined;
  };
