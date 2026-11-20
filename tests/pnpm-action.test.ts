import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { delimiter, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { claimedPort } from "./helpers/claimedPort";
import { npmRegistryStandIn, pnpmInstall } from "./helpers/npmRegistryStandIn";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * pnpm/action-setup installed pnpm from npm's registry on every job, and a
 * self-hosted Linux machine's three tries all timed out twice in a day, so
 * two checks failed before any project step ran.
 * .github/actions/pnpm keeps the version package.json pins in the Actions
 * cache instead. These run its own shell steps as a runner does, against a
 * stand-in for the registry, and carry only the folder its cache path names
 * from one runner to the next, as the cache does.
 *
 * Its last step gives pnpm's own downloads on a GitHub-hosted machine the
 * waits the project's job images give them, after a batch's hosted Linux
 * journeys job failed its install on an 86 MB package that took longer than
 * pnpm's 60-second default three times. That case runs the project's own
 * pnpm against a stand-in registry whose package arrives slowly.
 */

const repoRoot = join(__dirname, "..");
const actionPath = join(repoRoot, ".github/actions/pnpm");

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
const { runs } = loadYamlFile(".github/actions/pnpm/action.yml") as {
  runs: {
    steps: [pnpm: Step, restore: Step, fetch: Step, save: Step, link: Step, waits: Step];
  };
};
const [record, restore, fetch, save, link, waits] = runs.steps;

/** The pnpm package as npm publishes it: package/package.json and its commands under package/bin. */
function makePackage(folder: string, version: string, claims = version): Buffer {
  const tree = join(folder, `tree-${version}-${claims}`);
  mkdirSync(join(tree, "package", "bin"), { recursive: true });
  writeFileSync(
    join(tree, "package", "package.json"),
    JSON.stringify({ name: "pnpm", version: claims }, null, 2),
  );
  // pnpm ships each command as an ES module beside a CommonJS shim; the
  // stand-in ships pnpx as the shim alone, so both entries are exercised.
  writeFileSync(
    join(tree, "package", "bin", "pnpm.mjs"),
    'console.log(["stand-in pnpm", ...process.argv.slice(2)].join(" "));\n',
  );
  writeFileSync(
    join(tree, "package", "bin", "pnpx.cjs"),
    'console.log(["stand-in pnpx", ...process.argv.slice(2)].join(" "));\n',
  );
  const archive = join(folder, `pnpm-${version}-${claims}.tgz`);
  const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "package"], { env: hostEnv() });
  expect(packed.status, String(packed.stderr)).toBe(0);
  return readFileSync(archive);
}

/**
 * The stand-in registry: answers 504, as an overloaded registry does, for its
 * first `failures` requests, then serves each version's package.
 */
async function standIn(packages: Record<string, Buffer>, failures = 0) {
  const asked: string[] = [];
  let failed = 0;
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push(path);
    if (failed < failures) {
      failed++;
      response.writeHead(504).end();
      return;
    }
    const version = /^\/pnpm\/-\/pnpm-([^/]+)\.tgz$/.exec(path)?.[1];
    const body = version ? packages[version] : undefined;
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": body.length }).end(body);
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    // With a trailing slash, as a registry address is often written.
    registry: `http://127.0.0.1:${port}/`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A registry address nothing listens on: any request to it is refused. */
async function nothingListening(): Promise<string> {
  return `http://127.0.0.1:${await claimedPort()}`;
}

describe(".github/actions/pnpm", () => {
  let folder: string;
  let server: Awaited<ReturnType<typeof standIn>> | undefined;
  let slow: Awaited<ReturnType<typeof npmRegistryStandIn>> | undefined;

  beforeEach(() => {
    folder = scratchDir("infinitary-pnpm-action-");
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await slow?.close();
    slow = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  /** One runner: its own temporary folder and checkout, as a fresh machine starts with. */
  function runner(name: string, packageJson: Record<string, unknown>) {
    const temp = join(folder, name, "temp");
    const checkout = join(folder, name, "checkout");
    mkdirSync(temp, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "package.json"), JSON.stringify(packageJson, null, 2));
    return { temp, checkout };
  }

  /** The environment a runner gives a composite action's bash step. */
  function stepProcess(step: Step, cwd: string, env: Record<string, string>) {
    return {
      args: ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run ?? ""],
      options: {
        cwd,
        env: {
          ...hostEnv(),
          PATH: `${dirname(process.execPath)}${delimiter}${hostEnv().PATH ?? ""}`,
          GITHUB_ACTION_PATH: actionPath,
          // The fetch waits 30 seconds between tries on a runner.
          FETCH_PAUSE_SECONDS: "0",
          ...env,
        },
      },
    };
  }

  /** A step that reaches no network, run as a runner runs it. */
  function runStep(step: Step, cwd: string, env: Record<string, string>) {
    const { args, options } = stepProcess(step, cwd, env);
    return spawnSync("bash", args, { ...options, encoding: "utf8" });
  }

  /**
   * The fetch step, run beside the test, never blocking it, since the
   * stand-in registry answering it listens in this process.
   */
  function runFetch(cwd: string, env: Record<string, string>) {
    const { args, options } = stepProcess(fetch, cwd, env);
    const child = spawn("bash", args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
  }

  /** Lines a step wrote to one of the runner's files: name=value, or a bare line. */
  function written(file: string): string[] {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  }
  const values = (lines: string[]) =>
    Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ) as Record<string, string>;

  /** The first step: the version package.json pins, and the folders the rest use. */
  function runRecord(temp: string, checkout: string) {
    const output = join(temp, "record-output");
    writeFileSync(output, "");
    const result = runStep(record, checkout, { RUNNER_TEMP: temp, GITHUB_OUTPUT: output });
    return { result, outputs: values(written(output)) };
  }

  /** The expression contexts the later steps read, after `record` and the restore. */
  function contexts(
    outputs: Record<string, string>,
    registry: string,
    state: { hit: boolean; fetch?: "success" | "failure" | "skipped" },
  ) {
    return {
      runner: { os: "Linux" },
      inputs: { "working-directory": ".", registry },
      steps: {
        pnpm: { outputs },
        restore: { outputs: { "cache-hit": state.hit ? "true" : "" } },
        fetch: { outcome: state.fetch ?? "skipped" },
      },
    };
  }

  /** A step's env as the runner hands it over, its expressions evaluated. */
  function stepEnv(step: Step, context: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(step.env ?? {}).map(([name, value]) => [name, workflowString(value, context)]),
    );
  }

  /** The last step: the commands on the PATH, and what the job's later steps see. */
  function runLink(temp: string, context: Record<string, unknown>) {
    const path = join(temp, "path");
    const env = join(temp, "env");
    writeFileSync(path, "");
    writeFileSync(env, "");
    const result = runStep(link, temp, {
      ...stepEnv(link, context),
      GITHUB_PATH: path,
      GITHUB_ENV: env,
    });
    expect(result.status, result.stderr).toBe(0);
    return { path: written(path), env: values(written(env)) };
  }

  /** A command the link step placed, run as a later step runs it. */
  function command(home: string, name: string, args: string[]) {
    const result = spawnSync(join(home, name), args, {
      env: { ...hostEnv(), PATH: `${dirname(process.execPath)}${delimiter}${hostEnv().PATH}` },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  it("reads the pnpm version package.json pins, without its checksum", () => {
    const { temp, checkout } = runner("first", {
      name: "project",
      packageManager: "pnpm@9.9.9+sha512.0123456789abcdef",
    });
    const { result, outputs } = runRecord(temp, checkout);
    expect(result.status, result.stderr).toBe(0);
    expect(outputs).toEqual({
      version: "9.9.9",
      dir: join(temp, "pnpm", "9.9.9"),
      home: join(temp, "pnpm", "home"),
    });
    // pnpm's home, which its store follows, is outside the folder the cache saves.
    expect(relative(outputs.dir ?? "", outputs.home ?? "").startsWith("..")).toBe(true);
    const context = contexts(outputs, "https://registry.npmjs.org", { hit: false });
    expect(workflowString(restore.with?.key ?? "", context)).toBe("pnpm-Linux-9.9.9");
    expect(workflowString(restore.with?.path ?? "", context)).toBe(outputs.dir);
    expect(save.with).toEqual(restore.with);

    // This project's own package.json, as every job runs it.
    const own = (
      JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
        packageManager: string;
      }
    ).packageManager;
    const ours = runner("ours", {});
    cpSync(join(repoRoot, "package.json"), join(ours.checkout, "package.json"));
    expect(runRecord(ours.temp, ours.checkout).outputs.version).toBe(
      own.replace(/^pnpm@/, "").replace(/\+.*$/, ""),
    );
  });

  it("fails before any download when package.json pins no pnpm", () => {
    for (const [name, packageJson] of Object.entries({
      yarn: { packageManager: "yarn@4.0.0" },
      none: { name: "project" },
      unversioned: { packageManager: "pnpm@latest" },
    })) {
      const { temp, checkout } = runner(name, packageJson);
      const { result, outputs } = runRecord(temp, checkout);
      expect(result.status, name).not.toBe(0);
      expect(result.stderr, name).toContain("::error title=No pnpm version::");
      expect(outputs, name).toEqual({});
    }
  });

  it("waits out a registry outage on a version's first download, keeps it, and runs it", async () => {
    server = await standIn({ "9.9.9": makePackage(folder, "9.9.9") }, 2);
    const { temp, checkout } = runner("first", { packageManager: "pnpm@9.9.9" });
    const { outputs } = runRecord(temp, checkout);

    // Nothing restored: the fetch runs, and waits through two 504s.
    const missed = contexts(outputs, server.registry, { hit: false });
    expect(workflowValue(fetch.if ?? "", missed)).toBe(true);
    const fetched = await runFetch(temp, { ...stepEnv(fetch, missed), RUNNER_TEMP: temp });
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(server.asked).toEqual(Array(3).fill("/pnpm/-/pnpm-9.9.9.tgz"));
    expect(fetched.stderr).toContain("gave HTTP 504");

    // Saved at once, from the folder the next runner restores into.
    expect(workflowValue(save.if ?? "", { ...missed, ...fetchedAs("success", missed) })).toBe(true);
    const dir = outputs.dir ?? "";
    const kept = join(folder, "cache");
    cpSync(dir, kept, { recursive: true });

    const placed = runLink(temp, missed);
    const home = outputs.home ?? "";
    expect(placed.path).toEqual([home]);
    expect(placed.env).toEqual({ PNPM_HOME: home });
    expect(command(home, "pnpm", ["install", "--frozen-lockfile"])).toBe(
      "stand-in pnpm install --frozen-lockfile",
    );
    expect(command(home, "pnpx", ["thing"])).toBe("stand-in pnpx thing");

    // The next fresh runner restores the kept folder and never asks the registry.
    await server.close();
    server = undefined;
    const second = runner("second", { packageManager: "pnpm@9.9.9" });
    const next = runRecord(second.temp, second.checkout).outputs;
    expect(workflowString(restore.with?.key ?? "", contexts(next, "", { hit: true }))).toBe(
      "pnpm-Linux-9.9.9",
    );
    cpSync(kept, next.dir ?? "", { recursive: true });
    const hit = contexts(next, await nothingListening(), { hit: true });
    expect(workflowValue(fetch.if ?? "", hit)).toBe(false);
    expect(workflowValue(save.if ?? "", hit)).toBe(false);
    const restored = runLink(second.temp, hit);
    expect(restored.path).toEqual([next.home]);
    expect(command(next.home ?? "", "pnpm", ["--version"])).toBe("stand-in pnpm --version");
  });

  it("keeps nothing when the registry answers a package of another version", async () => {
    server = await standIn({ "9.9.9": makePackage(folder, "9.9.9", "9.9.8") });
    const { temp, checkout } = runner("first", { packageManager: "pnpm@9.9.9" });
    const { outputs } = runRecord(temp, checkout);
    const missed = contexts(outputs, server.registry, { hit: false });
    const fetched = await runFetch(temp, { ...stepEnv(fetch, missed), RUNNER_TEMP: temp });
    expect(fetched.status).not.toBe(0);
    // It downloaded and unpacked the package, and refused it for its version.
    expect(server.asked).toEqual(["/pnpm/-/pnpm-9.9.9.tgz"]);
    expect(readFileSync(join(outputs.dir ?? "", "package", "package.json"), "utf8")).toContain(
      '"version": "9.9.8"',
    );
    expect(workflowValue(save.if ?? "", { ...missed, ...fetchedAs("failure", missed) })).toBe(
      false,
    );
  });

  it("fails naming the registry once it has not answered for the whole wait", async () => {
    const registry = await nothingListening();
    const { temp, checkout } = runner("first", { packageManager: "pnpm@9.9.9" });
    const { outputs } = runRecord(temp, checkout);
    const missed = contexts(outputs, registry, { hit: false });
    const fetched = await runFetch(temp, {
      ...stepEnv(fetch, missed),
      RUNNER_TEMP: temp,
      // On a runner the wait is ten minutes; here it ends after the first try.
      FETCH_PATIENCE_SECONDS: "0",
    });
    expect(stepEnv(fetch, missed).FETCH_PATIENCE_SECONDS).toBe("600");
    expect(fetched.status).not.toBe(0);
    expect(fetched.stderr).toContain(`${registry}/pnpm/-/pnpm-9.9.9.tgz still gave no answer`);
  });

  // The project's own pnpm, twice (docs/test-cohorts.md, "Budgets").
  it("gives pnpm's own downloads on a GitHub-hosted machine waits it reads", {
    timeout: 20_000,
  }, async () => {
    const hosted = { runner: { os: "Linux", environment: "github-hosted" } };
    expect(workflowValue(waits.if ?? "", hosted)).toBe(true);
    // A self-hosted machine keeps the waits its own image gives pnpm.
    const own = { runner: { os: "Linux", environment: "self-hosted" } };
    expect(workflowValue(waits.if ?? "", own)).toBe(false);

    slow = await npmRegistryStandIn(folder, [
      {
        manifest: { name: "slow-package", version: "1.0.0" },
        files: { "blob.bin": randomBytes(256 * 1024) },
        seconds: 1.5,
      },
    ]);
    /** What the step leaves in the job's environment, run with `env`. */
    const job = (name: string, env: Record<string, string>) => {
      const file = join(folder, `${name}.env`);
      writeFileSync(file, "");
      const result = runStep(waits, folder, { ...env, GITHUB_ENV: file });
      expect(result.status, result.stderr).toBe(0);
      return values(written(file));
    };
    const install = (name: string, env: Record<string, string>) =>
      pnpmInstall(
        join(folder, name),
        slow?.registry ?? "",
        { dependencies: { "slow-package": "1.0.0" } },
        job(name, env),
        ["install", "--no-frozen-lockfile"],
      );
    const installed = (project: string) =>
      existsSync(join(project, "node_modules", "slow-package", "package.json"));

    // Waits shorter than the download: pnpm gives up on each try at the
    // step's limit, tries once more as the step says, and fails, where its
    // own 60 seconds would take the whole download in one try.
    const short = await install("short", { FETCH_TIMEOUT_MS: "500", FETCH_RETRIES: "1" });
    expect(short.status, short.output).not.toBe(0);
    expect(short.output).toContain("aborted due to timeout");
    expect(slow.tarballRequests("slow-package")).toBe(2);
    expect(installed(short.project)).toBe(false);

    // The step's own waits take the slow download whole.
    const waited = await install("own", stepEnv(waits, hosted));
    expect(waited.status, waited.output).toBe(0);
    expect(slow.tarballRequests("slow-package")).toBe(3);
    expect(installed(waited.project)).toBe(true);
  });
});

/** The contexts after the fetch step ended with `outcome`. */
function fetchedAs(
  outcome: "success" | "failure",
  context: { steps: Record<string, unknown> },
): { steps: Record<string, unknown> } {
  return { steps: { ...context.steps, fetch: { outcome } } };
}
