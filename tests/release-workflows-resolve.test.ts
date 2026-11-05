import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { presentationCommitMessage } from "../src/core/forge";
import { compareSemver, isAlphaVersion } from "../src/core/update/semver";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  publicTagFor,
} from "../src/core/update/updateChannels";
import {
  loadYamlFile,
  read,
  root,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The release's identity, its keys and how a release is resolved and numbered (release.yml). */

describe("signed release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("enforces the pinned identity", () => {
    expect(workflow).toContain('SIGN_IDENTITY: "Developer ID Application: Kun Chen (9T2J7MNUP9)"');
    expect(workflow).toContain("TEAM_ID: 9T2J7MNUP9");
  });

  it("resolves the documented signing and publication credentials through the workflow's expressions", () => {
    // Revised INF-643: independent credentials preserve both publication destinations.
    const names = [
      "MAC_DEVELOPER_ID_CERT_P12",
      "MAC_DEVELOPER_ID_CERT_PASSWORD",
      "APP_STORE_CONNECT_KEY_ID",
      "APP_STORE_CONNECT_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY",
      "R2_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "HOMEBREW_TAP_TOKEN",
      "OLD_TAP_TOKEN",
    ];
    const secrets = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
    const parsed = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<string, { steps?: { id?: string; env?: Record<string, string> }[] }>;
    };
    const expressions = Object.values(parsed.jobs)
      .flatMap((job) => (job.steps ?? []).flatMap((step) => Object.values(step.env ?? {})))
      .filter((value) => /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(value));
    expect(
      new Set(expressions.map((expression) => workflowValue(expression, { secrets }))),
    ).toEqual(new Set(Object.values(secrets)));
  });

  // INF-2498's plan, piece 2 (the captain's hosted-parallel choice): the
  // signing material stays on the real Mac; the upload keys move to a machine
  // GitHub hosts, and the virtual Mac keeps only what switching the casks and
  // feeds writes with, beside a read-only token for fetching the record back.
  // A step holds a key when its environment hands the key over whole;
  // no reusable workflow this one calls is handed any.
  it("pins which machine holds which key", () => {
    const parsed = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<
        string,
        {
          "runs-on"?: string;
          uses?: string;
          secrets?: unknown;
          permissions?: Record<string, string>;
          env?: Record<string, string>;
          steps?: { id?: string; name?: string; env?: Record<string, string> }[];
        }
      >;
    };
    const holders: Record<string, string[]> = {};
    for (const [id, job] of Object.entries(parsed.jobs)) {
      expect(job.secrets, id).toBeUndefined();
      const hold = (where: string, env: Record<string, string> | undefined) => {
        for (const value of Object.values(env ?? {})) {
          const key = /^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/.exec(value)?.[1];
          if (key) holders[key] = [...(holders[key] ?? []), where];
        }
      };
      hold(`${id}:(job)`, job.env);
      for (const step of job.steps ?? []) hold(`${id}:${step.id ?? step.name}`, step.env);
    }
    const phone = "phone:Find a phone build that keeps changing things on this release";
    expect(holders).toEqual({
      // The real Mac signs and notarizes; it reads the record and asks
      // whether the storage keys are set, and uploads with none.
      MAC_DEVELOPER_ID_CERT_P12: ["release:developer_id_cert"],
      MAC_DEVELOPER_ID_CERT_PASSWORD: ["release:developer_id_cert"],
      APP_STORE_CONNECT_KEY_ID: [phone, "release:asc-key", "release:notarize", "release:dmg"],
      APP_STORE_CONNECT_ISSUER_ID: [phone, "release:asc-key", "release:notarize", "release:dmg"],
      APP_STORE_CONNECT_API_KEY: [phone, "release:asc-key"],
      GITHUB_TOKEN: [
        "release:recorded",
        "upload:private",
        "upload:adopt",
        "upload:upload",
        "publish:private-fetch-back",
      ],
      R2_ENDPOINT: ["release:visibility", "upload:adopt", "upload:upload", "publish:feeds"],
      R2_ACCESS_KEY_ID: ["upload:adopt", "upload:upload", "publish:feeds"],
      R2_SECRET_ACCESS_KEY: ["upload:adopt", "upload:upload", "publish:feeds"],
      HOMEBREW_TAP_TOKEN: ["upload:adopt", "upload:upload", "publish:tap"],
      OLD_TAP_TOKEN: ["upload:adopt", "upload:upload", "publish:old-tap"],
    });
    // The workflow token writes only from the hosted upload job.
    expect(parsed.jobs.release?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(parsed.jobs.upload?.permissions).toEqual({ contents: "write", actions: "read" });
    expect(parsed.jobs.publish?.permissions).toEqual({ contents: "read", actions: "read" });
    // The uploads run on a machine GitHub hosts, whatever the Mac queues say;
    // the signing and the checks stay on the Mac kinds the queue test pins.
    const vars = { MAC_QUEUES: JSON.stringify({ sign: "q-sign", light: "q-light" }) };
    const runner = (id: string) =>
      workflowString(parsed.jobs[id]?.["runs-on"] ?? "", {
        needs: { resolve: { outputs: { dry_run: "true" } } },
        vars,
      });
    expect(runner("upload")).toBe("ubuntu-24.04");
    expect(runner("release")).toBe("q-sign");
    expect(runner("publish")).toBe("q-light");
  });

  it("runs every gate: verify, launch, notarize, staple, re-download", () => {
    expect(workflow).toContain("scripts/verify-app.sh");
    expect(workflow).toContain("--signed --gatekeeper");
    expect(workflow).toContain("scripts/check-app-launch.sh");
    expect(workflow).toContain("xcrun notarytool submit");
    expect(workflow).toContain("xcrun stapler staple");
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("shasum -a 256 -c");
  });

  it("takes the umami config from repository variables, not secrets", () => {
    expect(workflow).toContain("vars.INFINITARY_UMAMI_HOST");
    expect(workflow).toContain("vars.INFINITARY_UMAMI_WEBSITE_ID");
    expect(workflow).not.toContain("secrets.INFINITARY_UMAMI");
  });
});

/** A valid checksum: the generator refuses anything but 64 lowercase hex digits. */
const CASK_SHA256 = "ab".repeat(32);

/**
 * The release's one source commit and its names (docs/alpha.md "The signed
 * channel workflow"), by running the resolve job's own script on stand-in
 * clones: an alpha releases its reviewed candidate, a stable promotes a
 * published alpha's own commit, and both are numbered from the newest
 * stable tag.
 */
describe("resolving a release", () => {
  const script = join(root, "scripts", "resolve-release.sh");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const release = loadYamlFile(".github/workflows/release.yml") as { env: Record<string, string> };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=resolve", "-c", "user.email=resolve@localhost", ...args],
      { cwd, env: gitEnv, encoding: "utf8" },
    ).trim();

  /**
   * A stand-in clone on main: stable v0.1.25, a fix, alpha v0.1.26-alpha.12
   * on it, another fix and alpha v0.1.26-alpha.13, and a last commit nothing
   * was built from. origin/main is main's head, as the resolve job's full
   * checkout has it.
   */
  function fixture() {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      return git(clone, "rev-parse", "HEAD");
    };
    commit("chore: first", { "src.txt": "0", "release-notes/changes/first.json": "{}" });
    git(clone, "tag", "v0.1.25");
    commit("fix: one", { "src.txt": "1" });
    git(clone, "tag", "v0.1.26-alpha.12");
    commit("chore: two");
    const alpha13 = commit("fix: three", { "src.txt": "3" });
    git(clone, "tag", "v0.1.26-alpha.13");
    const head = commit("fix: after the alpha", { "src.txt": "4" });
    git(clone, "update-ref", "refs/remotes/origin/main", head);
    return { clone, commit, alpha13, head };
  }

  it("keeps a promoted source's download destination when main selects a different host", () => {
    // INF-640: an updater and the publication it reads must use the same selected destination.
    const f = fixture();
    const configuration = read("packaging/release-source.json");
    const source = f.commit("feat: select the download host", {
      "packaging/release-source.json": configuration,
    });
    f.commit("chore: select a different future host", {
      "packaging/release-source.json": JSON.stringify({
        ...JSON.parse(configuration),
        downloadBase: "https://future-downloads.example/",
      }),
    });
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { resolve: { steps: { id?: string; run?: string }[] } };
    };
    const body = workflow.jobs.resolve.steps.find((step) => step.id === "destination")?.run;
    if (!body) throw new Error("The source destination reader is missing");
    const output = join(scratchDir("inf-release-source-output-"), "output");
    const result = spawnSync("bash", ["-c", body], {
      cwd: f.clone,
      encoding: "utf8",
      env: { ...gitEnv, SOURCE_COMMIT: source, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `repository=${JSON.parse(configuration).repository}\ndownload_base=${JSON.parse(configuration).downloadBase}\n`,
    );
  });

  /** Runs the resolver in a clone, returning its outputs. */
  function resolve(clone: string, env: Record<string, string>) {
    const output = join(scratchDir("infinitary-release-resolve-output-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", [script], {
      cwd: clone,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...gitEnv,
        TAP_REPO: release.env.TAP_REPO ?? "",
        TAP_TAG_PREFIX: release.env.TAP_TAG_PREFIX ?? "",
        OLD_TAP_REPO: release.env.OLD_TAP_REPO ?? "",
        OLD_TAP_TAG_PREFIX: release.env.OLD_TAP_TAG_PREFIX ?? "",
        GITHUB_OUTPUT: output,
        CHANNEL: "alpha",
        DRY_RUN: "false",
        REF: "refs/heads/main",
        RUN_NUMBER: "7",
        CANDIDATE: "",
        PROMOTE: "",
        HIGHLIGHTS: "",
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status: result.status, stderr: result.stderr, outputs };
  }

  /** The names a version's release carries, as the update reader builds them. */
  const publicNames = (version: string, commit: string) => {
    const target = buildUpdateTarget({
      version,
      assetName: `Infinitary-${version}-universal.zip`,
      sha256: CASK_SHA256,
      sourceCommit: commit,
    });
    return {
      zip_name: `Infinitary-${version}-universal.zip`,
      release_url: target.releaseUrl,
      download_url: target.downloadUrl,
      public_tag: target.releaseUrl.slice(target.releaseUrl.lastIndexOf("/") + 1),
    };
  };

  /**
   * The names the old-cask switch would publish the same version under, as
   * an installed Firstmate 3000's reader builds them (FI3-1780 step 10).
   */
  const oldNames = (version: string) => ({
    old_public_tag: publicTagFor(version, FIRSTMATE_TAP),
    old_download_url: buildDownloadUrl(
      version,
      `Infinitary-${version}-universal.zip`,
      FIRSTMATE_TAP,
    ),
  });

  const refusedWith = (result: ReturnType<typeof resolve>, reason: RegExp) => {
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(reason);
    expect(result.outputs).toEqual({});
  };

  it("releases the reviewed candidate: main's own commit or a notes-only commit off it, never a code change", () => {
    const { clone, commit, head } = fixture();
    // A main commit.
    const onMain = resolve(clone, { CANDIDATE: head });
    expect(onMain.status, onMain.stderr).toBe(0);
    expect(onMain.outputs.source_commit).toBe(head);
    // The release crewmate's review, committed on its own branch, while main moves on.
    git(clone, "checkout", "-q", "-b", "fm/release-review");
    const review = commit("docs(release-notes): review the next alpha", {
      "release-notes/changes/first.json": '{"reviewed": true}',
      "release-notes/releases/0.1.26-alpha.13.json": "{}",
    });
    git(clone, "checkout", "-q", "main");
    const moved = commit("feat: merged during the review", { "src.txt": "5" });
    git(clone, "update-ref", "refs/remotes/origin/main", moved);
    const notesOnly = resolve(clone, { CANDIDATE: review });
    expect(notesOnly.status, notesOnly.stderr).toBe(0);
    expect(notesOnly.outputs).toMatchObject({ source_commit: review, version: "0.1.26-alpha.7" });
    // A candidate that changes code is refused, and so is anything but a pushed commit id.
    git(clone, "checkout", "-q", "-b", "fm/sneaky", review);
    const code = commit("docs(release-notes): review, and a fix", { "src.txt": "6" });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: code }),
      /changes more than release notes since main's [0-9a-f]{40} \(src\.txt\)/,
    );
    git(clone, "checkout", "-q", "fm/sneaky");
    const wide = commit("chore: and much more", {
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`${name}.txt`, name])),
    });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: wide }),
      /\(a\.txt b\.txt c\.txt d\.txt e\.txt and 1 more\)/,
    );
    refusedWith(resolve(clone, { CANDIDATE: review.slice(0, 12) }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "fm/release-review" }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "f".repeat(40) }), /on no branch of the repository/);
    // A live alpha needs one; a rehearsal may build the checked-out commit.
    refusedWith(resolve(clone, {}), /a live alpha releases a candidate/);
    expect(resolve(clone, { DRY_RUN: "true" }).outputs.source_commit).toBe(moved);
  });

  it("numbers an alpha from the newest stable tag and the run, the next minor after a breaking change", () => {
    const { clone, commit, head } = fixture();
    const alpha = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "312" });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toEqual({
      channel: "alpha",
      dry_run: "false",
      source_commit: head,
      version: "0.1.26-alpha.312",
      bundle_version: "0.1.26",
      tag_name: "v0.1.26-alpha.312",
      ...publicNames("0.1.26-alpha.312", head),
      cask_token: CASK_TOKENS.alpha,
      old_cask: "false",
      ...oldNames("0.1.26-alpha.312"),
      prerelease: "true",
      promoted_from: "",
      highlights: "",
    });
    expect(alpha.outputs.public_tag).toBe("infinitary-alpha-v0.1.26-alpha.312");
    expect(isAlphaVersion(alpha.outputs.version as string)).toBe(true);
    // Later runs sort later: alpha.10 is newer than alpha.9.
    const ninth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "9" });
    const tenth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "10" });
    expect(
      compareSemver(tenth.outputs.version as string, ninth.outputs.version as string),
    ).toBeGreaterThan(0);
    // Only bare stable tags number a release.
    git(clone, "tag", "v9.9.9-beta.1");
    git(clone, "tag", "infinitary-v9.0.0");
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.26-alpha.7");
    // A newer stable moves the line; a breaking change since it takes the next minor.
    git(clone, "tag", "v0.1.26", head);
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.27-alpha.7");
    const breaking = commit("feat(cards)!: drop the old card shape", { "src.txt": "7" });
    git(clone, "update-ref", "refs/remotes/origin/main", breaking);
    expect(resolve(clone, { CANDIDATE: breaking }).outputs.version).toBe("0.2.0-alpha.7");
    // INF-228 F2: the actual squash-summary owner keeps the release reader's footer reachable.
    const footer = commit(
      `fix: x\n\n${presentationCommitMessage({
        whatChanged: ["Move saved data to the new folder."],
        projectText: "BREAKING CHANGE: saved data moves",
      })}`,
      { "src.txt": "8" },
    );
    git(clone, "tag", "v0.2.0", breaking);
    git(clone, "update-ref", "refs/remotes/origin/main", footer);
    expect(resolve(clone, { CANDIDATE: footer }).outputs.version).toBe("0.3.0-alpha.7");
    // A rehearsal may run from any branch; a live alpha comes from main.
    expect(
      resolve(clone, { DRY_RUN: "true", REF: "refs/heads/fm/x", RUN_NUMBER: "8" }).outputs.version,
    ).toBe("0.3.0-alpha.8");
    for (const [env, reason] of [
      [{ CANDIDATE: footer, REF: "refs/heads/fm/x" }, /a live alpha is requested from main/],
      [{ CANDIDATE: footer, PROMOTE: "0.1.26-alpha.13" }, /promote is for stable/],
      [{ CANDIDATE: footer, HIGHLIGHTS: "lead-change" }, /highlights are for stable/],
      [{ CANDIDATE: footer, RUN_NUMBER: "0" }, /not a positive whole number/],
      [{ CHANNEL: "beta" }, /neither stable nor alpha/],
    ] as const) {
      refusedWith(resolve(clone, env), reason);
    }
  });

  // The old-cask switch (FI3-1780 step 10; steps 13 and 14 list a channel):
  // only a channel the workflow commit's switch file lists also publishes
  // under Firstmate 3000's cask.
  it("switches Firstmate 3000's cask only for a channel the switch file lists", () => {
    const { clone, head } = fixture();
    expect(resolve(clone, { CANDIDATE: head }).outputs.old_cask).toBe("false");
    mkdirSync(join(clone, "packaging"), { recursive: true });
    writeFileSync(
      join(clone, "packaging", "old-cask-switch.json"),
      JSON.stringify({ schemaVersion: 1, channels: ["alpha"] }),
    );
    const alpha = resolve(clone, { CANDIDATE: head });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toMatchObject({ old_cask: "true", ...oldNames("0.1.26-alpha.7") });
    expect(alpha.outputs.old_public_tag).toBe("firstmate-3000-alpha-v0.1.26-alpha.7");
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs.old_cask).toBe("false");
    // The repository's own switch file lists alpha (step 13, INF-35) and
    // stable (step 14, INF-36): both of Firstmate 3000's casks move to Infinitary.
    expect(
      JSON.parse(readFileSync(join(root, "packaging", "old-cask-switch.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, channels: ["alpha", "stable"] });
  });

  it("promotes a published alpha newer than the latest stable on the alpha's own commit, with the captain's picks and no pull request", () => {
    const HIGHLIGHTS = "lead-change, second-change,third-change";
    for (const alpha of ["0.1.26-alpha.13", "0.1.26-alpha.12"]) {
      const { clone } = fixture();
      const commit = git(clone, "rev-parse", `v${alpha}^{commit}`);
      const promoted = resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS });
      expect(promoted.status, promoted.stderr).toBe(0);
      expect(promoted.outputs).toEqual({
        channel: "stable",
        dry_run: "false",
        source_commit: commit,
        version: "0.1.26",
        bundle_version: "0.1.26",
        tag_name: "v0.1.26",
        ...publicNames("0.1.26", commit),
        cask_token: CASK_TOKENS.stable,
        old_cask: "false",
        ...oldNames("0.1.26"),
        prerelease: "false",
        promoted_from: alpha,
        highlights: "lead-change,second-change,third-change",
      });
      expect(promoted.outputs.public_tag).toBe("infinitary-v0.1.26");
      // The release tags that same commit; promoting it again retries the
      // same promotion, and any other alpha of that version is refused.
      git(clone, "tag", "v0.1.26", commit);
      expect(
        resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS }).outputs.source_commit,
      ).toBe(commit);
      const other = alpha.endsWith(".13") ? "0.1.26-alpha.12" : "0.1.26-alpha.13";
      refusedWith(
        resolve(clone, { CHANNEL: "stable", PROMOTE: other, HIGHLIGHTS }),
        /already released/,
      );
    }
    // A stable rehearsal may build the checked-out commit as the next stable,
    // and keep the alpha reviews' ranks.
    const { clone, head } = fixture();
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs).toMatchObject({
      source_commit: head,
      version: "0.1.26",
      promoted_from: "",
      highlights: "",
    });
  });

  it.each([
    [{ REF: "refs/heads/fm/x" }, /a promotion is requested from main/],
    [{ PROMOTE: "0.1.26" }, /not an alpha version/],
    [{ PROMOTE: "0.1.26-alpha.99" }, /is not published/],
    [{ PREPARE: "newer-stable" }, /not newer than the latest stable, 0\.1\.27/],
    [{ PREPARE: "no-feat-fix" }, /nothing to release/],
    [{ PROMOTE: "" }, /a stable promotes a published alpha/],
    [{ CANDIDATE: "c".repeat(40) }, /candidate is for alpha/],
    [{ HIGHLIGHTS: "" }, /a stable ships the highlights the captain picked on its card/],
    [{ HIGHLIGHTS: "lead-change,Second" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,three-c,four-d" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,one-a" }, /name a change twice/],
  ])("refuses the stable promotion %j", (env, reason) => {
    const { clone, commit } = fixture();
    const { PREPARE, ...rest } = {
      HIGHLIGHTS: "lead-change,second-change,third-change",
      ...env,
    } as Record<string, string>;
    let promote = "0.1.26-alpha.13";
    if (PREPARE === "newer-stable") {
      git(clone, "tag", "v0.1.27");
    } else if (PREPARE === "no-feat-fix") {
      git(clone, "tag", "-f", "v0.1.25");
      commit("chore: x");
      git(clone, "tag", "v0.1.26-alpha.14");
      promote = "0.1.26-alpha.14";
    }
    refusedWith(resolve(clone, { CHANNEL: "stable", PROMOTE: promote, ...rest }), reason);
  });

  /**
   * Step 7 of the Infinitary rename (FI3-1780's plan): a repository that
   * starts again from one parentless commit has no tag to number from, so it
   * numbers from the record of past releases, above every version either
   * channel published, until it tags a stable of its own.
   */
  it("numbers a fresh history above every version its record of past releases names", () => {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      const head = git(clone, "rev-parse", "HEAD");
      git(clone, "update-ref", "refs/remotes/origin/main", head);
      return head;
    };
    const archive = (stable: string, alpha: string) =>
      JSON.stringify({ schema: 1, repository: "owner/archived", stable, alpha, releases: {} });
    const root = commit("chore: initialize from the archived tree", {
      "src.txt": "0",
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    expect(git(clone, "rev-list", "--count", "--all")).toBe("1");
    // Run numbers start again in a new repository, and still sort above the archive.
    const first = resolve(clone, { CANDIDATE: root, RUN_NUMBER: "1" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({ source_commit: root, version: "0.4.2-alpha.1" });
    // An alpha the archived history cut past its last stable lifts the line too.
    commit("chore: an alpha past the stable", {
      "release-notes/archive.json": archive("0.4.1", "0.4.2-alpha.80"),
    });
    const past = commit("fix: something");
    expect(resolve(clone, { CANDIDATE: past, RUN_NUMBER: "2" }).outputs.version).toBe(
      "0.4.3-alpha.2",
    );
    // A breaking change anywhere in this history takes the next minor.
    const breaking = commit("feat(cards)!: a new card shape");
    expect(resolve(clone, { CANDIDATE: breaking, RUN_NUMBER: "3" }).outputs.version).toBe(
      "0.5.0-alpha.3",
    );
    // A stable promotes past the archived stable, with no tag of it here.
    git(clone, "tag", "v0.5.0-alpha.3", breaking);
    const promoted = resolve(clone, {
      CHANNEL: "stable",
      PROMOTE: "0.5.0-alpha.3",
      HIGHLIGHTS: "lead-change",
    });
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(promoted.outputs).toMatchObject({ source_commit: breaking, version: "0.5.0" });
    // Once this history tags its own stable, it numbers from that.
    git(clone, "tag", "v0.5.0", breaking);
    const after = commit("fix: after the first stable");
    expect(resolve(clone, { CANDIDATE: after, RUN_NUMBER: "4" }).outputs.version).toBe(
      "0.5.1-alpha.4",
    );
    // A version at or below an archived one is refused, whatever tag says otherwise.
    git(clone, "tag", "-d", "v0.5.0");
    git(clone, "tag", "-d", "v0.5.0-alpha.3");
    const stray = commit("chore: back to the archived line", {
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    git(clone, "tag", "v0.4.0", stray);
    const low = commit("fix: numbered from a stray old tag");
    refusedWith(
      resolve(clone, { CANDIDATE: low, RUN_NUMBER: "5" }),
      /0\.4\.1-alpha\.5 is not newer than 0\.4\.1, which the archived history already published/,
    );
  });

  it("opens no pull request: no release proposal workflow, its configuration or its branch script remains", () => {
    for (const retired of [
      ".github/workflows/release-please.yml",
      "release-please-config.json",
      ".release-please-manifest.json",
      "scripts/promote-alpha.sh",
    ]) {
      expect(existsSync(join(root, retired)), retired).toBe(false);
    }
    for (const name of [
      "ci.yml",
      "release.yml",
      "mac-installer.yml",
      "mac-update.yml",
      "verify.yml",
    ]) {
      const workflow = loadYamlFile(`.github/workflows/${name}`) as {
        on: Record<string, unknown>;
        permissions?: Record<string, string>;
      };
      expect(workflow.permissions?.["pull-requests"], name).toBeUndefined();
      expect(read(`.github/workflows/${name}`), name).not.toMatch(
        /gh pr create|create-pull-request/,
      );
    }
  });
});
