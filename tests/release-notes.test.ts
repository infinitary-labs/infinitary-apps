import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitMessage } from "../scripts/batch-regenerate.ts";
import { newestStables } from "../scripts/docs-site-whats-new.ts";
import { run } from "../scripts/release-notes";
import { webpBytes } from "./helpers/images";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The release-notes gate, run the way release.yml runs it: the real
 * `scripts/release-notes.ts` against a scratch git repository with real
 * commits and tags (docs/release-notes.md "The release check"). Nothing
 * reaches a network and no signing material is involved.
 */

// Each case makes a handful of real commits and runs the CLI over them.
vi.setConfig({ testTimeout: 10_000 });

class Fixture {
  readonly dir = scratchDir("infinitary-release-notes-");

  constructor() {
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: this.dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@localhost",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@localhost",
      },
    }).trim();
  }

  /** One commit that writes `files` (text, bytes, or JSON); returns its id. */
  commit(message: string, files: Record<string, unknown>): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(
        join(this.dir, path),
        typeof content === "string" || Buffer.isBuffer(content)
          ? content
          : `${JSON.stringify(content, null, 2)}\n`,
      );
    }
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  tag(version: string): void {
    this.git("tag", `v${version}`);
  }

  cli(...args: string[]): string {
    return run([...args, "--repo", this.dir]);
  }

  read(path: string): unknown {
    return JSON.parse(readFileSync(join(this.dir, path), "utf8"));
  }
}

const note = (id: string, title = `Title of ${id}`, extra: Record<string, unknown> = {}) => ({
  entries: [
    {
      id,
      kind: "feature",
      title,
      area: "cards",
      noPicture: "Nothing on screen changes.",
      provenance: { origin: "change" },
      ...extra,
    },
  ],
});

/** A highlighted note with its hero pair, and the pair's files, for one commit. */
const pictured = (id: string, highlight?: number) => {
  const { noPicture: _none, ...entry } = note(id).entries[0] as Record<string, unknown>;
  return {
    [`release-notes/changes/${id}.json`]: {
      entries: [
        {
          ...entry,
          ...(highlight ? { highlight } : {}),
          picture: { dark: `${id}-dark.webp`, light: `${id}-light.webp`, alt: `The ${id} view` },
        },
      ],
    },
    [`release-notes/pictures/${id}-dark.webp`]: webpBytes(1200, 600, 40),
    [`release-notes/pictures/${id}-light.webp`]: webpBytes(1200, 600, 60),
  };
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The release crewmate's pin of a published release: its record, with a
 * promoted stable's picked highlights, and the exclusion that excuses the commit.
 */
function pin(f: Fixture, version: string, highlights?: string): string {
  f.cli(
    "manifest",
    "--version",
    version,
    ...(highlights ? ["--highlights", highlights] : []),
    "--write",
  );
  const id = `pin-${version.replace(/\./g, "-")}`;
  return f.commit(`chore(release-notes): pin ${version}`, {
    [`release-notes/changes/${id}.json`]: {
      exclusions: [{ id, reason: "Records a published release." }],
    },
  });
}

/** A fixture with one published, pinned stable release and a clean notes ledger. */
function released(): { f: Fixture; base: string } {
  const f = new Fixture();
  f.commit("init", { "src.txt": "0", "release-notes/changes/init.json": note("first-feature") });
  f.commit("release 1.0.0", { "package.json": '{"version":"1.0.0"}' });
  f.tag("1.0.0");
  return { f, base: pin(f, "1.0.0") };
}

describe("the release check", () => {
  it("refuses a release with a source change that has no note or exclusion", () => {
    const { f } = released();
    f.commit("feat: a change with no declaration", { "src.txt": "1" });
    const source = f.git("rev-parse", "HEAD");
    expect(() => f.cli("check", "--source", source, "--reviewed", source)).toThrow(
      /1 source change\(s\) since v1\.0\.0 have no note[\s\S]*a change with no declaration/,
    );
  });

  it("passes when the change's own pull request adds a note", () => {
    const { f } = released();
    const source = f.commit("feat: noted", {
      "src.txt": "1",
      "release-notes/changes/noted.json": note("noted-change"),
    });
    expect(f.cli("check", "--source", source, "--reviewed", source)).toContain("all covered");
  });

  it("credits each note file to the commit that added it, read for every note at once", () => {
    const { f } = released();
    f.commit("feat: one", { "src.txt": "1", "release-notes/changes/one.json": note("one-change") });
    // A later change that edits an earlier note takes no credit from it.
    f.commit("feat: two", {
      "src.txt": "2",
      "release-notes/changes/two.json": note("two-change"),
      "release-notes/changes/one.json": note("one-change", "Edited title"),
    });
    f.commit("feat: three", {
      "src.txt": "3",
      "release-notes/changes/three.json": note("three-change"),
    });
    // A renamed note is added under its new name, so it credits the renaming
    // commit, and the change that wrote it first is left uncovered.
    f.git("mv", "release-notes/changes/three.json", "release-notes/changes/renamed.json");
    const source = f.commit("feat: rename", { "src.txt": "4" });
    const message = (() => {
      try {
        return f.cli("check", "--source", source, "--reviewed", source);
      } catch (error) {
        return String(error);
      }
    })();
    expect(message).toMatch(/1 source change\(s\) since v1\.0\.0 have no note/);
    expect(message).toMatch(/feat: three/);
    expect(message).not.toMatch(/feat: (one|two|rename)/);
  });

  it("passes with a reviewed exclusion that names the change it excuses", () => {
    const { f } = released();
    const change = f.commit("chore: internal tooling", { "tool.txt": "1" });
    const source = f.commit("docs: review the exclusion", {
      "release-notes/changes/excuse.json": {
        exclusions: [{ id: "internal-tooling", reason: "Tooling only.", covers: [change] }],
      },
    });
    expect(f.cli("check", "--source", source, "--reviewed", source)).toContain("all covered");
  });

  it("refuses an alpha whose candidate is not the resolved source", () => {
    const { f, base } = released();
    const source = f.commit("feat: more", {
      "release-notes/changes/more.json": note("more-change"),
    });
    expect(() => f.cli("check", "--source", source, "--reviewed", base)).toThrow(
      /candidate .* is not the workflow's resolved source/,
    );
    expect(() => f.cli("check", "--source", source)).toThrow(/a candidate is required/);
    // A rehearsal may omit the candidate; a live release may not.
    expect(f.cli("check", "--source", source, "--rehearsal")).toContain("all covered");
  });

  it("refuses a checkout that is not the release source", () => {
    const { f, base } = released();
    f.commit("feat: later", { "release-notes/changes/later.json": note("later-change") });
    expect(() => f.cli("check", "--source", base, "--reviewed", base)).toThrow(
      /not the release source/,
    );
  });

  it("measures a later alpha from the previous alpha, not the stable before it", () => {
    const { f } = released();
    f.commit("feat: first alpha change", {
      "release-notes/changes/a.json": note("alpha-one-change"),
    });
    f.tag("1.0.1-alpha.3");
    pin(f, "1.0.1-alpha.3");
    f.commit("feat: undeclared after the alpha", { "src.txt": "2" });
    const source = f.git("rev-parse", "HEAD");
    expect(() => f.cli("check", "--source", source, "--reviewed", source)).toThrow(
      /since v1\.0\.1-alpha\.3/,
    );
  });

  it("measures an alpha from a previous alpha cut from a notes-only candidate off main", () => {
    const { f } = released();
    const reviewed = f.commit("feat: reviewed change", {
      "src.txt": "1",
      "release-notes/changes/reviewed.json": note("reviewed-change"),
    });
    // The release crewmate's review, committed on its own branch, is the candidate.
    f.git("checkout", "-q", "-b", "release-review");
    f.commit("docs(release-notes): review the next alpha", {
      "release-notes/changes/reviewed.json": note("reviewed-change", "A clearer title"),
      "release-notes/changes/review.json": {
        exclusions: [{ id: "review-one", reason: "Reviews the notes." }],
      },
    });
    f.tag("1.0.1-alpha.3");
    // Main moves on; the review and its record reach it later.
    f.git("checkout", "-q", "main");
    f.commit("feat: undeclared after the review", { "src.txt": "2" });
    f.cli("manifest", "--version", "1.0.1-alpha.3", "--write");
    const source = f.commit("chore(release-notes): pin 1.0.1-alpha.3", {
      "release-notes/changes/pin-alpha-3.json": {
        exclusions: [{ id: "pin-alpha-3", reason: "Records a published release." }],
      },
    });
    // Measured from the candidate, not the stable before it: the reviewed change
    // shipped in the alpha and is not counted again.
    const refusal = (() => {
      try {
        f.cli("check", "--source", source, "--reviewed", source);
        return "";
      } catch (error) {
        return String(error);
      }
    })();
    expect(refusal).toMatch(/1 source change\(s\) since v1\.0\.1-alpha\.3 have no note/);
    expect(refusal).toContain("undeclared after the review");
    expect(refusal).not.toContain(reviewed.slice(0, 12));
  });

  // INF-2259: an automatic alpha uses exact-main code, without a notes-only
  // commit that would invalidate its full-check proof. Immutable tags supply
  // historical manifests through the existing publishedReleases reader.
  it("checks an exact-main cut against tagged history without requiring a new notes commit", () => {
    const { f, base } = released();
    f.commit("feat: alpha change", { "release-notes/changes/a.json": note("alpha-change") });
    f.tag("1.0.1-alpha.4");
    const source = f.commit("feat: next", {
      "release-notes/changes/next.json": note("next-change"),
    });
    expect(f.cli("check", "--source", source, "--verified-main", source)).toContain("all covered");
    expect(() => f.cli("check", "--source", source, "--verified-main", base)).toThrow(
      /not the workflow's resolved source/,
    );
    f.tag("1.0.1-alpha.5");
    expect(
      f.cli(
        "check",
        "--source",
        source,
        "--channel",
        "stable",
        "--version",
        "1.0.1",
        "--promoted-from",
        "1.0.1-alpha.5",
      ),
    ).toContain("unchanged");
    const missing = f.commit("feat: undeclared", { "src.txt": "unnoted change" });
    expect(() => f.cli("check", "--source", missing, "--verified-main", missing)).toThrow(
      /have no note/,
    );
  });

  it("refuses a published release with no record, except the release being cut or promoted", () => {
    const { f } = released();
    f.commit("feat: alpha change", { "release-notes/changes/a.json": note("alpha-change") });
    f.tag("1.0.1-alpha.4");
    const alpha = f.git("rev-parse", "HEAD");
    // The stable promoted from it builds the alpha's own commit, before either has a record.
    expect(
      f.cli(
        "check",
        "--source",
        alpha,
        "--channel",
        "stable",
        "--version",
        "1.0.1",
        "--promoted-from",
        "1.0.1-alpha.4",
      ),
    ).toContain("unchanged");
    f.tag("1.0.1");
    const source = f.commit("feat: next", {
      "release-notes/changes/next.json": note("next-change"),
    });
    expect(() => f.cli("check", "--source", source, "--reviewed", source)).toThrow(
      /2 published release\(s\) have no record in release-notes\/releases\/: 1\.0\.1-alpha\.4, 1\.0\.1/,
    );
    pin(f, "1.0.1-alpha.4");
    // One change since the last stable fills one highlight slot.
    const pinned = pin(f, "1.0.1", "alpha-change");
    expect(f.cli("check", "--source", pinned, "--reviewed", pinned)).toContain(
      "since v1.0.1 are all covered",
    );
  });

  // A rehearsal dispatched on a branch, with no candidate, stopped at this
  // check because past alphas had no committed record, though it publishes no
  // tag and pins nothing. It reads them from their tags, as an exact-main cut
  // does; a live alpha and a rehearsal of its candidate do not.
  it("rehearses the dispatched commit against tagged history, while a candidate still waits for every record", () => {
    const { f } = released();
    f.commit("feat: alpha change", { "release-notes/changes/a.json": note("alpha-change") });
    f.tag("1.0.1-alpha.4");
    f.git("checkout", "-q", "-b", "task");
    const source = f.commit("feat: a task's change", {
      "src.txt": "1",
      "release-notes/changes/task.json": note("task-change"),
    });
    const at = ["check", "--source", source, "--version", "1.0.1-alpha.5"];
    expect(f.cli(...at, "--rehearsal")).toBe(
      "1 source change(s) since v1.0.1-alpha.4 are all covered",
    );
    expect(f.cli(...at, "--channel", "stable", "--rehearsal")).toContain(
      "since v1.0.1-alpha.4 are all covered",
    );
    const unpinned =
      /1 published release\(s\) have no record in release-notes\/releases\/: 1\.0\.1-alpha\.4/;
    expect(() => f.cli(...at, "--reviewed", source)).toThrow(unpinned);
    expect(() => f.cli(...at, "--reviewed", source, "--rehearsal")).toThrow(unpinned);
    // Reading the tags excuses no change from its note.
    const missing = f.commit("feat: undeclared", { "src.txt": "2" });
    expect(() => f.cli("check", "--source", missing, "--rehearsal")).toThrow(
      /1 source change\(s\) since v1\.0\.1-alpha\.4 have no note/,
    );
  });
});

/**
 * The pull request's own step (ci.yml, `change --base`; INF-2414, the
 * captain: "why can't we catch release note problems before merge?"): the
 * alpha's coverage rule for one change, before its squash commit exists.
 */
describe("the pull request's notes step", () => {
  it("refuses a change that adds no note or exclusion, or a malformed note, and passes one that the alpha would cover", () => {
    const { f, base } = released();
    f.git("checkout", "-q", "-b", "change");
    f.commit("test: a change with no declaration", { "src.txt": "1" });
    expect(() => f.cli("change", "--base", "main")).toThrow(
      /this change adds no file under release-notes\/changes\/ with a note or an exclusion/,
    );
    // Editing a note another change added does not credit this change.
    f.commit("docs: reword an old note", {
      "release-notes/changes/init.json": note("first-feature", "A clearer title"),
    });
    expect(() => f.cli("change", "--base", "main")).toThrow(/adds no file/);
    // Inside GitHub Actions the refusal is an error line, so the check's
    // summary says why it failed (INF-4305; docs/testing.md, "A failed check
    // says why").
    const step = spawnSync(
      process.execPath,
      ["scripts/release-notes.ts", "change", "--base", "main", "--repo", f.dir],
      { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } },
    );
    expect(step.status).toBe(1);
    expect(step.stderr).toMatch(
      /^::error title=Release notes::this change adds no file under release-notes\/changes\/ with a note or an exclusion/,
    );
    const { area: _area, ...noArea } = note("bad").entries[0] as Record<string, unknown>;
    f.commit("feat: a note without its area", {
      "release-notes/changes/bad.json": { entries: [noArea] },
    });
    expect(() => f.cli("change", "--base", "main")).toThrow(/area/);
    f.git("rm", "-q", "release-notes/changes/bad.json");
    f.commit("test: record the exclusion", {
      "release-notes/changes/internal-test.json": {
        exclusions: [{ id: "internal-test", reason: "Tests only." }],
      },
    });
    expect(f.cli("change", "--base", "main")).toContain("release-notes/changes/internal-test.json");
    f.git("checkout", "-q", "main");
    f.git("merge", "-q", "--squash", "change");
    f.git("commit", "-q", "-m", "test: the squashed change");
    const source = f.git("rev-parse", "HEAD");
    expect(f.git("merge-base", base, source)).toBe(base);
    expect(f.cli("check", "--source", source, "--reviewed", source)).toContain("all covered");
  });
});

/**
 * The batch's own step (batch-checks.yml, `batch --base`): the captain's ask
 * on a held batch's repair, "we simply rely on them being covered by the
 * batch's checks run", moves the notes step of a branch built on the batch's
 * version into the batch's run, which reads every change of the batch, one
 * commit each, by the alpha's coverage rule.
 */
describe("the batch's notes step", () => {
  it("refuses a batch with a change that adds no note or exclusion, naming it, and passes one the alpha would cover", () => {
    const { f } = released();
    f.git("checkout", "-q", "-b", "infinitary-batch/1");
    f.commit("feat: noted", { "src.txt": "1", "release-notes/changes/noted.json": note("noted") });
    f.commit("chore: excluded", {
      "tool.txt": "1",
      "release-notes/changes/tooling.json": {
        exclusions: [{ id: "tooling", reason: "Tooling only." }],
      },
    });
    expect(f.cli("batch", "--base", "main")).toContain("each of this batch's 2 change(s)");
    // A held batch's fix, whose own check skipped the notes step, joins the
    // batch with no note of its own.
    f.commit("fix: the held batch's repair", { "src.txt": "2" });
    expect(() => f.cli("batch", "--base", "main")).toThrow(
      /this batch's changes below add no file under release-notes\/changes\/ with a note or an exclusion \(1 of 3\):\n\s+[0-9a-f]{12} fix: the held batch's repair\n/,
    );
    f.git("reset", "-q", "--hard", "HEAD^");
    const { area: _area, ...noArea } = note("bad").entries[0] as Record<string, unknown>;
    f.commit("fix: the held batch's repair", {
      "src.txt": "2",
      "release-notes/changes/repair.json": { entries: [noArea] },
    });
    expect(() => f.cli("batch", "--base", "main")).toThrow(/area/);
    f.git("reset", "-q", "--hard", "HEAD^");
    f.commit("fix: the held batch's repair", {
      "src.txt": "2",
      "release-notes/changes/repair.json": note("repair"),
    });
    expect(f.cli("batch", "--base", "main")).toContain("each of this batch's 3 change(s)");
    f.git("checkout", "-q", "main");
    f.git("rebase", "-q", "infinitary-batch/1");
    const source = f.git("rev-parse", "HEAD");
    expect(f.cli("check", "--source", source, "--reviewed", source)).toContain("all covered");
  });

  it("passes the commit the batch's own check regenerated the phone's files in, and nothing that only imitates it", () => {
    const { f } = released();
    f.commit("chore: mark the phone's generated files", {
      ".gitattributes": "ios/**/*.generated.* linguist-generated\n",
      "ios/Words.generated.swift": "1",
      "release-notes/changes/attributes.json": {
        exclusions: [{ id: "attributes", reason: "Tooling only." }],
      },
    });
    f.git("checkout", "-q", "-b", "infinitary-batch/1");
    f.commit("fix: noted", { "src.txt": "1", "release-notes/changes/noted.json": note("noted") });
    const message = commitMessage(["ios/Words.generated.swift"]);
    f.commit(message, { "ios/Words.generated.swift": "2" });
    expect(f.cli("batch", "--base", "main")).toContain("each of this batch's 1 change(s)");
    // The words alone pass nothing: one source file beside the generated one is a change of its own.
    f.git("reset", "-q", "--hard", "HEAD^");
    f.commit(message, { "ios/Words.generated.swift": "2", "src.txt": "2" });
    expect(() => f.cli("batch", "--base", "main")).toThrow(
      /\(1 of 2\):\n\s+[0-9a-f]{12} chore\(phone\)/,
    );
    // Nor does a commit that marks its own files generated.
    f.git("reset", "-q", "--hard", "HEAD^");
    f.commit(message, {
      "ios/Words.generated.swift": "2",
      ".gitattributes": "* linguist-generated\n",
    });
    expect(() => f.cli("batch", "--base", "main")).toThrow(/\(1 of 2\)/);
  });
});

describe("a stable promotion", () => {
  function alphaThenStable() {
    const { f } = released();
    f.commit("feat: one", { "release-notes/changes/one.json": note("one-change") });
    f.commit("feat: two", { "release-notes/changes/two.json": note("two-change") });
    f.tag("1.0.1-alpha.4");
    return { f, alphaSource: f.git("rev-parse", "HEAD") };
  }

  it("builds the alpha's own commit, keeping its editorial entries and ids and adding nothing", () => {
    const { f, alphaSource } = alphaThenStable();
    expect(
      f.cli(
        "check",
        "--source",
        alphaSource,
        "--channel",
        "stable",
        "--version",
        "1.0.1",
        "--promoted-from",
        "1.0.1-alpha.4",
      ),
    ).toContain("unchanged");
    const out = join(scratchDir("infinitary-release-notes-out-"), "stable-catalog.json");
    f.cli("generate", "--version", "1.0.1", "--source", alphaSource, "--out", out);
    const stable = JSON.parse(readFileSync(out, "utf8")) as {
      entries: { id: string; title: string }[];
      releases: { version: string; promotedFrom: string | null; entryIds: string[] }[];
    };
    const alpha = stable.releases.find((release) => release.version === "1.0.1-alpha.4");
    const release = stable.releases.find((item) => item.version === "1.0.1");
    expect(release?.promotedFrom).toBe("1.0.1-alpha.4");
    expect(release?.entryIds).toEqual(alpha?.entryIds);
    expect(stable.entries.map((entry) => entry.id)).toEqual([
      "first-feature",
      "one-change",
      "two-change",
    ]);
  });

  it("ships the highlights the captain picked over the alpha's catalog, and its record keeps them", () => {
    const { f } = released();
    f.commit("feat: one", pictured("one-change", 1));
    f.commit("feat: two", { "release-notes/changes/two.json": note("two-change") });
    f.commit("feat: three", pictured("three-change", 2));
    f.tag("1.0.1-alpha.4");
    const alphaSource = f.git("rev-parse", "HEAD");
    const outDir = scratchDir("infinitary-release-notes-out-");
    const out = join(outDir, "release-notes.json");
    // The alpha's own tooling builds the stable's catalog, as release.yml's notes job does.
    f.cli("generate", "--version", "1.0.1", "--source", alphaSource, "--out", out);
    const listed = f.cli("stable-highlights", "--catalog", out);
    expect(listed).toContain("3 change(s) since stable 1.0.0");
    for (const id of ["one-change", "two-change", "three-change"]) expect(listed).toContain(id);
    expect(listed).not.toContain("first-feature");
    expect(() =>
      f.cli("stable-highlights", "--catalog", out, "--picks", "two-change,one-change,three-change"),
    ).toThrow(/"two-change" has no hero picture/);
    expect(() =>
      f.cli(
        "stable-highlights",
        "--catalog",
        out,
        "--picks",
        "first-feature,one-change,two-change",
      ),
    ).toThrow(/"first-feature" is not a change since the last stable/);
    f.cli("stable-highlights", "--catalog", out, "--picks", "three-change, two-change, one-change");
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      entries: { id: string; highlight?: number }[];
    };
    expect(
      Object.fromEntries(catalog.entries.map((entry) => [entry.id, entry.highlight ?? null])),
    ).toEqual({ "first-feature": null, "three-change": 1, "two-change": 2, "one-change": 3 });
    expect(readdirSync(join(outDir, "release-notes", "pictures")).sort()).toEqual([
      "one-change-dark.webp",
      "one-change-light.webp",
      "three-change-dark.webp",
      "three-change-light.webp",
    ]);
    expect(
      f.cli("verify-package", "--catalog", out, "--version", "1.0.1", "--source", alphaSource),
    ).toContain("with its 4 pictures");
    // Published, the stable is pinned with the picks its private release names.
    pin(f, "1.0.1-alpha.4");
    f.git("tag", "v1.0.1", alphaSource);
    expect(() => f.cli("manifest", "--version", "1.0.1", "--write")).toThrow(
      /keeps the highlights the captain picked/,
    );
    expect(() =>
      f.cli(
        "manifest",
        "--version",
        "1.0.1",
        "--highlights",
        "first-feature,one-change,two-change",
        "--write",
      ),
    ).toThrow(/not a change since the last stable/);
    f.cli(
      "manifest",
      "--version",
      "1.0.1",
      "--highlights",
      "three-change,two-change,one-change",
      "--write",
    );
    expect(f.read("release-notes/releases/1.0.1.json")).toMatchObject({
      promotedFrom: "1.0.1-alpha.4",
      highlights: ["three-change", "two-change", "one-change"],
    });
    expect(f.cli("validate")).toContain("consistent");
  });

  it("refuses a promotion that edits the notes source", () => {
    const { f } = alphaThenStable();
    const edited = f.commit("chore: sneak a prose edit into the promotion", {
      "release-notes/changes/one.json": note("one-change", "A different title"),
    });
    expect(() =>
      f.cli("check", "--source", edited, "--channel", "stable", "--promoted-from", "1.0.1-alpha.4"),
    ).toThrow(/edits the notes source[\s\S]*new alpha/);
  });
});

describe("the offline catalog", () => {
  it("is this exact version and source, and a packaged copy is checked against both", () => {
    const { f } = released();
    const source = f.commit("feat: shipped", {
      "release-notes/changes/shipped.json": note("shipped-change"),
    });
    const out = join(scratchDir("infinitary-release-notes-out-"), "catalog.json");
    f.cli("generate", "--version", "1.0.1-alpha.7", "--source", source, "--out", out);
    expect(
      f.cli("verify-package", "--catalog", out, "--version", "1.0.1-alpha.7", "--source", source),
    ).toContain("1.0.1-alpha.7");
    expect(() =>
      f.cli("verify-package", "--catalog", out, "--version", "1.0.1-alpha.8", "--source", source),
    ).toThrow(/not 1\.0\.1-alpha\.8/);
    expect(() =>
      f.cli(
        "verify-package",
        "--catalog",
        out,
        "--version",
        "1.0.1-alpha.7",
        "--source",
        f.git("rev-parse", "HEAD~1"),
      ),
    ).toThrow(/built from/);
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      entries: { id: string }[];
      releases: { version: string }[];
    };
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["first-feature", "shipped-change"]);
    expect(catalog.releases.map((release) => release.version)).toEqual(["1.0.0", "1.0.1-alpha.7"]);
  });

  it("ships the highlights' hero pictures beside it, and a packaged picture must be the file it hashed", () => {
    const { f } = released();
    const source = f.commit("feat: two pictured changes", {
      ...pictured("lead-change", 1),
      ...pictured("plain-change"),
    });
    const outDir = scratchDir("infinitary-release-notes-out-");
    const out = join(outDir, "release-notes.json");
    expect(
      f.cli("generate", "--version", "1.0.1-alpha.7", "--source", source, "--out", out),
    ).toContain("2 pictures");
    const pictures = join(outDir, "release-notes", "pictures");
    // Only the highlight's pair ships; an ordinary entry's stays in the repository.
    expect(readdirSync(pictures).sort()).toEqual([
      "lead-change-dark.webp",
      "lead-change-light.webp",
    ]);
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      pictures: Record<string, { sha256: string; width: number; height: number }>;
    };
    expect(catalog.pictures["lead-change-dark.webp"]).toEqual({
      sha256: sha256(webpBytes(1200, 600, 40)),
      width: 1200,
      height: 600,
    });
    const verify = () =>
      f.cli("verify-package", "--catalog", out, "--version", "1.0.1-alpha.7", "--source", source);
    expect(verify()).toContain("with its 2 pictures");
    writeFileSync(join(pictures, "lead-change-dark.webp"), webpBytes(1200, 600, 44));
    expect(verify).toThrow(/lead-change-dark\.webp is not the file the catalog hashed/);
    rmSync(join(pictures, "lead-change-dark.webp"));
    expect(verify).toThrow(/lead-change-dark\.webp is missing/);
    f.cli("generate", "--dev", "--out", out);
    expect(readdirSync(pictures)).toEqual([]);
  });

  it("is refused while the ledger names a picture it does not hold", () => {
    const { f } = released();
    const { "release-notes/pictures/gone-change-light.webp": _light, ...half } = pictured(
      "gone-change",
      1,
    );
    const source = f.commit("feat: half a pair", half);
    expect(() => f.cli("validate")).toThrow(/gone-change-light\.webp, which is missing/);
    const out = join(scratchDir("infinitary-release-notes-out-"), "release-notes.json");
    expect(() =>
      f.cli("generate", "--version", "1.0.1-alpha.7", "--source", source, "--out", out),
    ).toThrow(/which is missing/);
  });

  it("excludes entries from a tag on an unrelated branch", () => {
    const { f, base } = released();
    f.git("checkout", "-q", "-b", "side");
    f.commit("feat: side only", { "release-notes/changes/side.json": note("side-change") });
    f.tag("1.0.1-alpha.2");
    f.git("checkout", "-q", "main");
    const source = f.commit("feat: main only", {
      "release-notes/changes/main.json": note("main-change"),
    });
    const out = join(scratchDir("infinitary-release-notes-out-"), "catalog.json");
    f.cli("generate", "--version", "1.0.1-alpha.9", "--source", source, "--out", out);
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      entries: { id: string }[];
      releases: { version: string; entryIds: string[] }[];
    };
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["first-feature", "main-change"]);
    // The side release is known by version, but nothing of the side branch's
    // notes reaches this release's entries.
    const side = catalog.releases.find((release) => release.version === "1.0.1-alpha.2");
    expect(side?.entryIds).toEqual(["first-feature"]);
    expect(base).toBeTruthy();
  });
});

describe("published manifests", () => {
  it("pins a release once and never rewrites it", () => {
    // released() pins 1.0.0 the way the release crewmate does.
    const { f } = released();
    expect(f.read("release-notes/releases/1.0.0.json")).toMatchObject({
      version: "1.0.0",
      channel: "stable",
      entryIds: ["first-feature"],
    });
    expect(() => f.cli("manifest", "--version", "1.0.0", "--write")).toThrow(/never rewritten/);
    expect(f.cli("validate")).toContain("consistent");
  });

  it("refuses a later edit that moves an entry into or out of a published release", () => {
    const f = new Fixture();
    const early = f.commit("feat: early", { "src.txt": "0" });
    const history = (covers: string[]) => ({
      entries: [
        {
          id: "backfilled-one",
          kind: "fix",
          title: "A backfilled change",
          provenance: { origin: "changelog-backfill", covers },
        },
      ],
    });
    f.commit("docs: backfill", { "release-notes/history/h.json": history([early]) });
    f.tag("1.0.0");
    f.cli("manifest", "--version", "1.0.0", "--write");
    const late = f.commit("feat: late", { "src.txt": "1" });
    expect(f.cli("validate")).toContain("consistent");
    f.commit("docs: move the entry past the release", {
      "release-notes/history/h.json": history([late]),
    });
    expect(() => f.cli("validate")).toThrow(
      /published membership changed; a published release is immutable/,
    );
  });
});

/**
 * Step 7 of the Infinitary rename (FI3-1780's plan): the release tooling
 * works in a repository that starts again from one parentless commit of the
 * archived tree, through a typed record of past releases, and every new
 * version numbers above the archived ones (docs/release-notes.md "A fresh
 * history").
 */
describe("a fresh history", () => {
  /**
   * The archived history: stable 1.0.0 with a backfilled entry, alpha
   * 1.0.1-alpha.3 and its stable 1.0.1, each pinned, and the record of past
   * releases pinned from it.
   */
  function archivedHistory(): Fixture {
    const f = new Fixture();
    const early = f.commit("feat: early", { "src.txt": "0" });
    f.commit("docs: backfill", {
      "release-notes/history/1.0.0.json": {
        entries: [
          {
            id: "backfilled-one",
            kind: "fix",
            title: "A backfilled change",
            provenance: { origin: "changelog-backfill", covers: [early] },
          },
        ],
      },
      "release-notes/changes/first.json": note("first-feature"),
    });
    f.tag("1.0.0");
    pin(f, "1.0.0");
    f.commit("feat: alpha change", { "release-notes/changes/a.json": note("alpha-change") });
    f.tag("1.0.1-alpha.3");
    f.tag("1.0.1");
    pin(f, "1.0.1-alpha.3");
    pin(f, "1.0.1", "alpha-change");
    f.cli("archive", "--repository", "owner/archived", "--write");
    f.commit("chore(release-notes): pin the record of past releases", {});
    return f;
  }

  /** A new repository whose one parentless commit is `from`'s tree. */
  function freshCopy(from: Fixture, mutate: (dir: string) => void = () => {}): Fixture {
    const f = new Fixture();
    const files = from.git("ls-files").split("\n").filter(Boolean);
    for (const path of files) {
      mkdirSync(dirname(join(f.dir, path)), { recursive: true });
      writeFileSync(join(f.dir, path), readFileSync(join(from.dir, path)));
    }
    mutate(f.dir);
    f.git("add", "-A");
    f.git("commit", "-q", "-m", "chore: initialize from the archived tree");
    return f;
  }

  it("pins the archived releases by their hashes and each channel's newest", () => {
    const f = archivedHistory();
    const archive = f.read("release-notes/archive.json") as {
      stable: string;
      alpha: string;
      releases: Record<string, string>;
    };
    expect(archive).toMatchObject({ schema: 1, repository: "owner/archived" });
    expect(archive.stable).toBe("1.0.1");
    expect(archive.alpha).toBe("1.0.1-alpha.3");
    expect(Object.keys(archive.releases)).toEqual(["1.0.0", "1.0.1-alpha.3", "1.0.1"]);
    expect(archive.releases["1.0.1"]).toBe(
      sha256(readFileSync(join(f.dir, "release-notes/releases/1.0.1.json"))),
    );
    expect(f.cli("validate")).toContain("consistent");
    // The whole history keeps the record whole: pinning a later release pins
    // the record again with it, and a record that misses one is refused.
    const before = readFileSync(join(f.dir, "release-notes/archive.json"));
    f.commit("feat: later", { "release-notes/changes/later.json": note("later-change") });
    f.tag("1.0.2-alpha.4");
    pin(f, "1.0.2-alpha.4");
    expect(f.read("release-notes/archive.json")).toMatchObject({
      repository: "owner/archived",
      stable: "1.0.1",
      alpha: "1.0.2-alpha.4",
    });
    expect(f.cli("validate")).toContain("consistent");
    writeFileSync(join(f.dir, "release-notes/archive.json"), before);
    expect(() => f.cli("validate")).toThrow(/does not list it; pin the record again/);
  });

  it("checks, catalogs and pins a first release on one commit, carrying every archived entry", () => {
    const f = freshCopy(archivedHistory(), (dir) =>
      writeFileSync(
        join(dir, "release-notes/changes/new.json"),
        `${JSON.stringify(note("new-change"))}\n`,
      ),
    );
    const root = f.git("rev-parse", "HEAD");
    expect(f.git("rev-list", "--count", "--all")).toBe("1");
    expect(f.cli("validate")).toContain("consistent");
    expect(
      f.cli("check", "--source", root, "--version", "1.0.2-alpha.1", "--reviewed", root),
    ).toContain("1 source change(s) since the beginning are all covered");
    const out = join(scratchDir("infinitary-release-notes-out-"), "release-notes.json");
    f.cli("generate", "--version", "1.0.2-alpha.1", "--source", root, "--out", out);
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      releases: { version: string; entryIds: string[] }[];
    };
    const ids = (version: string) =>
      catalog.releases.find((release) => release.version === version)?.entryIds;
    expect(catalog.releases.map((release) => release.version)).toEqual([
      "1.0.0",
      "1.0.1-alpha.3",
      "1.0.1",
      "1.0.2-alpha.1",
    ]);
    // The backfilled entry names a commit only the archived history has, and
    // still rides along; the one new note is all that is new.
    expect(ids("1.0.2-alpha.1")).toEqual([
      "alpha-change",
      "backfilled-one",
      "first-feature",
      "new-change",
    ]);
    f.tag("1.0.2-alpha.1");
    f.cli("manifest", "--version", "1.0.2-alpha.1", "--write");
    expect(f.read("release-notes/releases/1.0.2-alpha.1.json")).toMatchObject({
      sourceCommit: root,
      entryIds: ["alpha-change", "backfilled-one", "first-feature", "new-change"],
    });
    expect(f.cli("validate")).toContain("consistent");
    // The record is the archived history's, so only that history pins it again.
    expect(() => f.cli("archive", "--write")).toThrow(/which this checkout does not have/);
  });

  it("keeps published membership when the separate archived history and its tags are fetched", () => {
    // INF-1883: fetching the old repository must not turn a parentless copy
    // back into that repository or re-derive its immutable published notes.
    const old = archivedHistory();
    const fresh = freshCopy(old);
    const root = fresh.git("rev-parse", "HEAD");
    const archiveBefore = readFileSync(join(fresh.dir, "release-notes/archive.json"), "utf8");
    const archivedBefore = readFileSync(
      join(fresh.dir, "release-notes/releases/1.0.1.json"),
      "utf8",
    );
    fresh.git("fetch", "--quiet", "--tags", old.dir, "main");
    expect(fresh.git("rev-parse", "v1.0.1")).toBe(old.git("rev-parse", "v1.0.1"));
    expect(fresh.cli("validate")).toContain("consistent");
    expect(() => fresh.cli("archive", "--write")).toThrow(/which this checkout does not have/);

    const version = "1.0.2-alpha.1";
    expect(
      fresh.cli("check", "--source", root, "--version", version, "--reviewed", root),
    ).toContain("all covered");
    const out = join(scratchDir("infinitary-release-notes-out-"), "release-notes.json");
    fresh.cli("generate", "--version", version, "--source", root, "--out", out);
    const catalog = JSON.parse(readFileSync(out, "utf8")) as {
      releases: { version: string; entryIds: string[] }[];
    };
    const inherited = JSON.parse(archivedBefore) as { entryIds: string[] };
    expect(catalog.releases.find((release) => release.version === version)?.entryIds).toEqual(
      inherited.entryIds,
    );
    expect(catalog.releases.find((release) => release.version === "1.0.1")).toEqual(
      JSON.parse(archivedBefore),
    );
    fresh.tag(version);
    pin(fresh, version);
    expect(fresh.cli("validate")).toContain("consistent");
    expect(readFileSync(join(fresh.dir, "release-notes/archive.json"), "utf8")).toBe(archiveBefore);
    expect(readFileSync(join(fresh.dir, "release-notes/releases/1.0.1.json"), "utf8")).toBe(
      archivedBefore,
    );
    // Imported objects do not relax either kind of immutability check.
    fresh.commit("docs: retroactively add a note to the new release", {
      "release-notes/changes/retroactive.json": note("retroactive-change", "A late correction", {
        provenance: { origin: "release-review", covers: [root] },
      }),
    });
    expect(() => fresh.cli("validate")).toThrow(/published membership changed/);
    const archivedPath = join(fresh.dir, "release-notes/releases/1.0.1.json");
    writeFileSync(archivedPath, `${archivedBefore}\n`);
    expect(() => fresh.cli("validate")).toThrow(/is not the manifest it pins/);
  });

  it("chains a second history and validates it from a third checkout without tags", () => {
    const second = freshCopy(archivedHistory());
    second.commit("feat: another history", {
      "release-notes/changes/new.json": note("new-feature"),
    });
    second.tag("1.0.2-alpha.7");
    second.tag("1.0.2");
    second.cli("archive", "--repository", "owner/second", "--write");
    expect(second.read("release-notes/archive.json")).toMatchObject({
      repository: "owner/second",
      previousRepositories: ["owner/archived"],
      stable: "1.0.2",
      alpha: "1.0.2-alpha.7",
    });
    second.commit("chore: pin both histories", {});
    const third = freshCopy(second);
    expect(third.cli("validate")).toContain("consistent");
  });

  it("never repins edited or unattested history, nor renders edited pins on the docs site", () => {
    const old = archivedHistory();
    const f = freshCopy(old);
    f.commit("feat: another history", { "release-notes/changes/new.json": note("new-feature") });
    f.tag("1.0.2-alpha.7");
    f.tag("1.0.2");
    f.cli("archive", "--repository", "owner/second", "--write");
    f.commit("chore: pin both histories", {});
    const before = readFileSync(join(f.dir, "release-notes/archive.json"));
    f.commit("feat: later", { "release-notes/changes/later.json": note("later-change") });
    f.tag("1.0.3-alpha.8");
    const path = join(f.dir, "release-notes/releases/1.0.0.json");
    const original = readFileSync(path);
    const manifest = JSON.parse(original.toString());
    for (const [file, data, diagnostic] of [
      [path, { ...manifest, date: "2000-01-01" }, /is not the manifest it pins/],
      [
        join(f.dir, "release-notes/releases/1.0.3.json"),
        { ...manifest, version: "1.0.3" },
        /not in this checkout/,
      ],
    ] as const) {
      writeFileSync(file, JSON.stringify(data));
      expect(() => f.cli("archive", "--write")).toThrow(diagnostic);
      expect(() => f.cli("manifest", "--version", "1.0.3-alpha.8", "--write")).toThrow(diagnostic);
      expect(readFileSync(join(f.dir, "release-notes/archive.json"))).toEqual(before);
      if (file === path) {
        expect(() => newestStables(f.dir)).toThrow(diagnostic);
        writeFileSync(path, original);
      }
    }
  });

  it("refuses an archived version tagged on the new history, and an archived record that changed", () => {
    const fresh = freshCopy(archivedHistory());
    fresh.tag("1.0.1");
    expect(() => fresh.cli("validate")).toThrow(
      /v1\.0\.1 was published from the archived history, so this history never tags it/,
    );
    const edited = freshCopy(archivedHistory(), (dir) => {
      const path = join(dir, "release-notes/releases/1.0.0.json");
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { date: string };
      writeFileSync(path, `${JSON.stringify({ ...manifest, date: "2000-01-01" }, null, 2)}\n`);
    });
    expect(() => edited.cli("validate")).toThrow(
      /release-notes\/releases\/1\.0\.0\.json is not the manifest it pins/,
    );
  });
});

/**
 * INF-2465 (docs/alpha.md, "An alpha with nothing new to build"): a rolling
 * alpha reads which paths on the desktop build list changed since the
 * previous release, found by the notes check's own rule.
 */
describe("what a rolling alpha would ship", () => {
  const changes = (f: Fixture, source: string) =>
    JSON.parse(f.cli("desktop-changes", "--source", source)) as {
      previous: string | null;
      changed: string[];
    };

  it("lists the desktop paths changed since the previous alpha, never tests, docs or notes", () => {
    const { f } = released();
    f.commit("feat: shipped", { "src/app.ts": "1" });
    f.tag("1.0.1-alpha.3");
    const quiet = f.commit("test: tests and docs only", {
      "src/app.test.ts": "t",
      "tests/journey.spec.ts": "t",
      "docs/alpha.md": "d",
      "release-notes/changes/t.json": {
        exclusions: [{ id: "tests-only-change", reason: "Tests only." }],
      },
    });
    expect(changes(f, quiet)).toEqual({ previous: "1.0.1-alpha.3", changed: [] });
    const cut = f.commit("fix: an app change", { "src/app.ts": "2", "pnpm-lock.yaml": "l" });
    expect(changes(f, cut)).toEqual({
      previous: "1.0.1-alpha.3",
      changed: ["pnpm-lock.yaml", "src/app.ts"],
    });
  });

  it("measures from the last published release, not a failed alpha that left no tag", () => {
    const { f } = released();
    // An alpha whose run failed published no tag, so its app change is still unreleased.
    f.commit("feat: its alpha failed", { "src/app.ts": "1" });
    const later = f.commit("docs: later", { "docs/alpha.md": "d" });
    expect(changes(f, later)).toEqual({ previous: "1.0.0", changed: ["src/app.ts"] });
  });

  it("names no previous release when there is none", () => {
    const f = new Fixture();
    const only = f.commit("init", { "src/app.ts": "0" });
    expect(changes(f, only)).toEqual({ previous: null, changed: [] });
  });
});

// INF-4960: the release resolver gates publication on the actual installer inputs.
describe("the post-merge signed installer source", () => {
  const select = (f: Fixture, source: string, main = source) =>
    f.cli("installer-source", "--source", source, "--main", main);

  it("requires the full check on the first alpha", () => {
    const f = new Fixture();
    const main = f.commit("Initial public source", { "package.json": '{"version":"1.0.0"}' });
    expect(select(f, main)).toBe(`source=${main}`);
  });

  // INF-5466: the captain's tight rule. Only the Mac update code, the updater
  // library or Electron, the app's executables, signing, electron-builder.yml's
  // Mac, signing or fuse settings, or app shutdown hold an alpha for the check.
  // The fixture is the project's own package.json and electron-builder.yml.
  const realFile = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
  const builder = realFile("electron-builder.yml");
  const pkg = JSON.parse(realFile("package.json")) as Record<string, Record<string, string>>;
  const withVersion = (field: string, name: string, version: string) =>
    `${JSON.stringify({ ...pkg, [field]: { ...pkg[field], [name]: version } }, null, 2)}\n`;
  const edit = (from: string, to: string) => {
    expect(builder).toContain(from);
    return builder.replace(from, to);
  };
  const editReal = (path: string, from: string, to: string) => {
    const text = realFile(path);
    expect(text).toContain(from);
    return text.replace(from, to);
  };
  function shipped(): { f: Fixture; base: string } {
    const { f } = released();
    f.git("tag", "-d", "v1.0.0");
    f.commit("Package the app", {
      "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
      "electron-builder.yml": builder,
      "src/core/update/macUpdates.ts": "export {};",
    });
    f.tag("1.0.1-alpha.1");
    return { f, base: f.git("rev-parse", "HEAD") };
  }
  const selectsFrom = (f: Fixture, base: string, files: Record<string, unknown>) => {
    f.git("checkout", "-q", "--detach", base);
    const main = f.commit("Change since the last alpha", files);
    return select(f, main) === `source=${main}`;
  };

  it("skips an alpha whose changes leave everything the check guards alone", () => {
    const { f, base } = shipped();
    const skipped: Record<string, Record<string, unknown>> = {
      docs: { "docs/alpha.md": "# Signing" },
      "app code": {
        "src/main/app.ts": "export {};",
        "src/core/update/linuxInstall.ts": "export {};",
      },
      "the copyright line": {
        "electron-builder.yml": edit(
          "copyright: Copyright (c) 2026",
          "copyright: Copyright (c) 2027",
        ),
      },
      "a license file the app carries": {
        "electron-builder.yml": edit(
          "extraResources:\n",
          "extraResources:\n  - from: THIRD_PARTY\n    to: licenses/THIRD_PARTY.txt\n",
        ),
      },
      "a comment in the Mac settings": {
        "electron-builder.yml": edit("mac:\n", "mac:\n  # A note for whoever reads this next.\n"),
      },
      "another package's version": {
        "package.json": withVersion("dependencies", "zod", "0.0.1-other"),
      },
      "the lockfile and bundled Git": {
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
        "vendor/git-bin/README.md": "g",
      },
      "the check's own files": {
        ".github/workflows/mac-installer.yml": "name: changed",
        ".github/actions/electron-download/action.yml": "name: changed",
        "tests/fixtures/installed-updates/versions.json": "{}",
        "tests/e2e/virtualMac.ts": "export {};",
      },
      "a test beside the update code": { "src/core/update/macUpdates.test.ts": "it" },
      // The captain's split: alpha 0.8.5-alpha.6 ran the check only because a
      // Windows installer download kind was added beside the Mac update code.
      "a new Windows or Linux download kind": {
        "src/core/update/releaseBuilds.ts": editReal(
          "src/core/update/releaseBuilds.ts",
          "  exe: /\\.exe$/,\n",
          "  exe: /\\.exe$/,\n  msi: /\\.msi$/,\n",
        ),
      },
    };
    for (const [what, files] of Object.entries(skipped))
      expect(selectsFrom(f, base, files), what).toBe(false);
  });

  it("runs the check for each change it guards", () => {
    const { f, base } = shipped();
    const held: Record<string, Record<string, unknown>> = {
      "the Mac update driver": { "src/core/update/macUpdates.ts": "export const changed = 1;" },
      "the update file Mac shares": { "src/core/update/updateChecker.ts": "export {};" },
      "the Mac update targets": {
        "src/core/update/updateChannels.ts": editReal(
          "src/core/update/updateChannels.ts",
          "const ZIP_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*\\.zip$/;",
          "const ZIP_ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*\\.(zip|tar)$/;",
        ),
      },
      "the Mac update host": { "src/main/host/macUpdates.ts": "export {};" },
      "the update feed's settings": { "packaging/app-update.yml": "provider: generic" },
      "the updater library's version": {
        "package.json": withVersion("dependencies", "electron-updater", "0.0.1-changed"),
      },
      "Electron's version": {
        "package.json": withVersion("devDependencies", "electron", "0.0.1-changed"),
      },
      "a patch to the updater library": { "patches/electron-updater@6.8.9.patch": "diff" },
      "the step that places the app's executables": {
        "scripts/after-pack.mjs": "export default () => {};",
      },
      "the Mac launcher": { "scripts/mac-app-launcher.m": "int main(void) { return 0; }" },
      "the entitlements": { "packaging/entitlements.plist": "<plist/>" },
      notarization: { "scripts/notarize.ts": "export {};" },
      "app shutdown": { "src/main/lifecycle.ts": "export {};" },
      "a fuse": {
        "electron-builder.yml": edit(
          "enableCookieEncryption: true",
          "enableCookieEncryption: false",
        ),
      },
      "the signing identity": {
        "electron-builder.yml": edit("hardenedRuntime: true", "hardenedRuntime: false"),
      },
      "a new hook after signing": {
        "electron-builder.yml": `${builder}\nafterSign: ./scripts/after-sign.mjs\n`,
      },
      "the disk image": { "electron-builder.yml": edit("iconSize: 96", "iconSize: 128") },
    };
    for (const [what, files] of Object.entries(held))
      expect(selectsFrom(f, base, files), what).toBe(true);
  });

  it("uses the merged base for notes-only candidates and refuses other branch changes", () => {
    const { f } = released();
    const main = f.commit("Update the Mac update code", {
      "src/core/update/macUpdates.ts": "export {};",
    });
    f.git("checkout", "-b", "reviewed-notes");
    const notes = f.commit("Review alpha notes", {
      "release-notes/changes/alpha.json": note("alpha"),
    });
    expect(select(f, notes, main)).toBe(`source=${main}`);
    const other = f.commit("Change unmerged code", { "src/main/app.ts": "export {};" });
    expect(() => select(f, other, main)).toThrow(/already merged into main/);
  });

  it("refuses a branch path with leading whitespace outside the release notes folder", () => {
    const f = new Fixture();
    const main = f.commit("Initial public source", { "package.json": '{"version":"1.0.0"}' });
    f.git("checkout", "-b", "reviewed-notes");
    const other = f.commit("Add a file outside the notes folder", {
      " release-notes/changes/alpha.json": note("alpha"),
    });
    expect(() => select(f, other, main)).toThrow(/already merged into main/);
  });

  it("reports a broken comparison instead of selecting a signing source", () => {
    const { f } = released();
    const tagTree = f.git("rev-parse", "v1.0.0^{tree}");
    const main = f.commit("Document signing", { "docs/alpha.md": "# Signing" });
    rmSync(join(f.dir, ".git", "objects", tagTree.slice(0, 2), tagTree.slice(2)));
    expect(() => select(f, main)).toThrow(/git diff .* failed/);
  });
});
