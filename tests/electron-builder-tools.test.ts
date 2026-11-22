import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { claimedPort } from "./helpers/claimedPort";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * electron-builder downloads the tools a package target needs (the AppImage
 * tools, 7-Zip and fpm for the Linux packages, dmgbuild for a Mac disk image)
 * from GitHub's release server; one 504 there failed a Linux package build
 * after its first tool arrived. .github/actions/electron-builder-tools keeps
 * those archives in the Actions cache, restored before a package step and
 * kept after it. These run its own step and electron-builder's own tool
 * downloader against a stand-in for that server, and copy only the files the
 * action's cache paths name from one runner to the next, as the cache does.
 */

const repoRoot = join(__dirname, "..");
const builder = createRequire(require.resolve("electron-builder/package.json"));
/** The downloader every electron-builder target fetches its tools through. */
const binDownload = builder.resolve("app-builder-lib/out/binDownload.js");

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
const { runs } = loadYamlFile(".github/actions/electron-builder-tools/action.yml") as {
  runs: { steps: [tools: Step, restore: Step, record: Step, save: Step] };
};
const [tools, restore, record, save] = runs.steps;
/** The electron-builder version package.json pins, which pins every tool's archive and checksum. */
const builderVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies["electron-builder"];

/** A tool archive as electron-builder-binaries publishes one, with its checksum. */
type Tool = { release: string; file: string; sha256: string; body: Buffer };

function makeTool(folder: string, release: string, name: string): Tool {
  const tree = join(folder, "trees", name);
  mkdirSync(join(tree, "bin"), { recursive: true });
  writeFileSync(join(tree, "bin", name), randomBytes(4096));
  const file = `${name}.tar.gz`;
  const archive = join(folder, file);
  const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "."], { env: hostEnv() });
  expect(packed.status, String(packed.stderr)).toBe(0);
  const body = readFileSync(archive);
  return { release, file, sha256: createHash("sha256").update(body).digest("hex"), body };
}

/**
 * The stand-in for GitHub's release server: serves each tool, or refuses one
 * named down. It refuses with 404, which electron-builder does not retry: a
 * 504 it retries three times over about twelve seconds, and the outage that
 * failed the Linux build outlasted those retries.
 */
async function standIn(tools: Tool[]) {
  const asked: string[] = [];
  const down = new Set<string>();
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push(path);
    const tool = tools.find((each) => path === `/${each.release}/${each.file}`);
    if (!tool || down.has(tool.file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": tool.body.length }).end(tool.body);
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    mirror: `http://127.0.0.1:${port}/`,
    asked,
    down,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe(".github/actions/electron-builder-tools", () => {
  let folder: string;
  let server: Awaited<ReturnType<typeof standIn>> | undefined;

  beforeEach(() => {
    folder = scratchDir("infinitary-builder-tools-");
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  /** One runner: its own temporary folder, as a fresh machine starts with. */
  function runner(name: string) {
    const temp = join(folder, name);
    mkdirSync(temp, { recursive: true });
    return temp;
  }

  function runToolsStep(temp: string, phase: { save: boolean; restored?: string }) {
    const env = join(temp, "env");
    const output = join(temp, "output");
    writeFileSync(env, "");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", tools.run ?? ""], {
      cwd: repoRoot,
      env: {
        ...hostEnv(),
        RUNNER_TEMP: temp,
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        GITHUB_ENV: env,
        GITHUB_OUTPUT: output,
        SAVE: phase.save ? "true" : "false",
        ELECTRON_BUILDER_TOOLS_RESTORED: phase.restored ?? "",
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ) as Record<string, string>;
    const outputs = lines(output);
    const contexts = {
      runner: { os: "Linux", arch: "X64" },
      inputs: { save: phase.save ? "true" : "false" },
      steps: { tools: { outputs } },
    };
    return { env: lines(env), outputs, contexts };
  }

  function required(value: string | undefined): string {
    expect(value).toBeTypeOf("string");
    return value as string;
  }

  /** The record step, given the key actions/cache/restore matched: what the second use reads back. */
  function runRecordStep(temp: string, matchedKey: string): string {
    const contexts = {
      inputs: { save: "false" },
      steps: { restore: { outputs: { "cache-matched-key": matchedKey } } },
    };
    expect(workflowValue(record.if ?? "", contexts)).toBe(true);
    const env = join(temp, "record-env");
    writeFileSync(env, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", record.run ?? ""], {
      env: {
        ...hostEnv(),
        GITHUB_ENV: env,
        MATCHED: workflowString(record.env?.MATCHED ?? "", contexts),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const line = readFileSync(env, "utf8").trim();
    expect(line.startsWith("ELECTRON_BUILDER_TOOLS_RESTORED=")).toBe(true);
    return line.slice("ELECTRON_BUILDER_TOOLS_RESTORED=".length);
  }

  /** The cache paths a step names, resolved and expanded as actions/cache expands them. */
  function cachedFiles(step: Step, contexts: Record<string, unknown>): string[] {
    const patterns = workflowString(step.with?.path ?? "", contexts)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return globSync(patterns).sort();
  }

  /** What actions/cache carries to the next runner: only the files its paths name. */
  function carry(files: string[], from: string, to: string) {
    for (const file of files) {
      const target = join(to, relative(from, file));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
  }

  /**
   * electron-builder's own downloader fetching `wanted`, as a package step
   * does. It runs beside the test, never blocking it, since the stand-in
   * answering it listens in this process.
   */
  function fetchTools(cache: string, temp: string, wanted: Tool[]) {
    const script = `
      const { getBinFromUrl } = require(${JSON.stringify(binDownload)});
      (async () => {
        for (const tool of JSON.parse(process.env.WANTED)) {
          const dir = await getBinFromUrl(tool.release, tool.file, tool.sha256);
          console.log("placed " + tool.file + " " + dir);
        }
      })().catch((error) => { console.error(String(error && error.message)); process.exit(1); });
    `;
    const scratch = join(temp, "tmp");
    mkdirSync(scratch, { recursive: true });
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        ...hostEnv(),
        ELECTRON_BUILDER_CACHE: cache,
        ELECTRON_BUILDER_BINARIES_MIRROR: server?.mirror,
        ELECTRON_BUILDER_BINARIES_ALLOW_HTTP: "true",
        TMPDIR: scratch,
        WANTED: JSON.stringify(
          wanted.map(({ release, file, sha256 }) => ({ release, file, sha256 })),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  it("restores the tools before a package step and keeps every archive it fetched for the next fresh runner", async () => {
    const appimage = makeTool(folder, "stand-in-appimage@1.0.0", "appimage-tools");
    const fpm = makeTool(folder, "stand-in-fpm@1.0.0", "fpm-tools");
    server = await standIn([appimage, fpm]);

    // The first runner: nothing restored, so both tools come from the server.
    const first = runner("first");
    const restored = runToolsStep(first, { save: false });
    const cache = required(restored.env.ELECTRON_BUILDER_CACHE);
    expect(cache).toBe(join(first, "electron-builder-cache"));
    const prefix = `electron-builder-tools-Linux-X64-${builderVersion}-`;
    expect(restored.outputs.prefix).toBe(prefix);
    expect(workflowValue(restore.if ?? "", restored.contexts)).toBe(true);
    expect(workflowString(restore.with?.key ?? "", restored.contexts)).toBe(prefix);
    expect(workflowString(restore.with?.["restore-keys"] ?? "", restored.contexts)).toBe(prefix);
    const cold = await fetchTools(cache, first, [appimage, fpm]);
    expect(cold.status, cold.stderr).toBe(0);
    expect(server.asked).toEqual([
      `/${appimage.release}/${appimage.file}`,
      `/${fpm.release}/${fpm.file}`,
    ]);

    // Its second use keeps exactly the two archives, never the unpacked tools.
    const kept = runToolsStep(first, { save: true });
    expect(kept.outputs.key).toMatch(new RegExp(`^${prefix}[0-9a-f]{16}$`));
    expect(workflowValue(save.if ?? "", kept.contexts)).toBe(true);
    expect(workflowString(save.with?.key ?? "", kept.contexts)).toBe(kept.outputs.key);
    expect(save.with?.path).toBe(restore.with?.path);
    const files = cachedFiles(save, kept.contexts);
    expect(files.map((file) => relative(cache, file))).toEqual([
      join(appimage.release, appimage.file),
      join(fpm.release, fpm.file),
    ]);

    // The next fresh runner restores them and asks the server for nothing.
    const second = runner("second");
    const next = runToolsStep(second, { save: false });
    carry(files, cache, required(next.env.ELECTRON_BUILDER_CACHE));
    const matched = runRecordStep(second, required(kept.outputs.key));
    server.asked.length = 0;
    const warm = await fetchTools(required(next.env.ELECTRON_BUILDER_CACHE), second, [
      appimage,
      fpm,
    ]);
    expect(warm.status, warm.stderr).toBe(0);
    expect(server.asked).toEqual([]);
    for (const tool of [appimage, fpm]) {
      expect(warm.stdout).toContain(`placed ${tool.file}`);
    }
    // It downloaded nothing new, so it saves nothing.
    const unchanged = runToolsStep(second, { save: true, restored: matched });
    expect(unchanged.outputs.key).toBeUndefined();
    expect(workflowValue(save.if ?? "", unchanged.contexts)).toBe(false);
  });

  it("keeps the tools a build fetched before it failed, so the next attempt fetches only the rest", async () => {
    const appimage = makeTool(folder, "stand-in-appimage@1.0.0", "appimage-tools");
    const fpm = makeTool(folder, "stand-in-fpm@1.0.0", "fpm-tools");
    server = await standIn([appimage, fpm]);
    server.down.add(fpm.file);

    const first = runner("first");
    const cache = required(runToolsStep(first, { save: false }).env.ELECTRON_BUILDER_CACHE);
    const failed = await fetchTools(cache, first, [appimage, fpm]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("404");
    const partial = runToolsStep(first, { save: true });
    const files = cachedFiles(save, partial.contexts);
    expect(files.map((file) => relative(cache, file))).toEqual([
      join(appimage.release, appimage.file),
    ]);

    server.down.clear();
    server.asked.length = 0;
    const second = runner("second");
    const next = runToolsStep(second, { save: false });
    carry(files, cache, required(next.env.ELECTRON_BUILDER_CACHE));
    const rest = await fetchTools(required(next.env.ELECTRON_BUILDER_CACHE), second, [
      appimage,
      fpm,
    ]);
    expect(rest.status, rest.stderr).toBe(0);
    expect(server.asked).toEqual([`/${fpm.release}/${fpm.file}`]);
    // Now holding both, it saves the fuller set under a key of its own.
    const fuller = runToolsStep(second, { save: true, restored: required(partial.outputs.key) });
    expect(fuller.outputs.key).toBeDefined();
    expect(fuller.outputs.key).not.toBe(partial.outputs.key);
    expect(cachedFiles(save, fuller.contexts)).toHaveLength(2);
  });

  it("fetches again a restored archive that does not match electron-builder's checksum", async () => {
    const appimage = makeTool(folder, "stand-in-appimage@1.0.0", "appimage-tools");
    server = await standIn([appimage]);
    const first = runner("first");
    const cache = required(runToolsStep(first, { save: false }).env.ELECTRON_BUILDER_CACHE);
    const planted = join(cache, appimage.release, appimage.file);
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, "not the archive");

    const fetched = await fetchTools(cache, first, [appimage]);

    expect(fetched.status, fetched.stderr).toBe(0);
    expect(server.asked).toEqual([`/${appimage.release}/${appimage.file}`]);
    expect(readFileSync(planted).equals(appimage.body)).toBe(true);
  });

  it("saves nothing when the package step fetched no tool", () => {
    const first = runner("first");
    runToolsStep(first, { save: false });
    const none = runToolsStep(first, { save: true });
    expect(none.outputs.key).toBeUndefined();
    expect(workflowValue(save.if ?? "", none.contexts)).toBe(false);
    expect(existsSync(join(first, "electron-builder-cache"))).toBe(false);
  });
});
