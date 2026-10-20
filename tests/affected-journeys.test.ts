import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closureOf,
  holdsHook,
  holdsPhrase,
  importsOf,
  select,
  symbolsOfDiff,
  tokensOfDiff,
} from "../scripts/affected-journeys.ts";

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
