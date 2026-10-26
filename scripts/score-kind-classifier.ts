/**
 * The S3 measurement harness (intelligence-bucket routing, design section 6
 * S3: "measured on one dogfood window ... tier distribution, classifier
 * abstain and failure rates, and agreement against a hand-labelled sample of
 * the C5 corpus").
 *
 * The corpus is the `spawn_crewmate` calls recorded in the captain's own
 * dogfood sessions - the same facts C5 extracts, read straight off the
 * replay fixtures so the measurement is reproducible from the repository
 * with no live database. The labels are the hand-labelled sample beside it
 * (`tests/fixtures/kind-classifier/labels.jsonl`), keyed by a hash of the
 * spawn's own words so a label can never drift onto another row.
 *
 * It reads transcripts, so it sits behind Observe's development gate exactly
 * like the corpus export and the replay harness. Unlike them it can REACH A PROVIDER:
 * scoring the classifier means running it, so a Pi-scored run requires
 * `--models`; Claude binds its client instead. `--dry` is the offline
 * shape of the same command.
 *
 *   pnpm score:kinds --dry
 *   pnpm score:kinds --models <models.json> --provider <p> --model <m> --out report.json
 *   pnpm score:kinds --provider anthropic-claude --model <m> --out report.json
 *
 * The last form scores the classifier on Claude (W1 S10): the session runs
 * the machine's own Claude client on its default login, exactly as the app
 * does, so it spends that login's allowance and needs no models.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  sessionFilesIn,
  readSession,
} from "../src/core/storage/sessionReader.ts";
import {
  type DevObserveGateInput,
  isDevObserveEnabled,
  OBSERVE_DISABLED_MESSAGE,
} from "../src/core/observe/gate.ts";
import type { DecisionsSettings } from "../src/shared/decisions.ts";
import { settingFrom } from "../src/shared/envSettings.ts";
import { CLAUDE_PROVIDER_ID } from "../src/shared/providers.ts";
import { detectPackaged } from "./export-corpus.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

const USAGE = `Usage: score-kind-classifier [options]

  --fixtures <dir>   replay fixture root (default tests/fixtures/replay)
  --cases <file>     labelled boundary JSONL instead of historical spawns
  --labels <file>    hand labels (default tests/fixtures/kind-classifier/labels.jsonl)
  --models <file>    a Pi models.json to bind a real model through
  --provider <id>    the provider in that models.json, or anthropic-claude to
                     run the machine's own Claude client on its default login
                     (no --models needed)
  --model <id>       the model id in that models.json, or the Claude model
  --api-key-env <N>  read the provider's key from this environment variable
                     (never write a key into models.json: it is set on the
                     runtime in memory and never touches disk or argv)
  --decision-model <id>
                     score a NATIVE decision model instead of the adapter
                     (S7b: \`jev\`). --models/--provider/--model are then the
                     fallback the service uses when it cannot answer.
  --out <file>       write the scored report as JSON
  --dry              print the corpus and its keys; call no model
  --help`;

type Spawn = {
  key: string;
  fixture: string;
  title: string;
  goal: string;
  userWords: string;
  constraints?: string;
  provenance?: { kind: "task-excerpt" | "synthetic"; source: string };
  /** A boundary case's hand lane: quick (read from what is here) or deep (INF-1430). */
  lane?: "quick" | "deep";
};

type Label = { key: string; kind: string; note?: string };

type Scored = Spawn & {
  label?: string;
  /** The tier the hand label would have routed to, for the cost comparison. */
  labelTier?: string;
  kind: string;
  source: string;
  tier: string;
  rule: string;
  version?: string;
};

/** Weakest first: the order the two routing-cost directions are read in. */
const LADDER = ["low", "medium", "high", "premium"];

/**
 * What a recorded spawn delivers, read the way the host reads it: a
 * `read-only` constraint makes it an answer (`deliverableFor`), so the
 * classifier is offered that branch's kinds as the app would offer them.
 */
export function deliverableOf(constraints: string | undefined): "answer" | "change" {
  return (constraints ?? "")
    .split(";")
    .map((item) => item.trim())
    .some((item) => item === "read-only" || item.startsWith("read-only:"))
    ? "answer"
    : "change";
}

/** The spawn's identity: its own words, so a label cannot drift onto another row. */
function keyOf(title: string, goal: string, userWords: string): string {
  return createHash("sha256").update(`${title}\n${goal}\n${userWords}`).digest("hex").slice(0, 12);
}

/**
 * Every `spawn_crewmate` the recorded Firstmate sessions made, in order,
 * deduplicated by its words: a retried spawn of the same work is one piece
 * of work to classify, not two.
 */
export function readSpawnCorpus(fixturesDir: string): Spawn[] {
  const spawns: Spawn[] = [];
  const seen = new Set<string>();
  // Only the `-real` fixtures: they are the hand-scrub-reviewed exports of
  // the captain's own evenings (`tests/fixtures/replay/README.md`). The
  // others are reconstructions built to exercise the F1-F9 mode tests, and
  // measuring a classifier against invented work would be measuring nothing.
  const fixtures = existsSync(fixturesDir)
    ? readdirSync(fixturesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith("-real"))
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const fixture of fixtures) {
    // Both seats' sessions, through the one session reader: a
    // Claude-served session's spawns arrive as the Pi dialect's tool calls.
    const files = ["sessions", "claude"].flatMap((dir) =>
      sessionFilesIn(join(fixturesDir, fixture, "firstmate", dir)),
    );
    for (const file of files) {
      for (const entry of readSession(file).entries) {
        for (const call of spawnCallsIn(entry)) {
          const title = String(call.title ?? "").trim();
          const goal = String(call.goal ?? "").trim();
          const userWords = String(call.user_words ?? "").trim();
          if (!goal || !userWords) continue;
          const key = keyOf(title, goal, userWords);
          if (seen.has(key)) continue;
          seen.add(key);
          const constraints = renderConstraints(call.constraints);
          spawns.push({
            key,
            fixture,
            title,
            goal,
            userWords,
            ...(constraints ? { constraints } : {}),
          });
        }
      }
    }
  }
  return spawns;
}

/** Explicit boundary examples, never passed off as recorded model turns. */
const boundaryCaseSchema = z.object({
  title: z.string().min(1), goal: z.string().min(1), userWords: z.string().min(1),
  constraints: z.string().optional(), expectedKind: z.string().min(1),
  lane: z.enum(["quick", "deep"]).optional(),
  provenance: z.object({ kind: z.enum(["task-excerpt", "synthetic"]), source: z.string().min(1) }),
}).strict();

export function readBoundaryCorpus(file: string): { spawns: Spawn[]; labels: Map<string, Label> } {
  const spawns: Spawn[] = [];
  const labels = new Map<string, Label>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("//")) continue;
    const { expectedKind, ...input } = boundaryCaseSchema.parse(JSON.parse(line));
    const key = keyOf(input.title, input.goal, input.userWords);
    if (labels.has(key)) throw new Error(`Duplicate boundary case ${key}`);
    spawns.push({ ...input, key, fixture: input.provenance.source });
    labels.set(key, { key, kind: expectedKind });
  }
  return { spawns, labels };
}

function spawnCallsIn(entry: unknown): Record<string, unknown>[] {
  const message = (entry as { message?: { role?: string; content?: unknown[] } } | null)?.message;
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Record<string, unknown>[] = [];
  for (const part of message.content) {
    const typed = part as { type?: string; name?: string; arguments?: unknown };
    if (typed.type !== "toolCall" || typed.name !== "spawn_crewmate") continue;
    if (typed.arguments && typeof typed.arguments === "object") {
      calls.push(typed.arguments as Record<string, unknown>);
    }
  }
  return calls;
}

function renderConstraints(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .map((item) => {
      const typed = item as { kind?: string; text?: string };
      return typed.text ? `${typed.kind}: ${typed.text}` : (typed.kind ?? "");
    })
    .filter(Boolean)
    .join("; ");
}

export function readLabels(file: string): Map<string, Label> {
  if (!existsSync(file)) return new Map();
  const labels = new Map<string, Label>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("//")) continue;
    const label = JSON.parse(line) as Label;
    labels.set(label.key, label);
  }
  return labels;
}

/** The report's numbers, all of them shares of the same corpus. */
export function score(rows: Scored[]): Record<string, unknown> {
  const n = rows.length;
  const share = (count: number) => (n === 0 ? 0 : Number((count / n).toFixed(3)));
  const tally = (values: string[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  };
  const labelled = rows.filter((row) => row.label);
  const agreed = labelled.filter((row) => row.kind === row.label);
  // What the disagreement COSTS. A kind that disagrees but routes to the
  // same tier changed nothing, and the two directions are not symmetric:
  // routing a cheap piece of work high wastes quota, while routing an
  // expensive one low is the failure the captain would actually feel.
  const tierAgreed = labelled.filter((row) => row.tier === row.labelTier);
  const under = labelled.filter(
    (row) => LADDER.indexOf(row.tier) < LADDER.indexOf(row.labelTier ?? row.tier),
  );
  const over = labelled.filter(
    (row) => LADDER.indexOf(row.tier) > LADDER.indexOf(row.labelTier ?? row.tier),
  );
  return {
    spawns: n,
    kinds: tally(rows.map((row) => row.kind)),
    tiers: tally(rows.map((row) => row.tier)),
    rules: tally(rows.map((row) => row.rule)),
    abstain_rate: share(rows.filter((row) => row.source.startsWith("classifier-abstained")).length),
    failure_rate: share(rows.filter((row) => row.source.startsWith("classifier-failed")).length),
    failures: tally(
      rows
        .filter((row) => row.source.startsWith("classifier-failed"))
        .map((row) => row.source.slice("classifier-failed:".length)),
    ),
    labelled: labelled.length,
    agreement:
      labelled.length === 0 ? null : Number((agreed.length / labelled.length).toFixed(3)),
    tier_agreement:
      labelled.length === 0 ? null : Number((tierAgreed.length / labelled.length).toFixed(3)),
    under_routed: under.length,
    over_routed: over.length,
    label_tiers: tally(labelled.map((row) => row.labelTier ?? "?")),
    // The fast lane's bar reads these: how many quick and deep cases went
    // to each tier (INF-1430 piece 1).
    ...(rows.some((row) => row.lane)
      ? {
          lanes: Object.fromEntries(
            (["quick", "deep"] as const).map((lane) => [
              lane,
              tally(rows.filter((row) => row.lane === lane).map((row) => row.tier)),
            ]),
          ),
        }
      : {}),
    disagreements: labelled
      .filter((row) => row.kind !== row.label)
      .map((row) => ({ key: row.key, title: row.title, label: row.label, kind: row.kind })),
  };
}

type Args = {
  fixtures: string;
  cases?: string;
  labels: string;
  models?: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  out?: string;
  dry: boolean;
  help: boolean;
  /** A native decision model to score instead of the adapter (S7b). */
  decisionModel?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fixtures: join(REPO_ROOT, "tests", "fixtures", "replay"),
    labels: join(REPO_ROOT, "tests", "fixtures", "kind-classifier", "labels.jsonl"),
    dry: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--cases":
      case "--fixtures":
      case "--labels":
      case "--models":
      case "--provider":
      case "--model":
      case "--api-key-env":
      case "--decision-model":
      case "--out": {
        if (!value) throw new Error(`${flag} needs a value`);
        if (flag === "--provider") args.provider = value;
        else if (flag === "--decision-model") args.decisionModel = value;
        else if (flag === "--model") args.model = value;
        else if (flag === "--api-key-env") args.apiKeyEnv = value;
        else if (flag === "--cases") args.cases = resolve(value);
        else if (flag === "--fixtures") args.fixtures = resolve(value);
        else if (flag === "--labels") args.labels = resolve(value);
        else if (flag === "--models") args.models = resolve(value);
        else args.out = resolve(value);
        index += 1;
        break;
      }
      case "--dry":
        args.dry = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const gate: DevObserveGateInput = {
    isPackaged: detectPackaged({ moduleUrl: import.meta.url, env: process.env }),
    env: process.env,
  };
  // Checked before any transcript is read, exactly like the corpus export.
  if (!isDevObserveEnabled(gate)) {
    process.stderr.write(`${OBSERVE_DISABLED_MESSAGE}: the scorer reads recorded sessions.\n`);
    return 3;
  }
  const boundary = args.cases ? readBoundaryCorpus(args.cases) : undefined;
  const corpus = boundary?.spawns ?? readSpawnCorpus(args.fixtures);
  if (corpus.length === 0) {
    process.stderr.write(`No recorded spawns under ${args.fixtures}.\n`);
    return 1;
  }
  const labels = boundary?.labels ?? readLabels(args.labels);
  if (args.dry) {
    for (const spawn of corpus) {
      const label = labels.get(spawn.key)?.kind ?? "-";
      process.stdout.write(
        `${spawn.key}  ${label.padEnd(10)}  ${deliverableOf(spawn.constraints).padEnd(6)}  ${(spawn.lane ?? "-").padEnd(5)}  ${spawn.title}\n`,
      );
    }
    process.stdout.write(`\n${corpus.length} spawn(s), ${labels.size} label(s)\n`);
    return 0;
  }
  const claude = args.provider === CLAUDE_PROVIDER_ID;
  if (!args.provider || !args.model || (!claude && !args.models)) {
    process.stderr.write(
      `A scored run needs --provider and --model, and --models unless the provider is ${CLAUDE_PROVIDER_ID}.\n`,
    );
    return 2;
  }

  const runner = await openModuleRunner();
  const rows: Scored[] = [];
  let instruction: unknown;
  try {
    const { DecisionKindClassifier, CLASSIFY_TIMEOUT_MS, KIND_QUESTIONS } = await runner.import<
      typeof import("../src/core/routing/decisionKindClassifier.ts")
    >("/src/core/routing/decisionKindClassifier.ts");
    instruction = KIND_QUESTIONS;
    const { workKindSchema } = await runner.import<typeof import("../src/shared/routingPolicy.ts")>("/src/shared/routingPolicy.ts");
    for (const label of labels.values()) workKindSchema.parse(label.kind);
    const { AdaptedDecisionModel, DecisionModels } = await runner.import<
      typeof import("../src/core/decisions/decisionModel.ts")
    >("/src/core/decisions/decisionModel.ts");
    const { DECISION_STATE_VERSION, DEFAULT_DECISIONS } = await runner.import<
      typeof import("../src/shared/decisions.ts")
    >("/src/shared/decisions.ts");
    const { resolveKind } = await runner.import<
      typeof import("../src/core/routing/kindClassifier.ts")
    >("/src/core/routing/kindClassifier.ts");
    const { tierFor } = await runner.import<typeof import("../src/core/routing/policy.ts")>(
      "/src/core/routing/policy.ts",
    );
    const home = join(REPO_ROOT, "node_modules", ".cache", "infinitary-kind-scorer");
    mkdirSync(home, { recursive: true });
    // Claude binds to its client, not a Pi runtime. Loading the unused Pi
    // SDK and probing its catalog/auth stores dominated the cold scorer's
    // startup and could exhaust the boxed integration's measured budget.
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
      if (args.apiKeyEnv) {
        const key = process.env[args.apiKeyEnv];
        if (!key) throw new Error(`${args.apiKeyEnv} is not set in the environment.`);
        // In memory only: the key never reaches models.json, argv or a log.
        await baseRuntime.setRuntimeApiKey(args.provider as string, key);
      }
    }
    const model = { provider: args.provider, id: args.model };
    const { createClaudeSessionFactory } = await runner.import<
      typeof import("../src/core/claude/session.ts")
    >("/src/core/claude/session.ts");
    const { defaultClaudeConfigDir } = await runner.import<
      typeof import("../src/core/claude/claudeQuota.ts")
    >("/src/core/claude/claudeQuota.ts");
    const adapted = new AdaptedDecisionModel({
      homeDir: home,
      availableModels: () => [{ ...model, slot: "low" as const }],
      quotaModels: () => undefined,
      // No vault here. A Pi candidate falls through to the base runtime,
      // which is the one model this run was pointed at; a Claude one binds
      // the machine's default login, which is its one account.
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
    // Scoring a native decision model (S7b) is the same corpus, the same
    // labels and the same tier table - only the answerer moves. Its key is
    // read from the environment for this offline run and never written
    // anywhere; the app itself reads only the user's own stored key.
    const native = args.decisionModel;
    if (native && native !== "jev") {
      throw new Error(`Unknown decision model ${native}`);
    }
    const nativeKey = native ? process.env.TYPESAFE_API_KEY : undefined;
    if (native && !nativeKey) {
      throw new Error("TYPESAFE_API_KEY is not set in the environment.");
    }
    const { JevDecisionModel } = await runner.import<
      typeof import("../src/core/decisions/jev/jevClient.ts")
    >("/src/core/decisions/jev/jevClient.ts");
    const settings: DecisionsSettings = native
      ? {
          version: 1,
          answerer: { kind: "native", id: "jev" },
          egress: { jev: { enabled: true, consentedVersion: DECISION_STATE_VERSION } },
        }
      : DEFAULT_DECISIONS;
    const classifier = new DecisionKindClassifier(
      new DecisionModels({
        settings: { getDecisions: () => settings, setDecisions: () => {} },
        adapted,
        ...(native && nativeKey
          ? {
              keys: {
                has: () => true,
                read: () => nativeKey,
                set: () => {},
                remove: () => {},
              },
              createNative: (row) =>
                new JevDecisionModel({
                  row,
                  key: () => nativeKey,
                  // Same dev-only override the app honours, so this harness
                  // can be smoke-tested against a stub without spending.
                  ...(settingFrom(process.env, "JEV_URL")?.trim()
                    ? { endpoint: settingFrom(process.env, "JEV_URL")?.trim() }
                    : {}),
                }),
            }
          : {}),
      }),
    );
    for (const spawn of corpus) {
      const verdict = await classifier.classify(
        {
          taskId: spawn.key,
          title: spawn.title,
          goal: spawn.goal,
          userWords: spawn.userWords,
          deliverable: deliverableOf(spawn.constraints),
          ...(spawn.constraints ? { constraints: spawn.constraints } : {}),
        },
        AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      );
      const shape = { kind: resolveKind(verdict), kind_source: verdict.source };
      const decision = tierFor(shape);
      const label = labels.get(spawn.key)?.kind;
      const row: Scored = {
        ...spawn,
        ...(label
          ? {
              label,
              labelTier:
                tierFor({ kind: label as typeof shape.kind, kind_source: "hand-label" }).bucket ??
                "pin",
            }
          : {}),
        version: verdict.version,
        kind: shape.kind,
        source: verdict.source,
        tier: decision.bucket ?? "pin",
        rule: decision.rule,
      };
      rows.push(row);
      process.stderr.write(
        `${row.kind.padEnd(10)} ${row.tier.padEnd(7)} ${row.label ? `(labelled ${row.label}) ` : ""}${row.title}\n`,
      );
    }
  } finally {
    await runner.close();
  }

  const report = {
    at: new Date().toISOString(),
    model: args.decisionModel
      ? `${args.decisionModel} (fallback ${args.provider}/${args.model})`
      : `${args.provider}/${args.model}`,
    fixtures: args.cases ?? args.fixtures,
    instruction,
    scores: score(rows),
    rows,
  };
  process.stdout.write(`${JSON.stringify(report.scores, null, 2)}\n`);
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
