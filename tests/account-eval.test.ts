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
  acceptedPlanCase,
  evaluation as acceptedPlanEvaluation,
  largeDesignCase,
  scoreAcceptedPlan,
  scoreLargeDesign,
  scoreReadyPlanPieces,
} from "../scripts/evals/acceptedPlan.ts";
import {
  ownershipCases,
  evaluation as ownershipEvaluation,
  scoreOwnershipRun,
} from "../scripts/evals/answerOwnership.ts";
import { approvalCases } from "../scripts/evals/approvalHandoff.ts";
import { ACCEPTANCE_WAIT_MS, approvalHost, refuseOverlap } from "../scripts/evals/host.ts";
import {
  type AccountModel,
  accountModels,
  approvalEvaluation,
  artifact,
  boundedToolText,
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
import { claudeEnvFor } from "../src/core/claude/claudeCli.ts";
import { createClaudeSessionFactory } from "../src/core/claude/session.ts";
import type { Ticker } from "../src/core/orchestrator/ticker.ts";
import { appPathsFor } from "../src/core/paths.ts";
import { AccountVault } from "../src/core/pi/accountVault.ts";
import { PiAccountBackend } from "../src/core/pi/piAccountBackend.ts";
import { createPiSessionFactory } from "../src/core/pi/session.ts";
import {
  assembleTasksReads,
  parseTasksQueryText,
  renderTasksFieldPage,
  renderTasksQueryResult,
  TASK_QUERY_PAGE_CHARACTERS,
} from "../src/core/pi/taskTools.ts";
import type { SessionBinding, SessionSpec } from "../src/core/session/session.ts";
import { InboxStore } from "../src/core/storage/inboxStore.ts";
import { taskResolutionBody } from "../src/core/tasks/taskQuery.ts";
import { MOCK_CLAUDE_OAUTH_TOKEN, writeMockClaudeClient } from "./e2e/mockClaudeClient.ts";
import { mockModelsJson, startMockProvider } from "./e2e/mockProvider.ts";
import {
  finishAnthropicStream,
  startStubApi,
  writeAnthropicEvent,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "./helpers/anthropicDialect.ts";
import { CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS } from "./helpers/claudeMcpLimit.ts";
import { scratchDir } from "./helpers/scratchDirs.ts";
import { pageTaskField, readTaskQueryText } from "./helpers/taskQueryText.ts";

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
    let preparedHosts = 0;
    const deps = {
      module: {
        ...approvalEvaluation,
        host: async (...args: Parameters<typeof approvalHost>) => {
          preparedHosts++;
          return approvalHost(...args);
        },
      },
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
    for (const approvedHash of [undefined, "wrong"]) {
      await expect(runEvaluation({ ...opts, live: true, approvedHash }, deps)).rejects.toThrow(
        "exact approved",
      );
      // INF-87: invalid approval must not repeat the expensive twelve-host preparation.
      expect(preparedHosts).toBe(dry.sheet.cases.length);
    }
    await expect(
      runEvaluation(
        { ...opts, sourceHash: "changed", live: true, approvedHash: dry.sheetHash },
        deps,
      ),
    ).rejects.toThrow("exact approved");
    expect(preparedHosts).toBe(dry.sheet.cases.length);
    expect(connects).toBe(0);
  });
  it("still measures current tool fingerprints after the saved approval matches", async () => {
    // INF-87: early refusals save work, never authorize a changed tool surface.
    const root = scratchDir("eval-current-fingerprint-");
    const opts = options(root);
    let changed = false;
    const factory = vi.fn(async () => {
      throw new Error("Must not connect");
    });
    const deps = {
      module: {
        ...approvalEvaluation,
        cases: approvalCases.slice(0, 1),
        host: async (...args: Parameters<typeof approvalHost>) => {
          const host = await approvalHost(...args);
          return changed
            ? { ...host, spec: { ...host.spec, tools: host.spec.tools.slice(1) } }
            : host;
        },
      },
      factory,
      scratch: () => scratchDir("eval-case-"),
    };
    const dry = await runEvaluation(opts, deps);
    changed = true;
    await expect(
      runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps),
    ).rejects.toThrow("exact approved");
    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(join(opts.out, "run-started.json"))).toBe(false);
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
  it("fixes the first fitting ordered-reduction plan on the sheet at the real prompt sizes", async () => {
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
    }
    // INF-2017, captain-approved correction: the documented policy removes calls
    // in this order and stops at the first fitting plan; it does not refill cheaper cases.
    // Rank the actual hosts' possible cuts independently of the allocator's reduction loop.
    const cutOrder = sheet.cases
      .flatMap((row, index) =>
        Array.from({ length: full(row.role) }, (_, call) => ({ index, calls: call + 1 })),
      )
      .sort((a, b) => b.calls - a.calls || b.index - a.index);
    const removed = cutOrder.filter((cut) => cut.calls > sheet.cases[cut.index]!.calls);
    expect(removed).toEqual(cutOrder.slice(0, removed.length));
    const lastCut = removed.at(-1);
    if (lastCut) {
      const row = sheet.cases[lastCut.index]!;
      const previousInput =
        sheet.maximumInputTokens - row.inputTokens + reservation(row.promptBytes, row.calls + 1);
      // Undo only the last prescribed cut: its predecessor must exceed at least one ceiling.
      expect(
        sheet.maximumCalls + 1 > sheet.limits.calls || previousInput > sheet.limits.inputTokens,
      ).toBe(true);
    }
    expect(sheet.maximumCalls).toBe(sheet.cases.reduce((sum, row) => sum + row.calls, 0));
    expect(sheet.maximumCalls).toBeLessThanOrEqual(sheet.limits.calls);
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
      args: { task_id: "BUILD", mode: "merge-pr", closing_sentence: "The build is merged." },
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
  // The environment the app gives a crewmate's client, which passes it on to its shell (INF-1861).
  const crew = claudeEnvFor({ PATH: process.env.PATH });
  it("finds the crewmate's client among the run's ancestors, and nothing else", () => {
    expect(claudeCrewClient({ ...crew, CLAUDE_PID: String(process.ppid) })()).toBe(true);
    // A person's own terminal session, another program's SDK client, and a shell no Claude client started.
    for (const entrypoint of ["cli", "sdk-ts"])
      expect(
        claudeCrewClient({
          CLAUDE_CODE_ENTRYPOINT: entrypoint,
          CLAUDE_PID: String(process.ppid),
        })(),
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

  it("never reports a request the run cut mid-answer as a smaller definite total", async () => {
    // INF-441: a live run cut a case on its second request's refused call, and the client's turn
    // totals held only the first request, so usage.json read cacheRead 0 where 23,327 were read.
    // The client runs a call while its request still streams; this reply never finishes, so the
    // evaluation's refusal of a merge always cuts the second request mid-answer.
    const root = scratchDir("eval-claude-cut-");
    const api = await startStubApi(() => true);
    closeProvider = api.close;
    const ledger: { input: number; output: number; cacheRead: number; cacheWrite: number }[] = [];
    api.answer(({ n, body }, res) => {
      const crew = body.tools?.find((tool) => tool.name.endsWith("crew_status"));
      const settle = body.tools?.find((tool) => tool.name.endsWith("settle_task"));
      const followup = body.messages?.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "tool_result"),
      );
      // What the server reports; the cut reply reports only its opening counters.
      const usage = !crew
        ? { input: 13, output: 2, cacheRead: 0, cacheWrite: 0 }
        : followup
          ? { input: 3, output: 1, cacheRead: 700, cacheWrite: 200 }
          : { input: 5, output: 17, cacheRead: 0, cacheWrite: 900 };
      ledger.push(usage);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      writeAnthropicEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: `msg_cut_${n}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input,
            output_tokens: followup ? usage.output : 0,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheWrite,
          },
        },
      });
      writeAnthropicText(res, 0, "Read the crew, then settle.");
      if (!crew) return finishAnthropicStream(res, "end_turn", usage.output);
      if (!followup) {
        writeAnthropicToolUse(res, 1, { id: `tool_crew_${n}`, name: crew.name, args: {} });
        return finishAnthropicStream(res, "tool_use", usage.output);
      }
      writeAnthropicToolUse(res, 1, {
        id: `tool_settle_${n}`,
        name: settle!.name,
        args: { task_id: "BUILD", mode: "merge-pr", closing_sentence: "The build is merged." },
      });
    });
    const opts = options(root, "claude");
    const test = approvalCases.find((row) => row.role === "firstmate")!;
    const deps = {
      module: { ...approvalEvaluation, cases: [test] },
      registryHash: () => "unchanged-disposable-registry",
      scratch: () => scratchDir("eval-case-"),
      crewClient: () => true,
      factory: boxedClaudeFactory(root, Number(new URL(api.url).port)),
    };
    const dry = await runEvaluation(opts, deps);
    await runEvaluation(
      { ...opts, live: true, claudeCrewTurn: true, approvedHash: dry.sheetHash },
      deps,
    );
    const record = JSON.parse(readFileSync(join(opts.out, `${test.id}.json`), "utf8"));
    expect(record).toMatchObject({ reason: "tool refusal or failure", requests: 2 });
    expect(record.results.map((row: { result: string }) => row.result)).toEqual([
      "success",
      "refused",
    ]);
    // The client did report a definite turn total, and the second request never finished.
    expect(
      record.frames.find((frame: { type: string }) => frame.type === "turn_end").usage,
    ).toBeDefined();
    expect(
      record.native
        .filter((entry: { role: string }) => entry.role === "assistant")
        .map((entry: { stopReason?: string }) => entry.stopReason),
    ).toEqual(["toolUse", undefined]);
    const unknown = { input: null, output: null, cacheRead: null, cacheWrite: null };
    expect(record.usageTotals).toEqual(unknown);
    const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
    expect(usage).toMatchObject({ stop: "tool refusal or failure", usageTotals: unknown });
    if (process.env.INFINITARY_EVAL_PROOF_DIR) {
      const proof = join(process.env.INFINITARY_EVAL_PROOF_DIR, "cut-usage");
      mkdirSync(proof, { recursive: true });
      cpSync(opts.out, proof, { recursive: true });
      writeFileSync(join(proof, "mock-api-usage.json"), JSON.stringify(ledger, null, 2));
    }
  });
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

// INF-87: a live evaluation must expose the real plan through tools, not preload or cut it.
it("keeps the accepted plan off the index and serves the entire native read within its approved budget", async () => {
  const root = scratchDir("accepted-plan-eval-");
  const host = await approvalHost(
    acceptedPlanCase,
    join(root, "host"),
    { provider: "fm-mock", id: "mock-1" },
    [],
  );
  try {
    expect(host.prompt).not.toContain("Your Mac lets a phone join as a phone.");
    const read = host.spec.tools.find((tool) => tool.name === "tasks")!;
    const result = await read.run({ key: "PLAN" });
    const first = parseTasksQueryText(result.text);
    // INF-439 live failure: the small plan must expose its non-default answer in one read,
    // rather than hiding it in an omitted resolution full of repeated card bodies.
    expect(first.omitted).toEqual([]);
    expect(first.rows[0]?.resolution?.answers).toEqual(
      acceptedPlanCase.tasks.PLAN!.resolution!.answers,
    );
    expect(first.rows[0]?.resolution?.offer).not.toHaveProperty("body");
    expect(first.rows[0]?.resolution?.card).not.toHaveProperty("body");
    const reads = [result.text];
    for (const omitted of first.omitted) {
      reads.push(...(await pageTaskField((args) => read.run(args), "PLAN", omitted.field)));
    }
    const row = assembleTasksReads(reads)[0]!;
    expect(row.outcome).toBe(acceptedPlanCase.tasks.PLAN!.outcome);
    expect(taskResolutionBody(row, "offer")).toBe(
      acceptedPlanCase.tasks.PLAN!.resolution!.offer.body,
    );
    expect(row.resolution?.answers).toEqual(acceptedPlanCase.tasks.PLAN!.resolution!.answers);
    // No-loss contract: an older accepted offer may differ from the newest stored card.
    // Use the retained original offer, before the evaluation's task-key remapping.
    const differingOffer = structuredClone(row);
    differingOffer.resolution!.offer!.body = JSON.parse(
      readFileSync("tests/fixtures/accepted-plan/inf64.json", "utf8"),
    ).body;
    expect(differingOffer.resolution!.offer!.body).not.toBe(differingOffer.card);
    const rendered = renderTasksQueryResult({ rows: [differingOffer], total: 1 });
    const renderedReads = [rendered];
    for (const omitted of parseTasksQueryText(rendered).omitted) {
      let offset = 1;
      while (offset) {
        const page = renderTasksFieldPage(differingOffer, omitted.field, offset);
        renderedReads.push(page);
        const next = page.match(/nextOffset (\d+|none)/)?.[1];
        offset = next && next !== "none" ? Number(next) : 0;
      }
    }
    expect(assembleTasksReads(renderedReads)).toEqual([differingOffer]);
    // INF-416 piece K: each page fits the band and the module reservation. The plan itself
    // is still larger than the default reservation, which is why the module reserves more.
    for (const text of reads) {
      expect(text.length).toBeLessThanOrEqual(TASK_QUERY_PAGE_CHARACTERS);
      expect(boundedToolText(text, acceptedPlanEvaluation.toolResultBytes)).toBe(text);
    }
    expect(JSON.stringify(row).length).toBeGreaterThan(LIMITS.toolResultBytes);
    expect(result.text.length).toBeGreaterThan(LIMITS.toolResultBytes);
    expect(boundedToolText(result.text, acceptedPlanEvaluation.toolResultBytes)).toBe(result.text);
    // An oversized response remains bounded, including multibyte characters.
    expect(Buffer.byteLength(boundedToolText(result.text, 20))).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(boundedToolText("😀".repeat(20), 21))).toBeLessThanOrEqual(21);
    const dry = await runEvaluation(options(root), { module: acceptedPlanEvaluation });
    expect(dry.sheet.cases.map(({ id }) => id)).toEqual(
      acceptedPlanEvaluation.cases.map(({ id }) => id),
    );
    expect(dry.sheet.cases[1]!.calls).toBe(largeDesignCase.maxCalls);
    expect(dry.sheet.limits.toolResultBytes).toBe(acceptedPlanEvaluation.toolResultBytes);
    expect(dry.sheet.cases[0]!.calls).toBe(acceptedPlanEvaluation.firstmateCalls);
    expect(dry.sheet.cases[0]!.inputTokens).toBe(
      reservation(
        dry.sheet.cases[0]!.promptBytes,
        acceptedPlanEvaluation.firstmateCalls,
        dry.sheet.limits,
      ),
    );
    expect(dry.sheet.maximumInputTokens).toBeLessThanOrEqual(LIMITS.inputTokens);
  } finally {
    await host.close();
  }
});

// INF-87 R1: the captain requires every ready root in the acceptance turn.
// P1/P4 are independent review repairs; the historical capture itself stays unchanged.
it.each([
  ["id", "research"],
  ["key", "reproduce"],
  ["lower-case key", "implement"],
] as const)("queues both ready roots by %s from an approved %s answer", async (reference, kind) => {
  // P1/P3: approved answers use the existing queue, regardless of classification.
  const fixture = structuredClone(acceptedPlanCase);
  fixture.id = "two-ready-plan-roots";
  fixture.tasks.PLAN!.kind = kind;
  const words =
    "Use the board's existing lanes, with no separate mark or new label; restore the authorization limit.";
  fixture.context = words;
  fixture.tasks.P!.title = "Fix the accepted-plan review findings";
  fixture.tasks.PLAN!.title = "Two independent review repairs";
  fixture.tasks.PLAN!.userWords = words;
  fixture.tasks.PLAN!.outcome =
    "Correct queue guidance and restore the authorization limit. Neither repair depends on the other.";
  fixture.tasks.PLAN!.resolution = {
    action: "fix-review",
    answers: [],
    offer: {
      body: fixture.tasks.PLAN!.outcome,
      actions: [{ id: "fix-review", label: "Fix and review once more" }],
    },
  };
  const host = await approvalHost(
    fixture,
    scratchDir("accepted-plan-roots-"),
    { provider: "fm-mock", id: "mock-1" },
    [],
  );
  const calls: import("../scripts/evals/approvalHandoff.ts").EvalCall[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await host.spec.tools.find((tool) => tool.name === name)!.run(args);
    const result = host.effect(name, args, answer);
    expect(result, answer.text).toBe("success");
    calls.push({
      name,
      args: host.normalize(args) as Record<string, unknown>,
      result,
      request: calls.length + 1,
    });
    return answer;
  };
  try {
    await call("tasks", { key: "PLAN" });
    const build = readTaskQueryText((await call("tasks", { key: "BUILD" })).text)[0]!;
    await call("update_task", {
      task:
        reference === "id"
          ? "BUILD"
          : reference === "key"
            ? build.key
            : ` ${build.key.toLowerCase()} `,
      title: "Correct accepted-plan queue guidance",
      goal: words,
      start_policy: "when-ready",
      blocked_by: [],
    });
    const before = new Set(host.state().graph!.map((row) => row.id));
    await call("create_task", {
      title: "Restore the authorization limit",
      goal: "Approval authorizes no credential command, repair, permission change or merge.",
      user_words: words,
      parent: "P",
      basis: "PLAN",
      start_policy: "when-ready",
      blocked_by: [],
      constraints: [{ kind: "free", text: "implement: queued" }],
    });
    const second = host.state().graph!.find((row) => !before.has(row.id))!.id;
    await call("tasks", { parent: "P" });
    await vi.waitFor(() => expect(host.starts).toEqual(expect.arrayContaining(["BUILD", second])));
    const run = { calls, state: host.state() };
    expect(scoreReadyPlanPieces(run, ["BUILD", second], [[], []])).toEqual([]);
    for (const started of [["BUILD"], [...host.starts, second], [...host.starts, "unknown"]])
      expect(
        scoreReadyPlanPieces(
          { ...run, state: { ...run.state, started } },
          ["BUILD", second],
          [[], []],
        ),
      ).toContain("Start every ready piece and no blocked piece");
    expect(
      scoreReadyPlanPieces(
        { ...run, state: { ...run.state, started: undefined } },
        ["BUILD", second],
        [[], []],
      ),
    ).toContain("Record actual queue dispatches");
    for (const id of ["BUILD", second])
      expect(host.state().graph!.find((row) => row.id === id)).toMatchObject({
        parent: "P",
        basis: "PLAN",
        startPolicy: "when-ready",
      });
  } finally {
    await host.close();
  }
});

it("scores the six-piece graph from actual task tools and refuses missing reads, wrong dependencies and missing review", async () => {
  const host = await approvalHost(
    acceptedPlanCase,
    scratchDir("accepted-plan-graph-"),
    { provider: "fm-mock", id: "mock-1" },
    [],
  );
  const calls: import("../scripts/evals/approvalHandoff.ts").EvalCall[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await host.spec.tools.find((tool) => tool.name === name)!.run(args);
    const result = host.effect(name, args, answer);
    calls.push({
      name,
      args: host.normalize(args) as Record<string, unknown>,
      result,
      // Scripted host proof: each awaited call represents a separate request.
      request: calls.length + 1,
    });
    expect(result, answer.text).toBe("success");
    return answer;
  };
  try {
    await call("tasks", { key: "PLAN" });
    const plan = acceptedPlanCase.tasks.PLAN!;
    // These are real recorded piece headings/outcomes, not model outputs or a live-eval pass.
    const sections = plan.outcome!.split(/\n(?=[1-6]\. )/).slice(1);
    const ids = ["BUILD"];
    const needs = [[], [0], [1], [1], [1], [2, 3, 4]];
    await call("tasks", { key: "BUILD" });
    await call("update_task", {
      task: "BUILD",
      goal: sections[0],
      start_policy: "when-ready",
      blocked_by: [],
    });
    for (let i = 1; i < 6; i++) {
      const before = new Set(host.state().graph!.map((row) => row.id));
      await call("create_task", {
        title: sections[i]!.split(". ").slice(1, 2)[0]!,
        goal: sections[i],
        user_words: plan.userWords,
        parent: "P",
        basis: "PLAN",
        start_policy: "when-ready",
        blocked_by: needs[i]!.map((n) => ids[n]),
        constraints: [{ kind: "free", text: "implement: queued" }],
      });
      ids.push(host.state().graph!.find((row) => !before.has(row.id))!.id);
    }
    // INF-269 Q2: Queued starts the ready root before the graph read, not after it.
    await vi.waitFor(() => expect(host.starts).toEqual(["BUILD"]));
    const readBackIndex = calls.length;
    await call("tasks", { parent: "P" });
    const run = {
      endedNormally: true,
      calls,
      state: host.state(),
      review: { fullAcceptedSpecPreserved: false, noInventedMergePermission: false },
    };
    // Semantic verdicts below are ONLY scorer fixtures. A real run needs independent quotations.
    const review = {
      pieces: ids,
      fullSpecificationAndChecks: true,
      phoneCodeInPiece2: true,
      captainOnlyActionsPreserved: true,
      noInventedMergePermission: true,
      graphReadBack: true,
      quotations: ["Scorer plumbing fixture, not a model evaluation"],
    };
    expect(scoreAcceptedPlan(run, review)).toEqual([]);
    // INF-201/P1: the graph read must be in a later request than its last mutation.
    const lastLinkIndex = calls.findLastIndex((call) => call.name === "create_task");
    for (const grouped of [[lastLinkIndex, readBackIndex]]) {
      const batched = structuredClone(calls);
      batched[grouped[1]!]!.request = batched[grouped[0]!]!.request;
      expect(scoreAcceptedPlan({ ...run, calls: batched }, review)).toContain(
        "Read the completed graph after filing, linking and queue changes",
      );
    }
    const unmeasured = calls.map(({ request: _request, ...call }) => call);
    expect(scoreAcceptedPlan({ ...run, calls: unmeasured }, review)).toContain(
      "Read the completed graph after filing, linking and queue changes",
    );
    // INF-164: read the completed graph after linking, not merely PLAN before filing.
    const withoutReadBack = calls.filter((_, index) => index !== readBackIndex);
    expect(scoreAcceptedPlan({ ...run, calls: withoutReadBack }, review)).toContain(
      "Read the completed graph after filing, linking and queue changes",
    );
    const staleReadBack = [...withoutReadBack];
    staleReadBack.splice(
      calls.findLastIndex((call) => call.name === "create_task"),
      0,
      calls[readBackIndex]!,
    );
    expect(scoreAcceptedPlan({ ...run, calls: staleReadBack }, review)).toContain(
      "Read the completed graph after filing, linking and queue changes",
    );
    expect(scoreAcceptedPlan(run, { ...review, graphReadBack: false })).not.toEqual([]);
    // INF-269 Q1: preserve the captain-only actions, not a hold before starting the piece.
    expect(scoreAcceptedPlan(run, { ...review, captainOnlyActionsPreserved: false })).toContain(
      "Independent review must substantiate the full scope, selected answer and captain-only actions",
    );
    expect(
      scoreAcceptedPlan(
        {
          ...run,
          calls: [
            ...calls,
            {
              name: "emit_card",
              args: {
                title: "Approve the pieces again",
                body: "<p>Approve the already accepted pieces again.</p><p>They have not been queued.</p>",
                actions: [
                  { id: "approve", label: "Approve", default: true },
                  { id: "wait", label: "Leave waiting" },
                ],
              },
              result: "success",
            },
          ],
        },
        review,
      ),
    ).toContain("The first mate must not ask again before queueing approved pieces");
    // INF-104 F5: read-only context before the native plan read is not a write.
    for (const name of ["knowledge", "app_state", "supervision_log", "locate_project"]) {
      expect(
        scoreAcceptedPlan(
          { ...run, calls: [{ name, args: {}, result: "success" }, ...calls] },
          review,
        ),
      ).toEqual([]);
    }
    expect(
      scoreAcceptedPlan(
        { ...run, calls: [calls[2]!, calls[0]!, calls[1]!, ...calls.slice(3)] },
        review,
      ),
    ).toContain("Read the saved plan directly before writing");
    expect(scoreAcceptedPlan({ ...run, calls: calls.slice(1) }, review)).toContain(
      "Read the saved plan directly before writing",
    );
    expect(scoreAcceptedPlan(run, { ...review, phoneCodeInPiece2: false })).not.toEqual([]);
    const wrong = structuredClone(run);
    wrong.state.graph!.find((row) => row.id === ids[3])!.blockers = [ids[2]!];
    expect(scoreAcceptedPlan(wrong, review)).toContain("Piece 4 has the wrong prerequisites");
    const wrongParent = structuredClone(run);
    wrongParent.state.graph!.find((row) => row.id === ids[1])!.parent = "another-parent";
    expect(scoreAcceptedPlan(wrongParent, review)).toContain(
      "Piece 2 needs the original parent and plan basis",
    );
    expect(scoreAcceptedPlan({ ...run, endedNormally: false }, review)).toContain(
      "The turn did not end normally",
    );
    // P1/P2: a forgotten Backlog piece would stall after its blockers merge.
    for (const piece of [1, 3, 4])
      await call("update_task", { task: ids[piece], start_policy: "on-request" });
    const stalled = scoreAcceptedPlan({ ...run, calls, state: host.state() }, review);
    for (const piece of [2, 4, 5]) expect(stalled).toContain(`Piece ${piece} must be Queued`);
    for (const piece of [1, 3, 4])
      await call("update_task", {
        task: ids[piece],
        start_policy: "when-ready",
        blocked_by: needs[piece]!.map((n) => ids[n]),
      });
    await call("tasks", { parent: "P" });
    expect(scoreAcceptedPlan({ ...run, calls, state: host.state() }, review)).toEqual([]);
    const manual = {
      ...run,
      state: host.state(),
      calls: [
        ...calls,
        {
          name: "update_task",
          args: { task: "BUILD", start_now: true },
          result: "success" as const,
        },
      ],
    };
    expect(scoreAcceptedPlan(manual, review)).toContain(
      "Queued pieces start through the host, not manual start calls",
    );
    // INF-222: the live model set every new piece to autonomy off to match BUILD,
    // despite no captain request. Disclosure or a mistaken review cannot authorize it.
    for (const task of ids.slice(1)) await call("update_task", { task, autonomy: "off" });
    expect(scoreAcceptedPlan({ ...run, calls, state: host.state() }, review)).toContain(
      "Plan acceptance does not authorize autonomy edits",
    );
  } finally {
    await host.close();
  }
});

// INF-104 F3: an accepted-plan run refunds only unused calls at its approved module rate.
it("keeps the enlarged native-read reservation for requests actually used", async () => {
  const root = scratchDir("accepted-plan-refund-");
  const api = await scriptedEndpoint({ name: "tasks", args: { key: "PLAN" } });
  closeProvider = api.close;
  const opts = options(root);
  disposablePiAccounts(opts, api.port);
  const paths = appPathsFor(opts.userData as string);
  const vault = readOnlyVault(
    AccountVault.create(paths, { pi: new PiAccountBackend({ modelsPath: paths.modelsPath }) }),
  );
  const deps = {
    // This refund regression keeps its original one-read fixture; both cases are checked above.
    module: { ...acceptedPlanEvaluation, cases: [acceptedPlanCase] },
    scratch: () => scratchDir("eval-case-"),
    factory: async (role: AccountModel, dir: string) => ({
      factory: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }),
      binding: {
        backend: "pi",
        accountId: role.accountId,
        runtime: await vault.runtimeFor(role.accountId),
      } as SessionBinding,
    }),
  };
  const dry = await runEvaluation(opts, deps);
  const result = await runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps);
  expect(result.responses![acceptedPlanCase.id]!.endedNormally).toBe(true);
  const record = JSON.parse(readFileSync(join(opts.out, `${acceptedPlanCase.id}.json`), "utf8"));
  // INF-201: the scorer's request boundaries are observed events, not call-array positions.
  expect(result.responses![acceptedPlanCase.id]!.calls.map((call) => call.request)).toEqual(
    record.frames
      .filter((frame: { type: string }) => frame.type === "tool_end")
      .map((frame: { request: number }) => frame.request),
  );
  const usage = JSON.parse(readFileSync(join(opts.out, "usage.json"), "utf8"));
  expect(usage.callsUsed).toBe(2); // Read the native plan, then finish the turn.
  expect(usage.inputTokensReserved).toBe(
    reservation(dry.sheet.cases[0]!.promptBytes, usage.callsUsed, dry.sheet.limits),
  );
});

// INF-104 F4: loss of the queued wake must fail even when the accepted choice itself is valid.
it("fails and disposes a missing acceptance wake instead of hanging preparation", async () => {
  const dir = scratchDir("accepted-plan-refusal-");
  const enqueue = vi.spyOn(InboxStore.prototype, "enqueueWake").mockReturnValue(null);
  vi.useFakeTimers();
  try {
    const failure = approvalHost(
      acceptedPlanCase,
      dir,
      { provider: "fm-mock", id: "mock-1" },
      [],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(ACCEPTANCE_WAIT_MS);
    expect(await failure).toEqual(
      new Error("The evaluation's answer-close wake did not reach the first mate"),
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    enqueue.mockRestore();
    vi.useRealTimers();
  }
});

// INF-416 piece K preserves INF-133 F3: the second approved live case pages its fields,
// including the saved report, brief, selected answers and complete accepted offer.
it("serves the large design through production task tools as lossless field pages", async () => {
  const host = await approvalHost(
    largeDesignCase,
    scratchDir("large-design-eval-"),
    { provider: "fm-mock", id: "mock-1" },
    [],
  );
  try {
    const tool = host.spec.tools.find(({ name }) => name === "tasks")!;
    const result = await tool.run({ key: "PLAN" });
    const first = parseTasksQueryText(result.text);
    // The remaining page now contains unique design text, not copies hidden with the choices.
    expect(first.omitted.map(({ field }) => field)).toEqual(["card"]);
    expect(first.rows[0]?.resolution?.answers).toEqual(
      largeDesignCase.tasks.PLAN!.resolution!.answers,
    );
    const reads = [result.text];
    for (const omitted of first.omitted) {
      reads.push(...(await pageTaskField((args) => tool.run(args), "PLAN", omitted.field)));
    }
    const row = assembleTasksReads(reads)[0]!;
    expect(result.text).not.toContain("$text");
    expect(result.text).toContain("does not fit one read");
    for (const text of reads) {
      expect(boundedToolText(text, acceptedPlanEvaluation.toolResultBytes)).toBe(text);
    }
    expect(row.outcome).toBe(largeDesignCase.tasks.PLAN!.outcome);
    expect(row.brief).toBe(largeDesignCase.tasks.PLAN!.brief);
    expect(row.resolution?.answers).toEqual(largeDesignCase.tasks.PLAN!.resolution!.answers);
    expect(taskResolutionBody(row, "offer")).toBe(
      largeDesignCase.tasks.PLAN!.resolution!.offer.body,
    );
    const calls: import("../scripts/evals/approvalHandoff.ts").EvalCall[] = [
      { name: "tasks", args: { key: "PLAN" }, result: "success" },
    ];
    for (const args of [
      { task: "DESIGN", goal: largeDesignCase.tasks.PLAN!.outcome },
      { task: "DESIGN", start_now: true },
    ]) {
      const answer = await host.spec.tools.find((tool) => tool.name === "update_task")!.run(args);
      const result = host.effect("update_task", args, answer);
      expect(result, answer.text).toBe("success");
      calls.push({ name: "update_task", args, result });
    }
    const run = {
      endedNormally: true,
      calls,
      state: host.state(),
      review: { fullAcceptedSpecPreserved: false, noInventedMergePermission: false },
    };
    // Scorer fixture only: a live verdict requires an independent reader's quotations.
    const review = {
      fullSpecificationAvailable: true,
      selectedAnswersPreserved: true,
      unansweredChoicesPreserved: true,
      noBuildOrPublicationPermission: true,
      noRetrievalDelegation: true,
      quotations: ["Scorer fixture, not live model evidence"],
    };
    expect(scoreLargeDesign(run, review)).toEqual([]);
    expect(scoreLargeDesign({ ...run, calls: calls.slice(1) }, review)).not.toEqual([]);
    expect(scoreLargeDesign(run, { ...review, selectedAnswersPreserved: false })).not.toEqual([]);
    const wrong = structuredClone(run);
    wrong.state.graph!.find((row) => row.id === "DESIGN")!.kind = "implement";
    expect(scoreLargeDesign(wrong, review)).toContain(
      "The continuation must remain a grounded read-only plan",
    );
    const implementation = structuredClone(run);
    implementation.state.graph!.find((row) => row.id === "BUILD")!.status = "active";
    expect(scoreLargeDesign(implementation, review)).toContain("Keep BUILD open and on request");
  } finally {
    await host.close();
  }
});

// INF-143: these exact live calls started four later pieces before their links existed.
it("refuses automatic creation with undeclared prerequisites before writing any task", async () => {
  const recorded = JSON.parse(
    readFileSync("tests/fixtures/accepted-plan/inf143-early-starts.json", "utf8"),
  );
  const host = await approvalHost(
    acceptedPlanCase,
    scratchDir("undeclared-starts-"),
    { provider: "fm-mock", id: "mock-1" },
    [],
  );
  try {
    const before = host.state();
    const tool = host.spec.tools.find(({ name }) => name === "create_task")!;
    const answers = [];
    for (const call of recorded.calls) answers.push(await tool.run(call.args));
    expect(host.state()).toEqual(before);
    expect(host.starts).toEqual([]);
    for (const [i, answer] of answers.entries()) {
      expect(answer.details?.refusal).toEqual({ kind: "undeclared-prerequisites" });
      expect(host.effect("create_task", recorded.calls[i].args, answer)).toBe("refused");
    }
    // P1: approved pieces are queued with their prerequisites declared atomically.
    const answer = await tool.run({ ...recorded.calls[0].args, blocked_by: ["BUILD"] });
    expect(answer.details?.refusal).toBeUndefined();
    const created = host
      .state()
      .graph!.find((row) => !before.graph!.some((old) => old.id === row.id))!;
    expect(created).toMatchObject({
      status: "open",
      startPolicy: "when-ready",
      blockers: ["BUILD"],
    });
    expect(host.starts).toEqual([]);
  } finally {
    await host.close();
  }
});
