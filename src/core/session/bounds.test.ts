import { PROGRESS_TOOL_NAMES } from "@shared/events";
import { describe, expect, it } from "vitest";
import {
  type FakeSession,
  fakeBinding,
  fakeSessionFactory,
} from "../../../tests/helpers/fakeSession";
import { manualClock } from "../../../tests/helpers/manualClock";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import {
  BoundsWatcher,
  modelTurnsErrorMessage,
  outputCapErrorMessage,
  requestTimeoutErrorMessage,
  turnTimeoutErrorMessage,
} from "./bounds";
import { LOCAL_MACHINE_ID, type ModelSession, type SessionSpec } from "./session";

/**
 * The one watcher of the watched bounds, on a clock the test moves: every
 * bound is a number of ticks, never a wall-clock wait. The session under it
 * is the shared fake, whose events the test plays as a backend would.
 */

const REQUEST_MS = 5 * TICK_PERIOD_MS;
const TURN_MS = 20 * TICK_PERIOD_MS;

function spec(watched?: NonNullable<SessionSpec["bounds"]>["watched"]): SessionSpec {
  return {
    machine: LOCAL_MACHINE_ID,
    owner: "firstmate",
    cwd: "/tmp/firstmate/home",
    binding: fakeBinding(),
    thinking: { level: "low" },
    instructions: { base: "Be brief." },
    builtins: "none",
    tools: [],
    shape: { turns: "rolling", record: { dir: "/tmp/firstmate/sessions" } },
    ...(watched ? { bounds: { watched } } : {}),
  };
}

async function watched(
  bounds: NonNullable<SessionSpec["bounds"]>["watched"] = {
    requestTimeoutMs: REQUEST_MS,
    turnTimeoutMs: TURN_MS,
  },
) {
  const clock = manualClock();
  const backend = fakeSessionFactory();
  const factory = new BoundsWatcher(clock).factory(backend);
  const session = await factory.open(spec(bounds));
  const fake = backend.sessions[0] as FakeSession;
  const ticks = (count: number) => {
    for (let i = 0; i < count; i += 1) clock.advance(TICK_PERIOD_MS);
  };
  return { clock, factory, session, fake, ticks };
}

describe("the watched bounds on the host's one clock", () => {
  it("cuts an inference past the per-request bound at the first tick after it is due, in the bound's words", async () => {
    const { session, fake, ticks } = await watched();
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    const prompting = session.prompt("hello");
    ticks(4);
    expect(fake.aborts).toEqual([]);
    ticks(1);
    expect(fake.aborts).toEqual([requestTimeoutErrorMessage(REQUEST_MS)]);
    await prompting;
    // The backend reports the cut turn as failed, with the bound's sentence.
    expect(events).toEqual([
      { type: "turn_failed", taskId: "firstmate", error: "Request timed out after 300 seconds" },
      { type: "turn_end", taskId: "firstmate" },
      { type: "turn_closed" },
    ]);
  });

  it("starts the per-inference clock over at each model request and at the last tool's end, and stops it while a tool runs", async () => {
    const { session, fake, ticks } = await watched({ requestTimeoutMs: REQUEST_MS });
    void session.prompt("hello");
    ticks(4);
    fake.emit({ type: "request_started" });
    ticks(4);
    // Two tools at once: the clock waits for the last one.
    fake.emit({ type: "tool_start", taskId: "firstmate", callId: "c1", toolName: "tasks" });
    fake.emit({ type: "tool_start", taskId: "firstmate", callId: "c2", toolName: "crew_status" });
    ticks(30);
    fake.emit({
      type: "tool_end",
      taskId: "firstmate",
      callId: "c1",
      toolName: "tasks",
      isError: false,
    });
    ticks(10);
    expect(fake.aborts).toEqual([]);
    fake.emit({
      type: "tool_end",
      taskId: "firstmate",
      callId: "c2",
      toolName: "crew_status",
      isError: false,
    });
    ticks(4);
    expect(fake.aborts).toEqual([]);
    ticks(1);
    expect(fake.aborts).toEqual([requestTimeoutErrorMessage(REQUEST_MS)]);
  });

  it("keeps the per-inference clock running through a backend's own housekeeping", async () => {
    const { session, fake, ticks } = await watched();
    void session.prompt("hello");
    const [compaction] = PROGRESS_TOOL_NAMES;
    fake.emit({ type: "tool_start", taskId: "firstmate", callId: "x", toolName: compaction });
    ticks(5);
    expect(fake.aborts).toEqual([requestTimeoutErrorMessage(REQUEST_MS)]);
  });

  it("holds a turn busy with tools to the whole-turn backstop", async () => {
    const { session, fake, ticks } = await watched();
    void session.prompt("hello");
    fake.emit({ type: "tool_start", taskId: "firstmate", callId: "c1", toolName: "tasks" });
    ticks(19);
    expect(fake.aborts).toEqual([]);
    ticks(1);
    expect(fake.aborts).toEqual([turnTimeoutErrorMessage(TURN_MS)]);
  });

  it("watches nothing between prompts, and each prompt starts both clocks afresh", async () => {
    const { session, fake, ticks } = await watched();
    const first = session.prompt("hello");
    ticks(3);
    fake.settle();
    await first;
    ticks(40);
    expect(fake.aborts).toEqual([]);
    void session.prompt("again");
    ticks(4);
    expect(fake.aborts).toEqual([]);
    ticks(1);
    expect(fake.aborts).toEqual([requestTimeoutErrorMessage(REQUEST_MS)]);
  });

  it("cuts a turn once, and bounds the turn a prompt goes on to after the cut one closes", async () => {
    const { session, fake, ticks } = await watched({ requestTimeoutMs: REQUEST_MS });
    // A backend whose cut turn closes while its prompt goes on (a steer it
    // still held, answered in a turn of its own), or that has not closed it yet.
    let closes = false;
    fake.abort = async (failure) => {
      fake.aborts.push(failure);
      if (closes) fake.emit({ type: "turn_closed" });
    };
    void session.prompt("hello");
    ticks(5);
    expect(fake.aborts).toHaveLength(1);
    // Until the cut turn closes, nothing more is checked.
    ticks(30);
    expect(fake.aborts).toHaveLength(1);
    closes = true;
    fake.emit({ type: "turn_closed" });
    ticks(4);
    expect(fake.aborts).toHaveLength(1);
    ticks(1);
    expect(fake.aborts).toEqual([
      requestTimeoutErrorMessage(REQUEST_MS),
      requestTimeoutErrorMessage(REQUEST_MS),
    ]);
  });

  it("keeps only the bounds the spec asks for", async () => {
    const { session, fake, ticks } = await watched({ turnTimeoutMs: TURN_MS });
    void session.prompt("hello");
    ticks(19);
    expect(fake.aborts).toEqual([]);
    ticks(1);
    expect(fake.aborts).toEqual([turnTimeoutErrorMessage(TURN_MS)]);
  });

  it("rides one registration for every watched session of every backend, gone once the last has closed", async () => {
    const clock = manualClock();
    const watcher = new BoundsWatcher(clock);
    const pi = watcher.factory(fakeSessionFactory("pi"));
    const claude = watcher.factory(fakeSessionFactory("claude"));
    const bounds = { requestTimeoutMs: REQUEST_MS };
    const sessions: ModelSession[] = [await pi.open(spec(bounds)), await claude.open(spec(bounds))];
    expect(clock.registrations()).toEqual(["session-bounds"]);
    const [first, second] = sessions as [ModelSession, ModelSession];
    first.dispose();
    await first.closed();
    expect(clock.registrations()).toEqual(["session-bounds"]);
    second.dispose();
    await second.closed();
    expect(clock.registrations()).toEqual([]);
  });

  it("serves the rest of the contract as the session does", async () => {
    const { session, fake } = await watched();
    expect(session.sessionId).toBe(fake.sessionId);
    expect(session.controlProfile).toBe(fake.controlProfile);
    await session.steer("mind the left");
    session.setThinkingLevel("medium");
    session.serveInstructions({ text: "Be brief.", sha: "sha-1" });
    await session.detach();
    expect(fake.steers).toEqual([{ text: "mind the left" }]);
    expect(fake.thinkingLevels).toEqual(["medium"]);
    expect(fake.served).toEqual([{ text: "Be brief.", sha: "sha-1" }]);
    expect(fake.detaches).toBe(1);
    session.dispose();
    await session.closed();
    expect(fake.disposed).toBe(true);
  });
});

describe("the bounds' sentences", () => {
  it("say what stopped the turn, in the words the person reads", () => {
    expect(requestTimeoutErrorMessage(300_000)).toBe("Request timed out after 300 seconds");
    expect(turnTimeoutErrorMessage(20 * 60_000)).toBe("Turn timed out after 20 minutes");
    expect(modelTurnsErrorMessage(40)).toBe("Turn stopped after 40 model requests");
    expect(outputCapErrorMessage(8192)).toBe("Answer kept running past the 8192-token limit");
  });
});
