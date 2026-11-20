/**
 * A crewmate starts a program (INF-3022's plan, the captain's Approve and
 * build; docs/programs.md, "Starting a program"): start_program files it in
 * the crewmate's project, found on its task, which waits on it holding no
 * merge (answer "always-wait"); its bound steers the crewmate that started
 * it, which raises or stops it, and its end steers that crewmate once with
 * the first mate told nothing (answer "crewmate-then-first-mate"). Each case
 * drives a real CrewSupervisor through the crew harness, with the program in
 * a real child process.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  bundledRunbooks,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { Runbooks } from "../runbooks/runbooks";
import { forkChildProcess } from "../sql/forkChildProcess";
import { NO_WORDS_FOR_THIS_TASK, parseSpawnIntent, type SpawnIntent } from "./intentBrief";

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("a crewmate's start_program (INF-3022)", () => {
  const WAIT = { timeout: 20_000, interval: 25 };
  const programProcess = forkChildProcess(
    fileURLToPath(new URL("../program/programProcess.ts", import.meta.url)),
  );
  const TWO_PARTS = `
    for (const file of args.files) await task("Cap the result rendered in " + file + ".");
    return "capped";
  `;

  async function started(
    options: { runbooksOff?: boolean; personal?: boolean; intent?: SpawnIntent } = {},
  ) {
    const sessions = [fakeCrewmate(), fakeCrewmate(), fakeCrewmate(), fakeCrewmate()];
    const runbooks = options.runbooksOff
      ? new Runbooks(join(dirname(fileURLToPath(import.meta.url)), "../../../resources/runbooks"), {
          getRunbookStates: () => ({ programs: false }),
          setRunbookStates: () => {},
        })
      : bundledRunbooks();
    const h = setup(sessions[0] as FakeCrewmate, {
      crewmates: sessions.slice(1),
      programProcess,
      runbooks,
    });
    const dir = scratchDir("infinitary-crew-program-");
    execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
    const { repo } = await h.repos.setup({ kind: "adopt", path: dir, name: "meterlab" });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Cap the meter's results",
      intent:
        options.intent ?? intentOf("cap what the meter renders; use start_program to do this"),
      repoId: repo.id,
    });
    await vi.waitFor(() => expect(sessions[0]?.promptCalls).toHaveLength(1), WAIT);
    const origin = sessions[0] as FakeCrewmate;
    const spec = h.specs[0];
    /** The crewmate's turn ends. */
    const endTurn = async () => {
      origin.emit({ type: "turn_end", taskId });
      origin.finishPrompt();
      await tick();
    };
    /** What the crewmate heard after its first prompt: later prompts and steers. */
    const heard = () => [
      ...origin.promptCalls.slice(1),
      ...origin.steer.mock.calls.map((call) => String(call[0])),
    ];
    /** The part a task() call filed, once its crewmate works on it. */
    const part = (programId: string, call: number) =>
      vi.waitFor(() => {
        const found = h.tasks.graph
          .children(programId)
          .find((child) => child.shape?.program_part?.call === call);
        if (found?.status !== "active" || !sessions[call + 1]?.promptCalls.length)
          throw new Error(`part ${call} has not started`);
        return found;
      }, WAIT);
    const report = async (programId: string, call: number, text: string) => {
      const found = await part(programId, call);
      await h.specs[call + 1]?.onReport?.(text);
      sessions[call + 1]?.emit({ type: "turn_end", taskId: found.id });
      sessions[call + 1]?.finishPrompt();
    };
    return { ...h, sessions, taskId, spec, endTurn, heard, part, report, repo };
  }

  it("files the program found on the task, which waits on it until it closes, and steers the crewmate once at its end", async () => {
    const h = await started();
    // What each commit shows once the program exists: a reader on another
    // connection reads between commits, as the program journey's test
    // process does (INF-3046, a merge batch's journey read no origin).
    const commits: { origin?: string; waitsOn: string[] }[] = [];
    const stopReading = h.tasks.onChange(() => {
      const filed = h.tasks.list().find((row) => row.shape?.program);
      if (!filed) return;
      commits.push({
        origin: h.tasks.crewFilingOrigin(filed.id)?.id,
        waitsOn: h.tasks.graph.blockers(h.taskId).map((row) => row.id),
      });
    });
    const answer = await h.spec?.onStartProgram?.({
      title: "Cap each renderer",
      goal: "Cap the result each renderer draws at 4 KiB.",
      script: TWO_PARTS,
      args: { files: ["src/meter.ts", "src/gauge.ts"] },
      bound: 2,
    });
    stopReading();
    const program = h.tasks.list().find((row) => row.shape?.program);
    expect(program).toBeDefined();
    if (!program) return;
    expect(answer).toContain(`Started program ${program.key} "Cap each renderer"`);
    expect(program).toMatchObject({ repoId: h.repo.id, parentId: null });
    expect(program.intent?.userWords).toBe(
      "cap what the meter renders; use start_program to do this",
    );
    expect(h.tasks.crewFilingOrigin(program.id)?.id).toBe(h.taskId);
    expect(h.tasks.graph.blockers(h.taskId).map((row) => row.id)).toEqual([program.id]);
    // The commit that files the program also finds it on the task, which waits on it.
    expect(commits[0]).toEqual({ origin: h.taskId, waitsOn: [program.id] });
    await h.spec?.onReport?.("Started the program that caps each renderer.");
    await h.endTurn();
    // The first mate hears the start as a program's, never as a follow-up waiting on request.
    await vi.waitFor(
      () =>
        expect(h.ops.join("\n")).toContain(
          `Programs started this turn: ${program.key} "Cap each renderer".`,
        ),
      WAIT,
    );

    await h.part(program.id, 0);
    // A part starts no program: its crewmate is not served the tool (answer "no-nesting").
    expect(h.specs[1]?.onStartProgram).toBeUndefined();
    await h.report(program.id, 0, "Capped src/meter.ts.");
    await h.report(program.id, 1, "Capped src/gauge.ts.");
    await vi.waitFor(() => expect(h.tasks.get(program.id)?.status).toBe("done"), WAIT);
    // Its end sweeps the waits at once; a later minute pass says nothing again.
    await vi.waitFor(
      () => expect(h.heard().filter((text) => text.includes("Your program"))).toHaveLength(1),
      WAIT,
    );
    await h.supervisor.watch.sweepGates(Date.now());
    await tick();
    await vi.waitFor(
      () => expect(h.heard().filter((text) => text.includes(`Your program`))).toHaveLength(1),
      WAIT,
    );
    expect(h.heard().join(" ")).toContain(`Read its result with tasks key ${program.key}`);
    expect(h.tasks.latestResult(program.id)?.value).toEqual({ value: "capped" });
    // The crewmate reads the result; the first mate hears no end of its own.
    expect(h.ops.filter((line) => line.includes(`the program on task ${program.key}`))).toEqual([]);
  });

  it("steers the bound to the crewmate that started it, which raises it and later stops another", async () => {
    const h = await started();
    await h.spec?.onStartProgram?.({
      title: "Cap each renderer",
      goal: "Cap the result each renderer draws at 4 KiB.",
      script: TWO_PARTS,
      args: { files: ["src/meter.ts", "src/gauge.ts"] },
      bound: 1,
    });
    const program = h.tasks.list().find((row) => row.shape?.program);
    if (!program) throw new Error("no program was filed");
    await h.endTurn();
    await h.report(program.id, 0, "Capped src/meter.ts.");
    await vi.waitFor(
      () =>
        expect(h.heard().some((text) => text.includes("reached its bound of 1 task() calls"))).toBe(
          true,
        ),
      WAIT,
    );
    expect(h.heard().join(" ")).toContain("raise it with start_program program and bound");
    expect(h.ops.filter((line) => line.includes("reached its bound of"))).toEqual([]);

    expect(await h.spec?.onStartProgram?.({ program: program.key, bound: 1 })).toContain(
      "give a larger whole number",
    );
    // A bound is raised only on the captain's words delivered into this turn,
    // as update_task program_bound is on the first mate's (the review's ruling).
    expect(await h.spec?.onStartProgram?.({ program: program.key, bound: 2 })).toContain(
      "raised only on the captain's words",
    );
    expect(h.tasks.get(program.id)?.shape?.program?.bound).toBe(1);
    await h.supervisor.steer.steerCrewmate(h.taskId, "Yes, it may run one more.", "captain");
    expect(await h.spec?.onStartProgram?.({ program: program.key, bound: 2 })).toContain(
      "bound is now 2",
    );
    await h.report(program.id, 1, "Capped src/gauge.ts.");
    await vi.waitFor(() => expect(h.tasks.get(program.id)?.status).toBe("done"), WAIT);

    await h.spec?.onStartProgram?.({
      title: "Audit the renderers",
      goal: "List every renderer that draws past 4 KiB.",
      script: `await task("Read src/meter.ts."); return "read";`,
      bound: 1,
    });
    const audit = h.tasks.list().find((row) => row.title === "Audit the renderers");
    if (!audit) throw new Error("no audit was filed");
    await h.spec?.onStartProgram?.({ program: audit.key, stop: true });
    expect(h.tasks.get(audit.id)?.status).toBe("dropped");
    // The record names the crewmate that stopped it, never the first mate.
    expect(
      h.tasks
        .timeline(audit.id)
        .filter((event) => (event.data as { status?: string } | null)?.status === "dropped")
        .map((event) => event.actor),
    ).toEqual(["crewmate"]);
    expect(await h.spec?.onStartProgram?.({ program: audit.key, stop: true })).toContain(
      "has already ended",
    );
  });

  it("names the branch a finished program returned on its starter's report wake, for the first mate to ship", async () => {
    const h = await started();
    await h.spec?.onStartProgram?.({
      title: "Cap the meter",
      goal: "Cap the result the meter draws at 4 KiB.",
      script: `await task("Cap src/meter.ts.", { label: "cap" }); return { branch: "cap" };`,
      bound: 1,
    });
    const program = h.tasks.list().find((row) => row.shape?.program);
    if (!program) throw new Error("no program was filed");
    await h.endTurn();
    const cap = await h.part(program.id, 0);
    await h.report(program.id, 0, "Capped src/meter.ts.");
    await vi.waitFor(() => expect(h.tasks.get(program.id)?.status).toBe("done"), WAIT);
    await vi.waitFor(
      () => expect(h.heard().some((text) => text.includes("Your program"))).toBe(true),
      WAIT,
    );
    await h.spec?.onReport?.(
      "The program capped the meter; its branch is ready to ship.",
      undefined,
      { needsFirstmate: "ship the program's branch" },
    );
    await h.endTurn();
    await vi.waitFor(
      () =>
        expect(h.ops.join("\n")).toContain(
          `${program.key} "Cap the meter" returned ${cap.key}'s last commit: work that ships it names ${cap.key} in branch_from`,
        ),
      WAIT,
    );
  });

  it("files a program from a step with no words of the captain's with none, never its title as their words (INF-1939)", async () => {
    const h = await started({
      intent: parseSpawnIntent({ goal: "Cap what the meter renders with start_program." }),
    });
    await h.spec?.onStartProgram?.({
      title: "Cap each renderer",
      goal: "Cap the result each renderer draws at 4 KiB.",
      script: TWO_PARTS,
      args: { files: ["src/meter.ts", "src/gauge.ts"] },
      bound: 2,
    });
    const program = h.tasks.list().find((row) => row.shape?.program);
    expect(program?.intent?.userWords).toBe("");
    if (!program) return;
    const part = await h.part(program.id, 0);
    expect(part.intent?.userWords).toBe("");
    expect(part.prompt.startsWith(NO_WORDS_FOR_THIS_TASK)).toBe(true);
  });

  // The captain's pick on INF-1939: "Parts get no words; each part's own goal is its ask".
  it("files each part with none of the captain's words even when the program keeps them, its own goal standing in", async () => {
    const h = await started();
    await h.spec?.onStartProgram?.({
      title: "Cap each renderer",
      goal: "Cap the result each renderer draws at 4 KiB.",
      script: TWO_PARTS,
      args: { files: ["src/meter.ts", "src/gauge.ts"] },
      bound: 2,
    });
    const program = h.tasks.list().find((row) => row.shape?.program);
    if (!program) throw new Error("the program was not filed");
    expect(program.intent?.userWords).toBe(
      "cap what the meter renders; use start_program to do this",
    );
    const part = await h.part(program.id, 0);
    expect(part.intent?.userWords).toBe("");
    expect(part.prompt.startsWith(NO_WORDS_FOR_THIS_TASK)).toBe(true);
    expect(part.prompt).not.toContain("cap what the meter renders");
  });

  it("files nothing for a missing goal, a bad script or bound, or a key it did not start", async () => {
    const h = await started();
    const before = h.tasks.list().length;
    expect(
      await h.spec?.onStartProgram?.({ title: "Cap", script: "return 1;", bound: 1 }),
    ).toContain("Give the program a title and a goal");
    expect(
      await h.spec?.onStartProgram?.({
        title: "Cap",
        goal: "Cap it.",
        script: "return 1;",
        bound: 0,
      }),
    ).toMatch(/bound/);
    expect(
      await h.spec?.onStartProgram?.({
        title: "Cap",
        goal: "Cap it.",
        script: "return (",
        bound: 1,
      }),
    ).toMatch(/script/i);
    expect(await h.spec?.onStartProgram?.({ program: h.taskId, bound: 3 })).toContain(
      "is no program your task started",
    );
    expect(h.tasks.list()).toHaveLength(before);
  });

  it("serves no start_program when the Programs runbook is off", async () => {
    const h = await started({ runbooksOff: true });
    expect(h.spec?.onStartProgram).toBeUndefined();
  });
});
