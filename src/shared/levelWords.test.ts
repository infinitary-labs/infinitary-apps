import { expect, it } from "vitest";
import { levelList, levelName, levelWord } from "./levelWords";
import { SLOTS } from "./modelSlots";
import { reasoningSchema, reasoningWord } from "./reasoning";

// INF-3961's answer, approved by the captain: people read a level's old
// words (High, Medium, Low) as the reasoning, so a level is named by how hard
// the task is. No level word may be one the reasoning also uses.
it("names every level with a word the reasoning never uses", () => {
  const reasoning = reasoningSchema.shape.level.options.map((level) =>
    reasoningWord({ level }).toLowerCase(),
  );
  for (const slot of SLOTS) {
    expect(reasoning).not.toContain(levelWord(slot).toLowerCase());
    expect(reasoning).not.toContain(levelName(slot));
    expect(levelList([slot])).not.toMatch(/\b(low|medium|high)\b/);
  }
});
