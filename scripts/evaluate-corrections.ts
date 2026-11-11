/**
 * Offline case loading and opt-in live scoring for the accepted correction
 * detector. Private cases, labels, selection metadata and reports stay outside
 * the project. Model inputs come only from the source-time context allowlist.
 * The command never prints case text, provider errors or generated prose.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { isDevObserveEnabled } from "../src/core/observe/gate.ts";
import { type DecisionAnswer, type DecisionQuestion, decisionQuestionSchema } from "../src/shared/decisions.ts";
import type { FmUsage } from "../src/shared/events.ts";
import { detectPackaged } from "./export-corpus.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

const verdict = z.enum(["review", "ordinary", "unclear"]);
const identity = z.string().regex(/^[a-f0-9]{64}$/);
const speaker = z.enum(["captain", "author", "host"]);
const contextSchema = z.object({
  latestReply: z.string().min(1),
  preceding: z.array(z.object({ who: speaker, text: z.string() })),
  precedingSource: z.enum(["same-thread", "recent-conversation"]).optional(),
  addressedCard: z.object({ title: z.string(), text: z.string() }).optional(),
  project: z.object({ id: z.string(), name: z.string() }).optional(),
  task: z.object({ title: z.string(), goal: z.string().optional() }).optional(),
  unavailableContext: z.boolean(),
});
const caseSchema = z.object({ id: identity, context: contextSchema });
const labelSchema = z.object({ id: identity, expected: verdict });
export type CorrectionEvalCase = z.infer<typeof caseSchema>;
export type CorrectionEvalLabel = z.infer<typeof labelSchema>;
export type ContextVariant = "reply" | "nearby" | "card-only" | "card";

/** Zod's non-strict objects strip all fields except this explicit allowlist. */
export function readCorrectionCases(text: string): CorrectionEvalCase[] {
  const rows = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => caseSchema.parse(JSON.parse(line)));
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate case identity");
  return rows;
}

export function readCorrectionLabels(text: string): Map<string, CorrectionEvalLabel> {
  const rows = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => labelSchema.parse(JSON.parse(line)));
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate label identity");
  return new Map(rows.map((row) => [row.id, row]));
}

export function projectContext(context: CorrectionEvalCase["context"], variant: ContextVariant) {
  return {
    latestReply: context.latestReply,
    preceding: variant === "reply" || variant === "card-only" ? [] : context.preceding,
    ...(context.precedingSource ? { precedingSource: context.precedingSource } : {}),
    ...((variant === "card" || variant === "card-only") && context.addressedCard
      ? { addressedCard: context.addressedCard }
      : {}),
    ...(context.project ? { project: context.project } : {}),
    ...(context.task ? { task: context.task } : {}),
    unavailableContext:
      context.unavailableContext ||
      ((variant === "reply" || variant === "card-only") && context.preceding.length > 0) ||
      ((variant === "reply" || variant === "nearby") && context.addressedCard !== undefined),
  };
}

/** Prompt experiments keep the accepted closed judgment contract unchanged. */
export function readCorrectionQuestion(text: string): DecisionQuestion {
  const question = decisionQuestionSchema.strict().parse(JSON.parse(text));
  if (question.type !== "choice" || question.abstain !== "unclear" ||
      JSON.stringify(Object.keys(question.criteria).sort()) !== JSON.stringify([...verdict.options].sort()))
    throw new Error("Correction experiments must keep the review/ordinary/unclear contract");
  return question;
}

/** Fingerprints bind labels to private inputs without reproducing their words. */
export function corpusFingerprint(
  cases: CorrectionEvalCase[],
  labels: Map<string, CorrectionEvalLabel>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(cases))
    .update(JSON.stringify([...labels]))
    .digest("hex");
}

/** Resolve symlinks too: output may not be written into the project indirectly. */
export function privatePath(path: string, output = false): string {
  const absolute = resolve(path);
  const canonical = output
    ? resolve(realpathSync(dirname(absolute)), relative(dirname(absolute), absolute))
    : realpathSync(absolute);
  const fromProject = relative(realpathSync(REPO_ROOT), canonical);
  const outside = fromProject === ".." || fromProject.startsWith("../") || isAbsolute(fromProject);
  if (!outside) {
    throw new Error("Private evaluation files must be outside the project");
  }
  return canonical;
}

const poolSchema = z.object({
  answerer: z.object({ kind: z.literal("adapted"), offering: z.literal("auto") }),
  models: z
    .array(
      z.object({
        provider: z.enum(["anthropic-claude", "openai-codex"]),
        id: z.string().min(1),
        slot: z.literal("low"),
      }),
    )
    .min(1),
  flagshipProvider: z.enum(["anthropic-claude", "openai-codex"]).nullable(),
});

async function main(): Promise<void> {
  // The existing offline-reader gate runs before any private input is opened.
  if (
    !isDevObserveEnabled({
      isPackaged: detectPackaged({ moduleUrl: import.meta.url, env: process.env }),
      env: process.env,
    })
  )
    throw new Error("Private evaluation is unavailable in this build");
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--live") continue;
    if (!key?.startsWith("--") || !args[i + 1]) throw new Error("Invalid arguments");
    options.set(key.slice(2), args[++i] as string);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const casesFile = privatePath(required("cases"));
  const labelsFile = privatePath(required("labels"));
  const reportFile = privatePath(required("out"), true);
  const cases = readCorrectionCases(readFileSync(casesFile, "utf8"));
  const labels = readCorrectionLabels(readFileSync(labelsFile, "utf8"));
  if (!cases.length || cases.some((row) => !labels.has(row.id)))
    throw new Error("Every case needs a frozen label");
  const budget = Number(required("context-bytes"));
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid context budget");
  const variant = z.enum(["reply", "nearby", "card-only", "card"]).parse(required("variant"));
  const cardBytes = options.has("card-bytes") ? Number(required("card-bytes")) : undefined;
  const fingerprint = corpusFingerprint(cases, labels);
  // Exclusive creation prevents accidental replay of a run whose outcome is unknown.
  writeFileSync(
    reportFile,
    JSON.stringify({
      kind: "start",
      fingerprint,
      cases: cases.length,
      variant,
      budget,
      cardBytes,
      live,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const runner = await openModuleRunner();
  try {
    const { CORRECTION_QUESTION, correctionState } = await runner.import<
      typeof import("../src/core/decisions/correctionQuestion.ts")
    >("/src/core/decisions/correctionQuestion.ts");
    const question = options.has("question-file")
      ? readCorrectionQuestion(readFileSync(privatePath(required("question-file")), "utf8"))
      : CORRECTION_QUESTION;
    appendFileSync(reportFile, JSON.stringify({ kind: "question", version: question.version,
      fingerprint: createHash("sha256").update(JSON.stringify(question)).digest("hex") }) + "\n");
    const { excerptCorrectionCard } = await runner.import<
      typeof import("../src/core/decisions/correctionContext.ts")
    >("/src/core/decisions/correctionContext.ts");
    const states = cases.map((row) => {
      const context = projectContext(row.context, variant);
      return correctionState(
        cardBytes === undefined ? context : excerptCorrectionCard(context, cardBytes),
        budget,
      );
    });
    if (!live) {
      appendFileSync(
        reportFile,
        JSON.stringify({
          kind: "dry",
          fingerprint,
          fitting: states.filter(Boolean).length,
          omitted: states.filter((state) => state?.facts.context_missing_or_omitted).length,
          modelCalls: 0,
        }) + "\n",
      );
      console.log("Private inputs validated; no model calls made.");
      return;
    }
    const pool = poolSchema.parse(JSON.parse(readFileSync(privatePath(required("pool")), "utf8")));
    appendFileSync(
      reportFile,
      `${JSON.stringify({
        kind: "selection",
        poolFingerprint: createHash("sha256").update(JSON.stringify(pool)).digest("hex"),
        models: pool.models,
        flagshipProvider: pool.flagshipProvider,
      })}\n`,
    );
    const home = privatePath(required("home"));
    const accountsDir = resolve(required("accounts-dir"));
    // No startup warm, model discovery, account adoption, sign-in, or keychain read.
    // The vault alone maps an account to its Pi store; the Claude factory uses
    // the existing client sign-in just as the app's adapted question does.
    const { AccountVault } = await runner.import<typeof import("../src/core/pi/accountVault.ts")>(
      "/src/core/pi/accountVault.ts",
    );
    const vault = AccountVault.create({ accountsDir });
    const account = (provider: string) => {
      const rows = vault.list(provider).filter((row) => row.enabled && !row.cutOff);
      if (rows.length !== 1)
        throw new Error("Evaluation requires one available account per provider");
      return rows[0]?.id;
    };
    for (const model of pool.models) account(model.provider);
    const { hostEnv } =
      await runner.import<typeof import("../src/core/hostEnv.ts")>("/src/core/hostEnv.ts");
    const { createClaudeSessionFactory } = await runner.import<
      typeof import("../src/core/claude/session.ts")
    >("/src/core/claude/session.ts");
    const { defaultClaudeConfigDir } = await runner.import<
      typeof import("../src/core/claude/claudeQuota.ts")
    >("/src/core/claude/claudeQuota.ts");
    const { createPiSessionFactory } =
      await runner.import<typeof import("../src/core/pi/session.ts")>("/src/core/pi/session.ts");
    const { AdaptedDecisionModel, DecisionModels } = await runner.import<
      typeof import("../src/core/decisions/decisionModel.ts")
    >("/src/core/decisions/decisionModel.ts");
    const { DEFAULT_DECISIONS } = await runner.import<typeof import("../src/shared/decisions.ts")>(
      "/src/shared/decisions.ts",
    );
    let cutOff = false;
    const adapted = new AdaptedDecisionModel({
      homeDir: home,
      availableModels: () => pool.models,
      quotaModels: () => undefined,
      selectAccount: (_task, provider) => account(provider),
      flagshipAccountId: () =>
        pool.flagshipProvider ? (account(pool.flagshipProvider) ?? null) : null,
      runtimeFor: (id) => vault.runtimeFor(id),
      offering: () => "auto",
      sessions: {
        pi: createPiSessionFactory({ agentDir: resolve(home, "agent") }),
        claude: createClaudeSessionFactory({
          configDir: defaultClaudeConfigDir(),
          env: hostEnv,
          log: () => {},
        }),
      },
      noteCutOff: () => {
        cutOff = true;
      },
      prepareHome: async () => {
        mkdirSync(home, { recursive: true, mode: 0o700 });
      },
    });
    let usage: FmUsage[] = [];
    const decisions = new DecisionModels({
      settings: {
        // --live requires the operator's separately obtained evaluation
        // authorization. These settings exist only in the isolated runner,
        // never in the person's live app settings: the person's own models,
        // with reply checks at their default, on.
        getDecisions: () => DEFAULT_DECISIONS,
        setDecisions: () => {
          throw new Error("Evaluation does not change settings");
        },
        getDecisionUses: () => ({}),
        setDecisionUses: () => {
          throw new Error("Evaluation does not change settings");
        },
      },
      adapted,
      recordUsage: (event) => {
        usage.push(event.usage);
      },
    });
    const confusion: Record<string, number> = {};
    let calls = 0;
    for (const [index, row] of cases.entries()) {
      const state = states[index];
      usage = [];
      const started = performance.now();
      const result: DecisionAnswer | undefined = state
        ? (
            await decisions.decide(
              { purpose: "correction-evaluation", use: "reply-checks" },
              state,
              { correction: question },
              new AbortController().signal,
            )
          ).correction
        : undefined;
      if (state) calls++;
      const expected = labels.get(row.id)?.expected;
      const answer = result?.value ?? "unclear";
      const pair = `${expected}/${answer}`;
      confusion[pair] = (confusion[pair] ?? 0) + 1;
      // Intentionally omit detail, provider errors and raw answer prose.
      appendFileSync(
        reportFile,
        JSON.stringify({
          kind: "case",
          id: row.id,
          expected,
          answer,
          outcome: result?.outcome ?? "not-sent",
          reason: result?.reason ?? (state ? null : "context-budget"),
          source: result?.source ?? null,
          version: result?.version ?? question.version,
          elapsedMs: performance.now() - started,
          inputBytes: state ? Buffer.byteLength(JSON.stringify(state)) : null,
          usage,
        }) + "\n",
      );
      if (cutOff) throw new Error("Subscription access failed; evaluation stopped without retry");
    }
    appendFileSync(
      reportFile,
      JSON.stringify({ kind: "complete", fingerprint, calls, confusion }) + "\n",
    );
    console.log(`Evaluation completed: ${cases.length} cases; results kept privately.`);
  } finally {
    await runner.close();
  }
}

if (import.meta.main) {
  // Never print an exception: it could contain a private case or provider body.
  main().catch(() => {
    console.error(
      "Evaluation stopped. No automatic retry; inspect the private run's completion record.",
    );
    process.exitCode = 1;
  });
}
