import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    // The next alpha waits for both records.
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
    // A development placeholder written over it leaves no picture behind.
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
