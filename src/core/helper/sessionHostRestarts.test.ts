import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PlacedEventRecord, PlacedSpec } from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { scriptedClaudeWorld } from "../../../tests/helpers/scriptedClaudeContract";
import {
  MODEL,
  model,
  PROVIDER,
  placed,
  runtime,
  sessionHostHooks,
  standInHome,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { createPiSessionFactory } from "../pi/sessionFactory";
import { PlacedTasks } from "./placedTasks";
import { SessionHost, type SessionHostOptions } from "./sessionHost";

sessionHostHooks();

describe("a conversation held on a computer that runs work", () => {
  it("ends a turn the computer quit in the middle of as interrupted, and tells the home once it is back", async () => {
    const at = await placed();
    await at.open();
    const report = at.home.hold("inf:work:report");
    model([{ tools: [{ name: "report", args: { text: "Never answered." } }] }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:5", task: TASK, text: "Go." }]);
    await report.reached;

    // INF-2280: Pi closure waits for callbacks already in flight. Start the
    // quit while this report is held, observe its durable interrupted end,
    // then let the callback return so shutdown can finish before restarting.
    const tasks = new PlacedTasks(at.dataDir);
    const restarting = at.restartComputer();
    try {
      await expect
        .poll(() => tasks.outbox(TASK, 0).filter((record) => record.event.type === "turn_ended"))
        .toMatchObject([{ event: { turn: 1, outcome: "interrupted" } }]);
      expect(at.home.types()).not.toContain("turn_ended");
    } finally {
      report.open();
      await restarting;
    }
    await at.ended(1);
    expect(at.home.events.at(-1)?.event).toMatchObject({
      type: "turn_ended",
      turn: 1,
      outcome: "interrupted",
    });
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks).toEqual([
      expect.objectContaining({ task: TASK, open: false, closed: false }),
    ]);
    expect(roster.tasks[0]?.running).toBeUndefined();
    // The prompt asked again after the quit is the one that started that turn.
    expect(
      await at.order("inf:session:prompt", [{ orderId: "rows:5", task: TASK, text: "Go." }]),
    ).toEqual({ turn: 1 });
    expect(at.home.events.filter((record) => record.event.type === "turn_ended")).toHaveLength(1);
  });

  // INF-151: the home's answer to events a stopped run sent can arrive after
  // the run that started next from the same folder has gone on.
  it("keeps the saved turn of the run that started next when a stopped run's events answer arrives late (INF-151)", async () => {
    const home = standInHome();
    const dir = scratchDir("infinitary-placed-late-answer-");
    const spec: PlacedSpec = {
      binding: { backend: "pi", provider: PROVIDER },
      model: { provider: PROVIDER, id: MODEL },
      thinking: { level: "off" },
      instructions: "You are a crewmate on another Mac.",
      tools: [],
    };
    const host = (ask: SessionHostOptions["ask"]) =>
      new SessionHost({
        tasks: new PlacedTasks(dir),
        ask,
        factories: { pi: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }) },
        bind: async () => ({ backend: "pi", runtime }),
        log: () => {},
      });
    // The home keeps the request that carries the first run's turn end; its
    // answer is held on the way back until that run has stopped.
    let late: Promise<unknown> | undefined;
    let reached!: () => void;
    const answerHeld = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const first = host((channel, args) => {
      const answer = home.dispatch(channel, args);
      const [{ events }] = args as [{ events?: PlacedEventRecord[] }];
      if (late || !events?.some(({ event }) => event.type === "turn_ended")) return answer;
      late = answer.then(async (kept) => {
        reached();
        await delivered;
        return kept;
      });
      return late;
    });
    const tasks = new PlacedTasks(dir);
    const next = host((channel, args) => home.dispatch(channel, args));
    model([]);
    try {
      await first.answer("inf:session:open", [{ orderId: "open:1", task: TASK, spec }]);
      await first.answer("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
      await answerHeld;
      await first.close();

      // The next run reads what the first one left, and runs a turn of its own.
      await next.answer("inf:session:open", [{ orderId: "open:2", task: TASK, spec }]);
      await next.answer("inf:session:prompt", [{ orderId: "rows:2", task: TASK, text: "On." }]);
      await expect
        .poll(() => {
          const state = tasks.state(TASK);
          return state.turn === 2 && !state.running && state.kept === state.seq;
        })
        .toBe(true);
      const saved = tasks.state(TASK);

      deliver();
      await late;
      expect(tasks.state(TASK)).toEqual(saved);
      // Nothing is lost by leaving that answer unread: the home has each event once, in order.
      expect(home.events.map(({ seq }) => seq)).toEqual(
        Array.from({ length: saved.seq }, (_, index) => index + 1),
      );
      expect(
        home.events.flatMap(({ event }) => (event.type === "turn_ended" ? [event.turn] : [])),
      ).toEqual([1, 2]);
    } finally {
      deliver();
      await late;
      await first.close();
      await next.close();
    }
  });

  // INF-2080: the home refuses every event of a task it closed, so a closed
  // conversation's events it refused once are sent at no later welcome or start.
  it("sends a closed conversation's refused events at no later welcome or start (INF-2080)", async () => {
    const home = standInHome();
    const dir = scratchDir("infinitary-placed-closed-refused-");
    const spec: PlacedSpec = {
      binding: { backend: "pi", provider: PROVIDER },
      model: { provider: PROVIDER, id: MODEL },
      thinking: { level: "off" },
      instructions: "You are a crewmate on another Mac.",
      tools: [],
    };
    // The home's record closes before it orders the conversation closed, and
    // from then on it refuses that task's events, as the real home does.
    let closedAtHome = false;
    const refused: number[][] = [];
    const ask: SessionHostOptions["ask"] = (channel, args) => {
      if (channel === "inf:work:events" && closedAtHome) {
        const [{ events }] = args as [{ events: PlacedEventRecord[] }];
        refused.push(events.map(({ seq }) => seq));
        return Promise.reject(new Error("That task is closed on this computer."));
      }
      return home.dispatch(channel, args);
    };
    const host = () =>
      new SessionHost({
        tasks: new PlacedTasks(dir),
        ask,
        factories: { pi: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }) },
        bind: async () => ({ backend: "pi", runtime }),
        log: () => {},
      });
    const tasks = new PlacedTasks(dir);
    const first = host();
    let next: SessionHost | undefined;
    // The home holds the turn's first events, so the rest wait here until it has closed.
    const gate = home.hold("inf:work:events");
    model([]);
    try {
      await first.answer("inf:session:open", [{ orderId: "open:1", task: TASK, spec }]);
      await first.answer("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
      await gate.reached;
      await expect
        .poll(() => {
          const state = tasks.state(TASK);
          return state.turn === 1 && !state.running;
        })
        .toBe(true);
      closedAtHome = true;
      await first.answer("inf:session:close", [{ orderId: "close:1", task: TASK }]);
      gate.open();
      // The refusal is answered in the same pass as its request, before this poll's next look.
      await expect.poll(() => refused.length).toBe(1);
      expect(home.types()).not.toContain("turn_ended");
      expect(refused[0]).toContain(tasks.state(TASK).seq);

      // A later welcome (`reached`, each welcome's call) sends nothing for it:
      // a send asks before `reached` returns.
      first.reached();
      expect(refused).toHaveLength(1);
      expect(tasks.outbox(TASK, tasks.state(TASK).kept)).toEqual([]);

      // Nor does the run that starts next from the same folder.
      await first.close();
      next = host();
      next.reached();
      expect(refused).toHaveLength(1);
      expect(tasks.state(TASK).closed).toBe(true);
    } finally {
      gate.open();
      await first.close();
      await next?.close();
    }
  });

  // INF-2080's other side: a refusal of an open conversation's events may
  // pass, so the next welcome sends them again.
  it("sends an open conversation's refused events again at the next welcome (INF-2080)", async () => {
    const home = standInHome();
    const dir = scratchDir("infinitary-placed-open-refused-");
    const spec: PlacedSpec = {
      binding: { backend: "pi", provider: PROVIDER },
      model: { provider: PROVIDER, id: MODEL },
      thinking: { level: "off" },
      instructions: "You are a crewmate on another Mac.",
      tools: [],
    };
    let refusing = true;
    let refusals = 0;
    const host = new SessionHost({
      tasks: new PlacedTasks(dir),
      ask: (channel, args) => {
        if (channel === "inf:work:events" && refusing) {
          refusals += 1;
          return Promise.reject(new Error("The home is not ready for this task's events yet."));
        }
        return home.dispatch(channel, args);
      },
      factories: { pi: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }) },
      bind: async () => ({ backend: "pi", runtime }),
      log: () => {},
    });
    const tasks = new PlacedTasks(dir);
    model([]);
    try {
      await host.answer("inf:session:open", [{ orderId: "open:1", task: TASK, spec }]);
      await host.answer("inf:session:prompt", [{ orderId: "rows:1", task: TASK, text: "Go." }]);
      await expect
        .poll(() => {
          const state = tasks.state(TASK);
          return state.turn === 1 && !state.running && refusals > 0;
        })
        .toBe(true);
      expect(home.types()).toEqual([]);

      refusing = false;
      host.reached();
      await expect.poll(() => home.types()).toContain("turn_ended");
      expect(home.events.map(({ seq }) => seq)).toEqual(
        Array.from({ length: tasks.state(TASK).seq }, (_, index) => index + 1),
      );
    } finally {
      await host.close();
    }
  });

  // Captain's INF-352 W1: helper shutdown/recovery must terminate its own continuation.
  it.each(["stop", "crash", "older-crash", "closed"] as const)(
    "records terminal Claude endings only for open work after %s",
    async (ending) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => held });
      const at = await placed({ claude });
      const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
      claude.answer({ text: "The background check started." });
      try {
        await at.order("inf:session:open", [{ orderId: "open:continuation", task: TASK, spec }]);
        await at.order("inf:session:prompt", [
          { orderId: "rows:continuation", task: TASK, text: "Start the background check." },
        ]);
        await at.ended(1);
        claude.answer({ tool: "note_progress", answer: "Not reached while held." });
        claude.continueTurn();
        await expect
          .poll(() => at.home.events.some(({ event }) => event.type === "tool_start"))
          .toBe(true);
        let root = at.dataDir;
        if (ending === "crash" || ending === "older-crash") {
          // The bytes already on disk before graceful shutdown model a process lost mid-call.
          root = scratchDir("infinitary-continuation-crash-");
          cpSync(join(at.dataDir, "tasks"), join(root, "tasks"), { recursive: true });
        }
        if (ending === "closed")
          await at.order("inf:session:close", [{ orderId: "close:continuation", task: TASK }]);
        await at.host().close();
        const tasks = new PlacedTasks(root);
        if (ending === "older-crash") {
          // c645fe4's helper kept the outbox boundaries without a state flag.
          tasks.writeState(TASK, { ...tasks.state(TASK), continuing: undefined });
        }
        const restart = () =>
          new SessionHost({
            tasks,
            factories: { claude: claude.factory },
            bind: async () => claude.binding,
            ask: async () => {
              throw new Error("The recovered helper has not reconnected.");
            },
            log: () => {},
          });
        const recovered = restart();
        await recovered.close();
        const events = tasks.outbox(TASK, 0);
        const terminal = events.filter(({ event }) => event.type === "continuation_ended");
        if (ending === "closed") expect(tasks.state(TASK).closed).toBe(true);
        expect(terminal).toEqual(
          ending === "closed"
            ? []
            : [
                expect.objectContaining({
                  event: {
                    type: "continuation_ended",
                    interrupted: true,
                    error: expect.any(String),
                  },
                }),
              ],
        );
        if (ending !== "closed") expect(events.at(-1)?.event).toEqual(terminal[0]?.event);
        expect(events.some(({ event }) => event.type === "tool_end")).toBe(false);
        const again = restart();
        await again.close();
        expect(
          tasks.outbox(TASK, 0).filter(({ event }) => event.type === "continuation_ended"),
        ).toHaveLength(ending === "closed" ? 0 : 1);
      } finally {
        claude.endClient();
        release();
      }
    },
  );

  // INF-284, review F4: a Claude conversation's token names no folder, and a
  // home that restarted after this computer's one-time move names the new
  // one, so nothing an open carries names the older folder; its crewmate is
  // still resumes the same conversation after its folders migrate.
  it("preserves a Claude conversation across the folder migration without injecting a compatibility notice (INF-416 L)", async () => {
    const claude = await scriptedClaudeWorld();
    const at = await placed({ claude, inOlderFolder: true });
    const spec: PlacedSpec = { ...at.spec, binding: { backend: "claude" }, model: claude.model };
    let opens = 0;
    const open = (resume?: string) => {
      opens += 1;
      return at.order("inf:session:open", [
        {
          orderId: `open:${TASK}:${opens}`,
          task: TASK,
          spec: { ...spec, ...(resume ? { resume } : {}) },
        },
      ]);
    };
    const prompt = async (turn: number, text: string) => {
      await at.order("inf:session:prompt", [{ orderId: `rows:${turn}`, task: TASK, text }]);
      await at.ended(turn);
    };
    /** The conversation's own id, as its last turn's end named it to the home. */
    const resumeToken = () => {
      const ended = at.home.events.filter((record) => record.event.type === "turn_ended").at(-1);
      return ended?.event.type === "turn_ended" ? ended.event.state?.resume : undefined;
    };
    claude.answer({ text: "On it." });
    expect((await open()).state?.backend).toBe("claude");
    await prompt(1, "Fix the footer.");
    const original = resumeToken();
    expect(original).toBeTruthy();

    await at.moveComputer();
    // As a home that restarted opens it: its instructions name no older
    // path, and its token is the conversation's id.
    await open(resumeToken());
    await prompt(2, "Fix the header too.");
    const told = claude.served().at(-1)?.said ?? "";
    expect(resumeToken()).toBe(original);
    expect(told).toContain("Fix the header too.");
    expect(told).not.toContain("Your working copy was");

    // That computer restarts: the conversation opens again, and its crewmate is not told twice.
    await at.restartComputer();
    await open(resumeToken());
    await prompt(3, "Check the footer again.");
    const later = claude.served().at(-1)?.said ?? "";
    expect(later).toContain("Check the footer again.");
    expect(resumeToken()).toBe(original);
    expect(later).not.toContain("Your working copy was");

    // A task that began after the move has nothing that moved, and is told nothing.
    const fresh = "task-after-the-move";
    await at.order("inf:session:open", [{ orderId: `open:${fresh}:1`, task: fresh, spec }]);
    await at.order("inf:session:prompt", [
      { orderId: "rows:fresh", task: fresh, text: "Start the sidebar." },
    ]);
    await expect.poll(() => claude.served().at(-1)?.said).toContain("Start the sidebar.");
    expect(claude.served().at(-1)?.said).not.toContain("Your working copy was");
  });

  it("copies the conversation's record to the home, from where its copy ends", async () => {
    const at = await placed();
    await at.open();
    model([{ text: "Recorded." }]);
    await at.order("inf:session:prompt", [{ orderId: "rows:6", task: TASK, text: "Note it." }]);
    await at.ended(1);

    const first = await at.order("inf:session:copy", [{ task: TASK, from: [] }]);
    expect(first.more).toBe(false);
    expect(first.files).toHaveLength(1);
    const [file] = first.files;
    const text = Buffer.from(file?.data ?? "", "base64").toString("utf8");
    expect(text).toContain("Note it.");
    expect(file?.size).toBe(Buffer.byteLength(text));

    const again = await at.order("inf:session:copy", [
      { task: TASK, from: [{ name: file?.name ?? "", offset: file?.size ?? 0 }] },
    ]);
    expect(again).toEqual({ files: [], more: false });
  });

  it("closes a conversation for good when the home closes the record", async () => {
    const at = await placed();
    await at.open();
    expect(await at.order("inf:session:close", [{ orderId: "close:1", task: TASK }])).toEqual({
      ok: true,
    });
    await expect(at.open()).rejects.toThrow("opens no more");
    const roster = await at.order("inf:session:roster", []);
    expect(roster.tasks).toEqual([expect.objectContaining({ task: TASK, closed: true })]);
  });

  // INF-3447's piece 1 and its review: the close order runs the sweep of what
  // the task left running there once, with the start time and the carrying
  // task the home sent, and answers its report for the home's timeline.
  it("sweeps what a closed task left running there once, with the home's start time, and answers the report", async () => {
    const report = {
      stops: [{ label: "scratch machine", outcome: "ran" as const }],
      programs: [{ pid: 4242, name: "qemu-system-aarch64", outcome: "ended" as const }],
      holders: "checked" as const,
    };
    const leftovers = vi.fn(async () => report);
    const at = await placed({ leftovers });
    await at.open();
    const close = {
      orderId: "close:1",
      task: TASK,
      startedAt: 1_794_000_000_000,
      carriedTo: { task: "t-next", key: "INF-9" },
    };
    expect(await at.order("inf:session:close", [close])).toEqual({ ok: true, leftovers: report });
    expect(leftovers).toHaveBeenCalledWith(TASK, close);
    // Asked again, the close is already done there and sweeps nothing more.
    expect(await at.order("inf:session:close", [{ ...close, orderId: "close:2" }])).toEqual({
      ok: true,
    });
    expect(leftovers).toHaveBeenCalledTimes(1);
  });

  it("removes a closed conversation's folder for the home only once its working copy is gone, and answers the same when asked again", async () => {
    const at = await placed({ copies: true });
    const work = join(at.dataDir, "worktrees", TASK);
    mkdirSync(work, { recursive: true });
    await at.open();
    const folder = join(at.dataDir, "tasks", TASK);
    const remove = (orderId: string) => at.order("inf:session:remove", [{ orderId, task: TASK }]);
    await expect(remove("remove:1")).rejects.toThrow("still open here");
    await at.order("inf:session:close", [{ orderId: "close:1", task: TASK }]);
    await expect(remove("remove:2")).rejects.toThrow("working copy is still here");
    expect(existsSync(folder)).toBe(true);

    // The working copy retired, the folder goes, and nothing writes it again.
    rmSync(work, { recursive: true });
    expect(await remove("remove:3")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
    expect((await at.order("inf:session:roster", [])).tasks).toEqual([]);
    expect(await remove("remove:3")).toEqual({ ok: true });
    expect(existsSync(folder)).toBe(false);
  });
});
