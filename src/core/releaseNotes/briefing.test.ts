import { describe, expect, it } from "vitest";
import { type HeroPicture, READ_AGAIN, renderNote } from "./briefing";
import { MAX_HIGHLIGHTS, type NoteArea } from "./catalog";
import { selectEntries } from "./select";
import { catalogFor, ENTRIES, entry, RELEASES, release } from "./testCatalog";

/**
 * The Briefing the captain chose on FI3-608 and extended on FI3-745, as an
 * ordinary card body: the version range, one line on what it covers,
 * numbered highlights with their area and hero picture (the first across
 * the card, the next two side by side), then every change behind one
 * disclosure, grouped by feature area and tagged with its kind.
 */

/** The fixture's entries with a declared area each: d and b in Cards, c in Tasks; a, e and f declare none. */
const AREAS: Record<string, NoteArea> = {
  "change-d": "cards",
  "change-b": "cards",
  "change-c": "tasks",
};
const AREA_ENTRIES = ENTRIES.map((e) => (AREAS[e.id] ? { ...e, area: AREAS[e.id] } : e));

const note = (
  from: string | null,
  to: string,
  extra: Partial<Parameters<typeof selectEntries>[0]> = {},
  pictures?: ReadonlyMap<string, HeroPicture>,
) => {
  const input = {
    catalog: "catalog" in extra ? (extra.catalog ?? null) : catalogFor(to, RELEASES, AREA_ENTRIES),
    from,
    to,
    delivered: new Set<string>(),
    unresolved: [],
    mode: from === null ? ("overview" as const) : ("upgrade" as const),
    ...extra,
  };
  return renderNote({
    mode: input.mode,
    from,
    to,
    selection: selectEntries(input),
    ...(pictures ? { pictures } : {}),
  });
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
const all = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "g"))].map((m) => text(m[1] ?? ""));
const highlightsOf = (html: string) =>
  /<section aria-label="Highlights"[^>]*>(.*?)<\/section>/.exec(html)?.[1] ?? "";

describe("the Briefing of an upgrade", () => {
  const { title, body } = note("0.1.25", "0.1.27");

  it("is titled with the version it covers and opens on the range, the current version lit", () => {
    expect(title).toBe("What’s new in stable 0.1.27");
    expect(body.startsWith('<p class="inf-mono inf-muted"')).toBe(true);
    const range = all(body, "p")[0];
    expect(range).toBe("Stable 0.1.25 → Stable 0.1.27");
    expect(body).toContain('<span style="color:var(--accent)">Stable 0.1.27</span>');
  });

  it("says in one line how many releases it covers", () => {
    expect(all(body, "p")[1]).toBe(
      "Two releases since the version you last opened, in one complete briefing.",
    );
  });

  it("numbers the highlights by rank with their kind and area, the first across the card and the next beside each other", () => {
    const section = highlightsOf(body);
    expect(all(section, "h6")).toEqual(["01 / Added · Cards", "02 / Fixed · Tasks"]);
    expect(all(section, "h3")).toEqual(["Change change-d", "Change change-c"]);
    const [lead, grid] = section.split('<div class="inf-grid"');
    expect(all(lead ?? "", "h3")).toEqual(["Change change-d"]);
    expect(all(grid ?? "", "h3")).toEqual(["Change change-c"]);
  });

  it("puts every change behind one closed disclosure, by area in the product's order, features first, with no version headings", () => {
    const [outer] = all(body, "summary");
    expect(outer).toBe("All 3 changes");
    expect(body).toMatch(/<details><summary>All 3 changes<\/summary>/);
    expect(all(body, "summary").slice(1)).toEqual(["Cards · 2 changes", "Tasks · 1 change"]);
    expect(all(body, "li")).toEqual([
      "Change change-d AddedBody of d.",
      "Change change-b ImprovedBody of b.",
      "Change change-c Fixed",
    ]);
    expect(all(body, "summary").join(" ")).not.toMatch(/Stable 0\.1\.2[67]/);
  });

  it("files an entry that declares no area under Other changes, last", () => {
    const { body: history } = note(null, "0.1.27", { mode: "history" });
    expect(all(history, "summary").slice(1)).toEqual([
      "Cards · 2 changes",
      "Tasks · 1 change",
      "Other changes · 1 change",
    ]);
    expect(all(history, "li").at(-1)).toBe("Change change-a Added");
  });

  it("closes on where the notes come from, then where to read them again", () => {
    expect(all(body, "p").slice(-2)).toEqual([
      "Notes carried in this version · available offline",
      "You can read this again from What’s New in the Help menu.",
    ]);
  });

  it("is an ordinary card body: no script, stylesheet or button of its own", () => {
    expect(body).not.toMatch(/<script|<style|<button|<link|<iframe/);
  });
});

describe("highlights", () => {
  it("never shows more than three, and opens the full list when there are none", () => {
    const ranked = ENTRIES.map((e, i) => ({ ...e, highlight: i + 1 }));
    const many = renderNote({
      mode: "upgrade",
      from: "0.1.25",
      to: "0.1.27",
      selection: selectEntries({
        catalog: catalogFor("0.1.27", RELEASES, ranked),
        from: "0.1.25",
        to: "0.1.27",
        delivered: new Set(),
        unresolved: [],
        mode: "upgrade",
      }),
    });
    expect(all(highlightsOf(many.body), "h3")).toHaveLength(MAX_HIGHLIGHTS);
    const plain = ENTRIES.map(({ highlight: _highlight, ...e }) => e);
    const none = renderNote({
      mode: "upgrade",
      from: "0.1.25",
      to: "0.1.27",
      selection: selectEntries({
        catalog: catalogFor("0.1.27", RELEASES, plain),
        from: "0.1.25",
        to: "0.1.27",
        delivered: new Set(),
        unresolved: [],
        mode: "upgrade",
      }),
    });
    expect(none.body).not.toContain("Highlights");
    expect(none.body).toMatch(/<details open><summary>All 3 changes<\/summary>/);
  });
});

describe("other moments", () => {
  it("an alpha upgrade lists only what came after the previous alpha", () => {
    const { title, body } = note("0.1.28-alpha.2", "0.1.28-alpha.10");
    expect(title).toBe("What’s new in alpha 0.1.28-alpha.10");
    expect(all(body, "p")[1]).toBe("Only changes added after your previous alpha.");
  });

  it("a promotion with nothing new says so in a compact note", () => {
    const { title, body } = note("0.1.27-alpha.20", "0.1.27");
    expect(title).toBe("Your alpha is now stable");
    expect(all(body, "h3")).toEqual(["No new changes"]);
    expect(body).not.toContain("<details");
    expect(all(body, "p").at(-1)).toBe("Verified promotion · no repeated changes");
  });

  it("an upgrade with nothing new to this person says so, without claiming a promotion", () => {
    const { title, body } = note("0.1.25", "0.1.27", {
      delivered: new Set(["change-b", "change-c", "change-d"]),
    });
    expect(title).toBe("Your app is updated");
    expect(all(body, "p")[1]).toBe("Nothing in this version is new to you.");
    expect(all(body, "p").at(-1)).toBe("Verified update · no repeated changes");
    // What's new opens the newest note that listed changes, so this one names no way back.
    expect(body).not.toContain(READ_AGAIN);
  });

  it("missing notes say the app is updated and what cannot be shown, never an empty list", () => {
    const { title, body } = note("0.1.25", "0.1.27", { catalog: null });
    expect(title).toBe("Your app is updated");
    expect(all(body, "p")[1]).toBe(
      "The notes this version carries could not be read, so I cannot show what changed since stable 0.1.25.",
    );
    expect(body).toContain("border-color:var(--warn)");
    expect(body).not.toContain("<details");
  });

  it("names a previous version it has no notes for, an incomplete one, and a move off its line", () => {
    expect(all(note("0.1.26-alpha.99", "0.1.27").body, "p")[1]).toBe(
      "I have no notes for alpha 0.1.26-alpha.99, the version you last opened. These notes cover this release only.",
    );
    expect(all(note("0.1.0", "0.1.25").body, "p")[1]).toBe(
      "The notes for stable 0.1.0 are incomplete, so some of these may be changes you already had.",
    );
    expect(all(note("0.1.27-alpha.16", "0.1.27").body, "p")[1]).toBe(
      "Alpha 0.1.27-alpha.16 had changes this version does not include. Only the changes in this version are listed.",
    );
  });

  it("lists recovered changes under the range they belong to, grouped by area inside", () => {
    const { body } = note("0.1.26", "0.1.27", {
      unresolved: [{ from: "0.1.25", to: "0.1.26", reason: "unavailable" }],
    });
    const summaries = all(body, "summary");
    const at = summaries.indexOf(
      "Earlier, now verified: stable 0.1.25 to stable 0.1.26 · 1 change",
    );
    expect(at).toBeGreaterThan(0);
    expect(summaries.slice(at + 1)).toEqual(["Cards · 1 change"]);
  });
});

describe("hero pictures", () => {
  const pair = (name: string, alt: string): HeroPicture => ({
    alt,
    dark: { src: `app-frame://images/release-notes-${name}d.webp`, width: 1200, height: 600 },
    light: { src: `app-frame://images/release-notes-${name}l.webp`, width: 1200, height: 600 },
  });
  const pictures = new Map([
    ["change-d", pair("d", "The d view")],
    ["change-c", pair("c", "The c view")],
  ]);
  const section = highlightsOf(note("0.1.25", "0.1.27", {}, pictures).body);
  const [lead = "", side = ""] = section.split('<div class="inf-grid"');
  const images = (html: string) => [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);

  it("rides the note as both themes' pictures, each marked with its theme, sized from its header", () => {
    expect(images(lead).map((tag) => /data-inf-theme="(\w+)"/.exec(tag)?.[1])).toEqual([
      "dark",
      "light",
    ]);
    expect(images(lead)[0]).toContain('src="app-frame://images/release-notes-dd.webp"');
    expect(images(lead)[1]).toContain('src="app-frame://images/release-notes-dl.webp"');
    for (const tag of images(section)) expect(tag).toContain('width="1200" height="600"');
    expect(images(lead)[0]).toContain('alt="The d view"');
  });

  it("puts the lead's picture under its words and a side highlight's above them, each on a 12 px mat", () => {
    expect(lead.indexOf("<img")).toBeGreaterThan(lead.indexOf("Body of d."));
    expect(side.indexOf("<img")).toBeLessThan(side.indexOf("<h3>"));
    for (const tag of images(section)) {
      expect(tag).toContain("padding:var(--space-3)");
      expect(tag).toContain("border:1px solid var(--line-1)");
      expect(tag).toContain("background:var(--bg-1)");
    }
  });

  it("leaves a highlight with no picture as text", () => {
    const words = highlightsOf(note("0.1.25", "0.1.27").body);
    expect(words).not.toContain("<img");
    expect(all(words, "h3")).toEqual(["Change change-d", "Change change-c"]);
  });
});

describe("escaping", () => {
  it("renders catalog text as text, never as markup", () => {
    const hostile = [entry("change-z", { title: "<img src=x onerror=alert(1)>", body: "a & b" })];
    const releases = [release("0.1.1", []), release("0.1.2", ["change-z"])];
    const { body } = renderNote({
      mode: "upgrade",
      from: "0.1.1",
      to: "0.1.2",
      selection: selectEntries({
        catalog: catalogFor("0.1.2", releases, hostile),
        from: "0.1.1",
        to: "0.1.2",
        delivered: new Set(),
        unresolved: [],
        mode: "upgrade",
      }),
    });
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).toContain("a &amp; b");
  });

  it("escapes a picture's alt text into its attribute", () => {
    const picture: HeroPicture = {
      alt: 'A "quoted" <view>',
      dark: { src: "app-frame://images/release-notes-x.webp", width: 10, height: 5 },
      light: { src: "app-frame://images/release-notes-y.webp", width: 10, height: 5 },
    };
    const { body } = note("0.1.25", "0.1.27", {}, new Map([["change-d", picture]]));
    expect(body).toContain('alt="A &quot;quoted&quot; &lt;view&gt;"');
  });
});

/** The star ask the captain chose on INF-6429: a panel after the highlights linking to the project's page. */
describe("the star ask", () => {
  const withAsk = (from: string, to: string, starAsk: boolean) =>
    renderNote({
      mode: "upgrade",
      from,
      to,
      selection: selectEntries({
        catalog: catalogFor(to, RELEASES, AREA_ENTRIES),
        from,
        to,
        delivered: new Set(),
        unresolved: [],
        mode: "upgrade",
      }),
      starAsk,
    }).body;

  it("sits between the highlights and the full list, its button a link to the project's page", () => {
    const body = withAsk("0.1.25", "0.1.27", true);
    const panel =
      /<div class="inf-panel" data-star-ask=""[^>]*>.*?<\/a><\/div>/.exec(body)?.[0] ?? "";
    expect(text(panel)).toBe(
      "Open sourceInfinitary is open source. If you find it useful, a star on GitHub helps more people discover it.Star on GitHub",
    );
    expect(panel).toContain('<a href="https://github.com/infinitary-labs/infinitary-apps"');
    const at = body.indexOf(panel);
    expect(at).toBeGreaterThan(body.indexOf("</section>"));
    expect(at).toBeLessThan(body.indexOf("<details><summary>All "));
    expect(body).not.toContain("<script");
  });

  it("is left out when not asked for, and from a note with nothing new", () => {
    expect(withAsk("0.1.25", "0.1.27", false)).not.toContain("data-star-ask");
    expect(withAsk("0.1.27-alpha.20", "0.1.27", true)).not.toContain("data-star-ask");
  });
});
