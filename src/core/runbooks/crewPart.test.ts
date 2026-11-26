import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppTools } from "../pi/appTools";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { Runbooks } from "./runbooks";

const root = join(__dirname, "../../../resources/runbooks");

function appState(runbooks?: Runbooks) {
  const tool = createAppTools({
    dispatch: () => {
      throw new Error("The runbook read asks no core request.");
    },
    actor: () => ({ kind: "firstmate", wake: "captain" }),
    ...(runbooks ? { runbooks } : {}),
  }).find((candidate) => candidate.name === "app_state");
  if (!tool) throw new Error("Missing app_state");
  return async (args: unknown) => (await tool.run({ read: "runbooks.crew", args })).text;
}

// Intent: INF-6749's finding 4, which the captain chose to build - the first
// mate answered a question about the architecture runbook from its own
// section alone, so it can read a runbook's crew part on request.
describe("the first mate's read of a runbook's crew part", () => {
  it("answers the architecture runbook's crew section whole, with its selector and skill, while it is off", async () => {
    const books = new Runbooks(root, new SettingsStore(openInMemoryDatabase()));
    const answer = JSON.parse(await appState(books)({ runbook: "Advanced architecture" }));
    expect(answer).toEqual({
      read: "runbooks.crew",
      value: {
        id: "architecture",
        name: "Advanced architecture",
        enabled: false,
        sections: [
          {
            when: { kind: ["implement", "fix", "chore"], place: ["project"] },
            text: readFileSync(join(root, "architecture/crew.md"), "utf8").trim(),
          },
        ],
        skills: ["advanced-architecture"],
      },
    });
  });

  it("reads by id every crew section of a runbook that has several, a JSON section's text included", async () => {
    const books = new Runbooks(root, new SettingsStore(openInMemoryDatabase()));
    const { value } = JSON.parse(await appState(books)({ runbook: "care" }));
    expect(value.name).toBe("Rigor levels");
    expect(value.enabled).toBe(true);
    expect(value.sections.map((section: { when: unknown }) => section.when)).toEqual([
      { care: ["quick"] },
      { care: ["standard", "reviewed"] },
      { care: ["reviewed"] },
      { kind: ["review"] },
    ]);
    expect(value.sections[0].text).toBe(
      JSON.parse(readFileSync(join(root, "care/quick.json"), "utf8")).trim(),
    );
  });

  it("names the runbooks there are for a name that is not one, and says when none are connected", async () => {
    const books = new Runbooks(root, new SettingsStore(openInMemoryDatabase()));
    const missing = await appState(books)({ runbook: "Architecture review" });
    expect(missing).toMatch(
      /^The read runbooks\.crew could not answer: No runbook "Architecture review"\./,
    );
    expect(missing).toContain("Advanced architecture (architecture)");
    expect(await appState()({ runbook: "architecture" })).toBe(
      "The read runbooks.crew could not answer: Runbooks are not connected.",
    );
  });
});
