import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { claudeToolServer } from "../src/core/claude/claudeTaskTools";
import { renderRigorSection } from "../src/core/orchestrator/intentBrief";
import { SAVED_STORY_RULE } from "../src/core/pi/cardTool";
import { CREWMATE_TOOLS } from "../src/core/pi/crewmateTaskTools";
import { OLLAMA_MIN_CONTEXT } from "../src/core/pi/ollamaProfile";
import { LOCAL_CONTEXT_RESERVE, localInputFits } from "../src/core/pi/ollamaStream";
import {
  buildCrewmateSystemPrompt,
  type CrewmateBackend,
  type CrewmateProcedureFacts,
  crewmateCardBodiesNote,
} from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import { CLAUDE_TOOL_DESCRIPTION_CAP } from "../src/core/prompts/cardContract";
import { bindTools } from "../src/core/session/tools";
import { crewmateToolDelegate } from "./helpers/crewmateToolDelegate";
import {
  CREWMATE_BUDGET,
  fixedTokens as countFixed,
  overLine,
  roomAtHardLine,
} from "./helpers/promptBudget";

/**
 * The fixed part of every crewmate request: the served prompt and the tool
 * list, counted the way the first mate's gauge counts (`fixedTokens` in
 * tests/firstmate-fixed-context.test.ts, characters / 4). Nothing measured
 * this side (INF-411 P3, INF-416 piece J). Path notes are per task and are
 * not in this gauge. The client's own coding tools are not the app's text.
 *
 * A rule the trim took out of one text is still said in the text the ledger
 * names. A description that would meet the Claude cap fails by name and
 * headroom, not by a bare length.
 */

const RUNTIMES: (CrewmateBackend | undefined)[] = [undefined, "pi", "claude"];

/** Kind of work, as the dispatch already knows it. Absent is the full prompt. */
const KINDS: (CrewmateProcedureFacts | undefined)[] = [
  undefined,
  { delivery: "direct-pr", rigor: "standard" },
  { delivery: "direct-pr", rigor: "reviewed" },
  { delivery: "direct-pr", rigor: "quick" },
  { delivery: "local-only", rigor: "standard" },
  { delivery: "local-only", rigor: "reviewed" },
  { delivery: "local-only", rigor: "quick" },
  { delivery: "none", rigor: "none" },
];

const tools = piToolsOf(bindTools(CREWMATE_TOOLS, crewmateToolDelegate()));

/** The app's own count of the fixed part (tests/helpers/promptBudget.ts). */
function fixedTokens(systemPrompt: string): number {
  return countFixed({ systemPrompt, tools });
}

function label(
  runtime: CrewmateBackend | undefined,
  kind: CrewmateProcedureFacts | undefined,
): string {
  return `${runtime ?? "unplaced"} ${kind ? `${kind.delivery}/${kind.rigor}` : "unknown"}`;
}

function promptFor(
  runtime: CrewmateBackend | undefined,
  kind: CrewmateProcedureFacts | undefined,
): string {
  return buildCrewmateSystemPrompt(runtime, undefined, undefined, undefined, undefined, kind);
}

type Schema = { description?: string; properties?: Record<string, Schema> };

/** Top-level parameter descriptions, the ones a Claude client serves. */
function parameterDescriptions(): { tool: string; parameter: string; description: string }[] {
  const found: { tool: string; parameter: string; description: string }[] = [];
  for (const tool of CREWMATE_TOOLS) {
    const properties = (tool.parameters as Schema).properties ?? {};
    for (const [parameter, schema] of Object.entries(properties)) {
      if (schema.description)
        found.push({ tool: tool.name, parameter, description: schema.description });
    }
  }
  return found;
}

/** Standing text a crewmate is served before the first word of the task. */
function standingText(): string {
  const prompts = RUNTIMES.flatMap((runtime) => KINDS.map((kind) => promptFor(runtime, kind)));
  const descriptions = CREWMATE_TOOLS.map((tool) => tool.description);
  const parameters = parameterDescriptions().map((item) => item.description);
  const briefs = (["quick", "standard", "reviewed"] as const).map((tier) =>
    renderRigorSection(tier),
  );
  return [
    ...prompts,
    ...descriptions,
    ...parameters,
    ...briefs,
    crewmateCardBodiesNote("/tmp/cards"),
  ].join("\n");
}

const SIGNED_IN_RULE = "the captain signs in, never you";

type Home = "prompt" | { tool: string };

/**
 * The ledger (docs/orchestrator-contract.md, "The fixed-context budget"): a
 * rule a trim took out of the delivery or testing guidance, and the served text that
 * still says it. INF-1874 paid for the main-fails-too exception this way.
 */
const LEDGER: { rule: string; home: Home; says: string }[] = [
  {
    rule: "counts in the delivery guidance are the crew's judgment, never a host allowance",
    home: { tool: "check_change" },
    says: "Judge readiness, flakes, settlement and when to stop from your delivery guidance, not a host count.",
  },
  {
    rule: "no unrelated failure is fixed on the side",
    home: "prompt",
    says: "Do no unrelated work on the side.",
  },
  {
    rule: "a stronger model is the first mate's to arrange, never the crewmate's own switch",
    home: "prompt",
    says: "For merging, discarding, a stronger model or unrelated work, close your card and report the captain's words verbatim with needs_firstmate, naming the card's id; the first mate acts.",
  },
  {
    rule: "a blocker names the decision or access only the captain can give",
    home: "prompt",
    says: "report a sign-in or access only the captain can give as a blocker",
  },
  // INF-1876 trimmed the delivery judgment to what only it says: these two
  // rules it dropped are on the tools whose use they govern.
  {
    // INF-2796: it is listed on the story's afterMerge, and the merge files it.
    rule: "work that needs this merge first is an after-merge step on the story, not a filing",
    home: { tool: "file_followup" },
    says: "Work needing your merge first goes in your story's afterMerge instead.",
  },
  {
    rule: "no intermediate card of the crewmate's merges the pull request; only a merge card can",
    home: { tool: "emit_card" },
    says: "No merge or settle effects on intermediate questions; reuse an open merge card's id.",
  },
  // INF-2424 trimmed the testing guidance's repair and edited-test rules to
  // fit this budget: the pin rule both repeated is said once, by the owner word.
  {
    rule: "a re-typed or edited test derives each pin from its source",
    home: "prompt",
    says: "derive the pin from its source instead of typing it.",
  },
];

describe("the crewmate's fixed context (INF-416 piece J)", () => {
  it("stays under its hard line for each runtime and kind of work", () => {
    // INF-2286: keep the assembled context readings in the run's evidence,
    // including the Careful case that outgrew the unchanged budget. INF-2930:
    // it fails only past the hard line; the prompt-budget check on main holds
    // the budget and files the trim.
    const rows = RUNTIMES.flatMap((runtime) =>
      KINDS.map((kind) => ({
        label: label(runtime, kind),
        tokens: fixedTokens(promptFor(runtime, kind)),
      })),
    );
    expect(overLine("Crewmate", CREWMATE_BUDGET, rows)).toEqual([]);
  });

  it("names each tool's headroom when a description would meet the Claude cap", () => {
    const over = CREWMATE_TOOLS.map((tool) => {
      const headroom = CLAUDE_TOOL_DESCRIPTION_CAP - tool.description.length;
      return { name: tool.name, headroom, length: tool.description.length };
    }).filter((row) => row.headroom <= 0);
    expect(
      over.map(
        (row) =>
          `${row.name} has ${row.headroom} characters of headroom under the ${CLAUDE_TOOL_DESCRIPTION_CAP} cap (${row.length} characters)`,
      ),
    ).toEqual([]);
  });

  it("says the saved-story rule once, on emit_card's presentation field", () => {
    const presentation = parameterDescriptions().filter((item) =>
      item.description.includes("The saved-story rule, said once"),
    );
    expect(presentation).toEqual([
      { tool: "emit_card", parameter: "presentation", description: SAVED_STORY_RULE },
    ]);
    const standing = standingText();
    expect(standing.split("The saved-story rule, said once").length - 1).toBe(1);
    for (const gone of [
      "uses the saved story from prepare_change",
      "prepare_change first, then pass its presentation",
      "a saved story on future github.com",
      "Omit with presentation",
      "With presentation, supply the saved story title",
    ]) {
      expect(standing, gone).not.toContain(gone);
    }
  });

  it("says the signed-in rule once, in the prompt", () => {
    for (const runtime of RUNTIMES) {
      for (const kind of KINDS) {
        const prompt = promptFor(runtime, kind);
        expect(prompt.split(SIGNED_IN_RULE).length - 1, label(runtime, kind)).toBe(1);
      }
    }
    const toolsText = [
      ...CREWMATE_TOOLS.map((tool) => tool.description),
      ...parameterDescriptions().map((item) => item.description),
    ].join("\n");
    expect(toolsText).not.toContain(SIGNED_IN_RULE);
    expect(toolsText).not.toContain("If it answers that the app is not signed in");
    expect(toolsText).not.toContain("If not signed in, report a blocker");
  });

  it("says the rebase and conventional-name rules in the prompt, not on open_change (INF-733)", () => {
    for (const runtime of RUNTIMES) {
      for (const kind of KINDS) {
        const prompt = promptFor(runtime, kind);
        expect(prompt, label(runtime, kind)).toContain("never git reset --soft onto it");
        expect(prompt, label(runtime, kind)).toContain(
          "Use feat, fix, chore, test, refactor, docs or perf",
        );
      }
    }
    const openChange = CREWMATE_TOOLS.find((tool) => tool.name === "open_change");
    expect(openChange?.description).not.toContain("git reset --soft");
    expect(openChange?.description).not.toContain("feat, fix, chore");
  });

  it("serves the check_change judgment rule once to Pi and Claude", async () => {
    const rule = LEDGER.find(({ home }) => home !== "prompt" && home.tool === "check_change");
    if (!rule) throw new Error("Missing check_change judgment rule in the ledger");
    const pi = tools.find(({ name }) => name === "check_change");
    const server = claudeToolServer(bindTools(CREWMATE_TOOLS, crewmateToolDelegate()));
    const client = new Client({ name: "fixed-context-test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listing = await client.listTools();
      const claude = listing.tools.find(({ name }) => name === "check_change");
      expect(pi?.description.split(rule.says).length, "Pi").toBe(2);
      expect(claude?.description?.split(rule.says).length, "Claude MCP").toBe(2);
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("leaves the smallest local window room for the conversation it promises", () => {
    // INF-2286: unknown care is Default, not the largest prompt. Exercise
    // the real pre-send guard for every row, including direct-pr/Careful.
    for (const runtime of RUNTIMES) {
      for (const kind of KINDS) {
        const systemPrompt = promptFor(runtime, kind);
        const fits = (tokens: number) =>
          localInputFits(
            {
              systemPrompt,
              tools,
              messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 0 }],
            },
            OLLAMA_MIN_CONTEXT,
          );
        // INF-2930: a prompt up to the hard line still leaves the
        // conversation the room that line leaves, half of what the budget promises.
        expect(fits(roomAtHardLine(CREWMATE_BUDGET)), label(runtime, kind)).toBe(true);
        // The check is the real one: it refuses what cannot fit.
        const room = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - fixedTokens(systemPrompt);
        expect(fits(room), label(runtime, kind)).toBe(true);
        expect(fits(room + 1), label(runtime, kind)).toBe(false);
      }
    }
  });

  it("says each rule the trim took out of the delivery guidance in the home the ledger names", () => {
    const textOf = (
      home: Home,
      runtime: CrewmateBackend | undefined,
      kind: CrewmateProcedureFacts | undefined,
    ) =>
      home === "prompt"
        ? promptFor(runtime, kind)
        : (CREWMATE_TOOLS.find((tool) => tool.name === home.tool)?.description ?? "");
    for (const runtime of RUNTIMES) {
      for (const kind of KINDS) {
        const missing = LEDGER.filter(
          ({ home, says }) => !textOf(home, runtime, kind).includes(says),
        ).map(({ rule }) => rule);
        expect(missing, `a rule the crewmate (${label(runtime, kind)}) is no longer told`).toEqual(
          [],
        );
      }
    }
  });
});
