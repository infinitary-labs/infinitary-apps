import { describe, expect, it } from "vitest";
import { PNG_BASE64, webpBytes } from "../../../tests/helpers/images";
import {
  buildCatalog,
  coveredCommits,
  docsSiteProblems,
  entryCommits,
  highlightCandidates,
  type LedgerFile,
  MAX_HERO_BYTES,
  membership,
  type NoteEntry,
  parseManifest,
  parseNoteFile,
  pickHighlights,
  pictureProblems,
  type ReleaseManifest,
  uncoveredCommits,
  unreachableNotes,
  validateLedger,
  verifyCatalog,
} from "./catalog";

const sha = (n: number) => n.toString(16).padStart(40, "0");

/** A change's entry, with the area and the reason for no picture every change declares. */
function entry(id: string, covers: number[] = [], extra: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id,
    kind: "feature",
    title: `Title of ${id}`,
    area: "cards",
    noPicture: "Nothing on screen changes.",
    provenance: { origin: "change", covers: covers.map(sha) },
    ...extra,
  };
}

function pictured(id: string, extra: Partial<NoteEntry> = {}): NoteEntry {
  const { noPicture: _none, ...rest } = entry(id, [1], extra);
  return {
    ...rest,
    picture: { dark: `${id}-dark.webp`, light: `${id}-light.webp`, alt: `The ${id} view` },
  };
}

function manifest(version: string, source: number, ids: string[], extra = {}): ReleaseManifest {
  return {
    version,
    channel: version.includes("-alpha.") ? "alpha" : "stable",
    sourceCommit: sha(source),
    date: "2026-10-02",
    promotedFrom: null,
    entryIds: ids,
    ...extra,
  };
}

const file = (path: string, entries: NoteEntry[], selfCovering = false): LedgerFile => ({
  path,
  file: { entries, exclusions: [] },
  selfCovering,
});

describe("note files", () => {
  it("accepts a complete entry and an exclusion", () => {
    const { file: parsed, problems } = parseNoteFile(
      {
        entries: [
          {
            id: "see-changes",
            kind: "feature",
            title: "See what changed",
            body: "Revised cards mark what is new.",
            highlight: 1,
            provenance: { origin: "change" },
          },
        ],
        exclusions: [{ id: "test-only", reason: "Tests only." }],
      },
      "a.json",
    );
    expect(problems).toEqual([]);
    expect(parsed.entries[0]).toMatchObject({ id: "see-changes", highlight: 1 });
    expect(parsed.exclusions).toHaveLength(1);
  });

  it("refuses unknown fields, bad ids, kinds, ranks and short commit ids", () => {
    const { problems } = parseNoteFile(
      {
        entries: [
          {
            id: "Bad Id",
            kind: "headline",
            title: "x",
            hilight: 1,
            highlight: 0,
            provenance: { origin: "guess", covers: ["abc123"] },
          },
        ],
        extra: true,
      },
      "a.json",
    );
    const joined = problems.join("\n");
    expect(joined).toContain('unknown field "extra"');
    expect(joined).toContain('unknown field "hilight"');
    expect(joined).toContain("a.json.entries[0].id");
    expect(joined).toContain("kind: expected one of");
    expect(joined).toContain("highlight: expected a whole rank");
    expect(joined).toContain("provenance.origin");
    expect(joined).toContain("full 40-character");
  });

  it("accepts an area and a hero pair or a reason, and refuses a stray area, a misnamed or unexplained picture, or both", () => {
    const parse = (extra: Record<string, unknown>) =>
      parseNoteFile(
        {
          entries: [
            {
              id: "the-change",
              kind: "fix",
              title: "A fix",
              provenance: { origin: "change" },
              ...extra,
            },
          ],
        },
        "a.json",
      );
    const good = parse({
      area: "tasks",
      picture: { dark: "the-change-dark.webp", light: "the-change-light.png", alt: "The row" },
    });
    expect(good.problems).toEqual([]);
    expect(good.file.entries[0]).toMatchObject({ area: "tasks", picture: { alt: "The row" } });
    expect(parse({ area: "other", noPicture: "Nothing to see." }).problems).toEqual([]);
    expect(parse({ area: "Cards" }).problems.join()).toContain("area: expected one of");
    expect(
      parse({
        picture: { dark: "another-dark.webp", light: "the-change-light.webp", alt: "x" },
      }).problems.join(),
    ).toContain('picture.dark: expected "the-change-dark.webp"');
    expect(
      parse({
        picture: { dark: "the-change-dark.webp", light: "the-change-light.webp" },
      }).problems.join(),
    ).toContain("picture.alt");
    expect(
      parse({
        picture: { dark: "the-change-dark.webp", light: "the-change-light.webp", alt: "x" },
        noPicture: "Nothing.",
      }).problems.join(),
    ).toContain("not both");
  });

  // The captain's INF-6704 plan: a note names the docs site pages its change edited, or says why none.
  it("accepts docs site pages or a reason, and refuses both, an empty list, a malformed name and a generated page", () => {
    const parse = (extra: Record<string, unknown>) =>
      parseNoteFile(
        {
          entries: [
            {
              id: "the-change",
              kind: "feature",
              title: "A feature",
              area: "settings",
              noPicture: "Nothing to see.",
              provenance: { origin: "change" },
              ...extra,
            },
          ],
        },
        "a.json",
      );
    const pages = parse({ docsSite: ["settings", "get-help"] });
    expect(pages.problems).toEqual([]);
    expect(pages.file.entries[0]?.docsSite).toEqual(["settings", "get-help"]);
    expect(parse({ noDocsSite: "No page covers automation logs." }).problems).toEqual([]);
    expect(
      parse({ docsSite: ["settings"], noDocsSite: "Settings already says this." }).problems,
    ).toEqual(["a.json.entries[0]: declare docsSite pages or a noDocsSite reason, not both"]);
    expect(parse({ docsSite: [] }).problems.join()).toContain(
      "docsSite: expected a non-empty list",
    );
    expect(parse({ docsSite: ["settings.md"] }).problems.join()).toContain(
      "docsSite[0]: expected a page's file name without its extension",
    );
    expect(parse({ docsSite: ["settings", "settings"] }).problems.join()).toContain(
      'names "settings" twice',
    );
    for (const generated of ["keyboard", "whats-new"])
      expect(parse({ docsSite: [generated] }).problems.join()).toContain(
        `"${generated}" is written by a script`,
      );
    expect(parse({ noDocsSite: "" }).problems.join()).toContain("noDocsSite: expected non-empty");
  });

  it("refuses a manifest whose channel disagrees with its version", () => {
    const { manifest: parsed, problems } = parseManifest(
      { ...manifest("1.0.0", 1, []), channel: "alpha" },
      "m.json",
    );
    expect(parsed).toBeNull();
    expect(problems.join()).toContain("channel");
  });
});

describe("ledger validation", () => {
  it("rejects duplicate ids across files and entries versus exclusions", () => {
    const problems = validateLedger({
      files: [
        file("a.json", [entry("same-id", [1])]),
        {
          path: "b.json",
          file: { entries: [], exclusions: [{ id: "same-id", reason: "x", covers: [sha(2)] }] },
          selfCovering: false,
        },
      ],
      manifests: [],
    });
    expect(problems.join()).toContain('duplicate id "same-id"');
  });

  it("rejects a manifest that references a missing entry or lists one twice", () => {
    const problems = validateLedger({
      files: [file("a.json", [entry("real-one", [1])])],
      manifests: [
        {
          path: "releases/1.0.0.json",
          manifest: manifest("1.0.0", 1, ["real-one", "real-one", "ghost-id"]),
        },
      ],
    });
    expect(problems.join("\n")).toContain('missing entry "ghost-id"');
    expect(problems.join("\n")).toContain("an entry id twice");
  });

  it("accepts a stable that keeps its alpha's entries and refuses other promotions", () => {
    const files = [file("a.json", [entry("one-change", [1]), entry("two-change", [2])])];
    const alpha = manifest("1.0.1-alpha.4", 2, ["one-change", "two-change"]);
    const good = manifest("1.0.1", 3, ["one-change", "two-change"], {
      promotedFrom: "1.0.1-alpha.4",
    });
    expect(
      validateLedger({
        files,
        manifests: [
          { path: "releases/1.0.1-alpha.4.json", manifest: alpha },
          { path: "releases/1.0.1.json", manifest: good },
        ],
      }),
    ).toEqual([]);
    const fewer = manifest("1.0.1", 3, ["one-change"], { promotedFrom: "1.0.1-alpha.4" });
    const otherCore = manifest("1.0.2", 3, ["one-change", "two-change"], {
      promotedFrom: "1.0.1-alpha.4",
    });
    const unpublished = manifest("1.0.1", 3, ["one-change", "two-change"], {
      promotedFrom: "1.0.1-alpha.9",
    });
    for (const bad of [fewer, otherCore, unpublished]) {
      const problems = validateLedger({
        files,
        manifests: [
          { path: "releases/1.0.1-alpha.4.json", manifest: alpha },
          { path: `releases/${bad.version}.json`, manifest: bad },
        ],
      });
      expect(problems.join("\n")).toMatch(/promotion|keeps exactly/);
    }
  });
});

describe("what a change declares", () => {
  const problemsOf = (entries: NoteEntry[]) =>
    validateLedger({ files: [file("changes/a.json", entries, true)], manifests: [] });

  it("asks a change or a release review for its area, and a visible kind for a picture or a reason", () => {
    const { area: _area, noPicture: _none, ...bare } = entry("bare-change");
    const problems = problemsOf([
      bare,
      { ...bare, id: "reviewed-change", provenance: { origin: "release-review" } },
    ]).join("\n");
    expect(problems).toContain('"bare-change" declares no area');
    expect(problems).toContain('"bare-change" needs a hero picture pair');
    expect(problems).toContain('"reviewed-change" declares no area');
    expect(problems).toContain('"reviewed-change" needs a hero picture pair');
  });

  it("refuses maintenance from a change or a release review: internal work takes an exclusion", () => {
    const { noPicture: _none, ...upkeep } = entry("upkeep-change", [], { kind: "maintenance" });
    const reviewed = { ...upkeep, id: "upkeep-review", provenance: { origin: "release-review" } };
    const problems = problemsOf([upkeep, reviewed as NoteEntry]).join("\n");
    expect(problems).toContain('"upkeep-change" is maintenance');
    expect(problems).toContain('"upkeep-review" is maintenance');
    // The one written and shipped before the rule stays as it is.
    expect(problemsOf([{ ...upkeep, id: "pi-1-0" }])).toEqual([]);
  });

  it("exempts backfilled history from its area, its picture and the maintenance rule", () => {
    const {
      area: _area,
      noPicture: _reason,
      ...old
    } = entry("old-change", [], {
      provenance: { origin: "changelog-backfill" },
    });
    expect(problemsOf([old, { ...old, id: "old-upkeep", kind: "maintenance" }])).toEqual([]);
  });

  it("gives the lead highlight a picture, never only a reason", () => {
    expect(problemsOf([entry("lead-change", [], { highlight: 1 })]).join()).toContain(
      '"lead-change" is the lead highlight and needs a hero picture pair',
    );
    expect(problemsOf([pictured("lead-change", { highlight: 1 })])).toEqual([]);
    expect(problemsOf([entry("second-change", [], { highlight: 2 })])).toEqual([]);
  });
});

/**
 * The captain's INF-6704 plan: a feature, improvement or removal note from a
 * change names the docs site pages that same change edited, or says why none.
 */
describe("the docs site declaration", () => {
  const pages = new Map([
    ["settings", "docs-site/src/content/docs/settings.md"],
    ["install", "docs-site/src/content/docs/install.md"],
  ]);
  const own = (entries: NoteEntry[]) => file("release-notes/changes/a.json", entries, true);
  const bare = (kind: NoteEntry["kind"], extra: Partial<NoteEntry> = {}): NoteEntry => ({
    ...entry(`a-${kind}`),
    provenance: { origin: "change" },
    kind,
    ...extra,
  });

  it("asks a feature, improvement or removal for pages or a reason, and nothing of a fix, a release review or a note that covers other commits", () => {
    const none = new Set<string>();
    for (const kind of ["feature", "improvement", "removal"] as const)
      expect(docsSiteProblems(own([bare(kind)]), pages, none)).toEqual([
        `release-notes/changes/a.json: "a-${kind}" is a ${kind}: name the docs site pages this change edited in "docsSite", or say in one sentence in "noDocsSite" why no page needs to change`,
      ]);
    expect(docsSiteProblems(own([bare("fix")]), pages, none)).toEqual([]);
    expect(
      docsSiteProblems(own([bare("feature", { noDocsSite: "No page covers it." })]), pages, none),
    ).toEqual([]);
    expect(
      docsSiteProblems(
        own([bare("feature", { provenance: { origin: "release-review" } })]),
        pages,
        none,
      ),
    ).toEqual([]);
    expect(docsSiteProblems(own([entry("covering", [3])]), pages, none)).toEqual([]);
    // Authors write an empty covers list on notes of their own change, which covers nothing else.
    expect(
      docsSiteProblems(
        own([bare("feature", { provenance: { origin: "change", covers: [] } })]),
        pages,
        none,
      ),
    ).toEqual([
      `release-notes/changes/a.json: "a-feature" is a feature: name the docs site pages this change edited in "docsSite", or say in one sentence in "noDocsSite" why no page needs to change`,
    ]);
  });

  it("holds each named page to a hand-written page the same change edited", () => {
    const named = own([bare("feature", { docsSite: ["settings", "install"] })]);
    expect(
      docsSiteProblems(named, pages, new Set(["docs-site/src/content/docs/settings.md"])),
    ).toEqual([
      'release-notes/changes/a.json: "a-feature" names "install", but this change does not edit docs-site/src/content/docs/install.md: update the page in the same change, or say in "noDocsSite" why it needs no change',
    ]);
    expect(docsSiteProblems(named, pages, new Set([...pages.values()]))).toEqual([]);
    expect(
      docsSiteProblems(own([bare("fix", { docsSite: ["glossary"] })]), pages, new Set()),
    ).toEqual([
      'release-notes/changes/a.json: "a-fix" names "glossary", which is not a hand-written docs site page',
    ]);
    // A note covering other commits may have its page edited there, so the page need only exist.
    expect(
      docsSiteProblems(own([entry("covering", [3], { docsSite: ["install"] })]), pages, new Set()),
    ).toEqual([]);
  });
});

describe("hero picture files", () => {
  const ledger = (entries: NoteEntry[]) => [file("changes/a.json", entries, true)];
  const check = (files: Record<string, Buffer>, entries = [pictured("hero-change")]) =>
    pictureProblems(ledger(entries), (name) => files[name] ?? null);

  it("accepts a landscape WebP or PNG pair within the caps", () => {
    const png = Buffer.from(PNG_BASE64, "base64");
    expect(
      check({
        "hero-change-dark.webp": webpBytes(1200, 600),
        "hero-change-light.webp": webpBytes(1200, 600),
      }),
    ).toEqual([]);
    const pngEntry = pictured("hero-change");
    pngEntry.picture = { dark: "hero-change-dark.png", light: "hero-change-light.png", alt: "x" };
    // A 1 by 1 picture is square, not taller than wide.
    expect(
      check({ "hero-change-dark.png": png, "hero-change-light.png": png }, [pngEntry]),
    ).toEqual([]);
  });

  it("refuses a missing file or half a pair, a wrong format, a picture too wide, too large or portrait", () => {
    const light = webpBytes(1200, 600);
    expect(check({ "hero-change-light.webp": light }).join()).toContain(
      "hero-change-dark.webp, which is missing",
    );
    expect(
      check({
        "hero-change-dark.webp": Buffer.from(PNG_BASE64, "base64"),
        "hero-change-light.webp": light,
      }).join(),
    ).toContain("hero-change-dark.webp, which is not a valid WebP");
    expect(
      check({
        "hero-change-dark.webp": Buffer.from("RIFF not really"),
        "hero-change-light.webp": light,
      }).join(),
    ).toContain("not a valid WebP");
    expect(
      check({
        "hero-change-dark.webp": webpBytes(1700, 800),
        "hero-change-light.webp": light,
      }).join(),
    ).toContain("1700 px wide (at most 1600)");
    expect(
      check({
        "hero-change-dark.webp": webpBytes(1200, 600, MAX_HERO_BYTES + 1),
        "hero-change-light.webp": light,
      }).join(),
    ).toContain("(at most 300 KB)");
    expect(
      check({
        "hero-change-dark.webp": webpBytes(600, 900),
        "hero-change-light.webp": light,
      }).join(),
    ).toContain("600 by 900: crop it landscape");
  });
});

describe("coverage", () => {
  const addedBy = (path: string) => (path === "changes/new.json" ? sha(9) : null);

  it("a self-covering file speaks for the commit that added it", () => {
    const files = [file("changes/new.json", [entry("new-change")], true)];
    expect(unreachableNotes(files, addedBy)).toEqual([]);
    expect(coveredCommits(files, addedBy).has(sha(9))).toBe(true);
  });

  it("a note that names no commit and is not self-covering can never be reached", () => {
    expect(
      unreachableNotes([file("history/old.json", [entry("orphan-id")])], addedBy).join(),
    ).toContain("covers no commit");
  });

  it("lists exactly the source changes with no note or exclusion", () => {
    const files = [
      file("history/x.json", [entry("covered-one", [1])]),
      {
        path: "history/y.json",
        file: {
          entries: [],
          exclusions: [{ id: "chore-only", reason: "internal", covers: [sha(2)] }],
        },
        selfCovering: false,
      },
    ];
    const covered = coveredCommits(files, addedBy);
    const range = [1, 2, 3].map((n) => ({ sha: sha(n), subject: `s${n}` }));
    expect(uncoveredCommits(range, covered)).toEqual([{ sha: sha(3), subject: "s3" }]);
  });
});

describe("membership and the catalog", () => {
  const files = [
    file("h.json", [entry("a-first", [1]), entry("b-second", [2]), entry("c-branch", [7])]),
  ];
  const commits = entryCommits(files, () => null);

  it("is cumulative and exact: later and unrelated-branch entries are excluded", () => {
    const main = new Set([sha(1), sha(2), sha(3)]);
    expect(membership(commits, main)).toEqual(["a-first", "b-second"]);
    expect(membership(commits, new Set([sha(1)]))).toEqual(["a-first"]);
    expect(membership(commits, new Set([sha(1), sha(7)]))).toEqual(["a-first", "c-branch"]);
  });

  it("orders alpha releases by numeric precedence and ships only the target's entries", () => {
    const { catalog, problems } = buildCatalog({
      target: manifest("0.1.28-alpha.10", 3, ["a-first", "b-second"]),
      entries: files.flatMap((item) => item.file.entries),
      releases: [
        manifest("0.1.28-alpha.2", 1, ["a-first"]),
        manifest("0.1.27", 1, ["a-first"]),
        manifest("0.1.28", 3, ["a-first", "b-second"]),
      ],
    });
    expect(problems).toEqual([]);
    expect(catalog?.releases.map((release) => release.version)).toEqual([
      "0.1.27",
      "0.1.28-alpha.2",
      "0.1.28-alpha.10",
      "0.1.28",
    ]);
    expect(catalog?.entries.map((item) => item.id)).toEqual(["a-first", "b-second"]);
  });

  it("leaves the docs site declaration out of the packaged catalog", () => {
    const { catalog } = buildCatalog({
      target: manifest("0.1.28-alpha.10", 3, ["a-first", "b-second"]),
      entries: [
        entry("a-first", [1], { docsSite: ["settings"] }),
        entry("b-second", [2], { noDocsSite: "No page covers it." }),
      ],
      releases: [],
    });
    expect(catalog?.entries.map((item) => Object.keys(item).sort())).toEqual([
      ["area", "id", "kind", "noPicture", "provenance", "title"],
      ["area", "id", "kind", "noPicture", "provenance", "title"],
    ]);
  });

  it("refuses a version already published from a different source", () => {
    const { catalog, problems } = buildCatalog({
      target: manifest("0.1.28-alpha.2", 5, []),
      entries: [],
      releases: [manifest("0.1.28-alpha.2", 1, [])],
    });
    expect(catalog).toBeNull();
    expect(problems.join()).toContain("already published");
  });

  it("verifies a packaged catalog's exact identity and membership", () => {
    const { catalog } = buildCatalog({
      target: manifest("0.1.28-alpha.10", 3, ["a-first"]),
      entries: files.flatMap((item) => item.file.entries),
      releases: [],
    });
    const expected = { version: "0.1.28-alpha.10", sourceCommit: sha(3) };
    expect(verifyCatalog(catalog, expected)).toEqual([]);
    expect(verifyCatalog(catalog, { ...expected, version: "0.1.28-alpha.11" }).join()).toContain(
      "not 0.1.28-alpha.11",
    );
    expect(verifyCatalog(catalog, { ...expected, sourceCommit: sha(4) }).join()).toContain(
      "built from",
    );
    const tampered = {
      ...catalog,
      entries: [...(catalog?.entries ?? []), entry("extra-one", [5])],
    };
    expect(verifyCatalog(tampered, expected).join()).toContain("outside the release");
    expect(verifyCatalog({ schema: 2 }, expected)).toEqual(["the catalog is not schema 1"]);
  });

  it("carries exactly the highlighted entries' hero pairs, each with its hash and size", () => {
    const lead = pictured("lead-change", { highlight: 1 });
    const plain = pictured("plain-change");
    const shipped = { sha256: "a".repeat(64), width: 1200, height: 600 };
    const input = {
      target: manifest("0.1.29-alpha.1", 3, ["lead-change", "plain-change"]),
      entries: [lead, plain],
      releases: [],
    };
    const { catalog, problems } = buildCatalog({
      ...input,
      pictures: { "lead-change-dark.webp": shipped, "lead-change-light.webp": shipped },
    });
    expect(problems).toEqual([]);
    expect(Object.keys(catalog?.pictures ?? {}).sort()).toEqual([
      "lead-change-dark.webp",
      "lead-change-light.webp",
    ]);
    const expected = { version: "0.1.29-alpha.1", sourceCommit: sha(3) };
    expect(verifyCatalog(catalog, expected)).toEqual([]);
    expect(buildCatalog({ ...input, pictures: {} }).problems.join()).toContain(
      "lead-change-dark.webp was not read",
    );
    const { "lead-change-light.webp": _light, ...half } = catalog?.pictures ?? {};
    expect(verifyCatalog({ ...catalog, pictures: half }, expected).join()).toContain(
      "lead-change-light.webp is not in the catalog",
    );
    expect(
      verifyCatalog(
        { ...catalog, pictures: { ...catalog?.pictures, "plain-change-dark.webp": shipped } },
        expected,
      ).join(),
    ).toContain("plain-change-dark.webp belongs to no highlight");
    expect(
      verifyCatalog(
        {
          ...catalog,
          pictures: { ...catalog?.pictures, "lead-change-dark.webp": { width: 1, height: 1 } },
        },
        expected,
      ).join(),
    ).toContain("needs a sha256");
  });
});

/**
 * A stable promotion's highlights are the captain's picks (docs/alpha.md
 * "Promoting an alpha"): exactly those, in his order, chosen from the
 * changes since the last stable, with a pictured lead.
 */
describe("a stable's picked highlights", () => {
  const shipped = { sha256: "b".repeat(64), width: 1200, height: 600 };
  const old = pictured("old-change", { highlight: 1 });
  const history: NoteEntry = {
    id: "backfilled-change",
    kind: "fix",
    title: "A backfilled change",
    provenance: { origin: "changelog-backfill", covers: [sha(1)] },
  };
  const lead = pictured("lead-change", { highlight: 2 });
  const second = pictured("second-change", { highlight: 1 });
  const plain = entry("plain-change", [3]);
  const fourth = pictured("fourth-change", { highlight: 3 });
  const all = [old, history, lead, second, plain, fourth];
  const ids = all.map((item) => item.id).sort();
  const releases = [
    manifest("1.0.0", 1, ["old-change"]),
    manifest("1.0.1-alpha.4", 3, ids),
    manifest("1.0.1-alpha.5", 4, ids),
  ];
  /** The stable's catalog as its alpha's own tooling builds it: every review's ranks and their pairs. */
  function generated(version = "1.0.1") {
    const pictures = Object.fromEntries(
      [old, lead, second, fourth].flatMap((item) => [
        [`${item.id}-dark.webp`, shipped],
        [`${item.id}-light.webp`, shipped],
      ]),
    );
    const { catalog } = buildCatalog({
      target: manifest(
        version,
        4,
        ids,
        version.includes("alpha") ? {} : { promotedFrom: "1.0.1-alpha.5" },
      ),
      entries: all,
      releases,
      pictures,
    });
    return catalog;
  }
  const read = () => shipped;

  it("lists the changes since the last stable, never one it shipped or backfilled history", () => {
    const listed = highlightCandidates(generated());
    expect(listed.problems).toEqual([]);
    expect(listed.since).toBe("1.0.0");
    expect(listed.candidates.map((item) => item.id).sort()).toEqual([
      "fourth-change",
      "lead-change",
      "plain-change",
      "second-change",
    ]);
  });

  it("ranks exactly the picks in their order, clears every other rank and ships only their pairs", () => {
    const before = generated();
    const { catalog, problems } = pickHighlights(
      before,
      ["lead-change", "plain-change", "fourth-change"],
      read,
    );
    expect(problems).toEqual([]);
    const ranks = ((catalog?.entries ?? []) as NoteEntry[]).flatMap((item) =>
      item.highlight === undefined ? [] : [[item.id, item.highlight]],
    );
    expect(ranks).toEqual([
      ["fourth-change", 3],
      ["lead-change", 1],
      ["plain-change", 2],
    ]);
    // The unpictured second pick reads as text, so only two pairs ship.
    expect(Object.keys(catalog?.pictures as object).sort()).toEqual([
      "fourth-change-dark.webp",
      "fourth-change-light.webp",
      "lead-change-dark.webp",
      "lead-change-light.webp",
    ]);
    expect(verifyCatalog(catalog, { version: "1.0.1", sourceCommit: sha(4) })).toEqual([]);
    const { entries: _a, pictures: _b, ...rest } = catalog ?? {};
    const { entries: _c, pictures: _d, ...was } = before ?? {};
    expect(rest).toEqual(was);
  });

  it("refuses a lead with no picture, a change the last stable shipped, a short or repeated pick, and an alpha", () => {
    const refused = (picks: string[], catalog: unknown = generated()) =>
      pickHighlights(catalog, picks, read).problems.join("\n");
    expect(refused(["plain-change", "lead-change", "fourth-change"])).toMatch(
      /"plain-change" has no hero picture/,
    );
    expect(refused(["lead-change", "old-change", "fourth-change"])).toMatch(
      /"old-change" is not a change since the last stable/,
    );
    expect(refused(["lead-change", "backfilled-change", "fourth-change"])).toMatch(
      /"backfilled-change" is not a change since the last stable/,
    );
    expect(refused(["lead-change", "fourth-change"])).toMatch(/takes 3 picked highlights, not 2/);
    expect(refused(["lead-change", "lead-change", "fourth-change"])).toMatch(/picked twice/);
    expect(
      refused(["lead-change", "plain-change", "fourth-change"], generated("1.0.1-alpha.6")),
    ).toMatch(/not a stable/);
    expect(
      pickHighlights(
        generated(),
        ["lead-change", "plain-change", "fourth-change"],
        () => null,
      ).problems.join(),
    ).toContain("lead-change-dark.webp cannot be read");
  });

  it("keeps the picks in the stable's record, checked the same way", () => {
    const files = [file("a.json", all)];
    const record = (highlights: string[], version = "1.0.1") => ({
      path: `releases/${version}.json`,
      manifest: manifest(version, 4, ids, {
        promotedFrom: version.includes("alpha") ? null : "1.0.1-alpha.5",
        highlights,
      }),
    });
    const ledger = (...extra: { path: string; manifest: ReleaseManifest }[]) =>
      validateLedger({
        files,
        manifests: [
          ...releases.map((item) => ({ path: `releases/${item.version}.json`, manifest: item })),
          ...extra,
        ],
      });
    expect(ledger(record(["lead-change", "plain-change", "fourth-change"]))).toEqual([]);
    expect(ledger(record(["lead-change", "old-change", "fourth-change"])).join()).toContain(
      'releases/1.0.1.json: "old-change" is not a change since the last stable',
    );
    expect(
      ledger(record(["lead-change", "plain-change", "fourth-change"], "1.0.2-alpha.1")).join(),
    ).toContain("only a stable's record keeps picked highlights");
    const { manifest: parsed } = parseManifest(
      record(["lead-change", "plain-change", "fourth-change"]).manifest,
      "m.json",
    );
    expect(parsed?.highlights).toEqual(["lead-change", "plain-change", "fourth-change"]);
    expect(
      parseManifest(
        { ...record([]).manifest, highlights: "lead-change" },
        "m.json",
      ).problems.join(),
    ).toContain("highlights");
  });
});
