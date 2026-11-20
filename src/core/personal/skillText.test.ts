import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCrewmateSystemPrompt, FIRSTMATE_PROMPT_CORE } from "../pi/piResources";
import { CARD_AUTHORING, CARD_MECHANICS } from "../prompts/cardContract";
import { PERSONAL_AGENTS_MD } from "./seed/agentsMd";
import { readAuthoringSkill, skillSentences } from "./skillText";
import { AUTHORING_SKILL_IDS } from "./workspaceSkills";

const REPO_ROOT = join(__dirname, "../../..");

/**
 * The panel authoring rules have ONE home: the skills in the workspace. A
 * persona prompt that restated them would drift from them, and the crewmate
 * would be told two different things about the same panel.
 */
describe("the authoring skills have one home", () => {
  const sentences = AUTHORING_SKILL_IDS.flatMap((id) =>
    skillSentences(readAuthoringSkill(REPO_ROOT, id)).map((sentence) => ({ id, sentence })),
  );

  it("splits every skill into rules worth pinning", () => {
    expect(sentences.length).toBeGreaterThan(60);
    for (const id of AUTHORING_SKILL_IDS) {
      expect(sentences.filter((entry) => entry.id === id).length, id).toBeGreaterThan(5);
    }
  });

  it("no persona prompt and no card contract repeats one of them", () => {
    const prompts = [
      FIRSTMATE_PROMPT_CORE,
      CARD_AUTHORING,
      CARD_MECHANICS,
      buildCrewmateSystemPrompt(),
      buildCrewmateSystemPrompt("pi"),
      buildCrewmateSystemPrompt("claude"),
    ];
    for (const prompt of prompts) {
      for (const { id, sentence } of sentences) {
        expect(prompt, `${id}: ${sentence}`).not.toContain(sentence);
      }
    }
  });

  it("does not restate the workspace's own AGENTS.md, which points at the panel skill", () => {
    // The two are seeded side by side. The personal-panel skill is the one
    // copy of a panel's shape, compiler list and store API, and of its look.
    // AGENTS.md keeps the common workspace rules and points there. A rule in
    // both would drift in one.
    for (const { id, sentence } of sentences) {
      expect(PERSONAL_AGENTS_MD, `${id}: ${sentence}`).not.toContain(sentence);
    }
    for (const sentence of skillSentences(PERSONAL_AGENTS_MD)) {
      for (const id of AUTHORING_SKILL_IDS) {
        expect(readAuthoringSkill(REPO_ROOT, id), `${id}: ${sentence}`).not.toContain(sentence);
      }
    }
  });

  it("keeps the panel rules out of the prompts by vocabulary too", () => {
    // The words a prompt would have to use to restate the skill. The panel
    // vocabulary reaches the crewmate through the workspace, never a persona.
    for (const prompt of [
      FIRSTMATE_PROMPT_CORE,
      CARD_AUTHORING,
      CARD_MECHANICS,
      buildCrewmateSystemPrompt("pi"),
    ]) {
      expect(prompt).not.toContain("@infinitary/ui");
      expect(prompt).not.toContain("@firstmate/ui");
      expect(prompt).not.toContain("panel.tsx");
      expect(prompt).not.toContain("lint_panel");
    }
  });
});
