/**
 * Scores the reviewer question (`src/core/orchestrator/reviewerChoice.ts`)
 * offline against labelled cases: a builder's task, the standing directions
 * that apply to it, the usual pick and the models placed where the review
 * would run, with the answer those directions call for (docs/delivery-rigor.md,
 * "Which model reviews").
 *
 * The question and the facts are built by the app's own functions, and the
 * answer comes through the app's own decision service, so a score here is a
 * score of what the app sends. Cases hold a person's own tasks and
 * directions: they stay outside the project, and the scorer sits behind
 * Observe's development gate like the other offline tools.
 *
 *   pnpm score:reviewers --cases <cases.jsonl> --provider anthropic-claude --model <m>
 *   TYPESAFE_API_KEY=... pnpm score:reviewers --cases <cases.jsonl> --decision-model jev \
 *     --provider anthropic-claude --model <m>
 *
 * Each case is one JSON line: `{ id, input, expected, split?, scenario? }`,
 * where `input` is a `ReviewerChoiceInput` and `expected` is
 * `{ mode: "prefer" | "wait", key }` or null where no direction decides,
 * which `usual` or the abstention `unsure` both answer, since the usual pick
 * then reviews either way. `accept` lists other answers in the same shape the
 * case's directions fit as well. With `--decision-model jev` the key is read
 * from `TYPESAFE_API_KEY` for this run only; `--provider`/`--model` answer
 * when Jev cannot, as in the app. Jev is asked with no threshold, so each
 * row keeps the option it leaned to and its confidence, and the scorer
 * applies the catalog's threshold.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDevObserveEnabled, OBSERVE_DISABLED_MESSAGE } from "../src/core/observe/gate.ts";
import type { ReviewerChoiceInput } from "../src/core/orchestrator/reviewerChoice.ts";
import type { DecisionsSettings } from "../src/shared/decisions.ts";
import { settingFrom } from "../src/shared/envSettings.ts";
import { CLAUDE_PROVIDER_ID } from "../src/shared/providers.ts";
import { detectPackaged } from "./export-corpus.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

const USAGE = `Usage: score-reviewer-choice --cases <file> [options]

  --cases <file>        labelled cases, one JSON object per line
  --split <name>        score only cases with this split
  --scenario <prefix>   score only cases whose scenario starts with this
  --limit <n>           score only the first n cases
  --provider <id>       anthropic-claude, or a provider in --models
  --model <id>          the model answering (the fallback with --decision-model)
  --models <file>       a Pi models.json, for a provider other than Claude
  --decision-model jev  score Jev, reading TYPESAFE_API_KEY for this run only
  --concurrency <n>     questions asked at once (default 4)
  --out <file>          write the report as JSON
  --help`;

type Expected = { mode: "prefer" | "wait"; key: string } | null;
type Case = {
  id: string;
  input: ReviewerChoiceInput;
  expected: Expected;
  accept?: Expected[];
  split?: string;
  scenario?: string;
};

type Args = {
  cases?: string;
  split?: string;
  scenario?: string;
  limit?: number;
  provider?: string;
  model?: string;
  models?: string;
  decisionModel?: string;
  concurrency: number;
  out?: string;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { concurrency: 4, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === "--cases") args.cases = resolve(value);
    else if (flag === "--split") args.split = value;
    else if (flag === "--scenario") args.scenario = value;
    else if (flag === "--limit") args.limit = Number(value);
    else if (flag === "--provider") args.provider = value;
    else if (flag === "--model") args.model = value;
    else if (flag === "--models") args.models = resolve(value);
    else if (flag === "--decision-model") args.decisionModel = value;
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number(value));
    else if (flag === "--out") args.out = resolve(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  return args;
}

function readCases(file: string): Case[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("//"))
    .map((line) => JSON.parse(line) as Case);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help || !args.cases) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 2;
  }
  if (
    !isDevObserveEnabled({
      isPackaged: detectPackaged({ moduleUrl: import.meta.url, env: process.env }),
      env: process.env,
    })
  ) {
    process.stderr.write(`${OBSERVE_DISABLED_MESSAGE}: the scorer reads a person's own tasks.\n`);
    return 3;
  }
  const claude = args.provider === CLAUDE_PROVIDER_ID;
  if (!args.provider || !args.model || (!claude && !args.models)) {
    process.stderr.write(
      `A scored run needs --provider and --model, and --models unless the provider is ${CLAUDE_PROVIDER_ID}.\n`,
    );
    return 2;
  }
  if (args.decisionModel && args.decisionModel !== "jev") {
    process.stderr.write(`Unknown decision model ${args.decisionModel}\n`);
    return 2;
  }
  const nativeKey = args.decisionModel ? process.env.TYPESAFE_API_KEY : undefined;
  if (args.decisionModel && !nativeKey) {
    process.stderr.write("TYPESAFE_API_KEY is not set in the environment.\n");
    return 2;
  }
  let cases = readCases(args.cases).filter(
    (each) =>
      (!args.split || each.split === args.split) &&
      (!args.scenario || (each.scenario ?? "").startsWith(args.scenario)),
  );
  if (args.limit) cases = cases.slice(0, args.limit);

  const runner = await openModuleRunner();
  const rows: Record<string, unknown>[] = [];
  let questionVersion = "";
  try {
    const choice = await runner.import<
      typeof import("../src/core/orchestrator/reviewerChoice.ts")
    >("/src/core/orchestrator/reviewerChoice.ts");
    questionVersion = choice.REVIEWER_QUESTION_VERSION;
    const { AdaptedDecisionModel, DecisionModels } = await runner.import<
      typeof import("../src/core/decisions/decisionModel.ts")
    >("/src/core/decisions/decisionModel.ts");
    const { DEFAULT_DECISIONS } = await runner.import<typeof import("../src/shared/decisions.ts")>(
      "/src/shared/decisions.ts",
    );
    const { DECISION_APPROVAL_VERSION } = await runner.import<
      typeof import("../src/shared/decisionUses.ts")
    >("/src/shared/decisionUses.ts");
    const home = join(REPO_ROOT, "node_modules", ".cache", "infinitary-reviewer-scorer");
    mkdirSync(home, { recursive: true });
    let baseRuntime: import("../src/core/pi/types.ts").ModelRuntime | undefined;
    let pi: import("../src/core/session/session.ts").SessionFactory | undefined;
    if (!claude) {
      const { createModelRuntime } = await runner.import<
        typeof import("../src/core/pi/modelRuntime.ts")
      >("/src/core/pi/modelRuntime.ts");
      const { createPiSessionFactory } = await runner.import<
        typeof import("../src/core/pi/session.ts")
      >("/src/core/pi/session.ts");
      baseRuntime = await createModelRuntime({
        authPath: join(home, "auth.json"),
        modelsPath: args.models as string,
      });
      pi = createPiSessionFactory({ agentDir: join(home, "agent") });
    }
    const { createClaudeSessionFactory } = await runner.import<
      typeof import("../src/core/claude/session.ts")
    >("/src/core/claude/session.ts");
    const { defaultClaudeConfigDir } = await runner.import<
      typeof import("../src/core/claude/claudeQuota.ts")
    >("/src/core/claude/claudeQuota.ts");
    const model = { provider: args.provider, id: args.model };
    const adapted = new AdaptedDecisionModel({
      homeDir: home,
      availableModels: () => [{ ...model, slot: "low" as const }],
      quotaModels: () => undefined,
      selectAccount: () => (claude ? "claude" : undefined),
      flagshipAccountId: () => null,
      runtimeFor: async () => {
        if (!baseRuntime) throw new Error("No Pi runtime on a Claude binding.");
        return baseRuntime;
      },
      baseRuntime,
      sessions: {
        ...(pi ? { pi } : {}),
        claude: createClaudeSessionFactory({
          configDir: defaultClaudeConfigDir(),
          env: () => process.env,
        }),
      },
    });
    const { JevDecisionModel } = await runner.import<
      typeof import("../src/core/decisions/jev/jevClient.ts")
    >("/src/core/decisions/jev/jevClient.ts");
    let threshold: number | undefined;
    const settings: DecisionsSettings = nativeKey
      ? {
          version: 1,
          answerer: { kind: "native", id: "jev" },
          egress: { jev: { enabled: true, consentedVersion: DECISION_APPROVAL_VERSION } },
        }
      : DEFAULT_DECISIONS;
    const models = new DecisionModels({
      settings: {
        getDecisions: () => settings,
        setDecisions: () => {},
        getDecisionUses: () => ({}),
        setDecisionUses: () => {},
      },
      adapted,
      ...(nativeKey
        ? {
            keys: { has: () => true, read: () => nativeKey, set: () => {}, remove: () => {} },
            createNative: (row) => {
              threshold = row.abstainBelow;
              return new JevDecisionModel({
                // No threshold here: the scorer applies the catalog's below.
                row: { ...row, abstainBelow: 0 } as unknown as typeof row,
                key: () => nativeKey,
                ...(settingFrom(process.env, "JEV_URL")?.trim()
                  ? { endpoint: settingFrom(process.env, "JEV_URL")?.trim() }
                  : {}),
              });
            },
          }
        : {}),
    });
    let next = 0;
    const work = async () => {
      while (next < cases.length) {
        const each = cases[next++] as Case;
        const listed = each.input.models;
        // A pick as words: "prefer <key>", "wait <key>" or usual.
        const placed = (want: Expected) => (want ? `${want.mode} ${want.key}` : "usual");
        const fits = [each.expected, ...(each.accept ?? [])].map(placed);
        const questions = choice.reviewerChoiceQuestions(listed);
        // The app asks nothing where no direction applies (`askReviewerChoice`).
        const answers = each.input.directions.length
          ? await models.decide(
              { purpose: "reviewer-score", use: "reviewer", taskId: each.id },
              choice.reviewerChoiceState(each.input),
              questions,
              AbortSignal.timeout(20_000),
            )
          : {};
        const confidence = (answer: { detail?: string } | undefined) =>
          Number(/p=([0-9.]+)/.exec(answer?.detail ?? "")?.[1] ?? Number.NaN);
        // Jev was asked with no threshold: the catalog's applies here.
        const held = Object.fromEntries(
          Object.entries(answers).map(([id, answer]) => [
            id,
            threshold !== undefined && answer.outcome === "answered" && confidence(answer) < threshold
              ? { ...answer, value: questions[id]?.abstain ?? "unsure", outcome: "abstained" as const }
              : answer,
          ]),
        );
        const pickOf = (from: typeof answers) => {
          const pick = choice.readReviewerPick(listed, from);
          // A preference for a model that cannot review now is passed over
          // at routing, so the usual pick reviews: it scores as usual.
          if (!pick || (pick.mode === "prefer" && pick.why)) return "usual";
          return `${pick.mode} ${pick.key}`;
        };
        const value = pickOf(held);
        const leaned = threshold !== undefined ? pickOf(answers) : undefined;
        const row = {
          id: each.id,
          split: each.split,
          scenario: each.scenario,
          delivers: each.input.builder.delivers,
          title: each.input.builder.title,
          expected: fits[0],
          ...(each.accept ? { accept: fits.slice(1) } : {}),
          value,
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, answer]) => [
              id,
              { value: answer.value, outcome: held[id]?.outcome, reason: answer.reason, detail: answer.detail },
            ]),
          ),
          source: answers.reviewer?.source,
          ...(leaned !== undefined ? { leaned } : {}),
          correct: fits.includes(value),
        };
        rows.push(row);
        process.stderr.write(
          `${row.correct ? "ok  " : "MISS"} ${String(row.scenario).padEnd(18)} ${value.padEnd(34)} want ${String(fits[0]).padEnd(34)} ${row.title}\n`,
        );
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, work));
  } finally {
    await runner.close();
  }
  const share = (part: number, whole: number) =>
    whole ? Number((part / whole).toFixed(3)) : null;
  const by = (key: string) => {
    const groups: Record<string, { n: number; correct: number; accuracy: number | null }> = {};
    for (const row of rows) {
      const name = String(row[key]);
      const group = groups[name] ?? { n: 0, correct: 0, accuracy: null };
      group.n += 1;
      if (row.correct) group.correct += 1;
      groups[name] = group;
    }
    for (const group of Object.values(groups)) group.accuracy = share(group.correct, group.n);
    return groups;
  };
  const scores = {
    cases: rows.length,
    accuracy: share(rows.filter((row) => row.correct).length, rows.length),
    ...(rows.some((row) => "leaned" in row)
      ? {
          leaned: share(
            rows.filter(
              (row) =>
                row.leaned !== undefined &&
                [row.expected, ...((row.accept as string[]) ?? [])].includes(row.leaned as string),
            ).length,
            rows.length,
          ),
        }
      : {}),
    failed: rows.filter((row) =>
      Object.values(row.answers as Record<string, { outcome?: string }>).some(
        (answer) => answer.outcome === "failed",
      ),
    ).length,
    failures: [
      ...new Set(
        rows.flatMap((row) =>
          Object.values(row.answers as Record<string, { reason?: string }>).flatMap((answer) =>
            answer.reason ? [answer.reason] : [],
          ),
        ),
      ),
    ],
    by_scenario: by("scenario"),
    by_delivers: by("delivers"),
    by_expected: by("expected"),
  };
  const report = {
    at: new Date().toISOString(),
    question: questionVersion,
    model: args.decisionModel
      ? `${args.decisionModel} (fallback ${args.provider}/${args.model})`
      : `${args.provider}/${args.model}`,
    scores,
    rows,
  };
  process.stdout.write(`${JSON.stringify(scores, null, 2)}\n`);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`wrote ${args.out}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
