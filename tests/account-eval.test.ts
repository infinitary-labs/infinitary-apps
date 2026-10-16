import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ownershipCases,
  evaluation as ownershipEvaluation,
  scoreOwnershipRun,
} from "../scripts/evals/answerOwnership.ts";
import { approvalCases } from "../scripts/evals/approvalHandoff.ts";
import { approvalHost, refuseOverlap } from "../scripts/evals/host.ts";
import {
  type AccountModel,
  accountModels,
  approvalEvaluation,
  artifact,
  CLIENT_ENDED,
  claudeCrewClient,
  evaluationClaudeEnv,
  hash,
  LIMITS,
  type Options,
  planAllowances,
  readOnlyVault,
  reservation,
  runEvaluation,
} from "../scripts/evals/runner.ts";
import { createClaudeSessionFactory } from "../src/core/claude/session.ts";
import type { Ticker } from "../src/core/orchestrator/ticker.ts";
import { appPathsFor } from "../src/core/paths.ts";
import { AccountVault } from "../src/core/pi/accountVault.ts";
import { PiAccountBackend } from "../src/core/pi/piAccountBackend.ts";
import { createPiSessionFactory } from "../src/core/pi/session.ts";
import type { SessionBinding, SessionSpec } from "../src/core/session/session.ts";
import { MOCK_CLAUDE_OAUTH_TOKEN, writeMockClaudeClient } from "./e2e/mockClaudeClient.ts";
import { mockModelsJson, startMockProvider } from "./e2e/mockProvider.ts";
import {
  finishAnthropicStream,
  startStubApi,
  writeAnthropicEvent,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "./helpers/anthropicDialect.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";

// Each independent case owns its boxed client and migrations; never put every cold start under one ceiling.
vi.setConfig({ testTimeout: 30_000 });
let closeProvider: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeProvider?.();
  closeProvider = undefined;
  vi.unstubAllEnvs();
});
function options(root: string, backend: "pi" | "claude" = "pi"): Options {
  const role = {
    accountId: "disposable",
    accountLabel: "Disposable account",
    provider: backend === "pi" ? "fm-mock" : "anthropic-claude",
    model: backend === "pi" ? "mock-1" : "claude-opus-5-5",
    backend,
  };
  return {
    version: "hermetic-proof",
    sourceHash: "hermetic-proof",
    roles: { firstmate: role, builder: role },
    out: join(root, "out"),
    userData: join(root, "profile"),
  };
}
/** The production Claude session on the boxed mock client, in a throwaway HOME reaching `port`. */
function boxedClaudeFactory(root: string, port: number) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: `http://127.0.0.1:${port}`, credential: "subscription" },
  });
  return async (_role: unknown, _dir: string, clock: Ticker) => ({
    factory: createClaudeSessionFactory({
      configDir: join(home, ".claude"),
      clock,
      env: () =>
        evaluationClaudeEnv({
          HOME: home,
          CFFIXED_USER_HOME: home,
          PATH: process.env.PATH,
          INFINITARY_CLAUDE_CLI: stub,
        }),
    }),
    binding: { backend: "claude" as const, accountId: "disposable" },
  });
}
/** Credential names anywhere, and key or token prefixes where a word starts: task-card is not a key. */
const credentialShaped = /Bearer|access_token|refresh_token|(?<![A-Za-z0-9])(?:sk-|eyJ)/;
/** Every string a parsed evidence file holds, object keys included. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(Array.isArray(value) ? [] : [key]),
    ...strings(item),
  ]);
}
/** A disposable profile whose two api-key accounts reach the local mock provider through Pi. */
function disposablePiAccounts(opts: Options, port: number): void {
  vi.stubEnv("PI_OFFLINE", "1");
  const profile = opts.userData as string;
  mkdirSync(join(profile, "accounts"), { recursive: true });
  mkdirSync(join(profile, "auth"), { recursive: true });
  const models = JSON.parse(mockModelsJson(port));
  models.providers.openrouter = models.providers["fm-mock"];
  delete models.providers["fm-mock"];
  writeFileSync(join(profile, "auth", "models.json"), JSON.stringify(models));
  writeFileSync(
    join(profile, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      pins: {},
      accounts: ["firstmate", "builder"].map((role) => ({
        id: role,
        providerId: "openrouter",
        kind: "api_key",
        label: `Disposable ${role}`,
        enabled: true,
        createdAt: 1,
      })),
    }),
  );
  opts.roles = accountModels(
    profile,
    { accountId: "firstmate", provider: "openrouter", model: "mock-1" },
    { accountId: "builder", provider: "openrouter", model: "mock-1" },
  );
}

describe("account evaluation approval and isolation", () => {
  it("dry run opens no provider and refuses a missing, changed or mismatched approval", async () => {
    const root = scratchDir("eval-gate-");
    const opts = options(root);
    let connects = 0;
    const deps = {
      factory: async () => {
        connects++;
        throw new Error("Must not connect");
      },
      scratch: () => scratchDir("eval-case-"),
    };
    const dry = await runEvaluation(opts, deps);
    expect(dry.sheet.cases.map((row) => row.id)).toEqual(approvalCases.map((test) => test.id));
    expect(dry.sheet.maximumCalls).toBe(dry.sheet.cases.reduce((sum, row) => sum + row.calls, 0));
    expect(dry.sheet.limits.calls).toBe(80);
    expect(connects).toBe(0);
    for (const approvedHash of [undefined, "wrong"])
      await expect(runEvaluation({ ...opts, live: true, approvedHash }, deps)).rejects.toThrow(
        "exact approved",
      );
    await expect(
      runEvaluation(
        { ...opts, sourceHash: "changed", live: true, approvedHash: dry.sheetHash },
        deps,
      ),
    ).rejects.toThrow("exact approved");
    expect(connects).toBe(0);
  });
  it("refuses overlapping app state and any account-vault mutation", () => {
    expect(() => refuseOverlap("/scratch/app/child", ["/scratch/app"])).toThrow("overlaps");
    expect(() => refuseOverlap("/scratch", ["/scratch/app"])).toThrow("overlaps");
    expect(() => refuseOverlap("/scratch/app-other", ["/scratch/app"])).not.toThrow();
    const vault = readOnlyVault({
      list: () => [],
      get: () => undefined,
      runtimeFor: async () => {
        throw new Error("No account");
      },
    });
    expect(vault.list()).toEqual([]);
    expect(() => Reflect.get(vault, "noteCutOff")).toThrow("cannot change");
    expect(() => Reflect.get(vault, "markSelected")).toThrow("cannot change");
  });
  it("refuses a symlink alias of protected state before creating files", async () => {
    const root = scratchDir("eval-overlap-");
    const profile = join(root, "profile");
    mkdirSync(profile);
    symlinkSync(profile, join(root, "alias"));
    expect(() => refuseOverlap(join(root, "alias", "case"), [profile])).toThrow("overlaps");
    await expect(
      runEvaluation({ ...options(root), out: join(profile, "evidence") }),
    ).rejects.toThrow("overlaps");
  });
  it("executes real graph tools and distinguishes a repeated-start refusal from a start", async () => {
    const root = scratchDir("eval-effects-");
    const host = await approvalHost(
      approvalCases[0]!,
      root,
      { provider: "fm-mock", id: "mock-1" },
      [`${root}-protected`],
    );
    try {
      const tool = host.spec.tools.find((tool) => tool.name === "update_task")!;
      const args = { task: host.ids.BUILD, start_now: true };
      const started = await tool.run(args);
      expect(host.effect(tool.name, args, started)).toBe("success");
      expect(host.state().buildStatus).toBe("active");
      expect(host.state().basis).toBe("PLAN");
      const repeated = await tool.run(args);
      expect(host.effect(tool.name, args, repeated)).toBe("refused");
      expect(host.starts).toEqual(["BUILD"]);
      expect(host.state().openCards).toEqual([]);
    } finally {
      await host.close();
    }
  });
  it("judges a welcome-recovery basis attach by the record it leaves, then starts BUILD", async () => {
    const root = scratchDir("eval-basis-");
    const host = await approvalHost(
      approvalCases.find((test) => test.id === "welcome-recovery")!,
      root,
      { provider: "fm-mock", id: "mock-1" },
      [`${root}-protected`],
    );
    try {
      const tool = host.spec.tools.find((tool) => tool.name === "update_task")!;
      expect(host.state().basis).toBeUndefined();
      // The call names PLAN's id; a tool that takes a basis stores PLAN's key, and one that
      // does not stores nothing. Either way the verdict agrees with the record, so a run
      // stops here only when the basis really did not attach.
      const attach = { task: host.ids.BUILD, basis: host.ids.PLAN };
      const attached = host.effect(tool.name, attach, await tool.run(attach));
      expect(attached).toBe(host.state().basis === "PLAN" ? "success" : "refused");
      const start = { task: host.ids.BUILD, start_now: true };
      expect(host.effect(tool.name, start, await tool.run(start))).toBe("success");
      expect(host.state().buildStatus).toBe("active");
      expect(host.starts).toEqual(["BUILD"]);
    } finally {
      await host.close();
    }
  });
  it("counts a saved plan's build filed through the real create_task, on request and unstarted", async () => {
    const root = scratchDir("eval-defer-");
    const host = await approvalHost(
      approvalCases.find((test) => test.id === "save-and-defer")!,
      root,
      { provider: "fm-mock", id: "mock-1" },
      [`${root}-protected`],
    );
    try {
      expect(host.state()).toMatchObject({ planned: 0, blockers: [] });
      expect(host.state().buildStatus).toBeUndefined();
      const tool = host.spec.tools.find((tool) => tool.name === "create_task")!;
      const args = {
        title: "Build the saved plan: task popovers",
        goal: "Task popovers render as normal cards.",
        user_words: "make task popovers normal cards",
        basis: host.ids.PLAN,
        start_policy: "on-request",
      };
      expect(host.effect(tool.name, args, await tool.run(args))).toBe("success");
      expect(host.state().planned).toBe(1);
      expect(host.starts).toEqual([]);
    } finally {
      await host.close();
    }
  });
  it("redacts credential-shaped text even inside native response content", () => {
    const written = artifact({
      frames: [
        "Bearer sensitive-value",
        "access_token=secret-value",
        'access_token="quoted-secret"',
        "refresh_token",
        "sk-abc",
        "eyJabc",
        "first line\nsk-proj-after-a-newline",
        "\teyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      ],
      access_token: "named-secret",
    });
    expect(written).not.toMatch(
      /Bearer|secret|access_token|refresh_token|sk-|eyJ|after-a-newline|signature/,
    );
    expect(JSON.parse(written).frames).toHaveLength(8);
  });
  it("keeps ordinary words that merely contain a key prefix", () => {
    // FI3-417's evidence read "ta[redacted]" where the model wrote task-card and task-first.
    const reply =
      "I started the accepted task-card plan with the task-first copy: risk-free, desk-lamp, monkeyJar.";
    const evidence = { native: [{ content: [{ type: "text", text: reply }] }] };
    expect(JSON.parse(artifact(evidence))).toEqual(evidence);
  });
});

describe("account evaluation call allowances", () => {
  const full = (role: string) => (role === "builder" ? LIMITS.builderCalls : LIMITS.firstmateCalls);
  it("fixes every case's full call allowance on the sheet at the real prompt sizes", async () => {
    const { sheet } = await runEvaluation(options(scratchDir("eval-plan-")), {
      scratch: () => scratchDir("eval-case-"),
    });
    // Prompt cuts change which cases fit their full allowance. The sheet
    // owns the allocation; assert the bounds and reservation contract, not
    // a second list of per-case allocations tied to yesterday's text sizes.
    expect(sheet.cases.map((row) => row.id)).toEqual(approvalCases.map((test) => test.id));
    for (const row of sheet.cases) {
      expect(row.calls).toBeGreaterThanOrEqual(1);
      expect(row.calls).toBeLessThanOrEqual(full(row.role));
      if (row.calls < full(row.role)) {
        expect(
          sheet.maximumInputTokens - row.inputTokens + reservation(row.promptBytes, row.calls + 1),
        ).toBeGreaterThan(sheet.limits.inputTokens);
      }
    }
    expect(sheet.maximumCalls).toBe(sheet.cases.reduce((sum, row) => sum + row.calls, 0));
    for (const row of sheet.cases)
      expect(row.inputTokens).toBe(reservation(row.promptBytes, row.calls));
    expect(sheet.maximumInputTokens).toBe(
      sheet.cases.reduce((sum, row) => sum + row.inputTokens, 0),
    );
    expect(sheet.maximumInputTokens).toBeLessThanOrEqual(sheet.limits.inputTokens);
    // FI3-409: the old 1.5M ceiling cannot hold these prompts' plan; every case would get less.
    const old = planAllowances(
      sheet.cases.map((row) => ({ role: row.role, bytes: row.promptBytes })),
      { ...LIMITS, inputTokens: 1_500_000 },
    );
    expect(old.reduce((sum, row) => sum + row.inputTokens, 0)).toBeLessThanOrEqual(1_500_000);
    expect(old.every((row, i) => row.calls >= 1 && row.calls < full(sheet.cases[i]!.role))).toBe(
      true,
    );
  });
  it("states each case's smaller allowance when the full plan passes the ceiling", async () => {
    // Two real cases whose user turns are padded until both full plans cannot fit.
    const padding = "x".repeat(1_500_000);
    const module = {
      ...approvalEvaluation,
      cases: approvalCases.slice(0, 2),
      host: async (...args: Parameters<typeof approvalHost>) => {
        const host = await approvalHost(...args);
        return Object.assign(host, { prompt: host.prompt + padding });
      },
    };
    const { sheet } = await runEvaluation(options(scratchDir("eval-tight-")), {
      module,
      scratch: () => scratchDir("eval-case-"),
    });
    const calls = sheet.cases.map((row) => row.calls);
    expect(calls.every((n) => n >= 1 && n < LIMITS.firstmateCalls)).toBe(true);
    expect(Math.max(...calls) - Math.min(...calls)).toBeLessThanOrEqual(1);
    expect(sheet.maximumCalls).toBe(calls.reduce((sum, n) => sum + n, 0));
    expect(sheet.maximumInputTokens).toBeLessThanOrEqual(sheet.limits.inputTokens);
    // The largest allowance that fit: one more call for either case would pass the ceiling.
    for (const row of sheet.cases)
      expect(
        sheet.maximumInputTokens - row.inputTokens + reservation(row.promptBytes, row.calls + 1),
      ).toBeGreaterThan(sheet.limits.inputTokens);
  });
  it("opens every case in one run with their sheet allowance, whatever came before", async () => {
    const root = scratchDir("eval-allowance-");
    const api = await startMockProvider();
    closeProvider = api.close;
    const opts = options(root);
    disposablePiAccounts(opts, api.port);
    const paths = appPathsFor(opts.userData as string);
    const vault = readOnlyVault(
      AccountVault.create(paths, { pi: new PiAccountBackend({ modelsPath: paths.modelsPath }) }),
    );
    const opened: (number | undefined)[] = [];
    const deps = {
      scratch: () => scratchDir("eval-case-"),
      // The production Pi binding, recording the request bound each case's session receives.
      factory: async (role: AccountModel, dir: string) => {
        const pi = createPiSessionFactory({ agentDir: join(dir, "pi-agent") });
        return {
          factory: {
            backend: pi.backend,
            controlProfile: pi.controlProfile,
            open: (spec: SessionSpec) => {
              opened.push(spec.bounds?.request?.maxModelTurns);
              return pi.open(spec);
            },
          },
          binding: {
            backend: "pi",
            accountId: role.accountId,
            runtime: await vault.runtimeFor(role.accountId),
          } as SessionBinding,
        };
      },
    };
    const dry = await runEvaluation(opts, deps);
    const result = await runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps);
    expect(opened).toEqual(dry.sheet.cases.map((row) => row.calls));
    expect(Object.values(result.responses!).every((run) => run.endedNormally)).toBe(true);
    const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
    expect(usage.callsUsed).toBeGreaterThanOrEqual(approvalCases.length);
    expect(usage.inputTokensReserved).toBeLessThanOrEqual(dry.sheet.maximumInputTokens);
    expect(usage.stop).toBeUndefined();
  });
});

/**
 * A local chat-completions endpoint whose first reply calls one tool and whose later replies
 * are plain text, in the stream shape the mock provider serves.
 */
async function scriptedEndpoint(call: { name: string; args: Record<string, unknown> }) {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const request = ++requests;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const base = { id: `chatcmpl-${request}`, object: "chat.completion.chunk", model: "mock-1" };
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant" });
      if (request === 1)
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        });
      else chunk({ content: "Nothing more to do." });
      chunk({}, request === 1 ? "tool_calls" : "stop");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as import("node:net").AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("account evaluation stop reasons", () => {
  it("keeps its own tool-refusal stop when the turn it cut reports a failure", async () => {
    const root = scratchDir("eval-refusal-");
    const test = approvalCases.find((row) => row.role === "firstmate")!;
    // The evaluation refuses real-work settlement, so a merge call stops the case.
    const api = await scriptedEndpoint({
      name: "settle_task",
      args: { task_id: "BUILD", mode: "merge-pr" },
    });
    closeProvider = api.close;
    const opts = options(root);
    disposablePiAccounts(opts, api.port);
    const paths = appPathsFor(opts.userData as string);
    const vault = readOnlyVault(
      AccountVault.create(paths, { pi: new PiAccountBackend({ modelsPath: paths.modelsPath }) }),
    );
    const failures: string[] = [];
    const deps = {
      module: { ...approvalEvaluation, cases: [test] },
      scratch: () => scratchDir("eval-case-"),
      // The production Pi binding, witnessing the failed turn the runner's abort reports.
      factory: async (role: AccountModel, dir: string) => {
        const pi = createPiSessionFactory({ agentDir: join(dir, "pi-agent") });
        return {
          factory: {
            backend: pi.backend,
            controlProfile: pi.controlProfile,
            open: async (spec: SessionSpec) => {
              const session = await pi.open(spec);
              session.subscribe((event) => {
                if (event.type === "turn_failed") failures.push(event.error);
              });
              return session;
            },
          },
          binding: {
            backend: "pi",
            accountId: role.accountId,
            runtime: await vault.runtimeFor(role.accountId),
          } as SessionBinding,
        };
      },
    };
    const dry = await runEvaluation(opts, deps);
    const result = await runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps);
    expect(failures).toEqual(["Evaluation stopped on a tool refusal or failure"]);
    expect(result.responses![test.id]!.endedNormally).toBe(false);
    const record = JSON.parse(readFileSync(join(opts.out, `${test.id}.json`), "utf8"));
    expect(record.results).toMatchObject([{ name: "settle_task", result: "refused" }]);
    expect(record.ending).toBe("bounded");
    expect(record.reason).toBe("tool refusal or failure");
    const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
    expect(usage.stop).toBe("tool refusal or failure");
  });
});

describe("a live Claude run stays under the Claude crewmate's client", () => {
  const crew = { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" };
  it("finds the crewmate's client among the run's ancestors, and nothing else", () => {
    expect(claudeCrewClient({ ...crew, CLAUDE_PID: String(process.ppid) })()).toBe(true);
    // A person's own terminal session, and a shell no Claude client started.
    expect(
      claudeCrewClient({ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: String(process.ppid) })(),
    ).toBe(false);
    expect(claudeCrewClient(crew)()).toBe(false);
    // A live process the run does not descend from.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      env: { PATH: process.env.PATH },
      stdio: "ignore",
    });
    try {
      expect(claudeCrewClient({ ...crew, CLAUDE_PID: String(other.pid) })()).toBe(false);
    } finally {
      other.kill();
    }
  });
  it("lets go once the run is adopted away from the client, or the table cannot be read", () => {
    const client = { ...crew, CLAUDE_PID: "400" };
    let table = new Map([
      [process.pid, 300],
      [300, 400],
      [400, 1],
    ]);
    const holds = claudeCrewClient(client, () => table);
    expect(holds()).toBe(true);
    // The shell between them exited, or the client did: the system adopted the run.
    table = new Map([
      [process.pid, 1],
      [1, 0],
    ]);
    expect(holds()).toBe(false);
    const unreadable = claudeCrewClient(client, () => {
      throw new Error("No process table");
    });
    expect(unreadable()).toBe(false);
  });
  it("refuses outside the crewmate's client before it uses the approved sheet", async () => {
    const root = scratchDir("eval-crew-refusal-");
    const opts = options(root, "claude");
    let connects = 0;
    const deps = {
      factory: async () => {
        connects++;
        throw new Error("Must not connect");
      },
      scratch: () => scratchDir("eval-case-"),
      crewClient: () => false,
    };
    const dry = await runEvaluation(opts, deps);
    const live = { ...opts, live: true, approvedHash: dry.sheetHash };
    await expect(runEvaluation({ ...live, claudeCrewTurn: true }, deps)).rejects.toThrow(
      "Claude crewmate's own client",
    );
    await expect(
      runEvaluation({ ...live, claudeCrewTurn: false }, { ...deps, crewClient: () => true }),
    ).rejects.toThrow("Claude crewmate's own client");
    expect(connects).toBe(0);
    expect(existsSync(join(opts.out, "run-started.json"))).toBe(false);
  });
  it("stops at the next model request once the client ends, and opens no later case", async () => {
    const root = scratchDir("eval-crew-ended-");
    const api = await startMockProvider();
    closeProvider = api.close;
    const opts = options(root, "claude");
    const [first, second] = approvalCases.filter((test) => test.role === "firstmate");
    if (!first || !second) throw new Error("Approval handoff has two Firstmate cases");
    const boxed = boxedClaudeFactory(root, api.port);
    let connects = 0;
    const deps = {
      module: { ...approvalEvaluation, cases: [first, second] },
      scratch: () => scratchDir("eval-case-"),
      registryHash: () => "unchanged-disposable-registry",
      factory: (role: unknown, dir: string, clock: Ticker) => {
        connects++;
        return boxed(role, dir, clock);
      },
      // The crewmate's client ends while the first model request is in flight.
      crewClient: () => api.requests() === 0,
    };
    const dry = await runEvaluation(opts, deps);
    const result = await runEvaluation(
      { ...opts, live: true, claudeCrewTurn: true, approvedHash: dry.sheetHash },
      deps,
    );
    expect(Object.values(result.responses ?? {}).map((run) => run.endedNormally)).toEqual([
      false,
      false,
    ]);
    const cut = JSON.parse(readFileSync(join(opts.out, `${first.id}.json`), "utf8"));
    expect(cut).toMatchObject({ ending: "bounded", reason: CLIENT_ENDED, requests: 1 });
    const never = JSON.parse(readFileSync(join(opts.out, `${second.id}.json`), "utf8"));
    expect(never).toMatchObject({ ending: "bounded", reason: CLIENT_ENDED, requests: 0 });
    expect(connects).toBe(1);
    const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
    expect(usage).toMatchObject({ callsUsed: 1, stop: CLIENT_ENDED });
    expect(JSON.parse(readFileSync(join(opts.out, "run-started.json"), "utf8")).pid).toBe(
      process.pid,
    );
  });
});

it.each(
  (["pi", "claude"] as const).flatMap((backend) => [
    ...approvalCases.map((test) => ({ backend, test, caseId: test.id, reject: false })),
    { backend, test: approvalCases[0]!, caseId: "provider-503", reject: true },
  ]),
)(
  "writes $caseId evidence through the $backend production session on local mocks",
  async ({ backend, test, reject }) => {
    const root = scratchDir("eval-full-");
    const api = await startMockProvider();
    closeProvider = api.close;
    let rejectedRequests = 0;
    const refused = reject
      ? createServer((_req, res) => {
          if (
            _req.method === "POST" &&
            /\/(?:chat\/completions|messages)(?:\?|$)/.test(_req.url ?? "")
          )
            rejectedRequests++;
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Disposable provider failure", type: "api_error" },
            }),
          );
        })
      : undefined;
    if (refused) await new Promise<void>((resolve) => refused.listen(0, "127.0.0.1", resolve));
    const port = refused ? (refused.address() as import("node:net").AddressInfo).port : api.port;
    closeProvider = async () => {
      await api.close();
      if (refused) await new Promise<void>((resolve) => refused.close(() => resolve()));
    };
    const opts = options(root, backend);
    const modelPath = join(root, "models.json");
    writeFileSync(modelPath, mockModelsJson(port));
    if (backend === "pi") disposablePiAccounts(opts, port);
    const deps = {
      module: { ...approvalEvaluation, cases: [test] },
      scratch: () => scratchDir("eval-case-"),
      registryHash: backend === "claude" ? () => "unchanged-disposable-registry" : undefined,
      factory: backend === "pi" ? undefined : boxedClaudeFactory(root, port),
      // The run stands in for one started from a Claude crewmate's shell.
      crewClient: () => true,
    };
    const dry = await runEvaluation(opts, deps);
    const result = await runEvaluation(
      { ...opts, live: true, claudeCrewTurn: true, approvedHash: dry.sheetHash },
      deps,
    );
    expect(Object.keys(result.responses!)).toEqual([test.id]);
    if (reject) {
      expect(rejectedRequests).toBe(1);
      expect(Object.values(result.responses!).every((run) => !run.endedNormally)).toBe(true);
      expect(result.sheet.limits.retries).toBe(0);
      // A failed turn the runner did not cut is still the provider's. The Claude client reports
      // no request start before a 503, so its case reads "no observed model request" instead.
      const reason = backend === "pi" ? "provider failure" : "no observed model request";
      const record = JSON.parse(readFileSync(join(opts.out, `${test.id}.json`), "utf8"));
      expect(record.reason).toBe(reason);
      expect(JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8")).stop).toBe(reason);
      return;
    }
    expect(Object.values(result.responses!).every((run) => run.endedNormally)).toBe(true);
    expect(api.requests()).toBeGreaterThanOrEqual(1);
    {
      const record = JSON.parse(readFileSync(join(opts.out, `${test.id}.json`), "utf8"));
      expect(record.ending).toBe("normal");
      expect(record.requests).toBeGreaterThan(0);
      expect(record.native.length).toBeGreaterThan(0);
      expect(record.servedModel.id).toBe("mock-1");
      expect(record.requestedModel).toBe(opts.roles[test.role].model);
      // The evidence keeps the user turn the model read, ordinary words such as task-card included.
      expect(hash(record.userTurn)).toBe(record.turnSha);
    }
    // The planted sign-ins never reach evidence, and no string a reviewer reads is credential-shaped.
    const planted = [
      JSON.parse(mockModelsJson(port)).providers["fm-mock"].apiKey as string,
      MOCK_CLAUDE_OAUTH_TOKEN,
    ];
    for (const file of readdirSync(opts.out)) {
      const text = readFileSync(join(opts.out, file), "utf8");
      for (const secret of planted) expect(text).not.toContain(secret);
      for (const value of strings(JSON.parse(text))) expect(value).not.toMatch(credentialShaped);
    }
    expect(JSON.parse(readFileSync(join(opts.out, "registry-check.json"), "utf8")).unchanged).toBe(
      true,
    );
    expect(
      Object.values(result.responses!).every((run) => !run.review.fullAcceptedSpecPreserved),
    ).toBe(true);
    if (process.env.INFINITARY_EVAL_PROOF_DIR) {
      const proof = join(process.env.INFINITARY_EVAL_PROOF_DIR, backend, test.id);
      mkdirSync(proof, { recursive: true });
      cpSync(opts.out, proof, { recursive: true });
    }
    await expect(
      runEvaluation(
        { ...opts, live: true, claudeCrewTurn: true, approvedHash: dry.sheetHash },
        deps,
      ),
    ).rejects.toThrow("already used");
  },
);

describe("Claude evaluation usage artifacts", () => {
  it.each([false, true])(
    "retains cached multi-request usage or explicit unknowns (missing=%s)",
    async (missing) => {
      const root = scratchDir("eval-claude-usage-");
      // Include the client's own side calls in the independent server-side token ledger.
      const api = await startStubApi(() => true);
      closeProvider = api.close;
      const ledger: { input: number; output: number; cacheRead: number; cacheWrite: number }[] = [];
      api.answer(({ n, body }, res) => {
        const tool = body.tools?.find((tool) => tool.name.endsWith("crew_status"));
        const followup = body.messages?.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "tool_result"),
        );
        const usage = !tool
          ? { input: 13, output: 2, cacheRead: 0, cacheWrite: 0 }
          : followup
            ? { input: 5, output: 17, cacheRead: 900, cacheWrite: 0 }
            : { input: 3, output: 11, cacheRead: 700, cacheWrite: 200 };
        ledger.push(usage);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        writeAnthropicEvent(res, "message_start", {
          type: "message_start",
          message: {
            id: `msg_usage_${n}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.input,
              output_tokens: 0,
              cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheWrite,
            },
          },
        });
        writeAnthropicText(res, 0, "Read the current crew.");
        if (tool && !followup)
          writeAnthropicToolUse(res, 1, { id: `tool_usage_${n}`, name: tool.name, args: {} });
        finishAnthropicStream(res, tool && !followup ? "tool_use" : "end_turn", usage.output);
      });
      const opts = options(root, "claude");
      const boxed = boxedClaudeFactory(root, Number(new URL(api.url).port));
      const deps = {
        module: {
          ...approvalEvaluation,
          cases: approvalCases.filter((test) => test.role === "firstmate").slice(0, 2),
        },
        registryHash: () => "unchanged-disposable-registry",
        scratch: () => scratchDir("eval-case-"),
        crewClient: () => true,
        factory: async (role: unknown, dir: string, clock: Ticker) => {
          const connected = await boxed(role, dir, clock);
          if (!missing) return connected;
          const factory = connected.factory;
          return {
            ...connected,
            factory: {
              ...factory,
              open: async (spec: SessionSpec) => {
                const session = await factory.open(spec);
                const subscribe = session.subscribe.bind(session);
                session.subscribe = (listener) =>
                  subscribe((event) =>
                    listener(event.type === "turn_end" ? { ...event, usage: undefined } : event),
                  );
                const recordPath = session.recordPath.bind(session);
                session.recordPath = () => {
                  const path = recordPath();
                  if (path && existsSync(path)) {
                    // Deliberately degraded transcript: exercise a client that supplies no counters.
                    const lines = readFileSync(path, "utf8")
                      .trim()
                      .split("\n")
                      .map((line) => JSON.parse(line));
                    for (const line of lines)
                      if (line.type === "assistant") delete line.message.usage;
                    writeFileSync(
                      path,
                      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
                    );
                  }
                  return path;
                };
                return session;
              },
            },
          };
        },
      };
      const dry = await runEvaluation(opts, deps);
      const result = await runEvaluation(
        { ...opts, live: true, claudeCrewTurn: true, approvedHash: dry.sheetHash },
        deps,
      );
      expect(Object.values(result.responses!).every((run) => run.endedNormally)).toBe(true);
      const unknown = { input: null, output: null, cacheRead: null, cacheWrite: null };
      const sum = (rows: typeof ledger) =>
        rows.reduce(
          (total, row) => ({
            input: total.input + row.input,
            output: total.output + row.output,
            cacheRead: total.cacheRead + row.cacheRead,
            cacheWrite: total.cacheWrite + row.cacheWrite,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        );
      const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
      expect(usage.usageTotals).toEqual(missing ? unknown : sum(ledger));
      expect(usage.callsUsed).toBe(4);
      for (const test of deps.module.cases) {
        const saved = JSON.parse(readFileSync(join(opts.out, `${test.id}.json`), "utf8"));
        expect(saved.usageSource).toBe("turn_end");
        expect(
          saved.native
            .filter((entry: { role: string }) => entry.role === "assistant")
            .map((entry: { usage: unknown }) => entry.usage),
        ).toEqual(
          missing
            ? [unknown, unknown]
            : [
                { input: 3, output: 11, cacheRead: 700, cacheWrite: 200 },
                { input: 5, output: 17, cacheRead: 900, cacheWrite: 0 },
              ],
        );
        if (missing) expect(saved.usageTotals).toEqual(unknown);
      }
      if (process.env.INFINITARY_EVAL_PROOF_DIR) {
        const proof = join(
          process.env.INFINITARY_EVAL_PROOF_DIR,
          missing ? "unknown-usage" : "cached-usage",
        );
        mkdirSync(proof, { recursive: true });
        cpSync(opts.out, proof, { recursive: true });
        writeFileSync(join(proof, "mock-api-usage.json"), JSON.stringify(ledger, null, 2));
      }
    },
  );
});

describe("answer ownership evaluation", () => {
  it("the live runner allows only the fictional answered close, never a merge", async () => {
    const root = scratchDir("ownership-answered-");
    const test = ownershipCases.find((test) => test.ownership === "advance")!;
    const api = await scriptedEndpoint({
      name: "settle_task",
      args: { task_id: "OWNER", mode: "answered" },
    });
    closeProvider = api.close;
    const opts = options(root);
    disposablePiAccounts(opts, api.port);
    const paths = appPathsFor(opts.userData!);
    const vault = readOnlyVault(
      AccountVault.create(paths, { pi: new PiAccountBackend({ modelsPath: paths.modelsPath }) }),
    );
    const deps = {
      module: { ...ownershipEvaluation, cases: [test] },
      scratch: () => scratchDir("ownership-case-"),
      factory: async (role: AccountModel, dir: string) => ({
        factory: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }),
        binding: { backend: "pi" as const, runtime: await vault.runtimeFor(role.accountId) },
      }),
    };
    const dry = await runEvaluation(opts, deps);
    const result = await runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps);
    expect(result.responses?.[test.id]).toMatchObject({
      endedNormally: true,
      calls: [{ name: "settle_task", result: "success" }],
      state: { taskStates: { OWNER: "done" } },
    });
  });

  it("prepares eight production hosts without model calls and includes live owners", async () => {
    const { sheet } = await runEvaluation(options(scratchDir("ownership-sheet-")), {
      module: ownershipEvaluation,
      scratch: () => scratchDir("ownership-case-"),
      factory: async () => {
        throw new Error("Dry mode must not open a model");
      },
    });
    expect(sheet.cases.map((row) => row.id)).toEqual(ownershipCases.map((test) => test.id));
    expect(sheet.maximumCalls).toBe(48);
    const repeated = await runEvaluation(options(scratchDir("ownership-sheet-repeat-")), {
      module: ownershipEvaluation,
      scratch: () => scratchDir("ownership-case-"),
    });
    expect(repeated.sheet.cases).toEqual(sheet.cases);
  });
  for (const test of ownershipCases) {
    it(`${test.id}: observes the expected owner/retained-answer interface and rejects relay`, async () => {
      const host = await approvalHost(
        test,
        scratchDir("ownership-host-"),
        { provider: "fm-mock", id: "mock-1" },
        [],
      );
      const calls: import("../scripts/evals/approvalHandoff.ts").EvalCall[] = [];
      async function call(name: string, args: Record<string, unknown>) {
        const tool = host.spec.tools.find((tool) => tool.name === name)!;
        const output = await tool.run(args);
        calls.push({ name, args, result: host.effect(name, args, output) });
      }
      try {
        if (test.ownership === "owner") {
          await call("steer_crewmate", {
            task_id: "OWNER",
            message: "Show your findings and the captain's choice on your own card.",
          });
        } else if (test.ownership === "firstmate") {
          await call("emit_card", {
            task_id:
              test.id === "ownership-reviewer-question" ? "BUILD" : Object.keys(test.tasks)[0],
            title: "The recorded answer",
            body: "<p>The record supplies this answer.</p><p>No other evidence is needed.</p>",
            ...(test.id === "ownership-reviewer-question"
              ? {
                  actions: [
                    { id: "compat", label: "Keep compatibility", default: true },
                    { id: "size", label: "Keep the smaller package" },
                  ],
                }
              : {}),
          });
        } else {
          await call("update_task", { task: "NEXT", start_now: true });
          await call("settle_task", { task_id: "OWNER", mode: "answered" });
        }
        const run = {
          endedNormally: true,
          calls,
          state: host.state(),
          review: { fullAcceptedSpecPreserved: false, noInventedMergePermission: false },
        };
        const review = {
          correctAnswer: true,
          noRelayConstraint: true,
          threadNamesOwner: true,
          quotations: ["Scripted interface proof, not model-following proof"],
        };
        expect(scoreOwnershipRun(test, run, review)).toEqual([]);
        expect(scoreOwnershipRun(test, run, { ...review, noRelayConstraint: false })).not.toEqual(
          [],
        );
        expect(scoreOwnershipRun(test, { ...run, endedNormally: false }, review)).not.toEqual([]);
        if (test.ownership === "owner") {
          expect(
            scoreOwnershipRun(test, { ...run, state: { ...run.state, steered: [] } }, review),
          ).not.toEqual([]);
          expect(
            scoreOwnershipRun(
              test,
              { ...run, calls: [...calls, { name: "emit_card", args: {}, result: "success" }] },
              review,
            ),
          ).not.toEqual([]);
        }
      } finally {
        await host.close();
      }
    });
  }
});
