import { expect, test } from "vitest";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../../src/core/pi/bashWords";
import { frameServedInput } from "../../../src/shared/servedFrame";
import type { ScenarioAnswer } from "../mockProvider";
import { WORKING_COPY_PICTURES } from "../pictureFixtures";
import {
  CARD_PICTURES_PROMPT_MARKER,
  cardPictures,
  PICTURE_CARD_TITLES,
  PICTURES_STILL_WRITING,
} from "./cardPictures";

/**
 * INF-1128: on main's loaded Mac lane, `card-picture-fit.spec.ts` waited for
 * a stack of four picture cards and got three. A write that outlasts the
 * shell's limit answers with its job's receipt while the file is still being
 * written, and a card naming that file is refused. Replay the slow writes at
 * the stand-in's own boundary, without starting Electron or waiting on a
 * clock; the journeys still own how the cards look.
 */

// The journey encodes its JPEG and WebP in the app's own browser
// (`encodeInBrowser`). Only the shell's answers to the writes matter here,
// so those two files carry their own paths as bytes.
for (const picture of WORKING_COPY_PICTURES) picture.bytes ??= Buffer.from(picture.path);

for (const slow of ["one slow write", "two slow writes that end in one wake turn"] as const) {
  test(`the pictures crewmate waits for ${slow} before attaching its pictures`, () => {
    const answerer = cardPictures();
    const messages: { role: string; content: unknown }[] = [
      { role: "user", content: `commission a crewmate: ${CARD_PICTURES_PROMPT_MARKER}` },
    ];
    let last: ScenarioAnswer | undefined;
    const next = () => {
      const body = JSON.stringify({ messages });
      last = answerer({
        body,
        isFirstmate: false,
        wantsStream: true,
        latestUserTail: body,
        hasToolResults: messages.length > 1,
      });
      return last;
    };
    // Anthropic's tool-use/result shape, as the journey's Pi seat sends it:
    // one result for each call of the last answer.
    const results = (texts: string[]) => {
      if (!last || !("calls" in last)) throw new Error("Expected tool calls");
      expect(last.calls).toHaveLength(texts.length);
      const ids = last.calls.map((_, index) => `tool-${messages.length}-${index}`);
      messages.push(
        {
          role: "assistant",
          content: last.calls.map((call, index) => ({
            type: "tool_use",
            id: ids[index],
            name: call.name,
            input: call.args,
          })),
        },
        {
          role: "user",
          content: texts.map((text, index) => ({
            type: "tool_result",
            tool_use_id: ids[index],
            content: text,
          })),
        },
      );
    };
    const exits = (jobs: string[]) =>
      messages.push({
        role: "user",
        content: frameServedInput(
          jobs.map((job) => ({
            kind: "wake",
            origin: "agent",
            body: renderWake({
              facts: {
                kind: "job-exit",
                to: "crewmate",
                jobId: job,
                command: "mkdir -p shots && printf",
                exitCode: 0,
                durationMs: SYNC_CAP_MS + 1000,
              },
            }),
          })),
        ).text,
      });

    const writes = next();
    if (!writes || !("calls" in writes)) throw new Error("Expected the writes");
    expect(writes.calls.map((call) => call.name)).toEqual(WORKING_COPY_PICTURES.map(() => "bash"));
    // The last writes are the slow ones.
    const jobs = slow === "one slow write" ? ["5f0c2a91"] : ["5f0c2a91", "b37e04d6"];
    results([
      ...writes.calls.slice(jobs.length).map(() => "exit 0\n(no output)"),
      ...jobs.map((job) => backgroundJobReceipt(job)),
    ]);
    expect(next()).toEqual({ text: PICTURES_STILL_WRITING });
    exits(jobs);
    const cards = next();
    if (!cards || !("calls" in cards)) throw new Error("Expected the cards");
    expect(cards.calls).toEqual(
      Object.values(PICTURE_CARD_TITLES).map((title) => ({
        name: "emit_card",
        args: expect.objectContaining({ title }),
      })),
    );
    // After the cards, the default close-out answers.
    results(cards.calls.map(() => "Card shown."));
    expect(next()).toBeUndefined();
  });
}
