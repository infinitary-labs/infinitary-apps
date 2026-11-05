/**
 * The journey stand-in's readers (INF-2625's plan, the journey stand-ins
 * piece): what the scenarios read of a request and of a crewmate's tool
 * answers. The split moves these out of `mockProvider.ts` and rebases the
 * request readers on `providerRequest.ts`; these tests hold what each one
 * returns for the requests and answers the app's clients actually send, so
 * the move changes where they live and nothing a scenario reads.
 */
import { frameServedInput } from "@shared/servedFrame";
import { encode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { BROWSER_COMMAND } from "../src/core/browser/commandWords";
import { DELIVERY_COMPLETE } from "../src/core/orchestrator/contextDelivery";
import { renderWake } from "../src/core/orchestrator/wakes";
import { backgroundJobReceipt } from "../src/core/pi/bashWords";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../src/core/storage/sessionReader";
import {
  browser,
  calledTool,
  firstSentence,
  indexTaskId,
  knownRefOf,
  lookUpTask,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockModelsJson,
  mockProviderOverrideModelsJson,
  refOf,
  servedInstructions,
  shellJobsRunning,
  sinceLastUser,
  toolAnswers,
} from "./e2e/mockProvider";
import { providerMessages } from "./e2e/providerRequest";

/** A chat-completions tool loop's two legs, as Pi sends them. */
const chatCall = (name: string, args: unknown, id = "call_1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const chatResult = (content: string, id = "call_1") => ({
  role: "tool",
  tool_call_id: id,
  content,
});

describe("calledTool reads a call of a tool, never its definition", () => {
  const definitions = {
    tools: [
      { type: "function", function: { name: "report", description: "Report.", parameters: {} } },
    ],
  };

  it("on Pi's completions wire, compact or spaced", () => {
    const body = JSON.stringify({ ...definitions, messages: [{ role: "user", content: "go" }] });
    expect(calledTool(body, "report")).toBe(false);
    const called = JSON.stringify({
      ...definitions,
      messages: [
        { role: "user", content: "go" },
        chatCall("report", { text: "Done." }),
        chatResult("ok"),
      ],
    });
    expect(calledTool(called, "report")).toBe(true);
    expect(calledTool(called, "emit_card")).toBe(false);
    const spaced = JSON.stringify(JSON.parse(called), null, 1).replace(/\n\s*/g, " ");
    expect(spaced).toContain('"name": "report", "arguments"');
    expect(calledTool(spaced, "report")).toBe(true);
  });

  it("on the Responses wire", () => {
    const body = JSON.stringify({
      tools: [{ type: "function", name: "report", parameters: {} }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "call_1", name: "report", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
    expect(calledTool(body, "report")).toBe(true);
    expect(calledTool(body, "emit_card")).toBe(false);
  });

  it("on Anthropic's wire, under the name Claude's client serves the tool by", () => {
    const tool = `${CLAUDE_SEAT_TOOL_PREFIX}report`;
    const defined = {
      tools: [{ name: tool, description: "Report.", input_schema: { type: "object" } }],
    };
    const ask = { role: "user", content: [{ type: "text", text: "go" }] };
    expect(calledTool(JSON.stringify({ ...defined, messages: [ask] }), "report")).toBe(false);
    const body = JSON.stringify({
      ...defined,
      messages: [
        ask,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: tool, input: { text: "Done." } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
    });
    expect(calledTool(body, "report")).toBe(true);
  });
});

describe("sinceLastUser reads the newest words and the results after them", () => {
  it("on Pi's completions wire", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "You are a crewmate." },
        { role: "user", content: "older words" },
        { role: "assistant", content: "Done." },
        {
          role: "user",
          content: [
            { type: "text", text: "newest " },
            { type: "text", text: "words" },
          ],
        },
        chatCall("tasks", { text: "meter" }),
        chatResult("first"),
        chatCall("tasks", { text: "gauge" }, "call_2"),
        chatResult("second", "call_2"),
      ],
    });
    const read = sinceLastUser(body);
    expect(read.user).toBe("newest words");
    expect(read.results).toEqual(["first", "second"]);
    expect(read.tail).not.toContain("older words");
    expect(JSON.parse(read.tail)).toHaveLength(5);
  });

  it("on Anthropic's wire, where a result rides a user message of its own and the client adds notes", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "older words" }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>\nToday's date is 2026-11-05.\n</system-reminder>",
            },
            { type: "text", text: "newest words" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "tasks", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "first" }],
            },
            { type: "text", text: "<system-reminder>\nA note.\n</system-reminder>" },
          ],
        },
      ],
    });
    const read = sinceLastUser(body);
    expect(read.user).toContain("newest words");
    expect(read.results).toEqual(["first"]);
  });

  it("reads nothing of a body that is not a request", () => {
    expect(sinceLastUser("not json")).toEqual({ user: "", results: [], tail: "" });
    expect(sinceLastUser(JSON.stringify({ messages: [] }))).toEqual({
      user: "",
      results: [],
      tail: "",
    });
  });
});

describe("servedInstructions reads the instructions in any dialect", () => {
  it.each([
    [
      "Pi's completions",
      {
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi" },
        ],
      },
    ],
    [
      "a developer message",
      { messages: [{ role: "developer", content: [{ type: "text", text: "Be brief." }] }] },
    ],
    ["Responses", { instructions: "Be brief.", input: [] }],
    ["Anthropic's", { system: [{ type: "text", text: "Be brief." }], messages: [] }],
  ])("%s", (_, request) => {
    expect(servedInstructions(JSON.stringify(request)).trim()).toBe("Be brief.");
  });

  it("reads nothing of a body that is not a request", () => {
    expect(servedInstructions("not json")).toBe("");
  });
});

describe("a task's id, read the way a first mate finds it", () => {
  const crew = [
    { task_id: "task-1", title: "Steady the meter", status: "idle" },
    { task_id: "task-2", title: "Steady the meter twice", status: "idle" },
  ];
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: frameServedInput([
          {
            kind: "context",
            body: `[fm-op] context (not the user)\n${encode({ delivery: DELIVERY_COMPLETE, repos: [], crew })}`,
          },
          { kind: "user", origin: "captain", body: "[user]\nhello" },
        ]).text,
      },
    ],
  });

  it("off the context's crew, by its exact title", () => {
    expect(indexTaskId(body, "Steady the meter twice")).toBe("task-2");
    expect(indexTaskId(body, "Steady")).toBeUndefined();
  });

  it("off a tasks read when it is not started: the read, then the call that names it, then nothing", () => {
    const steer = (taskId: string) =>
      [{ name: "steer_crewmate", args: { task_id: taskId, message: "go" } }] as const;
    expect(lookUpTask("Fix the gauge", [], (id) => [...steer(id)])).toEqual({
      calls: [{ name: "tasks", args: { text: "Fix the gauge" } }],
    });
    const read = `Tasks matching "Fix the gauge":\n${JSON.stringify([
      { task_id: "task-9", title: "Fix the gauge twice" },
      { task_id: "task-8", title: "Fix the gauge" },
    ])}`;
    expect(lookUpTask("Fix the gauge", [read], (id) => [...steer(id)])).toEqual({
      calls: [...steer("task-8")],
    });
    expect(lookUpTask("Fix the gauge", ["No tasks match."], (id) => [...steer(id)])).toEqual({
      calls: [...steer("missing")],
    });
    expect(lookUpTask("Fix the gauge", [read, "Steered."], (id) => [...steer(id)])).toBeUndefined();
  });
});

describe("a crewmate's browser answers, as the browser scripts read them", () => {
  const page =
    'page: Sign in\nrefs: g2\noutline: lines 1-2 of 2\nheading "Sign in" (level 1)\nbutton "Send now" [g2:e4]';

  it("a browser command is one shell call of the task's browser, each word quoted only when it must be", () => {
    expect(browser("click", "g2:e4")).toEqual({
      name: "bash",
      args: { command: `${BROWSER_COMMAND} click g2:e4`, description: "Use this task's browser" },
    });
    expect(browser("fill", "g2:e5", "it's 5 o'clock").args).toMatchObject({
      command: `${BROWSER_COMMAND} fill g2:e5 'it'\\''s 5 o'\\''clock'`,
    });
  });

  it("reads each answer in the browser's own words, a slow one as the one answer it gave", () => {
    const messages = providerMessages(
      JSON.stringify({
        messages: [
          { role: "user", content: "Open the page." },
          chatResult("exit 0\nrunning: open"),
          chatResult(`exit 0\nearlier: Your earlier open finished\n${page}`),
          chatResult(
            'exit 0\npage: Sign in\nrefs: g2\ndid: "Clicked button \\"Send now\\" [g2:e4]."',
          ),
          chatResult('Exit code 1\nerror: "No control has ref g2:e9"'),
          chatResult("README.md\npackage.json"),
        ],
      }),
    );
    expect(toolAnswers(messages)).toEqual([
      page,
      'page: Sign in\nrefs: g2\ndid: Clicked button "Send now" [g2:e4].',
      "No control has ref g2:e9",
      "README.md\npackage.json",
    ]);
    expect(toolAnswers(messages, 4)).toEqual([
      "No control has ref g2:e9",
      "README.md\npackage.json",
    ]);
  });

  it("finds a control's ref in the newest outline of the current book", () => {
    expect(refOf(page, "button", "Send")).toBe("g2:e4");
    expect(refOf(page, "link", "Send")).toBeUndefined();
    const older = 'page: Sign in\nrefs: g1\nbutton "Send now" [g1:e3]';
    const changes = 'refs: g2\ndid: Typed.\n- old line 2: button "Send later" [g2:e7]';
    expect(knownRefOf([older, page, changes], "button", "Send")).toBe("g2:e4");
    expect(knownRefOf([older], "button", "Send")).toBe("g1:e3");
    expect(knownRefOf([older, changes], "button", "Send")).toBeUndefined();
  });

  it("quotes an answer's first sentence", () => {
    expect(firstSentence('did: Clicked button "Send now" [g2:e4]. The page moved.')).toBe(
      'Clicked button "Send now" [g2:e4].',
    );
    expect(firstSentence("exit 0\nThe captain returned control. Take a fresh look.")).toBe(
      "The captain returned control.",
    );
    expect(firstSentence(undefined)).toBe("");
  });

  it("holds a shell job running until its own exit wake comes", () => {
    const receipt = (id: string) => chatResult(backgroundJobReceipt(id));
    const exit = (id: string) => ({
      role: "user",
      content: frameServedInput([
        {
          kind: "wake",
          origin: "agent",
          body: renderWake({
            facts: {
              kind: "job-exit",
              to: "crewmate",
              jobId: id,
              command: "make build",
              exitCode: 0,
              durationMs: 4000,
              tail: "ok",
            },
          }),
        },
      ]).text,
    });
    const body = (...messages: unknown[]) =>
      JSON.stringify({ messages: [{ role: "user", content: "Build it." }, ...messages] });
    expect(shellJobsRunning(body())).toBe(false);
    expect(shellJobsRunning(body(receipt("j1")))).toBe(true);
    expect(shellJobsRunning(body(receipt("j1"), exit("j2")))).toBe(true);
    expect(shellJobsRunning(body(receipt("j1"), exit("j1")))).toBe(false);
    expect(shellJobsRunning(body(receipt("j1"), receipt("j2"), exit("j1")))).toBe(true);
  });
});

describe("the models.json a journey points the app at the stand-in with", () => {
  it("defines the mock model under its own provider", () => {
    expect(JSON.parse(mockModelsJson(4321))).toEqual({
      providers: {
        [MOCK_PROVIDER_ID]: {
          name: "Mock provider",
          baseUrl: "http://127.0.0.1:4321/v1",
          api: "openai-completions",
          apiKey: "mock-key",
          models: [{ id: MOCK_MODEL_ID, name: "Mock model", input: ["text", "image"] }],
        },
      },
    });
  });

  it("points a key-signed provider at the stand-in and defines nothing else", () => {
    expect(JSON.parse(mockProviderOverrideModelsJson(4321))).toEqual({
      providers: { openrouter: { baseUrl: "http://127.0.0.1:4321/v1" } },
    });
    expect(JSON.parse(mockProviderOverrideModelsJson(4321, "xai"))).toEqual({
      providers: { xai: { baseUrl: "http://127.0.0.1:4321/v1" } },
    });
  });
});
