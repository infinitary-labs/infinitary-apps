/**
 * WI-19 - the captain-session replay harness (interaction-system program P3;
 * plan `fm3000-interaction-sys-improve-s1/implementation-plan.md` section 3,
 * `docs/replay-harness.md`).
 *
 * Replays recorded captain sessions - the Firstmate's rolling transcript,
 * the crewmate sessions it drove, and the tables - against
 * the current prompt wiring, card lint, tools and supervision
 * (`scripts/replay/engine.ts`), scores the section-4 metrics
 * (`scripts/interaction-metrics.ts`), and writes one JSON report that records
 * the commit it ran at (D7: the running app is a long-lived dev build, so the
 * report, not the app, ties evidence to code). With `--baseline` it is the
 * CI gate: any metric that moved in its bad direction fails the run.
 *
 * It reads transcripts, so it sits behind Observe's gate exactly like the
 * corpus export (`isDevObserveEnabled` over `detectPackaged`): unpackaged, or
 * an explicit INFINITARY_DEV_OBSERVE=1. Offline: nothing reaches a provider or
 * the network, and nothing is written into the recording.
 *
 * Run it (Node 24 strips the types; the engine loads through Vite):
 *   pnpm replay:gate
 *   pnpm replay:captain --user-data /path/to/exported/userData --out report.json
 *   pnpm replay:captain --sessions <dir> --db firstmate.db --out report.json
 *   pnpm replay:captain --user-data <export> --from <iso> --to <iso> --out report.json
 *   pnpm replay:captain --user-data <export> --from <iso> --to <iso> --export-fixture tests/fixtures/replay/<name>
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingFrom } from "../src/shared/envSettings.ts";
import {
  type DevObserveGateInput,
  isDevObserveEnabled,
  OBSERVE_DISABLED_MESSAGE,
} from "../src/core/observe/gate.ts";
import {
  sessionDialectAt,
  sessionFilesIn,
  sidecarPathOf,
} from "../src/core/storage/sessionReader.ts";
import { detectPackaged } from "./export-corpus.ts";
import { defaultUserDataDir } from "./dispatch-corpus/userData.ts";
import {
  type BaselineScores,
  baselineFrom,
  compareToBaseline,
  formatValue,
  METRICS,
  type MetricDirection,
  type MetricScores,
  meetsTarget,
  type Regression,
} from "./interaction-metrics.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { RECORDED_TABLE_NAMES, readRecordedTables, scrubRecording } from "./recorded-tables.ts";
import type { ReplaySources, SessionReport } from "./replay/engine.ts";
import {
  hasMessageInWindow,
  parseWindowBound,
  type ReplayWindow,
  readWindowedJsonl,
  windowOf,
  windowTables,
} from "./replay/window.ts";

const ENGINE_PATH = join(REPO_ROOT, "scripts", "replay", "engine.ts");

// --------------------------------------------------------------------------
// Sources: a userData-shaped directory, or explicit paths
// --------------------------------------------------------------------------

export type SourceInput = {
  name: string;
  /** userData (or an exported / fixture copy shaped like it). */
  root?: string;
  sessionsDir?: string;
  /** The Claude-served Firstmate sessions (W1 S11); default `<root>/firstmate/claude`. */
  claudeSessionsDir?: string;
  crewmatesDir?: string;
  /** Pre-S7c archives to preserve in --export-fixture only; never replayed. */
  supervisionDir?: string;
  dbPath?: string;
  /** Trim the recording to one stretch of time (`--from` / `--to`). */
  window?: ReplayWindow | null;
  /** The hand-scored plain-language labels; the committed sample by default. */
  plainLabels?: string | null;
  /** The hand-labelled captain choices (the plan-to-build handoff); the committed file by default. */
  approvalLabels?: string | null;
};

/** The committed hand-scored sample (roadmap 1.5, `docs/replay-harness.md`). */
export const PLAIN_LABELS_PATH = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "plain-language",
  "labels.jsonl",
);

/** The committed hand-labelled captain choices (the plan-to-build handoff, `docs/replay-harness.md`). */
export const APPROVAL_LABELS_PATH = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "approval-labels",
  "labels.jsonl",
);

function jsonlIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile())
    .sort();
}

/**
 * The layout the app writes: `firstmate/sessions` (and `firstmate/claude`,
 * the Claude-served seat's sessions), `crewmates/<task>/sessions` (a Pi
 * crewmate's session files, or a Claude one's copies beside their sidecars),
 * and `firstmate.db` - or `tables.json`, the scrubbed dump a committed fixture
 * carries instead of a binary database. Retired pre-S7c `supervision/sessions`
 * archives are discovered only for preservation by exportFixture. With a
 * window, only the sessions - the crewmates' and the Firstmate's own - that
 * said something inside it are sources.
 */
export function discoverSources(input: SourceInput): ReplaySources {
  const root = input.root;
  const window = input.window ?? null;
  const sessionsDir = input.sessionsDir ?? (root ? join(root, "firstmate", "sessions") : "");
  const claudeSessionsDir =
    input.claudeSessionsDir ?? (root ? join(root, "firstmate", "claude") : "");
  const crewmatesDir = input.crewmatesDir ?? (root ? join(root, "crewmates") : "");
  const supervisionDir =
    input.supervisionDir ?? (root ? join(root, "supervision", "sessions") : "");
  const crewmateFiles: Record<string, string[]> = {};
  if (crewmatesDir && existsSync(crewmatesDir)) {
    for (const alias of readdirSync(crewmatesDir).sort()) {
      const files = sessionFilesIn(join(crewmatesDir, alias, "sessions"));
      if (files.length === 0) continue;
      if (window && !hasMessageInWindow(files, window)) continue;
      crewmateFiles[alias] = files;
    }
  }
  const dbCandidates = [
    input.dbPath,
    root ? join(root, "firstmate.db") : undefined,
    root ? join(root, "tables.json") : undefined,
  ];
  const tablesPath = dbCandidates.find((path): path is string => Boolean(path && existsSync(path)));
  // Both seats' sessions, each read through the one session reader; with a
  // window, only those that said something inside it, as with the crew.
  const orchestratorFiles = [
    ...sessionFilesIn(sessionsDir),
    ...sessionFilesIn(claudeSessionsDir),
  ].filter((file) => !window || hasMessageInWindow([file], window));
  return {
    name: input.name,
    orchestratorFiles,
    crewmateFiles,
    supervisionFiles: supervisionDir ? jsonlIn(supervisionDir) : [],
    tablesPath: tablesPath ?? null,
    ...(window ? { window } : {}),
    plainLabels: input.plainLabels === undefined ? PLAIN_LABELS_PATH : input.plainLabels,
    approvalLabels:
      input.approvalLabels === undefined ? APPROVAL_LABELS_PATH : input.approvalLabels,
  };
}

/** Every subdirectory of a fixtures root that holds a recording is one session. */
export function discoverFixtures(dir: string): ReplaySources[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory())
    .map((path) => discoverSources({ name: basename(path), root: path }))
    .filter(hasRecording);
}

export function hasRecording(sources: ReplaySources): boolean {
  return sources.orchestratorFiles.length > 0 || Object.keys(sources.crewmateFiles).length > 0;
}

/**
 * Copy a recording into a fixture directory, scrubbed: every JSONL line and
 * every table row through `scrubRecording`. Review the result before
 * committing it - redaction catches secrets by shape, not by meaning. A
 * window trims what is written by the replay's own rule (`replay/window.ts`),
 * so the fixture replays exactly as the windowed recording does.
 */
export function exportFixture(sources: ReplaySources, outDir: string): string[] {
  const written: string[] = [];
  const window = sources.window ?? null;
  const copy = (file: string, target: string) => {
    mkdirSync(dirname(target), { recursive: true });
    const lines = readWindowedJsonl(file, window)
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.stringify(scrubRecording(JSON.parse(line)))];
        } catch {
          return [];
        }
      });
    writeFileSync(target, `${lines.join("\n")}\n`);
    written.push(target);
  };
  // A Claude-served session keeps its own dialect and its served sidecar.
  const copySession = (file: string, target: string) => {
    copy(file, target);
    const sidecar = sidecarPathOf(file);
    if (sessionDialectAt(file) === "claude" && existsSync(sidecar)) {
      copy(sidecar, sidecarPathOf(target));
    }
  };
  for (const file of sources.orchestratorFiles) {
    const dir = sessionDialectAt(file) === "claude" ? "claude" : "sessions";
    copySession(file, join(outDir, "firstmate", dir, basename(file)));
  }
  for (const [alias, files] of Object.entries(sources.crewmateFiles)) {
    for (const file of files) {
      copySession(file, join(outDir, "crewmates", alias, "sessions", basename(file)));
    }
  }
  for (const file of sources.supervisionFiles) {
    copy(file, join(outDir, "supervision", "sessions", basename(file)));
  }
  if (sources.tablesPath) {
    const tables = windowTables(readRecordedTables(sources.tablesPath), window);
    const target = join(outDir, "tables.json");
    const scrubbed = Object.fromEntries(
      RECORDED_TABLE_NAMES.map((name) => [name, scrubRecording(tables[name])]),
    );
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, `${JSON.stringify(scrubbed, null, 2)}\n`);
    written.push(target);
  }
  return written;
}

// --------------------------------------------------------------------------
// The engine, through Vite (core modules use aliases plain Node cannot load)
// --------------------------------------------------------------------------

export type Engine = {
  replaySession: (sources: ReplaySources) => Promise<SessionReport>;
  /** Releases the module runner; the engine is unusable afterwards. */
  close?: () => Promise<void>;
};

/** The engine through a module runner that stays open for the whole run. */
export async function loadEngine(): Promise<Engine> {
  const runner = await openModuleRunner();
  const module = await runner.import<Engine>(ENGINE_PATH);
  return {
    replaySession: (sources) => module.replaySession(sources),
    close: runner.close,
  };
}

// --------------------------------------------------------------------------
// The report and the gate
// --------------------------------------------------------------------------

export type BaselineFile = { note?: string; sessions: BaselineScores };

export type ReplayReport = {
  harness: "replay-captain-session";
  version: 1;
  code: { head: string | null; dirty: boolean | null };
  gate: { is_packaged: boolean; dev_observe_override: boolean };
  sessions: (SessionReport & {
    scored: Record<
      string,
      {
        label: string;
        value: number | null;
        numerator?: number;
        denominator?: number;
        direction: MetricDirection;
        sep14: string;
        target: string | null;
        meets_target: boolean | null;
      }
    >;
  })[];
  baseline: { path: string; pass: boolean; regressions: Regression[] } | null;
};

export function gitState(cwd: string = REPO_ROOT): ReplayReport["code"] {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    return { head, dirty: status.trim().length > 0 };
  } catch {
    return { head: null, dirty: null };
  }
}

export function annotate(scores: MetricScores): ReplayReport["sessions"][number]["scored"] {
  return Object.fromEntries(
    METRICS.map((metric) => {
      const score = scores[metric.id];
      return [
        metric.id,
        {
          label: metric.label,
          value: score.value,
          ...(score.numerator !== undefined ? { numerator: score.numerator } : {}),
          ...(score.denominator !== undefined ? { denominator: score.denominator } : {}),
          direction: metric.direction,
          sep14: metric.sep14.text,
          target: metric.target?.text ?? null,
          meets_target: meetsTarget(metric.id, score.value),
        },
      ];
    }),
  );
}

export function readBaseline(path: string): BaselineFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
  if (!parsed || typeof parsed.sessions !== "object") {
    throw new Error(`${path} is not a replay baseline (no "sessions" object)`);
  }
  return parsed;
}

const BASELINE_NOTE =
  "The replay gate's committed scores (docs/replay-harness.md). Updated only by a PR that explains every change; regenerate with pnpm replay:gate --write-baseline.";

export function summarize(report: ReplayReport): string {
  const lines = [`code: ${report.code.head ?? "unknown"}${report.code.dirty ? " (dirty)" : ""}`];
  for (const session of report.sessions) {
    const f = session.fidelity;
    const delivered = f.recorded_thread_replies - f.skipped_thread_replies;
    // Why each crewmate turn that never played did not, counted by reason.
    const reasons = new Map<string, number>();
    for (const { reason } of session.details.unplayed_crewmate_turns) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const unplayed = [...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ");
    lines.push(
      `session ${session.session}: captain turns ${f.replayed_captain_turns}/${f.recorded_captain_turns}, ` +
        `op turns ${f.played_op_turns}/${f.recorded_op_turns}, ` +
        `crewmate turns ${f.played_crewmate_turns}/${f.recorded_crewmate_turns}` +
        `${unplayed ? ` (${unplayed})` : ""}, ` +
        `thread replies ${delivered}/${f.recorded_thread_replies}, ` +
        `unrecorded wakes ${f.unrecorded_firstmate_wakes}`,
    );
    for (const metric of METRICS) {
      const scored = session.scored[metric.id];
      if (!scored) continue;
      const target =
        scored.meets_target === null ? "" : scored.meets_target ? "  [meets target]" : "  [below target]";
      lines.push(`  ${metric.id}: ${formatValue(scored.value)}${target}`);
    }
  }
  if (report.baseline) {
    lines.push(
      report.baseline.pass
        ? `baseline ${report.baseline.path}: no regressions`
        : `baseline ${report.baseline.path}: ${report.baseline.regressions.length} regression(s)`,
    );
    for (const regression of report.baseline.regressions) {
      lines.push(`  REGRESSION ${regression.session} ${regression.metric}: ${regression.reason}`);
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export type CliArgs = {
  source: SourceInput | null;
  fixtures: string | null;
  baseline: string | null;
  writeBaseline: boolean;
  exportFixture: string | null;
  out: string | null;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData: string | null = null;
  let sessionsDir: string | undefined;
  let claudeSessionsDir: string | undefined;
  let crewmatesDir: string | undefined;
  let supervisionDir: string | undefined;
  let dbPath: string | undefined;
  let name: string | undefined;
  let from: number | null = null;
  let to: number | null = null;
  let fixtures: string | null = null;
  let baseline: string | null = null;
  let writeBaseline = false;
  let exportTo: string | null = null;
  let out: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--") continue;
    if (arg === "--user-data") userData = next();
    else if (arg === "--sessions") sessionsDir = next();
    else if (arg === "--claude-sessions") claudeSessionsDir = next();
    else if (arg === "--crewmates") crewmatesDir = next();
    else if (arg === "--supervision") supervisionDir = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--name") name = next();
    else if (arg === "--from") from = parseWindowBound(next(), arg);
    else if (arg === "--to") to = parseWindowBound(next(), arg);
    else if (arg === "--fixtures") fixtures = next();
    else if (arg === "--baseline") baseline = next();
    else if (arg === "--write-baseline") writeBaseline = true;
    else if (arg === "--export-fixture") exportTo = next();
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const explicit =
    userData || sessionsDir || claudeSessionsDir || crewmatesDir || supervisionDir || dbPath;
  if (!help && fixtures && explicit) {
    throw new Error("pass either --fixtures or one recording (--user-data / --sessions / --db), not both");
  }
  if (!help && writeBaseline && !baseline) throw new Error("--write-baseline needs --baseline <file>");
  if (!help && exportTo && fixtures) throw new Error("--export-fixture copies one recording, not --fixtures");
  const window = windowOf(from, to);
  if (!help && window && fixtures) {
    throw new Error("--from / --to trim one recording; committed fixtures are already trimmed");
  }
  let source: SourceInput | null = null;
  if (!fixtures) {
    const root =
      userData ?? (sessionsDir || claudeSessionsDir || dbPath ? undefined : defaultUserDataDir());
    source = {
      name: name ?? basename(root ?? sessionsDir ?? claudeSessionsDir ?? "session"),
      ...(window ? { window } : {}),
      ...(root ? { root } : {}),
      ...(sessionsDir ? { sessionsDir } : {}),
      ...(claudeSessionsDir ? { claudeSessionsDir } : {}),
      ...(crewmatesDir ? { crewmatesDir } : {}),
      ...(supervisionDir ? { supervisionDir } : {}),
      ...(dbPath ? { dbPath } : {}),
    };
  }
  return { source, fixtures, baseline, writeBaseline, exportFixture: exportTo, out, help };
}

const USAGE = `Replay recorded Infinitary captain sessions against the current code and score them
(interaction P3, WI-19; docs/replay-harness.md).

  pnpm replay:captain [options]      (or: node scripts/replay-captain-session.ts)
  pnpm replay:gate                   (the CI gate over tests/fixtures/replay)

  --user-data <dir>       a userData dir or an exported copy (default: the platform
                          userData path, or INFINITARY_USER_DATA_DIR)
  --sessions <dir>        Firstmate transcripts (default: <user-data>/firstmate/sessions)
  --claude-sessions <dir> Claude-served Firstmate transcripts (default: <user-data>/firstmate/claude)
  --crewmates <dir>       crewmate sessions root (default: <user-data>/crewmates)
  --supervision <dir>     pre-S7c archives for --export-fixture only; never replayed
                          (default: <user-data>/supervision/sessions)
  --db <path>             firstmate.db or a scrubbed tables.json (default: <user-data>/firstmate.db)
  --name <label>          the session's name in the report (default: the directory name)
  --from <iso>            replay only messages at or after this time (and the crewmates,
                          cards, outcomes, asks and thread messages inside the window;
                          every task row stays)
  --to <iso>              replay only messages at or before this time
  --fixtures <dir>        replay every recording under <dir> instead of one
  --baseline <file>       compare against committed scores; any regression exits 1
  --write-baseline        write the current scores to --baseline instead
  --export-fixture <dir>  copy the one recording, scrubbed and trimmed to --from/--to,
                          into a fixture directory
  --out, -o <file>        write the JSON report here (default: stdout)
  --help, -h

Local development only: it reads transcripts, so it needs an unpackaged build or
an explicit INFINITARY_DEV_OBSERVE=1 (docs/dev-observe.md, "Hard gate"). Offline: no
provider, no network, and nothing is written into the recording.`;

export type RunDeps = {
  gate: DevObserveGateInput;
  loadEngine: () => Promise<Engine>;
  git: () => ReplayReport["code"];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    deps.stdout(`${USAGE}\n`);
    return 0;
  }
  // The gate is checked before any transcript is read.
  if (!isDevObserveEnabled(deps.gate)) {
    deps.stderr(`${OBSERVE_DISABLED_MESSAGE}: the replay harness reads transcripts.\n`);
    return 3;
  }
  const sessions = args.fixtures
    ? discoverFixtures(args.fixtures)
    : [discoverSources(args.source as SourceInput)];
  const recorded = sessions.filter(hasRecording);
  if (recorded.length === 0) {
    deps.stderr("No recording found. Point --user-data, --sessions, or --fixtures at one.\n");
    return 1;
  }
  if (args.exportFixture) {
    const written = exportFixture(recorded[0] as ReplaySources, args.exportFixture);
    deps.stderr(`wrote ${written.length} file(s) under ${args.exportFixture}; review before committing.\n`);
    return 0;
  }

  const code = deps.git();
  const engine = await deps.loadEngine();
  const reports: ReplayReport["sessions"] = [];
  try {
    for (const sources of recorded) {
      const session = await engine.replaySession(sources);
      reports.push({ ...session, scored: annotate(session.metrics) });
    }
  } finally {
    await engine.close?.();
  }
  const current = Object.fromEntries(reports.map((session) => [session.session, session.metrics]));

  let baseline: ReplayReport["baseline"] = null;
  if (args.baseline && args.writeBaseline) {
    const file: BaselineFile = { note: BASELINE_NOTE, sessions: baselineFrom(current) };
    writeFileSync(args.baseline, `${JSON.stringify(file, null, 2)}\n`);
    deps.stderr(`wrote baseline ${args.baseline}\n`);
  } else if (args.baseline) {
    const regressions = compareToBaseline(current, readBaseline(args.baseline).sessions);
    baseline = {
      path: relative(process.cwd(), resolve(args.baseline)) || args.baseline,
      pass: regressions.length === 0,
      regressions,
    };
  }

  const report: ReplayReport = {
    harness: "replay-captain-session",
    version: 1,
    code,
    gate: {
      is_packaged: deps.gate.isPackaged,
      dev_observe_override: settingFrom(deps.gate.env ?? {}, "DEV_OBSERVE") === "1",
    },
    sessions: reports,
    baseline,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, json);
  else deps.stdout(json);
  deps.stderr(`${summarize(report)}\n`);
  return baseline && !baseline.pass ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), {
    gate: {
      isPackaged: detectPackaged({ moduleUrl: import.meta.url, env: process.env }),
      env: process.env,
    },
    loadEngine,
    git: () => gitState(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
