import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CLAUDE_MODEL_PROVIDER } from "../../src/core/claude/claudeQueryCore";
import { hasActiveSession, resetStoreLeasesForTest } from "../../src/core/claude/claudeStoreLease";
import { encodeClaudeProjectDir } from "../../src/core/claude/claudeTranscript";
import { createClaudeSessionFactory } from "../../src/core/claude/session";
import type { ModelRuntime } from "../../src/core/pi/types";
import { BoundsWatcher } from "../../src/core/session/bounds";
import {
  CLAUDE_SEAT_TOOL_PREFIX,
  CLAUDE_SEAT_TOOL_SERVER,
} from "../../src/core/storage/sessionReader";
import { SessionRecordStore } from "../../src/core/storage/sessionRecordStore";
import { manualClock } from "./manualClock";
import { scratchDir } from "./scratchDirs";
import {
  type ScriptedAttachment,
  type SDKUserMessage,
  scriptedClaudeQuery,
} from "./scriptedClaudeQuery";
import {
  CONTRACT_TOOL,
  type ContractReply,
  type ContractWorld,
  type ServedRequest,
} from "./sessionContract";

/**
 * Claude's scripted world for the session contract
 * (`tests/helpers/sessionContract.ts`): Claude's factory on a scripted
 * client that speaks the message shapes the real one does - what the model
 * says, and how the client reports a cut-short answer, a refusal and an
 * interrupt. It plays the client the way the options ask for it: a session
 * that asks for its state and acknowledgements (a rolling one) gets a
 * running/idle pair around every turn and an acknowledgement of each pushed
 * message as a turn takes it in, a steer sent during a tool is folded in
 * after the tool's result, as the real client was measured to, the app's
 * tools really run through the app's own server, and a recorded session
 * keeps a transcript where the client keeps one, which a resume reads back. What was served is read off the options
 * and the conversation the client held. The real client's side of the same
 * suite is `claudeSession.contract.integration.test.ts`.
 */

const MODEL = "claude-haiku-4-5";

/** One result message as the client sends it: the answer and its cumulative usage. */
function result(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 0.001,
    modelUsage: {
      [MODEL]: {
        inputTokens: 300,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    ...overrides,
  };
}

const says = {
  running: { type: "system", subtype: "session_state_changed", state: "running" },
  idle: { type: "system", subtype: "session_state_changed", state: "idle" },
  ack: (input: SDKUserMessage) => ({
    type: "user",
    isReplay: true,
    uuid: input.uuid,
    message: input.message,
    parent_tool_use_id: null,
  }),
};

function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

type PlayedClient = {
  attachment: ScriptedAttachment;
  /** It reports its session state and acknowledges pushed messages: a rolling session's client. */
  rolling: boolean;
  /** The session it runs, which every transcript line names. */
  sessionId: string | undefined;
  /** Where it keeps its transcript, when it keeps one. */
  transcript: string | undefined;
  /** What the model has been shown, in order. */
  history: string[];
  /** The last transcript entry, what the next one follows. */
  parent: string | null;
  turn: { steers: SDKUserMessage[]; toolDone: boolean; requests: number } | undefined;
  mcp: Promise<Client | undefined> | undefined;
};

function entryText(entry: {
  message?: { content?: unknown };
  attachment?: { prompt?: unknown };
}): string {
  const content = entry.attachment?.prompt ?? entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("");
}

/** The contract stamps in every sidecar under the app's record dir, in the record's own words. */
function sidecarStamps(dir: string): Record<string, unknown>[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".served.jsonl"));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.kind === "contract")
    .map(({ kind: _kind, at: _at, ...stamp }) => stamp);
}

/** A PreToolUse hook as the client calls it: the input, the call's id, and a signal. */
type PreToolUseHook = (
  input: Record<string, unknown>,
  toolUseId: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** What each world opened that outlives a case: its stores' stamps, its tool clients. */
const lingering: { stores: SessionRecordStore[]; mcps: Promise<Client | undefined>[] } = {
  stores: [],
  mcps: [],
};

export async function scriptedClaudeWorld(
  controls: {
    beforeTool?: () => Promise<void>;
    beforeToolRecord?: () => Promise<void>;
    /**
     * Holds a call's result out of the transcript while the client streams
     * it and goes on to its next request, as the real client can write a
     * result after it reported the call finished.
     */
    beforeResultRecord?: () => Promise<void>;
  } = {},
): Promise<
  ContractWorld & {
    continueTurn: () => void;
    listBackgroundTasks: (tasks: { id: string; type?: string; description: string }[]) => void;
    fold: () => void;
    endClient: (error?: Error) => void;
    /** The stand-in client's own folder, where its config and transcripts live. */
    clientDir: string;
  }
> {
  const root = scratchDir("infinitary-claude-scripted-contract-");
  const configDir = join(root, "claude-config");
  const homeDir = join(root, "home");
  const claudeDir = join(root, "claude");
  mkdirSync(homeDir, { recursive: true });
  // One store per record dir, as production keeps: the seat's, and a crewmate's.
  const records = new Map<string, SessionRecordStore>();
  const recordsIn = (dir: string): SessionRecordStore => {
    let kept = records.get(dir);
    if (!kept) {
      kept = new SessionRecordStore(dir);
      records.set(dir, kept);
      lingering.stores.push(kept);
    }
    return kept;
  };
  const store = recordsIn(claudeDir);
  let reply: ContractReply = { text: "left" };
  let reach: (() => void) | undefined;
  let asked = false;
  const served: ServedRequest[] = [];
  const heard: string[] = [];
  const listening: { text: string; resolve: () => void }[] = [];
  const clients = new Map<ScriptedAttachment, PlayedClient>();
  let toolCalls = 0;

  const hear = (text: string) => {
    heard.push(text);
    for (const listener of listening.filter((entry) => entry.text === text)) {
      listening.splice(listening.indexOf(listener), 1);
      listener.resolve();
    }
  };

  /** The app's in-process tool server, spoken to the way the client speaks to it. */
  const mcpOf = (client: PlayedClient): Promise<Client | undefined> => {
    client.mcp ??= (async () => {
      const server = client.attachment.options.mcpServers?.[CLAUDE_SEAT_TOOL_SERVER];
      if (server?.type !== "sdk") return undefined;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      const mcp = new Client({ name: "infinitary-contract", version: "0" });
      await mcp.connect(clientTransport);
      return mcp;
    })();
    lingering.mcps.push(client.mcp);
    return client.mcp;
  };

  const record = (client: PlayedClient, entry: Record<string, unknown>) => {
    if (!client.transcript) return;
    const uuid = typeof entry.uuid === "string" ? entry.uuid : randomUUID();
    mkdirSync(join(client.transcript, ".."), { recursive: true });
    appendFileSync(
      client.transcript,
      `${JSON.stringify({
        ...entry,
        uuid,
        parentUuid: client.parent,
        sessionId: client.sessionId,
        timestamp: new Date().toISOString(),
      })}\n`,
    );
    client.parent = uuid;
  };

  const clientOf = (attachment: ScriptedAttachment): PlayedClient => {
    const known = clients.get(attachment);
    if (known) return known;
    const options = attachment.options;
    const rolling = options.extraArgs?.["replay-user-messages"] === null;
    const sessionId = options.resume ?? options.sessionId;
    const transcript =
      options.persistSession !== false && sessionId && options.cwd
        ? join(configDir, "projects", encodeClaudeProjectDir(options.cwd), `${sessionId}.jsonl`)
        : undefined;
    const client: PlayedClient = {
      attachment,
      rolling,
      sessionId,
      transcript,
      history: [],
      parent: null,
      turn: undefined,
      mcp: undefined,
    };
    // A resumed session carries on from what the client recorded.
    if (options.resume && transcript && existsSync(transcript)) {
      for (const line of readFileSync(transcript, "utf8").trim().split("\n")) {
        const entry = JSON.parse(line) as Parameters<typeof entryText>[0] & { uuid?: string };
        client.history.push(entryText(entry));
        client.parent = entry.uuid ?? client.parent;
      }
    }
    clients.set(attachment, client);
    return client;
  };

  const endTurn = (client: PlayedClient) => {
    client.turn = undefined;
    if (client.rolling) client.attachment.emit(says.idle);
  };

  /**
   * The model calls a tool: the client runs it through the app's own
   * server and hands the result back. A steer that came during the tool
   * joins the turn after its result, acknowledged as the turn takes it in.
   */
  /**
   * The client asks each PreToolUse hook the session gave it before it runs
   * a call, once the call it streamed has reached the session; a denial's
   * reason is the call's result, and the call never runs.
   */
  const askBeforeCall = async (
    client: PlayedClient,
    id: string,
    name: string,
  ): Promise<string | undefined> => {
    const matchers =
      (client.attachment.options as { hooks?: { PreToolUse?: { hooks: PreToolUseHook[] }[] } })
        .hooks?.PreToolUse ?? [];
    if (matchers.length === 0) return undefined;
    await new Promise((resolve) => setImmediate(resolve));
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const output = await hook(
          {
            hook_event_name: "PreToolUse",
            session_id: "",
            transcript_path: "",
            cwd: "",
            tool_name: name,
            tool_input: {},
            tool_use_id: id,
          },
          id,
          { signal: new AbortController().signal },
        );
        const decision = (
          output as {
            hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
          }
        ).hookSpecificOutput;
        if (decision?.permissionDecision === "deny") return decision.permissionDecisionReason ?? "";
      }
    }
    return undefined;
  };

  const callTool = async (
    client: PlayedClient,
    turn: NonNullable<PlayedClient["turn"]>,
    mcp: Client,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<void> => {
    const { emit } = client.attachment;
    if (controls.beforeTool) {
      await controls.beforeTool();
      if (client.turn !== turn || client.attachment.closed()) return;
    }
    toolCalls += 1;
    const id = `toolu_${toolCalls}`;
    const call = {
      role: "assistant",
      content: [{ type: "tool_use", id, name: `${CLAUDE_SEAT_TOOL_PREFIX}${tool}`, input: args }],
    };
    emit({ type: "assistant", parent_tool_use_id: null, message: call });
    if (controls.beforeToolRecord) {
      await controls.beforeToolRecord();
      if (client.turn !== turn || client.attachment.closed()) return;
    }
    record(client, { type: "assistant", message: call });
    const refusal = await askBeforeCall(client, id, `${CLAUDE_SEAT_TOOL_PREFIX}${tool}`);
    if (client.turn !== turn || client.attachment.closed()) return;
    let content: string;
    if (refusal === undefined) {
      const called = await mcp.callTool({ name: tool, arguments: args });
      if (client.turn !== turn || client.attachment.closed()) return;
      content = (called.content as { type: string; text?: string }[])
        .map((block) => block.text ?? "")
        .join("");
    } else content = refusal;
    const result = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(refusal === undefined ? {} : { is_error: true }),
        },
      ],
    };
    if (controls.beforeResultRecord) {
      const recorded = controls.beforeResultRecord();
      emit({ type: "user", parent_tool_use_id: null, message: result });
      void recorded.then(() => record(client, { type: "user", message: result }));
    } else {
      record(client, { type: "user", message: result });
      emit({ type: "user", parent_tool_use_id: null, message: result });
    }
    client.history.push(content);
    for (const steer of turn.steers.splice(0)) {
      emit(says.ack(steer));
      client.history.push(textOf(steer));
      record(client, {
        type: "attachment",
        attachment: { type: "queued_command", prompt: textOf(steer), source_uuid: steer.uuid },
      });
    }
  };

  const request = async (client: PlayedClient): Promise<void> => {
    const { options, emit } = client.attachment;
    const mcp = await mcpOf(client);
    const cap = options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    const system = options.systemPrompt;
    served.push({
      system: Array.isArray(system)
        ? system.join("\n")
        : typeof system === "object"
          ? `${system.preset}\n${system.append ?? ""}`
          : String(system ?? ""),
      tools: mcp ? (await mcp.listTools()).tools.length : 0,
      maxOutputTokens: cap === undefined ? undefined : Number(cap),
      thinking: options.thinking?.type !== "disabled",
      // With no built-ins named, the client serves its whole coding set.
      coding:
        options.tools === undefined ||
        (!Array.isArray(options.tools) && options.tools.preset === "claude_code"),
      said: client.history.join("\n"),
    });
    asked = true;
    reach?.();
    const playing = reply;
    const turn = client.turn;
    if (turn) turn.requests += 1;
    // The API's first word of a reply, which the client relays; a refused
    // request never starts one.
    if (
      playing === "hang" ||
      playing === "loop" ||
      (playing !== "blockPage" && !("refuse" in playing))
    ) {
      emit({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { usage: { input_tokens: 300 } } },
      });
    }
    if (playing === "hang") return;
    if (playing === "loop") {
      if (!turn || !mcp) return;
      await callTool(client, turn, mcp, CONTRACT_TOOL);
      if (client.turn !== turn || client.attachment.closed()) return;
      const cap = options.maxTurns;
      if (cap !== undefined && turn.requests >= cap) {
        // The client's own stop at its turn cap, in its own words (measured
        // on 2.1.234 and 2.1.283).
        emit(
          result("", {
            subtype: "error_max_turns",
            is_error: true,
            errors: [`Reached maximum number of turns (${cap})`],
          }),
        );
        endTurn(client);
        return;
      }
      await request(client);
      return;
    }
    if (playing === "blockPage") {
      // The real client's own messages for a 403 HTML block page, as the
      // boxed client reports it against the stub API's block page: the
      // sign-in label with the page's title, and the 403 on the result.
      const words = "Failed to authenticate. API Error: Attention Required! | Cloudflare";
      emit({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: words }] },
        error: "authentication_failed",
      });
      emit(result(words, { is_error: true, api_error_status: 403 }));
      endTurn(client);
      return;
    }
    if ("refuse" in playing) {
      const error = playing.refuse === 401 ? "authentication_failed" : "oauth_org_not_allowed";
      emit({ type: "assistant", message: { content: [] }, error });
      emit(result("The API refused the sign-in.", { is_error: true }));
      endTurn(client);
      return;
    }
    if ("cutShort" in playing) {
      emit({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: playing.cutShort }] },
      });
      emit({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { output_tokens: 64 },
        },
      });
      return;
    }
    if ("tool" in playing && turn && !turn.toolDone && mcp) {
      turn.toolDone = true;
      await callTool(client, turn, mcp, playing.tool, playing.args);
      // An interrupt ended the turn while its tool ran: the rest of it is dropped.
      if (client.turn !== turn || client.attachment.closed()) return;
      await request(client);
      return;
    }
    const text = "tool" in playing ? playing.answer : playing.text;
    emit(result(text));
    client.history.push(text);
    record(client, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    endTurn(client);
  };

  const { factory: query, attachments } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      const attachment = attachments.find((entry) => entry.emit === emit);
      if (!attachment) throw new Error("input from no attachment");
      const client = clientOf(attachment);
      hear(textOf(message));
      if (client.turn) {
        // Into the running turn at its next step.
        client.turn.steers.push(message);
        return;
      }
      client.turn = { steers: [], toolDone: false, requests: 0 };
      // LAB (INF-293 reproduction): the real client opens every query with a
      // system init that names the model it runs, the spec's or its default.
      if (!(client as { inited?: boolean }).inited) {
        (client as { inited?: boolean }).inited = true;
        emit({
          type: "system",
          subtype: "init",
          model: (attachment.options as { model?: string }).model ?? "claude-opus-5-5",
        });
      }
      if (client.rolling) {
        emit(says.running);
        emit(says.ack(message));
      }
      client.history.push(textOf(message));
      record(client, {
        type: "user",
        uuid: message.uuid,
        message: { role: "user", content: textOf(message) },
      });
      void request(client);
    },
    onInterrupt: (emit) => {
      const attachment = attachments.find((entry) => entry.emit === emit);
      const client = attachment ? clients.get(attachment) : undefined;
      emit(
        result("", {
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        }),
      );
      if (client) endTurn(client);
    },
  });
  const clock = manualClock();
  return {
    clientDir: root,
    factory: new BoundsWatcher(clock).factory(
      createClaudeSessionFactory({
        configDir,
        env: () => ({ PATH: "/usr/bin", HOME: root }),
        checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
        query,
        clock,
        records: recordsIn,
      }),
    ),
    // INF-341 F1: a background completion starts work without another prompt.
    continueTurn: () => {
      const attachment = attachments.at(-1);
      if (!attachment) throw new Error("No client is attached.");
      const client = clientOf(attachment);
      client.turn = { steers: [], toolDone: false, requests: 0 };
      attachment.emit(says.running);
      void request(client);
    },
    // INF-379: the client's whole list of the background tasks it runs, each
    // time it changes, in the shape measured on 2.1.234.
    listBackgroundTasks: (tasks) => {
      const attachment = attachments.at(-1);
      if (!attachment) throw new Error("No client is attached.");
      attachment.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: tasks.map(({ id, type, description }) => ({
          task_id: id,
          task_type: type ?? "local_bash",
          description,
        })),
        uuid: randomUUID(),
        session_id: clientOf(attachment).sessionId,
      });
    },
    // INF-2599: the client folds its context on its own, between requests,
    // and says so with its compact boundary (the shape `claudeSession.test.ts`
    // reads).
    fold: () => {
      const attachment = attachments.at(-1);
      if (!attachment) throw new Error("No client is attached.");
      attachment.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 160000 },
        uuid: randomUUID(),
        session_id: clientOf(attachment).sessionId,
      });
    },
    endClient: (error) => {
      const attachment = attachments.at(-1);
      if (!attachment) throw new Error("No client is attached.");
      clientOf(attachment).turn = undefined;
      if (error) attachment.fail(error);
      else attachment.end();
    },
    advance: clock.advance,
    binding: { backend: "claude", accountId: "acct_claude" },
    foreignBinding: { backend: "pi", runtime: {} as unknown as ModelRuntime },
    model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    homeDir,
    paths: {
      firstmateHomeDir: homeDir,
      firstmateSessionsDir: join(root, "sessions"),
      firstmateClaudeDir: claudeDir,
    },
    answer: (next) => {
      reply = next;
    },
    reached: () =>
      asked
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            reach = resolve;
          }),
    holds: (_session, text) =>
      heard.includes(text)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            listening.push({ text, resolve });
          }),
    served: () => served,
    records: () =>
      attachments
        .filter((attachment) => attachment.options.persistSession !== false)
        .map(() => "the client's own transcript"),
    stamps: async () => {
      await store.flushed();
      return sidecarStamps(claudeDir);
    },
    released: () =>
      !hasActiveSession(configDir) && attachments.every((attachment) => attachment.closed()),
  };
}

export async function scriptedClaudeCleanup(): Promise<void> {
  resetStoreLeasesForTest();
  await Promise.all(lingering.stores.splice(0).map((store) => store.flushed()));
  for (const mcp of await Promise.all(lingering.mcps.splice(0))) await mcp?.close();
}
