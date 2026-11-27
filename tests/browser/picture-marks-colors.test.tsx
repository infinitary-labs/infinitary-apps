import { COLOR_THEME_ATTRIBUTE, COLOR_THEME_SHEET } from "@shared/colorThemes";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { useMarkLook } from "../../src/renderer/src/design/cards/PictureMarks";

/**
 * The color themes plan (INF-6888, part 2): asking again under a theme's name
 * changes that theme, and still drawings follow its colors. A person's own
 * theme saved again keeps its id, so only the window's theme sheet changes:
 * a picture's marks must be drawn again in the new accent. The accents are
 * the old green terminal's and its sky blue change.
 */
const GREEN = "#8dff9c";
const BLUE = "#7fd6ff";

function Ink() {
  return <span data-ink>{useMarkLook().ink}</span>;
}

/** Lays an own theme as the window does: its rule in the sheet, put last in the head again. */
function lay(accent: string) {
  let sheet = document.getElementById(COLOR_THEME_SHEET.id);
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = COLOR_THEME_SHEET.id;
  }
  document.head.append(sheet);
  sheet.textContent = `body { --accent: ${accent}; }`;
}

test("a picture's marks follow an own theme saved again under its name", async () => {
  document.body.dataset.theme = "dark";
  document.body.setAttribute(COLOR_THEME_ATTRIBUTE, "own-old-terminal");
  lay(GREEN);
  const holder = document.createElement("div");
  document.body.append(holder);
  const root = createRoot(holder);
  try {
    await act(async () => root.render(<Ink />));
    const ink = () => holder.querySelector("[data-ink]")?.textContent;
    expect(ink()).toBe(GREEN);
    await act(async () => lay(BLUE));
    await expect.poll(ink).toBe(BLUE);
  } finally {
    act(() => root.unmount());
    holder.remove();
    document.getElementById(COLOR_THEME_SHEET.id)?.remove();
    document.body.removeAttribute(COLOR_THEME_ATTRIBUTE);
  }
});
