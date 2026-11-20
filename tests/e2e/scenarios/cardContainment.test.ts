import { expect, test } from "vitest";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../../src/core/pi/bashWords";
import { frameServedInput } from "../../../src/shared/servedFrame";
import type { ScenarioAnswer } from "../mockProvider";
import {
  cardContainment,
  PROJECT_FONT_CARD_TITLE,
  PROJECT_FONT_PROMPT_MARKER,
  PROJECT_FONT_REFUSAL,
  PROJECT_FONTS_STILL_WRITING,
} from "./cardContainment";

/**
 * INF-2029: on the alpha's Mac lane, `card-containment.spec.ts` waited ten
 * minutes for the project-font card. When both font writes came back as
 * background jobs' receipts, the stand-in offered the card before the files
 * existed, and after the host refused the missing file it never offered the
 * real one. Replay the crewmate at the stand-in's own boundary, without
 * starting Electron or waiting on a clock; the journey owns how the card draws.
 */

const DAMAGED = "shots/project-face-damaged.woff2";
const REAL = "shots/project-face.woff2";

function replay() {
  const answerer = cardContainment();
  const messages: Record<string, unknown>[] = [
    { role: "user", content: `commission a crewmate: ${PROJECT_FONT_PROMPT_MARKER}` },
  ];
  let last: ScenarioAnswer | undefined;
  return {
    next() {
      const body = JSON.stringify({ messages });
      const lastUser = body.lastIndexOf('"role":"user"');
      const latestUserTail = body.slice(lastUser);
      last = answerer({
        body,
        latestUserTail,
        isFirstmate: false,
        wantsStream: true,
        hasToolResults: latestUserTail.includes('"tool_call_id"'),
        anthropicMessages: false,
        port: 0,
      });
      return last;
    },
    // Chat completions' tool-call/result shape, one result for each call of the last answer.
    results(texts: string[]) {
      if (!last || !("calls" in last)) throw new Error("Expected tool calls");
      const calls = last.calls;
      expect(calls).toHaveLength(texts.length);
      const ids = calls.map((_, index) => `call-${messages.length}-${index}`);
      messages.push({
        role: "assistant",
        tool_calls: calls.map((call, index) => ({
          id: ids[index],
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      messages.push(
        ...texts.map((content, index) => ({ role: "tool", tool_call_id: ids[index], content })),
      );
    },
    exits(jobs: string[]) {
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
    },
  };
}

const offered = (answer: ScenarioAnswer | undefined) => {
  if (!answer || !("calls" in answer)) throw new Error("Expected a card");
  expect(answer.calls.map((call) => call.name)).toEqual(["emit_card"]);
  return JSON.stringify(answer.calls[0]?.args);
};

test("the font crewmate offers the real font once the host refuses the damaged copy", () => {
  const r = replay();
  const writes = r.next();
  if (!writes || !("calls" in writes)) throw new Error("Expected the writes");
  expect(writes.calls.map((call) => call.name)).toEqual(["bash", "bash"]);
  r.results(["exit 0", "exit 0"]);
  expect(offered(r.next())).toContain(DAMAGED);
  r.results([`Card font refused: ${DAMAGED} ${PROJECT_FONT_REFUSAL}: decode failed.`]);
  const real = offered(r.next());
  expect(real).toContain(REAL);
  expect(real).not.toContain(DAMAGED);
});

test("the font crewmate waits for both slow font writes before offering its card", () => {
  const r = replay();
  r.next();
  r.results([backgroundJobReceipt("5f0c2a91"), backgroundJobReceipt("b37e04d6")]);
  expect(r.next()).toEqual({ text: PROJECT_FONTS_STILL_WRITING });
  r.exits(["5f0c2a91", "b37e04d6"]);
  expect(offered(r.next())).toContain(DAMAGED);
});

test("the font crewmate still offers the real font after a missing-file refusal", () => {
  const r = replay();
  r.next();
  r.results(["exit 0", "exit 0"]);
  expect(offered(r.next())).toContain(DAMAGED);
  r.results([`Card font refused: file not found: ${DAMAGED}`]);
  const real = offered(r.next());
  expect(real).toContain(REAL);
  expect(real).not.toContain(DAMAGED);
  // A shown card ends the font crewmate's script.
  r.results([`Card shown: ${PROJECT_FONT_CARD_TITLE}`]);
  expect(r.next()).toBeUndefined();
});
