import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PERSONAL_FILE_BYTES, personalResources } from "./personalResources";

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
it("reads only the chosen local file and skill folders, honoring order, links, caps and project names", () => {
  const home = scratchDir("fm-personal-home-");
  const empty = personalResources(home);
  expect(empty.instructions).toBeUndefined();
  expect(empty.skills).toEqual([]);
  put(join(home, ".codex", "AGENTS.md"), "codex fallback");
  put(join(home, ".claude", "CLAUDE.md"), "claude fallback");
  put(join(home, "shared.md"), "﻿home winner");
  symlinkSync(join(home, "shared.md"), join(home, "AGENTS.md"));
  for (const root of [".agents", ".claude"]) {
    put(join(home, root, "skills", "same", "SKILL.md"), root);
  }
  put(join(home, ".claude", "skills", "unique", "SKILL.md"), "unique body");
  put(join(home, ".agents", "skills", "oversize", "SKILL.md"), "x".repeat(PERSONAL_FILE_BYTES + 1));
  put(join(home, ".claude", "settings.json"), "not JSON, never read");
  const first = personalResources(home);
  expect(first.instructions).toEqual({ path: join(home, "AGENTS.md"), content: "home winner" });
  expect(first.skills).toEqual([
    { name: "same", dir: join(home, ".agents", "skills", "same") },
    { name: "unique", dir: join(home, ".claude", "skills", "unique") },
  ]);
  expect(personalResources(home).digests).toEqual(first.digests);
  put(join(home, ".agents", "skills", "same", "SKILL.md"), "updated body");
  expect(personalResources(home).digests.skills).not.toBe(first.digests.skills);
  expect(personalResources(home, new Set(["same"])).skills.map((skill) => skill.name)).toEqual([
    "unique",
  ]);
  put(join(home, "shared.md"), "x".repeat(PERSONAL_FILE_BYTES + 1));
  expect(personalResources(home).instructions?.content).toBe("claude fallback");
  rmSync(join(home, ".claude", "CLAUDE.md"));
  expect(personalResources(home).instructions?.content).toBe("codex fallback");
  const otherHome = scratchDir("fm-personal-other-user-");
  put(join(otherHome, "AGENTS.md"), "other Mac's rules");
  expect(personalResources(otherHome).instructions?.content).toBe("other Mac's rules");
  expect(personalResources(otherHome).skills).toEqual([]);
});
