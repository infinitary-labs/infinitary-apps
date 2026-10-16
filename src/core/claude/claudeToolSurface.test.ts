import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type McpSdkServerConfigWithInstance, query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { sdkBundledClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { answerText, startStubApi } from "../../../tests/helpers/anthropicDialect";
import {
  answerTool,
  claudeSeatBox,
  seatBoxesFlushed,
} from "../../../tests/helpers/claudeSeatHarness";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { createAppTools } from "../pi/appTools";
import { EMIT_CARD_TOOL_DESCRIPTION } from "../pi/cardTool";
import { CLAUDE_TOOL_DESCRIPTION_CAP } from "../prompts/cardContract";
import { LOCAL_MACHINE_ID } from "../session/session";
import { type BoundTool, FIRSTMATE_TOOLS } from "../session/tools";
import { CLAUDE_SEAT_TOOL_PREFIX, CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";
import { resolveClaudeExecutable } from "./claudeCli";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { claudeToolServer, claudeToolsOf, zodShapeOf } from "./claudeTaskTools";
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

/** One tool as the captured request carries it. */
type ServedTool = { name: string; description?: string; input_schema?: Schema };

/**
 * Every parameter description a schema carries, by its path: `constraints`
 * at the top level, `actions[].effect<settle>.mode` below it (a union member
 * is named by its `kind`). A top-level path has no separator; every other
 * one is nested, which is what the client drops.
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
    const served = await captureServedTools(cwd, claudeToolServer(censusTools(cwd)));
    const ours = served.filter((tool) => tool.name.startsWith(CLAUDE_SEAT_TOOL_PREFIX));
    expect(ours.length, "the in-process tool server reached the model").toBeGreaterThan(0);

    const source = new Map(
      claudeToolsOf(censusTools(cwd)).map((tool) => [
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

    // `emit_card` is the only app tool with nested parameters, and the
    // audit found only its top-level descriptions surviving. Whatever a
    // Claude crewmate must know lives in the description or in one of
    // these; since v4.59 no nested parameter is described at all.
    const emitCard = ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}emit_card`);
    expect(emitCard?.description).toContain(
      "Name it in the body and say it starts once it is merged",
    );
    expect(
      ours.find((tool) => tool.name === `${CLAUDE_SEAT_TOOL_PREFIX}file_followup`)?.description,
    ).toContain("title beginning Continue:");
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
 * nested field carries no description on any runtime - the Claude client
 * never served one, and the copy a Pi seat read repeated the served text -
 * so each rule lives in the `actions` description or in the tool's own
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
  "actions[].effect<request_merge>.review":
    "kind request_merge with review naming the id check_change returned",
  "actions[].effect<settle>.mode":
    "settle merge merges a direct-pr task's PR or merges a local-only task's branch and closes the task; settle discard drops the worktree unmerged",
  "actions[].effect<settle>.confirm":
    "confirm true only when the body already says there are unmerged commits or uncommitted edits",
  "actions[].effect<settle>.proceed_with_open":
    "proceed_with_open true to settle a task that has open children and keep them planned, when a refusal names it",
  "actions[].effect<open>.target": "target settings|subscriptions|projects",
  "actions[].effect<open>.sign_in":
    "sign_in naming the host whose sign-in the projects section starts, exactly as a not-signed-in refusal's way names it",
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
      const servedParameters = parameterDescriptions(arrived?.input_schema);
      for (const [path, description] of parameterDescriptions(tool.parameters as Schema)) {
        if (isNested(path)) nested.push(`${tool.name}.${path}`);
        if (servedParameters.get(path) !== description) lost.push(`${tool.name}.${path}`);
      }
    }
    expect(lost, "a rule the client did not serve, which a Claude seat never reads").toEqual([]);
    // The client drops every nested description, so the source declares
    // none: a rule written there would reach a Pi seat alone.
    expect(nested, "a rule declared below a top-level parameter").toEqual([]);

    // Each nested emit_card field's rule is carried by the text that is served.
    const emitCard = ours.get("emit_card");
    const servedCardText = [
      emitCard?.description ?? "",
      ...parameterDescriptions(emitCard?.input_schema).values(),
    ].join("\n");
    const source = tools.find((tool) => tool.name === "emit_card");
    expect(
      new Set(nestedFields(source?.parameters as Schema)),
      "every nested emit_card field names its carrier",
    ).toEqual(new Set(Object.keys(EMIT_CARD_NESTED_CARRIERS)));
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
      // What the two that describe the machine and the person may say.
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
