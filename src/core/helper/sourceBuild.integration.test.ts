import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DeviceGrant } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type BackgroundContext,
  readInstalled,
  serviceLabel,
  startInBackground,
} from "./background";
import {
  buildIdentityOf,
  buildSourceHere,
  runsSourceBuild,
  SOURCE_BUILD_FILE,
  type StepRunner,
  sourceBuildDir,
} from "./sourceBuild";

// INF-5635's plan, piece 3: Match sends a committed source archive that a Mac builds and runs;
// a failing build leaves it on its old copy and says why.

const COMMIT = "d".repeat(40);
const GRANT = { deviceId: "mini", at: "127.0.0.1:1", homeKey: "k" } as unknown as DeviceGrant;
const LAUNCHER = { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] };

/** A Mac's background set up for the installed app, with launchctl a stand-in that writes down what it was asked. */
async function macAt() {
  const homeDir = scratchDir("infinitary-source-home-");
  const context: BackgroundContext = {
    flavor: "dev",
    dataDir: join(scratchDir("infinitary-source-"), "work"),
    homeDir,
    uid: 502,
    launchctl: async () => ({ ok: true, output: "" }),
  };
  await startInBackground(context, { launcher: LAUNCHER, env: {}, app: null });
  const agent = join(homeDir, "Library", "LaunchAgents", `${serviceLabel("dev")}.plist`);
  return { context, agent };
}

/** The home's committed tree as one gzipped tar, which the stand-in home sends to the sink. */
function homeSource() {
  const tree = scratchDir("infinitary-source-tree-");
  writeFileSync(join(tree, "package.json"), '{"name":"infinitary","main":"out/main/index.js"}');
  writeFileSync(join(tree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const archive = join(scratchDir("infinitary-source-archive-"), "source.tar.gz");
  expect(spawnSync("/usr/bin/tar", ["-czf", archive, "-C", tree, "."]).status).toBe(0);
  return (async (_grant, sink) => {
    await pipeline(createReadStream(archive), sink as NodeJS.WritableStream);
  }) as typeof import("../devices/dial").fetchFromHome;
}

/** The steps a build runs, as a stand-in: install puts Electron in place, build writes the app. */
function steps(fail?: "install" | "build"): { run: StepRunner; ran: string[][] } {
  const ran: string[][] = [];
  const run: StepRunner = async (file, args, { cwd }) => {
    ran.push([file, ...args]);
    if (args[0] === "install") {
      if (fail === "install") return { code: 1, tail: "ERR_PNPM_FETCH_404 electron" };
      const electron = join(cwd, "node_modules", "electron");
      mkdirSync(join(electron, "dist", "Electron.app", "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(electron, "path.txt"), "Electron.app/Contents/MacOS/Electron");
      return { code: 0, tail: "" };
    }
    if (args.includes("build")) {
      if (fail === "build") return { code: 1, tail: "error during build" };
      mkdirSync(join(cwd, "out", "main"), { recursive: true });
    }
    return { code: 0, tail: "" };
  };
  return { run, ran };
}

describe("building the home's source on a Mac", () => {
  it("installs and builds the home's commit, writes what it built, and starts its background from it", async () => {
    const { context, agent } = await macAt();
    const { run, ran } = steps();
    const said: string[] = [];
    const built = await buildSourceHere({
      dataDir: context.dataDir,
      grant: GRANT,
      commit: COMMIT,
      background: { context, env: {} },
      platform: "darwin",
      tools: { node: "/usr/local/bin/node", pnpm: "/usr/local/bin/pnpm" },
      run,
      fetch: homeSource(),
      onStep: (step) => said.push(step),
    });
    expect(built).toEqual(expect.objectContaining({ restarts: true }));
    expect(said).toEqual(["fetching", "installing", "building"]);
    expect(ran.map((step) => step.slice(1).join(" "))).toEqual([
      "install --frozen-lockfile",
      "scripts/prepare-local-codesign.mjs",
      "node_modules/electron-vite/bin/electron-vite.js build",
    ]);
    const dir = sourceBuildDir(context.dataDir, COMMIT);
    expect(JSON.parse(readFileSync(join(dir, SOURCE_BUILD_FILE), "utf8"))).toEqual({
      version: 1,
      commit: COMMIT,
      lockDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // The agent starts that build's Electron with the build's folder, and the run it starts names the commit.
    const plist = readFileSync(agent, "utf8");
    expect(plist).toContain(
      `<string>${join(dir, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")}</string>`,
    );
    expect(plist).toContain(`<string>${dir}</string>`);
    expect(buildIdentityOf({ packaged: false, appDir: dir })).toEqual({
      commit: COMMIT,
      source: { edited: false, lockDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(runsSourceBuild(context.dataDir, dir, false)).toBe(true);
  });

  it("changes nothing and says the step when its install fails", async () => {
    const { context, agent } = await macAt();
    const before = readFileSync(agent, "utf8");
    const built = await buildSourceHere({
      dataDir: context.dataDir,
      grant: GRANT,
      commit: COMMIT,
      background: { context, env: {} },
      platform: "darwin",
      tools: { node: "/usr/local/bin/node", pnpm: "/usr/local/bin/pnpm" },
      run: steps("install").run,
      fetch: homeSource(),
    });
    expect(built).toEqual({ failed: "install", detail: "ERR_PNPM_FETCH_404 electron" });
    expect(readFileSync(agent, "utf8")).toBe(before);
    expect(readInstalled(context.dataDir).app).toBeNull();
    expect(existsSync(sourceBuildDir(context.dataDir, COMMIT))).toBe(false);
  });

  it("refuses with nothing tried on a computer that is not a Mac, or has no Node and pnpm", async () => {
    const { context } = await macAt();
    const asked = { dataDir: context.dataDir, grant: GRANT, commit: COMMIT };
    const background = { context, env: {} };
    expect(await buildSourceHere({ ...asked, background, platform: "linux" })).toEqual({
      failed: "system",
    });
    expect(
      await buildSourceHere({ ...asked, background, platform: "darwin", tools: null }),
    ).toEqual({ failed: "tools" });
  });
});

describe("the build a run says it is", () => {
  it("names an installed release's commit, and no commit for a run from source it did not build", () => {
    expect(buildIdentityOf({ packaged: true, appDir: "/x", releaseCommit: COMMIT })).toEqual({
      commit: COMMIT,
    });
    const checkout = scratchDir("infinitary-source-checkout-");
    expect(buildIdentityOf({ packaged: false, appDir: checkout })).toEqual({
      source: { edited: false },
    });
    expect(runsSourceBuild(join(checkout, "work"), checkout, false)).toBe(false);
  });
});
