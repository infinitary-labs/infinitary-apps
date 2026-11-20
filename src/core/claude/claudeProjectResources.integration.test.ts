import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  answerText,
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import {
  filesFromOutside,
  installClaudePlugin,
  linkOutsidePlugin,
  OUTSIDE_THE_PLUGIN,
} from "../../../tests/helpers/claudePluginHome";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { Runbooks } from "../runbooks/runbooks";
import { STAGED_FOLDER } from "../session/stagingFolders";
import { openInMemoryDatabase } from "../storage/db";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { SettingsStore } from "../storage/settingsStore";
import { CLAUDE_PROJECT_SKILLS_DIR } from "./claudeProjectResources";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// The staging case starts the boxed client twice. FI3-1104 measured its
// fastest Linux check run at 3.523 s; five times, rounded up to 5 s.
vi.setConfig({ testTimeout: 20_000 });

/**
 * What a Claude crewmate's coding session carries of its working copy
 * (FI3-789), on the SDK's own client, boxed (`tests/e2e/mockClaudeClient.ts`
 * turn mode) against a local stub API, opened through Claude's factory the
 * way the supervisor opens it. The working copy is a git repository two
 * folders below the box's HOME, as a real worktree sits under the person's
 * home.
 *
 * The working copy's AGENTS.md reaches the model in its prompt, and its
 * `.claude/skills` and `.agents/skills` are listed as `project:<skill>` and
 * load with the Skill tool. None of what the client's project settings
 * source would also bring does: the working copy's `.claude/settings.json`
 * (hooks, environment, a credential helper, permission rules, the switch
 * that turns the permission bypass off, an output style), a hook a skill
 * declares, and the instruction files and skills in the folders above it -
 * HOME's own Claude folder among them.
 */

const MODEL = "claude-haiku-4-5";

/** The crewmate's instruction; it also tells the app's requests from the client's own. */
const INSTRUCTION = "You are a crewmate counting rivets in a working copy.";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi((body) => JSON.stringify(body.system ?? "").includes(INSTRUCTION));
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function plantSkill(root: string, name: string, frontmatter = ""): void {
  put(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Planted ${name}.\n${frontmatter}---\nThe body of ${name}.\n`,
  );
}

/** A box with a working copy in it, planted where the client's project source would look. */
function box() {
  const home = scratchDir("infinitary-claude-project-home-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  const above = join(home, "worktrees");
  const cwd = join(above, "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  const ran = (name: string) => join(home, `${name}-ran`);
  put(join(cwd, "AGENTS.md"), "Rivets are counted in pairs.\n");
  put(join(cwd, "CLAUDE.md"), "Rivets are counted alone.\n");
  plantSkill(
    join(cwd, ".claude", "skills"),
    "rivet-design",
    `hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "touch ${ran("skill-hook")}"\n`,
  );
  plantSkill(join(cwd, ".agents", "skills"), "rivet-release");
  put(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `touch ${ran("start-hook")}` }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: `touch ${ran("prompt-hook")}` }] },
        ],
      },
      env: { FM_PLANTED_ENV: "from-the-project" },
      apiKeyHelper: `touch ${ran("api-key-helper")}; echo sk-planted`,
      permissions: { deny: ["Bash(echo:*)"], disableBypassPermissionsMode: "disable" },
      outputStyle: "Explanatory",
    }),
  );
  put(join(above, "CLAUDE.md"), "Planted above the working copy.\n");
  plantSkill(join(above, ".claude", "skills"), "above-skill");
  put(join(home, "CLAUDE.md"), "Planted in HOME.\n");
  put(join(home, ".claude", "CLAUDE.md"), "Planted in HOME's Claude folder.\n");
  plantSkill(join(home, ".claude", "skills"), "home-skill");
  const recordDir = scratchDir("infinitary-claude-project-record-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const logs: string[] = [];
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: (line) => logs.push(line),
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
  });
  const spec = codingSpec({
    binding: { backend: "claude", accountId: "acct_claude" },
    cwd,
    instructions: INSTRUCTION,
    model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    recordDir,
  });
  return { home, cwd, recordDir, ran, factory, spec, logs };
}

/** The runbook skills the app serves a Claude crewmate building a change, from the bundle. */
function servedRunbookSkills() {
  return new Runbooks(
    join(process.cwd(), "resources/runbooks"),
    new SettingsStore(openInMemoryDatabase()),
  ).crew({
    kind: "implement",
    place: "project",
    delivery: "direct-pr",
    care: "standard",
    backend: "claude",
  }).skills;
}

/** The model's side: load a skill, run one command, then answer. */
function loadsASkillThenRuns(skill: string, command: string): void {
  const first = api.requests.length;
  api.answer((request: StubRequest, res: ServerResponse) => {
    const index = request.n - first - 1;
    if (index > 1) {
      answerText(request, res, "Counted.");
      return;
    }
    beginAnthropicStream(res, 42, request.n);
    writeAnthropicToolUse(
      res,
      0,
      index === 0
        ? { id: `toolu_${request.n}`, name: "Skill", args: { skill } }
        : { id: `toolu_${request.n}`, name: "Bash", args: { command, description: "Count" } },
    );
    finishAnthropicStream(res, "tool_use", 7);
  });
}

describe("a Claude crewmate's working copy", () => {
  it("reaches the model as its AGENTS.md and its skills, with nothing else of the project's Claude setup or the folders above", async () => {
    const crewmate = box();
    const out = join(crewmate.home, "env-out");
    loadsASkillThenRuns("project:rivet-design", `echo "env=$FM_PLANTED_ENV" > ${out}`);
    const first = api.requests.length;
    const session = await crewmate.factory.open(crewmate.spec);
    await session.prompt("Count the rivets.");
    session.dispose();
    await session.closed();
    const [opening, loaded, ran] = api.requests.slice(first);

    // The instruction file, in the prompt; the skills, listed natively.
    const system = JSON.stringify(opening?.body.system ?? "");
    expect(system).toContain("Rivets are counted in pairs.");
    expect(system).toContain(join(crewmate.cwd, "AGENTS.md"));
    expect(opening?.raw).toContain("project:rivet-design: Planted rivet-design.");
    expect(opening?.raw).toContain("project:rivet-release: Planted rivet-release.");
    // The Skill tool loads one.
    expect(loaded?.raw).toContain("The body of rivet-design.");
    // The command ran, as the permission bypass lets it, outside the project's
    // environment.
    expect(JSON.stringify(ran?.body.messages?.at(-1))).not.toContain("Permission");
    expect(readFileSync(out, "utf8")).toBe("env=\n");
    for (const hook of ["start-hook", "prompt-hook", "skill-hook", "api-key-helper"]) {
      expect(existsSync(crewmate.ran(hook)), `${hook} ran`).toBe(false);
    }
    for (const absent of [
      "Rivets are counted alone.",
      "Planted above the working copy.",
      "above-skill",
      "Planted in HOME",
      "home-skill",
      "Explanatory",
    ]) {
      expect(opening?.raw, absent).not.toContain(absent);
    }
  });

  it("stages the skills beside its record, linked and never copied, and leaves them in place", async () => {
    const crewmate = box();
    // INF-2054: each session stages into a folder of its own, and the next
    // removes an ended session's folder and what earlier versions shared.
    const shared = join(crewmate.recordDir, CLAUDE_PROJECT_SKILLS_DIR);
    mkdirSync(join(shared, "skills"), { recursive: true });
    const staged = () =>
      readdirSync(join(crewmate.recordDir, STAGED_FOLDER)).map((name) =>
        join(crewmate.recordDir, STAGED_FOLDER, name, CLAUDE_PROJECT_SKILLS_DIR),
      );
    loadsASkillThenRuns("project:rivet-release", "true");
    const session = await crewmate.factory.open(crewmate.spec);
    await session.prompt("Count the rivets.");
    session.dispose();
    await session.closed();
    const [first, ...others] = staged();
    expect(others).toEqual([]);
    expect(existsSync(shared)).toBe(false);
    const link = join(first ?? "", "skills", "rivet-release");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("The body of rivet-release.");
    // A second session stages again from nothing; the working copy keeps its skills.
    loadsASkillThenRuns("project:rivet-release", "true");
    const again = await crewmate.factory.open(crewmate.spec);
    await again.prompt("Count them again.");
    again.dispose();
    await again.closed();
    const [second, ...more] = staged();
    expect(more).toEqual([]);
    expect(second).not.toBe(first);
    expect(existsSync(join(crewmate.cwd, ".claude", "skills", "rivet-design", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(crewmate.cwd, ".agents", "skills", "rivet-release", "SKILL.md"))).toBe(
      true,
    );
  });

  it("INF-2054 answers on two sessions of one task attached at once, each listing every skill", async () => {
    // The FIRS-5 report: two sessions of one task attached together, both
    // rebuilt the one runbook folder, one failed with EEXIST and its task
    // was dropped with its working copy.
    const crewmate = box();
    const runbookSkills = servedRunbookSkills();
    expect(runbookSkills.length).toBeGreaterThan(0);
    crewmate.spec.runbookSkills = runbookSkills;
    api.answer((request, res) => answerText(request, res, "Counted."));
    const first = api.requests.length;
    const sessions = await Promise.all([
      crewmate.factory.open(crewmate.spec),
      crewmate.factory.open(crewmate.spec),
    ]);
    const outcomes = await Promise.allSettled(
      sessions.map((session) => session.prompt("Count rivets.")),
    );
    for (const session of sessions) session.dispose();
    await Promise.all(sessions.map((session) => session.closed()));
    expect(
      outcomes.map((outcome) =>
        outcome.status === "fulfilled" ? "answered" : String(outcome.reason),
      ),
    ).toEqual(["answered", "answered"]);
    expect(crewmate.logs.filter((line) => line.includes("not staged"))).toEqual([]);
    const openings = api.requests.slice(first);
    expect(openings).toHaveLength(2);
    for (const opening of openings) {
      expect(opening.raw).toContain("project:rivet-release");
      for (const skill of runbookSkills) expect(opening.raw).toContain(`runbooks:${skill.name}`);
    }
  });

  it("INF-2054 answers when the runbooks' skills cannot be staged, and says so in its log", async () => {
    // The stage FIRS-5 failed in was the one failure that ended the turn and
    // dropped the task; a failed stage costs the skills, never the attach.
    // The disk refuses the staging folder here: a file stands in its place,
    // which every runner refuses, root included.
    const crewmate = box();
    crewmate.spec.runbookSkills = servedRunbookSkills();
    writeFileSync(join(crewmate.recordDir, STAGED_FOLDER), "");
    api.answer((request, res) => answerText(request, res, "Counted."));
    const first = api.requests.length;
    const session = await crewmate.factory.open(crewmate.spec);
    await session.prompt("Count rivets.");
    session.dispose();
    await session.closed();
    expect(api.requests.slice(first)).toHaveLength(1);
    expect(
      crewmate.logs.some((line) => line.startsWith("the runbook skills were not staged")),
    ).toBe(true);
  });
});

it("opts in to local personal instructions and loads a personal skill without hooks, settings or MCP", async () => {
  const crewmate = box();
  put(join(crewmate.home, "AGENTS.md"), "Personal tone: concise sentences.");
  plantSkill(
    join(crewmate.home, ".agents", "skills"),
    "personal-rivets",
    `hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "touch ${crewmate.ran("personal-skill-hook")}"\n`,
  );
  plantSkill(join(crewmate.home, ".agents", "skills"), "rivet-design");
  put(
    join(crewmate.home, ".claude", "settings.json"),
    JSON.stringify({
      env: { FM_PLANTED_ENV: "personal-env" },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `touch ${crewmate.ran("personal-start")}` }] },
        ],
      },
    }),
  );
  put(
    join(crewmate.home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        planted: {
          command: "touch",
          args: [crewmate.ran("personal-mcp")],
        },
      },
    }),
  );
  crewmate.spec.personalResources = true;
  const out = join(crewmate.home, "personal-env-out");
  loadsASkillThenRuns("personal:personal-rivets", `echo "env=$FM_PLANTED_ENV" > ${out}`);
  const first = api.requests.length;
  const session = await crewmate.factory.open(crewmate.spec);
  await session.prompt("Count with my skill.");
  session.dispose();
  await session.closed();
  await Promise.all(stores.map((store) => store.flushed()));
  const [opening, loaded] = api.requests.slice(first);
  const system = JSON.stringify(opening?.body.system ?? "");
  expect(system).toContain("Personal tone: concise sentences.");
  expect(system).toContain("Crew rules win on delivery");
  expect(system).toContain("Rivets are counted in pairs.");
  expect(opening?.raw).toContain("personal:personal-rivets");
  expect(opening?.raw).not.toContain("personal:rivet-design");
  expect(loaded?.raw).toContain("The body of personal-rivets.");
  expect(readFileSync(out, "utf8")).toBe("env=\n");
  for (const name of [
    "personal-skill-hook",
    "personal-start",
    "personal-mcp",
    "start-hook",
    "skill-hook",
  ])
    expect(existsSync(crewmate.ran(name)), name).toBe(false);
  const stamps = stores.at(-1)?.sidecar(session.sessionId);
  expect(
    stamps?.some((record) => record.kind === "served" && record.personalResources?.instructions),
  ).toBe(true);
  console.info(
    "Claude local resources:",
    JSON.stringify({
      system: system.slice(system.indexOf("Personal instructions from")),
      skillLoaded: loaded?.raw?.includes("The body of personal-rivets."),
      shell: readFileSync(out, "utf8"),
      stamps,
    }),
  );
});

// The captain's feature request: the skills of the Claude Code plugins turned
// on in ~/.claude/settings.json, skills only, with hooks still disabled.
it("lists a turned-on plugin's skills under its name with its own files reachable, and none of its other parts", async () => {
  const crewmate = box();
  // The client library's settings reader reads this HOME's settings file.
  vi.stubEnv("HOME", crewmate.home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(crewmate.home, ".claude"));
  const plugin = installClaudePlugin(crewmate.home, { name: "claude-security" });
  put(
    join(plugin.root, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `touch ${crewmate.ran("plugin-hook")}` }] },
        ],
      },
    }),
  );
  put(
    join(plugin.root, ".mcp.json"),
    JSON.stringify({
      mcpServers: { scanner: { command: "touch", args: [crewmate.ran("plugin-mcp")] } },
    }),
  );
  put(
    join(crewmate.home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { [plugin.id]: true } }),
  );
  // A dangling link in the plugin's folder costs only itself.
  symlinkSync(join(plugin.root, "removed-notes"), join(plugin.root, "notes"));
  // Links that lead outside the plugin are not its own: nothing they reach is staged or served.
  linkOutsidePlugin(crewmate.home, plugin.root);
  crewmate.spec.personalResources = true;
  loadsASkillThenRuns("claude-security:claude-security", "true");
  const first = api.requests.length;
  const session = await crewmate.factory.open(crewmate.spec);
  await session.prompt("Scan with the plugin.");
  session.dispose();
  await session.closed();
  const [opening, loaded] = api.requests.slice(first);
  expect(opening?.raw).toContain("claude-security:claude-security");
  for (const part of ["scan-verifier", 'claude-security:scan\\"', "scanner", OUTSIDE_THE_PLUGIN])
    expect(opening?.raw, part).not.toContain(part);
  const script = /[^"\s]*\/scripts\/render_report\.py/.exec(loaded?.raw ?? "")?.[0];
  expect(script).toBeDefined();
  expect(script).not.toContain("CLAUDE_PLUGIN_ROOT");
  expect(readFileSync(script as string, "utf8")).toBe("print('report')\n");
  for (const name of ["plugin-hook", "plugin-mcp"])
    expect(existsSync(crewmate.ran(name)), name).toBe(false);
  expect(filesFromOutside(join(crewmate.recordDir, STAGED_FOLDER))).toEqual([]);
  expect(existsSync(join(dirname(script as string), "..", "tools", "render_report.py"))).toBe(true);
  console.info("Claude plugin skill loaded:", loaded?.raw?.slice(0, 2000));
});

it("renews a reopened conversation when opting in, changing the file or opting out, but resumes unchanged resources", async () => {
  const crewmate = box();
  const prompt = async () => {
    api.answer((request, res) => answerText(request, res, "Counted."));
    const first = api.requests.length;
    const session = await crewmate.factory.open(crewmate.spec);
    await session.prompt("Count rivets.");
    session.dispose();
    await session.closed();
    await Promise.all(stores.map((store) => store.flushed()));
    if (crewmate.spec.shape.turns !== "rolling") throw new Error("Expected a rolling crewmate");
    crewmate.spec.shape.record.resume = { backend: "claude", sessionId: session.sessionId };
    return {
      id: session.sessionId,
      renewal: session.takeRenewal(),
      system: JSON.stringify(api.requests[first]?.body.system),
    };
  };
  put(join(crewmate.home, "AGENTS.md"), "First personal instruction.");
  const off = await prompt();
  expect(off.system).not.toContain("First personal instruction.");
  crewmate.spec.personalResources = true;
  const on = await prompt();
  expect(on.id).not.toBe(off.id);
  expect(on.renewal).toEqual({ from: off.id, changed: ["instructions"] });
  expect(on.system).toContain("First personal instruction.");
  const same = await prompt();
  expect(same.id).toBe(on.id);
  expect(same.renewal).toBeUndefined();
  put(join(crewmate.home, "AGENTS.md"), "Changed personal instruction.");
  const changed = await prompt();
  expect(changed.id).not.toBe(same.id);
  expect(changed.system).toContain("Changed personal instruction.");
  crewmate.spec.personalResources = false;
  const againOff = await prompt();
  expect(againOff.id).not.toBe(changed.id);
  expect(againOff.system).not.toContain("Changed personal instruction.");
  console.info(
    "Claude personal renewal:",
    JSON.stringify({
      off: off.id,
      on: on.id,
      same: same.id,
      changed: changed.id,
      againOff: againOff.id,
    }),
  );
});
