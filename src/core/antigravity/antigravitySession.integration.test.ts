import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgyScenario } from "../../../tests/helpers/agyStandIn";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { ModelSession, SessionEvent, SessionResume } from "../session/session";
import { boundTool } from "../session/tools";
import { readSession, sessionAssistantLines, sessionToolCalls } from "../storage/sessionReader";
import {
  ANTIGRAVITY_PERSONAL_MCP,
  ANTIGRAVITY_PERSONAL_OFF,
  ANTIGRAVITY_WORDS,
} from "./antigravitySession";
import { createAntigravitySessionFactory } from "./session";

/**
 * Intent: INF-3776's approved plan, its first pull request - "Crewmates:
 * find the installed program, talk to it, serve Infinitary's tools, keep
 * the transcript, and test against a scripted stand-in" - under the
 * captain's constraints: Infinitary names itself as itself, offers Gemini
 * models only, and never reads the program's sign-in. The stand-in
 * (`tests/helpers/agyStandIn.ts`) speaks the program's protocol over a
 * real child process; no Google sign-in or network service is used.
 */

const STAND_IN = join(import.meta.dirname, "../../../tests/helpers/agyStandIn.ts");
const GEMINI = { id: "gemini-3-pro", name: "Gemini 3 Pro" };
const OTHER = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };

const open: ModelSession[] = [];
afterEach(async () => {
  for (const session of open.splice(0)) {
    session.dispose();
    await session.closed();
  }
});

/** A crewmate's tool, as the app binds one: it answers with what it was given. */
const noteTool = boundTool({
  name: "note_progress",
  label: "Note progress",
  description: "Put one line on the task's timeline.",
  parameters: Type.Object({ text: Type.String() }),
  run: ({ text }) => ({ text: `Noted: ${text}` }),
});

function setUp(
  scenario: AgyScenario,
  options: { resume?: SessionResume; model?: string; personal?: boolean } = {},
) {
  const home = scratchDir("infinitary-antigravity-");
  // The person's own home, where their instructions and skills are read from.
  const personHome = join(home, "person");
  mkdirSync(personHome);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const recordDir = join(home, "record");
  const scenarioPath = join(home, "scenario.json");
  const logPath = join(home, "agy-log.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const launches: string[][] = [];
  const factory = createAntigravitySessionFactory({
    clientVersion: "9.9.9-test",
    cancelGraceMs: 2_000,
    home: personHome,
    launch: () => {
      const args = [STAND_IN, scenarioPath, logPath];
      launches.push(args);
      return { command: process.execPath, args };
    },
  });
  const spec = codingSpec({
    binding: { backend: "antigravity", accountId: "antigravity" },
    cwd,
    instructions: "You are a crewmate on the print shop project.",
    tools: [noteTool],
    recordDir,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.model ? { model: { provider: "google-antigravity", id: options.model } } : {}),
  });
  if (options.personal !== undefined) spec.personalResources = options.personal;
  const events: SessionEvent[] = [];
  const start = async (resume?: SessionResume) => {
    const session = await factory.open(
      resume && spec.shape.turns === "rolling"
        ? { ...spec, shape: { ...spec.shape, record: { ...spec.shape.record, resume } } }
        : spec,
    );
    open.push(session);
    session.subscribe((event) => events.push(event));
    return session;
  };
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const prompts = () =>
    log()
      .filter((entry) => entry.method === "session/prompt")
      .map((entry) => {
        const params = entry.params as { prompt: { text: string }[] };
        return params.prompt.map((block) => block.text);
      });
  return { start, events, log, prompts, launches, factory, spec, cwd, personHome };
}

describe("an Antigravity crewmate", () => {
  it("runs a turn through the program, serves the app's tools and keeps a record the app reads", async () => {
    const run = setUp({
      version: "1.5.4",
      models: [OTHER, GEMINI],
      currentModel: OTHER.id,
      turns: [
        [
          { think: "Check the tests first." },
          { shell: { command: "pnpm test", output: "12 passed" } },
          { permission: true },
          { tool: { name: "note_progress", args: { text: "Tests pass" } } },
          { say: "Done: the tests pass." },
          { usage: { inputTokens: 1200, outputTokens: 80, thoughtTokens: 40 } },
        ],
        [{ say: "Second turn." }],
      ],
    });
    const session = await run.start();

    // It named itself as itself, and moved off the program's non-Gemini default.
    const init = run.log().find((entry) => entry.method === "initialize");
    expect((init?.params as { clientInfo: unknown } | undefined)?.clientInfo).toEqual({
      name: "infinitary",
      title: "Infinitary",
      version: "9.9.9-test",
    });
    expect(run.log()).toContainEqual({
      method: "session/set_config_option",
      params: expect.objectContaining({ configId: "model", value: GEMINI.id }),
    });
    expect(session.modelRef()).toEqual({ provider: "google-antigravity", id: GEMINI.id });

    // The tool server's key rides the session request only, never the command line.
    expect(run.launches[0]?.join(" ")).not.toMatch(/Bearer/);
    const created = run.log().find((entry) => entry.method === "session/new");
    expect((created?.params as { mcpServers: unknown[] } | undefined)?.mcpServers).toEqual([
      {
        type: "http",
        name: "infinitary",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        headers: [{ name: "Authorization", value: "(present)" }],
      },
    ]);

    await session.prompt("Run the tests and note the result.");
    expect(session.isStreaming()).toBe(false);
    expect(run.events).toContainEqual({
      type: "model_served",
      model: { provider: "google-antigravity", id: GEMINI.id },
    });

    // The program reached the app's own tool, which ran and answered.
    expect(run.log()).toContainEqual({ listedTools: ["note_progress"] });
    expect(run.log()).toContainEqual({
      toolResult: { content: [{ type: "text", text: "Noted: Tests pass" }] },
    });
    expect(run.log()).toContainEqual({
      // Once, never always: a remembered grant could leave rules in the
      // person's Antigravity settings or the working copy (INF-3805's review).
      permission: { outcome: { outcome: "selected", optionId: "once" } },
    });

    const types = run.events.map((event) => event.type);
    expect(types.slice(types.indexOf("request_started"))).toEqual([
      "request_started",
      "model_served",
      "input_read",
      "thinking_delta",
      "tool_start",
      "tool_end",
      "request_started",
      "tool_start",
      "tool_end",
      "request_started",
      "assistant_delta",
      "turn_end",
      "turn_closed",
    ]);
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: "tool_start", toolName: "bash" }),
    );
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: "tool_start", toolName: "note_progress" }),
    );
    expect(run.events).toContainEqual({
      type: "turn_end",
      taskId: "task-1",
      usage: { input: 1200, output: 80, reasoning: 40 },
    });
    expect(run.events.at(-1)).toEqual({ type: "turn_closed", text: "Done: the tests pass." });

    // The instructions arrive at the head of the first prompt only.
    await session.prompt("Carry on.");
    const [first, second] = run.prompts();
    expect(first?.[0]).toContain("You are a crewmate on the print shop project.");
    expect(first?.[1]).toBe("Run the tests and note the result.");
    expect(second).toEqual(["Carry on."]);

    // The app's record reads through the one reader as a Pi session does.
    const path = session.recordPath();
    if (!path) throw new Error("no record");
    const read = readSession(path);
    expect(read.dialect).toBe("pi");
    expect(read.sessionId).toBe(session.sessionId);
    expect(sessionToolCalls(read.text, "pi").map((call) => [call.name, call.arguments])).toEqual([
      ["bash", { command: "pnpm test" }],
      ["note_progress", { text: "Tests pass" }],
    ]);
    expect(sessionAssistantLines(read.text, "pi").flatMap((line) => line.texts)).toEqual([
      "Done: the tests pass.",
      "Second turn.",
    ]);
  });

  it("refuses a model that is not Gemini, and a program that offers none", async () => {
    await expect(
      setUp({ models: [OTHER, GEMINI], turns: [] }, { model: OTHER.id }).start(),
    ).rejects.toThrow("Infinitary runs Antigravity on Gemini models only");
    await expect(setUp({ models: [OTHER], turns: [] }).start()).rejects.toThrow(
      "Antigravity offers no Gemini model on this sign-in.",
    );
  });

  it("moves a conversation the program moved off Gemini back to its Gemini model", async () => {
    const run = setUp({
      models: [GEMINI, OTHER],
      turns: [[{ moveModel: OTHER.id }, { say: "Moved." }]],
    });
    const session = await run.start();
    await session.prompt("Go.");
    await until(() =>
      run
        .log()
        .some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as { value?: string }).value === GEMINI.id,
        ),
    );
    expect(session.modelRef()).toEqual({ provider: "google-antigravity", id: GEMINI.id });
    expect(run.events).not.toContainEqual({
      type: "model_served",
      model: { provider: "google-antigravity", id: OTHER.id },
    });
  });

  it("ends the turn and reattaches when the program will not move back to Gemini", async () => {
    const run = setUp({
      models: [GEMINI, OTHER],
      resume: true,
      refuseModelSets: 1,
      turns: [[{ moveModel: OTHER.id }, { wait: "cancel" }], [{ say: "Back on Gemini." }]],
    });
    const session = await run.start();
    await session.prompt("Go.");
    expect(run.events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: `Infinitary runs Antigravity on Gemini models only, and ${OTHER.name} is not one.`,
    });

    // The next prompt starts the program again and chooses Gemini.
    await session.prompt("Again.");
    expect(run.launches).toHaveLength(2);
    expect(run.log()).toContainEqual({ refusedModelSet: GEMINI.id });
    expect(session.modelRef()).toEqual({ provider: "google-antigravity", id: GEMINI.id });
    expect(run.events.at(-1)).toEqual({ type: "turn_closed", text: "Back on Gemini." });
  });

  it("serves the person's own instructions and skills only under the personal opt-in", async () => {
    const shared = setUp({ turns: [[{ say: "One." }]] }, { personal: true });
    writeFileSync(join(shared.personHome, "AGENTS.md"), "Write commit subjects in lowercase.");
    const skill = join(shared.personHome, ".agents", "skills", "tidy-imports");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\ndescription: Sort imports.\n---\n");
    await (await shared.start()).prompt("Begin.");
    const on = shared.prompts()[0]?.[0] ?? "";
    expect(on).toContain("Write commit subjects in lowercase.");
    expect(on).toContain(`- tidy-imports (${join(skill, "SKILL.md")}): Sort imports.`);
    expect(on).not.toContain(ANTIGRAVITY_PERSONAL_OFF);
    // Never the program's personal MCP servers, which Pi and Claude never offer either.
    expect(on).toContain(ANTIGRAVITY_PERSONAL_MCP);

    const kept = setUp({ turns: [[{ say: "One." }]] }, { personal: false });
    writeFileSync(join(kept.personHome, "AGENTS.md"), "Write commit subjects in lowercase.");
    await (await kept.start()).prompt("Begin.");
    const off = kept.prompts()[0]?.[0] ?? "";
    expect(off).not.toContain("Write commit subjects in lowercase.");
    expect(off).toContain(ANTIGRAVITY_PERSONAL_OFF);
  });

  it("serves its tools to a program that names no MCP capability but lists them, as the installed 1.5.6 does", async () => {
    // Intent: the real-program check on Antigravity 1.5.6 (INF-3791), whose
    // initialize answer carries no mcpCapabilities while it still lists the
    // HTTP tool server's tools before answering session/new.
    const run = setUp({
      mcpHttp: "unadvertised",
      models: [GEMINI],
      currentModel: GEMINI.id,
      turns: [[{ tool: { name: "note_progress", args: { text: "Reached" } } }, { say: "Noted." }]],
    });
    const session = await run.start();
    expect(run.log()).toContainEqual({ listedWhenOpened: ["note_progress"] });
    await session.prompt("Note it.");
    expect(run.log()).toContainEqual({
      toolResult: { content: [{ type: "text", text: "Noted: Reached" }] },
    });
    expect(run.events.at(-1)).toEqual({ type: "turn_closed", text: "Noted." });
  });

  it("says plainly when the program is signed out, too old or cannot reach the app's tools", async () => {
    await expect(setUp({ auth: "required", turns: [] }).start()).rejects.toThrow(
      ANTIGRAVITY_WORDS.signedOut,
    );
    await expect(setUp({ version: "1.5.0", turns: [] }).start()).rejects.toThrow(
      ANTIGRAVITY_WORDS.old,
    );
    await expect(setUp({ mcpHttp: false, turns: [] }).start()).rejects.toThrow(
      ANTIGRAVITY_WORDS.noTools,
    );
  });

  it("reports a spent plan as typed headroom, the one failure the program types", async () => {
    const run = setUp({ turns: [[{ say: "Starting." }, { stop: "refusal" }]] });
    const session = await run.start();
    await session.prompt("Go.");
    expect(run.events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: ANTIGRAVITY_WORDS.spent,
      cutOff: { class: "no_headroom" },
    });
    expect(run.events.at(-1)).toEqual({ type: "turn_closed" });
  });

  it("stops a turn on request, and reports a stop's words as its failure", async () => {
    const run = setUp({
      turns: [
        [{ say: "Working." }, { wait: "cancel" }],
        [{ say: "Again." }, { wait: "cancel" }],
      ],
    });
    const session = await run.start();
    const first = session.prompt("Work for a long time.");
    await until(() => run.events.some((event) => event.type === "assistant_delta"));
    await session.abort();
    await first;
    expect(run.log().some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(run.events.filter((event) => event.type === "turn_failed")).toEqual([]);

    const second = session.prompt("Work again.");
    await until(() => run.events.filter((event) => event.type === "assistant_delta").length === 2);
    await session.abort("Stopped: the task was cancelled.");
    await second;
    expect(run.events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: "Stopped: the task was cancelled.",
    });
  });

  it("ends a turn whose program exits, then reopens the same conversation on the next prompt", async () => {
    const run = setUp({
      resume: true,
      turns: [[{ say: "Read." }], [{ say: "Half." }, { exit: 1 }], [{ say: "Back again." }]],
    });
    const session = await run.start();
    const id = session.sessionId;
    await session.prompt("Read the brief.");
    await session.prompt("Begin.");
    expect(run.events).toContainEqual({
      type: "turn_failed",
      taskId: "task-1",
      error: "Antigravity stopped: stand-in stopped on purpose",
    });
    expect(session.isStreaming()).toBe(false);

    await session.prompt("Continue.");
    expect(run.launches).toHaveLength(2);
    expect(run.log()).toContainEqual({
      method: "session/resume",
      params: expect.objectContaining({ sessionId: id }),
    });
    expect(session.sessionId).toBe(id);
    expect(session.resume()).toEqual({ backend: "antigravity", sessionId: id });
    // The same session's conversation holds the instructions its finished first turn carried.
    expect(run.prompts()[2]).toEqual(["Continue."]);
    expect(run.events.at(-1)).toEqual({ type: "turn_closed", text: "Back again." });
  });

  it("serves the working copy's instructions and skills, and serves them again when a later session reopens the conversation", async () => {
    const run = setUp({ resume: true, turns: [[{ say: "One." }], [{ say: "Two." }]] });
    writeFileSync(join(run.cwd, "AGENTS.md"), "Run pnpm check before every push.");
    const skill = join(run.cwd, ".claude", "skills", "print-layout");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: print-layout\ndescription: Lay out a print sheet.\n---\n",
    );
    const first = await run.start();
    await first.prompt("Begin.");
    const resume = first.resume();
    if (resume?.backend !== "antigravity") throw new Error("no conversation to reopen");
    first.dispose();
    await first.closed();

    // A new session, as after an app restart, reopens the recorded conversation.
    const second = await run.start(resume);
    await second.prompt("Continue.");
    expect(run.log()).toContainEqual({
      method: "session/resume",
      params: expect.objectContaining({ sessionId: resume.sessionId }),
    });
    const [opening, reopened] = run.prompts();
    for (const head of [opening?.[0], reopened?.[0]]) {
      expect(head).toContain("You are a crewmate on the print shop project.");
      expect(head).toContain("Run pnpm check before every push.");
      expect(head).toContain(`- print-layout (${join(skill, "SKILL.md")}): Lay out a print sheet.`);
    }
    expect(reopened?.[1]).toBe("Continue.");
  });

  it("refuses the first mate's seat and the one-shot roles", async () => {
    const run = setUp({ turns: [] });
    await expect(run.factory.open({ ...run.spec, builtins: "none" })).rejects.toThrow(
      ANTIGRAVITY_WORDS.onlyCrew,
    );
    await expect(
      run.factory.open({ ...run.spec, binding: { backend: "claude", accountId: "a" } }),
    ).rejects.toThrow("cannot open a claude session");
  });
});

/** Waits for a condition the stand-in's stream makes true; the test's own time limit bounds it. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}
