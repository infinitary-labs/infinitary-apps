import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGET_TEST_NAME, BUDGET_TESTS } from "./prompt-budget.ts";

/**
 * Lists every served sentence a change removed or altered, before and after,
 * for the first mate's and a crewmate's instructions (docs/orchestrator-contract.md,
 * "How a trim works"). It reads the text the prompt-budget measurement counts:
 * the budget tests run with `SERVED_TEXT_OUT` set, and
 * `tests/helpers/promptBudget.ts` writes each reading's prompt and tools.
 *
 *   node scripts/served-sentences.ts [--base <rev>] [--head <rev>] [--json]
 *
 * The base defaults to where the working copy left `origin/main`; the head
 * defaults to the working copy itself. The script only lists: the trimmer
 * marks each sentence kept, moved or dropped, and the reviewer judges the marks.
 */

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK_FILE = "tests/helpers/promptBudget.ts";

export type ServedReading = { label: string; systemPrompt: string; tools: unknown };
export type ServedSet = Record<string, ServedReading[]>;

/** One sentence where a seat is served it: the prompt or a tool's text. */
type Placed = { where: string; sentence: string };

type Change = {
  before: string;
  where: string;
  /** Absent when no served sentence now resembles it. */
  after?: { sentence: string; where: string };
  /** Prompt readings that lost it; tool text is the same for every reading. */
  readings: string[];
};

export type SeatChanges = {
  seat: string;
  readings: { before: string[]; after: string[] };
  removedOrAltered: Change[];
  added: Placed[];
};

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    // An ellipsis, as in "git -c user.name=... -c", does not end a sentence.
    .flatMap((line) => line.replace(/\s+/g, " ").trim().split(/(?<=[^.][.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[A-Za-z]/.test(sentence));
}

type Schema = { description?: unknown; properties?: Record<string, Schema>; items?: Schema };

function toolSentences(tools: unknown): Placed[] {
  const found: Placed[] = [];
  const walk = (where: string, schema: Schema | undefined) => {
    if (!schema || typeof schema !== "object") return;
    if (typeof schema.description === "string")
      for (const sentence of splitSentences(schema.description)) found.push({ where, sentence });
    for (const [name, child] of Object.entries(schema.properties ?? {}))
      walk(`${where} · ${name}`, child);
    if (schema.items) walk(`${where} · items`, schema.items);
  };
  for (const tool of (tools ?? []) as { name?: string; description?: string; parameters?: Schema }[]) {
    const where = `tool ${tool.name ?? "?"}`;
    for (const sentence of splitSentences(tool.description ?? "")) found.push({ where, sentence });
    walk(where, tool.parameters);
  }
  return found;
}

/** Each placed sentence once, with the readings that are served it. */
function placedSentences(readings: ServedReading[]): Map<string, Placed & { readings: string[] }> {
  const map = new Map<string, Placed & { readings: string[] }>();
  for (const reading of readings) {
    const placed = [
      ...splitSentences(reading.systemPrompt).map((sentence) => ({ where: "prompt", sentence })),
      ...toolSentences(reading.tools),
    ];
    for (const item of placed) {
      const key = `${item.where}\u0000${item.sentence}`;
      const entry = map.get(key) ?? { ...item, readings: [] };
      if (!entry.readings.includes(reading.label)) entry.readings.push(reading.label);
      map.set(key, entry);
    }
  }
  return map;
}

/** Shared words in order, as a share of both sentences' words: 1 is the same sentence. */
export function likeness(a: string, b: string): number {
  const x = a.toLowerCase().split(/\s+/);
  const y = b.toLowerCase().split(/\s+/);
  const row = new Array<number>(y.length + 1).fill(0);
  for (const word of x) {
    let diagonal = 0;
    for (let j = 1; j <= y.length; j++) {
      const above = row[j] ?? 0;
      row[j] = word === y[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0);
      diagonal = above;
    }
  }
  return (2 * (row[y.length] ?? 0)) / (x.length + y.length);
}

/** Below this, an added sentence is not offered as the after of a removed one. */
const ALTERED_LIKENESS = 0.5;

export function compareSeat(
  seat: string,
  before: ServedReading[],
  after: ServedReading[],
): SeatChanges {
  const was = placedSentences(before);
  const now = placedSentences(after);
  const afterLabels = new Set(after.map((reading) => reading.label));
  const added = [...now.entries()]
    .filter(([key]) => !was.has(key))
    .map(([, item]) => ({ where: item.where, sentence: item.sentence }));
  const removedOrAltered: Change[] = [];
  for (const [key, item] of was) {
    const kept = now.get(key);
    // A prompt sentence still served to every reading it was served to, and
    // to each reading that remains, is unchanged.
    const lost = item.readings.filter(
      (label) => afterLabels.has(label) && !(kept?.readings.includes(label) ?? false),
    );
    if (kept && lost.length === 0) continue;
    if (!kept && lost.length === 0) continue;
    const moved = added.find((other) => other.sentence === item.sentence);
    let best: { sentence: string; where: string; score: number } | undefined = moved
      ? { ...moved, score: 1 }
      : undefined;
    if (!best)
      for (const other of added) {
        const score =
          likeness(item.sentence, other.sentence) - (other.where === item.where ? 0 : 0.1);
        if (score >= ALTERED_LIKENESS && score > (best?.score ?? 0)) best = { ...other, score };
      }
    removedOrAltered.push({
      before: item.sentence,
      where: item.where,
      after: best && { sentence: best.sentence, where: best.where },
      readings: lost,
    });
  }
  return {
    seat,
    readings: {
      before: before.map((reading) => reading.label),
      after: after.map((reading) => reading.label),
    },
    removedOrAltered,
    added,
  };
}

export function compareServed(before: ServedSet, after: ServedSet): SeatChanges[] {
  const seats = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return seats.map((seat) => compareSeat(seat, before[seat] ?? [], after[seat] ?? []));
}

export function renderChanges(changes: SeatChanges[]): string {
  const lines: string[] = [];
  for (const seat of changes) {
    const all = seat.readings.before.filter((label) => seat.readings.after.includes(label));
    lines.push(`## ${seat.seat}`, "");
    const gone = seat.readings.before.filter((label) => !seat.readings.after.includes(label));
    const fresh = seat.readings.after.filter((label) => !seat.readings.before.includes(label));
    if (gone.length) lines.push(`Readings no longer measured: ${gone.join(", ")}.`);
    if (fresh.length) lines.push(`Readings measured only now: ${fresh.join(", ")}.`);
    lines.push(`Removed or altered sentences: ${seat.removedOrAltered.length}.`, "");
    seat.removedOrAltered.forEach((change, index) => {
      const served =
        change.where !== "prompt" || change.readings.length === all.length
          ? ""
          : ` (in ${change.readings.join(", ")})`;
      lines.push(`${index + 1}. ${change.where}${served}`);
      lines.push(`   - Before: ${change.before}`);
      lines.push(
        change.after
          ? `   - After${change.after.where === change.where ? "" : ` (${change.after.where})`}: ${change.after.sentence}`
          : "   - After: no served sentence resembles it",
      );
      lines.push("   - Mark: kept, moved (quote its new place) or dropped");
    });
    if (seat.added.length) {
      lines.push("", `Added sentences: ${seat.added.length}.`, "");
      for (const item of seat.added) lines.push(`- ${item.where}: ${item.sentence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** The budget tests' served text in a tree, read through the measurement hook. */
function readServed(tree: string, scratch: string): ServedSet {
  const out = join(scratch, "served");
  const vitest = join(ROOT, "node_modules", ".bin", "vitest");
  const result = spawnSync(
    vitest,
    ["run", "--retry", "0", "--testNamePattern", BUDGET_TEST_NAME, ...BUDGET_TESTS],
    { cwd: tree, env: { ...process.env, SERVED_TEXT_OUT: out }, encoding: "utf8" },
  );
  const set: ServedSet = {};
  for (const seat of ["Crewmate", "First mate"]) {
    const file = join(out, `${seat}.json`);
    // A reading over its line fails the test after the hook wrote its text,
    // so only a missing file means the measurement did not run.
    if (!existsSync(file))
      throw new Error(`No served text for ${seat} in ${tree}:\n${result.stdout}\n${result.stderr}`);
    set[seat] = JSON.parse(readFileSync(file, "utf8")) as ServedReading[];
  }
  return set;
}

/** A version's served text, read from an unpacked copy of it beside this working copy's packages. */
function servedAt(rev: string): ServedSet {
  const scratch = mkdtempSync(join(tmpdir(), "served-sentences-"));
  try {
    const tree = join(scratch, "tree");
    run("mkdir", ["-p", tree], ROOT);
    const archive = spawnSync(
      "sh",
      [
        "-c",
        'git archive "$1" -- . ":!ios" ":!docs-site" ":!store" | tar -x -C "$2"',
        "sh",
        rev,
        tree,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (archive.status !== 0) throw new Error(`Could not unpack ${rev}: ${archive.stderr}`);
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    // Versions before the hook are read through this one; their tests already
    // count every reading through `fixedTokens` and hand them to `overLine`.
    if (!readFileSync(join(tree, HOOK_FILE), "utf8").includes("SERVED_TEXT_OUT"))
      copyFileSync(join(ROOT, HOOK_FILE), join(tree, HOOK_FILE));
    if (existsSync(join(tree, "scripts", "generate-messages.ts")))
      run("node", ["scripts/generate-messages.ts", "--compiled"], tree);
    return readServed(tree, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function servedInWorkingCopy(): ServedSet {
  const scratch = mkdtempSync(join(tmpdir(), "served-sentences-"));
  try {
    return readServed(ROOT, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function main(args: string[]): void {
  const base = option(args, "--base") ?? run("git", ["merge-base", "HEAD", "origin/main"], ROOT).trim();
  const head = option(args, "--head");
  const changes = compareServed(servedAt(base), head ? servedAt(head) : servedInWorkingCopy());
  process.stdout.write(
    args.includes("--json")
      ? `${JSON.stringify(changes, null, 2)}\n`
      : `# Served sentences removed or altered\n\nBase ${base}, head ${head ?? "the working copy"}.\n\n${renderChanges(changes)}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
