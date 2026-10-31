import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeBinding } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type RunbookFacts, runbookMatches } from "../../shared/runbooks";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { createCrewmateResourceLoader } from "../pi/piResourceLoader";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { requireConventional } from "../workspace/conventional";
import { Runbooks, stageRunbookSkills } from "./runbooks";

const root = join(__dirname, "../../../resources/runbooks");
const code: RunbookFacts = {
  kind: "implement",
  place: "project",
  delivery: "direct-pr",
  care: "standard",
  backend: "pi",
  project: "infinitary",
};
function fixture() {
  const db = openInMemoryDatabase();
  const settings = new SettingsStore(db);
  return { db, settings, books: new Runbooks(root, settings) };
}
// Intent: the captain's accepted INF-1177 settings; the fixtures are the actual bundled procedures.
describe("runbooks over existing prompt and skill doors", () => {
  it("starts every bundled runbook on and persists an individual switch without taking programs away", () => {
    const { db, books } = fixture();
    expect(books.list()).toHaveLength(8);
    expect(books.list().every((book) => book.enabled)).toBe(true);
    const before = books.firstmate();
    books.set("sequences", false);
    const reopened = new Runbooks(root, new SettingsStore(db));
    expect(reopened.list().find((book) => book.id === "sequences")?.enabled).toBe(false);
    const after = reopened.firstmate();
    expect(after.sha).not.toBe(before.sha);
    expect(after.text).not.toContain("# Common workflows");
    expect(after.text).toContain("# Programs");
    reopened.set("sequences", true);
    expect(reopened.firstmate()).toEqual(before);
    expect(() => reopened.set("missing", false)).toThrow("not available");
  });
  it("serves the operation line, and Casual projects names where its skip rule lives rather than a place", () => {
    // Intent: INF-1865. The move into runbooks dropped the operation line docs/sequences.md
    // ("Operations") describes, and Casual projects, served first, pointed to a skip rule "above".
    const { books } = fixture();
    const served = books.firstmate().text;
    const workflows = served.slice(served.indexOf("# Common workflows"));
    expect(workflows).toContain(
      "An effect, not code, is an operation: declare operation. Code chores remain changes.",
    );
    expect(workflows).toContain("Skip the plan only when");
    const start = served.indexOf("# Casual projects");
    const casual = served.slice(start, served.indexOf("\n# ", start)).replace(/\s+/g, " ");
    expect(casual).toContain("Plan skipping follows the Common workflows skip rule.");
    expect(casual).not.toMatch(/\b(above|below)\b/);
  });
  it("copies editable guidance off, replaces the built-in on request and keeps both across restart", () => {
    // Intent: INF-1177 piece 4, using the actual bundled Common workflows.
    const { db, settings } = fixture();
    const personal = join(scratchDir("inf-personal-runbooks-"), "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    const original = books.firstmate();
    books.copy("sequences", "my-workflows", "My workflows");
    const path = books.list().find((book) => book.id === "my-workflows")?.path;
    expect(path).toBe(join(personal, "my-workflows"));
    if (!path) throw new Error("The copy did not return its editable path.");
    const manifest = JSON.parse(readFileSync(join(path, "runbook.json"), "utf8"));
    expect(manifest.replaces).toBe("sequences");
    const guide = join(path, manifest.firstmate);
    const copied = readFileSync(guide, "utf8");
    expect(copied).toBe(readFileSync(join(root, "sequences", manifest.firstmate), "utf8"));
    expect(books.list().find((book) => book.id === "my-workflows")?.enabled).toBe(false);
    expect(books.firstmate()).toEqual(original);
    writeFileSync(guide, copied.replace("# Common workflows", "# My workflows"));
    books.set("my-workflows", true);
    expect(books.firstmate().text).toContain("# My workflows");
    expect(books.firstmate().text).not.toContain("# Common workflows");
    expect(books.list().find((book) => book.id === "sequences")?.enabled).toBe(false);
    const reopened = new Runbooks(root, new SettingsStore(db), () => [], personal);
    expect(reopened.firstmate()).toEqual(books.firstmate());
    writeFileSync(guide, copied.replace("# Common workflows", "# Edited workflows"));
    expect(reopened.firstmate().text).toContain("# Edited workflows");
    reopened.set("my-workflows", false);
    reopened.set("sequences", true);
    expect(reopened.firstmate()).toEqual(original);
    expect(readFileSync(guide, "utf8")).toContain("# Edited workflows");
  });
  it("copies the bundled lesson skills and tested parts into an editable runbook", () => {
    // Intent: INF-1177 piece 4 and the captain's repair request: the real Lessons copy passes unchanged admission.
    const { settings } = fixture();
    const personal = join(scratchDir("inf-personal-lesson-runbook-"), "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    books.copy("lessons", "my-lessons", "My lessons");
    expect(readFileSync(join(personal, "my-lessons/skills/lessons/parts/quiz.html"), "utf8")).toBe(
      readFileSync(join(root, "lessons/skills/lessons/parts/quiz.html"), "utf8"),
    );
    books.set("my-lessons", true);
    const skill = books.crew(code).skills.find((skill) => skill.name === "lessons");
    expect(skill).toBeDefined();
    expect(skill?.files["parts/quiz.html"]).toBeDefined();
    expect(Object.keys(skill?.files ?? {}).some((path) => /\.tsx?$/.test(path))).toBe(false);
  });
  it("never overwrites personal folders, accepts an escaping id or follows a linked copy root", () => {
    // Intent: copy and edit keeps the captain's work intact; the actual bundle is the copy source.
    const { settings } = fixture();
    const workspace = scratchDir("inf-runbook-copy-collision-");
    const personal = join(workspace, "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    expect(() => books.copy("missing", "mine", "Mine")).toThrow("built-in");
    expect(() => books.copy("sequences", "../escape", "Mine")).toThrow();
    expect(existsSync(join(workspace, "escape"))).toBe(false);
    expect(() => books.copy("sequences", "programs", "Mine")).toThrow("already in use");
    mkdirSync(join(personal, "unfinished"), { recursive: true });
    writeFileSync(join(personal, "unfinished/guide.md"), "Unfinished personal work");
    expect(() => books.copy("sequences", "unfinished", "Mine")).toThrow();
    expect(readFileSync(join(personal, "unfinished/guide.md"), "utf8")).toBe(
      "Unfinished personal work",
    );
    const linked = join(workspace, "linked");
    symlinkSync(personal, linked, "dir");
    expect(() =>
      new Runbooks(root, settings, () => [], linked).copy("sequences", "mine", "Mine"),
    ).toThrow("plain folder");
    expect(existsSync(join(personal, "mine"))).toBe(false);
  });
  it("serves testing only to the accepted project kinds on either backend", () => {
    const { books } = fixture();
    const passage = (
      JSON.parse(readFileSync(join(root, "testing/crew.json"), "utf8")) as string
    ).trim();
    for (const backend of ["pi", "claude"]) {
      for (const kind of ["plan", "reproduce", "implement", "fix", "chore"])
        expect(books.crew({ ...code, kind, backend }).text).toContain(passage);
      for (const kind of ["research", "retrieval", "review", "teach", "unclear"])
        expect(books.crew({ ...code, kind, backend }).text).not.toContain(passage);
      expect(books.crew({ ...code, place: "personal", backend }).text).not.toContain(passage);
    }
    books.set("testing", false);
    expect(books.crew(code).text).not.toContain(passage);
  });
  it("serves each care its own sections from one manifest with several selectors (INF-1876)", () => {
    // Intent: the host knows the three care names as typed facts; what each
    // asks is the care runbook's. Default and Careful share the Default
    // section, Careful adds its own, Quick has its own sentence, and a task
    // with no care is served none.
    const { books, db } = fixture();
    const section = (file: string) =>
      (JSON.parse(readFileSync(join(root, `care/${file}`), "utf8")) as string).trim();
    for (const backend of ["pi", "claude"]) {
      const quick = books.crewSections({ ...code, backend, care: "quick" });
      expect(quick).toContain(section("quick.json"));
      expect(quick).not.toContain(section("default.json"));
      expect(quick).not.toContain(section("careful.json"));
      const standard = books.crewSections({ ...code, backend, care: "standard" });
      expect(standard).toContain(section("default.json"));
      expect(standard).not.toContain(section("quick.json"));
      expect(standard).not.toContain(section("careful.json"));
      const careful = books.crewSections({ ...code, backend, care: "reviewed" });
      expect(careful).toContain(section("default.json"));
      expect(careful).toContain(section("careful.json"));
      expect(careful.indexOf(section("default.json"))).toBeLessThan(
        careful.indexOf(section("careful.json")),
      );
      const none = books.crewSections({ ...code, backend, care: "none" });
      for (const file of ["quick.json", "default.json", "careful.json"])
        expect(none).not.toContain(section(file));
    }
    // The skill travels with the runbook, and the first mate reads its guide.
    expect(books.crew(code).skills.map((skill) => skill.name)).toContain("careful-change");
    expect(books.firstmate().text).toContain("# Care levels");
    books.set("care", false);
    const off = new Runbooks(root, new SettingsStore(db));
    expect(off.crew({ ...code, care: "reviewed" }).text).not.toContain(section("careful.json"));
    expect(off.crew(code).skills.map((skill) => skill.name)).not.toContain("careful-change");
  });
  it("serves delivery judgment only to direct-pr crew, and its switch removes it", () => {
    const { books, db } = fixture();
    const passage = (
      JSON.parse(readFileSync(join(root, "delivery/crew.json"), "utf8")) as string
    ).trim();
    for (const backend of ["pi", "claude"]) {
      expect(books.crew({ ...code, backend }).text).toContain(passage);
      expect(books.crew({ ...code, backend, delivery: "local-only" }).text).not.toContain(passage);
    }
    expect(books.firstmate().text).not.toContain(passage);
    books.set("delivery", false);
    expect(new Runbooks(root, new SettingsStore(db)).crew(code).text).not.toContain(passage);
  });
  it("removes delivery judgments from actual crew prompts on both backends without removing consent", () => {
    const { books } = fixture();
    const cwd = scratchDir("inf-delivery-prompt-");
    for (const backend of ["pi", "claude"] as const) {
      const binding = backend === "pi" ? fakeBinding("test") : { backend, accountId: "test" };
      const prompt = () =>
        crewmateSessionSpec(
          appPathsFor(cwd),
          {
            taskId: "delivery",
            machineId: "local",
            cwd,
            runbookText: books.crew({ ...code, backend }).text,
            procedure: { delivery: "direct-pr", rigor: "standard" },
          },
          binding,
        ).instructions.base;
      expect(prompt()).toContain("Up to three unsuccessful own repairs");
      books.set("delivery", false);
      expect(prompt()).not.toContain("Up to three unsuccessful own repairs");
      expect(prompt()).not.toContain("Never emit a completion decision on anything but green");
      expect(prompt()).toContain("The completion offer never grants merge permission");
      expect(prompt()).toContain("Before anything sensitive or costly");
      books.set("delivery", true);
    }
  });
  it("matches every declared axis without judging words", () => {
    expect(
      runbookMatches(
        {
          project: ["infinitary"],
          backend: ["pi"],
          kind: ["implement"],
          place: ["project"],
          delivery: ["direct-pr"],
          care: ["standard"],
        },
        code,
      ),
    ).toBe(true);
    for (const key of ["project", "backend", "kind", "place", "delivery", "care"] as const)
      expect(runbookMatches({ [key]: [] }, code)).toBe(false);
    expect(runbookMatches(undefined, code)).toBe(true);
  });
  it("serves naming to agents and the host from the same enabled manifest", () => {
    const { books } = fixture();
    expect(requireConventional("feat(runbooks): add guidance", "title", books.naming())).toContain(
      "guidance",
    );
    expect(() => requireConventional("a plain title", "title", books.naming())).toThrow(
      "conventional name",
    );
    books.set("naming", false);
    expect(requireConventional("a plain title", "title", books.naming())).toBe("a plain title");
    expect(books.crew(code).text).not.toContain("Name every commit subject");
    expect(books.firstmate().text).not.toContain("Name every commit subject");
  });
  it("materializes actual lesson skills and HTML parts on the running computer, and off removes their reach", async () => {
    const { books } = fixture();
    const skills = books.crew(code).skills;
    const staged = await stageRunbookSkills(skills, join(scratchDir("inf-runbooks-"), "skills"));
    const lesson = staged.find((skill) => skill.name === "lessons");
    expect(lesson).toBeDefined();
    expect(readFileSync(join(lesson?.dir ?? "", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(root, "lessons/skills/lessons/SKILL.md"), "utf8"),
    );
    expect(readFileSync(join(lesson?.dir ?? "", "parts/quiz.html"), "utf8")).toBe(
      readFileSync(join(root, "lessons/skills/lessons/parts/quiz.html"), "utf8"),
    );
    books.set("lessons", false);
    // A skill rides its runbook, not a care: the care runbook's stays.
    expect(books.crew(code).skills.map((skill) => skill.name)).toEqual(["careful-change"]);
  });
  it("puts only the matched section in the actual crew preset on both backends", () => {
    const { books } = fixture();
    const root = scratchDir("inf-runbook-prompt-");
    for (const backend of ["pi", "claude"] as const) {
      const binding = backend === "pi" ? fakeBinding("test") : { backend, accountId: "test" };
      const prompt = (kind: string) =>
        crewmateSessionSpec(
          appPathsFor(root),
          {
            taskId: "task-1",
            machineId: "local",
            cwd: root,
            runbookText: books.crew({ ...code, kind, backend }).text,
            procedure: { delivery: "local-only", rigor: "quick" },
          },
          binding,
        ).instructions.base;
      expect(prompt("implement")).toContain("Tests follow six words:");
      expect(prompt("research")).not.toContain("Tests follow six words:");
      books.set("testing", false);
      books.set("naming", false);
      expect(prompt("implement")).not.toContain("Tests follow six words:");
      expect(prompt("implement")).not.toContain("Name every commit subject");
      books.set("testing", true);
      books.set("naming", true);
    }
  });
  it("keeps project then personal skills ahead of runbook skills in the Pi resource door", async () => {
    const { books } = fixture();
    const cwd = scratchDir("inf-runbook-roots-");
    const files = books.crew(code).skills;
    const runbookSkills = await stageRunbookSkills(files, join(cwd, "runbooks"));
    const personalSkills = await stageRunbookSkills(files, join(cwd, "personal"));
    const personal = { skills: personalSkills, digests: { instructions: null, skills: "" } };
    const loader = createCrewmateResourceLoader("base", undefined, {
      cwd,
      personal,
      runbookSkills,
    });
    await loader.reload();
    expect(loader.getSkills().skills.find((skill) => skill.name === "lessons")?.filePath).toBe(
      join(cwd, "personal/lessons/SKILL.md"),
    );
    await stageRunbookSkills(files, join(cwd, ".claude/skills"));
    await loader.reload();
    expect(loader.getSkills().skills.find((skill) => skill.name === "lessons")?.filePath).toBe(
      join(cwd, ".claude/skills/lessons/SKILL.md"),
    );
  });
});
