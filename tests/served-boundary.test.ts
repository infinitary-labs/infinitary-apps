import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderIntentBrief,
  renderReviewBrief,
  renderRigorSection,
} from "../src/core/orchestrator/intentBrief";
import { renderWake, type WakeFacts } from "../src/core/orchestrator/wakes";
import { PERSONAL_AGENTS_MD } from "../src/core/personal/seed/agentsMd";
import { SEQUENCES_SEED } from "../src/core/personal/sequencesSkill";
import { CREWMATE_TOOLS } from "../src/core/pi/crewmateTaskTools";
import {
  buildCrewmateSystemPrompt,
  buildFirstmateSystemPrompt,
  buildKindClassifierInstruction,
  type CrewmateBackend,
  type CrewmateProcedureFacts,
  crewmateCardBodiesNote,
} from "../src/core/pi/piResources";
import { piToolsOf } from "../src/core/pi/toolSpec";
import { SETTING_PREFIXES } from "../src/shared/envSettings";
import { firstmateTools } from "./helpers/firstmateTools";

/**
 * INF-1553, the captain's ask after INF-1549 wrote this repository's own
 * signing setup into the rule every user's crewmates are served: "i want that
 * task to start with an audit for whether we already have such mix ups in the
 * codebase". The text the app serves - the two personas' prompts, each tool's
 * description and parameters, the briefs, the wakes, the kind classifier's
 * instruction and the personal workspace's seed - speaks for every project,
 * never for this repository's CI, Mac mini, signing, releases, tests or
 * scripts (docs/orchestrator-contract.md, "What the served text may name").
 *
 * What a sentence means is judged in review and measured by replay, never
 * matched against a word list. This test holds only the part that is a fact
 * of the tree: a served text names no file this repository tracks, no
 * workflow of its own, and no INFINITARY_ setting the app itself never reads.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const RUNTIMES: (CrewmateBackend | undefined)[] = [undefined, "pi", "claude"];
const KINDS: (CrewmateProcedureFacts | undefined)[] = [
  undefined,
  { delivery: "direct-pr", rigor: "standard" },
  { delivery: "direct-pr", rigor: "reviewed" },
  { delivery: "direct-pr", rigor: "quick" },
  { delivery: "local-only", rigor: "standard" },
  { delivery: "local-only", rigor: "reviewed" },
  { delivery: "local-only", rigor: "quick" },
  { delivery: "none", rigor: "none" },
];

const BUILDER = { id: "t1", title: "Fix the pin" };
const WAKES: WakeFacts[] = [
  {
    kind: "review-verdict",
    task: { id: "r1", title: "Review: Fix the pin" },
    builder: BUILDER,
    crewmate: "crewmate 2",
    verdict: "findings",
    excerpt: "verdict: findings",
    cards: [],
  },
  { kind: "captain-start", task: { ...BUILDER, key: "FI3-8" }, move: "start", at: 0 },
  { kind: "ci-cap", task: BUILDER, rounds: 3, cap: 3, head: "0123456789ab" },
];

type Served = { surface: string; text: string };

/** Every text a user's first mate or crewmate is served, named by its surface. */
async function servedTexts(): Promise<Served[]> {
  const served: Served[] = [];
  for (const runtime of RUNTIMES) {
    for (const kind of KINDS) {
      served.push({
        surface: `crewmate prompt (${runtime ?? "unplaced"}, ${kind ? `${kind.delivery}/${kind.rigor}` : "unknown"})`,
        text: buildCrewmateSystemPrompt(runtime, undefined, undefined, undefined, undefined, kind),
      });
    }
  }
  served.push({ surface: "crewmate card bodies note", text: crewmateCardBodiesNote("/tmp/cards") });
  for (const tool of CREWMATE_TOOLS) {
    served.push({ surface: `crewmate tool ${tool.name}`, text: tool.description });
    served.push({
      surface: `crewmate tool ${tool.name} parameters`,
      text: JSON.stringify(tool.parameters),
    });
  }
  for (const tier of ["quick", "standard", "reviewed"] as const) {
    served.push({ surface: `rigor section ${tier}`, text: renderRigorSection(tier) });
  }
  served.push({ surface: "first mate prompt", text: buildFirstmateSystemPrompt() });
  served.push({ surface: "sequences seed", text: SEQUENCES_SEED });
  for (const tool of piToolsOf(await firstmateTools())) {
    served.push({ surface: `first mate tool ${tool.name}`, text: tool.description });
    served.push({
      surface: `first mate tool ${tool.name} parameters`,
      text: JSON.stringify(tool.parameters),
    });
  }
  served.push({ surface: "kind classifier instruction", text: buildKindClassifierInstruction() });
  served.push({ surface: "personal workspace seed", text: PERSONAL_AGENTS_MD });
  const intent = { goal: "Fix the pin", userWords: "make the pin stop moving" };
  served.push({ surface: "builder brief", text: renderIntentBrief(intent, "direct-pr") });
  served.push({
    surface: "review brief",
    text: renderReviewBrief(intent, "direct-pr", {
      builderTitle: "Fix the pin",
      branch: "fm/task-abc12345",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      changedFiles: ["src/pin.ts"],
      builderReport:
        "Intent: the pin stays. What changed: one line. Verified: ten runs. Risk: low.",
    }),
  });
  for (const facts of WAKES) {
    served.push({ surface: `wake ${facts.kind}`, text: renderWake({ facts }) });
  }
  return served;
}

/** Something written like a path with at least one folder: `tests/a.ts`, `.github/workflows/ci.yml`. */
const PATH_LIKE = /(?<![\w/~.@-])((?:\.?[\w-]+\/)+[\w.-]*\w)/g;

/** A file this repository tracks; a folder's name alone, such as `.claude/skills`, is any project's. */
function isRepositoryFile(candidate: string): boolean {
  const path = join(ROOT, candidate);
  return existsSync(path) && statSync(path).isFile();
}
const WORKFLOW_LIKE = /\b[\w-]+\.ya?ml\b/g;
/** The app's setting prefixes, as its one reader names them. */
const PREFIX = `(?:${SETTING_PREFIXES.map((prefix) => prefix.replace(/_$/, "")).join("|")})`;
const SETTING_LIKE = new RegExp(`\\b${PREFIX}_([A-Z0-9_]+)\\b`, "g");

function appSources(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Whether the app itself reads a setting: through `settingFrom` (the one
 * reader, `src/shared/envSettings.ts`), off an environment it holds
 * (`process.env.INFINITARY_<NAME>`, `env["INFINITARY_<NAME>"]`), or as the
 * key of an environment it builds. A name that appears only in a served
 * sentence, a script or a test is not the app's.
 */
function appReads(name: string, sources: string[]): boolean {
  const setting = `${PREFIX}_${name}`;
  const reader = new RegExp(
    [
      `settingFrom\\([^)]*"${name}"\\)`,
      `\\.${setting}\\b`,
      `\\["${setting}"\\]`,
      `(?:^|[\\s{,])"?${setting}"?\\s*:`,
    ].join("|"),
    "m",
  );
  return sources.some((file) => reader.test(readFileSync(file, "utf8")));
}

describe("what the app serves speaks for every project (INF-1553)", () => {
  it("names no file this repository tracks", async () => {
    const leaks: string[] = [];
    for (const { surface, text } of await servedTexts()) {
      for (const match of text.matchAll(PATH_LIKE)) {
        const candidate = match[1] ?? "";
        if (isRepositoryFile(candidate)) leaks.push(`${surface}: ${candidate}`);
      }
    }
    expect(leaks, "a served text names this repository's own files").toEqual([]);
  });

  it("names no workflow of this repository", async () => {
    const leaks: string[] = [];
    for (const { surface, text } of await servedTexts()) {
      for (const match of text.matchAll(WORKFLOW_LIKE)) {
        if (existsSync(join(ROOT, ".github", "workflows", match[0])))
          leaks.push(`${surface}: ${match[0]}`);
      }
    }
    expect(leaks, "a served text names this repository's own workflows").toEqual([]);
  });

  it("names no setting the app itself never reads", async () => {
    const sources = appSources();
    const leaks: string[] = [];
    for (const { surface, text } of await servedTexts()) {
      for (const match of text.matchAll(SETTING_LIKE)) {
        if (!appReads(match[1] ?? "", sources)) leaks.push(`${surface}: ${match[0]}`);
      }
    }
    expect(
      leaks,
      "a served text names a setting only this repository's scripts or tests read",
    ).toEqual([]);
  });
});
