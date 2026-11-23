import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloneOrCopy } from "../scripts/clone-or-copy.ts";
import { appExecutable } from "../src/main/appExecutable";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The app's own executables on a Mac (scripts/mac-app-launcher.m;
 * docs/run.md, "Opened while it runs"), put in place by the packaging step
 * itself (scripts/place-mac-app-launcher.mjs) in a stand-in app: Electron's
 * own bundle under a name of its own, whose code reports, from each start,
 * the file it runs and where macOS lists that copy. A start that shows no
 * window runs from the background file and is listed there, and a window's
 * start runs from the main executable and is listed at the bundle, so a
 * click on the app while only a frozen run is up starts a window instead of
 * waiting on it.
 */

const root = join(__dirname, "..");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const BUNDLE_ID = "com.example.infinitary-start-check";
const NAME = "Start Check";
/**
 * Five times the slowest case's fastest run on a Mac, an Electron start of
 * the stand-in 3.0 s (docs/test-cohorts.md, "Budgets").
 */
const START_BUDGET_MS = 15_000;
/** Five times the stand-in's making on a Mac, 1.2 s. */
const MAKE_BUDGET_MS = 10_000;

type Report = {
  pid: number;
  word: string | null;
  /** The file the copy runs, as the app's code reads it before it names its own program. */
  file: string;
  place: string | null;
  ready?: true;
};

/**
 * The stand-in's code: every start says which file it runs and where macOS
 * lists it once it is ready. `run` stays up as the background run does - no Dock icon, a hidden
 * page so Chromium's other processes start too; every other start ends
 * there.
 */
function standInCode(report: string, home: string): string {
  return `const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const words = process.argv.slice(1).filter((word) => !word.startsWith("--"));
app.setPath("userData", ${JSON.stringify(home)} + "/user-data-" + process.pid);
app.setActivationPolicy(words[0] === "run" ? "prohibited" : "accessory");
const say = (fact) =>
  appendFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, word: words[0] ?? null, file: process.execPath, ...fact }) + "\\n");
// macOS 27 answers in the whole record's words, bundle path="<path>"; macOS 26
// names the key alone, "LSBundlePath"="<path>".
const place = () => {
  const listed = execFileSync("/usr/bin/lsappinfo", ["info", "-only", "bundlepath", String(process.pid)], { encoding: "utf8" });
  return /(?:bundle path|"LSBundlePath")="([^"]*)"/.exec(listed)?.[1] ?? null;
};
app.whenReady().then(async () => {
  if (words[0] === "run") await new BrowserWindow({ show: false }).loadURL("data:text/html,run");
  say({ place: place(), ready: true });
  if (words[0] !== "run") app.quit();
});
`;
}

function reports(file: string): Report[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report);
}

function reported(file: string, matches: (line: Report) => boolean): Promise<Report> {
  return vi.waitFor(
    () => {
      const found = reports(file).find(matches);
      if (!found) throw new Error(`no such report among: ${JSON.stringify(reports(file))}`);
      return found;
    },
    { interval: 100 },
  );
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every process started from the stand-in app's folder, its helpers included. */
function standInProcesses(app: string): number[] {
  const listed = execFileSync("/bin/ps", ["-axwwo", "pid=,command="], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((line) => line.includes(app))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

describe.skipIf(process.platform !== "darwin")("the app's own executables on a Mac", () => {
  let app = "";
  let executable = "";
  let background = "";
  let home = "";
  let report = "";
  const started: ChildProcess[] = [];

  const start = (args: string[], file = executable): ChildProcess => {
    const child = spawn(file, args, {
      env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home, ELECTRON_RUN_AS_NODE: "" },
      stdio: "ignore",
    });
    started.push(child);
    return child;
  };
  const ended = (child: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });

  beforeAll(() => {
    const dir = realpathSync(scratchDir("infinitary-app-launcher-"));
    home = join(dir, "home");
    mkdirSync(home);
    report = join(dir, "report.jsonl");
    app = join(dir, `${NAME}.app`);
    cloneOrCopy(join(root, "node_modules", "electron", "dist", "Electron.app"), app);
    // Named as electron-builder names a packaged app: the main executable,
    // and Chromium's helpers, which Electron finds by the app's name in its
    // Info.plist - so a copy that started without the app's own info would
    // find none and stop.
    const plist = (key: string, value: string, file: string) =>
      execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, file]);
    const info = join(app, "Contents", "Info.plist");
    plist("CFBundleIdentifier", BUNDLE_ID, info);
    plist("CFBundleName", NAME, info);
    plist("CFBundleExecutable", NAME, info);
    renameSync(join(app, "Contents", "MacOS", "Electron"), join(app, "Contents", "MacOS", NAME));
    const frameworks = join(app, "Contents", "Frameworks");
    for (const helper of readdirSync(frameworks).filter((entry) =>
      entry.startsWith("Electron Helper"),
    )) {
      const named = helper.replace("Electron", NAME).replace(/\.app$/, "");
      const was = helper.replace(/\.app$/, "");
      renameSync(join(frameworks, helper), join(frameworks, `${named}.app`));
      const contents = join(frameworks, `${named}.app`, "Contents");
      renameSync(join(contents, "MacOS", was), join(contents, "MacOS", named));
      plist("CFBundleExecutable", named, join(contents, "Info.plist"));
      plist("CFBundleName", named, join(contents, "Info.plist"));
    }
    const code = join(app, "Contents", "Resources", "app");
    mkdirSync(code);
    writeFileSync(
      join(code, "package.json"),
      JSON.stringify({ name: "start-check", main: "main.js" }),
    );
    writeFileSync(join(code, "main.js"), standInCode(report, home));
    // The packaging step itself, as electron-builder runs it on each bundle.
    const hook = pathToFileURL(join(root, "scripts", "place-mac-app-launcher.mjs")).href;
    const context = {
      electronPlatformName: "darwin",
      appOutDir: dir,
      packager: { appInfo: { productFilename: NAME } },
    };
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import place from ${JSON.stringify(hook)}; place(${JSON.stringify(context)});`,
    ]);
    executable = join(app, "Contents", "MacOS", NAME);
    background = `${executable} Background`;
  }, MAKE_BUDGET_MS);

  afterAll(async () => {
    if (!app) return;
    for (const child of started) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGCONT");
      child.kill("SIGKILL");
      await ended(child);
    }
    // A window's copy macOS started, and Chromium's helpers, end with no
    // parent here: each is gone before the scratch folder goes.
    await vi.waitFor(
      () => {
        const left = standInProcesses(app);
        for (const pid of left) if (running(pid)) process.kill(pid, "SIGKILL");
        if (left.length > 0) throw new Error(`stand-in processes left running: ${left.join(" ")}`);
      },
      { interval: 100 },
    );
    execFileSync(LSREGISTER, ["-u", app]);
  });

  it("holds both Mac chips in each file", () => {
    for (const file of [executable, background]) {
      const chips = execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" });
      expect({ file, chips: chips.trim().split(" ").sort() }).toEqual({
        file,
        chips: ["arm64", "x86_64"],
      });
    }
  });

  it("records the macOS SDK Electron's own executable records, whichever developer tools compiled it", () => {
    // Each chip's SDK, as macOS reads it to choose a window's behaviors.
    const sdks = (file: string) =>
      execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", file], { encoding: "utf8" })
        .split("\n")
        .flatMap((line) => /^\s*sdk (\S+)$/.exec(line)?.[1] ?? []);
    const electron = sdks(
      join(
        root,
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron",
      ),
    );
    expect(new Set(electron).size).toBe(1);
    for (const file of [executable, background]) {
      expect({ file, sdks: sdks(file) }).toEqual({ file, sdks: [electron[0], electron[0]] });
    }
  });

  it("places the background file signed under the app's own bundle id, so the main executable signs beside it", () => {
    // codesign writes what it displays to the error stream.
    const identifier = (file: string) => {
      const shown = spawnSync("/usr/bin/codesign", ["--display", "--verbose=2", file], {
        encoding: "utf8",
      });
      expect(shown.status, shown.stderr).toBe(0);
      return shown.stderr.split("\n").find((line) => line.startsWith("Identifier="));
    };
    expect(identifier(background)).toBe(`Identifier=${BUNDLE_ID}`);
    // The signing pass may sign the main executable first, and its signature
    // seals the files beside it: codesign refuses one with no signature.
    const signed = spawnSync("/usr/bin/codesign", ["--sign", "-", "--force", executable], {
      encoding: "utf8",
    });
    expect(signed.status, signed.stderr).toBe(0);
    // Signed again, as the release's and a local package's signing pass signs
    // it: with no identifier named, codesign takes the file's own.
    execFileSync("/usr/bin/codesign", ["--sign", "-", "--force", background], { stdio: "ignore" });
    expect(identifier(background)).toBe(`Identifier=${BUNDLE_ID}`);
  });

  it(
    "runs as Node.js where Electron's run-as-Node fuse allows it, as Electron's executable does",
    () => {
      // Electron's own bundle leaves the fuse on; the app's packaging turns it off.
      const version = execFileSync(executable, ["-p", "process.versions.electron"], {
        env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
      });
      const electron = JSON.parse(
        readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8"),
      ) as { version: string };
      expect(version.trim()).toBe(electron.version);
    },
    START_BUDGET_MS,
  );

  it(
    "starts a window on a click while the run is frozen",
    async () => {
      const run = start(["run"]);
      const ready = await reported(report, (line) => line.pid === run.pid && line.ready === true);
      expect({ file: ready.file, place: ready.place }).toEqual({
        file: background,
        place: background,
      });
      // With only the run up, macOS lists no copy at the app a click names.
      const listed = (place: string) =>
        execFileSync("/usr/bin/lsappinfo", ["find", `bundlepath=${place}`], {
          encoding: "utf8",
        }).trim();
      expect(listed(app)).toBe("");
      expect(listed(background)).not.toBe("");
      const before = new Set(reports(report).map((line) => line.pid));
      // As a run whose main thread is stuck: it can answer nothing macOS sends.
      run.kill("SIGSTOP");
      try {
        // What a click on the app in the Dock, Finder or Spotlight asks of
        // macOS, the stand-in's home pinned as it is for the other starts.
        execFileSync("/usr/bin/open", [
          "-a",
          app,
          "--env",
          `HOME=${home}`,
          "--env",
          `CFFIXED_USER_HOME=${home}`,
        ]);
        const window = await reported(
          report,
          (line) => !before.has(line.pid) && line.ready === true,
        );
        expect({ word: window.word, file: window.file, place: window.place }).toEqual({
          word: null,
          file: executable,
          place: app,
        });
      } finally {
        run.kill("SIGCONT");
        run.kill("SIGKILL");
        await ended(run);
      }
    },
    START_BUDGET_MS,
  );

  it(
    "keeps a start on the main executable when the background file cannot take the app's info",
    async () => {
      // A pair of files whose name is not the one the app's Info.plist names
      // for its main executable: the background file cannot take that info
      // for them and hands each windowless start back.
      const other = join(app, "Contents", "MacOS", "Other Check");
      const otherBackground = `${other} Background`;
      for (const [from, to] of [
        [executable, other],
        [background, otherBackground],
      ] as const) {
        copyFileSync(from, to);
        chmodSync(to, 0o755);
      }
      try {
        const child = start(["status"], other);
        const said = await reported(
          report,
          (line) => line.pid === child.pid && line.ready === true,
        );
        await ended(child);
        expect({ word: said.word, file: said.file, place: said.place }).toEqual({
          word: "status",
          file: other,
          place: app,
        });
      } finally {
        rmSync(other, { force: true });
        rmSync(otherBackground, { force: true });
      }
    },
    START_BUDGET_MS,
  );

  it(
    "runs each start that shows no window from the background file, listed there, and a window's from the app",
    async () => {
      const starts: {
        args: string[];
        from?: "background";
        word: string | null;
        windowless: boolean;
      }[] = [
        { args: ["work", "version"], word: "work", windowless: true },
        { args: ["--no-sandbox", "work", "status"], word: "work", windowless: true },
        { args: ["status"], word: "status", windowless: true },
        { args: ["link"], word: "link", windowless: true },
        { args: ["start-at-boot", "--off"], word: "start-at-boot", windowless: true },
        { args: ["help"], word: "help", windowless: true },
        { args: [], word: null, windowless: false },
        { args: ["--enable-logging"], word: null, windowless: false },
        { args: ["elsewhere"], word: "elsewhere", windowless: false },
        // Started at the background file itself, each start still runs from its own file.
        { args: ["status"], from: "background", word: "status", windowless: true },
        { args: [], from: "background", word: null, windowless: false },
      ];
      for (const { args, from, word, windowless } of starts) {
        const child = start(args, from === "background" ? background : executable);
        const said = await reported(
          report,
          (line) => line.pid === child.pid && line.ready === true,
        );
        await ended(child);
        expect({ args, from, word: said.word, file: said.file, place: said.place }).toEqual({
          args,
          from,
          word,
          file: windowless ? background : executable,
          place: windowless ? background : app,
        });
        // Every place that starts the app again names its main executable.
        expect(appExecutable(said.file, "darwin")).toBe(executable);
      }
    },
    START_BUDGET_MS,
  );
});
