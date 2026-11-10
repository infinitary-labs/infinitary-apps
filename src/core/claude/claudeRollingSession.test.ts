import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeFactory,
  scriptedClaudeQuery,
  scriptedRecordsFlushed,
} from "../../../tests/helpers/scriptedClaudeQuery";
import type { SessionEvent } from "../session/session";
import { encodeClaudeProjectDir } from "./claudeTranscript";

afterEach(scriptedRecordsFlushed);

/**
 * Intent: the accepted turn refactor keeps a stop asked during attachment
 * (the startup-stop defect). These are the real client's running, replay,
 * result and idle messages, through the session factory's scripted seam.
 * No real client, credentials or wall-clock delay is needed.
 */
it.each([undefined, "The turn exceeded its bound."])(
  "keeps a startup abort (%s), settles once and accepts the next prompt",
  async (failure) => {
    let stopped = false;
    let finishFirst: (() => void) | undefined;
    const { factory, harness } = scriptedClaudeQuery({
      onInput: (message, emit) => {
        emit({ type: "system", subtype: "session_state_changed", state: "running" });
        emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
        if (message.message.content === "Continue the work.") {
          emit({ type: "result", subtype: "success", is_error: false, result: "Continued." });
          emit({ type: "system", subtype: "session_state_changed", state: "idle" });
        } else {
          // Control and input have separate queues. The real client emits
          // running before its result even if control arrived first.
          finishFirst = () => {
            emit({ type: "result", subtype: "success", is_error: false, result: "" });
            emit({ type: "system", subtype: "session_state_changed", state: "idle" });
          };
          if (stopped) finishFirst();
        }
      },
      onInterrupt: () => {
        stopped = true;
        finishFirst?.();
      },
    });
    const session = await scriptedClaudeFactory({
      configDir: "/accounts/startup-stop",
      query: factory,
    }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("Start the work.");
    // Observe rejection even when a failing assertion ends the stand-in.
    void turn.catch(() => {});
    try {
      // prompt() cannot have attached before this synchronous abort call.
      await session.abort(failure);
      await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
      expect(harness().interrupts()).toBe(1);
      await turn;
      expect(session.isStreaming()).toBe(false);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual(
        failure ? [{ type: "turn_failed", taskId: "task-1", error: failure }] : [],
      );
      expect(events.filter((event) => event.type === "turn_closed")).toHaveLength(1);
      await session.prompt("Continue the work.");
      expect(harness().interrupts()).toBe(1);
      expect(events.filter((event) => event.type === "turn_closed")).toHaveLength(2);
    } finally {
      // Also release the deliberately unresponsive baseline client after
      // the expected failing assertion; no test-owned query outlives it.
      harness().end();
      await turn.catch(() => {});
      session.dispose();
      await session.closed();
    }
  },
);

// Intent: preserve attachment failure, startup-steer recovery and safe-stop
// boundaries while the accepted refactor removes their overlapping flags.
it("returns early steers after an attachment failure and releases its lease", async () => {
  const { hasActiveSession } = await import("./claudeStoreLease");
  const configDir = "/accounts/attachment-failure";
  const session = await scriptedClaudeFactory({
    configDir,
    query: () => {
      throw new Error("Client could not start.");
    },
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const turn = session.prompt("Start the work.");
  await session.steer("Keep this instruction.");
  await expect(turn).rejects.toThrow("Client could not start.");
  expect(session.isStreaming()).toBe(false);
  expect(session.takeUndeliveredSteers()).toEqual(["Keep this instruction."]);
  expect(session.takeUndeliveredSteers()).toEqual([]);
  expect(hasActiveSession(configDir)).toBe(false);
  session.dispose();
  await session.closed();
});

// Intent: row 7 of the implicit state machine audit - a resumed session
// whose transcript copy cannot be read hands its hold on the account's
// store back, or every later renewal stands down until a restart.
it("releases its lease when a resumed session's transcript copy cannot be read", async () => {
  const { hasActiveSession } = await import("./claudeStoreLease");
  const configDir = scratchDir("infinitary-claude-unreadable-copy-");
  const recordDir = scratchDir("infinitary-claude-unreadable-record-");
  const cwd = "/worktree";
  const recorded = "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90";
  // The client's transcript, so the session resumes, and the app's copy of
  // it, which this account cannot open.
  const line = `${JSON.stringify({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [] } })}\n`;
  const project = join(configDir, "projects", encodeClaudeProjectDir(cwd));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${recorded}.jsonl`), line);
  const copy = join(recordDir, `${recorded}.jsonl`);
  writeFileSync(copy, line);
  chmodSync(copy, 0o000);
  try {
    const { factory, attachments } = scriptedClaudeQuery({ onInput: () => {} });
    const session = await scriptedClaudeFactory({ configDir, query: factory }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "claude" },
        cwd,
        recordDir,
        resume: { backend: "claude", sessionId: recorded },
      }),
    );
    await expect(session.prompt("Carry on.")).rejects.toThrow(/EACCES/);
    expect(attachments).toEqual([]);
    expect(hasActiveSession(configDir)).toBe(false);
    session.dispose();
    await session.closed();
  } finally {
    chmodSync(copy, 0o600);
  }
});

it("safe-stops before sending a starting prompt and returns its early steer", async () => {
  const { StoppedBeforeStartError } = await import("../session/session");
  const { factory, attachments } = scriptedClaudeQuery({ onInput: () => {} });
  const session = await scriptedClaudeFactory({
    configDir: "/accounts/starting-safe-stop",
    query: factory,
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const turn = session.prompt("Start the work.");
  const rejected = expect(turn).rejects.toBeInstanceOf(StoppedBeforeStartError);
  await session.steer("Keep this instruction.");
  await expect(session.stopSafely?.()).resolves.toBe("stopped");
  await rejected;
  expect(attachments.flatMap((attachment) => attachment.inputs)).toEqual([]);
  expect(session.takeUndeliveredSteers()).toEqual(["Keep this instruction."]);
  session.dispose();
  await session.closed();
});

it("disposes a starting prompt only after interrupting the attached client", async () => {
  const { factory, harness } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      emit({ type: "system", subtype: "session_state_changed", state: "running" });
      emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
    },
    onInterrupt: (emit) => {
      emit({ type: "result", subtype: "success", is_error: false, result: "" });
      emit({ type: "system", subtype: "session_state_changed", state: "idle" });
    },
  });
  const session = await scriptedClaudeFactory({
    configDir: "/accounts/starting-dispose",
    query: factory,
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const turn = session.prompt("Start the work.");
  session.dispose();
  await turn;
  await session.closed();
  expect(harness().inputs).toHaveLength(1);
  expect(harness().interrupts()).toBe(1);
  expect(harness().closed()).toBe(true);
  await expect(session.prompt("Cannot start.")).rejects.toThrow("This Claude session has ended.");
  await expect(session.steer("Cannot steer.")).rejects.toThrow("This Claude session has ended.");
});

it("settles a rejected interrupt at the host tick and remains reusable", async () => {
  const { TICK_PERIOD_MS } = await import("../orchestrator/ticker");
  let now = 0;
  const ticks = new Set<(now: number) => void>();
  const notes: string[] = [];
  const { factory, harness } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      emit({ type: "system", subtype: "session_state_changed", state: "running" });
      emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
    },
    onInterrupt: () => {
      throw new Error("Client did not answer.");
    },
  });
  const session = await scriptedClaudeFactory({
    configDir: "/accounts/interrupt-rejection",
    query: factory,
    log: (line) => notes.push(line),
    clock: {
      now: () => now,
      register: (_name, _every, run) => {
        ticks.add(run);
        return () => {
          ticks.delete(run);
        };
      },
    },
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const turn = session.prompt("Start the work.");
  await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
  await session.abort("The turn exceeded its bound.");
  expect(notes).toContain("interrupt failed: Error: Client did not answer.");
  now += TICK_PERIOD_MS;
  for (const tick of ticks) tick(now);
  await turn;
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([
    { type: "turn_failed", taskId: "task-1", error: "The turn exceeded its bound." },
  ]);
  expect(events.filter((event) => event.type === "turn_closed")).toHaveLength(1);
  expect(session.isStreaming()).toBe(false);
  session.dispose();
  await session.closed();
});

// Intent: the refactor preserves input-read notifications even when the
// client's replay acknowledgement arrives just after its idle boundary.
it("still reports a prompt acknowledgement arriving after idle", async () => {
  const { sha256 } = await import("./claudeSessionRecord");
  const text = "Keep the recorded input notification.";
  const { factory } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      emit({ type: "system", subtype: "session_state_changed", state: "running" });
      emit({ type: "result", subtype: "success", is_error: false, result: "Done." });
      emit({ type: "system", subtype: "session_state_changed", state: "idle" });
      emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
    },
  });
  const session = await scriptedClaudeFactory({
    configDir: "/accounts/late-acknowledgement",
    query: factory,
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.prompt(text);
    await session.detach();
    expect(events).toContainEqual({ type: "input_read", textSha256: sha256(text) });
  } finally {
    session.dispose();
    await session.closed();
  }
});

// Intent: the accepted refactor preserves quiet interruption of a
// continuation, including a result already buffered when the tick stops it.
it("drains a wedged continuation's interrupted result without a new failure", async () => {
  const { TICK_PERIOD_MS } = await import("../orchestrator/ticker");
  let now = 0;
  const ticks = new Set<(now: number) => void>();
  const { factory, harness } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      emit({ type: "system", subtype: "session_state_changed", state: "running" });
      emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
      emit({ type: "result", subtype: "success", is_error: false, result: "Done." });
      emit({ type: "system", subtype: "session_state_changed", state: "idle" });
    },
  });
  const session = await scriptedClaudeFactory({
    configDir: "/accounts/continuation-drain",
    query: factory,
    clock: {
      now: () => now,
      register: (_name, _every, run) => {
        ticks.add(run);
        return () => {
          ticks.delete(run);
        };
      },
    },
  }).open(codingSpec({ binding: { backend: "claude", accountId: "claude" }, cwd: "/worktree" }));
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("Start the work.");
  harness().emit({ type: "system", subtype: "session_state_changed", state: "running" });
  await vi.waitFor(() => expect(session.isStreaming()).toBe(true));
  await session.abort();
  harness().emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Interrupted."],
  });
  // The buffered result has not reached the pump when this synchronous
  // tick stops the client. Its result must still classify as interrupted.
  now += TICK_PERIOD_MS;
  for (const tick of ticks) tick(now);
  await session.detach();
  expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
  expect(events.filter((event) => event.type === "continuation_ended")).toHaveLength(1);
  session.dispose();
  await session.closed();
});
