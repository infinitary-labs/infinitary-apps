import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER, type ClaudeQueryFactory } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// Measured on the hosted Linux check machine with four integration workers:
// slowest per-case 2.919 s; five times that is 14.6 s, rounded up to a whole
// 5 s: 15 s.
vi.setConfig({ testTimeout: 15_000 });

/**
 * A Claude crewmate's commits and pull requests carry no attribution (the
 * captain, 2026-10-15: "disable commit and PR author attribution for all
 * claude crewmates in infinitary (it's a claude setting)"), on the client the
 * product would run - the override, else the installed one, else the SDK's
 * own copy - boxed by the e2e stub (`tests/e2e/mockClaudeClient.ts` turn
 * mode) and opened through Claude's factory the way the supervisor opens it.
 *
 * Left to its default the client has the model end every commit message with
 * a `Co-Authored-By` trailer and every pull request description with a
 * "Generated with Claude Code" line: in the coding preset's git instructions
 * on the SDK's own client, in a reminder those instructions point to on the
 * installed 2.1.299. Every coding session is handed the client's attribution
 * setting with empty text (`CLAUDE_CODING_SETTINGS`).
 *
 * The case runs one turn of a crewmate whose working copy is a git
 * repository with a skill to stage, as a project's usually has, and reads
 * every request the client sent: neither line reaches the model. A control
 * proves the case would see them: with the setting taken out, both do.
 */

const MODEL = "claude-haiku-4-5";

/** The client's own attribution lines, as its default serves them. */
const COMMIT_TRAILER = "Co-Authored-By:";
const PR_LINE = "Generated with [Claude Code]";

let api: StubApi;

beforeAll(async () => {
  // Every request the client sends is kept, its housekeeping included.
  api = await startStubApi(() => true);
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/**
 * A crewmate in a box of its own: a throwaway HOME holding the boxed client,
 * and a git working copy under it with one skill, opened through a factory
 * that runs the SDK's query (or the one handed in).
 */
function boxedCrewmate(sdkQuery?: ClaudeQueryFactory) {
  const home = scratchDir("infinitary-claude-attribution-home-");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, maxRetries: 0, ...(client ? { client } : {}) },
  });
  const cwd = join(home, "worktrees", "repo");
  const skill = join(cwd, ".claude", "skills", "release");
  mkdirSync(skill, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: release\ndescription: How this project is released.\n---\nTag, then publish.\n",
  );
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
    ...(sdkQuery ? { query: sdkQuery } : {}),
  });
  const spec = crewmateSessionSpec(
    appPathsFor(scratchDir("infinitary-claude-attribution-app-")),
    {
      ...crewmateToolDelegate(),
      machineId: LOCAL_MACHINE_ID,
      cwd,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    },
    { backend: "claude", accountId: "acct_claude_attribution" },
  );
  return { factory, spec };
}

/** Everything the client sent while the crewmate ran one turn. */
async function served(crewmate: ReturnType<typeof boxedCrewmate>): Promise<string> {
  const from = api.requests.length;
  const session = await crewmate.factory.open(crewmate.spec);
  await session.prompt("Commit this work and open a pull request.");
  session.dispose();
  await session.closed();
  return api.requests
    .slice(from)
    .map((request) => request.raw)
    .join("\n");
}

/** The SDK's query with the attribution setting taken out of the options it is handed. */
const withClientDefault: ClaudeQueryFactory = ({ prompt, options }) => {
  const { attribution: _attribution, ...settings } = options.settings as Exclude<
    Options["settings"],
    string | undefined
  >;
  return query({ prompt, options: { ...options, settings } });
};

describe("the attribution a Claude crewmate is told to add", () => {
  it("serves the crewmate no commit trailer and no pull request line", async () => {
    const sent = await served(boxedCrewmate());
    expect(sent, "the client sent the turn").toContain("Commit this work and open a pull request.");
    expect(sent, "the skill was staged").toContain("project:release");
    expect(sent, "the commit trailer reached the model").not.toContain(COMMIT_TRAILER);
    expect(sent, "the pull request line reached the model").not.toContain(PR_LINE);
  });

  it("would serve both were the client left to its default", async () => {
    const sent = await served(boxedCrewmate(withClientDefault));
    expect(sent, "the commit trailer is the client's default").toContain(COMMIT_TRAILER);
    expect(sent, "the pull request line is the client's default").toContain(PR_LINE);
  });
});
