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
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_RELEASE_NAMES, releaseSource } from "../src/core/update/releaseSource";
import { renderCask } from "../src/core/update/tapPublication";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  parseBuilds,
  parseUpdateTargets,
  type UpdateTarget,
  type UpdateTargets,
} from "../src/core/update/updateChannels";
import { declaredStepOnly } from "./helpers/olderCask";
import { scratchDir } from "./helpers/scratchDirs";
import { baseEnv, standInGh } from "./helpers/standInGh";

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
  // every stable the tap will carry numbers above, so its first alpha publishes.
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
      const gh = standInGh(COMMIT);
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
      const gh = standInGh(COMMIT);
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
      const gh = standInGh(COMMIT);
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
    const gh = standInGh(COMMIT);
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

  // INF-2771: release run 42122748351's upload failed when GitHub answered the
  // record's create with HTTP 500 and made nothing.
  it("reads the release again after GitHub answers its create with a server error, and creates it once more only while missing", () => {
    const gh = standInGh(COMMIT);
    const zip = gh.zip(VERSION, "build");
    const sha = sha256Of(`${VERSION} build`);
    const creates = () =>
      gh.calls().filter(([command, verb]) => command === "release" && verb === "create").length;

    // As in run 42122748351: nothing was made, so the record is created again.
    const lost = gh.run("adopt", PRIVATE, `v${VERSION}`, zip, {
      PRERELEASE: "true",
      LATEST: "false",
      STANDIN_GH_CREATE_ERRORS: "lost",
    });
    expect(lost.status, lost.stderr).toBe(0);
    expect(lost.stderr).toContain(`HTTP 500 (https://api.github.com/repos/${PRIVATE}/releases)`);
    expect(lost.outputs).toEqual({ zip, sha256: sha, state: "uploaded" });
    expect(creates()).toBe(2);
    expect(gh.created(PRIVATE, `v${VERSION}`)).toEqual(
      expect.arrayContaining(["--target", COMMIT, "--prerelease", "--latest=false"]),
    );
    expect(gh.published(PRIVATE, `v${VERSION}`)).toEqual({
      [NAME]: `${VERSION} build`,
      [`${NAME}.sha256`]: `${sha}  ${NAME}\n`,
    });

    // GitHub made the release before its server error: that release is kept.
    const made = gh.run("match", PUBLIC, `infinitary-alpha-v${VERSION}`, zip, {
      TARGET: "main",
      PRERELEASE: "true",
      LATEST: "false",
      STANDIN_GH_CREATE_ERRORS: "made",
    });
    expect(made.status, made.stderr).toBe(0);
    expect(made.outputs.state).toBe("uploaded");
    expect(creates()).toBe(3);
    expect(gh.published(PUBLIC, `infinitary-alpha-v${VERSION}`)?.[NAME]).toBe(`${VERSION} build`);

    // A second server error fails the run, with nothing published.
    const record = "kunchenguid/stand-in-record";
    const twice = gh.run("adopt", record, `v${VERSION}`, zip, {
      PRERELEASE: "true",
      STANDIN_GH_CREATE_ERRORS: "lost,lost",
    });
    expect(twice.status).toBe(1);
    expect(creates()).toBe(5);
    expect(gh.published(record, `v${VERSION}`)).toBeNull();
  });

  it("refuses a record whose tag names another commit, and a sidecar that disagrees", () => {
    const gh = standInGh(COMMIT);
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

// INF-640: replacement feeds publish without Homebrew; exact artifacts precede one atomic commit.
describe("the Homebrew-free feed publication", () => {
  function fixture() {
    const dir = scratchDir("infinitary-feed-publication-");
    mkdirSync(join(dir, "home"));
    const bare = join(dir, "downloads.git");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const brewCalled = join(dir, "brew-called");
    writeFileSync(join(bin, "brew"), `#!/bin/sh\ntouch ${JSON.stringify(brewCalled)}\nexit 90\n`, {
      mode: 0o755,
    });
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir),
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(bare).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://github.com/${releaseSource.repository}.git`,
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--quiet", "--bare", "--initial-branch=main", bare);
    const seed = join(dir, "source");
    git("clone", "--quiet", bare, seed);
    writeFileSync(
      join(seed, "unchanged-source.txt"),
      "The feed writer never changes the project's default branch.\n",
    );
    git("-C", seed, "add", ".");
    git("-C", seed, "commit", "-qm", "chore: seed the download source");
    git("-C", seed, "push", "-q", "origin", "HEAD:main");
    const before = git("--git-dir", bare, "rev-parse", "main");
    // The publisher consumes already-verified opaque bytes; the signed workflow owns their format.
    const bytes = readFileSync(join(root, "packaging/build/icon.png"));
    let attempt = 0;
    const publish = (
      version: string,
      mode: "live" | "rehearsal" = "live",
      changedDmg = false,
      windows = false,
    ) => {
      const folder = join(dir, `artifacts-${++attempt}`);
      mkdirSync(folder);
      const installer = join(folder, `Infinitary-${version}-windows-x64-setup.exe`);
      if (windows) writeFileSync(installer, bytes);
      const zip = join(folder, `Infinitary-${version}-universal.zip`);
      const dmg = join(folder, `Infinitary-${version}-mac-universal.dmg`);
      writeFileSync(zip, bytes);
      writeFileSync(dmg, changedDmg ? Buffer.concat([bytes, Buffer.from("changed")]) : bytes);
      const file = { asset: `infinitary-${version}-linux-amd64.deb`, sha256: sha256Of(bytes) };
      writeFileSync(join(folder, file.asset), bytes);
      writeFileSync(join(folder, "assets.txt"), `${file.asset}\n`);
      const linux = join(folder, "linux.json");
      writeFileSync(
        linux,
        JSON.stringify({ alpha: { x64: { deb: file } }, stable: { x64: { deb: file } } }),
      );
      const work = join(dir, `publication-${attempt}`);
      const options = {
        cwd: root,
        encoding: "utf8" as const,
        env: {
          ...env,
          NODE_OPTIONS: `--import=${pathToFileURL(join(root, "tests/helpers/releaseStoragePreload.mjs")).href}`,
          RELEASE_STORAGE_FIXTURE: join(dir, "storage.json"),
          R2_ENDPOINT: "https://r2.example.test",
          R2_BUCKET: "installers",
          R2_ACCESS_KEY_ID: "disposable",
          R2_SECRET_ACCESS_KEY: "disposable-not-a-secret",
          LINUX_DIRECTORY: folder,
          WORK: work,
          VERSION: version,
          CHANNEL: version.includes("-alpha.") ? "alpha" : "stable",
          SOURCE_COMMIT: before,
          DIST_ZIP: zip,
          DIST_DMG: dmg,
          ...(windows ? { DIST_WINDOWS: installer } : {}),
          LINUX_MANIFEST: linux,
        },
      };
      if (mode === "live") {
        const upload = spawnSync(
          process.execPath,
          [join(root, "scripts/publish-downloads.ts")],
          options,
        );
        if (upload.status !== 0) return { ...upload, work };
      }
      const result = spawnSync("bash", [join(root, "scripts/publish-feeds.sh"), mode], options);
      expect(existsSync(brewCalled)).toBe(false);
      return { ...result, work };
    };
    const stored = () =>
      existsSync(join(dir, "storage.json"))
        ? JSON.parse(readFileSync(join(dir, "storage.json"), "utf8"))
        : {};
    const head = () => stored()["feeds/current.json"]?.etag;
    const object = (key: string) => stored()[key];
    const read = (name: string) => {
      const store = stored();
      const pointer = JSON.parse(
        Buffer.from(store["feeds/current.json"].bytes, "base64").toString(),
      );
      return JSON.parse(Buffer.from(store[`${pointer.prefix}${name}`].bytes, "base64").toString());
    };
    return { dir, bare, git, before, publish, head, read, object };
  }

  it("rehearses without a storage write, then publishes alpha, promoted stable and next alpha while leaving main alone", () => {
    const f = fixture();
    const rehearsal = f.publish("0.5.0-alpha.9", "rehearsal");
    expect(rehearsal.status, rehearsal.stderr).toBe(0);
    expect(f.git("--git-dir", f.bare, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main",
    );
    expect(existsSync(join(rehearsal.work, "feeds", "alpha-mac.yml"))).toBe(true);
    expect(existsSync(join(f.dir, "storage.json"))).toBe(false);
    for (const version of ["0.5.0-alpha.9", "0.5.0", "0.5.1-alpha.11"]) {
      const result = f.publish(version);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(f.read("latest-mac.yml").version).toBe("0.5.0");
    expect(f.read("alpha-mac.yml").version).toBe("0.5.1-alpha.11");
    expect(
      f.read(PUBLIC_RELEASE_NAMES.buildsFile).channels.alpha.systems.macos.arm64.dmg.url,
    ).toContain("/releases/v0.5.1-alpha.11/");
    expect(f.git("--git-dir", f.bare, "rev-parse", "main")).toBe(f.before);
    expect(
      Object.keys(JSON.parse(readFileSync(join(f.dir, "storage.json"), "utf8"))),
    ).not.toContain("Casks/infinitary.rb");
  });

  it("adopts an identical retry and refuses changed bytes or an older target without changing the remote", () => {
    const f = fixture();
    const first = f.publish("0.5.0-alpha.9");
    expect(first.status, first.stderr).toBe(0);
    const head = f.head();
    const retry = f.publish("0.5.0-alpha.9");
    expect(retry.status, retry.stderr).toBe(0);
    expect(f.head()).toBe(head);
    const changed = f.publish("0.5.0-alpha.9", "live", true);
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain("never change");
    expect(f.head()).toBe(head);
    const older = f.publish("0.5.0-alpha.8");
    expect(older.status).not.toBe(0);
    expect(older.stderr).toContain("never moves backwards");
    expect(f.head()).toBe(head);
  });

  // INF-5230's piece 1: an alpha publishes the Windows installer its Windows check tested.
  it("uploads an alpha's Windows installer beside the other downloads and names it in the builds file", () => {
    const f = fixture();
    const rehearsal = f.publish("0.5.0-alpha.9", "rehearsal", false, true);
    expect(rehearsal.status, rehearsal.stderr).toBe(0);
    expect(existsSync(join(f.dir, "storage.json"))).toBe(false);
    const rehearsed = JSON.parse(
      readFileSync(join(rehearsal.work, "feeds", PUBLIC_RELEASE_NAMES.buildsFile), "utf8"),
    );
    const name = "Infinitary-0.5.0-alpha.9-windows-x64-setup.exe";
    const key = `releases/v0.5.0-alpha.9/${name}`;
    expect(rehearsed.channels.alpha.systems.windows.x64.exe.url).toBe(
      `${releaseSource.downloadBase}${key}`,
    );
    const live = f.publish("0.5.0-alpha.9", "live", false, true);
    expect(live.status, live.stderr).toBe(0);
    const exe = f.read(PUBLIC_RELEASE_NAMES.buildsFile).channels.alpha.systems.windows.x64.exe;
    expect(exe).toEqual(rehearsed.channels.alpha.systems.windows.x64.exe);
    expect(exe.sha256).toBe(sha256Of(Buffer.from(f.object(key).bytes, "base64")));
    expect(Buffer.from(f.object(`${key}.sha256`).bytes, "base64").toString()).toBe(
      `${exe.sha256}  ${name}\n`,
    );
    expect(
      parseBuilds(f.read(PUBLIC_RELEASE_NAMES.buildsFile), PUBLIC_RELEASE_NAMES),
    ).not.toBeNull();
  });
});
