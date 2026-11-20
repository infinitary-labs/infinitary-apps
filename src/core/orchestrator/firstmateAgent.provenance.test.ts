import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { type DecisionRecord, decisionRecordSchema } from "@shared/provenance";
import { parseServedInput } from "@shared/servedFrame";
import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  fakeClockEachTest,
  fakeSession,
  notifyProse,
  setup,
  type TurnImages,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { pngImage } from "../../../tests/helpers/images";
import { attachmentPath } from "../attachments";
import { FIRSTMATE_CONTRACT_VERSION, firstmatePromptSha } from "../pi/piResources";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import type { TaskService } from "../tasks/taskService";
import { renderWake } from "./wakes";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: provenance (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/**
 * Prospective provenance (R2): a served Firstmate turn is a policy-step
 * decision, recorded once through the task writer on the tasks it touched;
 * a direct steer or interrupt is a typed event of its own. Driven through
 * the real agent, supervisor, TaskService and SQLite over a scripted session.
 */
describe("FirstmateAgent provenance (R2)", () => {
  const decidedOn = (tasks: TaskService, taskId: string) =>
    tasks.timeline(taskId).filter((event) => event.kind === "decided");
  const allDecided = (tasks: TaskService) =>
    tasks.list().flatMap((record) => decidedOn(tasks, record.id));

  it("records one decision per served turn, with its frame, contract, producer and lineage", async () => {
    const { agent, session, specs, tasks, db } = setup({
      coalesceMs: 60_000,
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle" },
        { id: "t2", title: "Fix the flaky test", status: "idle" },
      ],
    });
    // A wake waits out the coalescing window, so the captain's turn carries it.
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task t1 "Add pagination": done.',
      "crewmate-report",
      "t1",
    );
    const wakeRow = new InboxStore(db).allFor("firstmate")[0];
    await agent.converse("stop the flaky-test work");

    const served = session.prompts[0] as string;
    const segments = parseServedInput(served);
    expect(segments?.map((segment) => segment.kind)).toEqual(["context", "wake", "user"]);
    expect(segments?.[2]?.body).toBe("[user]\nstop the flaky-test work");

    const interrupt = toolsOf(specs).get("interrupt_crewmate");
    session.emit({
      type: "tool_start",
      taskId: "firstmate",
      callId: "call-1",
      toolName: "interrupt_crewmate",
    });
    await interrupt?.execute("call-1", { task_id: "t2", mode: "interrupt" });
    session.emit({
      type: "tool_end",
      taskId: "firstmate",
      callId: "call-1",
      toolName: "interrupt_crewmate",
      isError: false,
    });
    // Nothing is recorded while the decision is still running.
    expect(allDecided(tasks)).toEqual([]);
    session.emitTurnEnd("Stopped.");
    session.resolveNextPrompt();
    await tick();

    const [onT1] = decidedOn(tasks, "t1");
    const [onT2] = decidedOn(tasks, "t2");
    expect(decidedOn(tasks, "t1")).toHaveLength(1);
    expect(decidedOn(tasks, "t2")).toHaveLength(1);
    expect(onT1?.data).toEqual(onT2?.data);
    expect(onT1?.actor).toBe("firstmate");
    expect(onT1?.feed).toBe(false);
    const record = decisionRecordSchema.parse(onT1?.data) as DecisionRecord;
    expect(onT1?.ref).toBe(record.decision);
    expect(record.trigger).toBe("mixed");
    expect(record.producer).toEqual({
      actor: "firstmate",
      role: "firstmate",
      model: { provider: "fm-mock", id: "mock-1" },
      accountId: null,
      thinkingLevel: "medium",
    });
    expect(record.contract.version).toBe(FIRSTMATE_CONTRACT_VERSION);
    expect(record.contract.promptSha).toBe(firstmatePromptSha());
    expect(record.contract.toolsSha).toMatch(/^[0-9a-f]{64}$/);
    expect(record.served?.prompt.textSha256).toBe(
      createHash("sha256").update(served).digest("hex"),
    );
    expect(record.served?.prompt.frame).toBe("v1");
    expect(record.served?.prompt.segments).toEqual([
      { kind: "context", length: (segments?.[0]?.end ?? 0) - (segments?.[0]?.start ?? 0) },
      {
        kind: "wake",
        length: (segments?.[1]?.end ?? 0) - (segments?.[1]?.start ?? 0),
        origin: "crewmate-report",
        inboxId: wakeRow?.id,
        ref: "t1",
      },
      { kind: "user", origin: "captain", length: "[user]\nstop the flaky-test work".length },
    ]);
    expect(record.disposition).toMatchObject({
      outcome: "clean",
      error: null,
      inbox: "acked",
      toolCalls: [{ id: "call-1", name: "interrupt_crewmate", isError: false }],
      verdict: null,
    });
    expect([...record.disposition.tasks].sort()).toEqual(["t1", "t2"]);
    expect(record.disposition.asks).toEqual([
      { id: tasks.capture.listAsks()[0]?.id, taskId: "t2", via: "tool:interrupt_crewmate" },
    ]);
    // The interrupt the decision issued points back at it.
    const interrupted = tasks.timeline("t2").find((event) => event.kind === "interrupted");
    expect(interrupted).toMatchObject({ actor: "firstmate", ref: record.decision, feed: false });
    expect(interrupted?.data).toEqual({
      mode: "interrupt",
      effect: "no-turn",
      error: null,
      via: "tool",
      decision: record.decision,
    });
  });

  it("concurrent startup inbox pokes serve one clean turn without a busy failure", async () => {
    const session = fakeSession();
    const prompt = session.prompt.bind(session);
    // Both real backends refuse a second prompt while the first is streaming.
    const attempts = vi.fn((text: string, images?: TurnImages) => {
      if (session.isStreaming()) return Promise.reject(new Error("Agent is already processing"));
      return prompt(text, images);
    });
    session.prompt = attempts;
    const { agent, db, tasks, events, cards, turns } = setup({
      session,
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
    });
    const inbox = new InboxStore(db);
    // A persisted, due wake exists before session creation, as at restart.
    inbox.enqueueWake(FIRSTMATE_RECIPIENT, "Pagination is ready", "crewmate-report", "t1");
    agent.pokeInbox();
    agent.pokeInbox();
    await tick();
    const inFlight = inbox.inFlight(FIRSTMATE_RECIPIENT);
    const failureCards = cards().filter((card) => card.id === "card-fm-turn-failure");
    const prematureIdle = events.filter((event) => event.type === "firstmate_state" && !event.busy);
    const prematureSettles = [...turns];
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();

    expect(attempts).toHaveBeenCalledTimes(1);
    expect(inFlight).toMatchObject([{ attempts: 1 }]);
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toEqual([]);
    expect(inbox.inFlight(FIRSTMATE_RECIPIENT)).toEqual([]);
    expect(failureCards).toEqual([]);
    expect(prematureIdle).toEqual([]);
    expect(prematureSettles).toEqual([]);
    expect(turns).toMatchObject([{ trigger: "operation", failed: false }]);
    const decisions = decidedOn(tasks, "t1");
    expect(decisions).toHaveLength(1);
    expect(decisionRecordSchema.parse(decisions[0]?.data).disposition).toMatchObject({
      outcome: "clean",
      error: null,
      inbox: "acked",
    });
  });

  it("records nothing on a watchdog tick, an empty inbox poke, or an idle supervisor tick", async () => {
    const { agent, db, session, supervisor, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
    });
    // The shared tick's own passes, with nothing to serve.
    const now = Date.now() + 60 * 60_000;
    agent.checkQuiet(now);
    agent.pokeInbox();
    supervisor.watch.checkQuietTasks(now);
    await supervisor.watch.sweepGates(now);
    await supervisor.watch.sweepInbox(now);
    await tick();
    expect(session.prompts).toEqual([]);
    expect(allDecided(tasks)).toEqual([]);

    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task t1 "Add pagination": done.',
      "crewmate-report",
      "t1",
    );
    await tick();
    agent.checkQuiet(Date.now());
    agent.pokeInbox();
    session.emitTurnEnd("Noted.");
    session.resolveNextPrompt();
    await tick();
    agent.pokeInbox();
    await tick();
    expect(allDecided(tasks)).toHaveLength(1);
    expect(decisionRecordSchema.parse(allDecided(tasks)[0]?.data).trigger).toBe("wake");
  });

  it("a failed turn is a failed decision, its error redacted and its rows released", async () => {
    const { agent, db, session, tasks } = setup({
      seedTasks: [{ id: "t1", title: "Add pagination", status: "idle" }],
    });
    notifyProse(
      db,
      agent,
      '[fm-op] crewmate 1 reported on task t1 "Add pagination": done.',
      "crewmate-report",
      "t1",
    );
    await tick();
    session.emitTurnFailed("401 invalid x-api-key sk-ant-live-SECRET123");
    session.resolveNextPrompt();
    await tick();
    const record = decidedOn(tasks, "t1")[0]?.data as DecisionRecord;
    expect(record.disposition.outcome).toBe("failed");
    expect(record.disposition.inbox).toBe("released");
    expect(record.disposition.error).toContain("401");
    expect(JSON.stringify(record)).not.toContain("SECRET123");
  });

  it("parks a refused mid-turn steer as the captain's typed turn, saying when its pictures could not be kept", async () => {
    const { agent, session, db } = setup();
    await agent.converse("first");
    await tick();
    session.steer = async () => {
      throw new Error("the session is closing");
    };
    await agent.converse("look at quota");
    await agent.converse({
      text: "and this",
      images: [pngImage],
    });
    const rows = new InboxStore(db).allFor(FIRSTMATE_RECIPIENT);
    expect(rows.map((row) => [row.origin, row.facts?.kind, row.text])).toEqual([
      ["captain", "captain-turn", undefined],
      ["captain", "captain-turn", undefined],
    ]);
    // The picture rides as a message-owned copy the row names, not a note
    // that it is gone.
    expect(rows.map(renderWake)).toEqual(["[user]\nlook at quota", "[user]\nand this"]);
    expect(rows[1]?.facts).toMatchObject({
      kind: "captain-turn",
      imagesDropped: false,
      attachments: [{ kind: "image", mimeType: "image/png", bytes: expect.any(Number) }],
    });
  });

  it("serves a parked turn's pictures from their copies when it drains, and blocks it when a copy is gone", async () => {
    const { agent, session, db, events } = setup();
    await agent.converse("first");
    await tick();
    session.steer = async () => {
      throw new Error("the session is closing");
    };
    await agent.converse({ text: "and this", images: [pngImage] });
    const inbox = new InboxStore(db);
    const [row] = inbox.allFor(FIRSTMATE_RECIPIENT);
    const kept = row?.facts as unknown as { attachments: AttachmentRef[] };
    const ref = kept.attachments[0] as AttachmentRef;
    // A copy that is gone blocks the message: it stays queued, and the feed says so.
    const file = attachmentPath(ref);
    const bytes = readFileSync(file);
    rmSync(file);
    session.resolveNextPrompt();
    await tick();
    expect(inbox.allFor(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    expect(session.promptImages.at(-1)).toBeUndefined();
    expect(
      events.filter(
        (event) => event.type === "firstmate_note" && event.text.includes("is not available"),
      ),
    ).toHaveLength(1);
    // Restored, it is served with its picture.
    writeFileSync(file, bytes);
    agent.pokeInbox();
    await tick();
    expect(session.promptImages.at(-1)).toEqual([
      expect.objectContaining({ mimeType: "image/png" }),
    ]);
  });

  it("a parked captain turn drains as the captain's words, never as a wake", async () => {
    const { agent, session, db } = setup();
    new InboxStore(db).enqueue("firstmate", "[user]\nlook at quota", "captain-turn", "captain");
    agent.pokeInbox();
    await tick();
    expect(parseServedInput(session.prompts[0] as string)?.map((segment) => segment.kind)).toEqual([
      "context",
      "user",
    ]);
  });

  it("captures a card choice's steer as the captain's, and the shell's abort as a direct cancel", async () => {
    const { supervisor, tasks } = setup({
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
        { id: "t2", title: "Fix the flaky test", status: "idle" },
      ],
      seedCards: [
        {
          ...crewCard("card-t1-1", "t1", "Which endpoint first?", "<p>Two choices.</p>"),
          actions: [{ id: "users", label: "Users first", default: true }],
        },
      ],
    });
    supervisor.cardActions.act("card-t1-1", "users");
    await tick();
    const steered = tasks.timeline("t1").find((event) => event.kind === "steered");
    expect(steered).toMatchObject({ actor: "captain", ref: null, feed: false });
    expect(steered?.text).toBe(
      'Card "Which endpoint first?": the user chose "Users first" (users).',
    );
    expect(steered?.data).toMatchObject({ via: "card", cardId: "card-t1-1", decision: null });
    expect(typeof steered?.data?.inboxId).toBe("number");

    await supervisor.sessions.abort("t2");
    const interrupted = tasks.timeline("t2").find((event) => event.kind === "interrupted");
    expect(interrupted).toMatchObject({ actor: "captain", ref: null });
    expect(interrupted?.data).toEqual({
      mode: "cancel",
      effect: "cancelled-record",
      error: null,
      via: "shell",
      decision: null,
    });
    // Request, then effect.
    const kinds = tasks.timeline("t2").map((event) => event.kind);
    expect(kinds.indexOf("interrupted")).toBeLessThan(kinds.lastIndexOf("status"));
  });

  it("a Firstmate steer records its delivery, the decision behind it, and a redacted message", async () => {
    const { agent, session, specs, tasks } = setup({
      seedTasks: [
        { id: "t1", title: "Add pagination", status: "idle", sessionFile: "/tmp/t1.jsonl" },
      ],
    });
    await agent.converse("tell pagination to use token ghp_abcdef123456");
    const steer = toolsOf(specs).get("steer_crewmate");
    await steer?.execute("call-s", { task_id: "t1", message: "use token ghp_abcdef123456" });
    session.emitTurnEnd("Steered.");
    session.resolveNextPrompt();
    await tick();
    const { decision } = decisionRecordSchema.parse(decidedOn(tasks, "t1")[0]?.data);
    const steered = tasks.timeline("t1").find((event) => event.kind === "steered");
    expect(steered).toMatchObject({ actor: "firstmate", ref: decision });
    expect(steered?.text).not.toContain("ghp_abcdef123456");
    expect(steered?.data).toMatchObject({ via: "tool", decision, cardId: null });
    expect(typeof steered?.data?.outcome).toBe("string");
  });
});
