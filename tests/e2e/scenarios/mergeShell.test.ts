import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { jobExitWake, SYNC_CAP_MS } from "../../../src/core/jobs/jobManager";
import { JOB_BOUND_MS } from "../../../src/core/orchestrator/idleLadder";
import { checkBackAsk } from "../../../src/core/orchestrator/jobWakes";
import { renderWake } from "../../../src/core/orchestrator/wakes";
import { createEventBashTool } from "../../../src/core/pi/bashTool";
import { frameServedInput } from "../../../src/shared/servedFrame";
import { scratchDir } from "../../helpers/scratchDirs";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { GUIDED_MERGE_MARKER, GUIDED_MERGE_STEER, guidedMerge } from "./guidedMerge";
import { KEPT_MERGE_MARKER, KEPT_MERGE_REPAIR, keptMerge } from "./keptMerge";

/**
 * INF-1342: the alpha's loaded Mac run must not turn a git job receipt into
 * a repair with missing heads. Replay both shell completion orders using
 * real disposable git output and the bash tool's receipt/exit protocol.
 * The Electron journey owns the merge; this test owns the scripted model's
 * decision to wait, then use the completed command without repeating it.
 */
function conversation(scenario: Scenario, user: string) {
  const answer = scenario();
  const messages: { role: string; content: unknown }[] = [{ role: "user", content: user }];
  const next = (): ScenarioAnswer | undefined => {
    const body = JSON.stringify({ messages });
    return answer({
      body,
      isFirstmate: false,
      wantsStream: true,
      latestUserTail: body,
      hasToolResults: messages.length > 1,
      anthropicMessages: true,
      port: 0,
    });
  };
  return { messages, next };
}

function callOf(answer: ScenarioAnswer | undefined): ScriptedCall {
  if (!answer || !("calls" in answer) || answer.calls.length !== 1)
    throw new Error("Expected one scripted call");
  return answer.calls[0] as ScriptedCall;
}

const CASES = [
  { scenario: keptMerge, marker: KEPT_MERGE_MARKER, repair: KEPT_MERGE_REPAIR },
  {
    scenario: guidedMerge,
    marker: GUIDED_MERGE_MARKER,
    repair: GUIDED_MERGE_STEER,
  },
];

for (const { scenario, marker, repair } of CASES) {
  for (const phase of ["commit", "repair"] as const) {
    for (const background of [false, true]) {
      test(`${marker}: ${phase} resumes from ${background ? "the job exit" : "the inline output"}`, async () => {
        const cwd = scratchDir("infinitary-merge-shell-");
        const git = (...args: string[]) =>
          execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
        git("init", "--initial-branch=main");
        git("config", "user.name", "Test");
        git("config", "user.email", "test@localhost");
        git("commit", "--allow-empty", "-m", "chore: initialize fixture");
        git("checkout", "-b", "work");
        const initial = conversation(scenario, marker);
        const commit = callOf(initial.next());
        const run = (call: ScriptedCall) => {
          if (call.name !== "bash") throw new Error("Expected the git command");
          return execFileSync("bash", ["-c", String(call.args.command)], {
            cwd,
            encoding: "utf8",
            stdio: "pipe",
          });
        };
        let chat = initial;
        let call = commit;
        if (phase === "repair") {
          run(commit);
          git("checkout", "main");
          git("commit", "--allow-empty", "-m", "feat: newer work");
          git("checkout", "work");
          chat = conversation(scenario, repair);
          call = callOf(chat.next());
        }
        if (call.name !== "bash") throw new Error("Expected the git command");
        const fromHead = git("rev-parse", "HEAD");
        const base = git("rev-parse", "main");
        const output = run(call);
        const head = git("rev-parse", "HEAD");
        const jobId = "merge-git";
        const tool = createEventBashTool(async () =>
          background
            ? { kind: "job", jobId, tail: fromHead }
            : { kind: "done", exitCode: 0, output },
        );
        const context = {} as Parameters<typeof tool.execute>[4];
        const result = await tool.execute(
          "git",
          { command: String(call.args.command) },
          undefined,
          undefined,
          context,
        );
        chat.messages.push(
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "git", name: call.name, input: call.args }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "git", content: result.content }],
          },
        );
        if (background) {
          expect(chat.next()).toEqual({ text: "" });
          // The real supervisor asks about a still-running job at idle.
          // This wake must not replace the assignment the git output belongs to.
          chat.messages.push({
            role: "user",
            content: renderWake(
              checkBackAsk(
                {
                  jobId,
                  command: String(call.args.command),
                  startedAt: 0,
                },
                SYNC_CAP_MS,
                JOB_BOUND_MS,
              ),
            ),
          });
          expect(chat.next()).toEqual({ text: "" });
          chat.messages.push({
            role: "user",
            content: frameServedInput([
              {
                kind: "wake",
                origin: "agent",
                body: renderWake(
                  jobExitWake(
                    {
                      jobId,
                      ownerId: "crewmate",
                      command: String(call.args.command),
                      exitCode: 0,
                      durationMs: SYNC_CAP_MS + 1,
                      tail: output,
                    },
                    "crewmate",
                  ),
                ),
              },
            ]).text,
          });
        }
        const next = callOf(chat.next());
        if (phase === "commit") {
          if (next.name !== "prepare_change") throw new Error("Expected the committed story");
          expect(next.args.story).toMatchObject({ base, head });
        } else {
          if (next.name !== "check_change") throw new Error("Expected the repair declaration");
          expect(next.args.conflictRepair).toMatchObject({
            fromHead,
            toHead: head,
            newBase: base,
            impact: "none",
          });
        }
      });
    }
  }
}
