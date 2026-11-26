import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appearanceSchema, DEFAULT_APPEARANCE, DEFAULT_LAYOUT } from "@shared/preferences";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { JoinedHome } from "./joinedHome";

// The color themes plan (INF-6888, part 1): a window that controls another
// computer keeps its own look, color theme included, and an older version
// reading the same settings shows plain Dark or Light and loses nothing.
// An older version reads appearance.json with a strict look that has no
// color theme, so the theme lives in a file of its own beside it.
const olderLook = appearanceSchema.omit({ colorTheme: true });

it("keeps a window's color theme beside its look, where an older version still reads the look", () => {
  const dir = scratchDir("joined-color-theme-");
  const joined = new JoinedHome(dir);
  joined.setLook({
    appearance: { ...DEFAULT_APPEARANCE, theme: "dark", colorTheme: "dracula", size: 125 },
    layout: DEFAULT_LAYOUT,
  });

  expect(joined.look()?.appearance).toMatchObject({ theme: "dark", colorTheme: "dracula" });
  const saved = JSON.parse(readFileSync(join(dir, "appearance.json"), "utf8"));
  expect(olderLook.safeParse(saved.appearance).success).toBe(true);
  expect(saved.appearance).toMatchObject({ theme: "dark", size: 125 });

  // An older version switches the window to Light: the base wins, and the theme does not show.
  writeFileSync(
    join(dir, "appearance.json"),
    JSON.stringify({ ...saved, appearance: { ...saved.appearance, theme: "light" } }),
  );
  expect(joined.look()?.appearance).toMatchObject({ theme: "light", size: 125 });
  expect(joined.look()?.appearance).not.toHaveProperty("colorTheme");

  // Picking Dark or Light here is a look with no color theme.
  joined.setLook({ appearance: { ...DEFAULT_APPEARANCE, theme: "dark" }, layout: DEFAULT_LAYOUT });
  expect(joined.look()?.appearance).not.toHaveProperty("colorTheme");
});
