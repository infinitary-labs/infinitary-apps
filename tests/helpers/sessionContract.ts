import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAuthFailureMessage } from "@shared/authFailure";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  crewmateResume,
  crewmateResumeToken,
  crewmateSessionSpec,
} from "../../src/core/orchestrator/crewSession";
import {
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  FIRSTMATE_MAX_OUTPUT_TOKENS,
  FIRSTMATE_REQUEST_TIMEOUT_MS,
  FIRSTMATE_TURN_TIMEOUT_MS,
  firstmateContractStamp,
  type SeatSessionInput,
  type ServedInstructions,
  seatSessionSpec,
} from "../../src/core/orchestrator/seat";
import { TICK_PERIOD_MS } from "../../src/core/orchestrator/ticker";
import { type AppPaths, appPathsFor, crewmateSessionsDir } from "../../src/core/paths";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { requestTimeoutErrorMessage, turnTimeoutErrorMessage } from "../../src/core/session/bounds";
import { questionSessionSpec } from "../../src/core/session/questionSession";
import {
  LOCAL_MACHINE_ID,
  type ModelSession,
  SAFE_STOP_BLOCKED_TEXT,
  type SessionBackend,
  type SessionBinding,
  type SessionEvent,
  type SessionFactory,
  type SessionResume,
  type SessionSpec,
  StoppedBeforeStartError,
} from "../../src/core/session/session";
import { type BoundTool, boundTool } from "../../src/core/session/tools";
import { readSession, type SessionRead } from "../../src/core/storage/sessionReader";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type Reply,
  type StubRequest,
  startStubApi,
  writeAnthropicError,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "./anthropicDialect";

/**
 * The one session contract's behavioral suite (`src/core/session/`): the
 * same cases, with the same assertions, run against every backend's
 * factory through a harness that plays the model. Pi runs for real against
 * a local stub API, Claude runs on a scripted client that speaks the real
 * one's message shapes, and Claude runs again on the SDK's own co-released
 * client, boxed against the same stub API. A backend passes the contract
 * only when all of its harnesses do.
 *
 * The cases are the roles' own presets, opened the way their owners open
 * them: the question's one-shot (`questionSessionSpec`) and the Firstmate
 * seat's rolling session (`seatSessionSpec`), the crewmate's coding session
 * (`crewmateSessionSpec`), plus a fourth preset no role has - one bound tool
 * on a one-shot - which every backend serves with no edit of its own. Every
 * factory is opened the way the app opens it, under the one watcher of the
 * watched bounds (`BoundsWatcher`), on a host clock the case moves one tick
 * at a time: a bound is a number of ticks, never a wall-clock wait.
 */

/** How the model answers the next request. */
export type ContractReply =
  | { text: string }
  /** The output cap cut the answer short. */
  | { cutShort: string }
  /** The API refuses the sign-in: 401 as signed out, 403 as an organisation refusal. */
  | { refuse: 401 | 403 }
  /**
   * A firewall in front of the API answers instead: a 403 HTML block page,
   * the shape a network block returned to a crewmate's request (INF-4072).
   */
  | "blockPage"
  /** The API goes quiet mid-answer and never finishes. */
  | "hang"
  /** The model calls the named tool, with `args` or none, and answers once it has the tool's result. */
  | { tool: string; answer: string; args?: Record<string, unknown> }
  /** The model calls the contract tool on every request and never answers. */
  | "loop";

export type ServedRequest = {
  system: string;
  tools: number;
  maxOutputTokens: number | undefined;
  thinking: boolean;
  /** The backend's coding set (read, bash, edit, write, ...) was offered beside the role's tools. */
  coding: boolean;
  /** Everything the request showed the model after its system prompt, as one string. */
  said: string;
};

/** One contract stamp as the backend recorded it, in the record's own words. */
export type RecordedStamp = Record<string, unknown>;

/** One backend's world for one case: a factory, what it serves, and the model's side. */
export type ContractWorld = {
  /** The backend's factory under the one watcher, both on this world's clock. */
  factory: SessionFactory;
  /**
   * The machine every case opens its session on: this Mac
   * (`LOCAL_MACHINE_ID`) unless the world holds it on a computer that runs
   * work (src/core/placed/).
   */
  machine?: string;
  /** Moves the host's one clock on by `ms`: one tick of everything registered on it. */
  advance: (ms: number) => void;
  binding: SessionBinding;
  /** A binding of the other backend: what this factory must refuse. */
  foreignBinding: SessionBinding;
  model: { provider: string; id: string };
  homeDir: string;
  /** Where a rolling role keeps its record, per backend (the seat preset's paths). */
  paths: SeatSessionInput["paths"];
  /** Scripts the model's answers from now on. */
  answer: (reply: ContractReply) => void;
  /** Resolves once the question has reached the model. */
  reached: () => Promise<void>;
  /** Resolves once the backend holds a steer's words for the running turn. */
  holds: (session: ModelSession, text: string) => Promise<void>;
  /** Every request the session made of the model, in order. */
  served: () => ServedRequest[];
  /** Every session record the backend wrote anywhere. */
  records: () => string[];
  /** The contract stamps in every rolling record, oldest first, once they have landed. */
  stamps: () => Promise<RecordedStamp[]>;
  /** The backend holds nothing any more: no request open, no client, no store. */
  released: () => boolean;
};

/** The roles' presets the suite opens, and the fourth preset no role has. */
export type ContractRole = "question" | "seat" | "crewmate" | "fourth";

export type SessionContractHarness = {
  /** Named in the suite's title. */
  name: string;
  backend: SessionBackend;
  /**
   * The presets its factory serves; every one unless named. A conversation
   * held on another computer is only ever a crewmate's.
   */
  roles?: readonly ContractRole[];
  /** A fresh world per case. */
  world: () => Promise<ContractWorld>;
  /**
   * The crewmate's session stops safely (`ModelSession.stopSafely`); a
   * conversation held on another computer does not yet, and its owner cuts
   * the turn instead.
   */
  stopsSafely?: boolean;
  /** Called after every case. */
  cleanup?: () => Promise<void>;
};

/** The question every case asks: its instruction names both options. */
export const CONTRACT_INSTRUCTION =
  "You answer one contract question. Answer with exactly one of: left, right.";

/** The tool every rolling case serves, and the fourth preset's one tool. */
export const CONTRACT_TOOL = "look_up";

export const CONTRACT_TOOL_RESULT = "The record says left.";

const QUESTION = "Which way?";

export const CREWMATE_TASK = "task-contract";

/** The built-ins every backend's coding set names, in any case. */
const CODING_BUILTINS = ["read", "bash", "edit", "write"];

/** The captain-owned text served after the seat's prompt, and a later edit of it. */
const SERVED: ServedInstructions = {
  text: "Serve the contract in one word.",
  sha: "sha-served-one",
};
const CHANGED: ServedInstructions = {
  text: "Serve the contract in two words.",
  sha: "sha-served-two",
};

/** The contract tool, whose every run the case can count or hold. */
function contractTool(run: () => void | Promise<void> = () => {}): BoundTool {
  return boundTool({
    name: CONTRACT_TOOL,
    label: "Look up",
    description: "Look the contract answer up.",
    parameters: Type.Object({}),
    run: async () => {
      await run();
      return { text: CONTRACT_TOOL_RESULT };
    },
  });
}

/** A request is the app's when it asks the contract question or serves the contract tool. */
function isContractRequest(body: StubRequest["body"]): boolean {
  return (
    JSON.stringify(body.system ?? "").includes(CONTRACT_INSTRUCTION) ||
    (body.tools ?? []).some(
      (tool) => tool.name === CONTRACT_TOOL || tool.name.endsWith(`__${CONTRACT_TOOL}`),
    )
  );
}

/**
 * The stub API the two harnesses that reach a real backend share (Pi, and
 * Claude's real client): it keeps the contract's requests and answers a
 * client's own housekeeping on its own.
 */
export function startContractApi() {
  return startStubApi(isContractRequest);
}

/** How the stub API plays a reply, in the Anthropic dialect both backends read. */
export function stubReply(reply: ContractReply): Reply {
  return (request, res) => {
    if (reply === "hang") {
      beginAnthropicStream(res, 300, request.n);
      return;
    }
    if (reply === "loop") {
      beginAnthropicStream(res, 300, request.n);
      const name =
        request.body.tools?.find(
          (tool) => tool.name === CONTRACT_TOOL || tool.name.endsWith(`__${CONTRACT_TOOL}`),
        )?.name ?? CONTRACT_TOOL;
      writeAnthropicToolUse(res, 0, { id: `toolu_${request.n}`, name, args: {} });
      finishAnthropicStream(res, "tool_use", 7);
      return;
    }
    if (reply === "blockPage") {
      res.writeHead(403, { "content-type": "text/html; charset=UTF-8" });
      res.end(
        "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>" +
          "<body><h1>Sorry, you have been blocked</h1></body></html>",
      );
      return;
    }
    if ("refuse" in reply) {
      if (reply.refuse === 401) {
        writeAnthropicError(res, 401, {
          type: "authentication_error",
          message: "invalid x-api-key",
        });
      } else {
        writeAnthropicError(res, 403, {
          type: "permission_error",
          message: "OAuth authentication is currently not allowed for this organization.",
        });
      }
      return;
    }
    beginAnthropicStream(res, 300, request.n);
    if ("cutShort" in reply) {
      writeAnthropicText(res, 0, reply.cutShort);
      finishAnthropicStream(res, "max_tokens", CLASSIFIER_MAX_OUTPUT_TOKENS);
      return;
    }
    if ("tool" in reply && !request.raw.includes('"tool_result"')) {
      // The tool under the name this request served it as.
      const name =
        request.body.tools?.find(
          (tool) => tool.name === reply.tool || tool.name.endsWith(`__${reply.tool}`),
        )?.name ?? reply.tool;
      writeAnthropicToolUse(res, 0, { id: `toolu_${request.n}`, name, args: reply.args ?? {} });
      finishAnthropicStream(res, "tool_use", 7);
      return;
    }
    writeAnthropicText(res, 0, "tool" in reply ? reply.answer : reply.text);
    finishAnthropicStream(res, "end_turn", 2);
  };
}

export function servedByStub(request: StubRequest): ServedRequest {
  const tools = new Set((request.body.tools ?? []).map((tool) => tool.name.toLowerCase()));
  return {
    system: JSON.stringify(request.body.system ?? ""),
    tools: tools.size,
    maxOutputTokens: request.body.max_tokens,
    thinking: request.body.thinking !== undefined && request.body.thinking.type !== "disabled",
    coding: CODING_BUILTINS.every((name) => tools.has(name)),
    said: JSON.stringify(request.body.messages ?? []),
  };
}

function recorder(session: ModelSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function failures(events: SessionEvent[]): Extract<SessionEvent, { type: "turn_failed" }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "turn_failed" }> =>
      event.type === "turn_failed",
  );
}

function closingWords(events: SessionEvent[]): string | undefined {
  return events.filter((event) => event.type === "turn_closed").at(-1)?.text;
}

function toolEvents(events: SessionEvent[]): unknown[] {
  return events.flatMap((event): unknown[] =>
    event.type === "tool_start"
      ? [{ start: event.toolName, taskId: event.taskId }]
      : event.type === "tool_end"
        ? [{ end: event.toolName, isError: event.isError }]
        : [],
  );
}

function machineOf(world: ContractWorld): string {
  return world.machine ?? LOCAL_MACHINE_ID;
}

function questionOn(world: ContractWorld, overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    ...questionSessionSpec({
      homeDir: world.homeDir,
      binding: world.binding,
      model: world.model,
      instruction: CONTRACT_INSTRUCTION,
    }),
    machine: machineOf(world),
    ...overrides,
  };
}

/** The Firstmate seat, opened the way the agent opens it, with the contract tool. */
function seatOn(
  world: ContractWorld,
  options: { tools?: BoundTool[]; resume?: SessionResume } = {},
): SessionSpec {
  return {
    ...seatSessionSpec({
      paths: world.paths,
      binding: world.binding,
      model: world.model,
      tools: options.tools ?? [contractTool()],
      instructions: SERVED,
      ...(options.resume ? { resume: options.resume } : {}),
    }),
    machine: machineOf(world),
  };
}

/** The app's folders a contract crewmate's task keeps its record under. */
function crewPaths(world: ContractWorld): AppPaths {
  return appPathsFor(join(world.homeDir, "..", "crew"));
}

/**
 * A crewmate, opened the way the supervisor opens it (its task's worktree,
 * its record under the crew's dir), serving the contract tool in place of
 * the callbacks a task binds.
 */
function crewmateOn(
  world: ContractWorld,
  options: { tools?: BoundTool[]; resumeToken?: string } = {},
): SessionSpec {
  const spec = crewmateSessionSpec(
    crewPaths(world),
    {
      taskId: CREWMATE_TASK,
      machineId: machineOf(world),
      cwd: world.homeDir,
      model: world.model,
      ...(options.resumeToken ? { resumeToken: options.resumeToken } : {}),
    },
    world.binding,
  );
  return { ...spec, tools: options.tools ?? [contractTool()] };
}

/** A tool that waits at a gate: the turn is provably mid-tool while it holds. */
function gated(): {
  tool: BoundTool;
  entered: Promise<void>;
  open: () => void;
  runs: () => number;
} {
  let entered!: () => void;
  let open!: () => void;
  let runs = 0;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    tool: contractTool(async () => {
      runs += 1;
      entered();
      await gate;
    }),
    entered: enteredPromise,
    open,
    runs: () => runs,
  };
}

function conversationOf(read: SessionRead): { role: string; text: string }[] {
  return read.entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return [];
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part: { type?: unknown; text?: unknown }) =>
                part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
              )
              .join("")
          : "";
    return text ? [{ role: message.role, text }] : [];
  });
}

/** Resolves once the session has said `count` model requests started: the order a clock case waits on. */
async function requestsStarted(events: SessionEvent[], count = 1): Promise<void> {
  await vi.waitFor(() =>
    expect(
      events.filter((event) => event.type === "request_started").length,
    ).toBeGreaterThanOrEqual(count),
  );
}

async function toolStarted(events: SessionEvent[]): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.type === "tool_start")).toBe(true));
}

/** Resolves whichever way a promise settles: a case asks only THAT it settled. */
function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

export function describeSessionContract(harness: SessionContractHarness): void {
  const serves = (role: ContractRole) => !harness.roles || harness.roles.includes(role);
  const describeQuestion = serves("question") ? describe : describe.skip;
  const describeSeat = serves("seat") ? describe : describe.skip;
  const describeCrewmate = serves("crewmate") ? describe : describe.skip;
  const describeFourth = serves("fourth") ? describe : describe.skip;
  const describeSafeStop =
    serves("crewmate") && harness.stopsSafely !== false ? describe : describe.skip;
  describe(`the session contract: ${harness.name}`, () => {
    let world: ContractWorld;
    const opened: ModelSession[] = [];

    async function open(spec: SessionSpec): Promise<ModelSession> {
      const session = await world.factory.open(spec);
      opened.push(session);
      return session;
    }

    function ticks(count: number): void {
      for (let tick = 0; tick < count; tick += 1) world.advance(TICK_PERIOD_MS);
    }

    beforeEach(async () => {
      world = await harness.world();
    });

    // Every case ends the way an owner ends a session: disposed, and then
    // nothing held - the client gone, the store free, no request open.
    afterEach(async () => {
      const sessions = opened.splice(0);
      for (const session of sessions) session.dispose();
      await Promise.all(sessions.map((session) => session.closed()));
      await vi.waitFor(() => expect(world.released()).toBe(true));
      await harness.cleanup?.();
    });

    describe("a factory", () => {
      it("declares its backend, and every session it opens carries its control profile", async () => {
        expect(world.factory.backend).toBe(harness.backend);
        world.answer({ text: "left" });
        const session = await open(serves("question") ? questionOn(world) : crewmateOn(world));
        expect(session.controlProfile).toEqual(world.factory.controlProfile);
        expect(session.sessionId).not.toBe("");
        if (!serves("seat")) return;
        const seat = await open(seatOn(world));
        expect(seat.controlProfile).toEqual(world.factory.controlProfile);
      });

      it("refuses what it cannot serve, holding nothing", async () => {
        await expect(open(questionOn(world, { binding: world.foreignBinding }))).rejects.toThrow(
          `cannot serve a ${world.foreignBinding.backend} binding`,
        );
        await expect(open(questionOn(world, { machine: "remote-1" }))).rejects.toThrow(
          "cannot run on machine remote-1",
        );
        await expect(open({ ...crewmateOn(world), shape: { turns: "one" } })).rejects.toThrow(
          "serves the coding built-ins on a rolling session only",
        );
        expect(world.released()).toBe(true);
        expect(world.served()).toEqual([]);
      });
    });

    describeQuestion("the question: one bounded answer from a session that reaches nothing", () => {
      it("asks once, on the instruction alone, with no tools and the backend's answer allowance", async () => {
        world.answer({ text: "left" });
        const session = await open(questionOn(world));
        const events = recorder(session);
        await session.prompt(QUESTION);
        expect(world.served()).toEqual([
          expect.objectContaining({
            system: expect.stringContaining(CONTRACT_INSTRUCTION),
            tools: 0,
            coding: false,
            said: expect.stringContaining(QUESTION),
          }),
        ]);
        const request = world.served()[0];
        if (harness.backend === "pi") {
          expect(request).toMatchObject({
            maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
            thinking: false,
          });
        } else if (request?.maxOutputTokens !== undefined) {
          // INF-1451: the real Claude client chooses a model-specific
          // allowance including hidden thinking; a scripted client leaves
          // the unspecified bound absent. Neither uses Pi's word-only cap.
          expect(request.maxOutputTokens).toBeGreaterThan(CLASSIFIER_MAX_OUTPUT_TOKENS);
        }
        expect(events.filter((event) => event.type === "turn_closed")).toEqual([
          { type: "turn_closed", text: "left" },
        ]);
        expect(events.some((event) => event.type === "turn_failed")).toBe(false);
        const ends = events.filter((event) => event.type === "turn_end");
        expect(ends).toHaveLength(1);
        expect(ends[0]).toMatchObject({
          taskId: "firstmate",
          usage: { input: expect.any(Number) },
        });
        expect(session.modelRef()).toEqual(world.model);
        expect(session.isStreaming()).toBe(false);
      });

      it("takes no steer and no second question, and keeps no record", async () => {
        world.answer({ text: "right" });
        const session = await open(questionOn(world));
        expect(session.resume()).toBeUndefined();
        expect(session.recordPath()).toBeUndefined();
        await session.prompt(QUESTION);
        await expect(session.steer("wait")).rejects.toThrow("one question");
        await expect(session.prompt("And now?")).rejects.toThrow("one question");
        expect(session.takeUndeliveredSteers()).toEqual([]);
        expect(session.servedState()).toBeUndefined();
        await session.detach();
        session.dispose();
        await session.closed();
        await vi.waitFor(() => expect(world.released()).toBe(true));
        expect(world.records()).toEqual([]);
        expect(world.served()).toHaveLength(1);
      });

      it("reads an answer the output cap cut short as the answer", async () => {
        world.answer({ cutShort: "left - because the question" });
        const session = await open(questionOn(world));
        const events = recorder(session);
        await session.prompt(QUESTION);
        const closed = events.filter((event) => event.type === "turn_closed");
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({ text: expect.stringContaining("left") });
        expect(events.some((event) => event.type === "turn_failed")).toBe(false);
      });

      it("gives the question up on abort, and lets go of it", async () => {
        world.answer("hang");
        const session = await open(questionOn(world));
        const asking = session.prompt(QUESTION);
        await world.reached();
        await session.abort();
        await settled(asking);
        expect(session.isStreaming()).toBe(false);
        session.dispose();
        await session.closed();
        await vi.waitFor(() => expect(world.released()).toBe(true));
      });

      it("reports an abort's failure as the question's own", async () => {
        world.answer("hang");
        const session = await open(questionOn(world));
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        await world.reached();
        await session.abort("The question ran out of time.");
        await settled(asking);
        expect(events.filter((event) => event.type === "turn_failed")).toEqual([
          { type: "turn_failed", taskId: "firstmate", error: "The question ran out of time." },
        ]);
        expect(events.filter((event) => event.type === "turn_closed")).toEqual([
          { type: "turn_closed" },
        ]);
      });

      it.each([
        [401, "signed_out"],
        [403, "refused"],
      ] as const)(
        "reports a %i refusal as a failed turn its owner can read (%s)",
        async (status, cutOff) => {
          world.answer({ refuse: status });
          const session = await open(questionOn(world));
          const events = recorder(session);
          await settled(session.prompt(QUESTION));
          const failed = events.filter((event) => event.type === "turn_failed");
          expect(failed).toHaveLength(1);
          const failure = failed[0] as Extract<SessionEvent, { type: "turn_failed" }>;
          // A typed backend classifies it; a text backend's words carry it.
          if (world.factory.controlProfile.failureSignals === "typed") {
            expect(failure.cutOff).toEqual({ class: cutOff });
          } else {
            expect(isAuthFailureMessage(failure.error)).toBe(true);
          }
          expect(events.filter((event) => event.type === "turn_closed")).toEqual([
            { type: "turn_closed" },
          ]);
        },
      );
    });

    describeSeat("the seat: a rolling session on its own record, steered and resumed", () => {
      it("answers on the role's prompt, its served instructions and its tools alone", async () => {
        world.answer({ text: "left" });
        const session = await open(seatOn(world));
        const events = recorder(session);
        await session.prompt(QUESTION);
        const [request, ...more] = world.served();
        expect(more).toEqual([]);
        expect(request?.system).toContain(FIRSTMATE_PERSONA);
        expect(request?.system).toContain(SERVED.text);
        expect(request?.tools).toBe(1);
        expect(request?.coding).toBe(false);
        // The role's output cap, in the backend's own terms (decision D5).
        expect(request?.maxOutputTokens).toBe(FIRSTMATE_MAX_OUTPUT_TOKENS);
        expect(request?.said).toContain(QUESTION);
        expect(closingWords(events)).toBe("left");
        expect(failures(events)).toEqual([]);
        expect(events.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({
          taskId: "firstmate",
        });
        expect(session.isStreaming()).toBe(false);
        expect(session.modelRef()).toEqual(world.model);
        expect(session.resume()?.backend).toBe(harness.backend);
        expect(session.recordPath()).toEqual(expect.any(String));
      });

      it("stamps the role's contract in its record, and serves changed instructions only at the next prompt", async () => {
        world.answer({ text: "left" });
        const session = await open(seatOn(world));
        await session.prompt(QUESTION);
        session.serveInstructions(CHANGED);
        await session.prompt("And now?");
        const [first, second] = world.served();
        expect(first?.system).toContain(SERVED.text);
        expect(second?.system).toContain(CHANGED.text);
        expect(second?.system).not.toContain(SERVED.text);
        session.dispose();
        await session.closed();
        const stamp = firstmateContractStamp([contractTool()], harness.backend);
        const recorded = {
          version: stamp.version,
          prompt_sha: stamp.promptSha,
          tools_sha: stamp.toolsSha,
          // A Claude client resumes on the tool descriptions it recorded, so its record names each tool's sha.
          ...(harness.backend === "claude" ? { tool_shas: stamp.tools } : {}),
        };
        // One record or two: a Claude session starts over under a new id
        // for changed instructions, which its client cannot serve on resume.
        const stamps = await world.stamps();
        expect(stamps).toHaveLength(2);
        expect(stamps).toEqual(
          expect.arrayContaining([
            { ...recorded, instructions_sha: SERVED.sha },
            { ...recorded, instructions_sha: CHANGED.sha },
          ]),
        );
      });

      it("resumes its own record where the last session left it", async () => {
        world.answer({ text: "left" });
        const first = await open(seatOn(world));
        await first.prompt("Remember the word cobalt.");
        const resume = first.resume();
        first.dispose();
        await first.closed();
        const second = await open(seatOn(world, resume ? { resume } : {}));
        expect(second.resume()).toEqual(resume);
        expect(second.recordPath()).toBe(first.recordPath());
        await second.prompt(QUESTION);
        expect(world.served().at(-1)?.said).toContain("cobalt");
      });

      it("runs the role's own tool, speaks it by its bare name, and closes on the answer", async () => {
        let runs = 0;
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(
          seatOn(world, {
            tools: [
              contractTool(() => {
                runs += 1;
              }),
            ],
          }),
        );
        const events = recorder(session);
        await session.prompt(QUESTION);
        expect(runs).toBe(1);
        expect(toolEvents(events)).toEqual([
          { start: CONTRACT_TOOL, taskId: "firstmate" },
          { end: CONTRACT_TOOL, isError: false },
        ]);
        expect(world.served()).toHaveLength(2);
        expect(world.served()[1]?.said).toContain(CONTRACT_TOOL_RESULT);
        expect(closingWords(events)).toBe("left");
        expect(failures(events)).toEqual([]);
      });

      it("folds a steer sent while a tool runs into the running turn", async () => {
        const gate = gated();
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(seatOn(world, { tools: [gate.tool] }));
        const events = recorder(session);
        const prompting = session.prompt(QUESTION);
        await gate.entered;
        await session.steer("Mind the right side too.");
        await world.holds(session, "Mind the right side too.");
        gate.open();
        await prompting;
        const served = world.served();
        expect(served).toHaveLength(2);
        expect(served[1]?.said).toContain(CONTRACT_TOOL_RESULT);
        expect(served[1]?.said).toContain("Mind the right side too.");
        expect(session.takeUndeliveredSteers()).toEqual([]);
        expect(closingWords(events)).toBe("left");
        expect(failures(events)).toEqual([]);
      });

      it("gives back a steer no turn took in, once", async () => {
        world.answer({ text: "left" });
        const session = await open(seatOn(world));
        await session.prompt(QUESTION);
        await session.steer("A word too late.");
        expect(session.takeUndeliveredSteers()).toEqual(["A word too late."]);
        expect(session.takeUndeliveredSteers()).toEqual([]);
      });

      it("ends a turn on abort, quietly, and takes the next prompt", async () => {
        world.answer("hang");
        const session = await open(seatOn(world));
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        await world.reached();
        await session.abort();
        await settled(asking);
        expect(session.isStreaming()).toBe(false);
        expect(failures(events)).toEqual([]);
        world.answer({ text: "right" });
        await session.prompt("And now?");
        expect(closingWords(events)).toBe("right");
      });

      it("reports an abort's failure as the turn's own", async () => {
        world.answer("hang");
        const session = await open(seatOn(world));
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        await world.reached();
        await session.abort("The turn ran out of time.");
        await settled(asking);
        expect(failures(events)).toEqual([
          { type: "turn_failed", taskId: "firstmate", error: "The turn ran out of time." },
        ]);
        expect(session.isStreaming()).toBe(false);
      });

      it("detaches at an idle boundary, holding nothing, and the next prompt carries on", async () => {
        world.answer({ text: "left" });
        const session = await open(seatOn(world));
        await session.prompt("Remember the word cobalt.");
        await session.detach();
        expect(world.released()).toBe(true);
        await session.prompt(QUESTION);
        expect(world.served().at(-1)?.said).toContain("cobalt");
      });

      it.each([
        [401, "signed_out"],
        [403, "refused"],
      ] as const)(
        "reports a %i refusal as a failed turn its owner can read (%s)",
        async (status, cutOff) => {
          world.answer({ refuse: status });
          const session = await open(seatOn(world));
          const events = recorder(session);
          await settled(session.prompt(QUESTION));
          const failed = failures(events);
          expect(failed).toHaveLength(1);
          if (world.factory.controlProfile.failureSignals === "typed") {
            expect(failed[0]?.cutOff).toEqual({ class: cutOff });
          } else {
            expect(isAuthFailureMessage(failed[0]?.error ?? "")).toBe(true);
          }
          expect(session.isStreaming()).toBe(false);
        },
      );
    });

    describeSeat(
      "the seat's bounds: time on the host's one clock, requests in the backend's own terms",
      () => {
        it("cuts an inference past the per-request bound at the first tick after it is due, and takes the next prompt", async () => {
          world.answer("hang");
          const session = await open(seatOn(world));
          const events = recorder(session);
          const asking = session.prompt(QUESTION);
          await world.reached();
          await requestsStarted(events);
          ticks(FIRSTMATE_REQUEST_TIMEOUT_MS / TICK_PERIOD_MS - 1);
          expect(failures(events)).toEqual([]);
          ticks(1);
          await settled(asking);
          expect(failures(events)).toEqual([
            {
              type: "turn_failed",
              taskId: "firstmate",
              error: requestTimeoutErrorMessage(FIRSTMATE_REQUEST_TIMEOUT_MS),
            },
          ]);
          expect(session.isStreaming()).toBe(false);
          world.answer({ text: "right" });
          await session.prompt("And now?");
          expect(closingWords(events)).toBe("right");
        });

        it("stops the per-inference clock while the role's tool runs", async () => {
          const gate = gated();
          world.answer({ tool: CONTRACT_TOOL, answer: "left" });
          const session = await open(seatOn(world, { tools: [gate.tool] }));
          const events = recorder(session);
          const prompting = session.prompt(QUESTION);
          await gate.entered;
          await toolStarted(events);
          ticks((2 * FIRSTMATE_REQUEST_TIMEOUT_MS) / TICK_PERIOD_MS);
          gate.open();
          await prompting;
          expect(failures(events)).toEqual([]);
          expect(closingWords(events)).toBe("left");
          expect(world.served()).toHaveLength(2);
        });

        it("cuts a turn at the whole-turn backstop, the one bound a spec may ask for alone", async () => {
          world.answer("hang");
          const seat = seatOn(world);
          const session = await open({
            ...seat,
            bounds: { ...seat.bounds, watched: { turnTimeoutMs: FIRSTMATE_TURN_TIMEOUT_MS } },
          });
          const events = recorder(session);
          const asking = session.prompt(QUESTION);
          await world.reached();
          ticks(FIRSTMATE_TURN_TIMEOUT_MS / TICK_PERIOD_MS - 1);
          expect(failures(events)).toEqual([]);
          ticks(1);
          await settled(asking);
          expect(failures(events)).toEqual([
            {
              type: "turn_failed",
              taskId: "firstmate",
              error: turnTimeoutErrorMessage(FIRSTMATE_TURN_TIMEOUT_MS),
            },
          ]);
          expect(session.isStreaming()).toBe(false);
        });

        it("stops a model that keeps calling its tool at the model-turn cap, once the last turn's tools ran", async () => {
          let runs = 0;
          world.answer("loop");
          const seat = seatOn(world, {
            tools: [
              contractTool(() => {
                runs += 1;
              }),
            ],
          });
          const session = await open({
            ...seat,
            bounds: { ...seat.bounds, request: { ...seat.bounds?.request, maxModelTurns: 3 } },
          });
          const events = recorder(session);
          await settled(session.prompt(QUESTION));
          expect(runs).toBe(3);
          expect(world.served()).toHaveLength(3);
          // One failed turn naming the cap, in each backend's words; never a cut-off.
          const failed = failures(events);
          expect(failed).toEqual([
            { type: "turn_failed", taskId: "firstmate", error: expect.stringContaining("3") },
          ]);
          expect(session.isStreaming()).toBe(false);
          world.answer({ text: "right" });
          await session.prompt("And now?");
          expect(closingWords(events)).toBe("right");
        });
      },
    );

    describeCrewmate(
      "the crewmate: a coding session in its task's worktree, steered and resumed",
      () => {
        it("answers on the crewmate's prompt, with its tools beside the coding set, as its task", async () => {
          world.answer({ text: "left" });
          const session = await open(crewmateOn(world));
          const events = recorder(session);
          await session.prompt(QUESTION);
          const [request, ...more] = world.served();
          expect(more).toEqual([]);
          expect(request?.system).toContain("You are a crewmate");
          expect(request?.coding).toBe(true);
          expect(request?.tools).toBeGreaterThanOrEqual(1);
          expect(request?.said).toContain(QUESTION);
          expect(failures(events)).toEqual([]);
          expect(events.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({
            taskId: CREWMATE_TASK,
          });
          expect(session.isStreaming()).toBe(false);
          expect(session.modelRef()).toEqual(world.model);
          // What its task keeps reopens it on the same backend.
          const resume = session.resume();
          expect(resume?.backend).toBe(harness.backend);
          expect(crewmateResume(crewmateResumeToken(resume), harness.backend)).toEqual(resume);
        });

        it("runs its own tool, as its task's, and answers on the tool's result", async () => {
          let runs = 0;
          world.answer({ tool: CONTRACT_TOOL, answer: "left" });
          const session = await open(
            crewmateOn(world, {
              tools: [
                contractTool(() => {
                  runs += 1;
                }),
              ],
            }),
          );
          const events = recorder(session);
          await session.prompt(QUESTION);
          expect(runs).toBe(1);
          expect(toolEvents(events)).toEqual([
            { start: CONTRACT_TOOL, taskId: CREWMATE_TASK },
            { end: CONTRACT_TOOL, isError: false },
          ]);
          expect(world.served()).toHaveLength(2);
          expect(world.served()[1]?.said).toContain(CONTRACT_TOOL_RESULT);
          expect(failures(events)).toEqual([]);
        });

        it("folds a steer sent while a tool runs into the running turn", async () => {
          const gate = gated();
          world.answer({ tool: CONTRACT_TOOL, answer: "left" });
          const session = await open(crewmateOn(world, { tools: [gate.tool] }));
          const events = recorder(session);
          const prompting = session.prompt(QUESTION);
          await gate.entered;
          await session.steer("Mind the right side too.");
          await world.holds(session, "Mind the right side too.");
          gate.open();
          await prompting;
          const served = world.served();
          expect(served).toHaveLength(2);
          expect(served[1]?.said).toContain(CONTRACT_TOOL_RESULT);
          expect(served[1]?.said).toContain("Mind the right side too.");
          expect(session.takeUndeliveredSteers()).toEqual([]);
          expect(closingWords(events)).toBe("left");
          expect(failures(events)).toEqual([]);
          expect(session.isStreaming()).toBe(false);
        });

        it("gives back a steer no turn took in, once", async () => {
          world.answer({ text: "left" });
          const session = await open(crewmateOn(world));
          await session.prompt(QUESTION);
          await session.steer("A word too late.");
          expect(session.takeUndeliveredSteers()).toEqual(["A word too late."]);
          expect(session.takeUndeliveredSteers()).toEqual([]);
        });

        it("ends a turn on abort, quietly, and takes the next prompt", async () => {
          world.answer("hang");
          const session = await open(crewmateOn(world));
          const events = recorder(session);
          const asking = session.prompt(QUESTION);
          await world.reached();
          await session.abort();
          // Settled, never thrown: that it was an interrupt is the owner's own fact.
          await asking;
          expect(session.isStreaming()).toBe(false);
          expect(failures(events)).toEqual([]);
          world.answer({ text: "right" });
          await session.prompt("And now?");
          expect(world.served().at(-1)?.said).toContain("And now?");
          expect(failures(events)).toEqual([]);
        });

        it("holds a crewmate to no time bound: its turns are long by design", async () => {
          world.answer("hang");
          const session = await open(crewmateOn(world));
          const events = recorder(session);
          const asking = session.prompt(QUESTION);
          await world.reached();
          ticks(FIRSTMATE_TURN_TIMEOUT_MS / TICK_PERIOD_MS + 10);
          expect(failures(events)).toEqual([]);
          expect(session.isStreaming()).toBe(true);
          await session.abort();
          await settled(asking);
          expect(failures(events)).toEqual([]);
        });

        it("reports an abort's failure as its task's turn failing", async () => {
          world.answer("hang");
          const session = await open(crewmateOn(world));
          const events = recorder(session);
          const asking = session.prompt(QUESTION);
          await world.reached();
          await session.abort("The turn ran out of time.");
          await settled(asking);
          expect(failures(events)).toEqual([
            { type: "turn_failed", taskId: CREWMATE_TASK, error: "The turn ran out of time." },
          ]);
          expect(session.isStreaming()).toBe(false);
        });

        it("resumes its own record from the token its task keeps", async () => {
          world.answer({ text: "left" });
          const first = await open(crewmateOn(world));
          await first.prompt("Remember the word cobalt.");
          const token = crewmateResumeToken(first.resume());
          first.dispose();
          await first.closed();
          const second = await open(crewmateOn(world, token ? { resumeToken: token } : {}));
          expect(second.resume()).toEqual(first.resume());
          await second.prompt(QUESTION);
          expect(world.served().at(-1)?.said).toContain("cobalt");
        });

        it("carries its working copy's own AGENTS.md in its prompt, before CLAUDE.md", async () => {
          // FI3-789: every backend serves the working copy's instruction file
          // at the session's start (src/core/session/projectResources.ts).
          writeFileSync(join(world.homeDir, "AGENTS.md"), "Rivets are counted in pairs.\n");
          writeFileSync(join(world.homeDir, "CLAUDE.md"), "Rivets are counted alone.\n");
          world.answer({ text: "left" });
          const session = await open(crewmateOn(world));
          await session.prompt(QUESTION);
          const [request] = world.served();
          expect(request?.system).toContain("Rivets are counted in pairs.");
          expect(request?.system).toContain(join(world.homeDir, "AGENTS.md"));
          expect(`${request?.system}${request?.said}`).not.toContain("Rivets are counted alone.");
        });

        it("keeps its record in its task's folder, where it reads back as its conversation", async () => {
          world.answer({ text: "left" });
          const session = await open(crewmateOn(world));
          await session.prompt(QUESTION);
          session.dispose();
          await session.closed();
          const path = session.recordPath();
          expect(path).toEqual(expect.any(String));
          expect(dirname(path ?? "")).toBe(crewmateSessionsDir(crewPaths(world), CREWMATE_TASK));
          const read = readSession(path ?? "");
          expect(read.sessionId).toBe(session.sessionId);
          const said = conversationOf(read);
          expect(said.filter((line) => line.role === "user").map((line) => line.text)).toEqual([
            expect.stringContaining(QUESTION),
          ]);
          expect(said.at(-1)).toEqual({ role: "assistant", text: "left" });
        });

        it("carries its record on across a resume, only ever appending to it", async () => {
          world.answer({ text: "left" });
          const first = await open(crewmateOn(world));
          await first.prompt("Remember the word cobalt.");
          first.dispose();
          await first.closed();
          const path = first.recordPath() ?? "";
          const before = readFileSync(path, "utf8");
          const token = crewmateResumeToken(first.resume());
          const second = await open(crewmateOn(world, token ? { resumeToken: token } : {}));
          expect(second.recordPath()).toBe(path);
          await second.prompt(QUESTION);
          second.dispose();
          await second.closed();
          const after = readFileSync(path, "utf8");
          expect(after.length).toBeGreaterThan(before.length);
          expect(after.startsWith(before)).toBe(true);
          const asked = conversationOf(readSession(path))
            .filter((line) => line.role === "user")
            .map((line) => line.text);
          expect(asked).toEqual([
            expect.stringContaining("Remember the word cobalt."),
            expect.stringContaining(QUESTION),
          ]);
        });

        it("starts a fresh conversation from a token another backend wrote", async () => {
          const foreign =
            harness.backend === "pi"
              ? "0b7e3a52-5f1c-4c7e-9d3a-2f6b8e1c4a90"
              : join(world.homeDir, "elsewhere.jsonl");
          world.answer({ text: "left" });
          const session = await open(crewmateOn(world, { resumeToken: foreign }));
          const events = recorder(session);
          await session.prompt(QUESTION);
          expect(failures(events)).toEqual([]);
          expect(crewmateResumeToken(session.resume())).not.toBe(foreign);
          expect(world.served()).toHaveLength(1);
        });

        it.each([
          [401, "signed_out"],
          [403, "refused"],
        ] as const)(
          "reports a %i refusal as its task's failed turn (%s)",
          async (status, cutOff) => {
            world.answer({ refuse: status });
            const session = await open(crewmateOn(world));
            const events = recorder(session);
            await settled(session.prompt(QUESTION));
            const failed = failures(events);
            expect(failed).toHaveLength(1);
            expect(failed[0]?.taskId).toBe(CREWMATE_TASK);
            if (world.factory.controlProfile.failureSignals === "typed") {
              expect(failed[0]?.cutOff).toEqual({ class: cutOff });
            } else {
              expect(isAuthFailureMessage(failed[0]?.error ?? "")).toBe(true);
            }
            expect(session.isStreaming()).toBe(false);
          },
        );
      },
    );

    // INF-4072: a network block page is not proof of a lost sign-in. The
    // Claude client labels it as one, beside status 403; the typed backend
    // reads it as an ordinary failed turn, which the honest retry takes.
    (harness.backend === "claude" ? describeCrewmate : describe.skip)(
      "the crewmate meeting a network block page",
      () => {
        it("reports a 403 block page as a failed turn with no cut-off", async () => {
          world.answer("blockPage");
          const session = await open(crewmateOn(world));
          const events = recorder(session);
          await settled(session.prompt(QUESTION));
          const failed = failures(events);
          expect(failed).toHaveLength(1);
          expect(failed[0]?.taskId).toBe(CREWMATE_TASK);
          // The client's own words for it, kept: the block page's title.
          expect(failed[0]?.error).toBe(
            "Failed to authenticate. API Error: Attention Required! | Cloudflare",
          );
          expect(failed[0]?.cutOff).toBeUndefined();
          expect(session.isStreaming()).toBe(false);
        });
      },
    );

    // INF-2245, the captain's approved update plan (INF-2223): an update
    // stops a crewmate's turn only where nothing it did is lost - a call
    // already running finishes and keeps its result, then the turn ends,
    // and the next prompt carries on from the kept result.
    describeSafeStop("the crewmate's safe stop, for an update", () => {
      /** Stops the running turn safely; every backend in this suite has the member. */
      function stopSafely(
        session: ModelSession,
        options?: Parameters<NonNullable<ModelSession["stopSafely"]>>[0],
      ) {
        const stop = session.stopSafely;
        if (!stop) throw new Error("This session cannot stop safely.");
        return stop.call(session, options);
      }

      it("lets a running call finish and keeps its result, then ends the turn, and the next prompt carries on", async () => {
        const gate = gated();
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(crewmateOn(world, { tools: [gate.tool] }));
        const events = recorder(session);
        const prompting = session.prompt(QUESTION);
        // The stop lands once the call runs. The model's ask (`tool_start`)
        // comes before the call runs, and a stop between the two refuses the
        // call ("never runs a call the model asks for", below), so this case
        // waits for the run itself.
        await gate.entered;
        const waits: string[][] = [];
        const stopping = stopSafely(session, {
          waiting: (calls) => waits.push(calls.map((call) => call.toolName)),
        });
        await vi.waitFor(() => expect(waits.at(-1)).toEqual([CONTRACT_TOOL]));
        // The stop waits: the call still runs, and the turn with it.
        expect(session.isStreaming()).toBe(true);
        gate.open();
        expect(await stopping).toBe("stopped");
        await settled(prompting);
        expect(waits.at(-1)).toEqual([]);
        expect(gate.runs()).toBe(1);
        expect(toolEvents(events)).toEqual([
          { start: CONTRACT_TOOL, taskId: CREWMATE_TASK },
          { end: CONTRACT_TOOL, isError: false },
        ]);
        // Cut once the call ended: the model never closed on the answer.
        expect(closingWords(events)).not.toBe("left");
        expect(session.isStreaming()).toBe(false);
        world.answer({ text: "right" });
        await session.prompt("And now?");
        const next = world.served().at(-1)?.said ?? "";
        expect(next).toContain(CONTRACT_TOOL_RESULT);
        expect(next).toContain("And now?");
        expect(gate.runs()).toBe(1);
        expect(closingWords(events)).toBe("right");
      });

      it("ends a turn with no call running at once, and takes the next prompt", async () => {
        world.answer("hang");
        const session = await open(crewmateOn(world));
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        await world.reached();
        const waits: string[][] = [];
        expect(
          await stopSafely(session, {
            waiting: (calls) => waits.push(calls.map((call) => call.toolName)),
          }),
        ).toBe("stopped");
        await settled(asking);
        expect(waits).toEqual([[]]);
        expect(session.isStreaming()).toBe(false);
        world.answer({ text: "right" });
        await session.prompt("And now?");
        expect(world.served().at(-1)?.said).toContain("And now?");
        expect(closingWords(events)).toBe("right");
      });

      // INF-2223's approved plan: once the stop stands no new call starts,
      // and the model that asked for one reads why when its turn carries on.
      it("never runs a call the model asks for once the stop stands, and tells it why", async () => {
        let runs = 0;
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(
          crewmateOn(world, {
            tools: [
              contractTool(async () => {
                runs += 1;
              }),
            ],
          }),
        );
        let stopping: Promise<unknown> | undefined;
        session.subscribe((event) => {
          // The stop lands as the model asks for the call, before it runs.
          if (event.type === "tool_start" && !stopping) stopping = stopSafely(session);
        });
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        await vi.waitFor(() => expect(stopping).toBeDefined());
        expect(await stopping).toBe("stopped");
        await settled(asking);
        expect(runs).toBe(0);
        expect(closingWords(events)).not.toBe("left");
        expect(session.isStreaming()).toBe(false);
        world.answer({ text: "right" });
        await session.prompt("And now?");
        const next = world.served().at(-1)?.said ?? "";
        expect(next).toContain(SAFE_STOP_BLOCKED_TEXT);
        expect(next).not.toContain(CONTRACT_TOOL_RESULT);
        expect(runs).toBe(0);
        expect(closingWords(events)).toBe("right");
      });

      it("runs nothing of a prompt the stop meets as it starts, and either keeps its words or refuses it typed", async () => {
        let runs = 0;
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(
          crewmateOn(world, {
            tools: [
              contractTool(() => {
                runs += 1;
              }),
            ],
          }),
        );
        const events = recorder(session);
        const asking = session.prompt(QUESTION);
        expect(await stopSafely(session)).toBe("stopped");
        const refused = await asking.then(
          () => false,
          (error: unknown) => {
            // Its model never took it: the owner sends its words again.
            expect(error).toBeInstanceOf(StoppedBeforeStartError);
            return true;
          },
        );
        expect(runs).toBe(0);
        expect(closingWords(events)).not.toBe("left");
        expect(session.isStreaming()).toBe(false);
        world.answer({ text: "right" });
        await session.prompt("And now?");
        // A prompt that ended was cut with its words in the conversation,
        // which the next request carries; a refused one left none behind.
        const next = world.served().at(-1)?.said ?? "";
        expect(next).toContain("And now?");
        expect(next.includes(QUESTION)).toBe(!refused);
        expect(runs).toBe(0);
      });

      it("stops nothing on an idle session", async () => {
        world.answer({ text: "left" });
        const session = await open(crewmateOn(world));
        await session.prompt(QUESTION);
        expect(await stopSafely(session)).toBe("stopped");
        world.answer({ text: "right" });
        await session.prompt("And now?");
        expect(world.served().at(-1)?.said).toContain("And now?");
      });

      it("withdrawn while it waits, leaves the turn to finish as if never asked", async () => {
        const gate = gated();
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(crewmateOn(world, { tools: [gate.tool] }));
        const events = recorder(session);
        const prompting = session.prompt(QUESTION);
        await gate.entered;
        const later = new AbortController();
        const stopping = stopSafely(session, { signal: later.signal });
        later.abort();
        expect(await stopping).toBe("withdrawn");
        gate.open();
        await prompting;
        expect(closingWords(events)).toBe("left");
        expect(world.served()[1]?.said).toContain(CONTRACT_TOOL_RESULT);
        expect(failures(events)).toEqual([]);
      });

      it("gives a steer that came while it waited back to its owner, in order", async () => {
        const gate = gated();
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open(crewmateOn(world, { tools: [gate.tool] }));
        const prompting = session.prompt(QUESTION);
        await gate.entered;
        const stopping = stopSafely(session);
        await session.steer("First, mind the left.");
        await session.steer("Then the right.");
        gate.open();
        expect(await stopping).toBe("stopped");
        await settled(prompting);
        expect(session.takeUndeliveredSteers()).toEqual([
          "First, mind the left.",
          "Then the right.",
        ]);
        expect(session.takeUndeliveredSteers()).toEqual([]);
        for (const served of world.served()) expect(served.said).not.toContain("mind the left");
      });
    });

    describeFourth("a fourth preset no role has: one bound tool on a one-shot", () => {
      it("runs the tool and answers, with no edit of the backend, and keeps no record", async () => {
        let runs = 0;
        world.answer({ tool: CONTRACT_TOOL, answer: "left" });
        const session = await open({
          machine: machineOf(world),
          owner: "fourth",
          cwd: world.homeDir,
          binding: world.binding,
          model: world.model,
          thinking: { level: "low" },
          instructions: { base: CONTRACT_INSTRUCTION },
          builtins: "none",
          tools: [
            contractTool(() => {
              runs += 1;
            }),
          ],
          shape: { turns: "one" },
        });
        const events = recorder(session);
        await session.prompt(QUESTION);
        expect(runs).toBe(1);
        expect(toolEvents(events)).toEqual([
          { start: CONTRACT_TOOL, taskId: "fourth" },
          { end: CONTRACT_TOOL, isError: false },
        ]);
        expect(world.served().map((request) => request.tools)).toEqual([1, 1]);
        expect(closingWords(events)).toBe("left");
        expect(failures(events)).toEqual([]);
        session.dispose();
        await session.closed();
        await vi.waitFor(() => expect(world.released()).toBe(true));
        expect(world.records()).toEqual([]);
      });
    });
  });
}
