import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import {
  buildPrototypeSrcdoc,
  CARD_CHANGES_STYLE,
  cardBodyMarkup,
  cardBodyMounts,
} from "./prototypeSrcdoc";

type Node = { name?: string; attribs?: Record<string, string>; children?: Node[] };

function elements(html: string): Node[] {
  const found: Node[] = [];
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.name) found.push(node);
      walk(node.children ?? []);
    }
  };
  walk(parseDocument(html).children as unknown as Node[]);
  return found;
}

describe("cardBodyMarkup", () => {
  const body =
    '<p style="color:var(--fg-1)">Kept.</p><p>New.</p><table><tr><td>a</td></tr><tr><td>new row</td></tr></table>';
  const marks = [body.indexOf("<p>New"), body.lastIndexOf("<tr>")];

  it("marks each new part's own tag and anchors one bar to it", () => {
    const { html, marked } = cardBodyMarkup(body, marks);
    expect(marked).toBe(true);
    const all = elements(html);
    const parts = all.filter((node) => node.attribs?.["data-inf-changed"] !== undefined);
    expect(parts.map((node) => node.name)).toEqual(["p", "tr"]);
    // The author's own attributes are untouched: the anchor names ride a style block.
    expect(all.find((node) => node.name === "p")?.attribs?.style).toBe("color:var(--fg-1)");
    const bars = all.filter((node) => node.attribs?.["data-inf-bar"] !== undefined);
    expect(bars).toHaveLength(2);
    const anchors = parts.map((node) => `--fm-new-${node.attribs?.["data-inf-changed"]}`).sort();
    expect(bars.map((bar) => bar.attribs?.style?.replace("position-anchor:", "")).sort()).toEqual(
      anchors,
    );
    for (const anchor of anchors) expect(html).toContain(`anchor-name:${anchor}`);
  });

  it("keeps revision markers separate from author New tags on every part kind", () => {
    const body =
      "<h3>Heading</h3><p>Paragraph</p><ul><li>Item</li></ul><table><tr><td>Cell</td></tr></table><figure>Drawing</figure><figure data-inf-new>New view</figure>";
    const marks = [...body.matchAll(/<(?:h3|p|li|tr|figure)\b/g)].map((match) => match.index);
    const all = elements(cardBodyMarkup(body, marks).html);
    const changed = all.filter((node) => node.attribs?.["data-inf-changed"] !== undefined);
    expect(changed.map((node) => node.name)).toEqual(["h3", "p", "li", "tr", "figure", "figure"]);
    const tagged = all.filter((node) => node.attribs?.["data-inf-new"] !== undefined);
    expect(tagged).toEqual([changed.at(-1)]);
    expect(tagged[0]?.attribs?.["data-inf-new"]).toBe("");
    expect(all.filter((node) => node.attribs?.["data-inf-bar"] !== undefined)).toHaveLength(
      marks.length,
    );
  });

  it("keeps navigation targets but no change bars when no valid mark is supplied", () => {
    const plain = cardBodyMarkup(body);
    expect(plain.marked).toBe(false);
    expect(plain.html.replace(/ data-inf-target="\d+"/g, "")).toBe(body);
    expect(cardBodyMarkup(body, [3])).toEqual(plain);
    // A legacy plain-text body is never marked: its markup is the host's.
    expect(cardBodyMarkup("one\n\ntwo", [0]).marked).toBe(false);
  });

  it("builds a page born held, so its animations wait until the card is shown (FI3-871)", () => {
    expect(buildPrototypeSrcdoc("<p>Plain.</p>", "light")).toContain(
      '<html data-theme="light" data-inf-held>',
    );
  });

  it("carries the bars' style in every card document", () => {
    const document = buildPrototypeSrcdoc(body, "dark", marks);
    expect(document).toContain(CARD_CHANGES_STYLE.trim().split("\n")[0]);
    expect(document).toContain('data-inf-changed="0"');
  });
});

// INF-128's plan, approved by the captain: a body that draws in a project's
// own font rides the mount vehicle, so the font engine reads that file in a
// renderer process of its own; WI-16 mounts a body with its own script.
describe("cardBodyMounts", () => {
  const kept = "app-frame://typefaces/t1-0123456789abcdef0123456789abcdef.woff2";

  it("mounts a body carrying a script, or naming a kept project font", () => {
    expect(cardBodyMounts("<p>A toggle.</p><script>document.body.dataset.on = '1'</script>")).toBe(
      true,
    );
    expect(
      cardBodyMounts(
        `<style>@font-face{font-family:"Wallet";src:url("${kept}") format("woff2")}</style><p>$42.50</p>`,
      ),
    ).toBe(true);
  });

  it("leaves a body on srcdoc when its fonts are the app's own, a web address or not a kept copy", () => {
    expect(cardBodyMounts("<p>Plain prose.</p>")).toBe(false);
    expect(
      cardBodyMounts('<style>.b{font-family:var(--font-mono)}</style><p class="b">42</p>'),
    ).toBe(false);
    expect(
      cardBodyMounts(
        '<style>@font-face{font-family:"W";src:url("https://fonts.example/w.woff2")}</style>',
      ),
    ).toBe(false);
    expect(
      cardBodyMounts('<style>@font-face{src:url("app-frame://typefaces/x.woff2")}</style>'),
    ).toBe(false);
  });
});
