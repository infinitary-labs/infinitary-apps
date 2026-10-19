import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  placedContractCleanup,
  placedContractWorld,
} from "../../../tests/helpers/placedContractWorld";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import {
  CONTRACT_TOOL,
  CONTRACT_TOOL_RESULT,
  type ContractWorld,
  CREWMATE_TASK,
} from "../../../tests/helpers/sessionContract";
import { CLAUDE_MODEL_PROVIDER } from "../claude/session";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID, type ModelSession } from "../session/session";
import { boundTool } from "../session/tools";

/**
 * INF-293's "Unknown model" card: the card's model chip is `crewSupervisor.ts`'s
 * `session.modelLabel() ?? session.modelRef()?.id ?? "Unknown model"`, read
 * while the crewmate's emit_card runs - mid-turn. This reads the same
 * expression mid-turn, from inside a tool the turn runs, for a Claude
 * crewmate held on another computer and for one on this Mac.
 */

const OPUS = { provider: CLAUDE_MODEL_PROVIDER, id: "claude-opus-5-5" };

function chip(session: ModelSession): string {
  return session.modelLabel() ?? session.modelRef()?.id ?? "Unknown model";
}

async function midTurnChip(
  world: ContractWorld,
  model: { provider: string; id: string } | undefined,
): Promise<{ during: string; atTurnEnd: string[] }> {
  let during = "";
  let session!: ModelSession;
  const tool = boundTool({
    name: CONTRACT_TOOL,
    label: "Look up",
    description: "Look the contract answer up.",
    parameters: Type.Object({}),
    run: async () => {
      // The moment a crewmate's emit_card would read the chip.
      during = chip(session);
      return { text: CONTRACT_TOOL_RESULT };
    },
  });
  const spec = crewmateSessionSpec(
    appPathsFor(join(world.homeDir, "..", "crew")),
    {
      taskId: CREWMATE_TASK,
      machineId: world.machine ?? LOCAL_MACHINE_ID,
      cwd: world.homeDir,
      // The resume path (crewSupervisor.ts resume → openCrewmate) sends none.
      ...(model ? { model } : {}),
    },
    world.binding,
  );
  world.answer({ tool: CONTRACT_TOOL, answer: "left" });
  session = await world.factory.open({ ...spec, tools: [tool] });
  const atTurnEnd: string[] = [];
  session.subscribe((event) => {
    // What the supervisor's recordUsage reads on turn_end (crewSupervisor.ts recordUsage).
    if (event.type === "turn_end") atTurnEnd.push(session.modelRef()?.id ?? "no model");
  });
  await session.prompt("Which way?");
  return { during, atTurnEnd };
}

describe("the card's model chip, read mid-turn", () => {
  afterEach(async () => {
    await placedContractCleanup();
    await scriptedClaudeCleanup();
  });

  it("on the Mac mini, opened with no model (the resume path), names the model mid-turn", async () => {
    const world = await placedContractWorld(await scriptedClaudeWorld());
    const { during, atTurnEnd } = await midTurnChip(world, undefined);
    expect(during).toBe("Claude Opus 5.5");
    expect(atTurnEnd).toEqual(["claude-opus-5-5"]);
  }, 30_000);

  it("on the Mac mini, opened with the routed model (a fresh task), names the model mid-turn", async () => {
    const world = await placedContractWorld(await scriptedClaudeWorld());
    const { during } = await midTurnChip(world, OPUS);
    expect(during).toBe("Claude Opus 5.5");
  }, 30_000);

  it("on this Mac, opened with no model, names the model mid-turn", async () => {
    const world = await scriptedClaudeWorld();
    const { during } = await midTurnChip(world, undefined);
    expect(during).toBe("Claude Opus 5.5");
  }, 30_000);
});
