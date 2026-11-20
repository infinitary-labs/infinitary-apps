import { describe, expect, it } from "vitest";
import { cardChanges, cardParts, revisionNotice } from "./cardChanges";

const card = (body: string, title = "The flaky test") => ({ title, body, actions: [] });

/** The tag each mark points at, as the renderer will find it. */
function marked(body: string, marks: readonly number[]): string[] {
  return marks.map((start) => /^<[a-z]+/i.exec(body.slice(start))?.[0] ?? "?");
}

describe("cardParts", () => {
  it("reads paragraphs, list items, table rows, figures and questions, outermost only", () => {
    const body =
      "<h3>Why</h3><p>One <b>bold</b> line.</p>" +
      "<ul><li><p>An item with its own paragraph.</p></li><li>Two</li></ul>" +
      "<table><tr><th>a</th></tr><tr><td>b</td></tr></table>" +
      '<figure><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></figure>' +
      '<fieldset><legend>Which?</legend><label><input type="radio" name="w" value="a"> A</label></fieldset>' +
      "<details><summary>Evidence</summary><p>Inside the details.</p></details>" +
      "<div>Bare text in a container is not a part.</div>";
    const parts = cardParts(body);
    expect(parts.map((part) => /^<([a-z]+)/.exec(part.key)?.[1])).toEqual([
      "p",
      "li",
      "li",
      "tr",
      "tr",
      "figure",
      "fieldset",
      "p",
    ]);
    // Each start is the part's own opening tag in the body as written.
    expect(parts.map((part) => body.slice(part.start, part.start + 3))).toEqual([
      "<p>",
      "<li",
      "<li",
      "<tr",
      "<tr",
      "<fi",
      "<fi",
      "<p>",
    ]);
  });

  it("skips the host's fact strip and follow-up rows, and anything in a script or style", () => {
    const parts = cardParts(
      "<p>Ready.</p>" +
        '<div class="inf-facts" data-facts><span class="inf-fact"><p>Checks passed</p></span></div>' +
        '<div class="inf-followups" data-followups><p>FI3-1 planned</p></div>' +
        "<template><p>Not shown.</p></template>",
    );
    expect(parts).toHaveLength(1);
  });

  it("reads a question drawn as a role group, and a lone picture, as parts", () => {
    const parts = cardParts(
      '<div role="radiogroup" aria-label="Which?"><label><input type="radio" name="w"> A</label></div>' +
        '<img src="data:image/png;base64,AAAA" alt="the dock">',
    );
    expect(parts).toHaveLength(2);
  });
});

describe("cardChanges", () => {
  const seen = card(
    "<p>The upload test fails when the queue drains late.</p>" +
      "<ul><li>Mock the clock: 12 lines</li><li>Rewrite the uploader</li></ul>" +
      "<p>Evidence is in the log.</p>",
  );

  it("counts the new parts and the removed ones, and marks each new part where it starts", () => {
    const shown = card(
      "<p>The upload test fails when the queue drains late.</p>" +
        "<p>Mocking the clock also fixes the retry failure you asked about.</p>" +
        "<ul><li>Mock the clock: 12 lines</li><li>Await the queue: 40 lines</li></ul>" +
        "<p>Evidence is in the log.</p>",
    );
    const changes = cardChanges(seen, shown, 5000);
    expect(changes).toMatchObject({ at: 5000, added: 2, removed: 1, rewritten: false });
    expect(marked(shown.body, changes?.marks ?? [])).toEqual(["<p", "<li"]);
    expect((changes?.marks ?? []).map((start) => shown.body.slice(start, start + 20))).toEqual([
      "<p>Mocking the clock",
      "<li>Await the queue:",
    ]);
  });

  it("reads more than half new as a rewrite and marks nothing", () => {
    const changes = cardChanges(
      seen,
      card(
        "<p>A new answer.</p><ul><li>New one</li><li>New two</li></ul><p>Evidence is in the log.</p>",
      ),
      5000,
    );
    expect(changes).toMatchObject({ added: 3, removed: 3, rewritten: true, marks: [] });
  });

  it("reads exactly half new as a revision, with marks", () => {
    const changes = cardChanges(card("<p>a</p><p>b</p>"), card("<p>a</p><p>c</p>"), 1);
    expect(changes).toMatchObject({ added: 1, removed: 1, rewritten: false });
    expect(changes?.marks).toHaveLength(1);
  });

  it("does not count a part that only moved, or whitespace and attribute order", () => {
    const before = card('<p>One</p><p class="a" id="b">Two   words</p>');
    const after = card('<p id="b" class="a">Two words</p>\n<p>One</p>');
    expect(cardChanges(before, after, 1)).toBeUndefined();
  });

  it("ignores the name the host gave a picture's copy, which changes on every call", () => {
    const at = (hex: string) =>
      card(
        `<p>After:</p><img src="app-frame://images/1bf72c63-${hex}.png" alt="the dock" width="1200" height="800">`,
      );
    expect(cardChanges(at("a".repeat(32)), at("b".repeat(32)), 1)).toBeUndefined();
    // Another picture is another part.
    const other = card(
      `<p>After:</p><img src="app-frame://images/1bf72c63-${"c".repeat(32)}.png" alt="the rail" width="1200" height="800">`,
    );
    expect(cardChanges(at("a".repeat(32)), other, 1)).toMatchObject({ added: 1, removed: 1 });
  });

  // INF-3188: a revision swapped a figure's picture for a different file while
  // keeping its alt text and caption, and the captain saw no change; a caption
  // edit beside an unchanged picture marked the figure as if its picture were new.
  it("compares each picture by its verified bytes, never by its copy's name alone", () => {
    const figure = (hex: string, caption: string) =>
      `<figure class="inf-pictures"><img src="app-frame://images/fae94df9-${hex}.png" alt="The keyboard-down button beside the send arrow" width="1206" height="2622"><figcaption>${caption}</figcaption></figure>`;
    const version = (hex: string, sha: string, caption = "B. The keyboard-down mark") => ({
      ...card(`<p>The circle is redrawn.</p>${figure(hex, caption)}`),
      pictures: [
        {
          id: `fae94df9-${hex}`,
          sha256: sha.repeat(64),
          alt: "The keyboard-down button beside the send arrow",
          width: 1206,
          height: 2622,
          group: 0,
        },
      ],
    });
    const twoLine = version("c".repeat(32), "8");
    // The same file copied again under a new name is not a change.
    expect(cardChanges(twoLine, version("b".repeat(32), "8"), 1)).toBeUndefined();
    // Another file under the same alt text and caption is.
    expect(cardChanges(twoLine, version("4".repeat(32), "a"), 1)).toMatchObject({
      added: 1,
      removed: 1,
    });
  });

  it("ignores the names the host gave a demo recording's copy and its poster's", () => {
    const at = (hex: string, caption = "Drag the row") =>
      card(
        `<p>After:</p><figure data-inf-demo="app-frame://media/1bf72c63-${hex}.mp4" data-inf-demo-duration="3000"><img src="app-frame://images/1bf72c63-${hex}.png" alt="the row" width="480" height="270"><figcaption>${caption}</figcaption></figure>`,
      );
    expect(cardChanges(at("a".repeat(32)), at("b".repeat(32)), 1)).toBeUndefined();
    // A new caption is the author's change.
    expect(cardChanges(at("a".repeat(32)), at("b".repeat(32), "Drop the row"), 1)).toMatchObject({
      added: 1,
      removed: 1,
    });
  });

  it("says a card changed when only its title or buttons did, with nothing to mark", () => {
    expect(cardChanges(seen, { ...seen, title: "The flaky test is fixed" }, 7)).toEqual({
      at: 7,
      added: 0,
      removed: 0,
      rewritten: false,
      marks: [],
    });
    expect(
      cardChanges(seen, { ...seen, actions: [{ id: "go", label: "Go", default: true }] }, 7),
    ).toMatchObject({ added: 0, removed: 0 });
  });

  it("counts a playable preview's parts but never marks inside it", () => {
    const preview = (words: string) =>
      card(`<p>Drag the slider.</p><p>${words}</p><p>Settings below.</p><script>draw()</script>`);
    expect(cardChanges(preview("Old"), preview("New"), 1)).toMatchObject({
      added: 1,
      removed: 1,
      rewritten: false,
      marks: [],
    });
  });

  it("marks a figure that moves like any other part: its script is its own", () => {
    const moving = (words: string, label: string) =>
      card(
        `<p>Press Next run.</p><p>${words}</p><p>Settings below.</p>` +
          `<figure aria-label="${label}"><button type="button">Next run</button><svg viewBox="0 0 510 40"></svg><script>step()</script></figure>`,
      );
    const seen = moving("Old", "Ten runs");
    const shown = moving("New", "Ten runs after the fix");
    const changes = cardChanges(seen, shown, 1);
    expect(changes).toMatchObject({ added: 2, removed: 2, rewritten: false });
    expect(changes?.marks).toEqual([shown.body.indexOf("<p>New"), shown.body.indexOf("<figure")]);
    // A change to the script alone is no part the captain reads.
    const restepped = card(shown.body.replace("step()", "step(2)"));
    expect(cardChanges(shown, restepped, 2)).toBeUndefined();
  });
});

describe("revisionNotice", () => {
  const changes = { at: 1, added: 1, removed: 0, rewritten: false, marks: [0], preview: false };

  it("says nothing without a comparison or a changed part", () => {
    expect(revisionNotice(undefined)).toBe("");
    expect(revisionNotice({ ...changes, added: 0 })).toBe("");
  });

  it("counts the parts and promises a bar for a small revision", () => {
    expect(revisionNotice(changes)).toContain("1 part new and 0 removed");
    expect(revisionNotice(changes)).toContain("change bar");
  });

  it("names a rewrite, allows it, and never mandates edits", () => {
    const text = revisionNotice({ ...changes, added: 5, removed: 4, rewritten: true });
    expect(text).toContain('"Rewritten" with no change bars');
    expect(text).toContain("That is fine");
    expect(text).not.toMatch(/must|refused/i);
  });

  it("gives a playable preview the counts only", () => {
    const text = revisionNotice({ ...changes, added: 5, rewritten: true, preview: true });
    expect(text).toContain("5 parts new");
    expect(text).not.toContain("Rewritten");
    expect(text).not.toContain("bar");
  });
});
