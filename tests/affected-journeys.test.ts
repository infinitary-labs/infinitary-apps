import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closureOf,
  declaredJourneys,
  holdsHook,
  holdsPhrase,
  importsOf,
  named,
  ownedHooks,
  select,
  symbolsOfDiff,
  tokensOfDiff,
} from "../scripts/affected-journeys.ts";
import { changedMessages } from "../scripts/window-messages.ts";

/**
 * Which journey files a change can break (scripts/affected-journeys.ts):
 * the pull request's Mac check runs those and no others.
 */

const FILES = new Map<string, string>([
  [
    "tests/e2e/a.spec.ts",
    'import { launchApp } from "./launch";\nimport { board } from "./board";',
  ],
  ["tests/e2e/b.spec.ts", 'import { launchApp } from "./launch";\nconst x = "Start the work";'],
  [
    "tests/e2e/c.spec.ts",
    'import { launchApp } from "./launch";\nimport { VERSION } from "../../src/shared/version";\nconst note = "saved-data-compatibility.md";',
  ],
  [
    "tests/e2e/launch.ts",
    'export const launchApp = 1;\nconst longer = "press your key to continue";\nconst exact = "Cannot call GitHub";',
  ],
  ["src/shared/version.ts", "export const VERSION = 1;"],
  [
    "tests/e2e/board.ts",
    'export const tile = \'[data-board-tile="x"]\';\nexport const copied = "Begin the work";',
  ],
]);
const read = (file: string) => FILES.get(file);
const specs = [...FILES.keys()].filter((file) => file.endsWith(".spec.ts"));
const run = (change: { changed?: string[]; sourceDiff?: string }) =>
  [...select({ changed: [], sourceDiff: "", specs, read, ...change }).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
const picked = (change: { changed?: string[]; sourceDiff?: string }) =>
  run(change).map(([file]) => file);

describe("which journeys a change affects", () => {
  it("keeps the Mac update journey on controller and state-store changes without a changed hook", () => {
    // INF-640: the project gate must retain the consent, channel and recovery journey it owns.
    const specs = [
      "tests/e2e/mac-updates.spec.ts",
      "tests/e2e/installed-update-work.spec.ts",
      "tests/e2e/app-close.spec.ts",
    ];
    const read = (file: string) => {
      try {
        return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      } catch {
        return undefined;
      }
    };
    for (const path of [
      "src/core/update/macUpdates.ts",
      "src/core/update/macInstallation.ts",
      "src/core/update/updateChecker.ts",
      "src/renderer/src/app/updateState.ts",
    ]) {
      expect([...select({ changed: [path], sourceDiff: "", specs, read }).keys()]).toEqual([
        "tests/e2e/mac-updates.spec.ts",
      ]);
    }
    // INF-643: the native proof's active-work fixture has its own real-app journey.
    expect([
      ...select({
        changed: ["tests/fixtures/installed-updates/runningWork.ts"],
        sourceDiff: "",
        specs,
        read,
      }).keys(),
    ]).toEqual(["tests/e2e/installed-update-work.spec.ts"]);
  });

  it("runs the spec a change edits, and nothing for a change no journey reaches", () => {
    expect(picked({ changed: ["tests/e2e/b.spec.ts"] })).toEqual(["tests/e2e/b.spec.ts"]);
    expect(picked({ changed: ["src/core/tasks/taskService.ts", "docs/testing.md"] })).toEqual([]);
  });

  it("runs every spec that imports a changed helper, including one every spec imports", () => {
    expect(picked({ changed: ["tests/e2e/board.ts"] })).toEqual(["tests/e2e/a.spec.ts"]);
    expect(picked({ changed: ["tests/e2e/launch.ts"] })).toEqual(specs);
  });

  it("runs every spec that reaches a changed helper outside tests/e2e, through any helper", () => {
    // INF-520: tests/helpers/completionCard.ts, which every journey reaches
    // through the stand-in, picked no journey when a change edited it.
    const files = new Map<string, string>([
      [
        "tests/e2e/launch.ts",
        'import { scratchDir } from "../helpers/scratchDirs";\nimport { startMockProvider } from "./mockProvider";',
      ],
      [
        "tests/e2e/mockProvider.ts",
        'import { completionCardBody } from "../helpers/completionCard";',
      ],
      [
        "tests/helpers/completionCard.ts",
        'import { COMPLETION_CARD_HEADINGS } from "../../src/shared/cardHeadings";',
      ],
      ["tests/helpers/scratchDirs.ts", "export function scratchDir(prefix: string) {}"],
      ["tests/helpers/fakeSession.ts", "export class FakeSession {}"],
      ["tests/fixtures/ollamaServer.ts", "export function startOllamaServer() {}"],
      ["scripts/interaction-metrics.ts", "export function interactionMetrics() {}"],
      ["src/shared/cardHeadings.ts", "export const COMPLETION_CARD_HEADINGS = [];"],
      ["tests/e2e/risk-chart.spec.ts", 'import { launchApp } from "./launch";'],
      [
        "tests/e2e/ollama-context.spec.ts",
        'import { launchApp } from "./launch";\nimport { startOllamaServer } from "../fixtures/ollamaServer";',
      ],
      [
        "tests/e2e/forge-signin.spec.ts",
        'import { launchApp } from "./launch";\nimport { interactionMetrics } from "../../scripts/interaction-metrics";',
      ],
    ]);
    const journeys = [...files.keys()].filter((file) => file.endsWith(".spec.ts"));
    const chosen = (changed: string[]) =>
      select({ changed, sourceDiff: "", specs: journeys, read: (file) => files.get(file) });
    const deep = chosen(["tests/helpers/completionCard.ts"]);
    expect([...deep.keys()].sort()).toEqual([...journeys].sort());
    expect(deep.get("tests/e2e/risk-chart.spec.ts")).toEqual([
      "imports tests/helpers/completionCard.ts, which the change edits",
    ]);
    expect([...chosen(["tests/helpers/scratchDirs.ts"]).keys()].sort()).toEqual(
      [...journeys].sort(),
    );
    expect([...chosen(["tests/fixtures/ollamaServer.ts"]).keys()]).toEqual([
      "tests/e2e/ollama-context.spec.ts",
    ]);
    expect([...chosen(["scripts/interaction-metrics.ts"]).keys()]).toEqual([
      "tests/e2e/forge-signin.spec.ts",
    ]);
    // A helper only unit tests import runs no journey, and a module of src/ is
    // where the closure stops: its edit selects through rules 3 to 5, not this one.
    expect([...chosen(["tests/helpers/fakeSession.ts"]).keys()]).toEqual([]);
    expect([...chosen(["src/shared/cardHeadings.ts"]).keys()]).toEqual([]);
  });

  it("runs the specs whose helpers read a hook as a whole token", () => {
    const sourceDiff = [
      "--- a/src/renderer/src/Board.tsx",
      "+++ b/src/renderer/src/Board.tsx",
      "-  <li data-board-tile={key}>",
      "+  <li data-board-card={key}>",
      "+  <p data-compatibility>",
    ].join("\n");
    expect(picked({ changed: ["src/renderer/src/Board.tsx"], sourceDiff })).toEqual([
      "tests/e2e/a.spec.ts",
    ]);
    expect(holdsHook("see saved-data-compatibility.md", "data-compatibility")).toBe(false);
    expect(holdsHook('[data-board-tile="x"]', "data-board-tile")).toBe(true);
  });

  it("runs the specs that hold a changed sentence as their own quoted string", () => {
    const sourceDiff = ['-  title: "Start the work",', '+  title: "Begin the work",'].join("\n");
    expect(picked({ changed: ["src/shared/x.ts"], sourceDiff })).toEqual([
      "tests/e2e/a.spec.ts",
      "tests/e2e/b.spec.ts",
    ]);
  });

  it("does not let a fragment, or a sentence only the stand-in holds, select every journey", () => {
    const fragment = ['-  hint: "your key",'].join("\n");
    expect(picked({ changed: ["src/renderer/src/Form.tsx"], sourceDiff: fragment })).toEqual([]);
    expect(holdsPhrase('const longer = "press your key to continue";', "your key")).toBe(false);
    const standIn = ['-  throw "Cannot call GitHub";'].join("\n");
    expect(picked({ changed: ["src/core/forge.ts"], sourceDiff: standIn })).toEqual([]);
  });

  it("follows a changed shared module only when the journey names what changed", () => {
    const renamed = [
      "diff --git a/src/shared/version.ts b/src/shared/version.ts",
      "--- a/src/shared/version.ts",
      "+++ b/src/shared/version.ts",
      "-export const VERSION = 1;",
      "+export const BUILD_STAMP = 2;",
    ].join("\n");
    expect(picked({ changed: ["src/shared/version.ts"], sourceDiff: renamed })).toEqual([
      "tests/e2e/c.spec.ts",
    ]);
    const added = [
      "diff --git a/src/shared/version.ts b/src/shared/version.ts",
      "--- a/src/shared/version.ts",
      "+++ b/src/shared/version.ts",
      "+export const BUILD_STAMP = 2;",
    ].join("\n");
    expect(picked({ changed: ["src/shared/version.ts"], sourceDiff: added })).toEqual([]);
    expect(closureOf("tests/e2e/c.spec.ts", read)).toEqual([
      "tests/e2e/c.spec.ts",
      "tests/e2e/launch.ts",
      "src/shared/version.ts",
    ]);
  });

  it("does not treat an ordinary word, a comment, or a parameter as what changed", () => {
    const ordinary = [
      "diff --git a/src/shared/version.ts b/src/shared/version.ts",
      "+  launchApp: true,",
    ].join("\n");
    expect(picked({ changed: ["src/shared/version.ts"], sourceDiff: ordinary })).toEqual([]);
    const commentAndParameter = [
      "diff --git a/src/shared/events.ts b/src/shared/events.ts",
      "+ * Activity holds: a line written",
      "+export function changesFeed(event: string) {",
      "+  withdrawn: true,",
    ].join("\n");
    expect(picked({ changed: ["src/shared/events.ts"], sourceDiff: commentAndParameter })).toEqual(
      [],
    );
  });
});

describe("what a diff changes in the product", () => {
  it("takes hooks and sentences from added and removed lines only", () => {
    const { hooks, sentences } = tokensOfDiff(
      [
        "--- a/x.tsx",
        "+++ b/x.tsx",
        " <p data-kept>unchanged words</p>",
        '+<p data-fresh>{"Say something new"}</p>',
        '-const old = "Old words here";',
        '+const oneWord = "single";',
      ].join("\n"),
    );
    expect([...hooks]).toEqual(["data-fresh"]);
    expect([...sentences].sort()).toEqual(["Old words here", "Say something new"]);
  });

  it("resolves relative and @shared imports against the repository", () => {
    expect(importsOf("tests/e2e/stack.ts", 'import { drawnFrame } from "./frames";')).toEqual([
      "tests/e2e/frames.ts",
    ]);
    expect(
      importsOf("tests/e2e/x.ts", 'import { a } from "@shared/cards"; import "left-pad";'),
    ).toEqual(["src/shared/cards.ts"]);
  });
});

// INF-625's accepted precision fixes. The fixtures keep the original helper
// versions and real journey import clauses; no git process runs inside a unit test.
describe("INF-625 motivating runs", () => {
  for (const run of ["39319028198", "39329016218", "39366415817"]) {
    it(`selects only changed-export importers in run ${run}`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL(`./fixtures/affected-journeys/${run}.json`, import.meta.url), "utf8"),
      ) as {
        helpers: Record<string, { before: string; after: string }>;
        imports: Record<string, string>;
        expected: string[];
      };
      const read = (file: string) => fixture.imports[file] ?? fixture.helpers[file]?.after;
      const reasons = select({
        changed: Object.keys(fixture.helpers),
        sourceDiff: "",
        specs: Object.keys(fixture.imports),
        read,
        readBefore: (file) => fixture.helpers[file]?.before,
      });
      expect([...reasons.keys()].sort()).toEqual(fixture.expected);
    });
  }

  it.each([
    ["39296806356", "around", "OpenChangeInput"],
    ["39317894265", "changes", "ClientFrame"],
    ["39337683472", "flatMap", "TaskFactId"],
    ["39381269010", "failed", "TaskView"],
    ["39381269010", "passed", "TaskView"],
    ["39381269010", "cancelled", "TaskView"],
  ])(
    "does not select a journey for an ordinary word or built-in in run %s",
    (run, word, imported) => {
      const fixture = JSON.parse(
        readFileSync(new URL(`./fixtures/affected-journeys/${run}.json`, import.meta.url), "utf8"),
      ) as { module: string; sourceDiff: string };
      const journey = "tests/e2e/check-refresh.spec.ts";
      const files = new Map([
        [fixture.module, ""],
        [
          journey,
          `import { ${imported} } from "../../${fixture.module.replace(/\.ts$/, "")}";\nconst reading = "${word}";`,
        ],
        ["tests/e2e/other.spec.ts", ""],
      ]);
      expect([
        ...select({
          changed: [fixture.module],
          sourceDiff: fixture.sourceDiff,
          specs: [journey, "tests/e2e/other.spec.ts"],
          read: (file) => files.get(file),
        }).keys(),
      ]).toEqual([]);
    },
  );

  it("does not let the stand-in's hooks select all importers", () => {
    const files = new Map(FILES);
    files.set(
      "tests/e2e/launch.ts",
      `${files.get("tests/e2e/launch.ts")}\nconst body = '<div data-record-section>';`,
    );
    expect([
      ...select({
        changed: ["src/renderer/src/Record.tsx"],
        sourceDiff: "+<div data-record-section>",
        specs,
        read: (file) => files.get(file),
      }).keys(),
    ]).toEqual([]);
  });

  it("ignores app unit tests and cancels unchanged hooks and sentences per file", () => {
    const diff = [
      "diff --git a/src/shared/board.test.ts b/src/shared/board.test.ts",
      '+const body = "data-board-tile";',
      '+const words = "Start the work";',
      "diff --git a/src/renderer/src/Board.tsx b/src/renderer/src/Board.tsx",
      '-<li data-board-tile>{"Start the work"}</li>',
      '+<li data-board-tile hidden>{"Start the work"}</li>',
    ].join("\n");
    expect(
      picked({
        changed: ["src/shared/board.test.ts", "src/renderer/src/Board.tsx"],
        sourceDiff: diff,
      }),
    ).toEqual([]);
    // A hook changing owners must not cancel across files.
    expect([
      ...tokensOfDiff(
        "diff --git a/src/a.tsx b/src/a.tsx\n-<div data-board-tile>\ndiff --git a/src/b.tsx b/src/b.tsx\n+<div data-board-tile>",
      ).hooks,
    ]).toEqual(["data-board-tile"]);
  });

  it("requires a key or export declaration, not just a referenced camelCase name", () => {
    const diff =
      "diff --git a/src/shared/version.ts b/src/shared/version.ts\n+const x = launchApp();\n+const prose = 'launchApp: true';\n+// export const launchApp = true";
    expect(picked({ changed: ["src/shared/version.ts"], sourceDiff: diff })).toEqual([]);
    const declared =
      "diff --git a/src/shared/version.ts b/src/shared/version.ts\n+export const BUILD_STAMP = 2;\n+  buildStamp: z.number(),";
    expect([...(symbolsOfDiff(declared).get("src/shared/version.ts") ?? [])]).toEqual([
      "BUILD_STAMP",
      "buildStamp",
    ]);
  });
});

describe("changed helper names (INF-625)", () => {
  it("follows renamed imports and re-exports without selecting unrelated names", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/affected-journeys/39319028198.json", import.meta.url),
        "utf8",
      ),
    ) as {
      helpers: Record<string, { before: string; after: string }>;
    };
    const files = new Map([
      ["tests/e2e/windowKeys.ts", fixture.helpers["tests/e2e/windowKeys.ts"]?.after ?? ""],
      ["tests/e2e/keys.ts", 'export { focusOn as focusTarget } from "./windowKeys";'],
      ["tests/e2e/focus.spec.ts", 'import { focusTarget } from "./keys";'],
      ["tests/e2e/key-hint.spec.ts", 'import { keyHint } from "./windowKeys";'],
      ["tests/e2e/alias.spec.ts", 'import { focusOn as focusTarget } from "./windowKeys";'],
    ]);
    const specs = [...files.keys()].filter((file) => file.endsWith(".spec.ts"));
    expect(
      [
        ...select({
          changed: ["tests/e2e/windowKeys.ts"],
          sourceDiff: "",
          specs,
          read: (file) => files.get(file),
          readBefore: (file) => fixture.helpers[file]?.before,
        }).keys(),
      ].sort(),
    ).toEqual(["tests/e2e/alias.spec.ts", "tests/e2e/focus.spec.ts"]);
  });
});

describe("removed helper exports (INF-625)", () => {
  it("still selects importers when the changed helper is deleted", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/affected-journeys/39319028198.json", import.meta.url),
        "utf8",
      ),
    ) as {
      helpers: Record<string, { before: string; after: string }>;
    };
    const spec = "tests/e2e/task-crewmate.spec.ts";
    const chosen = select({
      changed: ["tests/e2e/windowKeys.ts"],
      sourceDiff: "",
      specs: [spec],
      read: (file) => (file === spec ? 'import { focusOn } from "./windowKeys";' : undefined),
      readBefore: (file) => fixture.helpers[file]?.before,
    });
    expect([...chosen.keys()]).toEqual([spec]);
  });
});

// INF-625's owned-hooks fix. PR #153 (run 39296951860) changed how the task
// record draws without adding or removing a hook, chose three files, and
// skipped the three journeys that then failed on main. The fixture keeps the
// real changed paths, the lines of each changed screen file that name a hook,
// and the import and hook lines of each journey and its own helpers.
describe("hooks a changed screen file draws (INF-625)", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/affected-journeys/39296951860.json", import.meta.url), "utf8"),
  ) as {
    changed: string[];
    drawn: Record<string, string>;
    journeys: Record<string, string>;
    helpers: Record<string, string>;
    missed: string[];
    unchosen: string;
    specs: string[];
  };
  const read = (file: string) =>
    fixture.drawn[file] ??
    fixture.journeys[file] ??
    fixture.helpers[file] ??
    (fixture.specs.includes(file) ? "" : undefined);

  it("selects the journeys PR #153 broke, and not one that reads none of its hooks", () => {
    const reasons = select({
      changed: fixture.changed,
      sourceDiff: "",
      specs: fixture.specs,
      read,
    });
    for (const journey of fixture.missed)
      expect(
        reasons.get(journey)?.some((why) => / which src\/renderer\/\S+ draws$/.test(why)),
      ).toBe(true);
    expect(reasons.has(fixture.unchosen)).toBe(false);
  });

  it("reads only screen files, not a unit test beside them or a module outside the renderer", () => {
    const files = new Map([
      ["src/renderer/src/cards/stageSlots.test.ts", 'const x = "[data-stage-entry]";'],
      ["src/core/tasks/record.ts", 'const y = "data-stage-entry";'],
      ["src/renderer/src/cards/RecordCard.tsx", '<div data-record-body="x">'],
    ]);
    const owned = ownedHooks([...files.keys()], (file) => files.get(file));
    expect([...owned.keys()]).toEqual(["src/renderer/src/cards/RecordCard.tsx"]);
    // A deleted screen file still owns the hooks it drew.
    const deleted = ownedHooks(
      ["src/renderer/src/Gone.tsx"],
      () => undefined,
      () => "<p data-gone>",
    );
    expect([...(deleted.get("src/renderer/src/Gone.tsx") ?? [])]).toEqual(["data-gone"]);
  });
});

// INF-658's accepted screen-rule choice, on PR #153's actual source and diff.
describe("edited screen regions (INF-658)", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/affected-journeys/screen-regions.json", import.meta.url),
      "utf8",
    ),
  ) as {
    before: Record<string, string>;
    after: Record<string, string>;
    sourceDiff: string;
  };
  const original = JSON.parse(
    readFileSync(new URL("./fixtures/affected-journeys/39296951860.json", import.meta.url), "utf8"),
  ) as {
    changed: string[];
    journeys: Record<string, string>;
    helpers: Record<string, string>;
    specs: string[];
    missed: string[];
    unchosen: string;
  };
  it("still selects every journey PR #153 broke with the precise real diff", () => {
    const reasons = select({
      changed: original.changed,
      sourceDiff: fixture.sourceDiff,
      specs: original.specs,
      read: (file) =>
        fixture.after[file] ??
        original.journeys[file] ??
        original.helpers[file] ??
        (original.specs.includes(file) ? "" : undefined),
      readBefore: (file) => fixture.before[file],
    });
    for (const file of original.missed) expect(reasons.has(file), file).toBe(true);
    expect(reasons.has(original.unchosen)).toBe(false);
  });
  it("does not select unrelated parts of HomeScreen for its CardLayer edit", () => {
    const file = "src/renderer/src/app/HomeScreen.tsx";
    const hooks = ownedHooks(
      [file],
      (path) => fixture.after[path],
      (path) => fixture.before[path],
      fixture.sourceDiff,
    ).get(file);
    expect(hooks?.has("data-stage-entry")).toBe(true);
    expect(hooks?.has("data-prompt-dock")).toBe(false);
    expect(hooks?.has("data-character-frame")).toBe(false);
  });
});

it("INF-658: a JSX hook-value edit does not select a sibling screen region", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/affected-journeys/screen-regions.json", import.meta.url),
      "utf8",
    ),
  ) as { before: Record<string, string> };
  const file = "src/renderer/src/app/HomeScreen.tsx";
  const before = fixture.before[file] ?? "";
  const line = before.split("\n").findIndex((line) => line.includes('data-prompt-dock=""')) + 1;
  expect(line).toBeGreaterThan(0);
  const after = before.replace('data-prompt-dock=""', 'data-prompt-dock="main"');
  const diff = `diff --git a/${file} b/${file}\n@@ -${line} +${line} @@\n-data-prompt-dock=""\n+data-prompt-dock="main"`;
  const hooks = ownedHooks(
    [file],
    () => after,
    () => before,
    diff,
  ).get(file);
  expect(hooks?.has("data-prompt-dock")).toBe(true);
  expect(hooks?.has("data-character-frame")).toBe(false);
  expect(hooks?.has("data-stage-entry")).toBe(false);
});

describe("journeys a change declares (INF-631)", () => {
  // PR #167 (run 39337683472) broke now-panel through taskFacts.ts, which no
  // rule that reads files sees: the crewmate's Journeys: trailer names it.
  const root = new URL("..", import.meta.url);
  const realSpecs = readdirSync(new URL("tests/e2e/", root))
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => `tests/e2e/${file}`);
  const readReal = (file: string) => {
    const path = new URL(file, root);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/affected-journeys/39337683472.json", import.meta.url), "utf8"),
  ) as { module: string; sourceDiff: string };
  const change = {
    changed: [fixture.module],
    sourceDiff: fixture.sourceDiff,
    specs: realSpecs,
    read: readReal,
  };

  it("adds a declared journey no rule chose, with the declaration as its reason", () => {
    expect(select(change).has("tests/e2e/now-panel.spec.ts")).toBe(false);
    const reasons = select({ ...change, declared: declaredJourneys("now-panel\n") });
    expect(reasons.get("tests/e2e/now-panel.spec.ts")).toEqual([
      "the change's commits declare it reaches this journey",
    ]);
  });

  it("refuses a name that is no journey rather than run nothing for it", () => {
    expect(() => select({ ...change, declared: declaredJourneys("now-pannel.spec.ts") })).toThrow(
      /now-pannel\.spec\.ts, which is not a journey/,
    );
  });

  it("reads every commit's trailer, in each way a journey is named", () => {
    // `git log --format=%(trailers:key=Journeys,valueonly)` over three commits:
    // one trailer each, the third with none.
    const log =
      "now-panel.spec.ts, tests/e2e/task-crewmate.spec.ts\n\nrecord-controls panel-tasks\n\n\n";
    expect(declaredJourneys(log)).toEqual([
      "tests/e2e/now-panel.spec.ts",
      "tests/e2e/task-crewmate.spec.ts",
      "tests/e2e/record-controls.spec.ts",
      "tests/e2e/panel-tasks.spec.ts",
    ]);
    expect(declaredJourneys("")).toEqual([]);
  });
});

/**
 * INF-1136's fix 4, the captain's pick: "Teach the journey picker to catch a
 * changed message between the app's window and its core". Main was red from
 * 5:29 to 9:26 PM because the change in the fixture gave inf:retention:scope
 * a new field, and knowledge-gate, which compares that answer whole, was not
 * chosen. The fixture is that change's own contract, preload and journeys.
 */
describe("a changed message between the window and its core (INF-1136)", () => {
  type Edit = { file: string; from: string; to: string };
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/affected-journeys/window-message.json", import.meta.url),
      "utf8",
    ),
  ) as {
    changed: string[];
    before: Record<string, string>;
    edits: Edit[];
    unchanged: Record<string, string>;
    journeys: Record<string, string>;
    specs: string[];
  };
  const apply = (files: Record<string, string>, edits: Edit[]) => {
    const result = { ...files };
    for (const edit of edits) {
      const text = result[edit.file] ?? "";
      expect(text.split(edit.from)).toHaveLength(2);
      result[edit.file] = text.replace(edit.from, () => edit.to);
    }
    return result;
  };
  const change = (
    before: Record<string, string>,
    after: Record<string, string>,
    journeys = fixture.journeys,
    changed = fixture.changed,
  ) => ({
    changed,
    sourceDiff: "",
    specs: [...new Set([...fixture.specs, ...Object.keys(journeys)])],
    read: (file: string) =>
      after[file] ??
      fixture.unchanged[file] ??
      journeys[file] ??
      (fixture.specs.includes(file) ? "" : undefined),
    readBefore: (file: string) => before[file] ?? fixture.unchanged[file],
  });
  const knowledgeGate = "tests/e2e/knowledge-gate.spec.ts";

  it("chooses knowledge-gate for the change that turned main red", () => {
    const after = apply(fixture.before, fixture.edits);
    const reasons = select(change(fixture.before, after));
    expect(reasons.get(knowledgeGate)).toEqual([
      "calls window.infinitary.retention.scope, whose message inf:retention:scope the change edits",
    ]);
    // Of the contract's channels, the change edits the two it means to, and
    // the journey that edits itself gains no reason of this kind.
    const { read, readBefore } = change(fixture.before, after);
    const messages = changedMessages(fixture.changed, read, readBefore);
    expect(Object.fromEntries(messages.methods)).toEqual({
      "retention.scope": "inf:retention:scope",
      "retention.deleteOutside": "inf:retention:delete-outside",
    });
    expect(messages.reads.size).toBe(0);
    expect(reasons.get("tests/e2e/integrations-google.spec.ts")).toEqual([
      "the change edits this journey",
    ]);
  });

  it("does not count a comment on a message as a change to it", () => {
    // The same change's new words on inf:retention:scope, without its code.
    const comment = (text: string) =>
      text.match(
        / {2}\/\*\*(?:(?!\*\/)[\s\S])*What a purge clears(?:(?!\*\/)[\s\S])*\*\/\n/,
      )?.[0] ?? "";
    const words: Edit = {
      file: "src/shared/ipc.ts",
      from: comment(fixture.before["src/shared/ipc.ts"] ?? ""),
      to: comment(fixture.edits.map((edit) => edit.to).join("")),
    };
    expect(words.to).toContain("the words from outside this build keeps");
    const after = apply(fixture.before, [words]);
    expect(
      select(change(fixture.before, after, fixture.journeys, ["src/shared/ipc.ts"])).size,
    ).toBe(0);
  });

  it("chooses a journey that reads a changed message by the read's name", () => {
    // fca460b9 made inf:knowledge:directions' argument optional, and
    // knowledge-directions reads it by name with this line.
    const after = { ...fixture.before };
    const before = apply(after, [
      {
        file: "src/shared/ipc.ts",
        from: "request: z.tuple([knowledgeDirectionsArgsSchema.optional()]),",
        to: "request: z.tuple([knowledgeDirectionsArgsSchema]),",
      },
    ]);
    const journey = {
      "tests/e2e/knowledge-directions.spec.ts":
        'window.infinitary.plugins.read("knowledge.directions", { scope: "captain" }),',
    };
    const reasons = select(change(before, after, journey, ["src/shared/ipc.ts"]));
    expect(Object.fromEntries(reasons)).toEqual({
      "tests/e2e/knowledge-directions.spec.ts": [
        "reads knowledge.directions, whose message inf:knowledge:directions the change edits",
      ],
    });
  });
});

/**
 * INF-800: journeys on request run the files a branch names, through the
 * same placement as a pull request's, so a computer in CI mode can send a
 * journey it is working on through CI (docs/testing.md, "Journeys on request").
 */
describe("journeys a request names", () => {
  it("runs each named journey, however it is named, and nothing else", () => {
    const reasons = named("now-panel, tests/e2e/task-crewmate.spec.ts devices.spec.ts");
    expect([...reasons.keys()].sort()).toEqual([
      "tests/e2e/devices.spec.ts",
      "tests/e2e/now-panel.spec.ts",
      "tests/e2e/task-crewmate.spec.ts",
    ]);
    expect(reasons.get("tests/e2e/devices.spec.ts")).toEqual(["requested by name"]);
  });

  it("refuses a name that is no journey, and a request that names none", () => {
    expect(() => named("now-pannel")).toThrow(/now-pannel\.spec\.ts, which is not a journey/);
    expect(() => named(" , ")).toThrow("Name at least one journey to run");
  });
});

/**
 * INF-1255: a core change reaches a journey through the words it serves the
 * model, which the journey's stand-in reads by pattern or answers by a
 * tool's name. The chooser chose neither journey these two merges broke.
 */
describe("words the core serves that a stand-in reads (INF-1255)", () => {
  type Merge = {
    pull: string;
    changed: string[];
    sourceDiff: string;
    files: Record<string, string>;
    specs: string[];
  };
  const { merges } = JSON.parse(
    readFileSync(
      new URL("./fixtures/affected-journeys/served-words.json", import.meta.url),
      "utf8",
    ),
  ) as { merges: Merge[] };
  const merge = (pull: string) => merges.find((entry) => entry.pull === pull) as Merge;
  const chosen = ({ changed, sourceDiff, files, specs }: Merge) =>
    Object.fromEntries(select({ changed, sourceDiff, specs, read: (file) => files[file] }));

  it("chooses check-repair for Merge anyway, whose refusal names check_change (PR #462)", () => {
    expect(chosen(merge("#462"))).toEqual({
      "tests/e2e/check-repair.spec.ts": [
        "scripts check_change, which words src/core/orchestrator/crewSupervisor.ts serves add or remove",
      ],
    });
  });

  it("chooses program-run for project scopes, whose note its pattern reads (PR #470)", () => {
    expect(chosen(merge("#470"))).toEqual({
      "tests/e2e/program-run.spec.ts": [
        'reads "project or" with /project (\\S+)/, words src/core/orchestrator/firstmateAgent.ts serves that the change adds or removes',
      ],
    });
  });

  it("does not count served words that only moved, or a one-word value of the code", () => {
    const real = merge("#470");
    const added = real.sourceDiff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    // The same note removed from one place and added at another serves the same words.
    const moved = [
      ...real.sourceDiff.split("\n"),
      ...added.map((line) => `-${line.slice(1)}`),
    ].join("\n");
    expect(chosen({ ...real, sourceDiff: moved })).toEqual({});
    // The gate's own answer "checked" beside the tool's name is code, not words it serves.
    const repair = merge("#462");
    const header = repair.sourceDiff.slice(0, repair.sourceDiff.indexOf("@@"));
    const value = `${header}@@ -9653 +9653 @@\n-        return "checked";\n+        return "check_change";\n`;
    expect(chosen({ ...repair, sourceDiff: value })).toEqual({});
  });
});
