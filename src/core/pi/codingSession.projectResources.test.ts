import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import {
  filesFromOutside,
  installClaudePlugin,
  linkOutsidePlugin,
  OUTSIDE_THE_PLUGIN,
} from "../../../tests/helpers/claudePluginHome";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { Runbooks } from "../runbooks/runbooks";
import type { SessionSpec } from "../session/session";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { createPiSessionFactory } from "./session";

/**
 * What a Pi crewmate's coding session carries of its working copy
 * (FI3-789): real Pi, in process, opened through the factory the way the
 * supervisor opens it, against a local stub API that keeps the request -
 * so what is checked is the system prompt Pi actually sent. The working
 * copy's AGENTS.md (or its CLAUDE.md) and the skills under its
 * `.claude/skills` and `.agents/skills` reach the model; an instruction
 * file or skill in the folder above it, or in the app's agentDir where
 * Pi's own loader would look, never does.
 */

const PROVIDER = "fm-project";
const MODEL = "stub-1";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

afterEach(() => vi.unstubAllEnvs());

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function plantSkill(root: string, name: string, description: string): string {
  const file = join(root, name, "SKILL.md");
  put(file, `---\nname: ${name}\ndescription: ${description}\n---\nFollow ${name}.\n`);
  return file;
}

/** A working copy inside a folder of its own, beside the app's agentDir. */
async function world() {
  const root = scratchDir("infinitary-pi-project-");
  const store = join(root, "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const modelsPath = join(store, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          name: "Project stub",
          baseUrl: api.url,
          api: "anthropic-messages",
          apiKey: "stub-key",
          models: [{ id: MODEL, name: "Stub", input: ["text"], maxTokens: 32_000 }],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(store, "auth.json"),
    modelsPath,
    allowModelNetwork: false,
  });
  const agentDir = join(root, "pi-agent");
  const cwd = join(root, "worktrees", "repo");
  mkdirSync(cwd, { recursive: true });
  // Where Pi's own loader would also look: the agentDir and every folder above.
  put(join(agentDir, "AGENTS.md"), "Planted in the agentDir.\n");
  plantSkill(join(agentDir, "skills"), "agent-dir-skill", "Planted in the agentDir.");
  put(join(root, "worktrees", "AGENTS.md"), "Planted above the working copy.\n");
  plantSkill(join(root, "worktrees", ".agents", "skills"), "above-skill", "Planted above.");
  /** A crewmate's coding session on this working copy, recorded in `recordDir`. */
  const open = (extra: Partial<SessionSpec> = {}, recordDir?: string) =>
    createPiSessionFactory({ agentDir }).open({
      ...codingSpec({
        binding: { backend: "pi", runtime },
        cwd,
        model: { provider: PROVIDER, id: MODEL },
        ...(recordDir ? { recordDir } : {}),
      }),
      ...extra,
    });
  /** The system prompt Pi sends for this session, on its first request. */
  const system = async (session: Awaited<ReturnType<typeof open>>): Promise<string> => {
    const next = api.nextRequest();
    await session.prompt("Which way?");
    const request = await next;
    return JSON.stringify(request.body.system ?? "");
  };
  /** The system prompt Pi sends for this working copy's crewmate, on its first request. */
  const served = async (personalResources = false): Promise<string> => {
    const session = await open({ personalResources });
    const sent = await system(session);
    session.dispose();
    return sent;
  };
  return { cwd, served, open, system, home: root };
}

describe("a Pi crewmate's working copy", () => {
  it("reaches the model as its AGENTS.md and the skills in both of its skill folders, and nothing from above or the agentDir", async () => {
    const { cwd, served } = await world();
    put(join(cwd, "AGENTS.md"), "Rivets are counted in pairs.\n");
    put(join(cwd, "CLAUDE.md"), "Rivets are counted alone.\n");
    const design = plantSkill(join(cwd, ".claude", "skills"), "design", "The design rules.");
    const release = plantSkill(join(cwd, ".agents", "skills"), "release", "How to release.");
    // A name both folders hold is the first folder's.
    plantSkill(join(cwd, ".agents", "skills"), "design", "A second design, never served.");
    const system = await served();
    expect(system).toContain("Rivets are counted in pairs.");
    expect(system).toContain(`<project_instructions path=\\"${join(cwd, "AGENTS.md")}\\">`);
    expect(system).toContain("<name>design</name>");
    expect(system).toContain(`<location>${design}</location>`);
    expect(system).toContain("<name>release</name>");
    expect(system).toContain(`<location>${release}</location>`);
    for (const absent of [
      "Rivets are counted alone.",
      "A second design, never served.",
      "Planted in the agentDir.",
      "agent-dir-skill",
      "Planted above",
      "above-skill",
    ]) {
      expect(system, absent).not.toContain(absent);
    }
  });

  it("reaches the model as its CLAUDE.md when it has no AGENTS.md", async () => {
    const { cwd, served } = await world();
    put(join(cwd, "CLAUDE.md"), "Rivets are counted alone.\n");
    const system = await served();
    expect(system).toContain(`<project_instructions path=\\"${join(cwd, "CLAUDE.md")}\\">`);
    expect(system).toContain("Rivets are counted alone.");
  });

  it("adds nothing to the prompt when it has no instruction file and no skill", async () => {
    const { served } = await world();
    const system = await served();
    expect(system).not.toContain("project_instructions");
    expect(system).not.toContain("available_skills");
    expect(system).not.toContain("Planted");
  });
});

it("opts in only to this Mac's file and skills, with project names winning and no user extensions", async () => {
  const { cwd, served, home } = await world();
  vi.stubEnv("HOME", home);
  put(join(home, "AGENTS.md"), "Personal tone: concise sentences.");
  plantSkill(join(home, ".agents", "skills"), "personal-rivets", "Personal rivet guidance.");
  plantSkill(join(home, ".claude", "skills"), "design", "Personal design, shadowed.");
  plantSkill(join(cwd, ".claude", "skills"), "design", "Project design wins.");
  put(join(home, ".pi", "agent", "AGENTS.md"), "Pi setup never served.");
  const off = await served();
  expect(off).not.toContain("Personal tone");
  expect(off).not.toContain("personal-rivets");
  const on = await served(true);
  expect(on).toContain("Personal tone: concise sentences.");
  expect(on).toContain("personal_instructions");
  expect(on).toContain("Crew rules win on delivery");
  expect(on).toContain("Personal rivet guidance.");
  expect(on).toContain("Project design wins.");
  expect(on).not.toContain("Personal design, shadowed.");
  expect(on).not.toContain("Pi setup never served.");
  console.info("Pi served personal resources:", on);
});

// The captain's feature request: the skills of the Claude Code plugins turned
// on in ~/.claude/settings.json reach other crewmates by their bare names.
it("serves a turned-on Claude Code plugin's skills below the person's own, naming its folder", async () => {
  const { served, home } = await world();
  // The client library's settings reader reads this HOME's settings file.
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  const plugin = installClaudePlugin(home, { name: "claude-security" });
  const off = installClaudePlugin(home, { name: "hookify" });
  put(
    join(plugin.root, "skills", "rivets", "SKILL.md"),
    "---\nname: rivets\ndescription: Plugin rivets, shadowed.\n---\n",
  );
  plantSkill(join(home, ".agents", "skills"), "rivets", "Your own rivets.");
  put(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { [plugin.id]: true, [off.id]: false } }),
  );
  // Links that lead outside the plugin are not its own: nothing they reach is served.
  linkOutsidePlugin(home, plugin.root);
  expect(await served()).not.toContain("claude-security");
  const on = await served(true);
  expect(on).toContain("<name>claude-security</name>");
  // The plugin is served from its own files, staged beside the session's record.
  const root = /- claude-security: ([^\s]+) \(skills: claude-security\)/.exec(on)?.[1];
  expect(root).toBeDefined();
  expect(root).not.toBe(plugin.root);
  expect(on).toContain(
    `<location>${join(root as string, "skills", "claude-security", "SKILL.md")}</location>`,
  );
  expect(readFileSync(join(root as string, "tools", "render_report.py"), "utf8")).toBe(
    "print('report')\n",
  );
  expect(filesFromOutside(root as string)).toEqual([]);
  expect(on).toContain("Your own rivets.");
  for (const absent of ["Plugin rivets, shadowed.", "hookify", "scan-verifier", OUTSIDE_THE_PLUGIN])
    expect(on, absent).not.toContain(absent);
});

it("INF-2054 keeps a session's runbook skills where its prompt names them while another session of its task opens", async () => {
  // Every session of a task records into one folder, and two can be open at
  // once (FIRS-5); the next one opens here after the runbooks were switched
  // off, so it serves none.
  const { open, system } = await world();
  const recordDir = scratchDir("infinitary-pi-record-");
  const runbookSkills = new Runbooks(
    join(process.cwd(), "resources/runbooks"),
    new SettingsStore(openInMemoryDatabase()),
  ).crew({
    kind: "implement",
    place: "project",
    delivery: "direct-pr",
    care: "standard",
    backend: "pi",
  }).skills;
  const [skill] = runbookSkills;
  if (!skill) throw new Error("The bundle serves no runbook skill.");
  const first = await open({ runbookSkills }, recordDir);
  const sent = await system(first);
  const location = sent.match(
    new RegExp(`<name>${skill.name}</name>[\\s\\S]*?<location>([^<]+)</location>`),
  )?.[1];
  expect(location).toBeDefined();
  const second = await open({ runbookSkills: [] }, recordDir);
  expect(readFileSync(location ?? "", "utf8")).toBe(
    Buffer.from(skill.files["SKILL.md"] ?? "", "base64").toString("utf8"),
  );
  second.dispose();
  first.dispose();
  await Promise.all([first.closed(), second.closed()]);
});
