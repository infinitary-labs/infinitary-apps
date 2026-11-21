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
import { compilePersonalModule } from "../personal/compiler";
import { createCrewmateResourceLoader } from "../pi/piResourceLoader";
import { CREWMATE_LOAD_LINE } from "../pi/piResources";
import { ASK_SECRET_TOOL_DESCRIPTION } from "../pi/secretTools";
import { validSecretBring } from "../secrets/bring";
import { CREWMATE_SECRETS_CATALOG_LINE, CREWMATE_SECRETS_LINE } from "../secrets/commandWords";
import { LOCAL_MACHINE_ID } from "../session/session";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { requireNamed } from "../workspace/naming";
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
    const on = new Set(books.list().flatMap((book) => (book.enabled ? [book.id] : [])));
    const sections = books
      .builtins()
      .filter((book) => book.firstmate && on.has(book.id))
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
  it("starts every bundled runbook but an experiment on and persists an individual switch without taking programs away", () => {
    const { db, books } = fixture();
    expect(books.list()).toHaveLength(BUILTIN_RUNBOOK_ORDER.length);
    const startsOff = new Set(
      books.builtins().flatMap((book) => (book.startsOff ? [book.id] : [])),
    );
    for (const book of books.list()) expect(book.enabled).toBe(!startsOff.has(book.id));
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
  // Intent: the approved Advanced architecture plan ships that runbook as an experiment, off on a
  // fresh install and after an update until its own switch turns it on, leaving every other runbook as it was.
  it("keeps a start-off runbook and all it serves off, fresh and after an update, until its switch turns it on", async () => {
    const { db, settings, books } = fixture();
    expect(
      books
        .builtins()
        .filter((book) => book.startsOff)
        .map((book) => book.id),
    ).toEqual(["batches", "pull-comments", "architecture"]);
    const switches = () => Object.fromEntries(books.list().map((book) => [book.id, book.enabled]));
    const allOn = Object.fromEntries(BUILTIN_RUNBOOK_ORDER.map((id) => [id, true]));
    expect(switches()).toEqual({
      ...allOn,
      batches: false,
      "pull-comments": false,
      architecture: false,
    });
    const off = { text: books.firstmate().text, crew: books.crew(code) };
    expect(off.text).not.toContain("# Advanced architecture");
    expect(off.crew.text).not.toContain("# Advanced architecture");
    expect(off.crew.skills.map((skill) => skill.name)).not.toContain("advanced-architecture");
    // An update reads the switches an earlier version saved, which never named this runbook.
    books.set("sequences", false);
    expect(settings.getRunbookStates()).toEqual({ sequences: false });
    const updated = new Runbooks(root, new SettingsStore(db));
    expect(Object.fromEntries(updated.list().map((book) => [book.id, book.enabled]))).toEqual({
      ...allOn,
      sequences: false,
      batches: false,
      "pull-comments": false,
      architecture: false,
    });
    const beforeOn = updated.firstmate().text;
    updated.set("architecture", true);
    const reopened = new Runbooks(root, new SettingsStore(db));
    expect(reopened.list().find((book) => book.id === "architecture")?.enabled).toBe(true);
    expect(reopened.list().find((book) => book.id === "sequences")?.enabled).toBe(false);
    const guide = readFileSync(join(root, "architecture/guide.md"), "utf8").trim();
    expect(reopened.firstmate().text.endsWith(guide)).toBe(true);
    expect(reopened.crew(code).text).toContain(
      readFileSync(join(root, "architecture/crew.md"), "utf8").trim(),
    );
    expect(reopened.crew({ ...code, kind: "retrieval" }).text).not.toContain(
      "# Advanced architecture",
    );
    const staged = await stageRunbookSkills(
      reopened.crew(code).skills,
      join(scratchDir("inf-architecture-"), "skills"),
    );
    const skill = staged.find((each) => each.name === "advanced-architecture");
    for (const file of ["SKILL.md", "parts/map.html", "parts/map.schema.json"])
      expect(readFileSync(join(skill?.dir ?? "", file), "utf8")).toBe(
        readFileSync(join(root, "architecture/skills/advanced-architecture", file), "utf8"),
      );
    reopened.set("architecture", false);
    expect(reopened.firstmate().text).toBe(beforeOn);
    expect(reopened.crew(code).skills.map((each) => each.name)).not.toContain(
      "advanced-architecture",
    );
  });
  // Intent: INF-4445's approved plan with the captain's answers - Pull request comments starts
  // off, one switch for every project; while on it serves its guidance to pull request crew and
  // the first mate and asks the host for the comment wake, which a personal copy keeps.
  it("asks for the comment wake and serves its guidance only while Pull request comments is on", () => {
    const { db, books } = fixture();
    const crew = (delivery: string) => books.crew({ ...code, delivery }).text;
    const section = readFileSync(join(root, "pull-comments/crew.md"), "utf8").trim();
    expect(books.list().find((book) => book.id === "pull-comments")?.enabled).toBe(false);
    expect(books.wakes()).toEqual(new Set());
    expect(crew("queue-pr")).not.toContain(section);
    expect(books.crew({ ...code, delivery: "queue-pr" }).wakes).toEqual([]);
    books.set("pull-comments", true);
    const reopened = new Runbooks(root, new SettingsStore(db));
    expect(reopened.wakes()).toEqual(new Set(["pull-request-comments"]));
    expect(reopened.crew({ ...code, delivery: "queue-pr" }).text).toContain(section);
    expect(reopened.crew({ ...code, delivery: "direct-pr" }).text).toContain(section);
    expect(reopened.crew({ ...code, delivery: "local-merge" }).text).not.toContain(section);
    // The conversation told of the section is the one the host may wake about it.
    expect(reopened.crew({ ...code, delivery: "queue-pr" }).wakes).toEqual([
      "pull-request-comments",
    ]);
    expect(reopened.crew({ ...code, delivery: "local-merge" }).wakes).toEqual([]);
    expect(reopened.firstmate().text).toContain(
      readFileSync(join(root, "pull-comments/guide.md"), "utf8").trim(),
    );
    reopened.set("pull-comments", false);
    expect(reopened.wakes()).toEqual(new Set());
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
  it("lists a runbook's panels by title, offers them only while it is on, and tells listeners of each switch", () => {
    // Intent: the captain's ask that runbooks can include panels; a copy of
    // the real Common workflows shows them under the built-in's id.
    const { settings } = fixture();
    const personal = join(scratchDir("inf-personal-runbooks-"), "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    const heard: string[] = [];
    const stop = books.subscribe(() => heard.push("changed"));
    books.copy("sequences", "my-workflows", "My workflows");
    const path = join(personal, "my-workflows");
    const manifest = JSON.parse(readFileSync(join(path, "runbook.json"), "utf8"));
    writeFileSync(join(path, "runbook.json"), JSON.stringify({ ...manifest, panels: ["desk"] }));
    mkdirSync(join(path, "desk"));
    writeFileSync(join(path, "desk/manifest.json"), JSON.stringify({ title: "Desk" }));
    const listed = () => books.list().find((book) => book.id === "my-workflows")?.panels;
    expect(listed()).toEqual([{ id: "sequences-desk", title: "Desk" }]);
    expect(books.panels()).toEqual([]);
    books.set("my-workflows", true);
    expect(books.panels()).toEqual([
      {
        id: "sequences-desk",
        folder: "desk",
        slice: "my-workflows:desk",
        dir: join(path, "desk"),
        runbook: { id: "my-workflows", name: "My workflows", source: "personal" },
      },
    ]);
    books.set("my-workflows", false);
    expect(books.panels()).toEqual([]);
    expect(heard).toEqual(["changed", "changed", "changed"]);
    stop();
    books.set("my-workflows", true);
    expect(heard).toHaveLength(3);
    // A built-in runbook's own panels never come through this door: the app
    // compiles them and shows them behind the runbook's gate instead.
    books.set("batches", true);
    expect(books.panels().map((panel) => panel.runbook.id)).toEqual(["my-workflows"]);
  });
  it("copies the Batches panel with its compiled words, so the copy's panel compiles in place of the built-in's", async () => {
    // Intent: the captain's approved plan for the Batches panel: Copy writes the panel's
    // compiled messages into the copy, and the copy shows the panel under the built-in's id.
    const { settings } = fixture();
    const personal = join(scratchDir("inf-batches-copy-"), "runbooks");
    const books = new Runbooks(root, settings, () => [], personal);
    expect(books.list().find((book) => book.id === "batches")?.panels).toEqual([
      { id: "batches-panel", title: "Batches" },
    ]);
    books.copy("batches", "my-batches", "My batches");
    books.set("my-batches", true);
    const [panel] = books.panels();
    expect(panel).toMatchObject({ id: "batches-panel", folder: "panel" });
    expect(existsSync(join(panel?.dir ?? "", "messages.generated.ts"))).toBe(true);
    const compiled = await compilePersonalModule({
      extensionId: "batches-panel",
      extensionDir: panel?.dir ?? "",
      kind: "panel",
      cacheRoot: scratchDir("inf-batches-copy-compiled-"),
    });
    expect(compiled.views).toEqual(["details"]);
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
    expect(books.firstmate().text).toContain("# Rigor levels");
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
    expect(requireNamed("feat(runbooks): add guidance", "title", books.naming())).toContain(
      "guidance",
    );
    expect(() => requireNamed("a plain title", "title", books.naming())).toThrow(
      "does not follow the naming runbook",
    );
    books.set("naming", false);
    expect(requireNamed("a plain title", "title", books.naming())).toBe("a plain title");
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
    // A skill rides its runbook, not a care: the care runbook's, the programs' and the cleanup's stay.
    expect(books.crew(code).skills.map((skill) => skill.name)).toEqual([
      "careful-change",
      "programs",
      "computer-cleanup",
      "bring-secrets",
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
  // Intent: INF-4718's approved plan, piece 2, and the captain's words "make sure the guidance
  // is not read on every session. it should be loaded only when the user actually wants to move
  // secrets". The fixtures are the real bundle and the real served prompts: a served section that
  // carried the move guidance, or a recipe whose example the bring refuses, fails here.
  it("serves no session the move guidance, stages it whole as a skill, and keeps its recipes usable", async () => {
    const { books } = fixture();
    const skillRoot = join(root, "bring-secrets/skills/bring-secrets");
    const files = readdirSync(skillRoot).sort();
    expect(files).toEqual(["SKILL.md", "automic-vault.md", "dotenv.md", "keychain.md"]);
    // Every sentence of the guidance, past the skill's listed name and description.
    const guidance = files.flatMap((file) =>
      readFileSync(join(skillRoot, file), "utf8")
        .replace(/^---[\s\S]*?---\n/, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 30),
    );
    const served = [books.firstmate().text, ASK_SECRET_TOOL_DESCRIPTION];
    const look: RunbookFacts = { ...code, kind: "research", place: "personal", project: undefined };
    for (const backend of ["pi", "claude"] as const) {
      const binding = backend === "pi" ? fakeBinding("test") : { backend, accountId: "test" };
      for (const facts of [code, look])
        served.push(
          crewmateSessionSpec(
            appPathsFor(root),
            {
              taskId: "task-1",
              machineId: "local",
              cwd: root,
              runbookText: books.crew({ ...facts, backend }).text,
              procedure: { delivery: "direct-pr", rigor: "standard" },
            },
            binding,
          ).instructions.base,
        );
    }
    for (const text of served) for (const line of guidance) expect(text).not.toContain(line);
    // The first mate's one pointer, in its Secrets tool.
    expect(ASK_SECRET_TOOL_DESCRIPTION).toContain("bring-secrets");
    // A crewmate that opens the skill finds its rules and each tool's file beside it.
    const staged = await stageRunbookSkills(
      books.crew(look).skills,
      join(scratchDir("inf-bring-secrets-"), "skills"),
    );
    const skill = staged.find((entry) => entry.name === "bring-secrets");
    expect(skill).toBeDefined();
    for (const file of files)
      expect(readFileSync(join(skill?.dir ?? "", file))).toEqual(
        readFileSync(join(skillRoot, file)),
      );
    // Each recipe's example is a bring the command takes.
    const examples = files.flatMap((file) =>
      [
        ...readFileSync(join(skillRoot, file), "utf8").matchAll(
          /^infinitary-secrets-axi bring --id (\S+) --reason '([^']+)' --from '(.+)'$/gm,
        ),
      ].map(([, id, reason, from]) => ({
        id: id ?? "",
        reason: reason ?? "",
        from: JSON.parse(from ?? ""),
      })),
    );
    expect(examples).toHaveLength(7);
    for (const example of examples) expect(validSecretBring(example)).toBe(true);
    books.set("bring-secrets", false);
    expect(books.crew(look).skills.map((entry) => entry.name)).not.toContain("bring-secrets");
  });
  // Intent: the approved plan for batches of your own puts the accounting of every failed test
  // against every change in the batch into the repair's guidance, with its three exits.
  // Exercise the real bundle-to-work-computer skill door, not a source-file presence check.
  it("stages the held batch's repair procedure and withdraws it when its runbook is off", async () => {
    const { books } = fixture();
    books.set("batches", true);
    const repairing = { ...code, kind: "fix" as const, delivery: "queue-pr" as const };
    const staged = await stageRunbookSkills(
      books.crew(repairing).skills,
      join(scratchDir("inf-batch-repair-"), "skills"),
    );
    const repair = staged.find((skill) => skill.name === "batch-repair");
    expect(repair).toBeDefined();
    const procedure = readFileSync(join(repair?.dir ?? "", "SKILL.md"), "utf8");
    expect(procedure).toBe(
      readFileSync(join(root, "batches/skills/batch-repair/SKILL.md"), "utf8"),
    );
    books.set("batches", false);
    expect(books.crew(repairing).skills.map((skill) => skill.name)).not.toContain("batch-repair");
  });
  // Intent: the team queue's removal renamed this runbook from `queue` to `batches`; a person
  // who turned Batched pull requests off keeps it off. The fixture is the setting an earlier
  // version saved; a lost carry would hand the repair skill back to a crew that had it withdrawn.
  it("keeps Batched pull requests off for a person who turned it off under its earlier id", () => {
    const { db, settings } = fixture();
    settings.setRunbookStates({ queue: false, sequences: false });
    const repairing = { ...code, kind: "fix" as const, delivery: "queue-pr" as const };
    const skills = () =>
      new Runbooks(root, new SettingsStore(db)).crew(repairing).skills.map((skill) => skill.name);
    expect(new SettingsStore(db).getRunbookStates()).toEqual({ batches: false, sequences: false });
    expect(skills()).not.toContain("batch-repair");
    // A choice made since, under the runbook's own id, is the one that holds.
    new Runbooks(root, new SettingsStore(db)).set("batches", true);
    expect(new SettingsStore(db).getRunbookStates()).toEqual({ batches: true, sequences: false });
    expect(skills()).toContain("batch-repair");
  });
  // Intent: INF-4754's approved plan with the captain's answers - Batched pull requests starts
  // off and offers the choice only while on; a person already batching keeps it on after the
  // update, and turning it off is refused while a project still uses it, naming the project.
  it("offers batched pull requests only while on, keeps them for a batching project and refuses turning them off under it", () => {
    const db = openInMemoryDatabase();
    const batching = new Set<string>();
    const open = (personal?: string) =>
      new Runbooks(
        root,
        new SettingsStore(db),
        () => [],
        personal,
        (offer) => (offer === "batched-pull-requests" ? [...batching] : []),
      );
    const fresh = open();
    expect(fresh.offers()).toEqual(new Set());
    fresh.keepOffersInUse();
    expect(new SettingsStore(db).getRunbookStates()).toEqual({});
    fresh.set("batches", true);
    expect(fresh.offers()).toEqual(new Set(["batched-pull-requests"]));
    fresh.set("batches", false);
    // An update finds a project already on batched pull requests with the switch never saved.
    new SettingsStore(db).setRunbookStates({});
    batching.add("website");
    const updated = open();
    updated.keepOffersInUse();
    expect(new SettingsStore(db).getRunbookStates()).toEqual({ batches: true });
    expect(updated.offers()).toEqual(new Set(["batched-pull-requests"]));
    batching.add("docs");
    expect(() => updated.set("batches", false)).toThrow(
      "website and docs still use batched pull requests. Choose another way for changes to go in Settings, under Projects, then turn this runbook off.",
    );
    expect(updated.list().find((book) => book.id === "batches")?.enabled).toBe(true);
    // A personal copy keeps the offer, so turning it on in place of ours is allowed.
    const personal = join(scratchDir("inf-batch-copy-"), "runbooks");
    const withCopy = open(personal);
    withCopy.copy("batches", "my-batches", "My batches");
    withCopy.set("my-batches", true);
    expect(withCopy.list().find((book) => book.id === "batches")?.enabled).toBe(false);
    expect(withCopy.offers()).toEqual(new Set(["batched-pull-requests"]));
    batching.clear();
    withCopy.set("my-batches", false);
    expect(withCopy.offers()).toEqual(new Set());
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
    const personal = {
      skills: personalSkills,
      plugins: [],
      digests: { instructions: null, skills: "" },
    };
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

// Intent: INF-4583, building INF-4573's direction A. the audited quick answer
// handed its thread on only when the captain named a stronger crewmate, and
// its brief carried a limit narrower than its kind's; the served sequences
// now tell the first mate to start a handed-back reply's work at once.
describe("the first mate's explainer rules for a quick answer's replies", () => {
  it("serves the hand-off start and the no-narrower-limit rule to the first mate", () => {
    const served = fixture().books.firstmate().text.replace(/\s+/g, " ");
    expect(served).toContain(
      "A reply a retrieval hands back starts the work my words need, built on its answer, at once, as if I had asked.",
    );
    expect(served).toContain("Add no limit narrower than the kind's own unless I asked.");
  });
});
