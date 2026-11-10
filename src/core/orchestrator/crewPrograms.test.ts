/**
 * Programs as `CrewPrograms` runs them (docs/programs.md): script
 * choices through dispatch, each task() call filed as a part, the bound on a
 * call, the drops of parts, and a program started again from its record.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * A program runs in a real child process.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WorkShapeAsk } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { forkChildProcess } from "../sql/forkChildProcess";
import { TaskService } from "../tasks/taskService";
import type { ReportDeclaration } from "../tasks/taskTurns";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

// INF-799 piece 2, the captain's Approve and build on "Plan task-graph
// programs, typed results first": the runner files each part as a child
// task and each part's checked result resolves the script's await; the
// program returns its branch and typed result; a call past the bound the
// first mate proposed is held until the captain says so (answer "bounds").
describe("programs (INF-799 piece 2)", () => {
  const PROGRAM_WAIT = { timeout: 20_000, interval: 25 };
  const programProcess = forkChildProcess(
    fileURLToPath(new URL("../program/programProcess.ts", import.meta.url)),
  );
  /** What the finder part hands on: the files that render a result. */
  const FILES = {
    type: "object",
    required: ["files"],
    properties: { files: { type: "array", items: { type: "string" } } },
  };

  async function programHarness(
    script: string,
    bound: number,
    options: {
      startPolicy?: "when-ready" | "on-request";
      spawns?: { count: number };
      premium?: boolean;
    } = {},
  ) {
    const sessions = [fakeCrewmate(), fakeCrewmate(), fakeCrewmate(), fakeCrewmate()];
    const counted = options.spawns;
    const harness = setup(sessions[0] as FakeCrewmate, {
      crewmates: sessions.slice(1),
      programProcess: counted
        ? {
            spawn: () => {
              counted.count += 1;
              return programProcess.spawn();
            },
          }
        : programProcess,
    });
    const dir = scratchDir("infinitary-program-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    const { repo } = await harness.repos.setup({ kind: "adopt", path: dir, name: "meterlab" });
    const program = harness.supervisor.intake.plan({
      title: "Cap the meter's rendered results",
      intent: intentOf("Cap what the meter renders."),
      repoId: repo.id,
      startPolicy: options.startPolicy ?? "when-ready",
      shape: { program: { script, bound }, ...(options.premium ? { premium_ask: true } : {}) },
    });
    harness.supervisor.intake.graphChanged();
    /** The part a task() call filed, once its crewmate is working on it. */
    const part = (call: number) =>
      vi.waitFor(() => {
        const found = harness.tasks.graph
          .children(program.id)
          .find((child) => child.shape?.program_part?.call === call);
        if (found?.status !== "active" || !sessions[call]?.promptCalls.length)
          throw new Error(`part ${call} has not started`);
        return found;
      }, PROGRAM_WAIT);
    /** The part's crewmate reports, and its turn ends. */
    const report = async (call: number, text: string, result?: Record<string, unknown>) => {
      const found = await part(call);
      const spec = harness.specs[call];
      await spec?.onReport?.(text, undefined, result ? { result } : undefined);
      sessions[call]?.emit({ type: "turn_end", taskId: found.id });
      sessions[call]?.finishPrompt();
      return found;
    };
    return { ...harness, open: harness.sessions.open, sessions, program, part, report };
  }

  // INF-974: the selected level survives filing and the queued dispatch's classification.
  it("persists each script choice through dispatch without changing unchosen parts", async () => {
    const h = await programHarness(
      `
      for (const intelligence of ["low", "medium", "high", undefined]) {
        await task("Read the meter's existing output.", { intelligence });
      }
      return "read";
    `,
      4,
    );
    for (const [call, intelligence] of ["low", "medium", "high", undefined].entries()) {
      const part = await h.part(call);
      expect(part.shape?.program_part?.intelligence).toBe(intelligence);
      expect(part.difficulty).toBe(intelligence ?? "high");
      await h.report(call, "Read the output.");
    }
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
  });

  it("refuses premium without consent and files it with the program's premium ask", async () => {
    const script = `await task("Investigate the meter.", { intelligence: "premium" }); return "checked";`;
    const denied = await programHarness(script, 1);
    await vi.waitFor(
      () => expect(denied.tasks.get(denied.program.id)?.status).toBe("dropped"),
      PROGRAM_WAIT,
    );
    expect(denied.tasks.graph.children(denied.program.id)).toEqual([]);
    expect(denied.ops.join(" ")).toContain(
      "the captain must request premium for the program first",
    );
    const allowed = await programHarness(script, 1, { premium: true });
    const part = await allowed.part(0);
    expect(part.shape).toMatchObject({
      premium_ask: true,
      program_part: { intelligence: "premium" },
    });
    expect(part.difficulty).toBe("premium");
    await allowed.report(0, "Checked the meter.");
    await vi.waitFor(
      () => expect(allowed.tasks.get(allowed.program.id)?.status).toBe("done"),
      PROGRAM_WAIT,
    );
  });

  it("files each task() call as a part, resolves its await with the part's result, and returns the program's result and branch", async () => {
    const h = await programHarness(
      `
      const found = await task("Find where the meter renders a result.", { label: "find", schema: ${JSON.stringify(FILES)} });
      const capped = await Promise.all(found.files.map((file) => task("Cap the result rendered in " + file + ".", { after: ["find"] })));
      return { files: found.files, capped, branch: "part 2" };
      `,
      3,
    );
    const finder = await h.part(0);
    expect(finder).toMatchObject({
      parentId: h.program.id,
      // Captain's program naming fix: the label is the title, not the instructions.
      title: "find",
      intent: { goal: "Find where the meter renders a result." },
    });
    expect(finder.shape).toMatchObject({ internal_step: true, result_schema: FILES });
    // The part carries the captain's words and is told how a part ships.
    expect(h.sessions[0]?.promptCalls[0]).toContain("Cap what the meter renders.");
    expect(h.sessions[0]?.promptCalls[0]).toContain(
      `Program part: this task is one part of the program ${h.program.key} "Cap the meter's rendered results"`,
    );
    const files = ["src/meter.ts", "src/gauge.ts"];
    await h.report(0, "Found two renderers.", { files });
    // The program reads the answer: no wake, and the part closes done, answered.
    await vi.waitFor(() => expect(h.tasks.get(finder.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.sorts.find((sort) => sort.taskId === finder.id)?.rule).toBe("program-part");
    expect(h.ops.filter((line) => line.includes(finder.id))).toEqual([]);

    // Both capping parts run at once, each waiting on the finder's result.
    const meter = await h.part(1);
    const gauge = await h.part(2);
    // Unlabelled calls keep the runner's default names, not their prompts.
    expect([meter.title, gauge.title]).toEqual(["part 2", "part 3"]);
    expect(h.events).toContainEqual({
      type: "firstmate_note",
      text: `The program "${h.program.title}" (${h.program.key}) filed part ${finder.key}: "${finder.title}".`,
    });
    expect(h.tasks.graph.blockers(meter.id).map((row) => row.id)).toEqual([finder.id]);
    await h.report(2, "Capped src/gauge.ts at 4 KiB.");
    await h.report(1, "Capped src/meter.ts at 4 KiB.");

    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    const result = {
      files,
      capped: ["Capped src/meter.ts at 4 KiB.", "Capped src/gauge.ts at 4 KiB."],
      branch: "part 2",
    };
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual(result);
    const ended = h.ops.find((line) => line.includes(`the program on task ${h.program.key}`)) ?? "";
    expect(ended).toContain("finished after 3 parts.");
    expect(ended).toContain(JSON.stringify(result));
    // The branch is the part the script returned by label, not the last to finish (captain, F5).
    expect(ended).toContain(`Its branch is ${meter.key}'s last commit`);
    expect(ended).not.toContain(gauge.key);
  });

  it("holds a call past the proposed bound, telling the first mate once, and goes on when the bound is raised", async () => {
    const h = await programHarness(
      `
      for (const file of ["meter.ts", "gauge.ts"]) await task("Cap the result rendered in " + file + ".");
      return "capped";
      `,
      1,
    );
    await h.report(0, "Capped meter.ts.");
    await vi.waitFor(
      () =>
        expect(h.ops.some((line) => line.includes("reached its bound of 1 task() calls"))).toBe(
          true,
        ),
      PROGRAM_WAIT,
    );
    const bound = h.ops.filter((line) => line.includes("reached its bound of"));
    expect(bound).toHaveLength(1);
    expect(bound[0]).toContain(
      "on the captain's words raise it with update_task program_bound, or drop the program",
    );
    expect(h.tasks.graph.children(h.program.id)).toHaveLength(1);
    expect(h.tasks.updateFields(h.program.id, { programBound: 2 }, "firstmate")).toEqual([
      "bound 2",
    ]);
    await h.report(1, "Capped gauge.ts.");
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual({ value: "capped" });
    // A script that returns no branch leaves nothing to ship; the host picks no part for it (captain, F5).
    const ended = h.ops.find((line) => line.includes("finished after 2 parts.")) ?? "";
    expect(ended).toContain("Its script returned no branch, so there is nothing to ship.");
    expect(ended).not.toContain("Its branch is");
  });

  it("fails a program whose returned branch names no part that finished done", async () => {
    const h = await programHarness(
      `
      await task("Cap the meter.", { label: "cap" });
      return { branch: "ship" };
      `,
      1,
    );
    await h.report(0, "Capped the meter.");
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("dropped"), PROGRAM_WAIT);
    const ended = h.ops.find((line) => line.includes(`the program on task ${h.program.key}`)) ?? "";
    expect(ended).toContain(
      'its script returned branch "ship", which names no part\'s label that finished done',
    );
  });

  it.each([
    ["a null", null],
    ["an empty", ""],
  ])(
    "reads %s returned branch as no branch, keeping the result (captain's N2 answer)",
    async (_name, empty) => {
      const h = await programHarness(
        `
      await task("Cap the meter.", { label: "cap" });
      return { capped: 1, branch: ${JSON.stringify(empty)} };
      `,
        1,
      );
      await h.report(0, "Capped the meter.");
      await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
      expect(h.tasks.latestResult(h.program.id)?.value).toEqual({ capped: 1, branch: empty });
      const ended =
        h.ops.find((line) => line.includes(`the program on task ${h.program.key}`)) ?? "";
      expect(ended).toContain("Its script returned no branch, so there is nothing to ship.");
    },
  );

  it("finishes once with one process when its end drops a part it never waited for (F3)", async () => {
    const spawns = { count: 0 };
    const h = await programHarness(
      `
      const meter = task("Cap the meter.");
      task("Cap the gauge.");
      return await meter;
      `,
      2,
      { spawns },
    );
    await h.part(1);
    await h.report(0, "Capped the meter.");
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    const gauge = h.tasks.graph
      .children(h.program.id)
      .find((part) => part.shape?.program_part?.call === 1);
    expect(gauge?.status).toBe("dropped");
    // The dropped part's close swept the graph while the program finished: no second runner.
    await tick();
    expect(spawns.count).toBe(1);
    expect(
      h.ops.filter((line) => line.includes(`the program on task ${h.program.key}`)),
    ).toHaveLength(1);
  });

  // INF-2037: a user's loop program ended and dropped two tasks the first
  // mate had filed under it, which were not its parts.
  it("drops only its own parts at its end, leaving a task filed under it running", async () => {
    const h = await programHarness(`return await task("Cap the meter.");`, 1);
    const part = await h.part(0);
    const { taskId: other, started } = await h.supervisor.intake.commission({
      title: "Write the gauge's docs",
      intent: intentOf("Document the gauge."),
      parent: h.program.key,
    });
    await started;
    expect(h.tasks.get(other)).toMatchObject({ parentId: h.program.id, status: "active" });
    await h.report(0, "Capped the meter.");
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.get(part.id)?.status).toBe("done");
    expect(h.tasks.get(other)?.status).toBe("active");
    expect(
      h.tasks
        .timeline(other)
        .map((event) => event.text)
        .join(" "),
    ).not.toContain("its program ended");
  });

  // INF-2037: the user's last loop round reported that its checks were still
  // running, with a check-back, and the app took that report as its answer.
  it("reads a part's check-back report as progress, and its later report as the answer", async () => {
    const ROUND = {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
    };
    const h = await programHarness(
      `return await task("Run the meter's checks.", { schema: ${JSON.stringify(ROUND)} });`,
      1,
    );
    const part = await h.part(0);
    const crewmate = h.sessions[0] as FakeCrewmate;
    /** The app wakes the part's crewmate, which reports, and its turn ends. */
    const turn = async (text: string, declared: ReportDeclaration) => {
      const prompts = crewmate.promptCalls.length;
      await h.supervisor.steer.steerCrewmate(
        part.id,
        "The app woke you: look at the meter's checks.",
      );
      await vi.waitFor(() => expect(crewmate.promptCalls.length).toBeGreaterThan(prompts));
      await h.specs[0]?.onReport?.(text, undefined, declared);
      crewmate.emit({ type: "turn_end", taskId: part.id });
      crewmate.finishPrompt();
      await tick();
    };
    const checkBack = { minutes: 10, waitingFor: "the meter's checks" };
    // A part with a result shape sends its progress without a result.
    await h.specs[0]?.onReport?.("The checks are still running.", undefined, { checkBack });
    crewmate.emit({ type: "turn_end", taskId: part.id });
    crewmate.finishPrompt();
    await tick();
    expect(h.tasks.get(part.id)?.status).toBe("active");
    expect(h.tasks.get(h.program.id)?.status).toBe("open");
    // A result beside a check-back is still progress: the work is not over.
    await turn("Still running.", { result: { done: false }, checkBack });
    expect(h.tasks.get(part.id)?.status).toBe("active");
    expect(h.sorts.filter((sort) => sort.taskId === part.id)).toHaveLength(2);
    expect(h.sorts.map((sort) => sort.rule)).not.toContain("program-part");
    await turn("The checks passed.", { result: { done: true } });
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual({ done: true });
  });

  /** A one-part program whose part's crewmate could not open, so the part is back in the queue. */
  async function unstartedPart() {
    const h = await programHarness(`return await task("Cap the meter.");`, 1);
    h.open.mockRejectedValueOnce(new Error("the provider did not answer"));
    const part = await vi.waitFor(() => {
      const found = h.tasks.graph.children(h.program.id)[0];
      if (
        !found ||
        !h.tasks.timeline(found.id).some((event) => event.text.includes("could not start"))
      )
        throw new Error("the part has not been returned to the queue");
      return found;
    }, PROGRAM_WAIT);
    expect(h.tasks.get(part.id)?.status).toBe("open");
    return { h, part };
  }

  it("keeps running when its drop is refused for a part that has not started (F8)", async () => {
    const { h, part } = await unstartedPart();
    expect(h.supervisor.intake.dropTask(h.program.key, { reason: "changed course" })).toMatch(
      /^Cannot close/,
    );
    expect(h.tasks.get(h.program.id)?.status).toBe("open");
    // Still running: the captain starts the held part, and its answer ends the script.
    expect(await h.supervisor.starts.startQueuedNow(part.key)).toContain(
      `${part.key} "${part.title}" is starting.`,
    );
    await vi.waitFor(() => expect(h.tasks.get(part.id)?.status).toBe("active"), PROGRAM_WAIT);
    // The failed open took the first crewmate spec; the started crewmate's is the last.
    await h.specs.at(-1)?.onReport?.("Capped the meter.");
    h.sessions[0]?.emit({ type: "turn_end", taskId: part.id });
    h.sessions[0]?.finishPrompt();
    await vi.waitFor(() => expect(h.tasks.get(h.program.id)?.status).toBe("done"), PROGRAM_WAIT);
    expect(h.tasks.latestResult(h.program.id)?.value).toEqual({
      value: "Capped the meter.",
    });
  });

  it("stops on a confirmed drop of a part that has not started (F8)", async () => {
    const { h, part } = await unstartedPart();
    expect(
      h.supervisor.intake.dropTask(h.program.key, { reason: "changed course", confirm: true }),
    ).toMatch(/^Dropped/);
    expect(h.tasks.get(h.program.id)?.status).toBe("dropped");
    expect(h.tasks.get(part.id)?.status).toBe("dropped");
  });

  it("starts an on-request program on Start, and runs it again from its record after a quit (F1)", async () => {
    const h = await programHarness(`return await task("Cap the meter.");`, 1, {
      startPolicy: "on-request",
    });
    await tick();
    expect(h.tasks.graph.children(h.program.id)).toHaveLength(0);
    expect(await h.supervisor.starts.startQueuedNow(h.program.key)).toBe(
      `Started ${h.program.key} "Cap the meter's rendered results".`,
    );
    expect(h.tasks.get(h.program.id)).toMatchObject({ status: "open" });
    expect(h.tasks.starts.programStarted(h.program.id)).toBe(true);
    // No crewmate holds a program: its start is not the crewmate fact that draws the Crewmate tab (INF-866 N3).
    expect(h.tasks.get(h.program.id)?.startedAt).toBeNull();
    const part = await h.part(0);
    // The part reports, and the app quits before the program reads it.
    h.tasks.turns.recordReport(part.id, { text: "Capped the meter." });
    await h.supervisor.disposeAll();

    const restartedTasks = new TaskService({ db: h.db, strict: true });
    const restarted = reboot(
      { paths: h.paths, db: h.db, workspace: h.workspace },
      vi.fn(async () => fakeCrewmate()),
      {
        tasks: restartedTasks,
        programProcess,
      },
    );
    restarted.setFirstmateHooks({ notifyOp: vi.fn(), retryConverse: vi.fn() });
    try {
      restarted.intake.graphChanged();
      await vi.waitFor(
        () => expect(restartedTasks.get(h.program.id)?.status).toBe("done"),
        PROGRAM_WAIT,
      );
      expect(restartedTasks.latestResult(h.program.id)?.value).toEqual({
        value: "Capped the meter.",
      });
      expect(restartedTasks.graph.children(h.program.id)).toHaveLength(1);
    } finally {
      await restarted.disposeAll();
    }
  });

  it("refuses a program outside a project, filing nothing", () => {
    const { supervisor, tasks } = setup(fakeCrewmate(), { programProcess });
    const plan = (shape: WorkShapeAsk) => () =>
      supervisor.intake.plan({ title: "Cap results", intent: intentOf("Cap them."), shape });
    expect(plan({ program: { script: "return 1;", bound: 1 } })).toThrow(
      "A program runs its parts in a project",
    );
    expect(tasks.list()).toHaveLength(0);
  });
});
