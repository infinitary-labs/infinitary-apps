import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeBinding } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type RunbookFacts, runbookMatches } from "../../shared/runbooks";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { createCrewmateResourceLoader } from "../pi/piResourceLoader";
import { CREWMATE_LOAD_LINE } from "../pi/piResources";
import { CREWMATE_SECRETS_CATALOG_LINE, CREWMATE_SECRETS_LINE } from "../secrets/commandWords";
import { LOCAL_MACHINE_ID } from "../session/session";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { requireConventional } from "../workspace/conventional";
import { BUILTIN_RUNBOOK_ORDER, Runbooks, stageRunbookSkills } from "./runbooks";

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
  // Intent: INF-1981/INF-1988, one common-to-niche order and safe built-in inspection.
  it("orders the real bundle once, including the first mate's joined sections", () => {
    const { books } = fixture();
    expect(new Set(books.builtins().map((book) => book.id))).toEqual(
      new Set(BUILTIN_RUNBOOK_ORDER),
    );
    expect(books.list().map((book) => book.id)).toEqual(BUILTIN_RUNBOOK_ORDER);
    expect(books.list().every((book) => book.source === "builtin")).toBe(true);
    const sections = books
      .builtins()
      .filter((book) => book.firstmate)
      .map((book) => {
        const file = join(root, book.id, book.firstmate ?? "");
        return readFileSync(file, "utf8").trim();
      });
    expect(books.firstmate().text).toBe(sections.join("\n\n"));
    const extra = scratchDir("inf-unplaced-runbook-");
    cpSync(root, extra, { recursive: true });
    const path = join(extra, "lessons/runbook.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, id: "unplaced" }));
    expect(() => new Runbooks(extra, fixture().settings)).toThrow("built-in runbook order");
  });
  it("views a fresh read-only temporary copy without changing the real bundle or switches", () => {
    const { books, settings } = fixture();
    const states = settings.getRunbookStates();
    const temp = scratchDir("inf-view-runbook-");
    const before = books.firstmate();
    const view = books.view("sequences", temp);
    const copied: string[] = [];
    const compare = (relative = "") => {
      const original = join(root, "sequences", relative);
      const target = join(view, relative);
      const stat = lstatSync(target);
      expect(stat.mode & 0o222).toBe(0);
      if (stat.isDirectory()) {
        copied.push(target);
        expect(readdirSync(target)).toEqual(readdirSync(original));
        for (const file of readdirSync(original)) compare(join(relative, file));
      } else expect(readFileSync(target)).toEqual(readFileSync(original));
    };
    try {
      compare();
      expect(() => writeFileSync(join(view, "guide.md"), "changed")).toThrow();
      expect(books.firstmate()).toEqual(before);
      expect(settings.getRunbookStates()).toEqual(states);
      expect(() => books.view("../sequences", temp)).toThrow("built-in");
      expect(() => books.view("unknown", temp)).toThrow("built-in");
    } finally {
      for (const dir of copied) chmodSync(dir, 0o700);
    }
  });
  it("lists an unreadable personal folder with a reason, then serves its repaired real guidance", () => {
    const { settings } = fixture();
    const personal = join(scratchDir("inf-new-runbook-"), "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    expect(books.personalFolder()).toBe(personal);
    const dir = join(personal, "my-workflows");
    mkdirSync(dir);
    const broken = books.list().find((book) => book.path === dir);
    expect(broken).toMatchObject({ source: "personal", enabled: false, error: expect.any(String) });
    expect(() => books.set(broken?.id ?? "", true)).toThrow("not available");
    cpSync(join(root, "sequences"), dir, { recursive: true });
    const path = join(dir, "runbook.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...manifest,
        id: "my-workflows",
        name: "My workflows",
        author: "You",
        version: "1.0.0",
      }),
    );
    const repaired = books.list().find((book) => book.id === "my-workflows");
    expect(repaired).toMatchObject({ source: "personal", enabled: true, path: dir });
    expect(repaired?.error).toBeUndefined();
    expect(
      books.firstmate().text.endsWith(readFileSync(join(dir, manifest.firstmate), "utf8").trim()),
    ).toBe(true);
    // The legacy JSON-string section format remains valid for runbooks people share.
    writeFileSync(
      join(dir, "guide.json"),
      JSON.stringify(readFileSync(join(dir, manifest.firstmate), "utf8")),
    );
    writeFileSync(
      path,
      JSON.stringify({
        ...manifest,
        id: "my-workflows",
        author: "You",
        version: "1.0.0",
        firstmate: "guide.json",
      }),
    );
    expect(books.list().find((book) => book.id === "my-workflows")?.enabled).toBe(true);
    expect(
      books.firstmate().text.endsWith(readFileSync(join(dir, manifest.firstmate), "utf8").trim()),
    ).toBe(true);
  });
  it("starts every bundled runbook on and persists an individual switch without taking programs away", () => {
    const { db, books } = fixture();
    expect(books.list()).toHaveLength(BUILTIN_RUNBOOK_ORDER.length);
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
    const passage = readFileSync(join(root, "testing/crew.md"), "utf8").trim();
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
  // Intent: INF-2435 and review INF-2557, a queue-pr crewmate drives its pull request green like direct-pr.
  it("serves delivery judgment only to pull request crew, and its switch removes it", () => {
    const { books, db } = fixture();
    const passage = readFileSync(join(root, "delivery/crew.md"), "utf8").trim();
    for (const backend of ["pi", "claude"]) {
      expect(books.crew({ ...code, backend }).text).toContain(passage);
      expect(books.crew({ ...code, backend, delivery: "queue-pr" }).text).toContain(passage);
      expect(books.crew({ ...code, backend, delivery: "local-only" }).text).not.toContain(passage);
    }
    expect(books.firstmate().text).not.toContain(passage);
    books.set("delivery", false);
    expect(new Runbooks(root, new SettingsStore(db)).crew(code).text).not.toContain(passage);
  });
  it("removes delivery judgments from actual crew prompts on both backends without removing consent", () => {
    const { books } = fixture();
    const passage = readFileSync(join(root, "delivery/crew.md"), "utf8").trim();
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
      expect(prompt()).toContain(passage);
      books.set("delivery", false);
      expect(prompt()).not.toContain(passage);
      expect(prompt()).not.toContain("Never emit a merge card on anything but green");
      expect(prompt()).toContain("The merge card never grants merge permission by itself");
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
    // A skill rides its runbook, not a care: the care runbook's, the programs' and the queue's stay.
    expect(books.crew(code).skills.map((skill) => skill.name)).toEqual([
      "careful-change",
      "programs",
      "queue-repair",
      "queue-setup",
      "computer-cleanup",
    ]);
  });
  // Intent: the accepted ask-first cleanup plan bundles its guide on the computer running the look.
  // Real manifest and guides through the first-mate and work-computer owners; off withdraws both.
  // The switch regression left the ask-first instruction active after removing the crew's guide.
  it("serves both cleanup guides only while enabled and stages the no-project look's skill", async () => {
    const { books } = fixture();
    const look: RunbookFacts = {
      kind: "research",
      place: "personal",
      backend: "pi",
      delivery: "answer",
      care: "standard",
    };
    const firstmateGuide = readFileSync(join(root, "computer-cleanup/guide.md"), "utf8").trim();
    const enabled = books.firstmate();
    expect(enabled.text).toContain(firstmateGuide);
    const staged = await stageRunbookSkills(
      books.crew(look).skills,
      join(scratchDir("inf-cleanup-look-"), "skills"),
    );
    const cleanup = staged.find((skill) => skill.name === "computer-cleanup");
    expect(cleanup).toBeDefined();
    expect(readFileSync(join(cleanup?.dir ?? "", "SKILL.md"))).toEqual(
      readFileSync(join(root, "computer-cleanup/skills/computer-cleanup/SKILL.md")),
    );
    books.set("computer-cleanup", false);
    expect(books.firstmate().text).not.toContain(firstmateGuide);
    expect(books.firstmate().sha).not.toBe(enabled.sha);
    expect(books.crew(look).skills.map((skill) => skill.name)).not.toContain("computer-cleanup");
    books.set("computer-cleanup", true);
    expect(books.firstmate()).toEqual(enabled);
    expect(books.crew(look).skills.map((skill) => skill.name)).toContain("computer-cleanup");
  });
  // Intent: the captain requires the paused-batch repair crewmate to fix flakiness forward.
  // Exercise the real bundle-to-work-computer skill door, not a source-file presence check.
  it("stages the fix-forward flake procedure for a repair and withdraws it when its runbook is off", async () => {
    const { books } = fixture();
    const staged = await stageRunbookSkills(
      books.crew({ ...code, kind: "fix", delivery: "queue-pr" }).skills,
      join(scratchDir("inf-queue-repair-"), "skills"),
    );
    const repair = staged.find((skill) => skill.name === "queue-repair");
    expect(repair).toBeDefined();
    const procedure = readFileSync(join(repair?.dir ?? "", "SKILL.md"), "utf8");
    expect(procedure).toContain("A failure judged a flake is still yours to repair");
    expect(procedure).toContain("Reproduce it in the failing ordering");
    expect(procedure).toContain("Never resume the unchanged batch");
    expect(procedure).toContain("When you cannot establish or fix the cause, keep the pause");
    books.set("queue", false);
    expect(
      books.crew({ ...code, kind: "fix", delivery: "queue-pr" }).skills.map((skill) => skill.name),
    ).not.toContain("queue-repair");
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
  it("keeps bundled guidance, load admission and Secrets mode independent on both backends", () => {
    // INF-1109's required update composes main's runbooks with approved local
    // use and remote catalog-only discovery at the positional prompt seam.
    const { books } = fixture();
    const cwd = scratchDir("inf-runbook-secrets-");
    for (const backend of ["pi", "claude"] as const) {
      const binding = backend === "pi" ? fakeBinding("test") : { backend, accountId: "test" };
      for (const mode of ["use", "list", "none"] as const) {
        const selected = books.crew({ ...code, backend });
        const session = crewmateSessionSpec(
          appPathsFor(cwd),
          {
            taskId: "runbook-secrets",
            cwd,
            load: true,
            machineId: mode === "list" ? "another-computer" : LOCAL_MACHINE_ID,
            runbookText: selected.text,
            ...(mode === "use" ? { secrets: true, shell: { path: [cwd], env: {} } } : {}),
            ...(mode === "list" ? { secretsCatalog: { list: async () => [] } } : {}),
          },
          binding,
        );
        expect(session.instructions.base).toContain(selected.text);
        expect(session.instructions.base).toContain(CREWMATE_LOAD_LINE);
        expect(session.instructions.base.includes(CREWMATE_SECRETS_LINE)).toBe(mode === "use");
        expect(session.instructions.base.includes(CREWMATE_SECRETS_CATALOG_LINE)).toBe(
          mode === "list",
        );
        expect(session.load).toBe(true);
      }
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
