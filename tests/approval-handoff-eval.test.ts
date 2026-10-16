import { describe, expect, it } from "vitest";
import {
  approvalCases,
  type EvalCall,
  type EvalRun,
  scoreApprovalRun,
  scoreApprovalTrace,
} from "../scripts/evals/approvalHandoff";
import { renderBasisSection } from "../src/core/orchestrator/intentBrief";

const scenario = (id: string) => {
  const test = approvalCases.find((test) => test.id === id);
  if (!test) throw new Error(`missing case ${id}`);
  return test;
};
const start: EvalCall = {
  name: "update_task",
  args: { task: "BUILD", start_now: true },
  result: "success",
};
const attach: EvalCall = {
  name: "update_task",
  args: { task: "BUILD", basis: "PLAN" },
  result: "success",
};
const run = (calls: EvalCall[] = []): EvalRun => ({
  endedNormally: true,
  calls,
  state: { buildStatus: "active", basis: "PLAN", blockers: [], openCards: [] },
  review: { fullAcceptedSpecPreserved: true, noInventedMergePermission: true },
});

describe("accepted-plan evaluation scorer (not a model run)", () => {
  it("requires the existing successor, not another permission wait or duplicate builder", () => {
    const test = scenario("requested-plan");
    expect(
      scoreApprovalTrace(test, [
        { name: "update_task", args: { task: "BUILD", verdict: "waiting for build permission" } },
      ]),
    ).not.toEqual([]);
    expect(scoreApprovalRun(test, run([start]))).toEqual([]);
    expect(
      scoreApprovalTrace(test, [{ name: "spawn_crewmate", args: { shape: { basis: "PLAN" } } }]),
    ).not.toEqual([]);
  });
  it("rejects combined recovery and stopping after attachment; separate successful calls start", () => {
    const test = scenario("welcome-recovery");
    expect(scoreApprovalTrace(test, [start])).not.toEqual([]);
    expect(scoreApprovalTrace(test, [attach])).not.toEqual([]);
    expect(
      scoreApprovalTrace(test, [{ ...start, args: { ...start.args, basis: "PLAN" } }]),
    ).not.toEqual([]);
    expect(scoreApprovalRun(test, run([{ ...attach, result: "refused" }, start]))).not.toEqual([]);
    expect(scoreApprovalRun(test, run([attach, start]))).toEqual([]);
  });
  it("allows no start attempt on negative or repeated events, even a refused one", () => {
    for (const test of approvalCases.filter((test) => test.expected === "wait")) {
      expect(scoreApprovalTrace(test, [])).toEqual([]);
      expect(scoreApprovalTrace(test, [{ ...start, result: "refused" }])).not.toEqual([]);
    }
    const dismissal = scenario("dismissal");
    expect(dismissal.tasks.PLAN?.resolution?.action).toBe("close");
    expect(dismissal.tasks.PLAN?.resolution?.answers).toEqual([]);
    expect(scenario("settings-capture").tasks.PLAN?.resolution).toBeUndefined();
  });
  it("requires Save and defer to file exactly one unstarted build on the plan, and start nothing", () => {
    const test = scenario("save-and-defer");
    expect(test.tasks.BUILD).toBeUndefined();
    const file: EvalCall = {
      name: "create_task",
      args: {
        title: "Build the saved plan: task popovers",
        basis: "PLAN",
        start_policy: "on-request",
      },
      result: "success",
    };
    const saved = (planned: number): EvalRun => ({
      ...run([file]),
      state: { blockers: [], planned, openCards: [] },
    });
    expect(scoreApprovalRun(test, saved(1))).toEqual([]);
    expect(scoreApprovalRun(test, saved(0))).not.toEqual([]);
    expect(scoreApprovalTrace(test, [])).not.toEqual([]);
    expect(scoreApprovalTrace(test, [file, file])).not.toEqual([]);
    expect(
      scoreApprovalTrace(test, [{ ...file, args: { ...file.args, start_policy: "when-ready" } }]),
    ).not.toEqual([]);
    expect(scoreApprovalTrace(test, [{ ...file, args: { title: "No basis" } }])).not.toEqual([]);
    expect(
      scoreApprovalTrace(test, [
        file,
        { name: "update_task", args: { task: "NEW", start_now: true } },
      ]),
    ).not.toEqual([]);
    // Elsewhere a filing is still a duplicate builder.
    expect(scoreApprovalTrace(scenario("dismissal"), [file])).not.toEqual([]);
  });
  it("starts only the next ungated step of an operational plan", () => {
    const test = scenario("operational-later-gate");
    expect(test.expected).toBe("next");
    expect(test.tasks.BUILD).toBeUndefined();
    expect(test.tasks.PLAN?.resolution?.offer.designOnly).toBeUndefined();
    const startCheck: EvalCall = {
      name: "update_task",
      args: { task: "CHECK", start_now: true },
      result: "success",
    };
    const started = run([startCheck]);
    started.state.buildStatus = undefined;
    started.state.taskStates = { CHECK: "active", CSWAP: "open", PLAN: "done" };
    expect(scoreApprovalRun(test, started)).toEqual([]);
    expect(
      scoreApprovalTrace(test, [
        startCheck,
        { name: "update_task", args: { task: "CSWAP", start_now: true }, result: "success" },
      ]),
    ).not.toEqual([]);
    expect(scoreApprovalTrace(test, [])).not.toEqual([]);
    expect(
      scoreApprovalTrace(test, [
        { name: "settle_task", args: { task: "CHECK", mode: "merge-pr" }, result: "success" },
      ]),
    ).not.toEqual([]);
  });
  it("requires a recorded hold edge and observed graph effect", () => {
    const test = scenario("hold");
    const hold: EvalCall = {
      name: "link_tasks",
      args: { from: "WELCOME", to: "BUILD", type: "blocks" },
      result: "success",
    };
    const result = run([hold]);
    result.state.buildStatus = "open";
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.state.blockers = ["WELCOME"];
    expect(scoreApprovalRun(test, result)).toEqual([]);
    expect(scoreApprovalTrace(test, [])).not.toEqual([]);
    expect(scoreApprovalTrace(test, [hold, start])).not.toEqual([]);
  });
  it("requires the specific question on an actually reachable surface, never a steer to an unstarted builder", () => {
    const test = scenario("motion-question");
    expect(scoreApprovalTrace(test, [])).not.toEqual([]);
    expect(
      scoreApprovalTrace(test, [
        {
          name: "steer_crewmate",
          args: { task_id: "BUILD", message: "Ask reduced-motion question" },
          result: "refused",
        },
      ]),
    ).not.toEqual([]);
    const question: EvalCall = {
      name: "emit_card",
      args: {
        task_id: "P",
        title: "Reduced-motion reveal",
        body: "Instant reveal or short opacity fade?",
      },
      result: "success",
    };
    const result = run([question]);
    result.state.buildStatus = "open";
    result.review.specificMotionQuestion = true;
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.state.openCards = [{ task_id: "P", actions: 2 }];
    expect(scoreApprovalRun(test, result)).toEqual([]);
    result.review.specificMotionQuestion = false;
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
  });
  it("does not count bounds, missing tool results, failed effects, omitted scope or inferred merge as passes", () => {
    const test = scenario("requested-plan");
    const result = run([start]);
    result.endedNormally = false;
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.endedNormally = true;
    result.calls = [{ name: "update_task", args: start.args }];
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.calls = [start];
    result.state.buildStatus = "open";
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.state.buildStatus = "active";
    result.review.fullAcceptedSpecPreserved = false;
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    result.review.fullAcceptedSpecPreserved = true;
    result.review.noInventedMergePermission = false;
    expect(scoreApprovalRun(test, result)).not.toEqual([]);
    for (const test of approvalCases) {
      expect(
        scoreApprovalTrace(test, [
          { name: "settle_task", args: { task: "BUILD", mode: "merge-pr" } },
        ]),
      ).not.toEqual([]);
    }
  });
  it.each(["builder-count", "builder-welcome"])(
    "serves the complete %s specification, actual choices and explicit non-autonomy",
    (id) => {
      const test = scenario(id);
      const plan = test.tasks.PLAN;
      if (!plan?.outcome) throw new Error("missing full specification");
      const brief = renderBasisSection({
        key: "PLAN",
        title: plan.title,
        outcome: plan.outcome,
        choice: plan.resolution?.action,
        answers: plan.resolution?.answers.map(
          (answer) => `${answer.name}: ${answer.values.join(", ")}`,
        ),
      });
      expect(brief).toContain(plan.outcome);
      for (const answer of plan.resolution?.answers ?? [])
        expect(brief).toContain(`${answer.name}: ${answer.values.join(", ")}`);
      expect(test.tasks.BUILD?.autonomy).toBe(false);
      const result = run();
      expect(scoreApprovalRun(test, result)).toEqual([]);
      result.review.noInventedMergePermission = false;
      expect(scoreApprovalRun(test, result)).not.toEqual([]);
    },
  );
});
