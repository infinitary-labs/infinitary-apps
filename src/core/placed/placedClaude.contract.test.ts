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
import { workOrders } from "../../shared/work";
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

afterEach(async () => {
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
  tasks.setSessionFile(CREWMATE_TASK, session.sessionId);
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
  tasks.setSessionFile(CREWMATE_TASK, session.sessionId);
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
  tasks.setSessionFile(CREWMATE_TASK, session.sessionId);
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
