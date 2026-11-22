import { fileURLToPath } from "node:url";
import type { WorkShape } from "@shared/routingPolicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { forkChildProcess } from "../sql/forkChildProcess";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { TIMELINE_CAP } from "../tasks/timelineCompaction";
import { RepoRegistry } from "../workspace/repoRegistry";
import {
  type ProgramEnd,
  type ProgramHost,
  type ProgramPartAsk,
  ProgramRunner,
} from "./programRunner";
import { callDigest } from "./programScript";

// INF-799 piece 2, the captain's Approve and build on "Plan task-graph
// programs, typed results first": the runner evaluates the script in its own
// process, each part's result resolves the script's await, a quit replays
// the script from the task record, and a call past the proposed bound waits
// for the captain (answer "bounds", written in).

const ENTRY = fileURLToPath(new URL("./programProcess.ts", import.meta.url));
const WAIT = { timeout: 4_000, interval: 10 };
const runners: ProgramRunner[] = [];

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
});

/** A host over a real task record, filing each part as a child task. */
function harness(script: string, bound: number, partsAtOnce = 4) {
  const db = freshDatabase();
  const tasks = new TaskService({ db, repos: new RepoRegistry(db, scratchDir("program-fleet-")) });
  const shape = (extra: Partial<WorkShape>): WorkShape =>
    ({ kind: "unclear", ...extra }) as WorkShape;
  const program = seedTask(tasks, {
    id: "prog0001",
    title: "Cap the meter's rendered results",
    status: "queued",
    shape: shape({ program: { script, bound } }),
  });
  const filed: ProgramPartAsk[] = [];
  const asked: string[] = [];
  const answers: unknown[] = [];
  const bounded: number[] = [];
  let ended: (end: ProgramEnd) => void = () => {};
  const end = new Promise<ProgramEnd>((resolve) => {
    ended = resolve;
  });
  const host: ProgramHost = {
    tasks,
    spawner: forkChildProcess(ENTRY),
    filePart: (parent, part) => {
      filed.push(part);
      return seedTask(tasks, {
        id: `part000${part.call}`,
        title: part.prompt.slice(0, 64),
        status: "queued",
        parentId: parent.id,
        shape: shape({
          program_part: { call: part.call, hash: part.hash, label: part.label },
          ...(part.schema ? { result_schema: part.schema } : {}),
        }),
      });
    },
    closePart: async (id) => tasks.close(id, { status: "done", reason: "answered", actor: "host" }),
    ask: async (_program, prompt) => {
      asked.push(prompt);
      return answers.shift() ?? null;
    },
    finish: async (_program, outcome) => ended(outcome),
    bounded: (_program, calls) => bounded.push(calls),
    // Room for every part these scripts open at once, whatever this computer's processors:
    // a two-processor runner otherwise holds F4's third part forever.
    partsAtOnce,
  };
  const start = () => {
    const runner = new ProgramRunner(host);
    runners.push(runner);
    expect(runner.run(program.id)).toBeUndefined();
    return runner;
  };
  /** A part's crewmate reports and the part closes, as the supervisor does. */
  const answer = (call: number, text: string, result?: Record<string, unknown>) => {
    const part = tasks.graph
      .children(program.id)
      .find((child) => child.shape?.program_part?.call === call);
    if (!part) throw new Error(`no part for call ${call}`);
    tasks.turns.recordReport(part.id, { text, ...(result ? { declared: { result } } : {}) });
    tasks.close(part.id, { status: "done", reason: "answered", actor: "host" });
  };
  const lines = (text: string) =>
    tasks.timeline(program.id).filter((event) => event.text === text).length;
  return { tasks, program, filed, asked, answers, bounded, end, start, answer, lines, host };
}

describe("the program runner", () => {
  // INF-974: scripts choose intelligence per part, and the journal must distinguish choices.
  it("carries each level, includes it in replay identity, and preserves old calls", async () => {
    const h = harness(
      `
      for (const intelligence of ["low", "medium", "high", "premium", undefined]) {
        await task("Read the meter's result.", { intelligence });
      }
      return "read";
    `,
      5,
    );
    const first = h.start();
    for (const [call, intelligence] of ["low", "medium", "high", "premium", undefined].entries()) {
      await vi.waitFor(() => expect(h.filed).toHaveLength(call + 1), WAIT);
      expect(h.filed[call]?.intelligence).toBe(intelligence);
      if (call === 4) {
        expect(h.filed[call]?.hash).toBe(callDigest("task", ["Read the meter's result.", {}]));
        first.dispose();
        h.start();
      }
      h.answer(call, "Read the result.");
    }
    expect(await h.end).toEqual({ value: "read" });
    expect(h.filed).toHaveLength(5);
    expect(new Set(h.filed.map((part) => part.hash)).size).toBe(5);
  });

  it.each(["strong", "HIGH", "", null, 1, {}])(
    "refuses invalid intelligence %j before filing",
    async (intelligence) => {
      const h = harness(
        `return await task("Read the meter.", { intelligence: ${JSON.stringify(intelligence)} });`,
        1,
      );
      h.start();
      expect(await h.end).toEqual({
        error: "task()'s intelligence must be low, medium, high, or premium.",
      });
      expect(h.filed).toEqual([]);
    },
  );

  it("resolves each await with its part's answer and, after a quit, replays from the record without filing or asking again", async () => {
    const h = harness(
      `
      phase("find");
      const pick = await ask("Which module first?", { type: "object" });
      const found = await task("Find " + pick.module + "'s renderers.", { label: "find", schema: { type: "object" } });
      log("found " + found.files.length);
      const capped = await task("Cap " + found.files[0] + ".", { after: ["find"] });
      return { module: pick.module, capped };
      `,
      4,
    );
    h.answers.push({ module: "meter" });
    const first = h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    expect(h.filed[0]).toMatchObject({
      prompt: "Find meter's renderers.",
      label: "find",
      schema: { type: "object" },
    });
    h.answer(0, "Found one renderer.", { files: ["src/meter.ts"] });
    await vi.waitFor(() => expect(h.filed).toHaveLength(2), WAIT);
    // The later part names the earlier one it builds on, by its task.
    expect(h.filed[1]).toMatchObject({ prompt: "Cap src/meter.ts.", after: ["part0000"] });
    expect(h.lines("found 1")).toBe(1);

    // The app quits while the second part works; the next start runs it again.
    first.dispose();
    h.start();
    h.answer(1, "Capped src/meter.ts at 4 KiB.");
    expect(await h.end).toEqual({
      value: { module: "meter", capped: "Capped src/meter.ts at 4 KiB." },
    });
    expect(h.filed).toHaveLength(2);
    expect(h.asked).toEqual(["Which module first?"]);
    expect([h.lines("found 1"), h.lines("Phase: find")]).toEqual([1, 1]);
  });

  it("takes away the clock and randomness, so a replay makes the same calls", async () => {
    const h = harness(
      `
      const epoch = new Date(0).getTime();
      try { Math.random(); } catch (error) { log(error.message); }
      log("epoch " + epoch);
      return Date.now();
      `,
      1,
    );
    h.start();
    expect(await h.end).toEqual({
      error: "Date.now() is not available in a program: a replay must make the same calls.",
    });
    expect(
      h.lines("Math.random() is not available in a program: a replay must make the same calls."),
    ).toBe(1);
    expect(h.lines("epoch 0")).toBe(1);
  });

  it("holds a call past the bound, filing nothing, until the bound is raised", async () => {
    const h = harness(
      `
      const done = [];
      for (const file of ["meter.ts", "gauge.ts", "dial.ts"]) done.push(await task("Cap " + file + "."));
      return done.length;
      `,
      2,
    );
    h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    h.answer(0, "Capped meter.ts.");
    await vi.waitFor(() => expect(h.filed).toHaveLength(2), WAIT);
    h.answer(1, "Capped gauge.ts.");
    await vi.waitFor(() => expect(h.bounded).toContain(2), WAIT);
    expect(h.tasks.graph.children(h.program.id)).toHaveLength(2);
    // The captain agreed to one more; the first mate raises the bound on the captain's words.
    expect(h.tasks.updateFields(h.program.id, { programBound: 3 }, "firstmate")).toEqual([
      "bound 3",
    ]);
    await vi.waitFor(() => expect(h.filed).toHaveLength(3), WAIT);
    h.answer(2, "Capped dial.ts.");
    expect(await h.end).toEqual({ value: 3 });
  });

  // SCR-1259's diagnosis: while calls wait for a free slot, the pump runs on every task
  // write anywhere, and reading every part's record there paused the main thread at
  // hundreds of parts. It reads two counts instead, and still fills only free slots.
  it("fills free slots as parts close, counting only its parts, and reads no part's record on an unrelated write", async () => {
    const h = harness(
      `
      const capped = ["meter", "gauge", "dial", "knob"].map((file) => task("Cap " + file + "."));
      log("all four asked");
      return await Promise.all(capped);
      `,
      4,
      2,
    );
    // A task filed under the program that is not one of its parts takes no slot.
    seedTask(h.tasks, {
      id: "aside001",
      title: "Note the meter's owner",
      status: "running",
      parentId: h.program.id,
    });
    h.start();
    await vi.waitFor(() => expect(h.lines("all four asked")).toBe(1), WAIT);
    expect(h.filed).toHaveLength(2);
    const counted = vi.spyOn(h.tasks.graph, "programPartCounts");
    const children = vi.spyOn(h.tasks.graph, "children");
    const live = vi.spyOn(h.tasks.graph, "openChildren");
    const other = seedTask(h.tasks, { id: "other001", title: "Read the gauge", status: "running" });
    h.tasks.noteProgress(other.id, "Read the gauge's scale.", "crewmate");
    await vi.waitFor(() => expect(counted).toHaveBeenCalledWith(h.program.id), WAIT);
    expect(children).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(h.filed).toHaveLength(2);
    vi.restoreAllMocks();
    h.answer(0, "Capped meter.");
    await vi.waitFor(() => expect(h.filed).toHaveLength(3), WAIT);
    h.answer(1, "Capped gauge.");
    await vi.waitFor(() => expect(h.filed).toHaveLength(4), WAIT);
    h.answer(2, "Capped dial.");
    h.answer(3, "Capped knob.");
    expect(await h.end).toEqual({
      value: ["Capped meter.", "Capped gauge.", "Capped dial.", "Capped knob."],
    });
    // Each part's call number is the count of parts filed before it.
    expect(h.filed.map((part) => part.call)).toEqual([0, 1, 2, 3]);
  });

  it("refuses a label no earlier call used, and answers a dropped part with null", async () => {
    const h = harness(
      `
      let refused;
      try { await task("Cap the dial.", { after: ["nope"] }); } catch (error) { refused = error.message; }
      const dropped = await task("Cap the gauge.");
      return { refused, dropped };
      `,
      2,
    );
    h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    const part = h.tasks.graph.children(h.program.id)[0] as TaskRecord;
    h.tasks.close(part.id, { status: "dropped", reason: "superseded", actor: "firstmate" });
    expect(await h.end).toEqual({
      value: {
        refused: 'task() names "nope", which no earlier task() call of this program is labelled.',
        dropped: null,
      },
    });
  });

  // The captain's ask to eval the served shapes (INF-799 piece 3): Haiku 5.5
  // wrote this migrate script, starting its chain at from: null, and the
  // runner refused its first call.
  it("reads from: null as no earlier part, so a chain's first call starts at the default branch", async () => {
    const h = harness(
      `
      let prev = null;
      for (const s of ["settings", "checkout"]) {
        await task("Migrate the " + s + " screen to the new Button.", { label: s, from: prev });
        prev = s;
      }
      return { branch: prev };
      `,
      2,
    );
    h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    expect(h.filed[0]).not.toHaveProperty("from");
    h.answer(0, "Migrated settings.");
    await vi.waitFor(() => expect(h.filed).toHaveLength(2), WAIT);
    expect(h.filed[1]).toMatchObject({ label: "checkout", from: "part0000" });
    h.answer(1, "Migrated checkout.");
    expect(await h.end).toEqual({ value: { branch: "checkout" } });
  });

  it("replays parallel parts with default labels in a new order without filing any twice (F2)", async () => {
    const h = harness(
      `
      const capped = await Promise.all(["meter", "gauge"].map(async (name) => {
        const file = await task("Find " + name + "'s renderer.");
        return task("Cap " + file + ".");
      }));
      return capped;
      `,
      4,
    );
    const first = h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(2), WAIT);
    // The gauge's finder answers first, so its capping part is the third call.
    h.answer(1, "src/gauge.ts");
    await vi.waitFor(() => expect(h.filed).toHaveLength(3), WAIT);
    h.answer(0, "src/meter.ts");
    await vi.waitFor(() => expect(h.filed).toHaveLength(4), WAIT);
    expect(h.filed.map((part) => part.prompt).slice(2)).toEqual([
      "Cap src/gauge.ts.",
      "Cap src/meter.ts.",
    ]);

    // After a quit both finders answer at once, in call order: the meter's cap now comes third.
    first.dispose();
    h.start();
    h.answer(2, "Capped src/gauge.ts.");
    h.answer(3, "Capped src/meter.ts.");
    expect(await h.end).toEqual({ value: ["Capped src/meter.ts.", "Capped src/gauge.ts."] });
    expect(h.filed).toHaveLength(4);
  });

  it("lets a call name a part still held past the bound, linking it when both are filed (F4)", async () => {
    const h = harness(
      `
      const found = task("Find the renderers.");
      const meter = task("Cap the meter.", { label: "meter" });
      const ship = task("Ship the meter.", { from: "meter", after: ["meter"] });
      return await Promise.all([found, meter, ship]);
      `,
      1,
    );
    h.start();
    await vi.waitFor(() => expect(h.bounded).toContain(1), WAIT);
    expect(h.filed).toHaveLength(1);
    expect(h.tasks.updateFields(h.program.id, { programBound: 3 }, "firstmate")).toEqual([
      "bound 3",
    ]);
    await vi.waitFor(() => expect(h.filed).toHaveLength(3), WAIT);
    expect(h.filed[2]).toMatchObject({
      prompt: "Ship the meter.",
      from: "part0001",
      after: ["part0001"],
    });
    h.answer(0, "Found.");
    h.answer(1, "Capped.");
    h.answer(2, "Shipped.");
    expect(await h.end).toEqual({ value: ["Found.", "Capped.", "Shipped."] });
  });

  it("answers a call whose part cannot be filed, and refuses a call that names it (F10)", async () => {
    const h = harness(
      `
      let thrown;
      let cascaded;
      await Promise.all([
        task("Cap the dial.", { label: "dial" }).catch((error) => { thrown = error.message; }),
        task("Ship the dial.", { after: ["dial"] }).catch((error) => { cascaded = error.message; }),
      ]);
      return { thrown, cascaded };
      `,
      2,
    );
    h.host.filePart = () => {
      throw new Error("the project is gone");
    };
    h.start();
    expect(await h.end).toEqual({
      value: {
        thrown: "the part could not be filed: the project is gone",
        cascaded: 'task() names "dial", whose own task() call was refused.',
      },
    });
  });

  it("closes on replay a text part that reported before the quit (F7)", async () => {
    const h = harness(`return await task("Cap the meter.");`, 1);
    // Its crewmate is working on it, as a part the supervisor started.
    h.host.filePart = (parent, part) => {
      h.filed.push(part);
      return seedTask(h.tasks, {
        id: `part000${part.call}`,
        title: part.prompt,
        status: "running",
        parentId: parent.id,
        shape: {
          kind: "unclear",
          program_part: { call: part.call, hash: part.hash, label: part.label },
        } as WorkShape,
      });
    };
    const first = h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    // The part's crewmate reports and the app quits before the report closed it.
    first.dispose();
    const part = h.tasks.graph.children(h.program.id)[0] as TaskRecord;
    h.tasks.turns.recordReport(part.id, { text: "Capped the meter." });
    h.start();
    expect(await h.end).toEqual({ value: "Capped the meter." });
    expect(h.tasks.get(part.id)?.status).toBe("done");
  });

  it("writes no folded phase or log line again when other events fold the program's last lines (INF-866 K2, K3)", async () => {
    const h = harness(
      `
      phase("check");
      log("checked file 0");
      return await task("Cap the meter.");
      `,
      1,
    );
    const first = h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    first.dispose();
    // Enough other events follow that both lines fold into the compacted row.
    for (let index = 0; index < TIMELINE_CAP; index += 1)
      h.tasks.note(h.program.id, `waited ${index}`, { news: false });
    expect([h.lines("Phase: check"), h.lines("checked file 0")]).toEqual([0, 0]);
    h.start();
    h.answer(0, "Capped the meter.");
    expect(await h.end).toEqual({ value: "Capped the meter." });
    expect([h.lines("Phase: check"), h.lines("checked file 0")]).toEqual([0, 0]);
  });

  it("keeps a long program's journal and start through timeline compaction, so its replay asks and writes nothing again (INF-866 J1, K1)", async () => {
    const lines = TIMELINE_CAP + 100;
    const h = harness(
      `
      const pick = await ask("Which module first?", { type: "object" });
      for (let at = 0; at < ${lines}; at++) log("checked file " + at);
      return await task("Cap " + pick.module + ".");
      `,
      1,
    );
    h.answers.push({ module: "meter" });
    const first = h.start();
    await vi.waitFor(() => expect(h.filed).toHaveLength(1), WAIT);
    const timeline = h.tasks.timeline(h.program.id);
    expect(timeline.length).toBeLessThanOrEqual(TIMELINE_CAP);
    expect(timeline.some((event) => event.kind === "compacted")).toBe(true);
    expect(h.lines("checked file 0")).toBe(0);
    expect(h.tasks.starts.programStarted(h.program.id)).toBe(true);

    first.dispose();
    h.start();
    h.answer(0, "Capped meter.");
    expect(await h.end).toEqual({ value: "Capped meter." });
    expect(h.asked).toEqual(["Which module first?"]);
    expect(h.filed).toHaveLength(1);
    expect([h.lines("checked file 0"), h.lines(`checked file ${lines - 1}`)]).toEqual([0, 1]);
    expect(h.tasks.starts.programStarted(h.program.id)).toBe(true);
  });
});
