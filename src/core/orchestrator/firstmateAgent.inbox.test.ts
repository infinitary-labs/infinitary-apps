import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../../tests/helpers/deferred";
import {
  admissionClock,
  fakeClockEachTest,
  fakeSession,
  notifyProse,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { sourceInstall } from "../../../tests/helpers/sourceInstall";
import { readSelfSourceAsync } from "../selfSource/resolve";
import type { ModelSession } from "../session/session";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: the durable inbox (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

describe("FirstmateAgent durable inbox (design A)", () => {
  it("INF-2214 delivers a saved answer after busy work and retries handling without duplicating its record", async () => {
    const f = setup({
      seedTasks: [
        {
          id: "dop208",
          title: "Find the remover path",
          status: "idle",
          sessionFile: "/tmp/dop208.jsonl",
        },
      ],
    });
    const inbox = new InboxStore(f.db);
    await f.agent.converse("Find the remover path.");
    await toolsOf(f.specs).get("steer_crewmate")?.execute("ask-path", {
      task_id: "dop208",
      message: "What is the full path to setup/shell-pc/shell-pc-job-host-remove.cmd?",
    });
    const request = inbox.pendingResponses("dop208")[0]!;
    expect(request).toBeDefined();
    const declaration = {
      requestId: request.id,
      responseId: "dop-208-path",
      status: "answered" as const,
    };
    const text = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
    const report = f.crewSpecs[0]?.tools.find((tool) => tool.name === "report");
    expect(report).toBeDefined();
    await report!.run({
      text,
      responses: [
        { request_id: request.id, response_id: declaration.responseId, status: "answered" },
      ],
    });
    const saved = inbox.savedResponse(declaration.responseId)!;
    expect(saved).toMatchObject({ text, contributorTask: "dop208" });
    await report!.run({ text: "The checks are still running." });
    f.agent.pokeInbox();
    expect(f.session.prompts).toHaveLength(1);
    expect(inbox.savedResponse(declaration.responseId)).toMatchObject({
      deliveredAt: null,
      handledAt: null,
    });
    // Closing the source lane does not delete the first mate's queued answer.
    inbox.purgeTask("dop208");
    f.session.emitTurnEnd("I will look at the answer.");
    f.session.resolveNextPrompt();
    await tick();
    expect(f.session.prompts).toHaveLength(2);
    expect(f.session.prompts[1]).toContain(text);
    const delivered = inbox.savedResponse(declaration.responseId)!;
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.handledAt).toBeNull();
    f.session.emitTurnFailed("provider unavailable during handling");
    f.session.resolveNextPrompt();
    await tick();
    expect(inbox.get(saved.wakeId)).toBeDefined();
    f.db
      .prepare(
        "UPDATE inbox SET last_attempt_at = last_attempt_at - 120000, next_attempt_at = next_attempt_at - 120000 WHERE id = ?",
      )
      .run(saved.wakeId);
    f.agent.pokeInbox();
    await tick();
    expect(f.session.prompts).toHaveLength(3);
    expect(f.session.prompts[2]).toContain(text);
    f.session.emitTurnEnd("Handled the saved path answer.");
    f.session.resolveNextPrompt();
    await tick();
    const handled = inbox.savedResponse(declaration.responseId)!;
    expect(handled.handledAt).not.toBeNull();
    expect(inbox.get(saved.wakeId)).toBeUndefined();
    expect(inbox.submitResponse(declaration, { task: "dop208", session: null }, text)).toEqual(
      handled,
    );
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    const evidence = process.env.INFINITARY_RESPONSE_EVIDENCE;
    if (evidence)
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            question: request,
            submission: saved,
            delivered,
            handled,
            firstMateInputs: f.session.prompts.slice(1),
          },
          null,
          2,
        ),
      );
    f.agent.dispose();
  });
  it("re-presents an op batch when the consuming turn fails", async () => {
    const { agent, session, db } = setup();
    await agent.converse("start work");
    notifyProse(
      db,
      agent,
      "[fm-op] crewmate 1 reported on task ab12: done",
      "crewmate-report",
      "ab12",
    );
    await tick();
    // Streaming: the op waits durably.
    expect(session.prompts).toHaveLength(1);
    session.emitTurnEnd("ok");
    session.resolveNextPrompt();
    await tick();
    // Drained as its own turn - which fails at the provider.
    expect(session.prompts).toHaveLength(2);
    session.emitTurnFailed("upstream 529");
    session.resolveNextPrompt();
    await tick();
    // Ack after handling: the batch was released, not deleted, and it
    // retries once the grace passes.
    db.prepare(
      "UPDATE inbox SET last_attempt_at = last_attempt_at - 120000, next_attempt_at = next_attempt_at - 120000",
    ).run();
    agent.pokeInbox();
    await tick();
    expect(session.prompts).toHaveLength(3);
    expect(session.prompts[2]).toContain("crewmate 1 reported");
    session.emitTurnEnd("noted");
    session.resolveNextPrompt();
    await tick();
    const left = db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("keeps the captain's words when a busy-session steer fails", async () => {
    const session = fakeSession();
    session.steer = vi.fn(async () => {
      throw new Error("steer rejected");
    });
    const { agent } = setup({ session });
    await agent.converse("start work");
    // The captain speaks mid-turn; the steer fails, but the row is durable.
    await agent.converse("urgent correction");
    session.emitTurnEnd("ok");
    session.resolveNextPrompt();
    await tick();
    // The recorded turn delivered as the next turn instead of vanishing.
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("[user]\nurgent correction");
  });

  it("delivers a steer the turn never read as a turn of its own", async () => {
    const { agent, session } = setup();
    await agent.converse("start work");
    // The captain speaks as the turn closes: the session accepts the steer,
    // but its run has already looked at its queue for the last time.
    session.holdSteers();
    await agent.converse("also this");
    expect(session.steers).toHaveLength(1);
    session.emitTurnEnd("ok");
    session.resolveNextPrompt();
    await tick();
    // Not left waiting for whatever turn comes next: it is the next turn.
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("[user]\nalso this");
    session.emitTurnEnd("ok");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(2);
  });

  it("acks a successful busy-session steer so nothing re-delivers", async () => {
    const { agent, session, db } = setup();
    await agent.converse("start work");
    await agent.converse("also this");
    expect(session.steers).toHaveLength(1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number };
    expect(rows.n).toBe(0);
    session.emitTurnEnd("ok");
    session.resolveNextPrompt();
    await tick();
    expect(session.prompts).toHaveLength(1);
  });
});

/**
 * INF-799 piece 2, the captain's bounds answer: "if the program exceeds the
 * proposed upperbound, also ask user via a card". The bound rests on the
 * captain's consent, so the first mate raises it only in a turn that carries their words.
 */
describe("a program's bound", () => {
  it("is raised in a turn that carries the captain's words, and refused in one without them", async () => {
    const f = setup({ silent: true });
    seedTask(f.tasks, {
      id: "pr0g",
      title: "Cap the meter's rendered results",
      status: "queued",
      shape: { kind: "unclear", program: { script: 'return task("Cap it.");', bound: 4 } },
    });
    const finish = async () => {
      f.session.emitTurnEnd("Noted.");
      f.session.resolveNextPrompt();
      await tick();
    };
    const raise = () =>
      toolsOf(f.specs).get("update_task")?.execute("bound", { task: "pr0g", program_bound: 8 });
    f.agent.notifyOp(
      {
        facts: {
          kind: "program-bound",
          task: { id: "pr0g", title: "Cap the meter's rendered results" },
          key: "SCR-1",
          bound: 4,
          calls: 4,
        },
      },
      "agent",
      "pr0g",
    );
    await tick();
    expect(JSON.stringify(await raise())).toContain(
      "program_bound is raised only on the captain's words",
    );
    expect(f.tasks.get("pr0g")?.shape?.program?.bound).toBe(4);
    await finish();
    await f.agent.converse("Yes, let it run up to 8 parts.");
    await raise();
    expect(f.tasks.get("pr0g")?.shape?.program?.bound).toBe(8);
    await finish();
    f.agent.dispose();
    f.db.close();
  });
});

// The captain's original report changed the model during the old turn, then
// an automatic drain and the next captain request overlapped. Keep that order
// with completion signals, not a delay or a retry; both sessions are real Pi.
it("INF-2373: a delayed captain request uses the replacement after a pending model drain", async () => {
  vi.useRealTimers();
  const { startMockProvider } = await import("../../../tests/e2e/mockProvider");
  const { mockModelsJson } = await import("../../../tests/e2e/mockModels");
  const { catalogRefreshesSettled, createModelRuntime } = await import("../pi/modelRuntime");
  const { createPiSessionFactory } = await import("../pi/session");
  const provider = await startMockProvider();
  const root = scratchDir("pending-rebind-laboratory-");
  const models = JSON.parse(mockModelsJson(provider.port));
  models.providers["fm-mock"].models.push({
    id: "mock-next",
    name: "Next mock model",
    input: ["text", "image"],
  });
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, JSON.stringify(models));
  const runtime = await createModelRuntime({ authPath: join(root, "auth.json"), modelsPath });
  const factory = createPiSessionFactory({ agentDir: join(root, "agent") });
  const installed = sourceInstall(join(root, "source"));
  const captainReading = deferred<void>();
  const releaseCaptain = deferred<void>();
  const firstClosed = deferred<void>();
  const replacementClosed = deferred<void>();
  const captainClosed = deferred<void>();
  const entries: string[] = [];
  const opened: ModelSession[] = [];
  let holdNextSourceRead = false;
  let closed = 0;
  const f = setup({
    knowledge: false,
    availableModels: () => [
      { provider: "fm-mock", id: "mock-1" },
      { provider: "fm-mock", id: "mock-next" },
    ],
    onTurnSettled: (outcome) => {
      entries.push(`turn settled ${++closed}: ${outcome.failed ? "failed" : "clean"}`);
      if (closed === 1) firstClosed.resolve();
      else if (closed === 2) replacementClosed.resolve();
      else captainClosed.resolve();
    },
    selfSourceFactsAsync: async () => {
      const hold = holdNextSourceRead;
      holdNextSourceRead = false;
      const facts = await readSelfSourceAsync(installed.location);
      if (hold) {
        entries.push("routing source read held");
        captainReading.resolve();
        await releaseCaptain.promise;
        entries.push("routing source read released");
      }
      return facts;
    },
    piSeat: async (spec) => {
      const session = await factory.open({ ...spec, binding: { backend: "pi", runtime } });
      const label = `${opened.length}:${session.modelRef()?.id}`;
      opened.push(session);
      entries.push(`opened ${label}`);
      const dispose = session.dispose.bind(session);
      session.dispose = () => {
        entries.push(`dispose ${label}`);
        dispose();
      };
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => {
        entries.push(`prompt ${label}`);
        try {
          await prompt(...args);
        } catch (error) {
          entries.push(`prompt rejected ${label}: ${String(error)}`);
          throw error;
        }
      };
      return session;
    },
  });
  let captain: Promise<void> | undefined;
  try {
    await f.agent.converse("hello");
    expect(f.agent.isBusy()).toBe(true);
    await f.agent.applyModelSetting({ provider: "fm-mock", id: "mock-next" });
    entries.push("model setting deferred while old turn is busy");
    await firstClosed.promise;
    await admissionClock.advance(0);
    expect(opened).toHaveLength(1);
    holdNextSourceRead = true;
    captain = f.agent.converse('catalog change {"action":"routing","value":{"enabled":false}}');
    await captainReading.promise;
    // Original traffic has an automatic follow-up on the new model before
    // the routing failure. A normal inbox wake exercises the same admission.
    new InboxStore(f.db).enqueueWake(FIRSTMATE_RECIPIENT, "The model setting changed.", "agent");
    const admission = f.agent as unknown as { drainInbox(): Promise<void> };
    await admission.drainInbox();
    await replacementClosed.promise;
    entries.push("replacement answered before routing source read finishes");
    releaseCaptain.resolve();
    await captain;
    await captainClosed.promise;
    await admissionClock.advance(0);
    console.info("CONVERSATION_HANDOFF", JSON.stringify(entries));
    const card = f.supervisor.cards
      .snapshot()
      .find((card) => card.title === "Your first mate hit a problem");
    expect(card).toBeUndefined();
    expect(entries.filter((entry) => entry.startsWith("prompt "))).toEqual([
      "prompt 0:mock-1",
      "prompt 1:mock-next",
      "prompt 1:mock-next",
    ]);
    expect(provider.requestBodies().some((body) => body.includes('"model":"mock-next"'))).toBe(
      true,
    );
    expect(
      provider.requestBodies().some((body) => body.includes('\\"action\\":\\"routing\\"')),
    ).toBe(true);
  } finally {
    releaseCaptain.resolve();
    await captain;
    f.agent.dispose();
    for (const session of opened) session.dispose();
    await Promise.all(opened.map((session) => session.closed()));
    await f.supervisor.disposeAll();
    f.db.close();
    // The runtime's catalog refresh writes its store into the scratch
    // folder, which the file's cleanup removes; a refresh still running
    // would put it back.
    await catalogRefreshesSettled();
    await provider.close();
  }
});
