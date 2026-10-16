import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { describe, expect, it } from "vitest";
import { compareSemver } from "../src/core/update/semver";
import { BUNDLE_ID, renderCask } from "../src/core/update/tapPublication";
import {
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  resolveUpdateChannel,
  resolveUpdateTap,
  targetsUrlOf,
  UPDATE_CHANNEL_MARKER,
  UPDATE_TARGETS_FILE,
} from "../src/core/update/updateChannels";
import { createUpdateChecker } from "../src/core/update/updateChecker";
import { declaredStepOnly } from "./helpers/olderCask";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The casks and targets file as their real consumers read them
 * (docs/alpha.md "Casks and update targets"): the tap files the publication
 * CLI writes, tapped into a Homebrew of its own and installed, upgraded,
 * refused and switched by that Homebrew, then read back by the app's own
 * channel resolver and update reader.
 *
 * Everything runs in scratch state: a clone of the installed Homebrew with
 * its own prefix, Caskroom, cache and trust store; a scratch HOME (so the
 * casks' install step writes the marker into a scratch release data root);
 * a scratch Applications folder; and a local git repository standing in
 * for the public tap. The machine's own Homebrew is only read from (cloned),
 * never run, and nothing is downloaded: each download is the stand-in app
 * placed where Homebrew caches the cask's URL, which Homebrew still checks
 * against the cask's sha256. The stand-in has its own bundle id, and the
 * one test-only edit to the tap files points `uninstall quit` at it - the
 * real id would make Homebrew quit a Firstmate 3000 running on this Mac.
 *
 * macOS with Homebrew only; elsewhere the generator's own tests and
 * `brew style` in the release contract carry the casks.
 */

const root = join(__dirname, "..");
const STAND_IN_BUNDLE_ID = `${BUNDLE_ID}.cask-consumer-check`;
const TAP = "infinitary-labs/tap";
const COMMIT = "c".repeat(40);

function installedHomebrew(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const repository = execFileSync("brew", ["--repository"], { encoding: "utf8" }).trim();
    const ruby = join(repository, "Library", "Homebrew", "vendor", "portable-ruby");
    return existsSync(join(repository, ".git")) && existsSync(ruby) ? repository : null;
  } catch {
    return null;
  }
}

const homebrew = process.env.INFINITARY_CASK_HOMEBREW_REPOSITORY ?? installedHomebrew();

type Run = { status: number | null; stdout: string; stderr: string };

/** The scratch world: an isolated Homebrew, its tap, and the stand-in artifacts. */
function scratchWorld(installed: string, version: string) {
  const dir = realpathSync(scratchDir("infinitary-cask-consumers-"));
  const prefix = join(dir, "homebrew");
  const home = join(dir, "home");
  const applications = join(dir, "Applications");
  const tap = join(dir, "tap");
  const artifacts = join(dir, "artifacts");
  for (const path of [home, applications, tap, artifacts, join(dir, "tmp")]) {
    mkdirSync(path, { recursive: true });
  }

  // Nothing of the machine's own Homebrew, git or XDG configuration rides along.
  const base = hostEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^(HOMEBREW_|XDG_|GIT_|NO_PROXY$|no_proxy$)/.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    HOMEBREW_CACHE: join(dir, "cache"),
    HOMEBREW_LOGS: join(dir, "logs"),
    HOMEBREW_TEMP: join(dir, "tmp"),
    HOMEBREW_CASK_OPTS: `--appdir=${applications}`,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_DEVELOPER: "1",
    HOMEBREW_NO_INSTALL_FROM_API: "1",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    // Offline by construction: any request Homebrew tried would fail here
    // rather than download.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
  });

  const run = (command: string, args: string[], cwd = dir): Run => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const ok = (command: string, args: string[], cwd = dir): string => {
    const result = run(command, args, cwd);
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
    }
    if (command.endsWith("/bin/brew")) {
      console.info(`Homebrew ${version}: ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    }
    return result.stdout;
  };
  const git = (cwd: string, ...args: string[]) =>
    ok(
      "git",
      [
        "-c",
        "user.name=cask check",
        "-c",
        "user.email=check@invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      cwd,
    );

  // A Homebrew of its own: a clone of the installed one's repository (its
  // objects borrowed read-only) and copies of its vendored Ruby and gems
  // (clonefile on APFS). Nothing of the installed Homebrew is written.
  git(dir, "clone", "--quiet", "--shared", installed, prefix);
  if (version !== "current") git(prefix, "checkout", "--quiet", version);
  for (const vendored of ["portable-ruby", "bundle"]) {
    const from = join(installed, "Library", "Homebrew", "vendor", vendored);
    if (existsSync(from)) {
      ok("cp", ["-cR", from, join(prefix, "Library", "Homebrew", "vendor", vendored)]);
    }
  }
  // With the API off, Homebrew would clone homebrew/core (1.4 GB) on the
  // first upgrade; an empty core tap answers its "is core installed" check,
  // and no formula is ever installed here.
  const core = join(prefix, "Library", "Taps", "homebrew", "homebrew-core");
  mkdirSync(join(core, "Formula"), { recursive: true });
  git(core, "init", "--quiet", "--initial-branch=main");
  git(core, "commit", "--quiet", "--allow-empty", "-m", "empty core");
  const brewBin = join(prefix, "bin", "brew");
  const brew = (...args: string[]) => run(brewBin, args);
  const brewOk = (...args: string[]) => ok(brewBin, args);

  // The stand-in app: the real bundle's name and shape, the stand-in's id,
  // numeric bundle versions, and its logical version where the test reads it.
  const artifactsByVersion = new Map<string, { zip: string; sha256: string }>();
  const standIn = (version: string, name = "Infinitary", bundleId = STAND_IN_BUNDLE_ID) => {
    const known = artifactsByVersion.get(`${name} ${version}`);
    if (known) return known;
    const app = join(artifacts, name, version, `${name}.app`);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    const core = version.replace(/-.*$/, "");
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${core}</string>
<key>CFBundleVersion</key><string>${core}</string>
</dict></plist>
`,
    );
    writeFileSync(join(app, "Contents", "MacOS", name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(join(app, "Contents", "Resources", "logical-version"), version);
    const zip = join(artifacts, `${name.replaceAll(" ", "-")}-${version}-universal.zip`);
    ok("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
    const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
    const made = { zip, sha256 };
    artifactsByVersion.set(`${name} ${version}`, made);
    return made;
  };

  // The tap stand-in: a local repository the CLI writes and Homebrew taps.
  git(tap, "init", "--quiet", "--initial-branch=main");
  git(tap, "commit", "--quiet", "--allow-empty", "-m", "tap");

  /**
   * Commit what the CLI wrote to the tap, with the one test-only edit to
   * each cask it wrote: `uninstall quit` names the stand-in.
   */
  const commitWritten = (result: Run, message: string, into = tap): Run => {
    if (result.status !== 0) return result;
    for (const file of (JSON.parse(result.stdout) as { files: string[] }).files) {
      if (!file.startsWith("Casks/")) continue;
      const path = join(into, file);
      const cask = readFileSync(path, "utf8");
      const real = `uninstall quit: "${BUNDLE_ID}"`;
      expect(cask.split(real)).toHaveLength(2);
      writeFileSync(path, cask.replace(real, `uninstall quit: "${STAND_IN_BUNDLE_ID}"`));
    }
    git(into, "add", "--all");
    git(into, "commit", "--quiet", "--allow-empty", "-m", message);
    return result;
  };

  /** One publication through the real CLI, committed to the tap as one commit. */
  const publish = (channel: "stable" | "alpha", version: string): Run => {
    const { sha256 } = standIn(version);
    const result = run(process.execPath, [
      join(root, "scripts", "tap-publication.ts"),
      "advance",
      ...["--tap", tap, "--channel", channel, "--version", version],
      ...["--asset", `Infinitary-${version}-universal.zip`],
      ...["--sha256", sha256, "--source-commit", COMMIT],
    ]);
    return commitWritten(result, `${channel} ${version}`);
  };

  /** Both casks on the tap as an older generator wrote them: the declared marker step alone. */
  const writeOlderCasks = () => {
    for (const token of Object.values(CASK_TOKENS)) {
      const path = join(tap, "Casks", `${token}.rb`);
      writeFileSync(path, declaredStepOnly(readFileSync(path, "utf8")));
    }
    git(tap, "commit", "--quiet", "--all", "-m", "older casks");
  };

  /** The republication through the real CLI, committed to the tap as one commit. */
  const republish = (): Run =>
    commitWritten(
      run(process.execPath, [
        join(root, "scripts", "tap-publication.ts"),
        "republish",
        "--tap",
        tap,
      ]),
      "republished casks",
    );

  /** `brew update`'s part for this tap: fetch the tap's new commit. */
  const updateTap = (name = TAP) =>
    git(brewOk("--repository", name).trim(), "pull", "--quiet", "--ff-only");

  /**
   * Place the download of what a cask carries where Homebrew caches its URL:
   * the stand-in of the app `app` names, at the cask's version.
   */
  const cacheDownload = (token: string, name = TAP, app?: { name: string; bundleId: string }) => {
    const tapped = brewOk("--repository", name).trim();
    const version = /^ {2}version "([^"]+)"$/m.exec(
      readFileSync(join(tapped, "Casks", `${token}.rb`), "utf8"),
    )?.[1] as string;
    const cached = brewOk("--cache", "--cask", `${name}/${token}`).trim();
    mkdirSync(join(cached, ".."), { recursive: true });
    cpSync(standIn(version, app?.name, app?.bundleId).zip, cached);
  };

  const appSupport = join(home, "Library", "Application Support");
  const dataRoot = join(appSupport, "infinitary");
  const installedVersion = (app = "Infinitary") =>
    readFileSync(
      join(applications, `${app}.app`, "Contents", "Resources", "logical-version"),
      "utf8",
    );
  const marker = (root = dataRoot) => {
    const value = JSON.parse(readFileSync(join(root, UPDATE_CHANNEL_MARKER), "utf8"));
    console.info(`Homebrew ${version}: marker ${JSON.stringify(value)}`);
    return value;
  };

  /** Everything under a data root but the installer's marker, by path and bytes. */
  const savedWork = (root = dataRoot) => {
    const files: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full !== join(root, UPDATE_CHANNEL_MARKER)) {
          files.push(
            `${relative(root, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
          );
        }
      }
    };
    walk(root);
    return files.sort();
  };

  /** The app's own reader, on the installed version and marker, against the tap's targets file. */
  const offered = async () => {
    const version = installedVersion();
    const tapped = brewOk("--repository", TAP).trim();
    const checker = createUpdateChecker({
      currentVersion: version,
      channel: () => resolveUpdateChannel(dataRoot, version),
      fetchImpl: async () => new Response(readFileSync(join(tapped, UPDATE_TARGETS_FILE), "utf8")),
    });
    return checker.getStatus();
  };

  return {
    dir,
    git,
    run,
    prefix,
    home,
    tap,
    applications,
    appSupport,
    dataRoot,
    standIn,
    commitWritten,
    brew,
    brewOk,
    publish,
    writeOlderCasks,
    republish,
    updateTap,
    cacheDownload,
    installedVersion,
    marker,
    savedWork,
    offered,
  };
}

describe.skipIf(!homebrew)("the casks under a real Homebrew, in scratch state", () => {
  const versions = (process.env.INFINITARY_CASK_HOMEBREW_VERSIONS ?? "current").split(",");
  it.each(versions)(
    "Homebrew %s installs, refuses, upgrades and switches channels, keeping saved work",
    async (version) => {
      const world = scratchWorld(homebrew as string, version);
      const { brew, brewOk } = world;

      // -- Isolation: this Homebrew's prefix, Caskroom and trust store are scratch.
      expect(brewOk("--prefix").trim()).toBe(world.prefix);
      expect(brewOk("--caskroom").trim()).toBe(join(world.prefix, "Caskroom"));

      // -- Saved work the person already has in the release data root.
      mkdirSync(join(world.dataRoot, "crewmates", "c1", "sessions"), { recursive: true });
      writeFileSync(join(world.dataRoot, "firstmate.db"), "seeded database bytes");
      writeFileSync(
        join(world.dataRoot, "crewmates", "c1", "sessions", "s1.jsonl"),
        '{"seeded":true}\n',
      );
      writeFileSync(join(world.dataRoot, "saved-data.json"), '{"schemaVersion":1,"revision":1}\n');
      const seeded = world.savedWork();
      expect(seeded).toHaveLength(3);

      // -- First stable publication: both casks, one tap commit.
      expect(JSON.parse(world.publish("stable", "0.1.25").stdout).changed).toEqual([
        "stable",
        "alpha",
      ]);
      brewOk("tap", TAP, world.tap);
      // Tap trust arrived after Homebrew 5; older versions need no trust store.
      if (!version.startsWith("5.")) {
        brewOk("trust", TAP);
        expect(existsSync(join(world.home, ".homebrew", "trust.json"))).toBe(true);
      }
      // Homebrew's reading of both tapped casks. Its style cops are the release
      // contract's `brew style` of the same generator's output; `brew audit`
      // installs gems and taps homebrew/core over the network, so it is a
      // recorded one-off, not part of this check.
      const info = JSON.parse(
        brewOk(
          "info",
          "--json=v2",
          "--cask",
          `${TAP}/${CASK_TOKENS.stable}`,
          `${TAP}/${CASK_TOKENS.alpha}`,
        ),
      ) as {
        casks: {
          token: string;
          conflicts_with: { cask: string[] };
          artifacts: Record<string, unknown>[];
        }[];
      };
      for (const cask of info.casks) {
        const other = cask.token === CASK_TOKENS.stable ? CASK_TOKENS.alpha : CASK_TOKENS.stable;
        expect(cask.conflicts_with.cask).toEqual([other]);
        // Homebrew's own reading: quit the app before replacing it, then the step.
        expect(cask.artifacts).toContainEqual({ uninstall: [{ quit: STAND_IN_BUNDLE_ID }] });
        if (version === "current" || version === "6.0.15") {
          expect(JSON.stringify(cask.artifacts)).toContain('"type":"write"');
        } else {
          expect(cask.artifacts.some((artifact) => "postflight" in artifact)).toBe(true);
        }
      }

      // -- Install alpha, which carries the stable artifact: it still records alpha.
      world.cacheDownload(CASK_TOKENS.alpha);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.alpha}`);
      expect(world.installedVersion()).toBe("0.1.25");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });
      expect(resolveUpdateChannel(world.dataRoot, "0.1.25")).toBe("alpha");
      expect(world.savedWork()).toEqual(seeded);

      // -- The stable cask refuses to install beside it.
      world.cacheDownload(CASK_TOKENS.stable);
      const beside = brew("install", "--cask", `${TAP}/${CASK_TOKENS.stable}`);
      expect(beside.status).not.toBe(0);
      expect(`${beside.stdout}${beside.stderr}`).toMatch(/conflicts with/);
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });

      // -- An alpha publication moves alpha alone; the alpha installation upgrades to it.
      expect(JSON.parse(world.publish("alpha", "0.1.26-alpha.43").stdout).changed).toEqual([
        "alpha",
      ]);
      world.updateTap();
      expect(await world.offered()).toMatchObject({
        channel: "alpha",
        latestVersion: "0.1.26-alpha.43",
        updateAvailable: true,
        upgradeCommand: "brew update && brew upgrade --cask infinitary@alpha",
      });
      world.cacheDownload(CASK_TOKENS.alpha);
      brewOk("upgrade", "--cask", CASK_TOKENS.alpha);
      expect(world.installedVersion()).toBe("0.1.26-alpha.43");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });
      expect(world.savedWork()).toEqual(seeded);

      // -- A late, older alpha is refused and leaves the tap as it was.
      const tapHead = world.git(world.tap, "rev-parse", "HEAD");
      const late = world.publish("alpha", "0.1.26-alpha.42");
      expect(late.status).toBe(1);
      expect(late.stderr).toMatch(/never moves backwards/);
      expect(world.git(world.tap, "rev-parse", "HEAD")).toBe(tapHead);
      expect(world.git(world.tap, "status", "--porcelain")).toBe("");

      // -- A newer stable moves both; alpha receives it and stays on alpha.
      expect(JSON.parse(world.publish("stable", "0.1.26").stdout).changed).toEqual([
        "stable",
        "alpha",
      ]);
      world.updateTap();
      world.cacheDownload(CASK_TOKENS.alpha);
      brewOk("upgrade", "--cask", CASK_TOKENS.alpha);
      expect(world.installedVersion()).toBe("0.1.26");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });
      expect(await world.offered()).toMatchObject({ channel: "alpha", updateAvailable: false });

      // -- Switch to stable, same artifact: the stable install overwrites the marker.
      brewOk("uninstall", "--cask", CASK_TOKENS.alpha);
      expect(existsSync(join(world.dataRoot, UPDATE_CHANNEL_MARKER))).toBe(true);
      expect(world.savedWork()).toEqual(seeded);
      world.cacheDownload(CASK_TOKENS.stable);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.stable}`);
      expect(world.installedVersion()).toBe("0.1.26");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "stable" });
      expect(world.savedWork()).toEqual(seeded);

      // -- A newer alpha is never offered to the stable installation.
      expect(JSON.parse(world.publish("alpha", "0.1.28-alpha.50").stdout).changed).toEqual([
        "alpha",
      ]);
      world.updateTap();
      expect(await world.offered()).toMatchObject({
        channel: "stable",
        latestVersion: "0.1.26",
        updateAvailable: false,
        upgradeCommand: "brew update && brew upgrade --cask infinitary",
      });
      expect(brewOk("outdated", "--cask", "--greedy").trim()).toBe("");

      // -- Back to alpha: the newer alpha installs and records alpha again.
      brewOk("uninstall", "--cask", CASK_TOKENS.stable);
      world.cacheDownload(CASK_TOKENS.alpha);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.alpha}`);
      expect(world.installedVersion()).toBe("0.1.28-alpha.50");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });

      // -- A stable that finishes after a newer alpha moves stable alone.
      expect(JSON.parse(world.publish("stable", "0.1.27").stdout).changed).toEqual(["stable"]);
      world.updateTap();
      expect(brewOk("outdated", "--cask", "--greedy").trim()).toBe("");
      expect(await world.offered()).toMatchObject({
        channel: "alpha",
        latestVersion: "0.1.28-alpha.50",
        updateAvailable: false,
      });

      // -- Uninstalling never touches saved work; only zap would, and it is never run here.
      brewOk("uninstall", "--cask", CASK_TOKENS.alpha);
      expect(world.savedWork()).toEqual(seeded);
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });

      // -- Stable also upgrades and overwrites a stale channel marker.
      world.cacheDownload(CASK_TOKENS.stable);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.stable}`);
      expect(world.installedVersion()).toBe("0.1.27");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "stable" });
      expect(JSON.parse(world.publish("stable", "0.1.28").stdout).changed).toEqual([
        "stable",
        "alpha",
      ]);
      world.updateTap();
      writeFileSync(
        join(world.dataRoot, UPDATE_CHANNEL_MARKER),
        '{"schemaVersion":1,"channel":"alpha"}\n',
      );
      world.cacheDownload(CASK_TOKENS.stable);
      brewOk("upgrade", "--cask", CASK_TOKENS.stable);
      expect(world.installedVersion()).toBe("0.1.28");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "stable" });
      expect(world.savedWork()).toEqual(seeded);
      brewOk("uninstall", "--cask", CASK_TOKENS.stable);
      expect(world.savedWork()).toEqual(seeded);
    },
    340_000,
  );

  // The public tap until its casks were republished (docs/alpha.md
  // "Republishing the casks"): a person on an older Homebrew holds an
  // installed version, and the newer cask an older generator wrote is
  // refused; republished at the same target, it upgrades.
  it.each(versions)(
    "Homebrew %s upgrades once a cask it refused is republished at the same target",
    async (version) => {
      const world = scratchWorld(homebrew as string, version);
      const { brew, brewOk } = world;
      const declaresWrites = version === "current" || (compareSemver(version, "6.0.15") ?? -1) >= 0;
      expect(brewOk("--prefix").trim()).toBe(world.prefix);
      mkdirSync(join(world.dataRoot, "crewmates", "c1", "sessions"), { recursive: true });
      writeFileSync(join(world.dataRoot, "firstmate.db"), "seeded database bytes");
      writeFileSync(
        join(world.dataRoot, "crewmates", "c1", "sessions", "s1.jsonl"),
        '{"seeded":true}\n',
      );
      const seeded = world.savedWork();

      // -- Stable installed; then a newer stable whose casks an older generator wrote.
      expect(world.publish("stable", "0.1.25").status).toBe(0);
      brewOk("tap", TAP, world.tap);
      if (!version.startsWith("5.")) brewOk("trust", TAP);
      world.cacheDownload(CASK_TOKENS.stable);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.stable}`);
      expect(world.installedVersion()).toBe("0.1.25");
      expect(world.publish("stable", "0.1.26").status).toBe(0);
      world.writeOlderCasks();
      world.updateTap();
      for (const token of Object.values(CASK_TOKENS)) {
        const read = brew("info", "--json=v2", "--cask", `${TAP}/${token}`);
        if (declaresWrites) {
          expect(read.status, read.stderr).toBe(0);
        } else {
          expect(read.status).not.toBe(0);
          expect(`${read.stdout}${read.stderr}`).toMatch(
            /definition is invalid: undefined method '(postflight_steps|write_file)'/,
          );
        }
      }

      // -- Republished: the same targets, byte for byte; both casks rewritten.
      const targetsFile = join(brewOk("--repository", TAP).trim(), UPDATE_TARGETS_FILE);
      const targets = readFileSync(join(world.tap, UPDATE_TARGETS_FILE), "utf8");
      const republished = world.republish();
      expect(republished.status, republished.stderr).toBe(0);
      expect(JSON.parse(republished.stdout).changed).toEqual(["stable", "alpha"]);
      world.updateTap();
      expect(readFileSync(targetsFile, "utf8")).toBe(targets);
      for (const token of Object.values(CASK_TOKENS)) {
        brewOk("info", "--json=v2", "--cask", `${TAP}/${token}`);
      }

      // -- The held stable upgrades and records stable; saved work stays.
      expect(await world.offered()).toMatchObject({
        channel: "stable",
        latestVersion: "0.1.26",
        updateAvailable: true,
      });
      world.cacheDownload(CASK_TOKENS.stable);
      brewOk("upgrade", "--cask", CASK_TOKENS.stable);
      expect(world.installedVersion()).toBe("0.1.26");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "stable" });
      expect(world.savedWork()).toEqual(seeded);

      // -- The republished alpha cask installs and records alpha.
      brewOk("uninstall", "--cask", CASK_TOKENS.stable);
      world.cacheDownload(CASK_TOKENS.alpha);
      brewOk("install", "--cask", `${TAP}/${CASK_TOKENS.alpha}`);
      expect(world.installedVersion()).toBe("0.1.26");
      expect(world.marker()).toEqual({ schemaVersion: 1, channel: "alpha" });
      brewOk("uninstall", "--cask", CASK_TOKENS.alpha);
      expect(world.savedWork()).toEqual(seeded);
    },
    340_000,
  );

  // The old-cask switch (FI3-1780 step 10 builds its publisher; FI3-1729: "A
  // Homebrew upgrade loads the installed cask's own file, quits and removes
  // Firstmate 3000.app, then installs whatever app the new version names"):
  // someone on Firstmate 3000's alpha cask runs the command they always ran
  // and lands on Infinitary, its marker in Infinitary's folder saying so, and
  // Infinitary's own reader keeps naming that command.
  it.each(versions)(
    "Homebrew %s moves a Firstmate 3000 alpha installation to Infinitary through its usual command",
    async (version) => {
      const world = scratchWorld(homebrew as string, version);
      const { brewOk } = world;
      const OLD = FIRSTMATE_TAP.tap;
      const token = FIRSTMATE_TAP.caskTokens.alpha;
      const older = { name: "Firstmate 3000", bundleId: `${STAND_IN_BUNDLE_ID}.older` };
      const oldRoot = join(world.appSupport, "firstmate-3000");

      // -- Firstmate 3000's tap as it stands: its alpha cask installs Firstmate 3000.
      const oldTap = join(world.dir, "old-tap");
      mkdirSync(join(oldTap, "Casks"), { recursive: true });
      world.git(oldTap, "init", "--quiet", "--initial-branch=main");
      const installed = "0.4.1-alpha.78";
      const installedTarget = buildUpdateTarget(
        {
          version: installed,
          assetName: `Firstmate-3000-${installed}-universal.zip`,
          sha256: world.standIn(installed, older.name, older.bundleId).sha256,
          sourceCommit: COMMIT,
        },
        FIRSTMATE_TAP,
      );
      // Today's alpha cask, written by Firstmate 3000's own generator: its app,
      // its folder's marker with no switch field, its bundle to quit.
      const today = renderCask(
        "alpha",
        installedTarget,
        "Firstmate 3000 is in private alpha.",
        FIRSTMATE_TAP,
      )
        .replace('app "Infinitary.app"', 'app "Firstmate 3000.app"')
        .replaceAll("Application Support/infinitary/", "Application Support/firstmate-3000/")
        .replaceAll(',\\"cameThroughOldCask\\":true', "")
        .replaceAll(',"cameThroughOldCask":true', "")
        .replace(`uninstall quit: "${BUNDLE_ID}"`, `uninstall quit: "${older.bundleId}"`);
      expect(today).not.toContain("cameThroughOldCask");
      writeFileSync(join(oldTap, "Casks", `${token}.rb`), today);
      // Its stable, the bridge stable, is the protected stable alpha returns to.
      const bridgeStable = buildUpdateTarget(
        {
          version: "0.4.1",
          assetName: "Firstmate-3000-0.4.1-universal.zip",
          sha256: world.standIn("0.4.1", older.name, older.bundleId).sha256,
          sourceCommit: COMMIT,
        },
        FIRSTMATE_TAP,
      );
      writeFileSync(
        join(oldTap, FIRSTMATE_TAP.targetsFile),
        `${JSON.stringify({ schemaVersion: 1, targets: { stable: bridgeStable, alpha: installedTarget } }, null, 2)}\n`,
      );
      world.git(oldTap, "add", "--all");
      world.git(oldTap, "commit", "--quiet", "-m", "Firstmate 3000 today");
      brewOk("tap", OLD, oldTap);
      if (!version.startsWith("5.")) brewOk("trust", OLD);
      world.cacheDownload(token, OLD, older);
      brewOk("install", "--cask", `${OLD}/${token}`);
      expect(world.installedVersion(older.name)).toBe(installed);
      expect(world.marker(oldRoot)).toEqual({ schemaVersion: 1, channel: "alpha" });
      writeFileSync(join(oldRoot, "firstmate.db"), "seeded database bytes");
      const seeded = world.savedWork(oldRoot);

      // -- The switch publishes Infinitary under Firstmate 3000's alpha cask.
      const next = "0.4.2-alpha.1";
      const switched = world.commitWritten(
        world.run(process.execPath, [
          join(root, "scripts", "tap-publication.ts"),
          "advance",
          ...["--tap", oldTap, "--names", "firstmate", "--channel", "alpha", "--version", next],
          ...["--asset", `Infinitary-${next}-universal.zip`],
          ...["--sha256", world.standIn(next).sha256, "--source-commit", COMMIT],
        ]),
        `switch to infinitary ${next}`,
        oldTap,
      );
      expect(switched.status, switched.stderr).toBe(0);
      expect(JSON.parse(switched.stdout).changed).toEqual(["alpha"]);
      world.updateTap(OLD);

      // -- The usual command: Firstmate 3000.app goes, Infinitary.app arrives.
      world.cacheDownload(token, OLD);
      brewOk("upgrade", "--cask", token);
      expect(existsSync(join(world.applications, "Firstmate 3000.app"))).toBe(false);
      expect(world.installedVersion()).toBe(next);
      expect(world.marker()).toEqual({
        schemaVersion: 1,
        channel: "alpha",
        cameThroughOldCask: true,
      });
      // Firstmate 3000's saved work waits, untouched, for Infinitary's first launch to move it.
      expect(world.savedWork(oldRoot)).toEqual(seeded);

      // -- Infinitary's own reader keeps that tap and that command.
      const tapped = brewOk("--repository", OLD).trim();
      const requests: string[] = [];
      const checker = createUpdateChecker({
        currentVersion: next,
        channel: () => resolveUpdateChannel(world.dataRoot, next),
        tap: () => resolveUpdateTap(world.dataRoot, next),
        fetchImpl: async (url) => {
          requests.push(String(url));
          return new Response(readFileSync(join(tapped, FIRSTMATE_TAP.targetsFile), "utf8"));
        },
      });
      expect(await checker.getStatus()).toMatchObject({
        channel: "alpha",
        latestVersion: next,
        updateAvailable: false,
        upgradeCommand: "brew update && brew upgrade --cask firstmate-3000@alpha",
      });
      expect(requests).toEqual([targetsUrlOf(FIRSTMATE_TAP)]);
      brewOk("uninstall", "--cask", token);
    },
    340_000,
  );
});
