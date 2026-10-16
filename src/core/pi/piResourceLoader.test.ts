import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createCrewmateResourceLoader } from "./piResourceLoader";
import { buildCrewmateSystemPrompt } from "./piResources";

it("serves only the supplied prompt and live appended instructions, with a private empty runtime, when it has no working copy", async () => {
  let appended: string | undefined = "captain's first instruction";
  const first = createCrewmateResourceLoader("base prompt", () => appended);
  const second = createCrewmateResourceLoader();
  expect(first.getSystemPrompt()).toBe("base prompt");
  expect(second.getSystemPrompt()).toBe(buildCrewmateSystemPrompt());
  expect(first.getAppendSystemPrompt()).toEqual(["captain's first instruction"]);
  appended = "captain's new instruction";
  await first.reload();
  expect(first.getAppendSystemPrompt()).toEqual([appended]);
  appended = undefined;
  expect(first.getAppendSystemPrompt()).toEqual([]);
  expect(first.getExtensions()).toMatchObject({ extensions: [], errors: [] });
  expect(first.getExtensions().runtime).not.toBe(second.getExtensions().runtime);
  expect(first.getAgentsFiles()).toEqual({ agentsFiles: [] });
  for (const resources of [first.getSkills(), first.getPrompts(), first.getThemes()]) {
    expect(resources.diagnostics).toEqual([]);
  }
  expect(first.getSkills().skills).toEqual([]);
  expect(first.getPrompts().prompts).toEqual([]);
  expect(first.getThemes().themes).toEqual([]);
});

it("serves a working copy's instruction file and skills as they stand at each reload", async () => {
  const cwd = scratchDir("infinitary-loader-project-");
  const loader = createCrewmateResourceLoader("base prompt", undefined, { cwd });
  await loader.reload();
  expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
  expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
  writeFileSync(join(cwd, "CLAUDE.md"), "Count rivets alone.\n");
  mkdirSync(join(cwd, ".claude", "skills", "rivets"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "skills", "rivets", "SKILL.md"),
    "---\nname: rivets\ndescription: How rivets are counted.\n---\nCount them.\n",
  );
  // Nothing is read until Pi asks the loader to reload.
  expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
  await loader.reload();
  expect(loader.getAgentsFiles()).toEqual({
    agentsFiles: [{ path: join(cwd, "CLAUDE.md"), content: "Count rivets alone.\n" }],
  });
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["rivets"]);
  writeFileSync(join(cwd, "AGENTS.md"), "﻿Count rivets in pairs.\n");
  await loader.reload();
  expect(loader.getAgentsFiles()).toEqual({
    agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: "Count rivets in pairs.\n" }],
  });
});
