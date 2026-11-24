import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type McpSdkServerConfigWithInstance, query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  acceptedPlanCase,
  largeDesignCase,
  scorePlanRead,
} from "../../../scripts/evals/acceptedPlan";
import { approvalHost } from "../../../scripts/evals/host";
import { sdkBundledClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { answerText, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS } from "../../../tests/helpers/claudeMcpLimit";
import {
  answersTool,
  answerTool,
  claudeSeatBox,
  seatBoxesFlushed,
} from "../../../tests/helpers/claudeSeatHarness";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { readPagedTaskQuery } from "../../../tests/helpers/taskQueryText";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { createAppTools } from "../pi/appTools";
import { EMIT_CARD_TOOL, EMIT_CARD_TOOL_DESCRIPTION } from "../pi/cardTool";
import { FOLLOWUP_AFTER_MERGE_RULE } from "../pi/crewmateTaskTools";
import { createTasksQueryTool, parseTasksFieldPage, parseTasksQueryText } from "../pi/taskTools";
import { piToolOf } from "../pi/toolSpec";
import { CLAUDE_TOOL_DESCRIPTION_CAP } from "../prompts/cardContract";
import { LOCAL_MACHINE_ID } from "../session/session";
import { type BoundTool, bindTool, FIRSTMATE_TOOLS } from "../session/tools";
import {
  CLAUDE_SEAT_TOOL_PREFIX,
  CLAUDE_SEAT_TOOL_SERVER,
  readSession,
} from "../storage/sessionReader";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS } from "./claudeSessionOptions";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { claudeToolOf, claudeToolServer, claudeToolsOf, zodShapeOf } from "./claudeTaskTools";
import { locateClaudeTranscript } from "./claudeTranscript";

/**
 * What the Claude transport actually SERVES of the app's own tools.
 *
 * The visual-density audit (`fm3000-card-visual-density-audit-s1`, section
 * 4.3a and appendix A) found the vendored client truncating a tool
 * description at 2,048 characters and dropping every nested parameter
 * description - so from contract v2.0 to v3.5 a Claude crewmate received
 * 2,061 of the card contract's 5,283 characters and rebuilt the rest from
 * refusals. It cost behaviour, not just bytes: on the completion rules those
 * crewmates never saw, compliance ran 50-75% against 100% for the Pi
 * families. Nothing in the repository guarded it, which is why it lasted.
 * The nested loss was not the client's: the SDK's own tool server wrote each
 * schema with the older zod it bundles, which also dropped every limit, and
 * the app serves its own since INF-744 (`claudeToolServer`).
 *
 * Two guards, in the order they are worth having:
 *
 * 1. Every app-owned description is under the cap. Pure and fast, and it is
 *    what fails the next contract revision that grows one past it again.
 * 2. What the real client sends equals the source, captured hermetically:
 *    the real in-process tool server, the real `query()`, a local stub API,
 *    a dummy key and a throwaway HOME. No credential is read, no sign-in is
 *    started, nothing is billed. This one caught a second loss the audit had
 *    not found on its first run: the client transliterates non-ASCII in a
 *    description (`close_card` said `card-fm-...` with an ellipsis and the
 *    model was served three periods), so app tool text stays ASCII. It
 *    runs for a crewmate's server and for the Firstmate's set (contract
 *    v4.13), where every rule the source declares must arrive: a Claude
 *    seat reads what a Pi seat reads.
 * 3. What the client adds to the Firstmate seat on its own, beside what the
 *    app serves: every attachment type the client records for a seat's
 *    session is one docs/claude-client.md accepts, so a client that starts
 *    injecting a new one fails here instead of reaching the Firstmate
 *    unseen.
 */

/**
 * A Claude crewmate's tools as its preset binds them, with every optional
 * callback present, so the census sees them all.
 */
function censusTools(cwd: string): readonly BoundTool[] {
  return crewmateSessionSpec(
    appPathsFor(cwd),
    { ...crewmateToolDelegate(), machineId: LOCAL_MACHINE_ID, cwd },
    { backend: "claude", accountId: "acct_census" },
  ).tools;
}

/**
 * Every app-owned description, by the name it is served under: the
 * Firstmate's whole set as the live agent serves it (all 27, through the
 * same generator a Claude seat uses), the crewmate's emit_card, and every
 * tool a Claude crewmate is served.
 */
async function appToolDescriptions(): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>([
    ["emit_card (crewmate)", EMIT_CARD_TOOL_DESCRIPTION],
  ]);
  for (const tool of claudeToolsOf(await firstmateTools())) {
    descriptions.set(`${tool.name} (firstmate)`, tool.description);
  }
  for (const tool of claudeToolsOf(censusTools(tmpdir()))) {
    descriptions.set(`${tool.name} (crewmate, claude)`, tool.description);
  }
  return descriptions;
}

// INF-968, re-typed by INF-2744: a saved-story merge card reaches the home
// the same way through both session backends, which alone knows the task's
// autonomy, and neither accepts content that competes with the saved story.
// INF-3060: a copy of the story's risk or required actions goes to the home,
// which holds it against the story (crewmateCards.completion.test.ts).
it.each(["Pi", "Claude"] as const)(
  "forwards saved-story merge cards and copies of their risk or required actions through %s, refusing competing content",
  async (backend) => {
    const onCard = vi.fn(() => "card-task-story");
    const bound = bindTool(EMIT_CARD_TOOL, { onCard });
    const run = (params: Record<string, unknown>) =>
      backend === "Pi"
        ? piToolOf(bound).execute("story", params, undefined, undefined, {} as never)
        : claudeToolOf(bound).handler(params, {} as never);
    const params = {
      title: "The story is ready",
      presentation: 2,
      actions: [{ id: "merge", effect: { kind: "merge", after: "close" } }],
    };
    const result = await run(params);
    expect(result.content).toEqual([
      { type: "text", text: "Card shown from presentation 2 (card-task-story)" },
    ]);
    expect(onCard).toHaveBeenLastCalledWith({
      title: params.title,
      body: "",
      presentationRevision: 2,
      actions: [
        expect.objectContaining({ id: "merge", effect: { kind: "merge", after: "close" } }),
      ],
    });
    const copied = await run({ ...params, required_actions: [] });
    expect(copied.content).toEqual([
      {
        type: "text",
        text: "Card shown from presentation 2 (card-task-story). The required_actions you passed repeats the saved revision exactly, so the copy was left out.",
      },
    ]);
    expect(onCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: "", requiredActions: [] }),
    );
    for (const competing of [
      { actions: [] },
      { body: "A different story" },
      { body_file: "story.html" },
      { risk: {} },
      { browser_button: "View" },
      { browser_page: "index.html" },
      { browser_handoff: { site: "example.com", reason: "Sign in", after: "Check" } },
      { asking: true },
      { design_only: true },
      { continues: true },
    ]) {
      await expect(run({ ...params, ...competing })).rejects.toThrow(/without body/);
    }
    expect(onCard).toHaveBeenCalledTimes(2);
  },
);

it("Claude carries the catalog value intact to the strict action validator", async () => {
  const calls: unknown[] = [];
  const tools = createAppTools({
    dispatch: async (channel, args) => {
      calls.push([channel, args]);
      return true as never;
    },
    actor: () => ({ kind: "firstmate", wake: "captain" }),
  });
  const change = tools.find((tool) => tool.name === "app_change");
  if (!change) throw new Error("Missing app_change");
  const schema = z.object(zodShapeOf(change.parameters));
  const accepted = schema.parse({
    action: "notifications",
    value: { enabled: false },
    evidence: "off",
  });
  await change.run(accepted);
  expect(calls).toContainEqual(["inf:settings:notifications:set", [false]]);
  calls.length = 0;
  const rejected = schema.parse({
    action: "notifications",
    value: { enabled: false, extra: true },
    evidence: "off",
  });
  expect((await change.run(rejected)).text).toMatch(/extra/);
  expect(calls).toEqual([]);
});

// INF-5326's piece 3: a named read's args are one object, and a Claude seat
// must hand a nested schedule on unchanged to the request Settings asks.
it("Claude carries a named read's nested args intact to its request", async () => {
  const calls: unknown[] = [];
  const state = createAppTools({
    dispatch: async (channel, args) => {
      calls.push([channel, args]);
      return { dates: [] } as never;
    },
    actor: () => ({ kind: "firstmate", wake: "captain" }),
  }).find((tool) => tool.name === "app_state");
  if (!state) throw new Error("Missing app_state");
  const spec = {
    kind: "weekly",
    days: [1, 3],
    hour: 9,
    minute: 0,
    timeZone: "America/Los_Angeles",
  };
  const accepted = z
    .object(zodShapeOf(state.parameters as Parameters<typeof zodShapeOf>[0]))
    .parse({ read: "automation.preview", args: { spec } });
  expect(JSON.parse((await state.run(accepted)).text)).toEqual({
    read: "automation.preview",
    value: { dates: [] },
  });
  expect(calls).toEqual([["inf:automation:preview", [spec]]]);
});

// INF-799 piece 1: a step's result shape is a whole JSON Schema, served as a
// bare object parameter, and a Claude seat must hand it on unchanged.
it("Claude carries a declared result shape whole through create_task and spawn_crewmate", async () => {
  const findings = {
    type: "object",
    required: ["files", "summary"],
    properties: {
      files: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
  };
  const tools = await firstmateTools();
  for (const name of ["create_task", "spawn_crewmate", "update_task"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    const shape = zodShapeOf(tool.parameters as Parameters<typeof zodShapeOf>[0]);
    expect(shape.result_schema?.parse(findings), name).toEqual(findings);
  }
});

describe("the app's tool descriptions fit the Claude transport", () => {
  it("keeps every app-owned description under the client's 2,048-character cap", async () => {
    const descriptions = await appToolDescriptions();
    expect(
      [...descriptions.keys()].filter((name) => name.endsWith("(firstmate)")),
      "the census covers the Firstmate's whole tool set",
    ).toHaveLength(FIRSTMATE_TOOLS.length + 1);
    const over = [...descriptions]
      .filter(([, description]) => description.length >= CLAUDE_TOOL_DESCRIPTION_CAP)
      .map(([name, description]) => `${name}: ${description.length} chars`);
    expect(over, "a description at or past the cap is silently truncated on Claude").toEqual([]);
  });
});

/** A parameter schema as the source declares it and as the captured request carries it. */
type Schema = {
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  const?: unknown;
};

type ServedTool = { name: string; description?: string; input_schema?: Schema };

/**
 * Every parameter description a schema carries, by its path: `constraints`
 * at the top level, `actions[].effect<settle>.mode` below it (a union member
 * is named by its `kind`). A top-level path has no separator; every other
 * one is nested, which no app tool describes.
 */
function parameterDescriptions(schema: Schema | undefined, at = ""): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: Schema | undefined, path: string) => {
    if (!node) return;
    if (path && node.description !== undefined) found.set(path, node.description);
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      visit(property, path ? `${path}.${name}` : name);
    }
    visit(node.items, `${path}[]`);
    // A union member is its own place a rule can sit: named by its `kind`,
    // else its own `const`, else its index, and always nested.
    for (const [index, member] of [...(node.anyOf ?? []), ...(node.oneOf ?? [])].entries()) {
      visit(member, `${path}<${String(member.properties?.kind?.const ?? member.const ?? index)}>`);
    }
  };
  visit(schema, at);
  return found;
}

function isNested(path: string): boolean {
  return /[.[<]/.test(path);
}

/** A source schema as JSON carries it: typebox's own symbol keys left out. */
function asJson(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

/**
 * Run the real client against a local stub and return the tools it sent. The
 * stub answers 400 to the first request that carries them, which is all it
 * takes: the client gives up instead of retrying forever, and that request
 * is the evidence.
 */
async function captureServedTools(
  cwd: string,
  server: McpSdkServerConfigWithInstance,
): Promise<ServedTool[]> {
  let captured: ServedTool[] | undefined;
  const stub = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: ServedTool[] };
        if (!captured && Array.isArray(body.tools)) captured = body.tools;
      } catch {
        // Not a messages request; the tools ride the one that is.
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as AddressInfo).port;
  const session = query({
    prompt: "tool surface census",
    options: {
      cwd,
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: "tool surface census" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { [CLAUDE_SEAT_TOOL_SERVER]: server },
      // Nothing of the machine's own reaches this run: no credential, no
      // config dir it could read, and no base URL but the stub's.
      env: {
        PATH: process.env.PATH ?? "",
        // The client keeps a claude-<uid> dir in TMPDIR on Linux; give it
        // this run's scratch so it goes with the test.
        TMPDIR: cwd,
        HOME: cwd,
        CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "sk-ant-tool-surface-census-not-a-real-key",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      // The client the product would run - the override, else the installed
      // one - and, where a runner has neither, the copy the SDK keeps in
      // node_modules (never shipped): the point is what the real transport
      // does, and verify.yml points this at today's native install.
      ...(resolveClaudeExecutable()
        ? { pathToClaudeCodeExecutable: resolveClaudeExecutable() }
        : {}),
    },
  });
  try {
    for await (const _message of session) {
      if (captured) break;
    }
  } catch {
    // The stub's 400 ends the run.
  } finally {
    stub.close();
  }
  return captured ?? [];
}

describe("what the Claude client serves equals the source", () => {
  it("sends every crewmate tool's description verbatim, with its top-level parameter descriptions", {
    timeout: 180_000,
  }, async () => {
    const cwd = scratchDir("infinitary-tool-surface-");
    const tools = censusTools(cwd);
    const served = await captureServedTools(cwd, claudeToolServer(tools));
    const ours = served.filter((tool) => tool.name.startsWith(CLAUDE_SEAT_TOOL_PREFIX));
    expect(ours.length, "the in-process tool server reached the model").toBeGreaterThan(0);

    const source = new Map(
      claudeToolsOf(tools).map((tool) => [
        `${CLAUDE_SEAT_TOOL_PREFIX}${tool.name}`,
        tool.description,
      ]),
    );
    expect(new Set(ours.map((tool) => tool.name))).toEqual(new Set(source.keys()));
    for (const tool of ours) {
      expect(tool.description, `${tool.name} arrived truncated or rewritten`).toBe(
        source.get(tool.name),
      );
    }

    // INF-125: exact effect consent must reach Claude, including the top-level parameter help.
    const write = ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}github_write`);
    const writeSource = tools.find((tool) => tool.name === "github_write");
    const effectHelp = (writeSource?.parameters as Schema | undefined)?.properties?.validationEffect
      ?.description;
    expect(effectHelp).toBeTruthy();
    expect(write?.input_schema?.properties?.validationEffect?.description).toBe(effectHelp);
    console.info(
      "INF-125 captured Claude forge consent",
      JSON.stringify({
        description: write?.description,
        descriptionLength: write?.description?.length,
        validationEffect: write?.input_schema?.properties?.validationEffect?.description,
      }),
    );

    // INF-733: the change story's relationships, which no schema can say,
    // reach Claude whole in the story's own description before it is sent.
    const prepare = ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}prepare_change`);
    const storySource = tools.find((tool) => tool.name === "prepare_change");
    const storyHelp = (storySource?.parameters as Schema | undefined)?.properties?.story
      ?.description;
    expect(storyHelp).toBeTruthy();
    expect(prepare?.input_schema?.properties?.story?.description).toBe(storyHelp);
    // INF-2142's approved plan: the story's own help says who reads it and
    // what publishable declares, on Claude as on Pi.
    expect(storyHelp).toContain("write for a stranger");
    expect(storyHelp).toContain(
      "publishable true declares you read it whole once as that stranger and it holds nothing personal or local",
    );

    // INF-744: each tool's schema arrives as the source declares it, so every
    // limit on it - an integer, a minimum or maximum, a pattern, an item
    // count, a length - reaches Claude before a call, as it reaches Pi.
    for (const tool of tools) {
      const arrived = ours.find(
        (served) => served.name === `${CLAUDE_SEAT_TOOL_PREFIX}${tool.name}`,
      );
      expect(arrived?.input_schema, `${tool.name} arrived with its schema rewritten`).toEqual(
        asJson(tool.parameters),
      );
    }

    // `emit_card` is the only app tool with nested parameters, and the
    // audit found only its top-level descriptions surviving. Whatever a
    // Claude crewmate must know lives in the description or in one of
    // these; since v4.59 no nested parameter is described at all.
    const emitCard = ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`);
    expect(emitCard?.description).toContain(
      "No merge or settle effects on intermediate questions; reuse an open merge card's id.",
    );
    expect(
      ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}file_followup`)?.description,
    ).toContain(FOLLOWUP_AFTER_MERGE_RULE);
    const properties = emitCard?.input_schema?.properties ?? {};
    for (const name of ["title", "body", "body_file", "id", "actions"]) {
      expect(properties[name]?.description, `emit_card.${name} lost its description`).toBeTruthy();
    }
    // FI3-249: a crewmate declares its completion decision's merge without
    // a label, as it is told, so the client must not ask it for one.
    expect(properties.actions?.items?.required).toEqual(["id"]);
    // Contract 4.22: a Claude crewmate reads that a pick in the body sends
    // nothing - the footer click carries the body's named fields.
    expect(emitCard?.description).toContain(
      "A footer button is the one send and carries every named field in the body",
    );
  });
});

/**
 * Every field a schema nests below a top-level parameter, by its path, with
 * or without words of its own: `actions[].effect<settle>.mode`.
 */
function nestedFields(schema: Schema | undefined): string[] {
  const found: string[] = [];
  const visit = (node: Schema | undefined, path: string) => {
    if (!node) return;
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const at = path ? `${path}.${name}` : name;
      if (path && name !== "kind") found.push(at);
      visit(property, at);
    }
    visit(node.items, `${path}[]`);
    for (const [index, member] of [...(node.anyOf ?? []), ...(node.oneOf ?? [])].entries()) {
      visit(member, `${path}<${String(member.properties?.kind?.const ?? member.const ?? index)}>`);
    }
  };
  visit(schema, "");
  return found;
}

/**
 * Where each nested emit_card field's rule is said. Since contract v4.59 a
 * nested field carries no description on any runtime - a Claude seat was
 * served none until INF-744, and the copy a Pi seat read repeated the served
 * text - so each rule lives in the `actions` description or in the tool's own
 * (`CARD_MECHANICS`). Keyed by the nested path: a new nested field fails
 * the census below until the phrase that carries its rule is named here.
 */
const EMIT_CARD_NESTED_CARRIERS: Record<string, string> = {
  "required_actions[].id": "id (stable kebab-case)",
  "required_actions[].sharedId": "sharedId (explicitly shared outstanding action)",
  "required_actions[].target": "target, title (imperative)",
  "required_actions[].title": "target, title (imperative)",
  "required_actions[].consequence": "consequence, instructions (list)",
  "required_actions[].instructions": "consequence, instructions (list)",
  "required_actions[].criterion": "criterion, prerequisites (task IDs)",
  "required_actions[].prerequisites": "criterion, prerequisites (task IDs)",
  "required_actions[].completion":
    "completion (manual with label, or device-version with deviceId and minVersion)",
  "required_actions[].completion<manual>.label": "manual with label",
  "required_actions[].completion<device-version>.deviceId":
    "device-version with deviceId and minVersion",
  "required_actions[].completion<device-version>.minVersion":
    "device-version with deviceId and minVersion",
  "actions[].id": "id (stable, kebab-case)",
  "actions[].label": "label (sentence case)",
  "actions[].default": "marks exactly one default, the step you would take",
  "actions[].effect":
    "An action's effect is what the host does on the click; with no effect the click returns to you as a message.",
  "actions[].danger": "danger true renders a destructive choice",
  "actions[].declines": "declines true marks your own way to say no to every choice",
  // INF-3846 piece 3: a choice the captain puts off until a task closes, a time, an event or their word.
  "actions[].until": "until on an action with no effect offers Not until",
  "actions[].until.task":
    "kind close with task (a task key; back when that task closes, merged or not)",
  "actions[].until.at": "date with at (an ISO time)",
  "actions[].until.integration":
    "event with integration, event and filter (any event an automation rule can wait for)",
  "actions[].until.event":
    "event with integration, event and filter (any event an automation rule can wait for)",
  "actions[].until.filter":
    "event with integration, event and filter (any event an automation rule can wait for)",
  "actions[].effect<merge>.after":
    "kind merge with after close (ends the task once nothing else is open) or continue",
  "actions[].effect<merge>.review": "review (check_change pull's id; omit for your current change)",
  "actions[].effect<merge>.asks_first":
    "asks_first (why a standing direction leaves this merge to the captain)",
  "actions[].effect<merge>.proceed_with_open":
    "proceed_with_open true settles a task with open children, keeping them planned, when a refusal names it",
  "actions[].effect<settle>.mode":
    "merge merges a PR or local-only branch, and its after closes or continues the task; settle discard drops the worktree unmerged",
  "actions[].effect<settle>.confirm":
    "confirm true only when the body already says there are unmerged commits or uncommitted edits",
  "actions[].effect<settle>.proceed_with_open":
    "proceed_with_open true settles a task with open children, keeping them planned, when a refusal names it",
  "actions[].effect<open>.target": "target settings|subscriptions|projects",
  "actions[].effect<open>.sign_in":
    "sign_in naming the host whose sign-in the projects section starts, exactly as a not-signed-in refusal's way names it",
  "actions[].effect<open>.folder":
    "folder true with target projects makes a Choose folder button, adding the folder the captain picks as a project",
};

describe("what the Claude client serves the Firstmate equals the source (contract v4.13)", () => {
  it("carries every rule the source declares, so a Claude seat reads what a Pi seat reads", {
    timeout: 180_000,
  }, async () => {
    const cwd = scratchDir("infinitary-firstmate-surface-");
    const tools: BoundTool[] = await firstmateTools();
    // The Firstmate's tools on the one in-process server every Claude
    // session serves its tools on, a crewmate's included.
    const served = await captureServedTools(cwd, claudeToolServer(tools));
    const ours = new Map(
      served
        .filter((tool) => tool.name.startsWith(CLAUDE_SEAT_TOOL_PREFIX))
        .map((tool) => [tool.name.slice(CLAUDE_SEAT_TOOL_PREFIX.length), tool]),
    );
    expect(new Set(ours.keys()), "the client served the Firstmate's whole set").toEqual(
      new Set(tools.map((tool) => tool.name)),
    );

    const lost: string[] = [];
    const nested: string[] = [];
    for (const tool of tools) {
      const arrived = ours.get(tool.name);
      expect(arrived?.description, `${tool.name} arrived truncated or rewritten`).toBe(
        tool.description,
      );
      // INF-744: and its schema as declared, every limit on it included.
      expect(arrived?.input_schema, `${tool.name} arrived with its schema rewritten`).toEqual(
        asJson(tool.parameters),
      );
      const servedParameters = parameterDescriptions(arrived?.input_schema);
      for (const [path, description] of parameterDescriptions(tool.parameters as Schema)) {
        if (isNested(path)) nested.push(`${tool.name}.${path}`);
        if (servedParameters.get(path) !== description) lost.push(`${tool.name}.${path}`);
      }
    }
    expect(lost, "a rule the client did not serve, which a Claude seat never reads").toEqual([]);
    // Each rule has its home in a description or a top-level parameter
    // (contract v4.59), so the source declares no nested description.
    expect(nested, "a rule declared below a top-level parameter").toEqual([]);

    // Each nested emit_card field's rule is carried by the text that is served.
    const emitCard = ours.get("emit_card");
    const servedCardText = [
      emitCard?.description ?? "",
      ...parameterDescriptions(emitCard?.input_schema).values(),
    ].join("\n");
    const source = tools.find((tool) => tool.name === "emit_card");
    // Fields the served schema leaves open (`required_actions` entries and
    // the `until` details) keep their carrier below: their rules are still
    // said in the description.
    expect(
      nestedFields(source?.parameters as Schema).filter(
        (path) => !(path in EMIT_CARD_NESTED_CARRIERS),
      ),
      "every nested emit_card field names its carrier",
    ).toEqual([]);
    for (const [path, carrier] of Object.entries(EMIT_CARD_NESTED_CARRIERS)) {
      expect(servedCardText, `emit_card ${path} is not carried by what is served`).toContain(
        carrier,
      );
    }
  });
});

/**
 * Every attachment type the client may add to the Firstmate seat's session,
 * each one accepted in docs/claude-client.md ("What the client adds to the
 * seat"). Measured on the installed 2.1.283 with the seat's switch
 * (`CLAUDE_SEAT_ENV`); the SDK's co-released 2.1.234 records none of them.
 * `silent_turn_reminder` and `total_tokens_reminder` are what the switch
 * keeps out, and so are not here.
 */
const SEAT_ATTACHMENTS = [
  // The seat's working directory and the machine (fields below).
  "environment",
  // The served model's name, id and knowledge cutoff.
  "model",
  // The signed-in Claude account's email (fields below).
  "session_context",
  // Today's date.
  "date",
  // The client's own record of the system prompt it served, the app's.
  "prompt_snapshot",
];

/** What `environment` may say about the machine, field by field. */
const SEAT_ENVIRONMENT_FIELDS = [
  "workingDirectory",
  "isWorktree",
  "isGitRepo",
  "additionalWorkingDirectories",
  "platform",
  "shell",
  "osVersion",
];

/** What `session_context` may say about the person. */
const SEAT_SESSION_CONTEXT_FIELDS = ["userEmail"];

/** A made-up address, never the person's: it proves where an email would go. */
const BOXED_EMAIL = "captain@example.invalid";

describe("what the Claude client adds to the Firstmate seat", () => {
  afterEach(async () => {
    resetStoreLeasesForTest();
    await seatBoxesFlushed();
  });

  it("carries only the attachments docs/claude-client.md accepts", {
    timeout: 180_000,
  }, async () => {
    const api = await startStubApi();
    try {
      // The client the product would run, boxed on the seat's harness: the
      // override, else the installed one, else the SDK's own copy (as above).
      const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
      // A signed-in account's record, with a made-up email: the client reads
      // the address it would put in session_context from here.
      mkdirSync(b.configDir, { recursive: true });
      writeFileSync(
        join(b.configDir, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: BOXED_EMAIL } }),
      );
      const tools = await firstmateTools();
      // Eight tool calls without a word before the answer: past the point
      // the installed client tells a quiet turn "the user hasn't heard from you".
      let quietCalls = 8;
      api.answer((request, res) => {
        if (quietCalls === 0) return answerText(request, res, "Aye.");
        quietCalls -= 1;
        return answerTool(request, res, "crew_status", {});
      });
      const session = await b.factory({
        cwd: b.cwd,
        sessionsDir: join(b.home, "firstmate", "sessions"),
        binding: { backend: "claude", accountId: "acct_census" },
        model: { provider: "anthropic-claude", id: "claude-opus-5-5" },
        tools,
        instructions: { text: "Answer in one line.", sha: "sha-instructions" },
      });
      await session.prompt("how is the crew?");
      await session.prompt("and now?");
      session.dispose();
      await session.closed();
      expect(quietCalls, "the quiet run reached the client").toBe(0);

      const transcript = locateClaudeTranscript({
        configDir: b.configDir,
        cwd: b.cwd,
        sessionId: session.sessionId,
      });
      expect(transcript, "the client recorded the seat's session").toBeTruthy();
      const attachments = readFileSync(transcript as string, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; attachment?: Record<string, unknown> })
        .filter((entry) => entry.type === "attachment")
        .map((entry) => entry.attachment ?? {});

      const unaccepted = [
        ...new Set(attachments.map((attachment) => String(attachment.type))),
      ].filter((type) => !SEAT_ATTACHMENTS.includes(type));
      expect(unaccepted, "an attachment docs/claude-client.md does not accept").toEqual([]);
      for (const { type, ...fields } of attachments) {
        if (type === "environment") {
          const snapshot = (fields.snapshot ?? {}) as Record<string, unknown>;
          expect(
            Object.keys(snapshot).filter((field) => !SEAT_ENVIRONMENT_FIELDS.includes(field)),
            "environment says something new about the machine",
          ).toEqual([]);
        }
        if (type === "session_context") {
          const context = (fields.context ?? {}) as Record<string, unknown>;
          expect(
            Object.keys(context).filter((field) => !SEAT_SESSION_CONTEXT_FIELDS.includes(field)),
            "session_context says something new about the person",
          ).toEqual([]);
        }
      }
    } finally {
      await api.close();
    }
  });
});

// INF-113: a complete keyed plan must reach the model through the installed client's own cap.
describe("the accepted plan through the real Claude client", () => {
  afterEach(async () => {
    resetStoreLeasesForTest();
    await seatBoxesFlushed();
  });
  it.each([
    { name: acceptedPlanCase.id, test: acceptedPlanCase, key: "PLAN" },
    { name: largeDesignCase.id, test: largeDesignCase, key: "PLAN" },
    { name: "captured INF-91", test: acceptedPlanCase, key: "182c1d82" },
  ])(
    "serves the complete native tasks result for $name without oversized-result substitution",
    {
      timeout: 180_000,
    },
    async ({ test, key }) => {
      const model = { provider: "anthropic-claude", id: "claude-opus-5-5" };
      const host = await approvalHost(test, scratchDir("accepted-plan-transport-"), model, []);
      const api = await startStubApi();
      try {
        const box = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
        const captured =
          key === "182c1d82"
            ? JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8"))
            : undefined;
        // INF-1306: a paged field request reaches the native query owner too.
        // Derive that field from the request issued below; keep the exact shape assertion.
        let requestedField: string | undefined;
        const capturedRead = captured
          ? createTasksQueryTool((input) => {
              expect(input).toEqual(
                requestedField === undefined ? { key } : { key, field: requestedField },
              );
              return { rows: captured, total: captured.length };
            })
          : undefined;
        const served: string[] = [];
        const tools = host.spec.tools.map((tool) =>
          tool.name !== "tasks"
            ? tool
            : {
                ...tool,
                run: async (args: unknown) => {
                  const answer = await (capturedRead ?? tool).run(args);
                  served.push(answer.text);
                  return answer;
                },
              },
        );
        const nextPage = (): { field: string; offset: number } | undefined => {
          const index = served.find((text) => text.includes("does not fit one read"));
          if (!index) return undefined;
          const finished = new Set(
            served.flatMap((text) => {
              const page = parseTasksFieldPage(text);
              return page?.nextOffset === null ? [page.field] : [];
            }),
          );
          const open = served.flatMap((text) => {
            const page = parseTasksFieldPage(text);
            return page?.nextOffset ? [page] : [];
          });
          const continuing = open.findLast((page) => !finished.has(page.field));
          if (continuing?.nextOffset)
            return { field: continuing.field, offset: continuing.nextOffset };
          const omitted = parseTasksQueryText(index).omitted.find(
            (item) => !finished.has(item.field),
          );
          return omitted ? { field: omitted.field, offset: 1 } : undefined;
        };
        api.answer((request, res) => {
          if (!answersTool(request)) return answerTool(request, res, "tasks", { key });
          const page = nextPage();
          requestedField = page?.field;
          return page
            ? answerTool(request, res, "tasks", { key, ...page })
            : answerText(request, res, "Read the accepted plan.");
        });
        const session = await box.factory({
          cwd: box.cwd,
          sessionsDir: join(box.home, "firstmate", "sessions"),
          binding: { backend: "claude", accountId: "acct_fixture" },
          model,
          tools,
        });
        await session.prompt(host.prompt);
        session.dispose();
        await session.closed();
        const received = api.requests
          .at(-1)
          ?.body.messages?.flatMap((message) =>
            message.role === "user" && Array.isArray(message.content) ? message.content : [],
          )
          .findLast((block) => block.type === "tool_result");
        const content = received?.content;
        const text =
          typeof content === "string"
            ? content
            : content?.map((block: { text?: string }) => block.text ?? "").join("\n");
        expect(served.length).toBeGreaterThan(0);
        expect(text).toBe(served.at(-1));
        if (captured) expect(readPagedTaskQuery(served)).toEqual(captured);
        else {
          const native = readSession(session.recordPath()!)
            .entries.filter((entry) => entry.type === "message")
            .map((entry) => entry.message as { role?: string; content?: unknown });
          const reads = served.map((item) => ({ text: item, servedText: item }));
          expect(scorePlanRead(test, reads, native)).toEqual([]);
          expect(
            scorePlanRead(test, [{ ...reads[0]!, servedText: "truncated" }], native),
          ).not.toEqual([]);
          expect(scorePlanRead(test, reads, [])).not.toEqual([]);
          if (parseTasksQueryText(served[0]!).omitted.length > 0) {
            expect(scorePlanRead(test, reads.slice(0, -1), native)).not.toEqual([]);
          }
        }
        expect(api.requests).toHaveLength(served.length + 1);
      } finally {
        await host.close();
        await api.close();
      }
    },
  );
});

// INF-451: past its 50,000-character default the client saves a tool result to a file and
// serves a preview, which the seat has no tool to open. Every result in the seat's band
// must reach the model whole.
describe("a first mate tool result past the client's default band", () => {
  afterEach(async () => {
    resetStoreLeasesForTest();
    await seatBoxesFlushed();
  });
  // The captured INF-91 row as one read would serve it whole, before the tasks tool pages it.
  const record = JSON.stringify(
    JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8")),
    null,
    2,
  );
  it.each([
    { name: "the captured INF-91 row", text: record },
    {
      name: "that record filling the seat's band to its last character",
      text: record.repeat(2).slice(0, CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS),
    },
  ])("reaches the model whole: $name", { timeout: 180_000 }, async ({ text }) => {
    expect(text.length).toBeGreaterThan(CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS);
    expect(text.length).toBeLessThanOrEqual(CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS);
    const api = await startStubApi();
    try {
      const box = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
      const tools = (await firstmateTools()).map((tool) =>
        tool.name === "tasks" ? { ...tool, run: async () => ({ text }) } : tool,
      );
      api.answer((request, res) =>
        answersTool(request)
          ? answerText(request, res, "Read it.")
          : answerTool(request, res, "tasks", { key: "INF-91" }),
      );
      const session = await box.factory({
        cwd: box.cwd,
        sessionsDir: join(box.home, "firstmate", "sessions"),
        binding: { backend: "claude", accountId: "acct_fixture" },
        model: { provider: "anthropic-claude", id: "claude-opus-5-5" },
        tools,
      });
      await session.prompt("Read INF-91.");
      session.dispose();
      await session.closed();
      expect(api.requests).toHaveLength(2);
      const received = api.requests
        .at(-1)
        ?.body.messages?.flatMap((message) =>
          message.role === "user" && Array.isArray(message.content) ? message.content : [],
        )
        .findLast((block) => block.type === "tool_result")?.content;
      const served =
        typeof received === "string"
          ? received
          : received?.map((block: { text?: string }) => block.text ?? "").join("\n");
      expect(served?.length).toBe(text.length);
      expect(served).toBe(text);
    } finally {
      await api.close();
    }
  });
});
