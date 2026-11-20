import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCHES,
  type Arch,
  ensureBundledGit,
  type ManifestEntry,
} from "../scripts/ensure-bundled-git.ts";
import { hostEnv } from "../src/core/hostEnv";
import { claimedPort } from "./helpers/claimedPort";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

const require = createRequire(import.meta.url);

/**
 * Electron 43's published tarball dropped the `postinstall` lifecycle script
 * that used to download Electron.app (the registry metadata still lists one;
 * the tarball's own package.json has none). scripts/ensure-electron-installed.mjs
 * runs electron's own installer from our postinstall to close that gap.
 *
 * These tests exercise the script as the real postinstall step will: as a
 * child process, against a real (fake) `electron` package on disk, asserting
 * on its actual exit code and side effects - not on the script's source text.
 */

const repoRoot = join(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "ensure-electron-installed.mjs");

function runScript(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

function writeFakeElectronPackage(projectDir: string, installJs: string) {
  const electronDir = join(projectDir, "node_modules", "electron");
  mkdirSync(electronDir, { recursive: true });
  writeFileSync(
    join(electronDir, "package.json"),
    JSON.stringify({ name: "electron", version: "1.0.0" }),
  );
  writeFileSync(join(electronDir, "install.js"), installJs);
  return electronDir;
}

describe("ensure-electron-installed.mjs", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = scratchDir("infinitary-electron-install-");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("invokes electron's own installer when the binary is missing", () => {
    const electronDir = writeFakeElectronPackage(
      projectDir,
      `
      const fs = require("fs");
      const path = require("path");
      fs.writeFileSync(path.join(__dirname, "invoked.marker"), "1");
      process.exit(0);
      `,
    );

    const result = runScript(projectDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(electronDir, "invoked.marker"))).toBe(true);
  });

  it("fails pnpm install loudly when electron's installer fails", () => {
    writeFakeElectronPackage(
      projectDir,
      `
      console.error("simulated: could not reach the Electron CDN");
      process.exit(1);
      `,
    );

    const result = runScript(projectDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/electron/i);
    expect(result.stderr).toMatch(/pnpm install/i);
  });
});

describe("ensure-electron-installed.mjs against the real electron package", () => {
  it("leaves require('electron') resolving to a binary that exists on disk", () => {
    // By the time tests run, `pnpm install` has already run this repo's real
    // postinstall (this same script, for real). Re-running it here proves
    // the idempotent fast path against the real electron/install.js, and
    // proves the actual acceptance criterion: require("electron") resolves
    // to a real, existing binary.
    const result = runScript(repoRoot);
    expect(result.status).toBe(0);

    const electronPath = require.resolve("electron");
    expect(existsSync(electronPath)).toBe(true);
  });
});

// Main's check run 42287797114 failed when electron's installer took a 504
// from GitHub's release server, which a hosted runner reached on every
// install. .github/actions/electron-download keeps that download in the
// Actions cache; tests/workflow-hygiene.test.ts holds every cached install
// to it. These run its own step and electron's own installer.
describe(".github/actions/electron-download", () => {
  type Step = {
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  };
  const { runs } = loadYamlFile(".github/actions/electron-download/action.yml") as {
    runs: { steps: [record: Step, cache: Step, git: Step] };
  };
  const [record, cache, git] = runs.steps;
  let folder: string;

  beforeEach(() => {
    folder = scratchDir("infinitary-electron-download-");
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The record step's run, as a hosted runner runs it in this checkout for a job naming `zips`. */
  function runRecordStep(zips = "") {
    const env = join(folder, "env");
    const output = join(folder, "output");
    writeFileSync(env, "");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", record.run ?? ""], {
      cwd: repoRoot,
      env: {
        ...hostEnv(),
        RUNNER_TEMP: folder,
        GITHUB_ENV: env,
        GITHUB_OUTPUT: output,
        ZIPS: workflowString(record.env?.ZIPS ?? "", { inputs: { zips } }),
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ) as Record<string, string>;
    return { env: lines(env), outputs: lines(output) };
  }

  // Batch run 42329308093's Mac journeys ran on a fresh virtual Mac, a
  // self-hosted runner with no Electron of its own; both steps skipped there,
  // and electron's installer failed when its download from the release server
  // stalled for five minutes. A self-hosted runner restores it too.
  it("runs on a self-hosted runner as on a GitHub-hosted one", () => {
    for (const step of [record, cache, git]) {
      for (const environment of ["github-hosted", "self-hosted"]) {
        const runner = { environment, os: "macOS" };
        const runs = step.if === undefined || workflowValue(step.if, { runner });
        expect(runs, `${step.id ?? "actions/cache"} on ${environment}`).toBe(true);
      }
    }
  });

  it("saves the folder electron's installer reads, under the Electron version the lockfile installs", () => {
    const { env, outputs } = runRecordStep();
    const lockfile = loadYamlFile("pnpm-lock.yaml") as {
      importers: { ".": { devDependencies: { electron: { version: string } } } };
    };
    const installed = lockfile.importers["."].devDependencies.electron.version;
    const contexts = {
      runner: { os: "Linux", arch: "X64" },
      steps: { [record.id ?? ""]: { outputs } },
    };
    expect(workflowString(cache.with?.key ?? "", contexts)).toBe(`electron-Linux-X64-${installed}`);
    expect(workflowString(cache.with?.path ?? "", contexts)).toBe(env.electron_config_cache);

    // Electron's own installer, the pinned version's, with a stand-in for its
    // downloader that records where it was told to cache and downloads nothing.
    const real = dirname(require.resolve("electron/package.json"));
    const electronDir = join(folder, "project", "node_modules", "electron");
    mkdirSync(electronDir, { recursive: true });
    for (const file of ["install.js", "package.json", "checksums.json"])
      copyFileSync(join(real, file), join(electronDir, file));
    const downloader = join(folder, "project", "node_modules", "@electron", "get");
    mkdirSync(downloader, { recursive: true });
    writeFileSync(join(downloader, "package.json"), JSON.stringify({ name: "@electron/get" }));
    writeFileSync(
      join(downloader, "index.js"),
      `exports.downloadArtifact = async (details) => {
        require("fs").writeFileSync(process.env.ASKED, JSON.stringify({ cacheRoot: details.cacheRoot, version: details.version }));
        throw new Error("stand-in: no download");
      };`,
    );
    const asked = join(folder, "asked.json");
    spawnSync(process.execPath, [join(electronDir, "install.js")], {
      env: { ...hostEnv(), ...env, ASKED: asked },
      encoding: "utf8",
    });
    expect(JSON.parse(readFileSync(asked, "utf8"))).toEqual({
      cacheRoot: env.electron_config_cache,
      version: installed,
    });
  });

  // Main's check run 42463836430 failed when electron-builder downloaded the
  // universal package's x64 zip, which no cache kept, from the release
  // server. A key once saved is only ever restored, so the Mac lane, which
  // names both Mac zips, keeps them under a key of its own that starts from
  // the install's.
  it("keeps the zips a job names under a key of its own, starting from the install's", () => {
    const { jobs } = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    const download = jobs.lane?.steps?.find((step) =>
      step.uses?.endsWith("/.github/actions/electron-download"),
    );
    const keys = (lane: string) => {
      const { outputs } = runRecordStep(
        workflowString(download?.with?.zips ?? "", { matrix: { lane } }),
      );
      const contexts = {
        runner: { os: "macOS", arch: "ARM64" },
        steps: { [record.id ?? ""]: { outputs } },
      };
      return [cache.with?.key, cache.with?.["restore-keys"]].map((value) =>
        workflowString(value ?? "", contexts),
      );
    };
    const lockfile = loadYamlFile("pnpm-lock.yaml") as {
      importers: { ".": { devDependencies: { electron: { version: string } } } };
    };
    const own = `electron-macOS-ARM64-${lockfile.importers["."].devDependencies.electron.version}`;
    expect(keys("mac")).toEqual([`${own}-darwin-arm64-darwin-x64`, own]);
    expect(keys("parallel")).toEqual([own, ""]);
  });

  // INF-1109's phone run 42469734595 failed on an iPad before any test ran:
  // the install's other download from GitHub's release server, dugite-native's
  // macOS git (scripts/ensure-bundled-git.ts), took a 504. These run the app's
  // own script against a stand-in for that server, and carry to the next
  // runner only the files the cache step's path names, as actions/cache does.
  it("keeps the app's git archives a Mac install fetches, so the next fresh runner fetches neither", async () => {
    const { env, outputs } = runRecordStep();
    const lockfile = loadYamlFile("pnpm-lock.yaml") as {
      importers: { ".": { dependencies: { dugite: { version: string } } } };
    };
    const dugite = lockfile.importers["."].dependencies.dugite.version;
    const contexts = {
      runner: { os: "macOS", arch: "ARM64" },
      steps: { [record.id ?? ""]: { outputs } },
    };
    expect(workflowValue(git.if ?? "", contexts)).toBe(true);
    expect(workflowValue(git.if ?? "", { ...contexts, runner: { os: "Linux" } })).toBe(false);
    expect(workflowString(git.with?.key ?? "", contexts)).toBe(`bundled-git-macOS-${dugite}`);
    const pattern = workflowString(git.with?.path ?? "", contexts);
    const folder = env.INFINITARY_BUNDLED_GIT_CACHE as string;
    expect(folder).toBeTypeOf("string");
    expect(dirname(pattern)).toBe(folder);

    // A stand-in archive for each chip, served by a stand-in release server.
    const archives = new Map<Arch, ManifestEntry & { body: Buffer }>();
    for (const arch of ARCHES) {
      const tree = join(scratchDir("infinitary-git-tree-"), "tree");
      mkdirSync(join(tree, "bin"), { recursive: true });
      mkdirSync(join(tree, "libexec", "git-core"), { recursive: true });
      writeFileSync(join(tree, "bin", "git"), randomBytes(1024));
      writeFileSync(join(tree, "libexec", "git-core", "git-remote-http"), "remote\n");
      const file = join(dirname(tree), `stand-in-git-${arch}.tar.gz`);
      const packed = spawnSync("tar", ["-czf", file, "-C", tree, "."], { env: hostEnv() });
      expect(packed.status, String(packed.stderr)).toBe(0);
      const body = readFileSync(file);
      const checksum = createHash("sha256").update(body).digest("hex");
      archives.set(arch, { name: basename(file), url: "", checksum, body });
    }
    const asked: string[] = [];
    const server = createServer((request, response) => {
      asked.push(request.url ?? "");
      const archive = [...archives.values()].find((each) => request.url === `/${each.name}`);
      if (archive) response.writeHead(200).end(archive.body);
      else response.writeHead(404).end();
    });
    const port = await claimedPort();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const entryFor = (arch: Arch) => {
      const archive = archives.get(arch);
      if (!archive) throw new Error(`no stand-in for ${arch}`);
      return { ...archive, url: `http://127.0.0.1:${port}/${archive.name}` };
    };
    // A scratch home too, so a script that ignored the folder would miss it here, never write home.
    const before = { cache: process.env.INFINITARY_BUNDLED_GIT_CACHE, home: process.env.HOME };
    process.env.INFINITARY_BUNDLED_GIT_CACHE = folder;
    process.env.HOME = scratchDir("infinitary-git-home-");
    try {
      // The first runner fetches both, into the folder the step names.
      await ensureBundledGit({ vendorDir: join(scratchDir("infinitary-copy-"), "git"), entryFor });
      expect(asked.sort()).toEqual(ARCHES.map((arch) => `/${entryFor(arch).name}`).sort());
      const kept = globSync(pattern).sort();
      expect(kept.map((file) => basename(file))).toEqual(
        ARCHES.map((arch) => entryFor(arch).name).sort(),
      );

      // The next fresh runner starts with only what the cache restored.
      const saved = scratchDir("infinitary-saved-");
      for (const file of kept) copyFileSync(file, join(saved, basename(file)));
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      for (const file of kept) copyFileSync(join(saved, basename(file)), file);
      asked.length = 0;
      const vendorDir = join(scratchDir("infinitary-copy-"), "git");
      await ensureBundledGit({ vendorDir, entryFor });
      expect(asked).toEqual([]);
      for (const arch of ARCHES) {
        expect(existsSync(join(vendorDir, `darwin-${arch}`, "bin", "git"))).toBe(true);
      }
    } finally {
      if (before.cache === undefined) delete process.env.INFINITARY_BUNDLED_GIT_CACHE;
      else process.env.INFINITARY_BUNDLED_GIT_CACHE = before.cache;
      process.env.HOME = before.home;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Main's check run 42463836430 failed in the Mac lane's package step, and
// the alpha run 42464772458 in the release's Mac and Linux package steps:
// after the install, electron-builder still downloaded Electron's zips, and
// Electron's SHASUMS256.txt for each, from GitHub's release server, which
// answered 504. These run every step of those jobs that runs electron-builder
// as its runner does, against a stand-in for the release server that counts
// what it is asked, with a stand-in for pnpm that reads its electron-builder
// arguments and configuration through electron-builder's own and fetches
// each zip through electron-builder's own Electron download, as its packager
// does. Each run loads electron-builder twice, about a second a case on a
// Mac, so the cases carry the rule's budget (docs/test-cohorts.md).
describe("every package step in the release path", { timeout: 10_000 }, () => {
  type Step = { id?: string; name?: string; run?: string; uses?: string };
  const steps = (
    [
      [".github/workflows/verify.yml", "lane"],
      [".github/workflows/release.yml", "release"],
      [".github/workflows/linux-packages.yml", "build"],
    ] as const
  ).flatMap(([workflow, job]) => {
    const { jobs } = loadYamlFile(workflow) as { jobs: Record<string, { steps?: Step[] }> };
    const jobSteps = jobs[job]?.steps ?? [];
    // A job with the Electron download step keeps electron_config_cache's
    // folder in the Actions cache; any other reads electron-builder's own
    // default cache, which stays on its machine.
    const kept = jobSteps.some((step) => step.uses?.endsWith("/.github/actions/electron-download"));
    return jobSteps
      .filter((step) => step.run?.includes("pnpm exec electron-builder"))
      .map((step) => ({
        label: `${workflow} ${job}: ${step.name ?? step.id}`,
        run: step.run ?? "",
        kept,
      }));
  });
  const electron = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")) as {
    version: string;
  };
  const zipName = (zip: string) => `electron-v${electron.version}-${zip}.zip`;
  let folder: string;
  let server: Server;
  let asked: string[];
  let served: Record<string, string>;

  beforeEach(async () => {
    folder = scratchDir("infinitary-electron-zips-");
    asked = [];
    // A zip's bytes stand in for Electron's; the checksums name them as
    // Electron's own package names its zips'.
    const zips = Object.fromEntries(
      ["darwin-arm64", "darwin-x64", "linux-x64"].map((zip) => [zipName(zip), `the ${zip} zip`]),
    );
    const sums = Object.fromEntries(
      Object.entries(zips).map(([name, body]) => [
        name,
        createHash("sha256").update(body).digest("hex"),
      ]),
    );
    served = { ...zips };
    server = createServer((request, response) => {
      const name = basename(request.url ?? "");
      asked.push(name);
      if (name === "SHASUMS256.txt") {
        response.end(
          Object.entries(sums)
            .map(([file, sum]) => `${sum} *${file}`)
            .join("\n"),
        );
      } else if (served[name] !== undefined) {
        response.end(served[name]);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    // The checkout a step runs in: electron-builder's configuration, the
    // zips' reader where the job's checkout and the workflow's own tooling
    // checkout keep it, the real electron-builder, and an Electron package.
    const project = join(folder, "project");
    for (const tooling of ["", ".release-tooling"]) {
      const action = join(project, tooling, ".github", "actions", "electron-download");
      mkdirSync(action, { recursive: true });
      copyFileSync(
        join(repoRoot, ".github/actions/electron-download/zips.mjs"),
        join(action, "zips.mjs"),
      );
    }
    for (const file of [
      "electron-builder.yml",
      "electron-builder.dev.yml",
      "electron-builder.linux.yml",
    ])
      copyFileSync(join(repoRoot, file), join(project, file));
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "infinitary", version: "0.0.0", description: "", author: "" }),
    );
    const electronDir = join(project, "node_modules", "electron");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(join(electronDir, "package.json"), JSON.stringify(electron));
    writeFileSync(join(electronDir, "checksums.json"), JSON.stringify(sums));
    symlinkSync(
      dirname(realpathSync(require.resolve("electron-builder/package.json"))),
      join(project, "node_modules", "electron-builder"),
    );
    const bin = join(folder, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), STAND_IN_PNPM, { mode: 0o755 });
    for (const dir of ["home", "tmp", "cache"]) mkdirSync(join(folder, dir));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Runs `script` as a job's shell does, in the checkout, and returns its
   * exit status, its output and the zips pnpm's stand-in read, if it ran.
   */
  async function run(script: string, kept: boolean) {
    const read = join(folder, "read.json");
    rmSync(read, { force: true });
    // The machine running these tests may itself be a CI job whose Electron
    // download step set electron_config_cache for every later step, as the
    // merge batch run 42472207286's Linux integration job had. A job without
    // that step never has it, so the step sees only the cache its own job
    // names: inherited, its zips' reader filled that outside cache while
    // electron-builder read its default one and asked the release server again.
    const { electron_config_cache: _outerCache, ...outer } = hostEnv();
    const { status, output } = await new Promise<{ status: number | null; output: string }>(
      (resolve) => {
        const child = spawn("bash", ["--noprofile", "--norc", "-e", "-c", script], {
          cwd: join(folder, "project"),
          env: {
            ...outer,
            PATH: `${join(folder, "bin")}${delimiter}${outer.PATH ?? ""}`,
            HOME: join(folder, "home"),
            XDG_CACHE_HOME: join(folder, "home", ".cache"),
            TMPDIR: join(folder, "tmp"),
            ...(kept ? { electron_config_cache: join(folder, "cache") } : {}),
            ELECTRON_MIRROR: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
            VERSION: "0.0.0",
            BUNDLE_VERSION: "0.0.0",
            ZIPS_READ: read,
          },
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("close", (status) => resolve({ status, output }));
      },
    );
    const zips = existsSync(read) ? (JSON.parse(readFileSync(read, "utf8")) as string[]) : null;
    return { status, output, zips };
  }

  /** Runs `script` and expects it to succeed, returning its output and the zips pnpm's stand-in read. */
  async function succeed(script: string, kept: boolean) {
    const { status, output, zips } = await run(script, kept);
    expect(status, output).toBe(0);
    return { output, zips: zips ?? [] };
  }

  it("finds the Mac check's package step and the release's Mac and Linux ones", () => {
    expect(steps.map(({ label }) => label)).toEqual([
      ".github/workflows/verify.yml lane: Package the universal app",
      ".github/workflows/release.yml release: Package and sign the universal app",
      ".github/workflows/linux-packages.yml build: Build the Ubuntu package, the Fedora package and the AppImage",
    ]);
  });

  for (const { label, run: script, kept } of steps) {
    it(`${label} reads its zips from the download cache, asking the release server only for what it lacks`, async () => {
      // A cache's first job: the cache lacks the zips, so the step downloads
      // each once, checked against Electron's checksums, never SHASUMS256.txt.
      const first = await succeed(script, kept);
      expect(first.zips).toHaveLength(script.includes("--universal") ? 2 : 1);
      expect(asked.toSorted()).toEqual(first.zips.map((zip) => basename(zip)).toSorted());
      const cache = kept ? join(folder, "cache") : join(folder, "home");
      for (const zip of first.zips) expect(zip.startsWith(cache + sep), zip).toBe(true);
      expect(first.output).toContain("was downloaded into the download cache");

      // Every later job finds that cache, and the step asks for nothing.
      asked = [];
      const later = await succeed(script, kept);
      expect(later.zips).toEqual(first.zips);
      expect(asked).toEqual([]);
      expect(later.output).not.toContain("was downloaded into");
      expect(later.output).toContain("was already in the download cache");
    });

    // electron-builder reads the cache with its own checksum download off,
    // so the check against Electron's checksums before it is the one a zip gets.
    it(`${label} stops before packaging when a downloaded zip is not the one Electron's checksums name`, async () => {
      for (const name of Object.keys(served)) served[name] = "a zip Electron never published";
      const { status, output, zips } = await run(script, kept);
      expect(status, output).not.toBe(0);
      expect(output).toMatch(/checksum/i);
      expect(zips).toBeNull();
    });
  }

  it("asked the release server for each zip's checksum file as the Mac check's step stood", async () => {
    await succeed(
      "pnpm exec electron-builder --mac dir --universal --config electron-builder.dev.yml",
      true,
    );
    expect(asked.filter((name) => name === "SHASUMS256.txt")).toHaveLength(2);
  });
});

/**
 * Stands in for `pnpm exec electron-builder ...` in a package step: reads
 * its arguments with electron-builder's own command line and its
 * configuration with electron-builder's own packager, then fetches the
 * Electron zip for each arch it packages through electron-builder's own
 * Electron download, with the options its packager passes
 * (app-builder-lib's ElectronFramework spreads the configuration's
 * electronDownload over the platform, arch and version), and records each
 * zip's path. A universal Mac package packages x64 and then arm64; the Linux
 * packages are x64 alone (electron-builder.linux.yml).
 */
const STAND_IN_PNPM = `#!/usr/bin/env node
const { createRequire } = require("node:module");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [, , exec, tool, ...args] = process.argv;
if (exec !== "exec" || tool !== "electron-builder") throw new Error("not electron-builder: " + process.argv.slice(2).join(" "));
const project = createRequire(join(process.cwd(), "package.json"));
const builder = createRequire(project.resolve("electron-builder/package.json"));
const cli = builder("./out/builder.js");
const lib = createRequire(builder.resolve("app-builder-lib/package.json"));
const { Packager } = lib("./out/packager.js");
const { downloadElectronArtifactZip } = lib("./out/util/electronGet.js");
const { version } = project("electron/package.json");
const platform = args.includes("--linux") ? "linux" : "darwin";
const arches = args.includes("--universal") ? ["x64", "arm64"] : ["x64"];
(async () => {
  const packager = new Packager(cli.normalizeOptions(cli.configureBuildCommand(cli.createYargs()).parse(args)));
  await packager.validateConfig();
  const zips = [];
  for (const arch of arches)
    zips.push(await downloadElectronArtifactZip({
      electronDownload: { platform, arch, version, ...packager.config.electronDownload },
      artifactName: "electron",
      platformName: platform,
      arch,
      version,
    }));
  writeFileSync(process.env.ZIPS_READ, JSON.stringify(zips));
})().catch((error) => { console.error(error); process.exit(1); });
`;
