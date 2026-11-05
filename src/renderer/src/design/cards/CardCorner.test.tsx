import { CARD_LEAVE, type CardLeaveKind, cardCornerOf } from "@shared/cardLeave";
import { parseDocument } from "htmlparser2";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CardCorner, CardSizeContext } from "./CardSize";

// INF-1879: every registered view has one leaving control, always a minus, with its owner's words.
for (const kind of Object.keys(CARD_LEAVE) as CardLeaveKind[]) {
  it(`${kind}: renders exactly one leaving control with the table's words`, () => {
    const words = cardCornerOf(kind, "INF-42");
    const root = parseDocument(
      renderToStaticMarkup(
        <CardSizeContext.Provider value={{ maximized: false, toggle: () => {}, corner: words }}>
          <CardCorner />
        </CardSizeContext.Provider>,
      ),
    );
    const controls: { attribs: Record<string, string>; children: unknown[] }[] = [];
    type Node = { name?: string; attribs?: Record<string, string>; children?: Node[] };
    const walk = (node: Node) => {
      if (node.name === "button" && node.attribs?.["data-card-leave"] !== undefined)
        controls.push(node as { attribs: Record<string, string>; children: unknown[] });
      for (const child of node.children ?? []) walk(child);
    };
    walk(root as unknown as Node);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.attribs["aria-label"]).toBe(words.label);
    expect(controls[0]?.attribs["aria-description"]).toBe(words.restWords);
    const paths: string[] = [];
    const readPaths = (node: Node | undefined) => {
      if (!node) return;
      if (node.name === "path") paths.push(node.attribs?.d ?? "");
      for (const child of node.children ?? []) readPaths(child);
    };
    readPaths(controls[0] as Node | undefined);
    expect(paths).toEqual(["M5 12h14"]);
  });
}
