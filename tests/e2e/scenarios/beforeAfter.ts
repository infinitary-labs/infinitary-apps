import { untaggedNewMarkRefusal } from "../../../src/core/pi/cardLint";
import { completionCardBody } from "../../helpers/completionCard";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { calledTool, type Scenario, writeChangePicturesCalls } from "../mockProvider";
import {
  CHANGE_AFTER_PICTURES,
  CHANGE_BEFORE_PICTURES,
  type PictureFixture,
} from "../pictureFixtures";

/**
 * Marker prompt (contract v4.69, `tests/e2e/card-before-after.spec.ts`): the
 * mock crewmate writes two before pictures and three after pictures, one of
 * them of a new view, and offers a completion decision that shows them. Its
 * first card marks the new picture itself, where no New tag can be drawn; it
 * reads the card check's refusal and offers the card again with the mark on
 * the picture's figure.
 */
export const BEFORE_AFTER_PROMPT_MARKER = "show the before and after";

export const BEFORE_AFTER_CARD_TITLE = "The meter row and transcript read at a glance";

export const BEFORE_AFTER_MARK_REFUSAL = untaggedNewMarkRefusal("img");

function beforeAfterCardCall(newMark: "figure" | "picture"): ScriptedCall {
  const mark = (fresh: boolean, on: typeof newMark) =>
    fresh && newMark === on ? " data-inf-new" : "";
  const view = (picture: PictureFixture, caption: string, fresh = false) =>
    `<figure${mark(fresh, "figure")}><img${mark(fresh, "picture")} src="${picture.path}" alt="${picture.alt}"><figcaption>${caption}</figcaption></figure>`;
  const [meterBefore, transcriptBefore] = CHANGE_BEFORE_PICTURES as [
    PictureFixture,
    PictureFixture,
  ];
  const [meterAfter, transcriptAfter, history] = CHANGE_AFTER_PICTURES as [
    PictureFixture,
    PictureFixture,
    PictureFixture,
  ];
  return {
    name: "emit_card",
    args: {
      title: BEFORE_AFTER_CARD_TITLE,
      body: completionCardBody(
        "<p>The meter row and the transcript were hard to read at a glance.</p>",
        "<p>Both views are rearranged, and a history list is added.</p>",
        `<p>The meters wrapped and the transcript ran together.</p>${view(meterBefore, "The meter row")}${view(transcriptBefore, "The transcript")}`,
        `<p>The meters sit in one line and the transcript has room.</p>${view(meterAfter, "The meter row")}${view(transcriptAfter, "The transcript")}${view(history, "The history list", true)}`,
      ),
      actions: [
        {
          id: "put-in",
          label: "Put it in",
          default: true,
          effect: { kind: "settle", mode: "merge" },
        },
      ],
    },
  };
}

/**
 * The before-and-after crewmate: write the files, then offer the merge,
 * and offer it again once the card check refuses the misplaced mark.
 */
export const beforeAfter: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    // The before-and-after crewmate: write the files, then offer the merge,
    // and offer it again once the card check refuses the misplaced mark.
    if (!isFirstmate && latestUserTail.includes(BEFORE_AFTER_PROMPT_MARKER) && wantsStream) {
      if (!hasToolResults) {
        return { calls: writeChangePicturesCalls() };
      }
      if (!calledTool(latestUserTail, "emit_card")) {
        return { calls: [beforeAfterCardCall("picture")] };
      }
      const emits = ['"name":"emit_card","arguments"', '"name": "emit_card", "arguments"']
        .map((call) => latestUserTail.split(call).length - 1)
        .reduce((sum, count) => sum + count, 0);
      const refused = JSON.stringify(BEFORE_AFTER_MARK_REFUSAL).slice(1, -1);
      if (emits === 1 && latestUserTail.includes(refused)) {
        return { calls: [beforeAfterCardCall("figure")] };
      }
    }
    return undefined;
  };
