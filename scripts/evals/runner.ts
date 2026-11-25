/** Developer-only runner. Account access is metadata plus the production session bindings. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Value } from "typebox/value";
import { hostEnv } from "../../src/core/hostEnv.ts";
import { INFINITARY_ENTRYPOINT } from "../../src/core/claude/claudeCli.ts";
import { defaultClaudeConfigDir } from "../../src/core/claude/claudeQuota.ts";
import { createClaudeSessionFactory } from "../../src/core/claude/session.ts";
import { appPathsFor } from "../../src/core/paths.ts";
import { AccountVault } from "../../src/core/pi/accountVault.ts";
import { PiAccountBackend } from "../../src/core/pi/piAccountBackend.ts";
import { toolsFingerprint } from "../../src/core/pi/piResources.ts";
import { createPiSessionFactory } from "../../src/core/pi/session.ts";
import { TICK_PERIOD_MS, Ticker } from "../../src/core/orchestrator/ticker.ts";
import { BoundsWatcher } from "../../src/core/session/bounds.ts";
import { FIRSTMATE_MAX_OUTPUT_TOKENS } from "../../src/core/orchestrator/seat.ts";
import type {
  ModelSession,
  SessionBinding,
  SessionFactory,
} from "../../src/core/session/session.ts";
import type { BoundTool } from "../../src/core/session/tools.ts";
import { readSession } from "../../src/core/storage/sessionReader.ts";
import { defaultUserDataDir } from "../dispatch-corpus/userData.ts";
import {
  approvalCases,
  type ApprovalCase,
  type EvalCall,
  type EvalRun,
} from "./approvalHandoff.ts";
import { approvalHost, refuseOverlap } from "./host.ts";
import { sumUsage, type TokenUsage, tokenUsage, turnUsage } from "./usage.ts";

export const allowanceRefusal = new Error("Evaluation refused: this transport cannot guarantee included allowance only. No model request was made.");

export const hash = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export type Role = "firstmate" | "builder";
export type AccountModel = {
  accountId: string;
  accountLabel: string;
  provider: string;
  model: string;
  backend: "pi" | "claude";
};
export type Limits = {
  calls: number;
  inputTokens: number;
  firstmateCalls: number;
  builderCalls: number;
  requestMs: number;
  caseMs: number;
  outputTokens: number;
  retries: number;
  toolResultBytes: number;
};
export const LIMITS: Limits = {
  calls: 80,
  // Reservations count UTF-8 bytes as tokens (`reservation`), far above what a run reads.
  // Approval handoff's full 62-call plan reserves about 11.5M at its 2026-10-03 prompt sizes.
  inputTokens: 12_000_000,
  firstmateCalls: 6,
  builderCalls: 4,
  requestMs: 300_000,
  caseMs: 600_000,
  outputTokens: FIRSTMATE_MAX_OUTPUT_TOKENS,
  retries: 0,
  toolResultBytes: 16_384,
};
export type Sheet = {
  runId: string;
  outputDirectory: string;
  version: string;
  sourceHash: string;
  module: string;
  roles: Record<Role, AccountModel>;
  limits: Limits;
  cases: {
    id: string;
    role: Role;
    promptSha: string;
    instructionsSha: string;
    toolsSha: string;
    turnSha: string;
    /** What the case sends before its first reply; `inputTokens` is reserved from it. */
    promptBytes: number;
    /** The case's own call allowance, fixed before approval. */
    calls: number;
    inputTokens: number;
  }[];
  maximumCalls: number;
  maximumInputTokens: number;
};
export type EvalHost = Awaited<ReturnType<typeof approvalHost>>;
export type EvaluationModule = {
  name: string;
  includedAllowanceOnly?: true;
  cases: ApprovalCase[];
  host: typeof approvalHost;
  /** Reserve enough room for full native task reads; included in the approved sheet. */
  toolResultBytes?: number;
  /** Longer filing turns retain the same global call/input ceilings. */
  firstmateCalls?: number;
  /** Longer working turns retain the same global call/input ceilings. */
  builderCalls?: number;
};
export const approvalEvaluation: EvaluationModule = {
  name: "approval-handoff",
  cases: approvalCases,
  host: approvalHost,
};
export type Options = {
  out: string;
  version: string;
  sourceHash: string;
  roles: Record<Role, AccountModel>;
  userData?: string;
  approvedHash?: string;
  live?: boolean;
  claudeCrewTurn?: boolean;
};
export type Deps = {
  module?: EvaluationModule;
  factory?: (
    role: AccountModel,
    dir: string,
    clock: Ticker,
  ) => Promise<{ factory: SessionFactory; binding: SessionBinding }>;
  registryHash?: () => string;
  scratch?: () => string;
  /** Whether the run still runs under the Claude crewmate's client (`claudeCrewClient`). */
  crewClient?: () => boolean;
};

function processParents(): Map<number, number> {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    env: hostEnv(),
    encoding: "utf8",
  });
  const parents = new Map<number, number>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
  }
  return parents;
}

/**
 * Whether this run still runs under the Claude crewmate's client it was started from. The running
 * app holds the machine's Claude store for that client's whole life, so the evaluation's own Claude
 * clients never race the app's renewal over a single-use refresh token. The client names itself to
 * every command it runs (`CLAUDE_PID`), and the app labels every client it starts with its own
 * entrypoint (`INFINITARY_ENTRYPOINT`), unlike a person's terminal session or another program's
 * SDK client; a Pi crewmate's shell carries neither. A process whose parent ends is adopted by
 * another, so a run detached from the client (`nohup`, `setsid`, a shell that exited) or outliving
 * it no longer finds the client among its ancestors. A process table that cannot be read holds
 * nothing.
 */
export function claudeCrewClient(
  env: NodeJS.ProcessEnv = process.env,
  parents: () => Map<number, number> = processParents,
): () => boolean {
  const client = Number(env.CLAUDE_PID);
  if (
    env.CLAUDE_CODE_ENTRYPOINT !== INFINITARY_ENTRYPOINT ||
    !Number.isInteger(client) ||
    client <= 1
  )
    return () => false;
  return () => {
    try {
      const table = parents();
      const seen = new Set<number>();
      for (let at = table.get(process.pid); at !== undefined && !seen.has(at); at = table.get(at)) {
        if (at === client) return true;
        seen.add(at);
      }
    } catch {}
    return false;
  };
}
/** Why a live Claude run stopped once it no longer ran under the crewmate's client. */
export const CLIENT_ENDED = "Claude crewmate client ended";

const credentialPattern =
  /(?<![A-Za-z0-9])Bearer\s+[^\s"',}]+|(?:access_token|refresh_token)["']?\s*[:=]\s*["']?[^\s"',}]+|(?<![A-Za-z0-9])Bearer|access_token|refresh_token/gi;
/** Key and token prefixes count only where a word starts, in their real case: "task-card" is not a key. */
const keyPattern = /(?<![A-Za-z0-9])(?:sk-|eyJ)[A-Za-z0-9._-]*/g;
const redact = (text: string): string =>
  text.replace(credentialPattern, "[redacted]").replace(keyPattern, "[redacted]");
/**
 * Only declared artifact fields reach this writer. Unexpected credential-looking text is removed, never logged.
 * Strings are redacted before serialization, where an escape such as `\n` cannot hide a word's start; a key that
 * needed redaction takes its value with it.
 */
export function artifact(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "string") return redact(item);
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(
        Object.entries(item).map(([key, field]) => {
          const safe = redact(key);
          return [safe, safe === key ? field : "[redacted]"];
        }),
      );
    },
    2,
  );
}
function write(out: string, name: string, value: unknown): void {
  writeFileSync(join(out, name), artifact(value));
}
export function readOnlyVault(vault: Pick<AccountVault, "list" | "get" | "runtimeFor">) {
  return new Proxy(vault, {
    get(target, property) {
      if (!["list", "get", "runtimeFor"].includes(String(property)))
        throw new Error("Evaluation cannot change account metadata");
      const method = Reflect.get(target, property);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}
export function accountModels(
  userData: string,
  firstmate?: { accountId: string; provider: string; model: string },
  builder?: { accountId: string; provider: string; model: string },
): Record<Role, AccountModel> {
  const vault = readOnlyVault(
    AccountVault.create(appPathsFor(userData), {
      pi: new PiAccountBackend({ modelsPath: appPathsFor(userData).modelsPath }),
    }),
  );
  if (!firstmate) {
    // No app migrations, PRAGMAs, or writes: exactly the two permitted settings rows.
    const db = new Database(join(userData, "firstmate.db"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = db
        .prepare(
          "SELECT key, value FROM settings WHERE key IN ('firstmate-model', 'firstmate-account')",
        )
        .all() as { key: string; value: string }[];
      const settings = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
      const model = settings["firstmate-model"];
      if (!model?.provider || !model?.id || typeof settings["firstmate-account"] !== "string")
        throw new Error("Name Firstmate's model and account explicitly");
      firstmate = {
        accountId: settings["firstmate-account"],
        provider: model.provider,
        model: model.id,
      };
    } finally {
      db.close();
    }
  }
  if (!builder) throw new Error("Name the builder's model and account explicitly");
  const choose = (ref: { accountId: string; provider: string; model: string }): AccountModel => {
    const account = vault.get(ref.accountId);
    if (!account || !account.enabled || account.providerId !== ref.provider)
      throw new Error("Account is missing, disabled, or belongs to another provider");
    if (account.cutOff) throw new Error("Account has a standing cut-off; run refused");
    return {
      ...ref,
      accountLabel: account.label,
      backend: ref.provider === "anthropic-claude" ? "claude" : "pi",
    };
  };
  return { firstmate: choose(firstmate), builder: choose(builder) };
}

const fingerprint = toolsFingerprint;
function normalizedTurn(host: EvalHost): string {
  let turn = host.prompt;
  for (const [alias, id] of Object.entries(host.ids)) turn = turn.replaceAll(id, alias);
  return turn;
}

/** UTF-8 bytes are a deliberately conservative token ceiling for a case's first request. */
export function promptBytes(host: EvalHost): number {
  return Buffer.byteLength(
    host.spec.instructions.base +
      (host.spec.instructions.served?.text ?? "") +
      host.prompt +
      JSON.stringify(
        host.spec.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ),
  );
}
/** Keep full native results when they fit; the fallback stays within a UTF-8 byte budget. */
export function boundedToolText(text: string, bytes: number): string {
  return Buffer.byteLength(text) <= bytes ? text : text.slice(0, Math.floor(bytes / 4));
}
/** A whole case's input for `calls` requests, including the output and tool results each adds. */
export function reservation(bytes: number, calls: number, limits: Limits = LIMITS): number {
  return (
    calls * bytes + ((limits.outputTokens * 4 + limits.toolResultBytes) * calls * (calls - 1)) / 2
  );
}
/**
 * Every case's call allowance, fixed on the sheet before approval. Each starts at its role's
 * limit; while the plan passes the run's call or input-token ceiling, the largest allowance
 * (the later case on a tie) gives up one call. The run reserves exactly this plan, so an
 * earlier case can never shorten a later one.
 */
export function planAllowances(
  cases: readonly { role: Role; bytes: number; maxCalls?: number }[],
  limits: Limits = LIMITS,
): { calls: number; inputTokens: number }[] {
  const calls = cases.map((test) => {
    const roleLimit = test.role === "builder" ? limits.builderCalls : limits.firstmateCalls;
    if (test.maxCalls === undefined) return roleLimit;
    if (!Number.isSafeInteger(test.maxCalls) || test.maxCalls < 1 || test.maxCalls > roleLimit)
      throw new Error("Invalid case request allowance");
    return test.maxCalls;
  });
  const over = () =>
    calls.reduce((sum, n) => sum + n, 0) > limits.calls ||
    cases.reduce((sum, test, i) => sum + reservation(test.bytes, calls[i]!, limits), 0) >
      limits.inputTokens;
  while (over()) {
    const largest = Math.max(...calls);
    if (largest === 0) break;
    calls[calls.lastIndexOf(largest)]!--;
  }
  return cases.map((test, i) => ({
    calls: calls[i]!,
    inputTokens: reservation(test.bytes, calls[i]!, limits),
  }));
}
export function evaluationLimits(evaluation: EvaluationModule): Limits {
  return {
    ...LIMITS,
    toolResultBytes: evaluation.toolResultBytes ?? LIMITS.toolResultBytes,
    firstmateCalls: evaluation.firstmateCalls ?? LIMITS.firstmateCalls,
    builderCalls: evaluation.builderCalls ?? LIMITS.builderCalls,
  };
}

export async function runEvaluation(
  options: Options,
  deps: Deps = {},
): Promise<{ sheet: Sheet; sheetHash: string; responses?: Record<string, EvalRun> }> {
  const evaluation = deps.module ?? approvalEvaluation;
  const limits = evaluationLimits(evaluation);
  if (
    !Number.isSafeInteger(limits.toolResultBytes) ||
    limits.toolResultBytes < 1 ||
    limits.toolResultBytes > 1_048_576
  )
    throw new Error("Invalid tool-result reservation");
  if (
    !Number.isSafeInteger(limits.firstmateCalls) ||
    limits.firstmateCalls < 1 ||
    limits.firstmateCalls > 12
  )
    throw new Error("Invalid first mate call allowance");
  if (
    !Number.isSafeInteger(limits.builderCalls) ||
    limits.builderCalls < 1 ||
    limits.builderCalls > 12
  )
    throw new Error("Invalid builder call allowance");
  const ids = evaluation.cases.map((test) => test.id);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
  )
    throw new Error("Evaluation cases need unique, safe artifact ids");
  const userData = resolve(options.userData ?? defaultUserDataDir());
  const release = resolve(defaultUserDataDir());
  const protectedDirs = [release, `${release}-dev`, userData];
  const out = resolve(options.out);
  refuseOverlap(out, protectedDirs);
  const saved =
    options.live && existsSync(join(out, "run-sheet.json"))
      ? (JSON.parse(readFileSync(join(out, "run-sheet.json"), "utf8")) as Sheet & {
          sheetHash?: string;
        })
      : undefined;
  // Reject already-invalid admission before rebuilding every isolated host. This only
  // refuses: a matching saved hash still needs the fresh fingerprints measured below.
  if (
    options.live &&
    (!saved ||
      !options.approvedHash ||
      (saved.sheetHash !== undefined && options.approvedHash !== saved.sheetHash) ||
      saved.version !== options.version ||
      saved.sourceHash !== options.sourceHash)
  )
    throw new Error("Live evaluation requires the exact approved run-sheet hash");
  const scratch = deps.scratch ?? (() => mkdtempSync(join(tmpdir(), "fm-model-eval-")));
  const measured: Omit<Sheet["cases"][number], "calls" | "inputTokens">[] = [];
  for (const test of evaluation.cases) {
    const dir = scratch();
    let host: EvalHost | undefined;
    try {
      host = await evaluation.host(
        test,
        dir,
        { provider: options.roles[test.role].provider, id: options.roles[test.role].model },
        protectedDirs,
      );
      measured.push({
        id: test.id,
        role: test.role,
        promptSha: hash(host.spec.instructions.base),
        instructionsSha: hash(host.spec.instructions),
        toolsSha: fingerprint(host.spec.tools),
        turnSha: hash(normalizedTurn(host)),
        promptBytes: promptBytes(host),
      });
    } finally {
      await host?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const plan = planAllowances(
    measured.map((row, index) => ({
      role: row.role,
      bytes: row.promptBytes,
      maxCalls: evaluation.cases[index]!.maxCalls,
    })),
    limits,
  );
  const prepared: Sheet["cases"] = measured.map((row, i) => ({ ...row, ...plan[i]! }));
  const sheet: Sheet = {
    runId: saved?.runId ?? randomUUID(),
    outputDirectory: out,
    version: options.version,
    sourceHash: options.sourceHash,
    module: evaluation.name,
    roles: options.roles,
    limits,
    cases: prepared,
    maximumCalls: prepared.reduce((sum, row) => sum + row.calls, 0),
    maximumInputTokens: prepared.reduce((sum, row) => sum + row.inputTokens, 0),
  };
  const sheetHash = hash(sheet);
  if (options.live && (!saved || !options.approvedHash || options.approvedHash !== sheetHash))
    throw new Error("Live evaluation requires the exact approved run-sheet hash");
  const claude = Object.values(options.roles).some((role) => role.backend === "claude");
  const underClient = deps.crewClient ?? claudeCrewClient();
  if (options.live && claude && (!options.claudeCrewTurn || !underClient()))
    throw new Error("Claude live evaluation must run under the Claude crewmate's own client");
  mkdirSync(out, { recursive: true });
  if (existsSync(join(out, "run-started.json")))
    throw new Error(
      "This run sheet was already used here; request a new approval before another run",
    );
  write(out, "run-sheet.json", { ...sheet, sheetHash });
  if (!options.live) return { sheet, sheetHash };
  // The Codex runtime has no request-level ban on paid credits. A quota snapshot
  // cannot bind billing for a subsequent request, even on a pinned account.
  if (evaluation.includedAllowanceOnly) throw allowanceRefusal;
  // One approved sheet is one run; do not silently spend it again on the same output folder.
  // The pid lets the crewmate hold its turn until this process exits.
  write(out, "run-started.json", { sheetHash, pid: process.pid });
  const registryPath = join(userData, "accounts", "registry.json");
  const registryHash = deps.registryHash ?? (() => hash(readFileSync(registryPath, "utf8")));
  const before = registryHash();
  const responses: Record<string, EvalRun> = {};
  const caseUsages: TokenUsage[] = [];
  let callsUsed = 0;
  let tokensReserved = 0;
  let stop: string | undefined;
  let clientEnded = false;
  let cutOpenCase: (() => void) | undefined;
  /** A Claude run that no longer runs under the crewmate's client cuts its open case and opens no other. */
  const checkClient = () => {
    if (!claude || stop || underClient()) return;
    clientEnded = true;
    stop = CLIENT_ENDED;
    cutOpenCase?.();
  };
  const clock = new Ticker();
  const watcher = new BoundsWatcher(clock);
  clock.register("claude-crew-client", TICK_PERIOD_MS, checkClient);
  clock.start();
  try {
    for (const test of evaluation.cases) {
      const dir = scratch();
      let host: EvalHost | undefined;
      let actualTurn: string | undefined;
      let session: ModelSession | undefined;
      let unsubscribe: (() => void) | undefined;
      const calls: EvalCall[] = [];
      const results: { name: string; text: string; servedText: string; result: string }[] = [];
      const frames: unknown[] = [];
      const turnUsages: TokenUsage[] = [];
      const usageSource = options.roles[test.role].backend === "claude" ? "turn_end" : "native";
      let caseUsage = sumUsage([]);
      checkClient();
      let bounded = stop;
      cutOpenCase = () => {
        bounded ??= CLIENT_ENDED;
        void session
          ?.abort("Evaluation stopped: it no longer runs under the Claude crewmate's client")
          .catch(() => {});
      };
      let requestCount = 0;
      // Every request the client began, the one the call limit refuses included: each spent usage.
      let requestsBegun = 0;
      let resultBytesLeft = limits.toolResultBytes;
      const started = Date.now();
      try {
        host = await evaluation.host(
          test,
          dir,
          { provider: options.roles[test.role].provider, id: options.roles[test.role].model },
          protectedDirs,
        );
        const intended = prepared.find((row) => row.id === test.id)!;
        if (
          hash(host.spec.instructions.base) !== intended.promptSha ||
          hash(host.spec.instructions) !== intended.instructionsSha ||
          fingerprint(host.spec.tools) !== intended.toolsSha ||
          hash(normalizedTurn(host)) !== intended.turnSha
        )
          throw new Error("Host changed after run sheet approval");
        // The approved plan already fits the ceilings: reserve this case's whole allowance
        // (including the growing output/tool context) BEFORE a provider can start.
        const maxTurns = intended.calls;
        const reserve = intended.inputTokens;
        if (!bounded && maxTurns === 0) bounded = "run budget";
        if (!bounded) {
          // Until the client reports usage, an attempted case has unknown consumption.
          caseUsage = tokenUsage(undefined);
          tokensReserved += reserve;
          const connect = deps.factory
            ? await deps.factory(options.roles[test.role], dir, clock)
            : await productionFactory(options.roles[test.role], userData, dir, clock);
          const executeHost = host;
          const tools = host.spec.tools.map(
            (tool): BoundTool => ({
              ...tool,
              run: async (args) => {
                let result: EvalCall["result"] = "success";
                let text = "";
                let hostText: string | undefined;
                try {
                  if (bounded) {
                    result = "refused";
                    text = "Evaluation has stopped";
                  } else if (!Value.Check(tool.parameters, args)) {
                    result = "invalid";
                    text = "Invalid tool parameters";
                  } else if (
                    tool.name === "settle_task" &&
                    !isFictionalAnswerClose(args)
                  ) {
                    result = "refused";
                    text = "Evaluation never merges, discards or releases tasks";
                  } else {
                    const answer = await tool.run(args);
                    hostText = answer.text;
                    text = boundedToolText(answer.text, resultBytesLeft);
                    resultBytesLeft -= Buffer.byteLength(text);
                    result = executeHost.effect(tool.name, args, answer);
                    // The throwaway host verifies typed effects, never parses refusal prose.
                  }
                } catch {
                  result = "failed";
                  text = "Tool execution failed";
                }
                calls.push({
                  name: tool.name,
                  args: executeHost.normalize(args) as Record<string, unknown>,
                  result,
                  request: requestCount,
                });
                results.push({ name: tool.name, text: hostText ?? text, servedText: text, result });
                if (result !== "success") {
                  bounded = "tool refusal or failure";
                  stop = bounded;
                  void session
                    ?.abort("Evaluation stopped on a tool refusal or failure")
                    .catch(() => {});
                }
                return { text };
              },
            }),
          );
          session = await watcher.factory(connect.factory).open({
            ...host.spec,
            binding: connect.binding,
            model: {
              provider: options.roles[test.role].provider,
              id: options.roles[test.role].model,
            },
            tools,
            bounds: {
              watched: { requestTimeoutMs: LIMITS.requestMs, turnTimeoutMs: LIMITS.caseMs },
              request: {
                ...host.spec.bounds?.request,
                maxOutputTokens: LIMITS.outputTokens,
                maxModelTurns: maxTurns,
                retries: LIMITS.retries,
              },
            },
          });
          unsubscribe = session.subscribe((event) => {
            if (event.type === "turn_end") turnUsages.push(turnUsage(event.usage));
            if (event.type === "request_started") {
              requestsBegun++;
              if (callsUsed >= LIMITS.calls || requestCount >= maxTurns) {
                bounded = "model call limit";
                stop = bounded;
                void session?.abort("Evaluation model call limit reached").catch(() => {});
                return;
              }
              callsUsed++;
              requestCount++;
              resultBytesLeft = limits.toolResultBytes;
              checkClient();
            }
            // A turn the runner cut itself reports the cut as its failure; keep the runner's reason.
            if (event.type === "turn_failed" && !bounded) {
              bounded = event.cutOff?.class ?? "provider failure";
              stop = bounded;
            }
            // The artifact has only events, not environment, config, auth, or headers.
            if (
              [
                "assistant_delta",
                "thinking_delta",
                "turn_end",
                "turn_closed",
                "request_started",
                "tool_start",
                "tool_end",
              ].includes(event.type)
            )
              frames.push({ ...event, request: requestCount });
          });
          if (!clientEnded) {
            const approved = host.prompt;
            const send = (text: string) => {
              if (actualTurn !== undefined || text !== approved) throw new Error("Unapproved evaluation turn");
              actualTurn = text;
              return session!.prompt(text);
            };
            if (host.dispatch) await host.dispatch(send);
            else await send(approved);
          }
          if (requestCount === 0) bounded = "no observed model request";
          if (
            requestCount >= maxTurns &&
            !frames.some((frame) => (frame as { type: string }).type === "turn_closed")
          )
            bounded = "case call limit";
          // Whatever else the cut turn shows, the client's end is why it stopped.
          if (clientEnded) bounded = CLIENT_ENDED;
          tokensReserved -= Math.max(
            0,
            reserve - reservation(intended.promptBytes, requestCount, limits),
          );
          await session.detach();
          session.dispose();
          await session.closed();
        }
        if (bounded) stop = bounded;
        responses[test.id] = {
          endedNormally: !bounded,
          calls,
          state: host.state(),
          review: { fullAcceptedSpecPreserved: false, noInventedMergePermission: false },
        };
        const record = session?.recordPath();
        let nativeRequest = 0;
        const native =
          record && existsSync(record)
            ? readSession(record)
                .entries.filter((entry) => entry.type === "message")
                .map((entry) => {
                  const message = entry.message as Record<string, unknown>;
                  return {
                    request: message.role === "assistant" ? ++nativeRequest : nativeRequest,
                    role: message.role,
                    content: message.content,
                    model: message.model,
                    provider: message.provider,
                    usage:
                      message.role === "assistant"
                        ? {
                            ...(message.usage as Record<string, unknown> | undefined),
                            ...tokenUsage(message.usage),
                          }
                        : null,
                    stopReason: message.stopReason,
                  };
                })
            : [];
        if (session) {
          const assistantUsage = native.flatMap((response) =>
            response.role === "assistant" ? [tokenUsage(response.usage)] : [],
          );
          // Never add the transcript to turn totals: they describe overlapping calls.
          // Claude's turn totals also include its client's own side calls, but count a request
          // only once its answer finished: one cut mid-answer has no stop reason here, and is
          // missing from them, so they are a smaller number than was spent.
          const finished = native.filter(
            (message) =>
              message.role === "assistant" &&
              typeof message.stopReason === "string" &&
              message.stopReason !== "error",
          ).length;
          const rows = usageSource === "turn_end" ? turnUsages : assistantUsage;
          const uncounted =
            usageSource === "turn_end" ? finished < requestsBegun : nativeRequest < requestCount;
          caseUsage = sumUsage([
            ...rows,
            ...(!rows.length || uncounted ? [tokenUsage(undefined)] : []),
          ]);
        }
        const served = native
          .filter((message) => message.role === "assistant" && message.model)
          .at(-1);
        if (!bounded && !served) {
          bounded = "missing served-model evidence";
          stop = bounded;
          responses[test.id]!.endedNormally = false;
        }
        write(out, `${test.id}.json`, {
          backend: options.roles[test.role].backend,
          accountLabel: options.roles[test.role].accountLabel,
          requestedModel: options.roles[test.role].model,
          servedModel: served ? { provider: served.provider, id: served.model } : undefined,
          ...intended,
          approvedTurnSha: intended.turnSha,
          turnSha: actualTurn === undefined ? undefined : hash(actualTurn),
          userTurn: actualTurn,
          frames,
          native,
          usageTotals: caseUsage,
          usageSource,
          results,
          state: responses[test.id]!.state,
          starts: host.starts,
          ending: bounded ? "bounded" : "normal",
          reason: bounded,
          requests: requestCount,
          wallMs: Date.now() - started,
        });
      } catch {
        stop = "infrastructure failure";
        if (host)
          responses[test.id] = {
            endedNormally: false,
            calls,
            state: host.state(),
            review: { fullAcceptedSpecPreserved: false, noInventedMergePermission: false },
          };
        write(out, `${test.id}.json`, {
          id: test.id,
          role: test.role,
          backend: options.roles[test.role].backend,
          accountLabel: options.roles[test.role].accountLabel,
          requestedModel: options.roles[test.role].model,
          frames,
          calls,
          results,
          state: host?.state(),
          turnSha: actualTurn === undefined ? undefined : hash(actualTurn),
          userTurn: actualTurn,
          ending: "bounded",
          reason: stop,
          usageTotals: caseUsage,
          usageSource,
          requests: requestCount,
          wallMs: Date.now() - started,
        });
      } finally {
        caseUsages.push(caseUsage);
        cutOpenCase = undefined;
        unsubscribe?.();
        session?.dispose();
        await session?.closed();
        await host?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    clock.stop();
    const after = registryHash();
    write(out, "registry-check.json", { before, after, unchanged: before === after });

    if (before !== after)
      for (const response of Object.values(responses)) response.endedNormally = false;
    write(out, "responses.json", responses);
    write(out, "usage.json", {
      callsUsed,
      inputTokensReserved: tokensReserved,
      usageTotals: sumUsage(caseUsages),
      stop,
    });
  }
  if (before !== registryHash())
    throw new Error(
      "Account registry changed during evaluation; inspect concurrent activity, do not restore it",
    );
  return { sheet, sheetHash, responses };
}

export function evaluationClaudeEnv(base: NodeJS.ProcessEnv = hostEnv()): NodeJS.ProcessEnv {
  return { ...base, CLAUDE_CODE_MAX_RETRIES: String(LIMITS.retries) };
}

async function productionFactory(role: AccountModel, userData: string, dir: string, clock: Ticker) {
  if (role.backend === "claude")
    return {
      factory: createClaudeSessionFactory({
        configDir: defaultClaudeConfigDir(),
        clock,
        env: evaluationClaudeEnv,
      }),
      binding: { backend: "claude", accountId: role.accountId } as SessionBinding,
    };
  const paths = appPathsFor(userData);
  const vault = readOnlyVault(
    AccountVault.create(paths, { pi: new PiAccountBackend({ modelsPath: paths.modelsPath }) }),
  );
  const account = vault.get(role.accountId);
  if (!account || !account.enabled || account.providerId !== role.provider || account.cutOff)
    throw new Error("Account no longer matches the approved run sheet");
  return {
    factory: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }),
    binding: {
      backend: "pi",
      accountId: role.accountId,
      runtime: await vault.runtimeFor(role.accountId),
    } as SessionBinding,
  };
}

/** The one close an evaluation runs: a done close of a fictional answer, on no words of the captain's. */
function isFictionalAnswerClose(args: unknown): boolean {
  const { mode, why, captain_words } = args as { mode?: string; why?: string; captain_words?: string };
  return mode === "done" && why === "answered" && captain_words === undefined;
}
