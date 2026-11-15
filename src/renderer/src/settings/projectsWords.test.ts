import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import { PROJECT_ROW_WORDS, projectRowWords } from "./projectsWords";

// INF-1495, the captain's approved direction A: a closed project row says only
// what differs from a new project. The rows below are the shapes the captain's
// own Settings -> Projects showed when they asked for a cleaner tab.
const FOLDER = "/Users/kunchen/Library/Application Support/infinitary/fleet";

const cloned: RepoView = {
  id: "repo-infinitary",
  name: "infinitary",
  path: `${FOLDER}/infinitary`,
  setupKind: "clone",
  kind: "project",
  origin: "https://github.com/infinitary-labs/infinitary.git",
  host: { kind: "github", name: "github.com" },
  delivery: "direct-pr",
  autonomy: false,
  rigor: "standard",
  runsOn: AUTOMATIC_COMPUTER,
};

describe("projectRowWords", () => {
  it("says nothing for a project set up the way a new cloned one is", () => {
    expect(projectRowWords(cloned, FOLDER, "automatically")).toEqual([]);
    expect(projectRowWords({ ...cloned, rigor: null }, FOLDER, null)).toEqual([]);
  });

  it("names each way a project differs, in the row's order", () => {
    const infra = {
      ...cloned,
      path: `${FOLDER}/infinitary-infra`,
      delivery: "local-only" as const,
      autonomy: true,
      rigor: "reviewed" as const,
      runsOn: "device-mini",
    };
    expect(projectRowWords(infra, FOLDER, "on Mac mini")).toEqual([
      PROJECT_ROW_WORDS.localMerge,
      PROJECT_ROW_WORDS.mergesOnItsOwn,
      PROJECT_ROW_WORDS.careful,
      PROJECT_ROW_WORDS.runs("on Mac mini"),
    ]);
    expect(projectRowWords({ ...cloned, rigor: "quick" }, FOLDER, null)).toEqual([
      PROJECT_ROW_WORDS.quick,
    ]);
    // INF-2114: Require pull request checks off is a way the project differs.
    expect(projectRowWords({ ...cloned, noChecks: { at: 1 } }, FOLDER, null)).toEqual([
      PROJECT_ROW_WORDS.noChecks,
    ]);
    // A plain Git host runs no checks at all, so its row has nothing to say about them.
    const plain = { ...cloned, host: { kind: "git" as const, name: "git.example.org" } };
    expect(projectRowWords({ ...plain, noChecks: { at: 1 } }, FOLDER, null)).toEqual([]);
  });

  it("calls a project outside the projects folder linked, and one beside it by name is not inside", () => {
    expect(projectRowWords({ ...cloned, path: "/Users/kunchen/code/notes" }, FOLDER, null)).toEqual(
      [PROJECT_ROW_WORDS.linked],
    );
    expect(projectRowWords({ ...cloned, path: `${FOLDER}-old/infinitary` }, FOLDER, null)).toEqual([
      PROJECT_ROW_WORDS.linked,
    ]);
    // Until the folder is read, nothing is called linked.
    expect(projectRowWords({ ...cloned, path: "/Users/kunchen/code/notes" }, null, null)).toEqual(
      [],
    );
  });

  it("reads the personal workspace as building in place and nothing else", () => {
    const personal = {
      ...cloned,
      kind: "personal" as const,
      path: `${FOLDER}/personal`,
      origin: null,
      delivery: "local-only" as const,
      autonomy: true,
      runsOn: null,
    };
    expect(projectRowWords(personal, FOLDER, null)).toEqual([PROJECT_ROW_WORDS.personal]);
  });
});
