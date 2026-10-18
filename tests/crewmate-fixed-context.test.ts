import { describe, expect, it } from "vitest";
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

/** The app's own count of the fixed part: characters / 4. */
function fixedTokens(systemPrompt: string): number {
  return Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
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

/**
 * Measured 23,582 after INF-416 piece J's trim, on the largest case (unknown
 * facts, Claude note). The audit's earlier reading was about 24,955, before
 * this trim and before later main. The ceiling sits above the measurement
 * with room for a few sentences, so a change that adds a few words does not
 * move it. One that would cross it trims first. The conversation-space check
 * below is the app's own pre-send check, not this number.
 */
const FIXED_CONTEXT_BUDGET = 23_800;

const SIGNED_IN_RULE = "the captain signs in, never you";

describe("the crewmate's fixed context (INF-416 piece J)", () => {
  it("stays inside its budget for each runtime and kind of work", () => {
    const over = RUNTIMES.flatMap((runtime) =>
      KINDS.map((kind) => {
        const tokens = fixedTokens(promptFor(runtime, kind));
        return { label: label(runtime, kind), tokens };
      }),
    ).filter((row) => row.tokens > FIXED_CONTEXT_BUDGET);
    expect(over).toEqual([]);
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

  it("leaves the smallest local window room the app's own check can prove", () => {
    const systemPrompt = buildCrewmateSystemPrompt("claude");
    const fits = (tokens: number) =>
      localInputFits(
        {
          systemPrompt,
          tools,
          messages: [{ role: "user", content: "x".repeat(tokens * 4), timestamp: 0 }],
        },
        OLLAMA_MIN_CONTEXT,
      );
    const room = OLLAMA_MIN_CONTEXT - LOCAL_CONTEXT_RESERVE - fixedTokens(systemPrompt);
    expect(room).toBeGreaterThan(0);
    expect(fits(room)).toBe(true);
    expect(fits(room + 1)).toBe(false);
  });
});
