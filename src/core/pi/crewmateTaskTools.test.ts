import { validateToolArguments } from "@earendil-works/pi-ai";
import { CHECK_DECLARATION_VERDICTS } from "@shared/checkRepair";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { claudeCrewmateTools, zodShapeOf } from "../claude/claudeTaskTools";
import { ORDINARY_NOTE_READ_ACK, ORDINARY_NOTE_READ_GUIDANCE } from "../prompts/cardContract";
import { crewmateTool } from "../session/tools";
import { CREWMATE_TOOLS, CREWMATE_TOOLS_MODULE, crewmateToolManifest } from "./crewmateTaskTools";
import { createCrewmateTools } from "./crewmateTools";
import { buildCrewmateSystemPrompt } from "./piResources";

/**
 * The crewmate tool spec (primitives P7): one list both runtimes generate
 * their tools from. These tests hold the generated tools - the Pi tools a
 * crewmate session is handed and the Claude tools its in-process server
 * carries - to the spec and to each other, by what they serve and what
 * they do, never by how they are written.
 */

type PiTool = ReturnType<typeof createCrewmateTools>[number];
type ClaudeTool = ReturnType<typeof claudeCrewmateTools>[number];

/** A JSON Schema without the wrapper keys each library adds on its own. */
function normalized(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalized);
  if (!schema || typeof schema !== "object") return schema;
  const entries = Object.entries(schema as Record<string, unknown>)
    .filter(([key]) => key !== "$schema" && key !== "additionalProperties")
    .map(([key, value]) => [key, normalized(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const out = Object.fromEntries(entries) as Record<string, unknown>;
  // A union of discriminated objects: zod says oneOf, typebox anyOf.
  if (Array.isArray(out.oneOf)) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  // A union of string constants is an enum, however it is spelled.
  const members = out.anyOf as Record<string, unknown>[] | undefined;
  if (members?.every((member) => typeof member.const === "string")) {
    out.type = "string";
    out.enum = members.map((member) => member.const);
    delete out.anyOf;
  }
  // An empty required list and no required list say the same thing.
  if (Array.isArray(out.required) && out.required.length === 0) delete out.required;
  // Any JSON object, such as start_program's args: zod spells it with no declared fields.
  if (
    out.type === "object" &&
    out.properties &&
    Object.keys(out.properties as Record<string, unknown>).length === 0
  )
    delete out.properties;
  // An integer bound is the same bound whichever way the library spells it.
  if (out.type === "integer") {
    delete out.maximum;
    delete out.minimum;
  }
  return out;
}

/** What the Claude client is handed for a tool's parameters, as JSON Schema. */
function claudeSchema(tool: ClaudeTool): unknown {
  return z.toJSONSchema(z.object(tool.inputSchema as Record<string, z.ZodType>));
}

async function runPi(tool: PiTool, params: unknown) {
  const result = await tool.execute("call-1", params as never, undefined, undefined, {} as never);
  return result.content;
}

async function runClaude(tool: ClaudeTool, params: unknown) {
  const result = await tool.handler(params as never, {});
  return result.content;
}

/** A completion decision's whole risk: every dimension rated (FI3-1128). */
const RISK = {
  blast: { level: "low", why: "Two files in the meter" },
  behavior: { level: "low", why: "Corrects the unit" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "high", why: "Adds a parser package" },
} as const;

/** One valid call per crewmate tool, with the callback it must reach. */
const CALLS: Record<string, { params: Record<string, unknown>; callback: string }> = {
  emit_card: {
    params: {
      title: "Ready to merge",
      body: "<p>Green on the head.</p>",
      actions: [
        { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
        { id: "hold", label: "Hold" },
      ],
      risk: RISK,
    },
    callback: "onCard",
  },
  close_card: { params: { card_id: "card-task-1-1", reason: "stale" }, callback: "onCloseCard" },
  file_followup: {
    params: { title: "Fix the flake", goal: "It passes", why: "It failed twice", blocks_me: true },
    callback: "onFollowup",
  },
  start_program: {
    params: {
      title: "Audit the meter",
      goal: "Every defect in the meter is found and checked.",
      script: 'return await task("Find a defect in the meter.");',
      args: { areas: ["src/meter.ts"] },
      bound: 2,
    },
    callback: "onStartProgram",
  },
  note_progress: { params: { text: "Reproduced it" }, callback: "onProgress" },
  report: {
    params: { text: "Done and verified", summary: "The search reads keys." },
    callback: "onReport",
  },
  reply: { params: { card_id: "card-task-1-1", text: "Yes" }, callback: "onReply" },
  revise_required_action: {
    params: {
      action: "task-2",
      source: "INF-1",
      action_id: "remove-job-host",
      expected_generation: 1,
      patch: { instructions: ["Run C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd"] },
      reason: "The remover's path was wrong",
      operation_id: "op-1",
      same_action: true,
    },
    callback: "onReviseRequiredAction",
  },
  tasks: { params: { status: "live", limit: 5 }, callback: "onQueryTasks" },
  knowledge: { params: { action: "search", query: "wake queue" }, callback: "knowledge.read" },
  record_knowledge: {
    params: {
      action: "publish",
      request_id: "r1",
      kind: "finding",
      text: "A failed turn is retried.",
      basis: "observation",
      about: ["c-1a2b3c"],
      conditions: "main",
      sources: [{ path: "src/inbox.ts", start_line: 1, end_line: 4 }],
    },
    callback: "knowledge.record",
  },
  lint_panel: { params: { id: "weather" }, callback: "onLintPanel" },
  place_panel: { params: { id: "weather" }, callback: "onPlacePanel" },
  capture_panel: { params: { id: "weather" }, callback: "onCapturePanel" },
  read_workflow: { params: { runId: 10, jobId: 20, offset: 5 }, callback: "onReadWorkflow" },
  download_artifact: { params: { runId: 10, artifactId: 30 }, callback: "onDownloadArtifact" },
  github_read: { params: { path: "/repos/o/r/pulls/1" }, callback: "onGithubRead" },
  github_write: {
    params: { method: "POST", path: "/repos/o/r/issues/1/comments", body: '{"body":"hi"}' },
    callback: "onGithubWrite",
  },
  prepare_change: {
    params: {
      story: {
        title: "fix: keep confirmed uploads",
        base: "5ca2d466ee21f9733827383f23df81f3874e0d10",
        head: "5ca2d466ee21f9733827383f23df81f3874e0d10",
        publishable: true,
        why: ["Uploads must survive restart."],
        whatChanged: ["The task keeps confirmed receipts."],
        before: ["A restart could send the bytes twice."],
        after: ["A confirmed receipt is reused."],
        views: [],
        noPicture: "This changes internal upload recovery, not a visible view.",
        checked: [{ check: "Publication", result: "The selected story and evidence agree." }],
        verification: ["Restart recovery passed."],
        risk: RISK,
        requiredActions: [],
        unfinished: [],
        projectText: "",
      },
    },
    callback: "onPrepareChange",
  },
  open_change: { params: { title: "Fix", body: "Intent" }, callback: "onOpenChange" },
  check_change: {
    params: {
      diagnosis: {
        headSha: "a",
        check: "linux-checks",
        classification: "own-regression",
        evidence: "The failed assertion reproduces only with my change",
      },
    },
    callback: "onCheckChange",
  },
};

describe("the crewmate tool spec", () => {
  // Both served runtimes must distinguish ordinary read acknowledgement from aside.
  it("serves the ordinary-read rule in report fields and card guidance on Pi and Claude", () => {
    const delegate = crewmateToolDelegate();
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report") as PiTool;
    const claude = claudeCrewmateTools(delegate).find(
      (tool) => tool.name === "report",
    ) as ClaudeTool;
    for (const schema of [pi.parameters, claudeSchema(claude)]) {
      const properties = (schema as { properties: Record<string, { description?: string }> })
        .properties;
      expect(properties.finished?.description).toContain(ORDINARY_NOTE_READ_ACK);
      expect(properties.waiting_on_captain?.description).toContain(ORDINARY_NOTE_READ_ACK);
    }
    for (const backend of ["pi", "claude"] as const) {
      expect(buildCrewmateSystemPrompt(backend)).toContain(ORDINARY_NOTE_READ_GUIDANCE);
    }
  });

  it("keeps the progress rule within Claude's tool description limit", () => {
    const tool = CREWMATE_TOOLS.find((entry) => entry.name === "note_progress");
    expect(tool?.description.length).toBeLessThan(2048);
    expect(tool?.description).toContain(
      "whole list with every later note, unchanged if nothing moved",
    );
    // INF-1464: the captain watched the plan stand still while a crewmate worked.
    expect(tool?.description).toContain(
      "as soon as a plan item finishes or the work moves to the next item, in the middle of your turn",
    );
  });

  it("keeps the GitHub tools within Claude's description limit (INF-205)", () => {
    for (const name of ["github_read", "github_write", "read_workflow"]) {
      const described = CREWMATE_TOOLS.find((entry) => entry.name === name);
      expect(described?.description.length, name).toBeLessThan(2048);
      expect(described?.description, name).not.toContain("not another program");
      expect(described?.description, name).not.toContain("When the captain's own words ask");
    }
    const write = CREWMATE_TOOLS.find((entry) => entry.name === "github_write");
    expect(write?.description).toContain(
      'Send "return_run_details":true yourself in a GitHub workflow dispatch; the app adds nothing',
    );
    expect(write?.description).toContain("confirm the run's head_sha");
    expect(JSON.stringify(write?.parameters)).toContain("accepted only on GitHub's upload address");
    expect(JSON.stringify(write?.parameters)).toContain("/projects/{id}/releases/{tag}");
  });

  it("serves every entry on Pi and on Claude, in the spec's order", () => {
    const delegate = crewmateToolDelegate();
    const names = CREWMATE_TOOLS.map((tool) => tool.name);
    expect(createCrewmateTools(delegate).map((tool) => tool.name)).toEqual(names);
    expect(claudeCrewmateTools(delegate).map((tool) => tool.name)).toEqual(names);
    expect(Object.keys(CALLS).sort()).toEqual([...names].sort());
  });

  it("gives both runtimes the spec's words and the same parameters", () => {
    const delegate = crewmateToolDelegate();
    const pi = createCrewmateTools(delegate);
    const claude = claudeCrewmateTools(delegate);
    CREWMATE_TOOLS.forEach((spec, index) => {
      const piTool = pi[index] as PiTool;
      const claudeTool = claude[index] as ClaudeTool;
      expect(piTool.description, spec.name).toBe(spec.description);
      expect(piTool.label, spec.name).toBe(spec.label);
      expect(claudeTool.description, spec.name).toBe(spec.description);
      expect(piTool.parameters, spec.name).toBe(spec.parameters);
      expect(normalized(claudeSchema(claudeTool)), spec.name).toEqual(normalized(spec.parameters));
    });
  });

  it("does the same thing on both runtimes: one callback, one answer", async () => {
    for (const spec of CREWMATE_TOOLS) {
      const call = CALLS[spec.name];
      if (!call) throw new Error(`no call for ${spec.name}`);
      const media = scratchDir("infinitary-tool-story-");
      const piDelegate = { ...crewmateToolDelegate(), picturesDir: media, cwd: media };
      const claudeDelegate = { ...crewmateToolDelegate(), picturesDir: media, cwd: media };
      const piTool = createCrewmateTools(piDelegate).find((tool) => tool.name === spec.name);
      const claudeTool = claudeCrewmateTools(claudeDelegate).find(
        (tool) => tool.name === spec.name,
      );
      const piContent = await runPi(piTool as PiTool, call.params);
      const claudeContent = await runClaude(claudeTool as ClaudeTool, call.params);
      expect(claudeContent, spec.name).toEqual(piContent);
      expect(
        piDelegate.calls.map((entry) => entry.callback),
        spec.name,
      ).toEqual([call.callback]);
      expect(claudeDelegate.calls, spec.name).toEqual(piDelegate.calls);
    }
  });

  it("carries a report's declarations to the host on both runtimes (FI3-435, FI3-710)", async () => {
    const declared: unknown[] = [];
    const delegate = {
      ...crewmateToolDelegate(),
      onReport: (_text: string, _summary?: string, declaration?: unknown) => {
        declared.push(declaration);
        return "reported";
      },
    };
    const params = {
      text: "The captain approved the plan by reply, with the limit at 32.",
      needs_firstmate: "start the builder on the approved plan",
      finished: true,
      // INF-1607: the same evidenced attribution reaches the host from either runtime.
      first_release: {
        version: "0.6.0",
        url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.6.0",
        evidence: "Published source contains the merge, absent from earlier published sources.",
        tasks: ["INF-1607"],
      },
    };
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report");
    const claude = claudeCrewmateTools(delegate).find((tool) => tool.name === "report");
    await runPi(pi as PiTool, params);
    await runClaude(claude as ClaudeTool, params);
    const expected = {
      needsFirstmate: "start the builder on the approved plan",
      finished: true,
      firstRelease: params.first_release,
    };
    expect(declared).toEqual([expected, expected]);
    // The rule rides a top-level parameter, which the Claude client serves.
    expect(
      (
        claudeSchema(claude as ClaudeTool) as {
          properties: Record<string, { description?: string }>;
        }
      ).properties.needs_firstmate?.description,
    ).toContain("authorizes nothing");
  });

  it("INF-2214 carries individually named responses identically on Pi and Claude", async () => {
    const declared: unknown[] = [];
    const delegate = {
      ...crewmateToolDelegate(),
      onReport: (_text: string, _summary?: string, declaration?: unknown) => {
        declared.push(declaration);
        return "saved and queued";
      },
    };
    const params = {
      text: "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd",
      responses: [{ request_id: "path-request", response_id: "path-answer", status: "answered" }],
    };
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report");
    const claude = claudeCrewmateTools(delegate).find((tool) => tool.name === "report");
    await runPi(pi as PiTool, params);
    await runClaude(claude as ClaudeTool, params);
    const expected = {
      responses: [{ requestId: "path-request", responseId: "path-answer", status: "answered" }],
    };
    expect(declared).toEqual([expected, expected]);
  });

  it("INF-1554 F4: omits empty recovery findings on both runtimes but carries real findings", async () => {
    const declared: Record<string, unknown>[] = [];
    const delegate = {
      ...crewmateToolDelegate(),
      onReport: (_text: string, _summary?: string, declaration?: unknown) => {
        declared.push(declaration as Record<string, unknown>);
        return "reported";
      },
    };
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report");
    const claude = claudeCrewmateTools(delegate).find((tool) => tool.name === "report");
    for (const run of [
      () => runPi(pi as PiTool, { text: "The checks still run.", recovery_ways: [] }),
      () => runClaude(claude as ClaudeTool, { text: "The checks still run.", recovery_ways: [] }),
    ])
      await run();
    expect(declared).toEqual([{}, {}]);
    const ways = [
      {
        action: "Take over the blocked branch",
        hold: "waits",
        evidence: "The running host record owns the refusal",
        nextFact: "The successor starts on the branch",
      },
    ];
    await runPi(pi as PiTool, { text: "A takeover is available.", recovery_ways: ways });
    await runClaude(claude as ClaudeTool, {
      text: "A takeover is available.",
      recovery_ways: ways,
    });
    expect(declared.slice(2)).toEqual([{ recoveryWays: ways }, { recoveryWays: ways }]);
  });

  it("INF-1554 F7: carries each recovery way's declared approach on both runtimes", async () => {
    const declared: unknown[] = [];
    const delegate = {
      ...crewmateToolDelegate(),
      onReport: (_text: string, _summary?: string, declaration?: unknown) => {
        declared.push(declaration);
        return "reported";
      },
    };
    const ways = [
      {
        action: "Start the takeover from the committed branch",
        approach: "workaround",
        hold: "waits",
        evidence: "The running first mate serves branch_from",
        nextFact: "The takeover starts on the branch",
      },
      {
        action: "Retry the checks on a stronger model",
        approach: "stronger-model",
        hold: "escalation",
        evidence: "The same check failed after two repairs",
        nextFact: "The captain picks a model",
      },
    ];
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report");
    const claude = claudeCrewmateTools(delegate).find((tool) => tool.name === "report");
    await runPi(pi as PiTool, { text: "Two ways remain.", recovery_ways: ways });
    await runClaude(claude as ClaudeTool, { text: "Two ways remain.", recovery_ways: ways });
    expect(declared).toEqual([{ recoveryWays: ways }, { recoveryWays: ways }]);
  });

  // Source: R6 of INF-1644: the home reads another build's way leniently, so
  // this build's report tool is where an unknown hold or approach is refused.
  it("refuses a recovery way outside this build's holds and approaches on both runtimes", () => {
    const pi = createCrewmateTools(crewmateToolDelegate()).find(
      (tool) => tool.name === "report",
    ) as PiTool;
    const claude = claudeCrewmateTools(crewmateToolDelegate()).find(
      (tool) => tool.name === "report",
    ) as ClaudeTool;
    const reportWith = (way: Record<string, unknown>) => ({
      text: "One way remains.",
      recovery_ways: [
        {
          action: "Start the takeover from the committed branch",
          hold: "waits",
          evidence: "The running first mate serves branch_from",
          nextFact: "The takeover starts on the branch",
          ...way,
        },
      ],
    });
    // What each runtime checks a call against before the tool runs.
    const accepted = (args: unknown) => {
      let pass = true;
      try {
        validateToolArguments(
          pi as never,
          {
            type: "toolCall",
            id: "call-1",
            name: "report",
            arguments: args,
          } as never,
        );
      } catch {
        pass = false;
      }
      const claudePass = z
        .object(claude.inputSchema as Record<string, z.ZodType>)
        .safeParse(args).success;
      return { pi: pass, claude: claudePass };
    };
    const both = { pi: true, claude: true };
    const neither = { pi: false, claude: false };
    expect(accepted(reportWith({}))).toEqual(both);
    expect(accepted(reportWith({ approach: "workaround" }))).toEqual(both);
    // INF-1688 retired the repair limit; an older build's other words are not this build's.
    expect(accepted(reportWith({ hold: "repairs" }))).toEqual(neither);
    expect(accepted(reportWith({ approach: "reroute" }))).toEqual(neither);
  });

  it("INF-125: carries validation once, separately from a report's captain wait on both runtimes", async () => {
    const declared: unknown[] = [];
    const delegate = {
      ...crewmateToolDelegate(),
      onReport: (_text: string, _summary?: string, declaration?: unknown) => {
        declared.push(declaration);
        return "reported";
      },
    };
    const params = {
      text: "The documentation-only change is ready for the captain's decision.",
      validation: {
        kind: "plan",
        previousRevision: 0,
        reason: "Only explanatory prose changes; there is no running surface.",
        scenarios: [],
      },
      waiting_on_captain: { reason: "Read the documentation change", card_id: "documentation" },
    };
    const pi = createCrewmateTools(delegate).find((tool) => tool.name === "report");
    const claude = claudeCrewmateTools(delegate).find((tool) => tool.name === "report");
    await runPi(pi as PiTool, params);
    await runClaude(claude as ClaudeTool, params);
    const expected = {
      validation: params.validation,
      wait: { reason: params.waiting_on_captain.reason, cardId: params.waiting_on_captain.card_id },
    };
    expect(declared).toEqual([expected, expected]);
  });

  it("INF-2441: refuses a value past a limit its served schema leaves out, on both runtimes", async () => {
    // The served form of a zod-owned parameter keeps its shape and leaves the
    // owner's lengths and item counts out for room; the tool's own parse
    // still refuses past them, before the host is reached.
    const delegate = crewmateToolDelegate();
    const pi = createCrewmateTools(delegate);
    const claude = claudeCrewmateTools(delegate);
    const calls = [
      {
        tool: "open_change",
        parameter: "recovery",
        limit: "retryUploads",
        params: { title: "fix(cards): keep the footer", recovery: { retryUploads: [] } },
      },
      {
        tool: "report",
        parameter: "validation",
        limit: "reason",
        params: {
          text: "The plan is recorded.",
          validation: {
            kind: "plan",
            previousRevision: 0,
            reason: "The whole build log, pasted. ".repeat(160),
            scenarios: [],
          },
        },
      },
    ];
    for (const { tool, parameter, limit, params } of calls) {
      const schema = pi.find((each) => each.name === tool)?.parameters as {
        properties: Record<string, unknown>;
      };
      expect(JSON.stringify(schema.properties[parameter]), tool).not.toMatch(
        /"(min|max)(Length|Items)"/,
      );
      await expect(
        runPi(pi.find((each) => each.name === tool) as PiTool, params),
        `${tool} on Pi`,
      ).rejects.toThrow(limit);
      await expect(
        runClaude(claude.find((each) => each.name === tool) as ClaudeTool, params),
        `${tool} on Claude`,
      ).rejects.toThrow(limit);
    }
    expect(delegate.calls).toEqual([]);
  });

  it("carries a capture's pictures beside its text on both runtimes", async () => {
    const pi = createCrewmateTools(crewmateToolDelegate()).find(
      (tool) => tool.name === "capture_panel",
    );
    const content = await runPi(pi as PiTool, { id: "weather" });
    expect(content.map((part) => part.type)).toEqual(["text", "image"]);
  });

  it("serves no browser tool, with a browser or without: the browser is a command in the crewmate's shell", () => {
    const { browser: _browser, ...without } = crewmateToolDelegate();
    for (const delegate of [crewmateToolDelegate(), without]) {
      const names = createCrewmateTools(delegate).map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("browser_"))).toEqual([]);
      expect(claudeCrewmateTools(delegate).map((tool) => tool.name)).toEqual(names);
    }
  });

  it("serves only the tools a crewmate's callbacks bind, on both runtimes", () => {
    const { onCard, onReport, taskId, cwd } = crewmateToolDelegate();
    const partial = { onCard, onReport, taskId, cwd };
    expect(createCrewmateTools(partial).map((tool) => tool.name)).toEqual(["emit_card", "report"]);
    expect(claudeCrewmateTools(partial).map((tool) => tool.name)).toEqual(["emit_card", "report"]);
  });

  it("validates a nested card action on Claude the way Pi's schema does", () => {
    const emitCard = claudeCrewmateTools(crewmateToolDelegate()).find(
      (tool) => tool.name === "emit_card",
    ) as ClaudeTool;
    const schema = z.object(emitCard.inputSchema as Record<string, z.ZodType>);
    expect(schema.safeParse(CALLS.emit_card?.params).success).toBe(true);
    const unknownEffect = {
      title: "t",
      body: "b",
      actions: [{ id: "a", label: "A", effect: { kind: "host", mode: "merge" } }],
    };
    expect(schema.safeParse(unknownEffect).success).toBe(false);
  });

  it("refuses a retired keeps_open on both runtimes rather than dropping it (contract 4.65)", async () => {
    // A crewmate whose earlier turns declared a keep-open Revise button may
    // send it again. Dropped, it would become a choice that closes the card.
    const call = {
      id: "call-1",
      name: "emit_card",
      arguments: {
        title: "Plan the cache",
        body: "<p>Cache the keys.</p><ul><li>Reads halve.</li></ul>",
        actions: [
          { id: "revise", label: "Revise the plan", keeps_open: true },
          { id: "approve", label: "Approve and build", default: true },
        ],
      },
    };
    const refusal = /action "revise" passes keeps_open, which is retired.*changes by reply/;

    const piDelegate = crewmateToolDelegate();
    const piTool = createCrewmateTools(piDelegate).find(
      (tool) => tool.name === "emit_card",
    ) as PiTool;
    // What Pi's agent loop hands the tool after checking the call against its schema.
    const piArgs = validateToolArguments(piTool as never, { type: "toolCall", ...call } as never);
    await expect(runPi(piTool, piArgs)).rejects.toThrow(refusal);
    expect(piDelegate.calls).toEqual([]);

    const claudeDelegate = crewmateToolDelegate();
    const claudeTool = claudeCrewmateTools(claudeDelegate).find(
      (tool) => tool.name === "emit_card",
    ) as ClaudeTool;
    // What the Claude client hands the tool after parsing the call with the served schema.
    const claudeArgs = z
      .object(claudeTool.inputSchema as Record<string, z.ZodType>)
      .parse(call.arguments);
    await expect(runClaude(claudeTool, claudeArgs)).rejects.toThrow(refusal);
    expect(claudeDelegate.calls).toEqual([]);

    // The same card without the retired flag goes up on both.
    const plain = {
      ...call.arguments,
      actions: [
        { id: "later", label: "Not now" },
        { id: "approve", label: "Approve and build", default: true },
      ],
    };
    await runPi(piTool, plain);
    await runClaude(claudeTool, plain);
    expect(piDelegate.calls.map((entry) => entry.callback)).toEqual(["onCard"]);
    expect(claudeDelegate.calls).toEqual(piDelegate.calls);
  });

  it("takes a completion decision that declares the merge without a label on both runtimes (FI3-249)", async () => {
    // The crewmate is told the host attaches the completion buttons and to
    // declare no labels, so its schema must let the merge go unlabeled; the
    // host words the buttons (`CrewmateCards.withCompletionActions`).
    const call = {
      id: "call-1",
      name: "emit_card",
      arguments: {
        title: "The meter reads true",
        body: "<h3>Why</h3><p>The meter read low.</p>",
        actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
        risk: RISK,
      },
    };
    // Both of a crewmate's schemas: with its task's browser and without one.
    const delegateFor = (withBrowser: boolean) => {
      const { browser, ...delegate } = crewmateToolDelegate();
      return withBrowser ? { ...delegate, browser } : delegate;
    };
    for (const withBrowser of [true, false]) {
      const piDelegate = delegateFor(withBrowser);
      const piTool = createCrewmateTools(piDelegate).find(
        (tool) => tool.name === "emit_card",
      ) as PiTool;
      // What Pi's agent loop hands the tool after checking the call against its schema.
      const piArgs = validateToolArguments(piTool as never, { type: "toolCall", ...call } as never);
      await runPi(piTool, piArgs);

      const claudeDelegate = delegateFor(withBrowser);
      const claudeTool = claudeCrewmateTools(claudeDelegate).find(
        (tool) => tool.name === "emit_card",
      ) as ClaudeTool;
      // What the Claude client hands the tool after parsing the call with the served schema.
      const claudeArgs = z
        .object(claudeTool.inputSchema as Record<string, z.ZodType>)
        .parse(call.arguments);
      await runClaude(claudeTool, claudeArgs);

      expect(piDelegate.calls, `browser: ${withBrowser}`).toEqual([
        {
          callback: "onCard",
          input: expect.objectContaining({
            actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
            // Its risk reaches the host whole, through either runtime's schema.
            riskDeclaration: RISK,
          }),
        },
      ]);
      expect(claudeDelegate.calls, `browser: ${withBrowser}`).toEqual(piDelegate.calls);
    }
  });

  it("forwards evidence-backed check verdicts whole on both runtimes (INF-1177)", async () => {
    for (const verdict of CHECK_DECLARATION_VERDICTS) {
      const input = {
        declaration: {
          headSha: "93355db9d04e964513879db74d068a7789cb4c16",
          verdict,
          evidence: "The exact-version check reading and failed-job log.",
          ...(verdict === "settled" ? { repairId: "phone-fix", outcome: "superseded" } : {}),
        },
      };
      const received: unknown[] = [];
      const receive = async (input: unknown) => {
        received.push(input);
        return "recorded";
      };
      const pi = { ...crewmateToolDelegate(), onCheckChange: receive },
        claude = { ...crewmateToolDelegate(), onCheckChange: receive };
      await runPi(createCrewmateTools(pi).find((tool) => tool.name === "check_change")!, input);
      await runClaude(
        claudeCrewmateTools(claude).find((tool) => tool.name === "check_change")!,
        input,
      );
      expect(received).toEqual([input, input]);
    }
  });

  it("makes a new crewmate tool one entry that both runtimes and the pin pick up", async () => {
    const ping = crewmateTool({
      name: "ping",
      label: "Ping",
      description: "Answer pong.",
      parameters: Type.Object({
        times: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "How often" })),
      }),
      bind: ({ onProgress }) =>
        onProgress &&
        (async (params) => ({ text: await onProgress(`pong x${params.times ?? 1}`) })),
    });
    const spec = [...CREWMATE_TOOLS, ping];
    const delegate = crewmateToolDelegate();

    const piPing = createCrewmateTools(delegate, spec).at(-1) as PiTool;
    const claudePing = claudeCrewmateTools(delegate, spec).at(-1) as ClaudeTool;
    expect(piPing.name).toBe("ping");
    expect(claudePing.name).toBe("ping");
    expect(claudePing.description).toBe("Answer pong.");
    expect(normalized(claudeSchema(claudePing))).toEqual(normalized(ping.parameters));
    expect(await runPi(piPing, { times: 2 })).toEqual(await runClaude(claudePing, { times: 2 }));
    expect(delegate.calls.map((entry) => entry.input)).toEqual(["pong x2", "pong x2"]);

    expect(crewmateToolManifest(spec).at(-1)).toEqual({
      name: "ping",
      module: CREWMATE_TOOLS_MODULE,
    });
  });

  it("refuses a parameter Claude's tool server cannot carry rather than loosening it", () => {
    const schema = Type.Object({ map: Type.Record(Type.String(), Type.String()) });
    expect(() => zodShapeOf(schema)).toThrow(/parameters\.map/);
  });
});
