import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoSetupSpec, RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ProjectSetups } from "./projectSetups";

/**
 * The first mate's adopt proposal for a folder (docs/fleet.md, "A folder that
 * is not there"): a relative path reads from the home folder, and a folder
 * that is not there is refused with the folders of a similar name and the
 * Choose folder card to ask on, before anything is checked or carded.
 */
describe("a proposed folder", () => {
  const proposer = (home: string, managed: Pick<RepoView, "id" | "name" | "path">[] = []) => {
    const checked: RepoSetupSpec[] = [];
    const cards: string[] = [];
    const project = new ProjectSetups({
      repos: {
        check: async (spec) => {
          checked.push(spec);
          return { name: "meter", origin: null, host: null, startsGit: false };
        },
        batchesOffered: () => false,
        list: () => managed as RepoView[],
      },
      devices: () => [],
      raiseCard: (card) => cards.push(card.id),
      tell: () => undefined,
      broadcast: () => undefined,
      home,
    });
    return { setups: project, checked, cards };
  };

  it("reads a relative path from the home folder", async () => {
    const home = scratchDir("infinitary-setup-home-");
    const meter = join(home, "github", "octo", "meter");
    mkdirSync(meter, { recursive: true });
    const { setups, checked, cards } = proposer(home);
    const answer = await setups.propose({ kind: "adopt", path: "github/octo/meter" });
    expect(checked).toEqual([{ kind: "adopt", path: meter }]);
    expect(cards).toEqual([answer.cardId]);
  });

  it("refuses a folder that is not there with the folders of a similar name and Choose folder", async () => {
    const home = scratchDir("infinitary-setup-home-");
    const meter = join(home, "github", "octo", "meter");
    mkdirSync(meter, { recursive: true });
    const managedPath = join(home, "projects", "meter-web");
    mkdirSync(managedPath, { recursive: true });
    const { setups, checked, cards } = proposer(home, [
      { id: "repo-meter-web", name: "meter-web", path: managedPath },
    ]);
    const missing = join(home, "code", "meter");
    const refusal = await setups.propose({ kind: "adopt", path: missing }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(refusal).toContain(`No folder exists at ${missing}.`);
    expect(refusal).toContain(`- ${meter}\n`);
    expect(refusal).toContain(
      `- ${managedPath} (already one of the captain's projects, repo_id repo-meter-web)`,
    );
    expect(refusal).toContain(
      "Choose folder action (effect kind open, target projects, folder true)",
    );
    expect(checked).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("offers Choose folder alone when no folder has a similar name", async () => {
    const home = scratchDir("infinitary-setup-home-");
    const { setups } = proposer(home);
    await expect(setups.propose({ kind: "adopt", path: "~/meter" })).rejects.toThrow(
      `No folder exists at ${join(home, "meter")}, and no folder with a similar name was found.`,
    );
  });
});
