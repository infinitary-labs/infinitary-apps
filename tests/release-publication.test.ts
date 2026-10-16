import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCask } from "../src/core/update/tapPublication";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  parseUpdateTargets,
  type UpdateTarget,
  type UpdateTargets,
} from "../src/core/update/updateChannels";
import { declaredStepOnly } from "./helpers/olderCask";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The publication half of the signed channel workflow (docs/alpha.md "The
 * signed channel workflow"), run the way release.yml runs it: the real
 * `scripts/publish-tap.sh` against a local repository standing in for the
 * public tap, and the real `scripts/publish-release-asset.sh` against a
 * stand-in `gh` that keeps releases in a scratch folder. Homebrew's style
 * cops are a recorded stand-in here (`brew style` of both casks is the
 * release contract's), and so is `curl`, which serves the tap's release
 * downloads from a scratch folder; everything else - git, the publication
 * CLI, the checksums - is real. Nothing reaches a network.
 */

// Each tap write runs the publication CLI (Node and Vite) and real git; the
// longest journey makes about a dozen (docs/test-cohorts.md).
vi.setConfig({ testTimeout: 50_000 });

const root = join(__dirname, "..");
const COMMIT = "c".repeat(40);
const OTHER_COMMIT = "d".repeat(40);
const NOTICE = readFileSync(join(root, "packaging", "alpha-notice.txt"), "utf8");
const TARGETS_FILE = "infinitary-updates.json";

/** The machine's git, without host git or publication configuration. */
function baseEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(GIT_|HOMEBREW_|GH_|GITHUB_|PRERELEASE$|LATEST$)/.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: join(dir, "home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "tap",
    GIT_AUTHOR_EMAIL: "tap@localhost",
    GIT_COMMITTER_NAME: "tap",
    GIT_COMMITTER_EMAIL: "tap@localhost",
  };
}

const sha256Of = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Run = { status: number | null; stdout: string; stderr: string };
type Mode = "live" | "rehearsal" | "republish" | "republish-rehearsal";

const RELEASES = "https://github.com/infinitary-labs/homebrew-tap/releases/download";

/** A stand-in public tap: a bare repository, seeded the way the tap stands today. */
function standInTap() {
  const dir = scratchDir("infinitary-tap-publication-");
  mkdirSync(join(dir, "home"));
  const env = baseEnv(dir);
  const bare = join(dir, "tap.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet", "--bare", "--initial-branch=main", bare);
  const seed = join(dir, "seed");
  git("clone", "--quiet", bare, seed);
  // The stable cask the single-channel workflow wrote for 0.1.24, and
  // another tool's cask sharing the tap.
  mkdirSync(join(seed, "Casks"));
  writeFileSync(
    join(seed, "Casks", "infinitary.rb"),
    renderCask("stable", artifact("0.1.24", sha256Of("0.1.24")), NOTICE),
  );
  writeFileSync(join(seed, "Casks", "other-tool.rb"), 'cask "other-tool" do\nend\n');
  git("-C", seed, "add", "--all");
  git("-C", seed, "commit", "--quiet", "-m", "seed");
  git("-C", seed, "push", "--quiet", "origin", "HEAD:main");

  // Homebrew's style cops, recorded; BREW_ON_STYLE runs once, first call.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const brewLog = join(dir, "brew.log");
  writeFileSync(
    join(bin, "brew"),
    [
      "#!/bin/bash",
      `echo "$PWD: $*" >> "${brewLog}"`,
      `if [[ -n "\${BREW_ON_STYLE:-}" && ! -e "${dir}/style-hook-ran" ]]; then`,
      `  touch "${dir}/style-hook-ran"`,
      '  bash -c "$BREW_ON_STYLE" || exit 1',
      "fi",
    ].join("\n"),
  );
  chmodSync(join(bin, "brew"), 0o755);

  // The tap's release downloads, as an unauthenticated GET returns them:
  // `<downloads>/<tag>/<asset>`, or curl's 404 failure. Every call is recorded.
  const downloads = join(dir, "downloads");
  const curlLog = join(dir, "curl.log");
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/bash",
      `echo "$*" >> "${curlLog}"`,
      'out="" url=""',
      "while (($#)); do",
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      "    --retry|--retry-delay) shift 2 ;;",
      "    -*) shift ;;",
      '    *) url="$1"; shift ;;',
      "  esac",
      "done",
      `file="${downloads}/\${url#${RELEASES}/}"`,
      '[[ -f "$file" ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }',
      'if [[ -n "$out" ]]; then cp "$file" "$out"; else cat "$file"; fi',
    ].join("\n"),
  );
  chmodSync(join(bin, "curl"), 0o755);
  /** Publish a download and its .sha256 sidecar where the stand-in curl serves them. */
  const serve = (downloadUrl: string, bytes: string, sidecarSha = sha256Of(bytes)) => {
    const path = join(downloads, downloadUrl.slice(RELEASES.length + 1));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    writeFileSync(`${path}.sha256`, `${sidecarSha}  ${downloadUrl.split("/").pop()}\n`);
  };

  const run = (mode: Mode, fields: Record<string, string>, extra = {}): Run => {
    const result = spawnSync(join(root, "scripts", "publish-tap.sh"), [mode], {
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        TAP_URL: `file://${bare}`,
        WORK: scratchDir("infinitary-tap-work-"),
        // No record of past releases unless a test gives one: the stand-in
        // tap's own state alone decides whether the alpha channel is activated.
        RELEASE_ARCHIVE: join(dir, "no-archive.json"),
        ...fields,
        ...extra,
      },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const show = (path: string) => git("-C", bare, "show", `main:${path}`);
  return {
    dir,
    bare,
    git,
    env,
    brewLog,
    run,
    serve,
    curlLog,
    show,
    head: () => git("-C", bare, "rev-parse", "main"),
    commits: () => Number(git("-C", bare, "rev-list", "--count", "main")),
    changedIn: (commit: string) =>
      git("-C", bare, "show", "--name-only", "--format=", commit).split("\n").sort(),
    subject: (commit: string) => git("-C", bare, "log", "-1", "--format=%s", commit),
    targets: () => parseUpdateTargets(JSON.parse(show(TARGETS_FILE))) as UpdateTargets,
    caskVersion: (token: string) => /^ {2}version "([^"]+)"$/m.exec(show(`Casks/${token}.rb`))?.[1],
  };
}

function artifact(version: string, sha256: string) {
  const target = buildUpdateTarget({
    version,
    assetName: `Infinitary-${version}-universal.zip`,
    sha256,
    sourceCommit: COMMIT,
  });
  return { version, sha256, downloadUrl: target.downloadUrl };
}

/** release.yml's environment for the tap step of one publication. */
function publication(
  channel: "stable" | "alpha",
  version: string,
  overrides: { sha256?: string; sourceCommit?: string; downloadUrl?: string } = {},
) {
  const sha256 = overrides.sha256 ?? sha256Of(version);
  const zip = `Infinitary-${version}-universal.zip`;
  const target = buildUpdateTarget({
    version,
    assetName: zip,
    sha256,
    sourceCommit: COMMIT,
  });
  return {
    CHANNEL: channel,
    VERSION: version,
    ZIP_NAME: zip,
    SHA256: sha256,
    SOURCE_COMMIT: overrides.sourceCommit ?? COMMIT,
    DOWNLOAD_URL: overrides.downloadUrl ?? target.downloadUrl,
  };
}

describe("the tap step of a release", () => {
  // The old-cask switch (FI3-1780 step 10, FI3-1729): on Firstmate 3000's
  // tap, one commit moves its casks and its frozen-schema update file to
  // Infinitary's download, published there under the tag an installed
  // Firstmate 3000 accepts.
  it("switches Firstmate 3000's casks and update file to Infinitary in one commit", () => {
    const tap = standInTap();
    const version = "0.4.2";
    const zip = `Infinitary-${version}-universal.zip`;
    const fields = {
      CHANNEL: "stable",
      VERSION: version,
      ZIP_NAME: zip,
      SHA256: sha256Of(version),
      SOURCE_COMMIT: COMMIT,
      DOWNLOAD_URL: buildDownloadUrl(version, zip, FIRSTMATE_TAP),
      NAMES: "firstmate",
    };
    const switched = tap.run("live", fields);
    expect(switched.status, switched.stderr).toBe(0);
    expect(tap.subject("main")).toBe("chore: switch firstmate-3000 to infinitary 0.4.2 (stable)");
    expect(tap.changedIn("main")).toEqual([
      "Casks/firstmate-3000.rb",
      "Casks/firstmate-3000@alpha.rb",
      "firstmate-3000-updates.json",
    ]);
    const cask = tap.show("Casks/firstmate-3000.rb");
    expect(cask).toContain('app "Infinitary.app"');
    expect(cask).toContain("cameThroughOldCask");
    const old = parseUpdateTargets(
      JSON.parse(tap.show("firstmate-3000-updates.json")),
      FIRSTMATE_TAP,
    );
    expect(old?.targets.stable?.downloadUrl).toBe(fields.DOWNLOAD_URL);
    expect(old?.targets.alpha?.downloadUrl).toBe(fields.DOWNLOAD_URL);
  });

  // Infinitary's own tap starts empty after Firstmate 3000's stables (FI3-1780
  // steps 7 and 12): the record of past releases names the protected stable
  // someone leaving the alpha channel returns to, so its first alpha publishes.
  it("publishes Infinitary's first alpha onto an empty tap when the archived stable is protected", () => {
    const tap = standInTap();
    const archive = join(tap.dir, "archive.json");
    writeFileSync(archive, JSON.stringify({ schema: 1, stable: "0.4.1", alpha: "0.4.1-alpha.78" }));
    const first = tap.run("live", publication("alpha", "0.4.2-alpha.1"), {
      RELEASE_ARCHIVE: archive,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary@alpha.rb", TARGETS_FILE]);
    expect(tap.targets().targets).toEqual({
      alpha: expect.objectContaining({ version: "0.4.2-alpha.1" }),
    });
    // Without that record, the same tap refuses it.
    const refused = tap.run("live", publication("alpha", "0.4.2-alpha.2"));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(
      /a live alpha is refused: the tap's infinitary-updates.json names no stable target/,
    );
  });

  it("publishes each channel in one tap commit, forwards only, and leaves the tap untouched when it refuses", () => {
    const tap = standInTap();
    const unchanged = (run: Run, reason: RegExp) => {
      const before = tap.head();
      expect(run.status, run.stdout).toBe(1);
      expect(run.stderr).toMatch(reason);
      expect(tap.head()).toBe(before);
    };

    // -- Before activation: no live alpha, and stable never moves behind the old cask.
    const seeded = tap.head();
    unchanged(
      tap.run("live", publication("alpha", "0.1.25-alpha.40")),
      /a live alpha is refused: the tap has no infinitary-updates.json yet; a protected stable \(newer than 0\.1\.24\) has to be published first/,
    );
    unchanged(
      tap.run("live", publication("stable", "0.1.23")),
      /the tap's stable cask already carries 0\.1\.24, newer than 0\.1\.23/,
    );
    expect(tap.head()).toBe(seeded);

    // -- The bootstrap stable: both casks and the targets file, in one commit.
    const bootstrap = tap.run("live", publication("stable", "0.1.25"));
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(tap.commits()).toBe(2);
    expect(tap.changedIn("main")).toEqual([
      "Casks/infinitary.rb",
      "Casks/infinitary@alpha.rb",
      TARGETS_FILE,
    ]);
    expect(tap.subject("main")).toBe("chore: publish infinitary 0.1.25 (stable)");
    expect(tap.targets().targets.stable?.version).toBe("0.1.25");
    expect(tap.targets().targets.alpha).toEqual(tap.targets().targets.stable);
    expect(tap.caskVersion("infinitary@alpha")).toBe("0.1.25");
    // Homebrew read exactly the casks this commit writes, in the tap clone.
    expect(readFileSync(tap.brewLog, "utf8")).toMatch(
      /\/tap: style --except-cops=Cask\/InstallSteps Casks\/infinitary\.rb Casks\/infinitary@alpha\.rb\n$/,
    );

    // -- (a) An alpha moves only alpha: its cask and the targets file.
    expect(tap.run("live", publication("alpha", "0.1.26-alpha.43")).status).toBe(0);
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary@alpha.rb", TARGETS_FILE]);
    expect(tap.targets().targets).toMatchObject({
      stable: { version: "0.1.25" },
      alpha: { version: "0.1.26-alpha.43", releaseUrl: expect.stringContaining("alpha-v") },
    });
    expect(tap.caskVersion("infinitary")).toBe("0.1.25");

    // -- (b) A newer stable moves both.
    expect(tap.run("live", publication("stable", "0.1.26")).status).toBe(0);
    expect(tap.changedIn("main")).toEqual([
      "Casks/infinitary.rb",
      "Casks/infinitary@alpha.rb",
      TARGETS_FILE,
    ]);
    expect(tap.targets().targets.alpha?.version).toBe("0.1.26");

    // -- (f) A stable finishing after a newer alpha moves stable alone.
    expect(tap.run("live", publication("alpha", "0.1.28-alpha.50")).status).toBe(0);
    const late = tap.run("live", publication("stable", "0.1.27"));
    expect(late.status, late.stderr).toBe(0);
    expect(late.stdout).toContain("alpha keeps 0.1.28-alpha.50, newer than stable 0.1.27");
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary.rb", TARGETS_FILE]);
    expect(tap.targets().targets).toMatchObject({
      stable: { version: "0.1.27" },
      alpha: { version: "0.1.28-alpha.50" },
    });

    // -- A retry of the same publication writes nothing.
    const head = tap.head();
    const retry = tap.run("live", publication("stable", "0.1.27"));
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).toContain("the tap already carries stable 0.1.27; nothing to write");
    expect(tap.head()).toBe(head);

    // -- Refusals leave the tap exactly as it was.
    unchanged(
      tap.run("live", publication("stable", "0.1.27", { sha256: sha256Of("rebuilt") })),
      /stable already carries 0\.1\.27 with a different artifact or source/,
    );
    unchanged(
      tap.run("live", publication("alpha", "0.1.28-alpha.49")),
      /alpha already carries 0\.1\.28-alpha\.50, newer than 0\.1\.28-alpha\.49/,
    );
    // The new target must be the download that was fetched back and verified.
    unchanged(
      tap.run(
        "live",
        publication("alpha", "0.1.29-alpha.51", {
          downloadUrl: artifact("0.1.28-alpha.50", sha256Of("x")).downloadUrl,
        }),
      ),
      /the alpha target names .*0\.1\.29-alpha\.51.*, not the verified .*0\.1\.28-alpha\.50/,
    );
    // Another tool's cask on the shared tap is never touched.
    expect(tap.git("-C", tap.bare, "log", "--format=%s", "--", "Casks/other-tool.rb")).toBe("seed");
  });

  it("reads the tap again when another publication lands first, and keeps both", () => {
    const tap = standInTap();
    expect(tap.run("live", publication("stable", "0.1.25")).status).toBe(0);
    // While this stable is being checked, an alpha publication lands on the
    // tap: the style hook commits it through the same CLI, as release.yml would.
    const other = join(tap.dir, "other");
    const alpha = publication("alpha", "0.1.27-alpha.60");
    const quoted = (path: string) => `'${path}'`;
    const competitor = [
      `git clone --quiet ${quoted(`file://${tap.bare}`)} ${quoted(other)}`,
      `node ${quoted(join(root, "scripts", "tap-publication.ts"))} advance --tap ${quoted(other)} --channel alpha --version ${alpha.VERSION} --asset ${alpha.ZIP_NAME} --sha256 ${alpha.SHA256} --source-commit ${COMMIT} > /dev/null`,
      `git -C ${quoted(other)} add --all`,
      `git -C ${quoted(other)} commit --quiet -m "chore: publish infinitary ${alpha.VERSION} (alpha)"`,
      `git -C ${quoted(other)} push --quiet origin HEAD`,
    ].join(" && ");
    const before = tap.commits();
    const result = tap.run("live", publication("stable", "0.1.26"), { BREW_ON_STYLE: competitor });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("the tap moved during attempt 1; reading it again");
    // Both publications, in the order they landed, neither overwriting the other.
    expect(tap.commits()).toBe(before + 2);
    expect(tap.subject("main~1")).toBe("chore: publish infinitary 0.1.27-alpha.60 (alpha)");
    expect(tap.subject("main")).toBe("chore: publish infinitary 0.1.26 (stable)");
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary.rb", TARGETS_FILE]);
    expect(tap.targets().targets).toMatchObject({
      stable: { version: "0.1.26" },
      alpha: { version: "0.1.27-alpha.60" },
    });
  });

  it("rehearses the tap commit into a scratch folder and never writes the tap", () => {
    const tap = standInTap();
    const head = tap.head();
    const out = join(scratchDir("infinitary-tap-rehearsal-"), "out");
    // An alpha before activation: rehearsed anyway, with what a live one would meet.
    const alpha = tap.run("rehearsal", publication("alpha", "0.1.25-alpha.40"), { OUT: out });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.stdout).toContain(
      "a live alpha would be refused now: the tap has no infinitary-updates.json yet",
    );
    expect(readdirSync(out).sort()).toEqual(["Casks", TARGETS_FILE, "tap-publication.json"]);
    expect(readdirSync(join(out, "Casks"))).toEqual(["infinitary@alpha.rb"]);
    const targets = parseUpdateTargets(JSON.parse(readFileSync(join(out, TARGETS_FILE), "utf8")));
    expect(targets?.targets.alpha?.version).toBe("0.1.25-alpha.40");
    expect(readFileSync(tap.brewLog, "utf8")).toContain(
      "style --except-cops=Cask/InstallSteps Casks/infinitary@alpha.rb",
    );

    // A stable rehearsal writes both casks, from the old stable cask's floor.
    const stableOut = join(scratchDir("infinitary-tap-rehearsal-"), "out");
    expect(tap.run("rehearsal", publication("stable", "0.1.24"), { OUT: stableOut }).status).toBe(
      0,
    );
    expect(readdirSync(join(stableOut, "Casks")).sort()).toEqual([
      "infinitary.rb",
      "infinitary@alpha.rb",
    ]);
    // A refused rehearsal fails like the live publication would.
    const older = tap.run("rehearsal", publication("stable", "0.1.23"), {
      OUT: join(scratchDir("infinitary-tap-rehearsal-"), "out"),
    });
    expect(older.status).toBe(1);
    expect(older.stderr).toMatch(/newer than 0\.1\.23/);

    expect(tap.head()).toBe(head);
    expect(tap.commits()).toBe(1);
  });
});

/**
 * Republishing the casks (docs/alpha.md "Republishing the casks";
 * republish-casks.yml): both casks written again by this generator at the
 * targets the tap already names, after every such download was fetched back
 * without a credential - and the targets file never written.
 */
describe("republishing the casks on the tap", () => {
  /**
   * The tap as the public one stood before its casks were republished:
   * stable and alpha published through the release workflow, then both
   * casks as the generator wrote them before it supported Homebrew older
   * than 6.0.15. Every target's download is served unless `served` is false.
   */
  function olderTap(served = true) {
    const tap = standInTap();
    expect(tap.run("live", publication("stable", "0.1.25")).status).toBe(0);
    expect(tap.run("live", publication("alpha", "0.1.26-alpha.43")).status).toBe(0);
    const older = join(tap.dir, "older");
    tap.git("clone", "--quiet", tap.bare, older);
    for (const token of Object.values(CASK_TOKENS)) {
      const path = join(older, "Casks", `${token}.rb`);
      writeFileSync(path, declaredStepOnly(readFileSync(path, "utf8")));
    }
    tap.git("-C", older, "commit", "--quiet", "--all", "-m", "older casks");
    tap.git("-C", older, "push", "--quiet", "origin", "HEAD:main");
    const targets = tap.targets().targets as Record<"stable" | "alpha", UpdateTarget>;
    if (served)
      for (const target of Object.values(targets)) tap.serve(target.downloadUrl, target.version);
    return { tap, targets, older };
  }
  const curlCalls = (log: string) =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

  it("writes both casks again at their targets in one tap commit, after fetching every download back without a credential", () => {
    const { tap, targets } = olderTap();
    const targetsFile = tap.show(TARGETS_FILE);
    const before = tap.commits();
    const result = tap.run("republish", {}, { HOMEBREW_TAP_TOKEN: "tap-token-value" });
    expect(result.status, result.stderr).toBe(0);
    expect(tap.commits()).toBe(before + 1);
    expect(tap.subject("main")).toBe("chore: republish infinitary casks");
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary.rb", "Casks/infinitary@alpha.rb"]);
    // Nothing moved: the targets file is byte for byte what the tap carried.
    expect(tap.show(TARGETS_FILE)).toBe(targetsFile);
    for (const channel of ["stable", "alpha"] as const) {
      expect(tap.show(`Casks/${CASK_TOKENS[channel]}.rb`)).toBe(
        renderCask(channel, targets[channel], NOTICE).trim(),
      );
    }
    expect(result.stdout).toContain("stable cask republished at 0.1.25");
    expect(result.stdout).toContain("alpha cask republished at 0.1.26-alpha.43");
    // Each download and its sidecar, fetched once, carrying no credential.
    const calls = curlCalls(tap.curlLog);
    expect(calls).toHaveLength(4);
    for (const target of Object.values(targets)) {
      expect(calls.filter((call) => call.endsWith(` ${target.downloadUrl}`))).toHaveLength(1);
      expect(calls.filter((call) => call.endsWith(` ${target.downloadUrl}.sha256`))).toHaveLength(
        1,
      );
    }
    expect(calls.join("\n")).not.toMatch(/tap-token-value|--header|-H |--user|-u /);
    expect(readFileSync(tap.brewLog, "utf8")).toMatch(
      /\/tap: style --except-cops=Cask\/InstallSteps Casks\/infinitary\.rb Casks\/infinitary@alpha\.rb\n$/,
    );
    expect(tap.git("-C", tap.bare, "log", "--format=%s", "--", "Casks/other-tool.rb")).toBe("seed");

    // A second run finds the casks current: nothing written, nothing fetched.
    const head = tap.head();
    const again = tap.run("republish", {});
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("the tap's casks are already current; nothing to write");
    expect(tap.head()).toBe(head);
    expect(curlCalls(tap.curlLog)).toHaveLength(4);
  });

  it("refuses, leaving the tap untouched, a download that is not its target's bytes and a cask that installs anything else", () => {
    const { tap, targets, older } = olderTap(false);
    const unchanged = (run: Run, reason: RegExp) => {
      const before = tap.head();
      expect(run.status, run.stdout).toBe(1);
      expect(run.stderr).toMatch(reason);
      expect(tap.head()).toBe(before);
    };
    tap.serve(targets.alpha.downloadUrl, targets.alpha.version);
    // Not published at all.
    unchanged(
      tap.run("republish", {}),
      /could not fetch .*infinitary-v0\.1\.25.* without a credential/,
    );
    // Other bytes than the target's checksum.
    tap.serve(targets.stable.downloadUrl, "rebuilt");
    unchanged(
      tap.run("republish", {}),
      new RegExp(
        `Infinitary-0\\.1\\.25-universal\\.zip is ${sha256Of("rebuilt")}, not its target's ${targets.stable.sha256}`,
      ),
    );
    // The target's bytes, beside a sidecar that names others.
    tap.serve(targets.stable.downloadUrl, targets.stable.version, sha256Of("rebuilt"));
    unchanged(tap.run("republish", {}), /\.zip\.sha256 names [0-9a-f]{64}, not its target's/);
    // A cask that installs another version than its channel's target.
    tap.serve(targets.stable.downloadUrl, targets.stable.version);
    const path = join(older, "Casks", "infinitary.rb");
    writeFileSync(path, readFileSync(path, "utf8").replace('version "0.1.25"', 'version "0.1.24"'));
    tap.git("-C", older, "commit", "--quiet", "--all", "-m", "a hand edit");
    tap.git("-C", older, "push", "--quiet", "origin", "HEAD:main");
    unchanged(
      tap.run("republish", {}),
      /the infinitary cask installs 0\.1\.24 from .*, not stable's target 0\.1\.25; republishing never changes what a cask installs/,
    );
  });

  it("reads the tap again when a publication lands first, and fetches the new target's download", () => {
    const { tap } = olderTap();
    const alpha = publication("alpha", "0.1.27-alpha.60");
    tap.serve(alpha.DOWNLOAD_URL, alpha.VERSION);
    // While the republished casks are style-checked, an alpha publication
    // lands on the tap through the same CLI, as release.yml would push it.
    const other = join(tap.dir, "other");
    const quoted = (path: string) => `'${path}'`;
    const competitor = [
      `git clone --quiet ${quoted(`file://${tap.bare}`)} ${quoted(other)}`,
      `node ${quoted(join(root, "scripts", "tap-publication.ts"))} advance --tap ${quoted(other)} --channel alpha --version ${alpha.VERSION} --asset ${alpha.ZIP_NAME} --sha256 ${alpha.SHA256} --source-commit ${COMMIT} > /dev/null`,
      `git -C ${quoted(other)} add --all`,
      `git -C ${quoted(other)} commit --quiet -m "chore: publish infinitary ${alpha.VERSION} (alpha)"`,
      `git -C ${quoted(other)} push --quiet origin HEAD`,
    ].join(" && ");
    const before = tap.commits();
    const result = tap.run("republish", {}, { BREW_ON_STYLE: competitor });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("the tap moved during attempt 1; reading it again");
    expect(tap.commits()).toBe(before + 2);
    expect(tap.subject("main~1")).toBe("chore: publish infinitary 0.1.27-alpha.60 (alpha)");
    expect(tap.subject("main")).toBe("chore: republish infinitary casks");
    // The publication already wrote a current alpha cask; only stable is left.
    expect(tap.changedIn("main")).toEqual(["Casks/infinitary.rb"]);
    expect(tap.targets().targets.alpha?.version).toBe("0.1.27-alpha.60");
    expect(
      curlCalls(tap.curlLog).filter((call) => call.endsWith(` ${alpha.DOWNLOAD_URL}`)),
    ).toHaveLength(1);
  });

  it("rehearses the republished casks into a scratch folder and never writes the tap", () => {
    const { tap, targets } = olderTap();
    const head = tap.head();
    const out = join(scratchDir("infinitary-tap-rehearsal-"), "out");
    const result = tap.run("republish-rehearsal", {}, { OUT: out });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("nothing committed or pushed");
    expect(readdirSync(out).sort()).toEqual(["Casks", "tap-publication.json"]);
    for (const channel of ["stable", "alpha"] as const) {
      expect(readFileSync(join(out, "Casks", `${CASK_TOKENS[channel]}.rb`), "utf8")).toBe(
        renderCask(channel, targets[channel], NOTICE),
      );
    }
    // A refused rehearsal fails as the live republication would.
    rmSync(join(tap.dir, "downloads"), { recursive: true });
    const refused = tap.run(
      "republish-rehearsal",
      {},
      {
        OUT: join(scratchDir("infinitary-tap-rehearsal-"), "out"),
      },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/could not fetch/);
    expect(tap.head()).toBe(head);
  });
});

/**
 * A stand-in `gh` keeping releases under a scratch folder:
 * `<state>/<owner>__<repo>/<tag>/` holds the release's assets and its
 * `.release.json` (the creation flags, the tag's commit, its id, creation
 * order and whether it is a prerelease); `<state>/<owner>__<repo>/.latest`
 * names the release marked latest. Every call is recorded in
 * `<state>/calls.jsonl`.
 *
 * Its latest badge follows GitHub's rule as the tap showed it with 0.1.25: a
 * release marked latest (created without --latest=false, or updated with
 * make_latest=true) keeps the badge, a prerelease never takes it, and while
 * none is marked the newest full release shows as latest - so --latest=false
 * alone leaves a new full release on the badge. STANDIN_GH_CROWNS_NEW=1
 * stands in for a GitHub that marks every new full release whatever it is
 * asked.
 */
function standInGh() {
  const dir = scratchDir("infinitary-release-assets-");
  const state = join(dir, "state");
  mkdirSync(state);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify(args) + "\\n");
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const repoDir = (repo) => path.join(state, repo.replace("/", "__"));
const releaseDir = (repo, tag) => path.join(repoDir(repo), tag);
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
const releases = (repo) =>
  fs.existsSync(repoDir(repo))
    ? fs.readdirSync(repoDir(repo)).filter((tag) => tag !== ".latest").map((tag) => ({
        tag, ...JSON.parse(fs.readFileSync(path.join(releaseDir(repo, tag), ".release.json"), "utf8")),
      }))
    : [];
const markLatest = (repo, tag) => fs.writeFileSync(path.join(repoDir(repo), ".latest"), tag);
const latest = (repo) => {
  const full = releases(repo).filter((release) => !release.prerelease).sort((a, b) => b.order - a.order);
  const marked = path.join(repoDir(repo), ".latest");
  const tag = fs.existsSync(marked) ? fs.readFileSync(marked, "utf8") : undefined;
  return full.find((release) => release.tag === tag) ?? full[0];
};
const record = (repo, tag, fields) => {
  const counter = path.join(state, "counter");
  const order = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(order));
  fs.mkdirSync(releaseDir(repo, tag), { recursive: true });
  fs.writeFileSync(
    path.join(releaseDir(repo, tag), ".release.json"),
    JSON.stringify({ id: 1000 + order, order, prerelease: false, ...fields }),
  );
};
if (args[0] === "api") {
  const [, owner, repo, kind, rest] = args.find((arg) => arg.startsWith("repos/")).split("/");
  const name = owner + "/" + repo;
  if (kind === "commits") {
    const file = path.join(releaseDir(name, rest), ".release.json");
    if (!fs.existsSync(file)) fail("Not Found");
    process.stdout.write(JSON.parse(fs.readFileSync(file, "utf8")).commit + "\\n");
  } else if (rest === "latest" && flag("--jq") === '"\\\\(.id) \\\\(.tag_name)"') {
    const shown = latest(name);
    if (!shown) {
      process.stdout.write('{"message":"Not Found","status":"404"}');
      fail("gh: Not Found (HTTP 404)");
    }
    process.stdout.write(shown.id + " " + shown.tag + "\\n");
  } else if (kind === "releases" && flag("--method") === "PATCH" && flag("-f") === "make_latest=true") {
    const release = releases(name).find((each) => String(each.id) === rest);
    if (!release) fail("gh: Not Found (HTTP 404)");
    if (!release.prerelease) markLatest(name, release.tag);
  } else if (kind === "releases?per_page=100" && args.includes("--paginate")) {
    const full = releases(name).filter((release) => !release.prerelease);
    process.stdout.write(full.map((release) => release.tag + "\\n").join(""));
  } else fail("unexpected gh call: " + args.join(" "));
  process.exit(0);
}
const [, verb, tag] = args;
const dir = releaseDir(flag("--repo"), tag);
const exists = fs.existsSync(path.join(dir, ".release.json"));
const assets = () => (exists ? fs.readdirSync(dir).filter((name) => name !== ".release.json") : []);
if (verb === "view") {
  if (!exists) fail("release not found");
  if (flag("--json") === "assets") process.stdout.write(assets().map((name) => name + "\\n").join(""));
} else if (verb === "create") {
  if (exists) fail("a release with the same tag name already exists");
  const named = flag("--target");
  const commit = /^[0-9a-f]{40}$/.test(named) ? named : "f".repeat(40);
  const prerelease = args.includes("--prerelease");
  record(flag("--repo"), tag, { commit, args, prerelease });
  const marks = !args.includes("--latest=false") || process.env.STANDIN_GH_CROWNS_NEW === "1";
  if (marks && !prerelease) markLatest(flag("--repo"), tag);
} else if (verb === "upload") {
  if (!exists) fail("release not found");
  for (const file of args.slice(3).filter((arg, at, all) => !arg.startsWith("--") && all[at - 1] !== "--repo")) {
    if (assets().includes(path.basename(file)) && !args.includes("--clobber")) fail("asset already exists");
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
  }
} else if (verb === "download") {
  if (!assets().includes(flag("--pattern"))) fail("no assets match the file pattern");
  fs.copyFileSync(path.join(dir, flag("--pattern")), path.join(flag("--dir"), flag("--pattern")));
} else fail("unexpected gh call: " + args.join(" "));
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  /** A zip's worth of bytes for a version and build. */
  const zip = (version: string, build: string) => {
    const folder = scratchDir("infinitary-release-zip-");
    const file = join(folder, `Infinitary-${version}-universal.zip`);
    writeFileSync(file, `${version} ${build}`);
    return file;
  };

  /**
   * Seeds an already published release, as an earlier attempt or another
   * product left it; `marked` makes it the release marked latest.
   */
  const seed = (
    repo: string,
    tag: string,
    commit: string,
    files: Record<string, string>,
    { prerelease = false, marked = false } = {},
  ) => {
    const release = join(state, repo.replace("/", "__"), tag);
    mkdirSync(release, { recursive: true });
    const counter = join(state, "counter");
    const order = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    writeFileSync(counter, String(order));
    writeFileSync(
      join(release, ".release.json"),
      JSON.stringify({ id: 1000 + order, order, prerelease, commit, args: ["seeded"] }),
    );
    if (marked) writeFileSync(join(state, repo.replace("/", "__"), ".latest"), tag);
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(release, name), content);
  };

  const run = (
    mode: "adopt" | "match",
    repo: string,
    tag: string,
    file: string,
    extra: Record<string, string> & { PRERELEASE: "true" | "false" },
  ) => {
    const work = scratchDir("infinitary-release-work-");
    const notes = join(work, "notes.md");
    writeFileSync(notes, "notes\n");
    const output = join(work, "output");
    writeFileSync(output, "");
    const result = spawnSync(
      join(root, "scripts", "publish-release-asset.sh"),
      [mode, repo, tag, file],
      {
        env: {
          ...baseEnv(dir),
          PATH: `${bin}:${process.env.PATH}`,
          WORK: work,
          GITHUB_OUTPUT: output,
          TITLE: "Infinitary",
          NOTES_FILE: notes,
          TARGET: COMMIT,
          SOURCE_COMMIT: COMMIT,
          ...extra,
        },
        encoding: "utf8",
      },
    );
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status: result.status, stderr: result.stderr, outputs };
  };

  const published = (repo: string, tag: string) => {
    const release = join(state, repo.replace("/", "__"), tag);
    return existsSync(release)
      ? Object.fromEntries(
          readdirSync(release)
            .filter((name) => name !== ".release.json")
            .map((name) => [name, readFileSync(join(release, name), "utf8")]),
        )
      : null;
  };
  const created = (repo: string, tag: string) =>
    (
      JSON.parse(
        readFileSync(join(state, repo.replace("/", "__"), tag, ".release.json"), "utf8"),
      ) as { args: string[] }
    ).args;
  const calls = () =>
    readFileSync(join(state, "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  /** Runs the stand-in `gh` directly, the way a person at the repository would. */
  const gh = (...args: string[]) =>
    spawnSync(join(bin, "gh"), args, { env: baseEnv(dir), encoding: "utf8" });
  /** The tag the repository shows as latest, or null when it shows none. */
  const latest = (repo: string) => {
    const shown = gh("api", `repos/${repo}/releases/latest`, "--jq", '"\\(.id) \\(.tag_name)"');
    return shown.status === 0 ? shown.stdout.trim().split(" ")[1] : null;
  };
  return { zip, seed, run, published, created, calls, gh, latest };
}

describe("a release's published assets", () => {
  const PRIVATE = "infinitary-labs/infinitary";
  const PUBLIC = "infinitary-labs/homebrew-tap";
  const VERSION = "0.1.26-alpha.43";
  const NAME = `Infinitary-${VERSION}-universal.zip`;

  afterEach(() => vi.unstubAllEnvs());

  it.each(["true", "false"])(
    "creates an alpha's prerelease, uploads the zip and its sidecar, and never clobbers (host PRERELEASE=%s)",
    (inheritedPrerelease) => {
      vi.stubEnv("PRERELEASE", inheritedPrerelease);
      const gh = standInGh();
      const zip = gh.zip(VERSION, "first build");
      const sha = sha256Of(`${VERSION} first build`);
      const first = gh.run("adopt", PRIVATE, `v${VERSION}`, zip, {
        PRERELEASE: "true",
        LATEST: "false",
      });
      expect(first.status, first.stderr).toBe(0);
      expect(first.outputs).toEqual({ zip, sha256: sha, state: "uploaded" });
      expect(gh.created(PRIVATE, `v${VERSION}`)).toEqual(
        expect.arrayContaining(["--target", COMMIT, "--prerelease", "--latest=false"]),
      );
      expect(gh.published(PRIVATE, `v${VERSION}`)).toEqual({
        [NAME]: `${VERSION} first build`,
        [`${NAME}.sha256`]: `${sha}  ${NAME}\n`,
      });
      // The public copy of the same bytes, on the tap's own prefixed tag.
      const publicCopy = gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, zip, {
        TARGET: "main",
        PRERELEASE: "true",
        LATEST: "false",
      });
      expect(publicCopy.outputs.state).toBe("uploaded");
      expect(gh.created(PUBLIC, `infinitary-alpha-v${VERSION}`)).toEqual(
        expect.arrayContaining(["--target", "main", "--prerelease", "--latest=false"]),
      );
      expect(gh.calls().flat()).not.toContain("--clobber");
      // A prerelease never shows as latest, so no release is marked for it.
      expect(gh.calls().flat()).not.toContain("make_latest=true");
    },
  );

  it.each(["true", "false"])(
    "keeps a stable on the shared tap off its latest badge, which stays where it was (host PRERELEASE=%s)",
    (inheritedPrerelease) => {
      vi.stubEnv("PRERELEASE", inheritedPrerelease);
      const gh = standInGh();
      // The tap as GitHub works it out while no release is marked: the newest
      // full release shows as latest, never a prerelease.
      gh.seed(PUBLIC, "infinitary-v0.1.28", COMMIT, {});
      gh.seed(PUBLIC, "other-tool-v2.0.0", COMMIT, {});
      gh.seed(PUBLIC, "infinitary-alpha-v0.1.29-alpha.35", COMMIT, {}, { prerelease: true });
      expect(gh.latest(PUBLIC)).toBe("other-tool-v2.0.0");

      // What the tap showed with 0.1.25: --latest=false alone leaves the new
      // full release on the badge.
      const elsewhere = "kunchenguid/stand-in-tap";
      gh.seed(elsewhere, "other-tool-v2.0.0", COMMIT, {});
      const notes = join(scratchDir("infinitary-release-notes-"), "notes.md");
      writeFileSync(notes, "notes\n");
      const unheld = ["--repo", elsewhere, "--target", "main", "--notes-file", notes];
      expect(
        gh.gh("release", "create", "infinitary-v0.1.29", ...unheld, "--latest=false").status,
      ).toBe(0);
      expect(gh.latest(elsewhere)).toBe("infinitary-v0.1.29");

      // The publication holds the badge where it was.
      const stable = gh.run("match", PUBLIC, "infinitary-v0.1.29", gh.zip("0.1.29", "build"), {
        TARGET: "main",
        PRERELEASE: "false",
        LATEST: "false",
      });
      expect(stable.status, stable.stderr).toBe(0);
      expect(stable.outputs.state).toBe("uploaded");
      expect(gh.created(PUBLIC, "infinitary-v0.1.29")).toContain("--latest=false");
      expect(gh.created(PUBLIC, "infinitary-v0.1.29")).not.toContain("--prerelease");
      expect(gh.latest(PUBLIC)).toBe("other-tool-v2.0.0");
      // The next stable, too, while Firstmate's own release shows as latest.
      const own = "kunchenguid/own-tap";
      gh.seed(own, "infinitary-v0.1.28", COMMIT, {});
      const next = gh.run("match", own, "infinitary-v0.1.29", gh.zip("0.1.29", "build"), {
        TARGET: "main",
        PRERELEASE: "false",
        LATEST: "false",
      });
      expect(next.status, next.stderr).toBe(0);
      expect(gh.latest(own)).toBe("infinitary-v0.1.28");
    },
  );

  it.each(["true", "false"])(
    "puts the latest badge back if GitHub moves it anyway, and names a first full release (host PRERELEASE=%s)",
    (inheritedPrerelease) => {
      vi.stubEnv("PRERELEASE", inheritedPrerelease);
      const gh = standInGh();
      gh.seed(PUBLIC, "other-tool-v2.0.0", COMMIT, {}, { marked: true });
      const moved = gh.run("match", PUBLIC, "infinitary-v0.1.29", gh.zip("0.1.29", "build"), {
        TARGET: "main",
        PRERELEASE: "false",
        LATEST: "false",
        STANDIN_GH_CROWNS_NEW: "1",
      });
      expect(moved.status, moved.stderr).toBe(0);
      expect(gh.latest(PUBLIC)).toBe("other-tool-v2.0.0");

      // With no full release to keep, GitHub shows the first one; the run says so.
      const fresh = "kunchenguid/fresh-tap";
      gh.seed(fresh, "infinitary-alpha-v0.1.29-alpha.35", COMMIT, {}, { prerelease: true });
      const first = gh.run("match", fresh, "infinitary-v0.1.29", gh.zip("0.1.29", "build"), {
        TARGET: "main",
        PRERELEASE: "false",
        LATEST: "false",
      });
      expect(first.status, first.stderr).toBe(0);
      expect(gh.latest(fresh)).toBe("infinitary-v0.1.29");
    },
  );

  it("keeps the published bytes on a retry: the record is adopted, a different public copy is refused", () => {
    const gh = standInGh();
    const publishedBytes = `${VERSION} first build`;
    const publishedSha = sha256Of(publishedBytes);
    // An earlier attempt published the record, then failed before the public copy.
    gh.seed(PRIVATE, `v${VERSION}`, COMMIT, {
      [NAME]: publishedBytes,
      [`${NAME}.sha256`]: `${publishedSha}  ${NAME}\n`,
    });
    const rebuilt = gh.zip(VERSION, "second build");
    const retry = gh.run("adopt", PRIVATE, `v${VERSION}`, rebuilt, { PRERELEASE: "true" });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.outputs.state).toBe("adopted");
    expect(retry.outputs.sha256).toBe(publishedSha);
    expect(readFileSync(retry.outputs.zip as string, "utf8")).toBe(publishedBytes);
    expect(gh.published(PRIVATE, `v${VERSION}`)?.[NAME]).toBe(publishedBytes);
    // The adopted artifact goes on to the public copy; an identical retry is a no-op.
    const adopted = retry.outputs.zip as string;
    expect(
      gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, adopted, { PRERELEASE: "true" })
        .outputs.state,
    ).toBe("uploaded");
    expect(
      gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, adopted, { PRERELEASE: "true" })
        .outputs.state,
    ).toBe("identical");
    // The rebuilt bytes never replace the public copy.
    const refused = gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, rebuilt, {
      PRERELEASE: "true",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("published bytes never change");
    expect(gh.published(PUBLIC, `infinitary-alpha-v${VERSION}`)?.[NAME]).toBe(publishedBytes);
    expect(gh.calls().flat()).not.toContain("--clobber");
  });

  it("refuses a record whose tag names another commit, and a sidecar that disagrees", () => {
    const gh = standInGh();
    gh.seed(PRIVATE, `v${VERSION}`, OTHER_COMMIT, {});
    const zip = gh.zip(VERSION, "build");
    const elsewhere = gh.run("adopt", PRIVATE, `v${VERSION}`, zip, { PRERELEASE: "true" });
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain(
      `names ${OTHER_COMMIT}, not this release's source ${COMMIT}`,
    );
    expect(gh.published(PRIVATE, `v${VERSION}`)).toEqual({});

    gh.seed(PUBLIC, `infinitary-alpha-v${VERSION}`, COMMIT, {
      [`${NAME}.sha256`]: `${"0".repeat(64)}  ${NAME}\n`,
    });
    const sidecar = gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, zip, {
      PRERELEASE: "true",
    });
    expect(sidecar.status).toBe(1);
    expect(sidecar.stderr).toMatch(/\.sha256 names 0{64}/);
  });
});
