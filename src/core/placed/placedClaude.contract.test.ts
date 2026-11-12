import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { PI_CONTRACT_MODEL, piContractWorld } from "../../../tests/helpers/piContractWorld";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import {
  placedContractCleanup,
  placedContractWorld,
} from "../../../tests/helpers/placedContractWorld";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import {
  CONTRACT_TOOL,
  CREWMATE_TASK,
  describeSessionContract,
  startContractApi,
} from "../../../tests/helpers/sessionContract";
import { runningCalls } from "../../renderer/src/cards/crewmateState";
import { PROTOCOL_VERSION } from "../../shared/ipc";
import { type WorkOrderResponse, workOrders } from "../../shared/work";
import { createCrewmateTranscriptResolver } from "../observe/transcriptSource";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { crewmateSessionsDir } from "../paths";
import { boundTool } from "../session/tools";
import { CrewTranscripts } from "../tasks/crewTranscript";

/**
 * The session contract for a crewmate's conversation held on a computer that
 * runs work (`placedContractWorld`): Claude's factory on the scripted client,
 * held by the computer's `SessionHost` and driven from the home's
 * `PlacedSessions` over the real connection. A placed conversation is only
 * ever a crewmate's, so the crewmate's cases are the ones it passes.
 */

/**
 * Every folder listing, file-size read and file read made through node:fs
 * or node:fs/promises, told to a case that listens (INF-3705, INF-3719);
 * every other case reads straight through. A read of an open file is told
 * by the path it was opened at, with the bytes it took.
 */
type FsRead = "list" | "stat" | "exists" | "open" | "read" | "link";
const fsReads = vi.hoisted(() => {
  const reads = {
    listen: undefined as ((kind: FsRead, path: string, bytes?: number) => void) | undefined,
    /** The path each open file descriptor was opened at. */
    opened: new Map<number, string>(),
    /** `fn` reading through, telling the listener after; `native` stays reachable. */
    told<F extends (...args: never[]) => unknown>(kind: FsRead, fn: F, counted?: boolean): F {
      const wrapped = ((...args: never[]) => {
        const result = fn(...args);
        const path = String(args[0]);
        const bytes = (value: unknown) =>
          !counted
            ? undefined
            : typeof value === "string"
              ? Buffer.byteLength(value)
              : (value as Buffer).length;
        if (result instanceof Promise)
          void result.then(
            (value) => reads.listen?.(kind, path, bytes(value)),
            () => {},
          );
        else reads.listen?.(kind, path, bytes(result));
        return result;
      }) as unknown as F;
      return Object.assign(wrapped, fn);
    },
  };
  return reads;
});

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    fsReads.opened.set(fd, String(args[0]));
    fsReads.listen?.("open", String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const readSync = ((fd: number, ...rest: unknown[]) => {
    const read = (actual.readSync as (...args: unknown[]) => number)(fd, ...rest);
    fsReads.listen?.("read", fsReads.opened.get(fd) ?? `fd:${fd}`, read);
    return read;
  }) as typeof actual.readSync;
  return {
    ...actual,
    readdirSync: fsReads.told("list", actual.readdirSync),
    statSync: fsReads.told("stat", actual.statSync),
    lstatSync: fsReads.told("stat", actual.lstatSync),
    existsSync: fsReads.told("exists", actual.existsSync),
    accessSync: fsReads.told("exists", actual.accessSync),
    readFileSync: fsReads.told("read", actual.readFileSync, true),
    readlinkSync: fsReads.told("link", actual.readlinkSync),
    realpathSync: fsReads.told("link", actual.realpathSync),
    openSync,
    readSync,
  };
});

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: fsReads.told("list", actual.readdir),
    stat: fsReads.told("stat", actual.stat),
    lstat: fsReads.told("stat", actual.lstat),
    access: fsReads.told("exists", actual.access),
    readFile: fsReads.told("read", actual.readFile, true),
    readlink: fsReads.told("link", actual.readlink),
    realpath: fsReads.told("link", actual.realpath),
    open: fsReads.told("open", actual.open),
  };
});

afterEach(async () => {
  fsReads.listen = undefined;
  await placedContractCleanup();
  await scriptedClaudeCleanup();
});

// INF-40 / review F1: a Claude prompt has many tool steps but only one turn_end.
it("shows a placed Claude tool result in the Crewmate tab before its prompt ends", async () => {
  const inner = await scriptedClaudeWorld();
  const world = await placedContractWorld(inner);
  const { tasks, paths } = world.placement;
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      {
        taskId: CREWMATE_TASK,
        machineId: world.machine,
        cwd: world.homeDir,
        model: world.model,
      },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => {
          inner.answer("hang");
          return { text: "Looked up." };
        },
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  inner.answer({ tool: CONTRACT_TOOL, answer: "Not reached while held." });
  const asking = session.prompt("Read the footer on Mac mini.");
  try {
    await expect.poll(() => inner.served().length).toBe(2);
    // The client serves its next request in the computer's own process, and
    // tool_end reaches the home over the connection after that, so wait for
    // the home to hear it (INF-435).
    await expect.poll(() => events).toContain("tool_end");
    expect(events).not.toContain("turn_end");
    const recordDirOf = (id: string) => crewmateSessionsDir(paths, id);
    const resolver = createCrewmateTranscriptResolver({
      recordDirOf,
      backendOf: () => undefined,
      configDirOf: () => undefined,
    });
    const reader = new CrewTranscripts({
      recordDirOf,
      currentSession: (task) => resolver(task).path,
    });
    const read = () => {
      const task = tasks.get(CREWMATE_TASK);
      if (!task) throw new Error("The placed Claude task is missing.");
      return reader.of(task, tasks.timeline(CREWMATE_TASK), false);
    };
    await expect
      .poll(() => read().lines.some((line) => line.kind === "tool" && line.result !== null), {
        timeout: 5_000,
      })
      .toBe(true);
    expect(session.isStreaming()).toBe(true);
    expect(events).not.toContain("turn_end");
  } finally {
    await session.abort();
    await asking;
    session.dispose();
    await session.closed();
  }
});

// INF-40 / review G1: a long check must appear while its tool is still running.
it("shows a placed Claude call as running before its tool_end", async () => {
  let startTool!: () => void;
  const beforeTool = new Promise<void>((resolve) => {
    startTool = resolve;
  });
  let finishTool!: () => void;
  const toolHeld = new Promise<void>((resolve) => {
    finishTool = resolve;
  });
  const inner = await scriptedClaudeWorld({ beforeTool: () => beforeTool });
  const world = await placedContractWorld(inner);
  const { tasks, paths } = world.placement;
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      {
        taskId: CREWMATE_TASK,
        machineId: world.machine,
        cwd: world.homeDir,
        model: world.model,
      },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => {
          await toolHeld;
          return { text: "Looked up." };
        },
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  const recordDirOf = (id: string) => crewmateSessionsDir(paths, id);
  const resolver = createCrewmateTranscriptResolver({
    recordDirOf,
    backendOf: () => undefined,
    configDirOf: () => undefined,
  });
  const reader = new CrewTranscripts({
    recordDirOf,
    currentSession: (task) => resolver(task).path,
  });
  const read = () => {
    const task = tasks.get(CREWMATE_TASK);
    if (!task) throw new Error("The placed Claude task is missing.");
    return reader.of(task, tasks.timeline(CREWMATE_TASK), false);
  };
  inner.answer({ tool: CONTRACT_TOOL, answer: "The check finished." });
  const asking = session.prompt("Run the long footer check on Mac mini.");
  try {
    // First let request_started's copy finish without a call in it.
    await expect.poll(() => read().lines.some((line) => line.kind === "brief")).toBe(true);
    expect(read().lines.some((line) => line.kind === "tool")).toBe(false);
    startTool();
    await expect.poll(() => events.includes("tool_start")).toBe(true);
    await expect
      .poll(() => read().lines.some((line) => line.kind === "tool" && line.result === null), {
        timeout: 3_000,
      })
      .toBe(true);
    expect(events).not.toContain("tool_end");
    expect(session.isStreaming()).toBe(true);
    const call = read().lines.find((line) => line.kind === "tool");
    expect(call).toBeDefined();
    expect(runningCalls(read().lines, session.isStreaming())).toContain(call?.id);
  } finally {
    startTool();
    finishTool();
    await asking;
    session.dispose();
    await session.closed();
  }
});

// INF-40 / review H1 and INF-341 F1/G1: owner endings stop repeats but preserve the final tail.
it.each([
  "tool-end",
  "turn-end",
  "release",
  "continuation-end",
  "continuation-failure",
  "continuation-complete",
] as const)("copies a delayed call while open and stops the loop at %s", async (ending) => {
  let now = 0;
  const scheduled = new Set<{ due: number; run: () => void }>();
  const schedule = (ms: number, run: () => void) => {
    expect(scheduled.size).toBe(0);
    const timer = { due: now + ms, run };
    scheduled.add(timer);
    return () => {
      scheduled.delete(timer);
    };
  };
  const fireNext = () => {
    const timer = scheduled.values().next().value;
    if (!timer) return;
    scheduled.delete(timer);
    now = Math.max(now, timer.due);
    timer.run();
  };
  let startTool!: () => void;
  const beforeTool = new Promise<void>((resolve) => {
    startTool = resolve;
  });
  let writeTool!: () => void;
  const beforeRecord = new Promise<void>((resolve) => {
    writeTool = resolve;
  });
  let finishTool!: () => void;
  const held = new Promise<void>((resolve) => {
    finishTool = resolve;
  });
  const inner = await scriptedClaudeWorld({
    beforeTool: () => beforeTool,
    beforeToolRecord: () => beforeRecord,
  });
  const world = await placedContractWorld(inner, { now: () => now, schedule });
  const { tasks, paths, devices } = world.placement;
  const ask = devices.ask.bind(devices);
  const copiedAt: number[] = [];
  let copying = 0;
  const sent = vi.spyOn(devices, "ask").mockImplementation(async (device, channel, args) => {
    if (channel === "inf:session:copy") copying += 1;
    try {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") copiedAt.push(now);
      return answer;
    } finally {
      if (channel === "inf:session:copy") copying -= 1;
    }
  });
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      {
        taskId: CREWMATE_TASK,
        machineId: world.machine,
        cwd: world.homeDir,
        model: world.model,
      },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => {
          inner.answer("hang");
          await held;
          return { text: "Looked up." };
        },
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  const recordDirOf = (id: string) => crewmateSessionsDir(paths, id);
  const resolver = createCrewmateTranscriptResolver({
    recordDirOf,
    backendOf: () => undefined,
    configDirOf: () => undefined,
  });
  const reader = new CrewTranscripts({
    recordDirOf,
    currentSession: (task) => resolver(task).path,
  });
  const read = () => {
    const task = tasks.get(CREWMATE_TASK);
    if (!task) throw new Error("The placed Claude task is missing.");
    return reader.of(task, tasks.timeline(CREWMATE_TASK), false);
  };
  const continuation =
    ending === "continuation-end" ||
    ending === "continuation-failure" ||
    ending === "continuation-complete";
  if (continuation) {
    inner.answer({ text: "The background check started." });
    await session.prompt("Start the footer check in the background.");
    events.length = 0;
  }
  inner.answer({ tool: CONTRACT_TOOL, answer: "The check finished." });
  if (continuation) inner.continueTurn();
  const asking = continuation
    ? Promise.resolve()
    : session.prompt("Run the long footer check on Mac mini.");
  try {
    await expect
      .poll(() => {
        fireNext();
        return read().lines.some((line) => line.kind === "brief");
      })
      .toBe(true);
    const copiesBeforeTool = copiedAt.length;
    startTool();
    await expect.poll(() => events.includes("tool_start")).toBe(true);
    // Let the tool_start copy read the file before the client writes its call.
    await expect
      .poll(
        () => {
          fireNext();
          return copiedAt.length;
        },
        { timeout: 3_000 },
      )
      .toBe(copiesBeforeTool + 1);
    expect(read().lines.some((line) => line.kind === "tool")).toBe(false);
    writeTool();
    await expect
      .poll(
        () => {
          fireNext();
          return read().lines.some((line) => line.kind === "tool" && line.result === null);
        },
        { timeout: 3_000 },
      )
      .toBe(true);
    expect(events).not.toContain("tool_end");
    expect(events).not.toContain("turn_end");
    if (continuation) {
      expect(events).toContain("continuation_started");
      expect(events).not.toContain("continuation_ended");
    } else expect(session.isStreaming()).toBe(true);
    for (let n = Math.max(1, copiesBeforeTool); n < copiedAt.length; n++)
      expect((copiedAt[n] ?? 0) - (copiedAt[n - 1] ?? 0)).toBeGreaterThanOrEqual(1_000);
    if (ending === "tool-end") {
      finishTool();
      await expect.poll(() => events.includes("tool_end")).toBe(true);
      await expect.poll(() => events.filter((type) => type === "request_started").length).toBe(2);
      // The last call ended and the next request hangs, so no event follows:
      // once a copy brings the result home, the loop runs out with no copy on
      // its way and none armed. Read the loop before firing: right after firing
      // an armed copy the schedule is empty whether or not the loop stops (INF-454).
      await expect
        .poll(() => {
          const loop = { copying, armed: scheduled.size };
          fireNext();
          return {
            ...loop,
            result: read().lines.some((line) => line.kind === "tool" && line.result !== null),
          };
        })
        .toEqual({ copying: 0, armed: 0, result: true });
    } else if (ending === "turn-end") {
      await session.abort();
      await asking;
      expect(events).not.toContain("tool_end");
      expect(scheduled.size).toBe(0);
    } else if (continuation) {
      if (ending === "continuation-complete") {
        inner.answer({ text: "The check finished." });
        finishTool();
      } else {
        inner.endClient(
          ending === "continuation-failure" ? new Error("Client stream failed") : undefined,
        );
      }
      await expect.poll(() => events.includes("continuation_ended")).toBe(true);
      if (ending === "continuation-complete") {
        expect(events).toContain("tool_end");
        expect(events).toContain("turn_end");
        expect(events.indexOf("turn_end")).toBeLessThan(events.indexOf("continuation_ended"));
      } else {
        expect(events).not.toContain("turn_end");
        expect(events).not.toContain("tool_end");
      }
      // G1: the last coalesced copy survives the ending, then no repeat is armed.
      // The ending can arrive while a copy asked before it is still on its way,
      // and that copy may lack the tail, so the home arms the final copy once it
      // answers: wait for that copy to be armed before firing it (INF-445).
      await expect.poll(() => scheduled.size).toBe(1);
      const copiesBeforeTail = copiedAt.length;
      fireNext();
      await expect.poll(() => copiedAt.length).toBe(copiesBeforeTail + 1);
      if (ending === "continuation-complete") {
        await expect
          .poll(() => read().lines)
          .toContainEqual(expect.objectContaining({ kind: "said", text: "The check finished." }));
      }
      expect(scheduled.size).toBe(0);
    } else {
      session.dispose();
      expect(scheduled.size).toBe(0);
    }
  } finally {
    startTool();
    writeTool();
    finishTool();
    await session.abort();
    await asking;
    session.dispose();
    await session.closed();
    sent.mockRestore();
  }
});

// INF-3612: the real client wrote a call's result after its tool_end and its
// next request, so the copy loop stopped first and the Crewmate tab showed the
// finished call as running until another event came (placedClaudeCost's wait).
it("keeps copying after a placed Claude call ends until its late result reaches the home", async () => {
  let now = 0;
  const scheduled = new Set<{ due: number; run: () => void }>();
  const schedule = (ms: number, run: () => void) => {
    expect(scheduled.size).toBe(0);
    const timer = { due: now + ms, run };
    scheduled.add(timer);
    return () => {
      scheduled.delete(timer);
    };
  };
  const fireNext = () => {
    const timer = scheduled.values().next().value;
    if (!timer) return;
    scheduled.delete(timer);
    now = Math.max(now, timer.due);
    timer.run();
  };
  let writeResult!: () => void;
  const resultHeld = new Promise<void>((resolve) => {
    writeResult = resolve;
  });
  const inner = await scriptedClaudeWorld({ beforeResultRecord: () => resultHeld });
  const world = await placedContractWorld(inner, { now: () => now, schedule });
  const { tasks, paths, devices } = world.placement;
  const ask = devices.ask.bind(devices);
  const copiedAt: number[] = [];
  let copying = 0;
  const sent = vi.spyOn(devices, "ask").mockImplementation(async (device, channel, args) => {
    if (channel === "inf:session:copy") copying += 1;
    try {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") copiedAt.push(now);
      return answer;
    } finally {
      if (channel === "inf:session:copy") copying -= 1;
    }
  });
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      {
        taskId: CREWMATE_TASK,
        machineId: world.machine,
        cwd: world.homeDir,
        model: world.model,
      },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => {
          inner.answer("hang");
          return { text: "Looked up." };
        },
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  const recordDirOf = (id: string) => crewmateSessionsDir(paths, id);
  const resolver = createCrewmateTranscriptResolver({
    recordDirOf,
    backendOf: () => undefined,
    configDirOf: () => undefined,
  });
  const reader = new CrewTranscripts({
    recordDirOf,
    currentSession: (task) => resolver(task).path,
  });
  const read = () => {
    const task = tasks.get(CREWMATE_TASK);
    if (!task) throw new Error("The placed Claude task is missing.");
    return reader.of(task, tasks.timeline(CREWMATE_TASK), false);
  };
  const resultHome = () =>
    read().lines.some((line) => line.kind === "tool" && line.result !== null);
  inner.answer({ tool: CONTRACT_TOOL, answer: "Not reached while held." });
  const asking = session.prompt("Run the footer check on Mac mini.");
  try {
    // The call ended and the next request hangs, so no event follows it.
    await expect.poll(() => events.includes("tool_end")).toBe(true);
    await expect.poll(() => events.filter((type) => type === "request_started").length).toBe(2);
    await expect
      .poll(() => {
        fireNext();
        return read().lines.some((line) => line.kind === "tool" && line.result === null);
      })
      .toBe(true);
    // While the client has not written the result, the loop goes on copying.
    const copiesBeforeResult = copiedAt.length;
    await expect
      .poll(() => {
        fireNext();
        return copiedAt.length;
      })
      .toBeGreaterThanOrEqual(copiesBeforeResult + 2);
    expect(resultHome()).toBe(false);
    expect(events).not.toContain("turn_end");
    writeResult();
    // Once a copy brings the result home, the loop runs out with no copy on
    // its way and none armed. Read the loop before firing (INF-454).
    await expect
      .poll(() => {
        const loop = { copying, armed: scheduled.size };
        fireNext();
        return { ...loop, result: resultHome() };
      })
      .toEqual({ copying: 0, armed: 0, result: true });
    expect(events).not.toContain("turn_end");
  } finally {
    writeResult();
    await session.abort();
    await asking;
    session.dispose();
    await session.closed();
    sent.mockRestore();
  }
});

// INF-3705: Claude crewmates running long turns on another computer froze
// the home's main thread: after every copy of the record, the check for a
// call still missing its result listed the record's folder and read the size
// of every file in it, staged skill copies included, once for each call the
// turn had ended.
it("reads a placed Claude record's own files once per check however many calls its turn ended", async () => {
  const CALLS = 200;
  let now = 0;
  const scheduled = new Set<{ due: number; run: () => void }>();
  const schedule = (ms: number, run: () => void) => {
    expect(scheduled.size).toBe(0);
    const timer = { due: now + ms, run };
    scheduled.add(timer);
    return () => {
      scheduled.delete(timer);
    };
  };
  const fireNext = () => {
    const timer = scheduled.values().next().value;
    if (!timer) return;
    scheduled.delete(timer);
    now = Math.max(now, timer.due);
    timer.run();
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const inner = await scriptedClaudeWorld({
    // The model goes on calling until CALLS calls ended, then thinks on.
    beforeTool: () => (calls++ < CALLS ? Promise.resolve() : held),
    // The last call's result reaches the transcript late, so the check holds the loop.
    beforeResultRecord: () => (calls === CALLS ? held : Promise.resolve()),
  });
  const world = await placedContractWorld(inner, { now: () => now, schedule });
  const { tasks, paths, devices } = world.placement;
  // The working copy's own skills, which the session stages beside its record there.
  cpSync(
    join(process.cwd(), ".claude", "skills", "infinitary-design"),
    join(world.homeDir, ".claude", "skills", "infinitary-design"),
    { recursive: true },
  );
  const recordDir = crewmateSessionsDir(paths, CREWMATE_TASK);
  const stagedDir = join(recordDir, "staged");
  // What the check after a copy reads: whatever was read since the copy's last answer.
  let sinceAnswer = { listings: 0, stagedReads: 0 };
  fsReads.listen = (kind, path) => {
    if (kind === "list" && path === recordDir) sinceAnswer.listings += 1;
    if (kind === "stat" && path.startsWith(stagedDir)) sinceAnswer.stagedReads += 1;
  };
  const ask = devices.ask.bind(devices);
  let copying = 0;
  let copies = 0;
  const sent = vi.spyOn(devices, "ask").mockImplementation(async (device, channel, args) => {
    if (channel === "inf:session:copy") copying += 1;
    try {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") {
        copies += 1;
        sinceAnswer = { listings: 0, stagedReads: 0 };
      }
      return answer;
    } finally {
      if (channel === "inf:session:copy") copying -= 1;
    }
  });
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      {
        taskId: CREWMATE_TASK,
        machineId: world.machine,
        cwd: world.homeDir,
        model: world.model,
      },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => ({ text: "Looked up." }),
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  const count = (type: string) => events.filter((each) => each === type).length;
  /** One live copy and the check after it: done once the check armed the next copy. */
  const copyAndCheck = async () => {
    const before = copies;
    fireNext();
    await expect
      .poll(() => copies > before && copying === 0 && scheduled.size === 1, { timeout: 5_000 })
      .toBe(true);
  };
  inner.answer("loop");
  const asking = session.prompt("Run the footer check on Mac mini, file by file.");
  try {
    await expect
      .poll(() => ({ ended: count("tool_end"), requests: count("request_started") }), {
        timeout: 5_000,
      })
      .toEqual({ ended: CALLS, requests: CALLS + 1 });
    await expect.poll(() => scheduled.size).toBe(1);
    // The first copy brings the record and its staged skills home.
    await copyAndCheck();
    expect(readdirSync(stagedDir, { recursive: true, encoding: "utf8" })).toContainEqual(
      expect.stringMatching(/infinitary-design\/SKILL\.md$/),
    );
    expect(events).not.toContain("turn_end");
    // Nothing more happens there, so this copy's check is all the next one reads.
    await copyAndCheck();
    expect({ ...sinceAnswer }).toEqual({ listings: 1, stagedReads: 0 });
  } finally {
    release();
    await session.abort();
    await asking;
    session.dispose();
    await session.closed();
    sent.mockRestore();
  }
});

/**
 * What the home reads from disk over one step of a placed Claude turn that
 * already ended `calls` calls: from the step's events arriving, through the
 * live copy of the record they start, to the check after it. Each read is
 * told by its kind and where it reads, with paths under the home's own folder
 * and the record's staged skills named by what they are.
 */
async function homeReadsOverOneStep(calls: number) {
  let now = 0;
  const scheduled = new Set<{ due: number; run: () => void }>();
  const schedule = (ms: number, run: () => void) => {
    expect(scheduled.size).toBe(0);
    const timer = { due: now + ms, run };
    scheduled.add(timer);
    return () => {
      scheduled.delete(timer);
    };
  };
  const fireNext = () => {
    const timer = scheduled.values().next().value;
    if (!timer) return;
    scheduled.delete(timer);
    now = Math.max(now, timer.due);
    timer.run();
  };
  // The model makes `calls` calls on its own, then each further call waits to be let go.
  let started = 0;
  const waiting: (() => void)[] = [];
  const inner = await scriptedClaudeWorld({
    beforeTool: () =>
      started++ < calls ? Promise.resolve() : new Promise((go) => waiting.push(go)),
  });
  const world = await placedContractWorld(inner, { now: () => now, schedule });
  const { tasks, paths, devices } = world.placement;
  // The working copy's own skills, which the session stages beside its record there.
  cpSync(
    join(process.cwd(), ".claude", "skills", "infinitary-design"),
    join(world.homeDir, ".claude", "skills", "infinitary-design"),
    { recursive: true },
  );
  const recordDir = crewmateSessionsDir(paths, CREWMATE_TASK);
  // The computer's own reads, and its client's, are its own work, not the home's.
  const theirs = [world.computerDir, inner.clientDir];
  let sessionId = "";
  const where = (path: string) => {
    const named = sessionId ? path.replaceAll(sessionId, "<session>") : path;
    if (named.startsWith(join(recordDir, "staged"))) return "record:staged";
    if (named.startsWith(recordDir)) return `record${named.slice(recordDir.length)}`;
    if (named.startsWith(paths.userData)) return `home${named.slice(paths.userData.length)}`;
    return named;
  };
  // Over the step: each read by its kind and place, the bytes the reads took, and the bytes copied home.
  let reads: Record<string, number> | undefined;
  let bytesRead = 0;
  let bytesCopied = 0;
  fsReads.listen = (kind, path, took) => {
    if (!reads || theirs.some((dir) => path.startsWith(dir))) return;
    const key = `${kind} ${where(path)}`;
    reads[key] = (reads[key] ?? 0) + 1;
    bytesRead += took ?? 0;
  };
  const ask = devices.ask.bind(devices);
  let copying = 0;
  let copies = 0;
  const sent = vi.spyOn(devices, "ask").mockImplementation(async (device, channel, args) => {
    if (channel === "inf:session:copy") copying += 1;
    try {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:copy") {
        copies += 1;
        for (const file of (answer as WorkOrderResponse<"inf:session:copy">).files)
          if (reads) bytesCopied += Buffer.byteLength(file.data, "base64");
      }
      return answer;
    } finally {
      if (channel === "inf:session:copy") copying -= 1;
    }
  });
  const session = await world.factory.open({
    ...crewmateSessionSpec(
      paths,
      { taskId: CREWMATE_TASK, machineId: world.machine, cwd: world.homeDir, model: world.model },
      world.binding,
    ),
    tools: [
      boundTool({
        name: CONTRACT_TOOL,
        label: "Look up",
        description: "Look the contract answer up.",
        parameters: Type.Object({}),
        run: async () => ({ text: "Looked up." }),
      }),
    ],
  });
  tasks.turns.setSessionFile(CREWMATE_TASK, session.sessionId);
  sessionId = session.sessionId;
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  const count = (type: string) => events.filter((each) => each === type).length;
  /** The model asked again and waits to make its next call, with every call before it ended. */
  const waitingAfter = async (ended: number) => {
    await expect
      .poll(
        () => ({
          ended: count("tool_end"),
          requests: count("request_started"),
          waiting: waiting.length,
        }),
        { timeout: 10_000 },
      )
      .toEqual({ ended, requests: ended + 1, waiting: 1 });
    await expect.poll(() => scheduled.size).toBe(1);
  };
  /** One live copy and the check after it: done once the check armed or left the next copy. */
  const copyAndCheck = async () => {
    const before = copies;
    fireNext();
    await expect.poll(() => copies > before && copying === 0, { timeout: 5_000 }).toBe(true);
    // The check after the copy runs as the copy settles; a tick lets it finish.
    await new Promise((resolve) => setImmediate(resolve));
  };
  inner.answer("loop");
  const asking = session.prompt("Run the footer check on Mac mini, file by file.");
  try {
    await waitingAfter(calls);
    // The first copy brings the record and its staged skills home.
    await copyAndCheck();
    expect(
      readdirSync(join(recordDir, "staged"), { recursive: true, encoding: "utf8" }),
    ).toContainEqual(expect.stringMatching(/infinitary-design\/SKILL\.md$/));
    // One more step, read from its first event to the check after its copy.
    reads = {};
    waiting.shift()?.();
    await waitingAfter(calls + 1);
    await copyAndCheck();
    const step = { reads, bytesRead, bytesCopied };
    reads = undefined;
    return step;
  } finally {
    reads = undefined;
    for (const go of waiting.splice(0)) go();
    await session.abort();
    await asking;
    session.dispose();
    await session.closed();
    sent.mockRestore();
  }
}

// INF-3719: a step of a placed crewmate's turn must cost the home the same
// disk work early in a turn as late in it, whichever function does the reading;
// INF-3705's freeze was a check that read once more for every call the turn
// had ended.
it("reads the same from disk for a step of a placed Claude turn however many calls it ended", async () => {
  const early = await homeReadsOverOneStep(25);
  await placedContractCleanup();
  await scriptedClaudeCleanup();
  const late = await homeReadsOverOneStep(100);
  // The same reads of the same files, step for step: a read repeated per ended call shows here.
  expect(late.reads).toEqual(early.reads);
  // And no read takes more than the step brought home: a whole growing file read again shows here.
  for (const step of [early, late]) {
    expect(step.bytesCopied).toBeGreaterThan(0);
    expect(step.bytesRead).toBeLessThanOrEqual(step.bytesCopied);
  }
});

// INF-341 F2: only refresh-capable Claude needs eventless open-call polling.
it.each([
  { backend: "claude", protocolVersion: "8.14.0" },
  { backend: "pi", protocolVersion: PROTOCOL_VERSION },
] as const)(
  "keeps event-driven copies for $backend on $protocolVersion",
  async ({ backend, protocolVersion }) => {
    let now = 0;
    const scheduled = new Set<{ due: number; run: () => void }>();
    let finishTool!: () => void;
    const held = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const api = backend === "pi" ? await startContractApi() : undefined;
    const inner = api
      ? await piContractWorld(api, await piStubRuntime(api.url, PI_CONTRACT_MODEL))
      : await scriptedClaudeWorld();
    const world = await placedContractWorld(inner, {
      protocolVersion,
      homeProtocolVersion: protocolVersion,
      now: () => now,
      schedule: (ms, run) => {
        const timer = { due: now + ms, run };
        scheduled.add(timer);
        return () => {
          scheduled.delete(timer);
        };
      },
    });
    const { paths, devices } = world.placement;
    const ask = devices.ask.bind(devices);
    let copies = 0;
    let copying = 0;
    const sent = vi.spyOn(devices, "ask").mockImplementation(async (device, channel, args) => {
      if (channel === "inf:session:copy") copying += 1;
      try {
        const answer = await ask(device, channel, args);
        if (channel === "inf:session:copy") copies += 1;
        return answer;
      } finally {
        if (channel === "inf:session:copy") copying -= 1;
      }
    });
    const session = await world.factory.open({
      ...crewmateSessionSpec(
        paths,
        { taskId: CREWMATE_TASK, machineId: world.machine, cwd: world.homeDir, model: world.model },
        world.binding,
      ),
      tools: [
        boundTool({
          name: CONTRACT_TOOL,
          label: "Look up",
          description: "Look the contract answer up.",
          parameters: Type.Object({}),
          run: async () => {
            await held;
            return { text: "Looked up." };
          },
        }),
      ],
    });
    const events: string[] = [];
    session.subscribe((event) => {
      events.push(event.type);
    });
    inner.answer({ tool: CONTRACT_TOOL, answer: "The check finished." });
    const asking = session.prompt("Run the long footer check on Mac mini.");
    try {
      await expect.poll(() => events.includes("tool_start")).toBe(true);
      await expect
        .poll(async () => {
          const timer = scheduled.values().next().value;
          if (timer) {
            scheduled.delete(timer);
            now = Math.max(now, timer.due);
            timer.run();
          }
          // Drain the completed transfer's promise continuations, not a wall-clock delay.
          await new Promise<void>((resolve) => setImmediate(resolve));
          return copies > 0 && copying === 0 && scheduled.size === 0;
        })
        .toBe(true);
      expect(events).not.toContain("tool_end");
      expect(session.isStreaming()).toBe(true);
    } finally {
      finishTool();
      await session.abort();
      await asking;
      session.dispose();
      await session.closed();
      sent.mockRestore();
      await api?.close();
    }
  },
);

// INF-40 / review F1: an older helper must receive the copy request it knows.
it.each([
  { protocolVersion: "8.14.0", refresh: false },
  { protocolVersion: PROTOCOL_VERSION, refresh: true },
])(
  "gates record refresh for a computer speaking $protocolVersion",
  async ({ protocolVersion, refresh }) => {
    // INF-416 L: the historical minor boundary needs a same-major home;
    // a protocol 9 home correctly gives an 8.x worker no work.
    const world = await placedContractWorld(await scriptedClaudeWorld(), {
      protocolVersion,
      homeProtocolVersion: protocolVersion,
    });
    const { devices, deviceId, paths } = world.placement;
    const sent = vi.spyOn(devices, "ask");
    const session = await world.factory.open(
      crewmateSessionSpec(
        paths,
        {
          taskId: CREWMATE_TASK,
          machineId: deviceId,
          cwd: world.homeDir,
          model: world.model,
        },
        world.binding,
      ),
    );
    try {
      await session.prompt("Read the footer.");
      const requests = sent.mock.calls.filter((call) => call[1] === "inf:session:copy");
      expect(requests.length).toBeGreaterThan(0);
      for (const call of requests) {
        const [request] = workOrders["inf:session:copy"].request.parse(call[2]);
        if (refresh) expect(request.refresh).toBe(true);
        else expect(request).not.toHaveProperty("refresh");
      }
    } finally {
      sent.mockRestore();
      session.dispose();
      await session.closed();
    }
  },
);

// INF-2599 (the captain: "Send a crewmate its directions once, and again only
// when they change"): the crew sends a crewmate its directions again after a
// fold, so a fold where its conversation is held reaches the crew's session
// at home, through the home's own reading of the computer's events.
it("tells the home's session when the placed Claude conversation folds", async () => {
  const claude = await scriptedClaudeWorld();
  const world = await placedContractWorld(claude);
  const { paths, deviceId } = world.placement;
  const session = await world.factory.open(
    crewmateSessionSpec(
      paths,
      { taskId: CREWMATE_TASK, machineId: deviceId, cwd: world.homeDir, model: world.model },
      world.binding,
    ),
  );
  const events: string[] = [];
  session.subscribe((event) => events.push(event.type));
  try {
    await session.prompt("Read the footer.");
    expect(events).not.toContain("context_compacted");
    claude.fold();
    await expect.poll(() => events).toContain("context_compacted");
  } finally {
    session.dispose();
    await session.closed();
  }
});

describeSessionContract({
  name: "Claude, scripted, held on a computer that runs work",
  backend: "claude",
  roles: ["crewmate"],
  stopsSafely: false,
  world: async () => placedContractWorld(await scriptedClaudeWorld()),
  cleanup: async () => {
    await placedContractCleanup();
    await scriptedClaudeCleanup();
  },
});
