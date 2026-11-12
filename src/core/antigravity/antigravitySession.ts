import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CutOff } from "@shared/authFailure";
import type { Reasoning } from "@shared/reasoning";
import { hostEnv, withTaskShell } from "../hostEnv";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import { stageRunbookSkills } from "../runbooks/runbooks";
import {
  PERSONAL_RESOURCE_RULES,
  personalInstructionsText,
  personalResources,
} from "../session/personalResources";
import { projectInstructions, projectSkillFolders } from "../session/projectResources";
import type {
  ControlProfile,
  ModelSession,
  SessionEvent,
  SessionImage,
  SessionResume,
  SessionSpec,
  ThinkingLevel,
} from "../session/session";
import { claimStagingFolder, type StagingFolder } from "../session/stagingFolders";
import { ACP_AUTH_REQUIRED, AcpConnection, AcpError, isRecord } from "./acpConnection";
import {
  chooseGeminiModel,
  contentText,
  isGeminiModel,
  type ModelChoice,
  modelChoiceOf,
  type OfferedModel,
  openingThinking,
  thinkingChoiceOf,
  toolArgsOf,
  toolNameOf,
  toolResultText,
  usageOf,
  versionAtLeast,
  versionOf,
} from "./acpReading";
import { AcpToolServer } from "./acpToolServer";
import { resolveAgyExecutable } from "./agyExecutable";
import { AntigravityRecord } from "./antigravityRecord";

/**
 * One Antigravity crewmate's conversation, run by the Antigravity program
 * the person installed, in its mode for other apps (`agy acp`, the Agent
 * Client Protocol over its stdin and stdout), on the person's own Google
 * sign-in, which only the program holds (INF-3776, the captain's approved
 * plan). Infinitary never reads that sign-in, never calls Google itself,
 * names itself as itself and offers Gemini models only.
 *
 * The program runs its own coding tools; the app's tools reach it as a
 * loopback MCP server with a key of its own (`AcpToolServer`). Every
 * permission question it asks is answered yes, as a Claude crewmate runs
 * with its permissions skipped. Instructions have no field of their own in
 * the protocol, so the app's arrive at the head of the conversation's first
 * prompt, and again at the head of the next prompt after they change.
 *
 * What it can honestly deliver (`ANTIGRAVITY_CONTROL_PROFILE`): a steer
 * waits for the next turn, since steering a running turn is not proven on
 * the program yet; a turn is stopped with `session/cancel`; background work
 * runs inside the program, out of the host's sight; and only a spent plan
 * arrives typed, as the `refusal` stop, so every other failure is prose.
 */

export const ANTIGRAVITY_CONTROL_PROFILE: ControlProfile = {
  steer: "followup-queue",
  interruptGranularity: "turn",
  quotaEvents: false,
  backgroundWork: "client",
  failureSignals: "text",
};

/** The provider an Antigravity-served model is named under. */
export const ANTIGRAVITY_MODEL_PROVIDER = "google-antigravity";

/**
 * The oldest program served: 1.5.0 added `agy acp`, and 1.5.1 fixed a
 * cancelled prompt also stopping the next one and updates arriving after a
 * prompt's answer (the program's changelog).
 */
export const AGY_OLDEST_SERVED = [1, 5, 1] as const;

/** The Agent Client Protocol version the client speaks. */
const ACP_PROTOCOL_VERSION = 1;

/** How long a cancelled turn may take to end before its program is stopped. */
const CANCEL_GRACE_MS = 10_000;

export const ANTIGRAVITY_WORDS = {
  missing:
    "Antigravity isn't installed on this computer. Install it to use your Google AI plan here.",
  old: `This computer's Antigravity is too old to work with Infinitary. Update it to version ${AGY_OLDEST_SERVED.join(".")} or later.`,
  noTools:
    "This computer's Antigravity cannot reach Infinitary's tools. Update Antigravity, then start the task again.",
  signedOut:
    "Antigravity is not signed in on this computer. Sign in to Antigravity, then start the task again.",
  spent: "Google ended the turn because your plan's allowance for Antigravity is spent.",
  ended: "This Antigravity conversation has ended.",
  busy: "This conversation is still working on its current turn.",
  onlyCrew: "Antigravity runs crewmates only, so far.",
} as const;

/** How a session finds and starts the program; a stand-in replaces it in tests. */
export type AgyLaunch = (env: NodeJS.ProcessEnv) => { command: string; args: string[] } | undefined;

export type AntigravitySessionDeps = {
  /** This app's version, which the client names itself with. */
  clientVersion: string;
  launch?: AgyLaunch;
  log?: (line: string) => void;
  cancelGraceMs?: number;
  now?: () => number;
  /** The home the person's own instructions and skills are read from; this user's by default. */
  home?: string;
  /** The models the program offered when a conversation opened, for the account's own list. */
  onOffered?: (accountId: string, models: readonly OfferedModel[]) => void;
};

/**
 * What a crewmate is told about the person's own Antigravity folder: the
 * program loads its rules, skills, hooks and MCP servers on its own, and
 * nothing it documents for this mode turns that off. Without the personal
 * opt-in none of it is part of the task; with it, its rules and skills may
 * be, but never its MCP servers, which Pi and Claude never offer either.
 */
export const ANTIGRAVITY_PERSONAL_OFF =
  "The person has not shared their own instructions and skills with crewmates. Antigravity may still load rules, skills, hooks or MCP servers from the person's own Antigravity folder (~/.gemini). They are not part of this task: do not follow those rules, and do not use those skills or those servers' tools.";
export const ANTIGRAVITY_PERSONAL_MCP =
  "Antigravity may also load MCP servers from the person's own Antigravity folder (~/.gemini). Do not use those servers' tools: reach services outside the project only through Infinitary's own tools.";

/** A refusal that carries the class it was typed with, when the program typed it. */
class AntigravityRefusal extends Error {
  constructor(
    message: string,
    readonly cutOff?: CutOff,
  ) {
    super(message);
    this.name = "AntigravityRefusal";
  }
}

type Live = { acp: AcpConnection; sessionId: string };
type Running = {
  kind: "running";
  resolve: () => void;
  /** The turn's own words, for the record and its read acknowledgement. */
  text: string;
  read: boolean;
  /** Asked to stop; with words, the turn reports them as its failure. */
  cancel?: { cut?: string };
  ended: Set<string>;
  started: Set<string>;
};
type Turn = { kind: "idle" } | Running;

export const defaultAgyLaunch: AgyLaunch = (env) => {
  const command = resolveAgyExecutable(env);
  return command ? { command, args: ["acp"] } : undefined;
};

export class AntigravitySession implements ModelSession {
  readonly controlProfile = ANTIGRAVITY_CONTROL_PROFILE;
  private id: string | undefined;
  private live: Live | undefined;
  private attaching: Promise<Live> | undefined;
  private turn: Turn = { kind: "idle" };
  private life: "open" | "disposed" = "open";
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private held: string[] = [];
  private record: AntigravityRecord | undefined;
  private model: OfferedModel | undefined;
  /** The model the owner was last told of. */
  private said: string | undefined;
  private opened: Reasoning | undefined;
  private instructions: ServedInstructions | undefined;
  /** The instructions the conversation holds already: a fresh one holds none. */
  private instructionsHeld = false;
  /** The config option that chooses the model, when the program offers one. */
  private modelConfigId: string | undefined;
  private loading = false;
  private staging: StagingFolder | undefined;
  /** The runbook skills staged beside the record, by name and folder. */
  private runbookSkills: { name: string; dir: string }[] = [];
  private afterSettle: (() => void)[] = [];
  private readonly toolServer: AcpToolServer;
  private readonly own: ReadonlySet<string>;
  private readonly retirement: { promise: Promise<void>; resolve: () => void };

  private constructor(
    private readonly spec: SessionSpec,
    private readonly recordDir: string,
    private resumeId: string | undefined,
    private readonly deps: AntigravitySessionDeps,
  ) {
    this.toolServer = new AcpToolServer(spec.tools);
    this.own = new Set(spec.tools.map((tool) => tool.name));
    this.instructions = spec.instructions.served;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.retirement = { promise, resolve };
  }

  /** Opens a crewmate's conversation: the program started, the conversation new or reopened. */
  static async open(spec: SessionSpec, deps: AntigravitySessionDeps): Promise<AntigravitySession> {
    if (spec.shape.turns !== "rolling" || spec.builtins !== "coding") {
      throw new Error(ANTIGRAVITY_WORDS.onlyCrew);
    }
    const record = spec.shape.record;
    const resumeId = record.resume?.backend === "antigravity" ? record.resume.sessionId : undefined;
    const session = new AntigravitySession(spec, record.dir, resumeId, deps);
    try {
      await session.stageSkills();
      await session.attach();
    } catch (caught) {
      session.dispose();
      throw caught;
    }
    return session;
  }

  get sessionId(): string {
    return this.id ?? "";
  }

  resume(): SessionResume | undefined {
    return this.id ? { backend: "antigravity", sessionId: this.id } : undefined;
  }

  recordPath(): string | undefined;
  recordPath(options: { refresh?: boolean }): string | undefined;
  recordPath(): string | undefined {
    return this.record?.path;
  }

  modelRef(): { provider: string; id: string } | undefined {
    return this.model ? { provider: ANTIGRAVITY_MODEL_PROVIDER, id: this.model.id } : undefined;
  }

  modelLabel(): string | undefined {
    return this.model?.name;
  }

  isStreaming(): boolean {
    return this.turn.kind !== "idle";
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string, images?: SessionImage[]): Promise<void> {
    if (this.life !== "open") return Promise.reject(new Error(ANTIGRAVITY_WORDS.ended));
    if (this.isStreaming()) return Promise.reject(new Error(ANTIGRAVITY_WORDS.busy));
    return new Promise<void>((resolve) => {
      const turn: Running = {
        kind: "running",
        resolve,
        text,
        read: false,
        ended: new Set(),
        started: new Set(),
      };
      this.turn = turn;
      void this.run(turn, text, images);
    });
  }

  /**
   * A steer waits for the next turn (`followup-queue`): the owner keeps it on
   * the task's lane, and one handed here anyway is given back undelivered.
   */
  steer(text: string): Promise<void> {
    if (this.life !== "open") return Promise.reject(new Error(ANTIGRAVITY_WORDS.ended));
    this.held.push(text);
    return Promise.resolve();
  }

  takeUndeliveredSteers(): string[] {
    const held = this.held;
    this.held = [];
    return held;
  }

  /** A crewmate's level is fixed when it opens; nothing changes it per turn. */
  setThinkingLevel(_level: ThinkingLevel): void {}

  reasoning(): Reasoning | undefined {
    return this.opened;
  }

  serveInstructions(instructions: ServedInstructions): void {
    if (instructions.sha === this.instructions?.sha) return;
    this.instructions = instructions;
    this.instructionsHeld = false;
  }

  takeRenewal(): undefined {
    return undefined;
  }

  servedState(): ServedState | undefined {
    return undefined;
  }

  async abort(failure?: string): Promise<void> {
    const turn = this.turn;
    if (turn.kind !== "running") return;
    turn.cancel = { cut: failure ?? turn.cancel?.cut };
    const live = this.live;
    if (!live) return;
    live.acp.notify("session/cancel", { sessionId: live.sessionId });
    const timer = setTimeout(() => {
      // The program did not end the turn: stop it, and its exit ends the turn.
      if (this.turn === turn && this.live === live) void live.acp.close(500);
    }, this.deps.cancelGraceMs ?? CANCEL_GRACE_MS);
    timer.unref?.();
  }

  async detach(): Promise<void> {
    if (this.isStreaming()) await new Promise<void>((done) => this.afterSettle.push(done));
    const live = this.live;
    this.live = undefined;
    await live?.acp.close();
  }

  dispose(): void {
    if (this.life === "disposed") return;
    this.life = "disposed";
    const turn = this.turn;
    if (turn.kind === "running") this.finish(turn, { error: ANTIGRAVITY_WORDS.ended });
    const live = this.live;
    this.live = undefined;
    this.staging?.release();
    void (async () => {
      await this.attaching?.catch(() => undefined);
      await Promise.all([live?.acp.close(), this.live?.acp.close(), this.toolServer.stop()]);
      this.retirement.resolve();
    })();
  }

  closed(): Promise<void> {
    return this.retirement.promise;
  }

  // ---- the program ------------------------------------------------------------

  private attach(): Promise<Live> {
    if (this.live) return Promise.resolve(this.live);
    this.attaching ??= this.connect().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  private async connect(): Promise<Live> {
    const env = withTaskShell(hostEnv(), this.spec.shell);
    const launch = (this.deps.launch ?? defaultAgyLaunch)(env);
    if (!launch) throw new Error(ANTIGRAVITY_WORDS.missing);
    const acp = new AcpConnection({ ...launch, cwd: this.spec.cwd, env }, (method, params) =>
      this.answerRequest(method, params),
    );
    acp.onNotification((method, params) => this.onNotification(acp, method, params));
    acp.onExit(() => this.onExit(acp));
    try {
      return await this.handshake(acp);
    } catch (caught) {
      await acp.close(500);
      throw caught;
    }
  }

  private async handshake(acp: AcpConnection): Promise<Live> {
    let init: unknown;
    try {
      init = await acp.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "infinitary", title: "Infinitary", version: this.deps.clientVersion },
      });
    } catch (caught) {
      // A program with no `acp` mode exits on the unknown command.
      if (!acp.alive) throw new Error(ANTIGRAVITY_WORDS.old);
      throw caught;
    }
    const info = isRecord(init) ? init : {};
    const agentInfo = isRecord(info.agentInfo) ? info.agentInfo : {};
    const version = versionOf(agentInfo.version);
    if (version && !versionAtLeast(version, AGY_OLDEST_SERVED)) {
      throw new Error(ANTIGRAVITY_WORDS.old);
    }
    const capabilities = isRecord(info.agentCapabilities) ? info.agentCapabilities : {};
    const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
    // The installed program (1.5.6) advertises no MCP capabilities at all,
    // yet reaches an HTTP tool server named in `session/new` and lists its
    // tools before it answers. A program that says it serves HTTP is
    // trusted; any other is held to that listing, its one observable sign.
    if (mcp.http === false) throw new Error(ANTIGRAVITY_WORDS.noTools);
    const advertised = mcp.http === true;
    const address = await this.toolServer.start();
    this.toolServer.takeListed();
    const mcpServers = [{ type: "http", ...address }];
    const cwd = this.spec.cwd;
    let opened: unknown;
    let sessionId: string | undefined;
    // The recorded conversation when the session opens, its own after the
    // program stops. A recorded one gets the instructions again on its first
    // prompt: nothing this session sent is in it yet (`instructionsHeld`).
    const reopen = this.resumeId ?? this.id;
    if (reopen) {
      const sessions = isRecord(capabilities.sessionCapabilities)
        ? capabilities.sessionCapabilities
        : {};
      const method =
        sessions.resume !== undefined && sessions.resume !== null
          ? "session/resume"
          : capabilities.loadSession === true
            ? "session/load"
            : undefined;
      if (method) {
        this.loading = method === "session/load";
        try {
          opened = await acp.request(method, { sessionId: reopen, cwd, mcpServers });
          sessionId = reopen;
        } catch (caught) {
          if (caught instanceof AcpError && caught.code === ACP_AUTH_REQUIRED) throw signedOut();
          if (!acp.alive) throw caught;
          this.note(`the program could not reopen conversation ${reopen}; starting fresh`);
        } finally {
          this.loading = false;
        }
      } else {
        this.note("the program reopens no conversation; starting fresh");
      }
      this.resumeId = undefined;
    }
    if (!sessionId) {
      try {
        opened = await acp.request("session/new", { cwd, mcpServers });
      } catch (caught) {
        if (caught instanceof AcpError && caught.code === ACP_AUTH_REQUIRED) throw signedOut();
        throw caught;
      }
      sessionId = isRecord(opened) && typeof opened.sessionId === "string" ? opened.sessionId : "";
      if (!sessionId) throw new Error("Antigravity opened no conversation.");
      this.instructionsHeld = false;
    }
    if (!advertised && !this.toolServer.takeListed()) throw new Error(ANTIGRAVITY_WORDS.noTools);
    const live: Live = { acp, sessionId };
    await this.chooseModel(live, opened);
    if (this.id !== sessionId || !this.record) {
      this.id = sessionId;
      this.record = new AntigravityRecord(
        AntigravityRecord.pathIn(this.recordDir, sessionId),
        sessionId,
        cwd,
        this.deps.now,
      );
    }
    if (this.spec.shape.turns === "rolling") this.record.stamp(this.spec.shape.record.stamp);
    this.live = live;
    return live;
  }

  /** The Gemini model and the thinking level the conversation runs at, set once per attachment. */
  private async chooseModel(live: Live, opened: unknown): Promise<void> {
    const choice: ModelChoice = modelChoiceOf(opened);
    // The models the program offers this sign-in, the account's own list.
    if (choice.offered.length > 0 && this.spec.binding.backend === "antigravity") {
      this.deps.onOffered?.(this.spec.binding.accountId, choice.offered);
    }
    const wanted = this.spec.model?.id ?? this.model?.id;
    const chosen = chooseGeminiModel(choice, wanted);
    if (typeof chosen === "string") throw new Error(chosen);
    this.modelConfigId = choice.configId;
    if (chosen.id !== choice.current) await this.setModel(live, chosen.id);
    const thinking = openingThinking(
      thinkingChoiceOf(opened),
      this.spec.thinking.level,
      this.spec.thinking.quick === true,
    );
    const choiceOfThinking = thinkingChoiceOf(opened);
    if (thinking.value !== undefined && choiceOfThinking) {
      await live.acp.request("session/set_config_option", {
        sessionId: live.sessionId,
        configId: choiceOfThinking.configId,
        value: thinking.value,
      });
    }
    this.opened = thinking.reasoning;
    this.serve(chosen);
  }

  /** Asks the program for a model, by its model selector when it offers one. */
  private async setModel(live: Live, id: string): Promise<void> {
    if (this.modelConfigId) {
      await live.acp.request("session/set_config_option", {
        sessionId: live.sessionId,
        configId: this.modelConfigId,
        value: id,
      });
    } else {
      await live.acp.request("session/set_model", { sessionId: live.sessionId, modelId: id });
    }
  }

  /** The model the conversation runs on now, said to the owner inside a turn. */
  private serve(model: OfferedModel): void {
    this.model = model;
    if (this.turn.kind === "running") this.sayModel();
  }

  /** Says the model when it is news: its first turn, and every change after it. */
  private sayModel(): void {
    const model = this.model;
    if (!model || model.id === this.said) return;
    this.said = model.id;
    this.emit({
      type: "model_served",
      model: { provider: ANTIGRAVITY_MODEL_PROVIDER, id: model.id },
    });
  }

  private async answerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission" && isRecord(params)) {
      const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
      // Once before always: a remembered grant could leave rules behind in
      // the person's Antigravity settings or the working copy.
      const pick =
        options.find((option) => option.kind === "allow_once") ??
        options.find((option) => option.kind === "allow_always");
      return pick && typeof pick.optionId === "string"
        ? { outcome: { outcome: "selected", optionId: pick.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    throw new AcpError(-32601, `Infinitary does not answer ${method}.`);
  }

  private onExit(acp: AcpConnection): void {
    if (this.live?.acp !== acp) return;
    this.live = undefined;
    const turn = this.turn;
    if (turn.kind === "running") {
      this.finish(turn, { error: acp.stoppedText(), cut: turn.cancel?.cut });
    }
  }

  private onNotification(acp: AcpConnection, method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params) || this.loading) return;
    if (this.live?.acp !== acp || params.sessionId !== this.live.sessionId) return;
    const turn = this.turn;
    const update = isRecord(params.update) ? params.update : undefined;
    if (!update) return;
    if (
      update.sessionUpdate === "config_option_update" ||
      update.sessionUpdate === "current_model_update"
    ) {
      this.noteModel(update);
      return;
    }
    if (turn.kind !== "running" || !this.record) return;
    this.read(turn);
    const taskId = this.spec.owner;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (!text) return;
        this.record.text(text);
        this.emit({ type: "assistant_delta", taskId, text });
        return;
      }
      case "agent_thought_chunk": {
        const text = contentText(update.content);
        if (!text) return;
        this.record.thinking(text);
        this.emit({ type: "thinking_delta", taskId, text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (!callId) return;
        if (!turn.started.has(callId)) {
          if (update.sessionUpdate !== "tool_call") return;
          turn.started.add(callId);
          const toolName = toolNameOf(update, this.own);
          this.record.toolCall(callId, toolName, toolArgsOf(update));
          this.emit({ type: "tool_start", taskId, callId, toolName });
        }
        if (
          (update.status === "completed" || update.status === "failed") &&
          !turn.ended.has(callId)
        ) {
          turn.ended.add(callId);
          const isError = update.status === "failed";
          const toolName = this.record.toolNameOf(callId);
          this.record.toolResult(callId, toolResultText(update), isError);
          this.emit({ type: "tool_end", taskId, callId, toolName, isError });
          // The model's next request follows the tool's answer.
          this.emit({ type: "request_started" });
        }
        return;
      }
      default:
        return;
    }
  }

  /** The program said which model answers now; a non-Gemini one is never asked for. */
  private noteModel(update: Record<string, unknown>): void {
    const choice = modelChoiceOf(
      update.sessionUpdate === "current_model_update"
        ? { models: { currentModelId: update.currentModelId, availableModels: [] } }
        : { configOptions: update.configOptions },
    );
    if (!choice.current) return;
    const known = choice.offered.find((model) => model.id === choice.current) ?? {
      id: choice.current,
      name: this.model?.id === choice.current ? this.model.name : choice.current,
    };
    if (isGeminiModel(known)) {
      this.serve(known);
      return;
    }
    // Gemini only (INF-3776): the conversation is moved back to its Gemini
    // model. When it cannot be, a running turn ends and the program is
    // stopped, so the next prompt reattaches and chooses a Gemini model again
    // or refuses (`chooseModel`).
    this.note(`the program moved the conversation to ${known.id}; moving it back`);
    const live = this.live;
    if (!live) return;
    const refuse = () => {
      if (this.live !== live) return;
      const turn = this.turn;
      if (turn.kind === "running") {
        this.finish(turn, {
          error: `Infinitary runs Antigravity on Gemini models only, and ${known.name} is not one.`,
        });
      }
      this.live = undefined;
      void live.acp.close(500);
    };
    const back = this.model;
    if (!back) refuse();
    else this.setModel(live, back.id).catch(refuse);
  }

  // ---- a turn -----------------------------------------------------------------

  private async run(turn: Running, text: string, images?: SessionImage[]): Promise<void> {
    let live: Live;
    try {
      live = await this.attach();
    } catch (caught) {
      this.fail(turn, caught);
      return;
    }
    if (this.turn !== turn) return;
    if (turn.cancel) {
      this.finish(turn, { cancelled: true, cut: turn.cancel.cut });
      return;
    }
    const blocks: Record<string, unknown>[] = [];
    const lead = this.instructionsHeld ? undefined : this.instructionsText();
    if (lead) blocks.push({ type: "text", text: lead });
    blocks.push({ type: "text", text });
    for (const image of images ?? []) {
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    this.record?.user(text, images);
    this.emit({ type: "request_started" });
    this.sayModel();
    let answer: unknown;
    try {
      answer = await live.acp.request("session/prompt", {
        sessionId: live.sessionId,
        prompt: blocks,
      });
    } catch (caught) {
      if (this.turn !== turn) return;
      if (!live.acp.alive) {
        this.finish(turn, { error: live.acp.stoppedText(), cut: cutOf(turn) });
        return;
      }
      this.fail(turn, caught);
      return;
    }
    if (lead) this.instructionsHeld = true;
    if (this.turn !== turn) return;
    this.read(turn);
    const stop = isRecord(answer) ? answer.stopReason : undefined;
    const usage = usageOf(answer);
    switch (stop) {
      case "end_turn":
        this.finish(turn, { usage });
        return;
      case "cancelled":
        this.finish(turn, { usage, cancelled: true, cut: cutOf(turn) });
        return;
      case "refusal":
        // The one typed failure the program sends: a spent plan (INF-3776).
        this.finish(turn, {
          usage,
          error: ANTIGRAVITY_WORDS.spent,
          cutOff: { class: "no_headroom" },
        });
        return;
      default:
        this.finish(turn, {
          usage,
          error: `Antigravity stopped the turn at its own limit (${String(stop ?? "no reason given")}).`,
          length: true,
        });
    }
  }

  private fail(turn: Running, caught: unknown): void {
    if (caught instanceof AcpError && caught.code === ACP_AUTH_REQUIRED) caught = signedOut();
    const message = caught instanceof Error ? caught.message : String(caught);
    this.finish(turn, {
      error: message,
      ...(caught instanceof AntigravityRefusal && caught.cutOff ? { cutOff: caught.cutOff } : {}),
    });
  }

  /** One exit for a turn: its record, its failure if any, its end and its closing words. */
  private finish(
    turn: Running,
    end: {
      usage?: ReturnType<typeof usageOf>;
      error?: string;
      cutOff?: CutOff;
      cancelled?: boolean;
      cut?: string;
      length?: boolean;
    },
  ): void {
    if (this.turn !== turn) return;
    this.turn = { kind: "idle" };
    const taskId = this.spec.owner;
    const text = this.record?.openText().trim() || undefined;
    const failure = end.cancelled ? end.cut : (end.error ?? end.cut);
    this.record?.end(
      end.cancelled ? "aborted" : end.length ? "length" : failure ? "error" : "stop",
      this.modelRef(),
      failure,
    );
    if (failure !== undefined) {
      this.emit({
        type: "turn_failed",
        taskId,
        error: failure,
        ...(end.cutOff ? { cutOff: end.cutOff } : {}),
      });
    }
    this.emit({ type: "turn_end", taskId, ...(end.usage ? { usage: end.usage } : {}) });
    this.emit({ type: "turn_closed", ...(failure === undefined && text ? { text } : {}) });
    turn.resolve();
    const waiting = this.afterSettle;
    this.afterSettle = [];
    for (const done of waiting) done();
  }

  private read(turn: Running): void {
    if (turn.read) return;
    turn.read = true;
    this.emit({
      type: "input_read",
      textSha256: createHash("sha256").update(turn.text).digest("hex"),
    });
  }

  // ---- instructions -----------------------------------------------------------

  /**
   * The app's instructions as the head of a prompt: the role's base, the
   * served text, the working copy's own instruction file, read now, the
   * person's own instructions under the personal opt-in, and the skills -
   * the working copy's, the person's under the opt-in, then the runbook
   * skills none of them names (FI3-789, as Pi and Claude serve them). Without
   * the opt-in the crewmate is told to leave alone what the program loads
   * from the person's own Antigravity folder, which the protocol cannot turn
   * off.
   */
  private instructionsText(): string {
    const parts = [this.spec.instructions.base];
    if (this.instructions?.text) parts.push(this.instructions.text);
    const project = projectInstructions(this.spec.cwd);
    if (project) {
      parts.push(
        `The working copy's own instructions, from ${project.path}:\n<project_instructions>\n${project.content}\n</project_instructions>`,
      );
    }
    const projectSkills = projectSkillFolders(this.spec.cwd);
    const personal = this.spec.personalResources
      ? personalResources(this.deps.home, new Set(projectSkills.map((skill) => skill.name)))
      : undefined;
    if (personal) {
      parts.push(
        personal.instructions
          ? personalInstructionsText(personal.instructions)
          : PERSONAL_RESOURCE_RULES,
      );
      parts.push(ANTIGRAVITY_PERSONAL_MCP);
    } else {
      parts.push(ANTIGRAVITY_PERSONAL_OFF);
    }
    const taken = new Set<string>();
    const lines: string[] = [];
    for (const skill of [...projectSkills, ...(personal?.skills ?? []), ...this.runbookSkills]) {
      if (taken.has(skill.name)) continue;
      taken.add(skill.name);
      lines.push(skillLine(skill));
    }
    if (lines.length > 0) {
      parts.push(
        `Your skills: when your work matches a skill's description, read its SKILL.md with your file tool before you go on, and follow it.\n${lines.join("\n")}`,
      );
    }
    return `Infinitary's instructions for this conversation follow. They hold for every turn until new ones arrive.\n<instructions>\n${parts.join("\n\n")}\n</instructions>`;
  }

  /**
   * The runbook skills a crewmate's instructions name, written beside its
   * record, and listed for its model with where each one's SKILL.md is.
   */
  private async stageSkills(): Promise<void> {
    const skills = this.spec.runbookSkills;
    if (!skills || skills.length === 0) return;
    this.staging = await claimStagingFolder(this.recordDir);
    this.runbookSkills = await stageRunbookSkills(skills, join(this.staging.dir, "runbook-skills"));
  }

  private note(line: string): void {
    this.deps.log?.(`[${this.spec.owner}] ${line}`);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** A skill as its model reads it: its name, where its SKILL.md is, and its description. */
function skillLine(skill: { name: string; dir: string }): string {
  const file = join(skill.dir, "SKILL.md");
  let head = "";
  try {
    head = readFileSync(file, "utf8");
  } catch {
    // Unreadable: listed by its name and file alone.
  }
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim();
  return `- ${skill.name} (${file})${description ? `: ${description}` : ""}`;
}

/** A turn's cut, read fresh: an abort can arrive while the turn awaits its answer. */
function cutOf(turn: Running): string | undefined {
  return (turn as { cancel?: { cut?: string } }).cancel?.cut;
}

function signedOut(): AntigravityRefusal {
  return new AntigravityRefusal(ANTIGRAVITY_WORDS.signedOut, { class: "signed_out" });
}
