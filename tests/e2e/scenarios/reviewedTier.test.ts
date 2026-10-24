import { expect, test } from "vitest";
import { SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../../../src/core/pi/bashWords";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { REVIEWED_TIER_PROMPT_MARKER, type ScenarioAnswer } from "../mockProvider";
import { MOCK_REVIEWED_BUILDER_REPORT, MOCK_REVIEWED_CHANGE, reviewedTier } from "./reviewedTier";

/**
 * INF-1149: on PR #309's loaded Mac lane, `rigor-reviewed.spec.ts` waited 30
 * seconds for the builder's first report line and saw none. The builder's
 * save point runs in a shell below the UI, so on a busy computer it can
 * outlast the shell's limit and answer with its job's receipt before the
 * commit is on the branch. A check reading taken then names the branch
 * before it, and the proof at that head is refused once the commit lands;
 * the builder repeated it and never ended its turn. Replay the slow commit
 * at the stand-in's own boundary, without starting Electron or waiting on a
 * clock; the journey still owns the rest of the review.
 */
test("the reviewed builder reads its checks once its slow save point has exited", () => {
  const answerer = reviewedTier();
  const messages: { role: string; content: unknown }[] = [
    { role: "user", content: `[work] title: meterlab ${REVIEWED_TIER_PROMPT_MARKER}` },
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
      anthropicMessages: false,
      port: 0,
    });
    return last;
  };
  // Anthropic's tool-use/result shape, as the journey's Pi seat sends it:
  // one result for each call of the last answer.
  const results = (...texts: string[]) => {
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
  expect(next()).toMatchObject({
    calls: [{ name: "report", args: { validation: { kind: "plan" } } }],
  });
  results(
    "Validation plan recorded at evidence revision 0. This records facts, not a finished-work report or permission. Continue the task; report when the first mate must act.",
  );
  const command = `git commit --allow-empty -m "${MOCK_REVIEWED_CHANGE.title}"`;
  expect(next()).toEqual({ calls: [{ name: "bash", args: { command } }] });
  results(backgroundJobReceipt("4d2e8a17"));
  // While the commit runs, the builder ends its turn without words: they
  // would be one more report on the task, ahead of its green one.
  expect(next()).toEqual({ text: "" });

  // The job's exit is the builder's next turn; its commit is on the branch now.
  messages.push({
    role: "user",
    content: frameServedInput([
      {
        kind: "wake",
        origin: "agent",
        body: renderWake({
          facts: {
            kind: "job-exit",
            to: "crewmate",
            jobId: "4d2e8a17",
            command,
            exitCode: 0,
            durationMs: SYNC_CAP_MS + 1000,
          },
        }),
      },
    ]).text,
  });
  expect(next()).toEqual({ calls: [{ name: "check_change", args: {} }] });
  const committed = "9b51c0e7a2d4f86b3e1c5a7d9f0b2e4c6a8d1f3b";
  results(
    `pull request #55 https://github.com/o/meterlab/pull/55 head ${committed}\noverall: green\n- ci: completed / success`,
  );
  expect(next()).toMatchObject({
    calls: [
      {
        name: "report",
        args: { text: MOCK_REVIEWED_BUILDER_REPORT, validation: { kind: "run", head: committed } },
      },
    ],
  });
  results("Reported. Validation recorded at evidence revision 1.");
  expect(next()).toEqual({ text: MOCK_REVIEWED_BUILDER_REPORT });
});
