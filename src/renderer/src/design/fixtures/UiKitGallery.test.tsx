import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as ui from "../index";
import { HELPER_EXPORTS, STAGE_ONLY_EXPORTS, UiKitGallery } from "./UiKitGallery";

/**
 * The gallery is the coherence check's subject, so what it leaves out is a
 * decision, not an oversight: a component added to the library is either in
 * the gallery or named as the stage's own furniture.
 */
describe("the coherence gallery", () => {
  it("renders every library export a panel may use", () => {
    const markup = renderToStaticMarkup(createElement(UiKitGallery));
    const shown = [...markup.matchAll(/data-ui-kit-item="([^"]+)"/g)].map((match) => match[1]);
    const expected = Object.keys(ui).filter(
      (name) => !STAGE_ONLY_EXPORTS.includes(name) && !HELPER_EXPORTS.includes(name),
    );
    expect([...shown].sort()).toEqual(expected.sort());
  });

  it("keeps the stage's own furniture off a rail, and helpers that draw nothing out, deliberately", () => {
    for (const name of [...STAGE_ONLY_EXPORTS, ...HELPER_EXPORTS]) {
      expect(Object.keys(ui), name).toContain(name);
    }
  });
});
