import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answering,
  baseSpec,
  closes,
  createClaudeSession,
  interruptedBy,
  interruptedResult,
  opens,
  result,
  says,
} from "../../../tests/helpers/claudeCrewmateScript";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeFactory,
  scriptedClaudeQuery as scriptedQuery,
  scriptedRecordsFlushed,
} from "../../../tests/helpers/scriptedClaudeQuery";
import { crewmateContractStamp } from "../orchestrator/crewSession";
import { followCompletions } from "../session/followCompletions";
import type { SessionEvent } from "../session/session";
import type { BoundTool } from "../session/tools";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { encodeClaudeProjectDir } from "./claudeTranscript";
import { createClaudeSessionFactory } from "./session";

/**
 * The crewmate's record, its contract across an upgrade and the session's own
 * guardrails on the Claude client, split from `claudeSession.test.ts` along
 * its owners; the scripted client's helpers are `tests/helpers/claudeCrewmateScript.ts`.
 */

beforeEach(() => {
  resetStoreLeasesForTest();
});

afterEach(scriptedRecordsFlushed);

describe("the crewmate's record (the session contract's step 6)", () => {
  it("INF-2248: follows a starting task without blocking discovery and keeps its late transcript completions", async () => {
    const configDir = scratchDir("infinitary-claude-start-lookup-");
    const recordDir = scratchDir("infinitary-claude-start-copy-");
    for (let i = 0; i < 64; i++) {
      mkdirSync(join(configDir, "projects", `-work-older-task-${i}`), { recursive: true });
    }
    const content = readFileSync("CONTRIBUTING.md", "utf8");
    const transcript =
      [
        {
          type: "assistant",
          uuid: "read-start",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "read",
                name: "Read",
                input: { file_path: "CONTRIBUTING.md" },
              },
            ],
          },
        },
        {
          type: "user",
          uuid: "read-end",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read", content, is_error: false }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";
    let client = "";
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        mkdirSync(dirname(client), { recursive: true });
        writeFileSync(client, transcript);
        opens(emit, message);
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    const session = await scriptedClaudeFactory({ configDir, query: factory }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        recordDir,
      }),
    );
    client = join(configDir, "projects", "different-client-encoding", `${session.sessionId}.jsonl`);
    let responsive = false;
    const heartbeat = new Promise<void>((resolve) =>
      setImmediate(() => {
        responsive = true;
        resolve();
      }),
    );
    const seen: SessionEvent[] = [];
    let observed!: () => void;
    const completion = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const began = performance.now();
    const cpu = process.threadCpuUsage();
    const following = followCompletions(
      session,
      (event) => {
        seen.push(event);
        if (event.type === "tool_observation") observed();
      },
      () => 2000,
    );
    const returnedMs = performance.now() - began;
    const stop = await following;
    try {
      expect(responsive).toBe(true);
      await heartbeat;
      await session.prompt("Read CONTRIBUTING.md.");
      await completion;
      expect(readFileSync(session.recordPath() ?? "", "utf8")).toBe(transcript);
      expect(seen.filter((event) => event.type === "tool_observation")).toHaveLength(1);
      if (process.env.INFINITARY_TRANSCRIPT_EVIDENCE) {
        const own = process.threadCpuUsage(cpu);
        console.log(
          JSON.stringify({
            returnedMs,
            elapsedMs: performance.now() - began,
            ownCpuMs: (own.user + own.system) / 1000,
            heartbeatBeforeFollowing: responsive,
            copiedBytes: Buffer.byteLength(transcript),
            completions: 1,
          }),
        );
      }
    } finally {
      await stop();
      session.dispose();
      await session.closed();
    }
  });

  // INF-40 / review G2: a renewed session may still have its previous client attached.
  it("refreshes the attached client's late tail after its next session ID is renewed", async () => {
    const configDir = scratchDir("infinitary-claude-renewed-client-");
    const recordDir = scratchDir("infinitary-claude-renewed-record-");
    const instructions = "Count the footer's rivets.";
    let client = "";
    const line = (text: string) =>
      `${JSON.stringify({ type: "user", uuid: text, message: { role: "user", content: text } })}\n`;
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        appendFileSync(client, line("first"));
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    const session = await scriptedClaudeFactory({ configDir, query: factory }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        recordDir,
        instructions,
        stamp: crewmateContractStamp(instructions, []),
      }),
    );
    const attached = session.sessionId;
    client = join(configDir, "projects", encodeClaudeProjectDir(baseSpec.cwd), `${attached}.jsonl`);
    mkdirSync(dirname(client), { recursive: true });
    try {
      await session.prompt("Read the footer.");
      const copy = session.recordPath() ?? "";
      expect(readFileSync(copy, "utf8")).toBe(line("first"));
      session.serveInstructions({ text: "Count the rivets in pairs.", sha: "rivets-in-pairs" });
      expect(session.sessionId).not.toBe(attached);
      expect(session.takeRenewal()).toMatchObject({ from: attached, changed: ["instructions"] });
      expect(harness().closed()).toBe(false);
      appendFileSync(client, line("late"));
      await session.recordPath({ refresh: true });
      expect(readFileSync(copy, "utf8")).toBe(line("first") + line("late"));
    } finally {
      session.dispose();
      await session.closed();
    }
  });
  // INF-2392: the app kept every Claude session's parsed transcript for as
  // long as it ran; a renewal and an ended session let go of theirs.
  it("lets go of a session's parsed transcript when it renews and when it ends", async () => {
    const configDir = scratchDir("infinitary-claude-release-client-");
    const recordDir = scratchDir("infinitary-claude-release-record-");
    const instructions = "Count the footer's rivets.";
    const store = new SessionRecordStore(recordDir);
    let client = "";
    const clientOf = (id: string) =>
      join(configDir, "projects", encodeClaudeProjectDir(baseSpec.cwd), `${id}.jsonl`);
    const line = (text: string) =>
      `${JSON.stringify({ type: "user", uuid: text, message: { role: "user", content: text } })}\n`;
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        appendFileSync(client, line(`turn-${Date.now()}`));
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    const session = await scriptedClaudeFactory({
      configDir,
      query: factory,
      records: () => store,
    }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        recordDir,
        instructions,
        stamp: crewmateContractStamp(instructions, []),
      }),
    );
    const first = session.sessionId;
    client = clientOf(first);
    mkdirSync(dirname(client), { recursive: true });
    try {
      await session.prompt("Read the footer.");
      expect(session.servedState()).toBeDefined();
      expect(store.holdsParsed(first)).toBe(true);
      session.serveInstructions({ text: "Count the rivets in pairs.", sha: "rivets-in-pairs" });
      const second = session.sessionId;
      expect(second).not.toBe(first);
      expect(store.holdsParsed(first)).toBe(false);
      // The renewed session's copy is kept on disk and read again on demand.
      expect(store.entries(first)).toHaveLength(1);
      store.release(first);
      client = clientOf(second);
      await session.prompt("Read the footer again.");
      expect(session.servedState()).toBeDefined();
      expect(store.holdsParsed(second)).toBe(true);
    } finally {
      session.dispose();
      await session.closed();
    }
    expect(store.holdsParsed(session.sessionId)).toBe(false);
    expect(store.holdsParsed(first)).toBe(false);
  });
  it("copies the turn into its task's record, and on each tick the tail the client wrote after it", async () => {
    const configDir = scratchDir("infinitary-claude-coding-record-");
    const recordDir = scratchDir("infinitary-claude-coding-copy-");
    let client = "";
    const line = (n: number) =>
      `${JSON.stringify({ type: "user", uuid: `line-${n}`, sessionId: "s" })}\n`;
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        // The client records the turn as it runs it.
        appendFileSync(client, line(1));
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    let tick: ((now: number) => void) | undefined;
    const session = await scriptedClaudeFactory({
      configDir,
      query: factory,
      clock: {
        now: () => Date.now(),
        register: (_name, _cadenceMs, run) => {
          tick = run;
          return () => {
            tick = undefined;
          };
        },
      },
    }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        recordDir,
      }),
    );
    client = join(
      configDir,
      "projects",
      encodeClaudeProjectDir(baseSpec.cwd),
      `${session.sessionId}.jsonl`,
    );
    mkdirSync(dirname(client), { recursive: true });
    await session.prompt("go");
    // The prompt's idle boundary copied what the client had written, into
    // the task's own record dir.
    const copy = session.recordPath() ?? "";
    expect(copy).toBe(join(recordDir, `${session.sessionId}.jsonl`));
    expect(readFileSync(copy, "utf8")).toBe(line(1));
    // The client writes the rest of the turn a moment after its idle, and
    // stays attached: the next tick copies it on.
    appendFileSync(client, line(2));
    expect(readFileSync(copy, "utf8")).toBe(line(1));
    tick?.(Date.now());
    expect(readFileSync(copy, "utf8")).toBe(line(1) + line(2));
    session.dispose();
    await session.closed();
  });

  it("keeps its copy when the client's transcript no longer extends it, and says so once (INF-2625's guardrail)", async () => {
    const configDir = scratchDir("infinitary-claude-diverged-client-");
    const recordDir = scratchDir("infinitary-claude-diverged-copy-");
    const notes: string[] = [];
    let client = "";
    const line = (n: number) =>
      `${JSON.stringify({ type: "user", uuid: `line-${n}`, sessionId: "s" })}\n`;
    const { factory } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        appendFileSync(client, line(1));
        closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    let tick: ((now: number) => void) | undefined;
    const session = await scriptedClaudeFactory({
      configDir,
      query: factory,
      log: (note) => notes.push(note),
      clock: {
        now: () => Date.now(),
        register: (_name, _cadenceMs, run) => {
          tick = run;
          return () => {
            tick = undefined;
          };
        },
      },
    }).open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: baseSpec.cwd,
        recordDir,
      }),
    );
    client = join(
      configDir,
      "projects",
      encodeClaudeProjectDir(baseSpec.cwd),
      `${session.sessionId}.jsonl`,
    );
    mkdirSync(dirname(client), { recursive: true });
    await session.prompt("go");
    const copy = session.recordPath() ?? "";
    expect(readFileSync(copy, "utf8")).toBe(line(1));
    // The client's file is rewritten: it no longer starts with what the app copied.
    writeFileSync(client, line(7) + line(8));
    tick?.(Date.now());
    tick?.(Date.now());
    expect(readFileSync(copy, "utf8")).toBe(line(1));
    expect(notes.filter((note) => note.includes("no longer extends"))).toEqual([
      "the client's transcript no longer extends the app's copy; the copy is kept",
    ]);
    session.dispose();
    await session.closed();
  });
});

describe("the crewmate's contract across an upgrade", () => {
  const tool = (name: string, description: string): BoundTool => ({
    name,
    label: name,
    description,
    parameters: Type.Object({ note: Type.String() }),
    run: async () => ({ text: "ok" }),
  });

  /**
   * One conversation reopened on whatever a build would serve it: the
   * client records each one it took a prompt in, as the real client does.
   */
  function conversations() {
    const configDir = scratchDir("infinitary-claude-coding-contract-");
    const recordDir = scratchDir("infinitary-claude-coding-contract-copy-");
    const { factory, harness } = scriptedQuery({
      onInput: answering(() => [result({ cost: 0.01, input: 10, output: 2 })]),
    });
    // One store, flushed after each conversation so the next open reads
    // every stamp the last one wrote.
    const store = new SessionRecordStore(recordDir);
    const sessions = scriptedClaudeFactory({ configDir, query: factory, records: () => store });
    return {
      harness,
      async open(
        instructions: string,
        tools: BoundTool[],
        options: { resume?: string; stamped?: boolean } = {},
      ) {
        const session = await sessions.open(
          codingSpec({
            binding: { backend: "claude", accountId: "acct_claude" },
            cwd: baseSpec.cwd,
            recordDir,
            instructions,
            tools,
            ...(options.stamped === false
              ? {}
              : { stamp: crewmateContractStamp(instructions, tools) }),
            ...(options.resume
              ? { resume: { backend: "claude", sessionId: options.resume } as const }
              : {}),
          }),
        );
        const renewal = session.takeRenewal();
        await session.prompt("carry on");
        const client = join(
          configDir,
          "projects",
          encodeClaudeProjectDir(baseSpec.cwd),
          `${session.sessionId}.jsonl`,
        );
        mkdirSync(dirname(client), { recursive: true });
        appendFileSync(client, `${JSON.stringify({ type: "user", uuid: "u1" })}\n`);
        session.dispose();
        await session.closed();
        await store.flushed();
        return { id: session.sessionId, renewal, resumed: harness().options.resume };
      },
    };
  }

  it("starts over when this build's prompt or a tool it had is described differently, or a tool came or went", async () => {
    const c = conversations();
    const tools = [tool("report", "Report v1."), tool("emit_card", "Show a card v1.")];
    const started = await c.open("Crewmate prompt v1.", tools);
    expect(started.renewal).toBeUndefined();
    const same = await c.open("Crewmate prompt v1.", tools, { resume: started.id });
    expect(same).toMatchObject({ id: started.id, renewal: undefined, resumed: started.id });
    // A tool the task gains or loses: the client would serve the list it
    // recorded at the start, without the new one and with the lost one
    // (INF-750, measured on 2.1.306).
    const gained = await c.open("Crewmate prompt v1.", [...tools, tool("open_change", "PR.")], {
      resume: started.id,
    });
    expect(gained.id).not.toBe(started.id);
    expect(gained.renewal).toEqual({ from: started.id, changed: ["prompt"] });
    expect(gained.resumed).toBeUndefined();
    const lost = await c.open("Crewmate prompt v1.", [tools[0] as BoundTool], {
      resume: started.id,
    });
    expect(lost.id).not.toBe(started.id);
    expect(lost.renewal).toEqual({ from: started.id, changed: ["prompt"] });
    expect(lost.resumed).toBeUndefined();
    // A tool it had, described differently: the client would serve the old words.
    const reworded = await c.open(
      "Crewmate prompt v1.",
      [tool("report", "Report v2."), tools[1] as BoundTool],
      { resume: started.id },
    );
    expect(reworded.id).not.toBe(started.id);
    expect(reworded.renewal).toEqual({ from: started.id, changed: ["prompt"] });
    expect(reworded.resumed).toBeUndefined();
    const upgraded = await c.open(
      "Crewmate prompt v2.",
      [tool("report", "Report v2."), tools[1] as BoundTool],
      { resume: reworded.id },
    );
    expect(upgraded.id).not.toBe(reworded.id);
    expect(upgraded.renewal).toEqual({ from: reworded.id, changed: ["prompt"] });
  });

  it("starts over from a conversation recorded with no contract, from before crewmates were stamped", async () => {
    const c = conversations();
    const tools = [tool("report", "Report v1.")];
    const legacy = await c.open("Crewmate prompt v1.", tools, { stamped: false });
    const reopened = await c.open("Crewmate prompt v1.", tools, { resume: legacy.id });
    expect(reopened.id).not.toBe(legacy.id);
    expect(reopened.renewal).toEqual({ from: legacy.id, changed: ["prompt"] });
    // And it is stamped from here on, so the same build resumes it.
    const again = await c.open("Crewmate prompt v1.", tools, { resume: reopened.id });
    expect(again).toMatchObject({ id: reopened.id, renewal: undefined });
  });
});

describe("the session's own guardrails", () => {
  it("refuses a session on another computer, and a rolling one without the host's clock (INF-2625's guardrail)", async () => {
    const { factory } = scriptedQuery({ onInput: () => {} });
    const spec = codingSpec({
      binding: { backend: "claude", accountId: "acct_claude" },
      cwd: baseSpec.cwd,
    });
    await expect(
      scriptedClaudeFactory({ configDir: baseSpec.configDir, query: factory }).open({
        ...spec,
        machine: "another-computer",
      }),
    ).rejects.toThrow("A Claude session cannot run on machine another-computer.");
    await expect(
      createClaudeSessionFactory({
        configDir: baseSpec.configDir,
        query: factory,
        checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
      }).open(spec),
    ).rejects.toThrow("A rolling Claude session needs the host's clock.");
  });

  it("fails a prompt its client crashed under with the client's error, and attaches a new client for the next (INF-2625's guardrail)", async () => {
    const notes: string[] = [];
    let crashes = true;
    const { factory, harness, attachments } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        if (!crashes) closes(emit, result({ cost: 0.01, input: 10, output: 2 }));
      },
    });
    const session = await createClaudeSession(
      { ...baseSpec, log: (note) => notes.push(note) },
      factory,
    );
    const first = session.prompt("one");
    await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
    harness().fail(new Error("the client crashed"));
    await expect(first).rejects.toThrow("the client crashed");
    expect(notes).toContain("the client stopped: the client crashed");
    expect(session.isStreaming()).toBe(false);
    crashes = false;
    await expect(session.prompt("two")).resolves.toBeUndefined();
    expect(attachments).toHaveLength(2);
    session.dispose();
    await session.closed();
  });

  it("settles a turn the provider already failed quietly when its client then crashes (INF-2625's guardrail)", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        emit({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Claude usage limit reached. Your limit resets at 3pm.",
          total_cost_usd: 0,
          modelUsage: {},
        });
      },
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn_failed")).toBe(true));
    harness().fail(new Error("the client crashed"));
    await expect(turn).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(1);
    session.dispose();
    await session.closed();
  });

  it("stops safely once the calls its client began end, never waiting on a subagent's, and refuses calls meanwhile (INF-2625's guardrail)", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => {
        opens(emit, message);
        // The call as it streams, then as its message records it again.
        emit({
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call-1",
              name: "mcp__infinitary__note_progress",
              input: {},
            },
          },
        });
        emit(says.toolCall("call-1", "mcp__infinitary__note_progress"));
        // A subagent's own call runs inside the call that started it.
        emit({
          type: "assistant",
          parent_tool_use_id: "call-1",
          message: { content: [{ type: "tool_use", id: "sub-1", name: "Read", input: {} }] },
        });
      },
      onInterrupt: interruptedBy(interruptedResult),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(events.some((event) => event.type === "tool_start")).toBe(true));
    const gate = harness().options.hooks?.PreToolUse?.[0]?.hooks[0];
    const ask = () =>
      gate?.({ hook_event_name: "PreToolUse" } as never, undefined, {
        signal: new AbortController().signal,
      });
    expect(await ask()).toEqual({});
    const waited: string[][] = [];
    const stopping = session.stopSafely?.({
      waiting: (calls) => waited.push(calls.map((call) => call.callId)),
    });
    expect(session.stopSafely?.()).toBe(stopping);
    expect(await ask()).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(harness().interrupts()).toBe(0);
    harness().emit(says.toolResult("call-1"));
    await expect(stopping).resolves.toBe("stopped");
    await expect(turn).resolves.toBeUndefined();
    expect(waited).toEqual([["call-1"], []]);
    expect(harness().interrupts()).toBe(1);
    expect(await ask()).toEqual({});
    session.dispose();
    await session.closed();
  });

  it("withdraws a safe stop whose signal was already aborted, and cuts nothing (INF-2625's guardrail)", async () => {
    const { factory, harness } = scriptedQuery({
      onInput: (message, emit) => opens(emit, message),
      onInterrupt: interruptedBy(interruptedResult),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(session.isStreaming()).toBe(true));
    await vi.waitFor(() => expect(harness().inputs).toHaveLength(1));
    await expect(session.stopSafely?.({ signal: AbortSignal.abort() })).resolves.toBe("withdrawn");
    expect(harness().interrupts()).toBe(0);
    session.dispose();
    await expect(turn).resolves.toBeUndefined();
    await session.closed();
  });

  it("refuses a second turn rather than orphaning the first", async () => {
    const { factory } = scriptedQuery({
      onInput: (message, emit) => opens(emit, message),
      onInterrupt: interruptedBy(interruptedResult),
    });
    const session = await createClaudeSession(baseSpec, factory);
    const first = session.prompt("one");
    await expect(session.prompt("two")).rejects.toThrow(/still working/);
    // The first turn is still live and still settles - it was not dropped:
    // a dismissal interrupts it and lets it end.
    await vi.waitFor(() => expect(session.isStreaming()).toBe(true));
    session.dispose();
    await expect(first).resolves.toBeUndefined();
    await session.closed();
  });
});
