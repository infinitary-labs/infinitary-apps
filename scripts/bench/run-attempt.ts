/**
 * Runs one headless benchmark attempt and writes its scored row (plan S1;
 * `scripts/bench/README.md`). Node 24 strips the types; the core loads
 * through the Vite module runner, the way the replay harness loads it.
 *
 *   pnpm bench:attempt --dry-run --out <dir>
 *   pnpm bench:attempt --task <task-dir> --repo <git-source> --base <sha> \
 *     --care quick|default|careful [--pin <provider>/<model>] [--mirror <url>] \
 *     --bridge "<command prefix>" --verifier <command> --out <dir> [--mock]
 *
 * `--dry-run` is the whole path at no spend: the fixture task under
 * `fixtures/mock-task`, the e2e mock provider, and the stub verifier.
 * Without `--mock` the attempt uses this machine's subscriptions.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openModuleRunner, REPO_ROOT } from "../moduleRunner.ts";
import type { AttemptOptions, AttemptRow } from "./attempt.ts";
import type { Care } from "./policy.ts";
import { commandVerifier, stubVerifier, type Verifier } from "./verifier.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "mock-task");
const CARES: readonly string[] = ["quick", "default", "careful"];

/** The dry-run fixture is an executable path, not a caller-supplied shell command. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

type MockModule = typeof import("../../tests/e2e/mockProvider.ts");
type MockModelsModule = typeof import("../../tests/e2e/mockModels.ts");
type WriteFileModule = typeof import("../../tests/e2e/scenarios/writeFile.ts");

function fail(message: string): never {
  console.error(`run-attempt: ${message}`);
  process.exit(2);
}

/** The fixture's repository as a git source, committed once under the attempt. */
function fixtureSource(outDir: string): { repo: string; base: string } {
  const repo = join(outDir, "source");
  cpSync(join(FIXTURE, "repo"), repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=infinitary-bench",
    "-c",
    "user.email=infinitary-bench@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Base",
  );
  return { repo, base: git("rev-parse", "HEAD") };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      mock: { type: "boolean", default: false },
      task: { type: "string" },
      "task-id": { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      care: { type: "string", default: "default" },
      pin: { type: "string" },
      mirror: { type: "string" },
      bridge: { type: "string" },
      verifier: { type: "string" },
      check: { type: "string" },
      out: { type: "string" },
      "cap-minutes": { type: "string" },
      "quiet-seconds": { type: "string" },
    },
  });
  if (!values.out) fail("--out <dir> is required");
  const outDir = resolve(values.out);
  if (existsSync(outDir)) {
    // A reused directory would mix two attempts' records.
    fail(`${outDir} already exists; every attempt writes a new directory`);
  }
  mkdirSync(outDir, { recursive: true });
  if (!CARES.includes(values.care)) fail(`--care must be one of ${CARES.join(", ")}`);
  const care = values.care as Care;

  const dryRun = values["dry-run"];
  const mock = dryRun || values.mock;
  const taskDir = dryRun ? FIXTURE : values.task;
  if (!taskDir) fail("--task <task-dir> is required (or --dry-run)");
  const instruction = readFileSync(join(taskDir, "instruction.md"), "utf8").trim();
  const taskId = dryRun ? "mock-answer" : (values["task-id"] ?? taskDir.split("/").at(-1) ?? "");

  let source: { repo: string; base: string };
  if (dryRun) {
    source = fixtureSource(outDir);
  } else {
    if (!values.repo || !values.base) fail("--repo and --base are required");
    source = { repo: values.repo, base: values.base };
  }

  let verifier: Verifier;
  if (values.verifier) {
    verifier = commandVerifier(values.verifier);
  } else if (dryRun) {
    verifier = stubVerifier({ ...source, check: shellQuote(join(FIXTURE, "check.sh")) });
  } else if (values.check) {
    verifier = stubVerifier({ ...source, check: values.check });
  } else {
    fail("--verifier <command> is required (or --check for the local stub)");
  }

  const bridge = values.bridge ?? (dryRun ? "sh -c" : undefined);
  if (!bridge) fail("--bridge <command prefix> is required");
  const repoInstructions = readFileSync(join(HERE, "crew-instructions.md"), "utf8").replaceAll(
    "{{BRIDGE}}",
    bridge,
  );

  let pin: AttemptOptions["pin"];
  if (values.pin) {
    const slash = values.pin.indexOf("/");
    if (slash <= 0) fail("--pin takes <provider>/<model>");
    pin = { provider: values.pin.slice(0, slash), id: values.pin.slice(slash + 1) };
  }

  const infinitaryCommit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const runner = await openModuleRunner();
  let mockServer: Awaited<ReturnType<MockModule["startMockProvider"]>> | undefined;
  try {
    let provider: AttemptOptions["provider"] = { kind: "live" };
    if (mock) {
      const mockModule = await runner.import<MockModule>(
        join(REPO_ROOT, "tests/e2e/mockProvider.ts"),
      );
      const { mockModelsJson } = await runner.import<MockModelsModule>(
        join(REPO_ROOT, "tests/e2e/mockModels.ts"),
      );
      const { writeFile } = await runner.import<WriteFileModule>(
        join(REPO_ROOT, "tests/e2e/scenarios/writeFile.ts"),
      );
      mockServer = await mockModule.startMockProvider({ scenarios: [writeFile] });
      provider = {
        kind: "mock",
        port: mockServer.port,
        modelsJson: mockModelsJson(mockServer.port),
      };
    }
    const { runAttempt } = await runner.import<typeof import("./attempt.ts")>(
      join(HERE, "attempt.ts"),
    );
    const row: AttemptRow = await runAttempt({
      taskId,
      instruction,
      repo: source.repo,
      baseCommit: source.base,
      care,
      ...(pin ? { pin } : {}),
      ...(values.mirror ? { mirror: values.mirror } : {}),
      outDir,
      repoInstructions,
      verifier,
      provider,
      infinitaryCommit,
      ...(values["cap-minutes"] ? { capMs: Number(values["cap-minutes"]) * 60_000 } : {}),
      ...(values["quiet-seconds"]
        ? { quietMs: Number(values["quiet-seconds"]) * 1000 }
        : mock
          ? { quietMs: 5_000 }
          : {}),
      log: (line) => console.log(`[attempt] ${line}`),
    });
    const totals = row.usage.totals;
    console.log(
      `row: ${join(outDir, "row.json")}\n` +
        `end ${row.end.reason}; reward ${row.reward?.reward ?? "none"}; ` +
        `${totals.turns} turns, ${totals.input} in / ${totals.output} out, $${totals.cost.toFixed(4)}`,
    );
  } finally {
    await mockServer?.close();
    await runner.close();
  }
}

await main();
