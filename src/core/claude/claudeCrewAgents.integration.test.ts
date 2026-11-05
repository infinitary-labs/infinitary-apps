import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  type StubApi,
  type StubRequest,
  startStubApi,
} from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { MessageQueue, userMessage } from "./claudeQueryCore";
import { claudeSessionOptions } from "./claudeSessionOptions";

// Measured on the hosted Linux check machine with four integration workers:
// slowest per-case minimum 1.966 s; five times, rounded up to 5 s.
vi.setConfig({ testTimeout: 10_000 });

/**
 * The agents a boxed Claude crewmate is offered (FI3-699), on the SDK's own
 * client in the e2e stub's box (`tests/e2e/mockClaudeClient.ts` turn mode)
 * with the options the app opens a crewmate with (`claudeSessionOptions`).
 * The client's Agent tool lists every agent type in the crewmate's first
 * request. A person keeps their own agent definitions in their Claude folder
 * (`~/.claude/agents`) and in a project's `.claude/agents`, which the client
 * also looks for in every folder above the working copy; the crewmate reads
 * none of them (`settingSources: []`). The client's own agents include
 * `claude`, "FleetView's default when no agent name is typed": a request
 * that lists it has not read the machine's setup.
 *
 * Each case plants a definition in each of those places: the box's HOME,
 * the working copy, and the folder above it. The client lists its own
 * agents and none of the planted ones. A control proves the plants are
 * where the client looks: read with the person's setup, all three reach the
 * model.
 */

const MODEL = "claude-haiku-4-5";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

/** One agent definition, the way a person writes one, named for where it sits. */
function plantAgent(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Planted for the box test; never offered to a crewmate.\n---\nYou are ${name}.\n`,
  );
  return name;
}

/**
 * A Claude crewmate in a box of its own: a throwaway HOME holding the boxed
 * client, and a working copy outside it, as an e2e crewmate's worktree
 * under userData is. A definition is planted in each place the person's own
 * would be.
 */
function boxedCrewmate() {
  const home = scratchDir("infinitary-claude-agents-home-");
  const stub = writeMockClaudeClient(home, { turns: { baseUrl: api.url, maxRetries: 0 } });
  const above = join(scratchDir("infinitary-claude-agents-projects-"), "projects");
  const cwd = join(above, "repo");
  mkdirSync(cwd, { recursive: true });
  const planted = [
    plantAgent(join(home, ".claude", "agents"), "planted-in-home"),
    plantAgent(join(above, ".claude", "agents"), "planted-above-working-copy"),
    plantAgent(join(cwd, ".claude", "agents"), "planted-in-working-copy"),
  ];
  const spec = crewmateSessionSpec(
    appPathsFor(scratchDir("infinitary-claude-agents-app-")),
    { ...crewmateToolDelegate(), machineId: LOCAL_MACHINE_ID, cwd },
    { backend: "claude", accountId: "acct_claude_crew" },
  );
  /** What the app hands the SDK for this crewmate, over the box's host environment. */
  const options = (): Options =>
    claudeSessionOptions({
      spec,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      executable: stub,
      stderr: () => {},
      attachment: { model: MODEL, session: { sessionId: randomUUID() } },
    });
  return { planted, options };
}

/**
 * The agents the client offers a session it opens with these options, and
 * the first request of the session's turn: the one whose reminder lists
 * them for the model.
 */
async function offered(options: Options): Promise<{ agents: string[]; request: StubRequest }> {
  const input = new MessageQueue();
  const session = query({ prompt: input, options });
  try {
    const agents = (await session.supportedAgents()).map((agent) => agent.name);
    const next = api.nextRequest();
    input.push(userMessage("Which agents can you call on?"));
    return { agents, request: await next };
  } finally {
    // The client exits once its input ends; the session ends with it.
    input.close();
    for await (const _message of session) {
      // Drained, so the client is gone before its folders are.
    }
  }
}

describe("the agents a boxed Claude crewmate is offered", () => {
  it("lists none of the definitions planted in its HOME, its working copy or the folder above", async () => {
    const crewmate = boxedCrewmate();
    const { agents, request } = await offered(crewmate.options());
    expect(agents.length, "the client offers its own agents").toBeGreaterThan(0);
    for (const name of crewmate.planted) {
      expect(agents, `${name} was offered`).not.toContain(name);
      expect(request.raw, `${name} reached the model`).not.toContain(name);
    }
  });

  it("would offer every planted definition were the person's setup read", async () => {
    const crewmate = boxedCrewmate();
    const { agents, request } = await offered({
      ...crewmate.options(),
      settingSources: ["user", "project"],
    });
    expect(agents).toEqual(expect.arrayContaining(crewmate.planted));
    for (const name of crewmate.planted) {
      expect(request.raw, `${name} sits where the client looks`).toContain(name);
    }
  });
});
