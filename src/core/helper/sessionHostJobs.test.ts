import type { PlacedSpec } from "@shared/work";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { scriptedClaudeWorld } from "../../../tests/helpers/scriptedClaudeContract";
import {
  api,
  model,
  placed,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import type { ClientBackgroundTask } from "../session/session";
import { crewmateTool } from "../session/tools";
import { PlacedTasks } from "./placedTasks";
import type { SessionHost } from "./sessionHost";

/**
 * A crewmate's conversation held on a computer that runs work
 * (`tests/helpers/sessionHostWorld.ts`): background jobs and Claude background tasks, and the ends the home is told.
 */

sessionHostHooks();

describe("a conversation held on a computer that runs work", () => {
  it("tells the home when a job the crewmate's shell started there ends", async () => {
    const at = await placed();
    await at.open();
    at.host().jobExit({
      jobId: "job1",
      ownerId: TASK,
      command: "pnpm test",
      exitCode: 0,
      durationMs: 1200,
      tail: "passed",
    });
    await expect
      .poll(() => at.home.effects.map((effect) => effect.channel))
      .toEqual(["inf:work:job-exit"]);
    expect(at.home.effects[0]).toMatchObject({
      callId: "job:job1",
      request: { task: TASK, exit: { jobId: "job1", exitCode: 0, tail: "passed" } },
    });
  });

  // Intent: INF-416 piece A (audit R6): a cut-off knowledge write is safe to
  // ask again on the work computer, as the home already treats it, instead of
  // reading as though the change may already be done.
  it("calls a cut-off knowledge write safe to ask again (INF-416 A)", async () => {
    const controller = new AbortController();
    const at = await placed({ toolSignal: controller.signal });
    await at.order("inf:session:open", [
      {
        orderId: `open:${TASK}:1`,
        task: TASK,
        spec: { ...at.spec, tools: [...at.spec.tools, "record_knowledge"] },
      },
    ]);
    const knowledge = at.home.hold("inf:work:record-knowledge");
    model([
      {
        tools: [
          {
            name: "record_knowledge",
            args: {
              action: "publish",
              request_id: "cut-off-1",
              kind: "concept",
              title: "Idle ladder",
              text: "How an idle crewmate is nudged.",
            },
          },
        ],
      },
      { text: "Asked again." },
    ]);
    const from = api.requests.length;
    try {
      await at.order("inf:session:prompt", [
        { orderId: "knowledge-cut", task: TASK, text: "Save it." },
      ]);
      await knowledge.reached;
      controller.abort(new Error("Claude stopped waiting"));
      await expect
        .poll(() =>
          JSON.stringify(api.requests.slice(from).map((request) => request.body.messages)),
        )
        .toContain("You can ask again");
      const transcript = JSON.stringify(
        api.requests.slice(from).map((request) => request.body.messages),
      );
      expect(transcript).not.toContain("may already be done");
      console.info("Cut-off knowledge write:", transcript.slice(-500));
      knowledge.open();
      await at.ended(1);
    } finally {
      knowledge.open();
    }
  });

  // Intent: INF-389, review INF-381's I1 on PR #66: a job's end is its own
  // fact, not part of the tool it ran under, so a cancelled tool never
  // withdraws the end its crewmate waits for.
  it("tells the home a job's end that arrives in a cancelled tool's scope, and forgets its row only once the home answers (INF-389)", async () => {
    const controller = new AbortController();
    let exits!: () => void;
    const exited = new Promise<void>((resolve) => {
      exits = resolve;
    });
    let host: () => SessionHost = () => {
      throw new Error("No conversation was opened.");
    };
    // A tool that starts a job here and then asks the home: the job's end
    // arrives on a callback registered inside the tool, as a spawned
    // child's close does.
    const startJob = crewmateTool({
      name: "start_job",
      label: "Start a job",
      description: "Start a background job and note it.",
      parameters: Type.Object({}),
      bind: (delegate) => {
        const onProgress = delegate.onProgress;
        if (!onProgress) return undefined;
        return async (_params, signal) => {
          void exited.then(() =>
            host().jobExit({
              jobId: "9b2e4f61",
              ownerId: TASK,
              command: "pnpm test:ios",
              exitCode: 0,
              durationMs: 95_000,
              tail: "Test Suites: 12 passed",
            }),
          );
          await (signal
            ? onProgress("Started pnpm test:ios in the background.", undefined, signal)
            : onProgress("Started pnpm test:ios in the background."));
          return { text: "Started." };
        };
      },
    });
    const at = await placed({ toolSignal: controller.signal, tools: [startJob] });
    host = at.host;
    await at.open();
    const progress = at.home.hold("inf:work:progress");
    const told = at.home.hold("inf:work:job-exit");
    const tasks = new PlacedTasks(at.dataDir);
    model([{ tools: [{ name: "start_job", args: {} }] }, { text: "Waiting for the job." }]);
    try {
      await at.order("inf:session:prompt", [
        { orderId: "job-in-tool", task: TASK, text: "Run the iOS tests." },
      ]);
      await progress.reached;
      controller.abort(new Error("Claude stopped waiting"));
      await at.ended(1);
      exits();
      await expect
        .poll(() => at.home.asked.some((ask) => ask.callId === "job:9b2e4f61"))
        .toBe(true);
      expect(tasks.jobs(TASK).map((job) => job.id)).toEqual(["9b2e4f61"]);
      told.open();
      await expect.poll(() => tasks.jobs(TASK)).toEqual([]);
      expect(
        at.home.effects
          .filter((effect) => effect.channel === "inf:work:job-exit")
          .map((effect) => effect.request.exit),
      ).toEqual([
        {
          jobId: "9b2e4f61",
          command: "pnpm test:ios",
          exitCode: 0,
          durationMs: 95_000,
          tail: "Test Suites: 12 passed",
        },
      ]);
    } finally {
      progress.open();
      told.open();
    }
  });

  // INF-367: a restart here tells the home of each background job's end it
  // had not told, once, so the crewmate never waits for an exit that cannot
  // arrive.
  it("tells the home once of each job end its last run left untold - a job its stop killed, one its end left unmarked, and an exit the home had not answered - asking again under the job's id when it stops again before the home answers (INF-367)", async () => {
    const at = await placed();
    await at.open();
    const told = at.home.hold("inf:work:job-exit");
    const asks = (id: string) => at.home.asked.filter((ask) => ask.callId === `job:${id}`).length;
    // The rows a run keeps while its jobs run (`JobManager`): its stop marks
    // the one it kills, and an end without its stop leaves the other as is.
    const tasks = new PlacedTasks(at.dataDir);
    const startedAt = Date.now() - 20 * 60_000;
    tasks.jobRows.add({ id: "45d291d9", ownerId: TASK, command: "pnpm test:ios", startedAt });
    tasks.jobRows.add({ id: "5e1f0c2a", ownerId: TASK, command: "pnpm build", startedAt });
    tasks.jobRows.markStoppedByQuit("45d291d9", TASK, startedAt + 12 * 60_000);
    // A third job exits now, and the home is slow to answer.
    at.host().jobExit({
      jobId: "7c3a9e10",
      ownerId: TASK,
      command: "pnpm lint",
      exitCode: 0,
      durationMs: 4_000,
      tail: "clean",
    });
    await expect.poll(() => asks("7c3a9e10")).toBe(1);

    await at.restartComputer();
    await expect
      .poll(() => [asks("45d291d9"), asks("5e1f0c2a"), asks("7c3a9e10")])
      .toEqual([1, 1, 2]);
    // Stopped again before the home answered: every row stays for the next start.
    await at.restartComputer();
    expect(tasks.jobs(TASK).map((job) => job.id)).toEqual(["45d291d9", "5e1f0c2a", "7c3a9e10"]);
    told.open();
    await expect.poll(() => tasks.jobs(TASK)).toEqual([]);
    expect(asks("45d291d9")).toBeGreaterThan(1);
    expect(asks("5e1f0c2a")).toBeGreaterThan(1);
    const heard = at.home.effects
      .filter((effect) => effect.channel === "inf:work:job-exit")
      .map((effect) => effect.request.exit as { jobId: string })
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
    expect(heard).toEqual([
      {
        jobId: "45d291d9",
        command: "pnpm test:ios",
        exitCode: null,
        durationMs: 12 * 60_000,
        tail: "",
        interrupted: "quit",
      },
      {
        jobId: "5e1f0c2a",
        command: "pnpm build",
        exitCode: null,
        durationMs: 0,
        tail: "",
        interrupted: "crash",
      },
      { jobId: "7c3a9e10", command: "pnpm lint", exitCode: 0, durationMs: 4_000, tail: "clean" },
    ]);
  });

  // INF-379: a Claude conversation's background work runs inside its
  // client, which this computer's stop ends with it; only what the client
  // still ran then is told, once, at the next start.
  it("keeps a row for each background task a Claude client runs, none for one it finished or once its client ended, and tells the home once at the next start that the stop ended the rest (INF-379)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    const tasks = new PlacedTasks(at.dataDir);
    const rows = () => tasks.jobs(TASK).map(({ id, command }) => ({ id, command }));
    const told = () => at.home.effects.filter((effect) => effect.channel === "inf:work:job-exit");
    const suite = { id: "bybac1mss", description: "Run the long suite" };
    const lint = { id: "b7rk2q0zt", description: "Lint the project" };
    try {
      claude.answer({ text: "Both run in the background." });
      await at.order("inf:session:open", [{ orderId: "open:tasks", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        {
          orderId: "rows:tasks",
          task: TASK,
          text: "Run the suite and the lint in the background.",
        },
      ]);
      await at.ended(1);
      claude.listBackgroundTasks([suite, lint]);
      await expect.poll(rows).toEqual([
        { id: suite.id, command: suite.description },
        { id: lint.id, command: lint.description },
      ]);
      // The lint finished: the client tells its own model, and its row goes.
      claude.listBackgroundTasks([suite]);
      await expect.poll(rows).toEqual([{ id: suite.id, command: suite.description }]);
      // The home hears how many, as before, and nothing of the tasks themselves
      // (the client's attach says it runs none it knows of yet).
      await expect
        .poll(() =>
          at.home.events.flatMap(({ event: { type, ...said } }) =>
            type === "background_work_changed" ? [said] : [],
          ),
        )
        .toEqual([{}, { count: 2 }, { count: 1 }]);
      expect(told()).toEqual([]);

      await at.restartComputer();
      await expect.poll(rows).toEqual([]);
      expect(told().map((effect) => effect.request.exit)).toEqual([
        {
          jobId: suite.id,
          command: suite.description,
          exitCode: null,
          durationMs: expect.any(Number),
          tail: "",
          interrupted: "quit",
        },
      ]);

      // A client that ends while this computer runs on takes its tasks with
      // it: the home hears that at once (INF-405), and no row is left for a
      // later start to tell as cut off.
      claude.answer({ text: "The suite runs again." });
      await at.order("inf:session:open", [{ orderId: "open:tasks:2", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        { orderId: "rows:tasks:2", task: TASK, text: "Run the suite again." },
      ]);
      await at.ended(2);
      claude.listBackgroundTasks([{ id: "bq4w8n1xe", description: "Run the long suite" }]);
      await expect.poll(rows).toEqual([{ id: "bq4w8n1xe", command: "Run the long suite" }]);
      claude.endClient();
      await expect.poll(rows).toEqual([]);
      await at.restartComputer();
      await at.inReach();
      expect(
        told().map((effect) => (effect.request.exit as { interrupted?: string }).interrupted),
      ).toEqual(["quit", "client"]);
    } finally {
      claude.endClient();
    }
  });

  // INF-2332 (FIRS-6), captain: "make sure we delete unnecessary state
  // tracking to honor the source of truth principle". Whether the
  // conversation works is read from the live session, so a turn - a
  // prompt's, or one Claude carries on by itself - keeps its conversation
  // through a reopen for new instructions and a home's detach, and the open's
  // answer says it still streams. The home asks again once the turn ends,
  // and that answer carries the conversation that started over for them.
  it.each(["carried-on", "prompt"] as const)(
    "keeps a conversation in a %s turn through a reopen and a detach, answering that it streams, and starts over for the reopen asked again once it ends (INF-2332)",
    async (turn) => {
      const claude = await scriptedClaudeWorld();
      const at = await placed({ claude });
      const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
      const reports = at.home.hold("inf:work:report");
      const report = {
        tool: "report" as const,
        args: { text: "All 29 tests passed." },
        answer: "Reported.",
      };
      try {
        await at.order("inf:session:open", [{ orderId: "open:1", task: TASK, spec }]);
        if (turn === "carried-on") {
          claude.answer({ text: "The check runs in the background." });
          await at.order("inf:session:prompt", [
            { orderId: "prompt:1", task: TASK, text: "Run the check in the background." },
          ]);
          await at.ended(1);
          // The background check finishes and Claude carries on to report
          // it, waiting on the home's answer.
          claude.answer(report);
          claude.continueTurn();
        } else {
          claude.answer(report);
          await at.order("inf:session:prompt", [
            { orderId: "prompt:1", task: TASK, text: "Run the check and report it." },
          ]);
        }
        await reports.reached;

        const moved = { ...spec, instructions: `${spec.instructions} Updated.` };
        const kept = await at.order("inf:session:open", [
          { orderId: "open:2", task: TASK, spec: moved },
        ]);
        expect(kept.state.streaming).toBe(true);
        expect(kept.state.renewal).toBeUndefined();
        await at.order("inf:session:detach", [{ orderId: "detach:1", task: TASK }]);
        expect(claude.released()).toBe(false);

        reports.open();
        const end = turn === "carried-on" ? "continuation_ended" : "turn_ended";
        await expect.poll(() => at.home.events.some(({ event }) => event.type === end)).toBe(true);
        expect(
          at.home.effects.filter((effect) => effect.channel === "inf:work:report"),
        ).toHaveLength(1);
        if (turn === "carried-on")
          expect(at.home.events.find(({ event }) => event.type === end)?.event).toEqual({
            type: end,
          });

        // Ended, the home's open asked again starts over for the moved
        // instructions, and its answer says so.
        const again = await at.order("inf:session:open", [
          { orderId: "open:3", task: TASK, spec: { ...moved, resume: kept.state.resume } },
        ]);
        expect(claude.released()).toBe(true);
        expect(again.state.streaming).toBe(false);
        expect(again.state.renewal).toMatchObject({ from: kept.state.sessionId });
        claude.answer({ text: "Under the new instructions." });
        await at.order("inf:session:prompt", [
          { orderId: "prompt:2", task: TASK, text: "Carry on." },
        ]);
        await expect
          .poll(() => claude.served().at(-1)?.system)
          .toContain(`${spec.instructions} Updated.`);
      } finally {
        reports.open();
        claude.endClient();
      }
    },
  );

  // INF-405: a Claude client this computer lets go of while it runs on - for
  // the home's detach (its quit or restart), or to reopen the conversation
  // for a contract it now speaks - ends with the background tasks it still
  // ran, and the crewmate must never wait on them. A close ends the task, so
  // it tells nothing.
  it("tells the home once that a Claude client's background tasks ended with it when this computer let it go while running on, asking again after a restart until the home answers, and tells nothing at a close (INF-405)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    const tasks = new PlacedTasks(at.dataDir);
    const rows = () =>
      tasks.jobs(TASK).map(({ id, exit }) => (exit ? { id, ended: exit.interrupted } : { id }));
    const told = () =>
      at.home.effects
        .filter((effect) => effect.channel === "inf:work:job-exit")
        .map((effect) => effect.request.exit);
    const asks = (id: string) => at.home.asked.filter((ask) => ask.callId === `job:${id}`).length;
    const endedWithClient = (id: string, description: string) => ({
      jobId: id,
      command: description,
      exitCode: null,
      durationMs: expect.any(Number),
      tail: "",
      interrupted: "client",
    });
    const running = async (round: number, instructions: string, task: ClientBackgroundTask) => {
      claude.answer({ text: "It runs in the background." });
      await at.order("inf:session:open", [
        { orderId: `open:${round}`, task: TASK, spec: { ...spec, instructions } },
      ]);
      await at.order("inf:session:prompt", [
        { orderId: `prompt:${round}`, task: TASK, text: "Run it in the background." },
      ]);
      await at.ended(round);
      claude.listBackgroundTasks([task]);
      await expect.poll(rows).toEqual([{ id: task.id }]);
    };
    const suite = { id: "bybac1mss", description: "Run the long suite" };
    const build = { id: "b2kq7d0wa", description: "Build the app" };
    const lint = { id: "b7rk2q0zt", description: "Lint the project" };
    const answers = at.home.hold("inf:work:job-exit");
    try {
      // The home's detach ends the idle client: the home is asked at once,
      // and the row keeps the client's end until it answers.
      await running(1, spec.instructions, suite);
      await at.order("inf:session:detach", [{ orderId: "detach:1", task: TASK }]);
      await answers.reached;
      expect(rows()).toEqual([{ id: suite.id, ended: "client" }]);
      // A restart before the home answered asks again under the same id.
      await at.restartComputer();
      await expect.poll(() => asks(suite.id)).toBe(2);
      answers.open();
      await expect.poll(rows).toEqual([]);
      expect(told()).toEqual([endedWithClient(suite.id, suite.description)]);

      // A reopen for new instructions lets go of the idle client too.
      await running(2, spec.instructions, build);
      await at.order("inf:session:open", [
        {
          orderId: "open:reopen",
          task: TASK,
          spec: { ...spec, instructions: `${spec.instructions} Its contract moved.` },
        },
      ]);
      await expect.poll(rows).toEqual([]);
      expect(told()).toEqual([
        endedWithClient(suite.id, suite.description),
        endedWithClient(build.id, build.description),
      ]);

      // A close ends the task: its tasks go untold, and no row is left.
      await running(3, `${spec.instructions} Its contract moved.`, lint);
      await at.order("inf:session:close", [{ orderId: "close:1", task: TASK }]);
      expect(rows()).toEqual([]);
      await at.restartComputer();
      expect(told()).toHaveLength(2);
    } finally {
      answers.open();
      claude.endClient();
    }
  });

  // INF-405: a home on a contract before `CLIENT_JOB_ENDS_SINCE` reads only
  // the ends it knows, so it hears a client's as an ordinary end, never one
  // its contract refuses (docs/contract.md).
  it("tells a home on an older contract a Claude client's ended task as an ordinary end, with no reason it cannot read (INF-405)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude, homeVersion: "9.1.0" });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    const tasks = new PlacedTasks(at.dataDir);
    try {
      claude.answer({ text: "The suite runs in the background." });
      await at.order("inf:session:open", [{ orderId: "open:older", task: TASK, spec }]);
      await at.order("inf:session:prompt", [
        { orderId: "prompt:older", task: TASK, text: "Run the suite in the background." },
      ]);
      await at.ended(1);
      claude.listBackgroundTasks([{ id: "bybac1mss", description: "Run the long suite" }]);
      await expect.poll(() => tasks.jobs(TASK).length).toBe(1);
      await at.order("inf:session:detach", [{ orderId: "detach:older", task: TASK }]);
      await expect.poll(() => tasks.jobs(TASK)).toEqual([]);
      expect(
        at.home.effects
          .filter((effect) => effect.channel === "inf:work:job-exit")
          .map((effect) => effect.request.exit),
      ).toEqual([
        {
          jobId: "bybac1mss",
          command: "Run the long suite",
          exitCode: null,
          durationMs: expect.any(Number),
          tail: "",
        },
      ]);
    } finally {
      claude.endClient();
    }
  });
});
