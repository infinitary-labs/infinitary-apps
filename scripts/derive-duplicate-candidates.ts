/**
 * WI-20 - the duplicate-candidate deriver (interaction-system program P3;
 * plan `fm3000-interaction-sys-improve-s1/implementation-plan.md` section 3).
 *
 * For every card on a task, look back over the cards the same task showed
 * earlier inside a window (default 30 minutes). A pair whose title or whole
 * text overlaps above a simple similarity (`cardSimilarity` in
 * `scripts/interaction-metrics.ts`, the same function the replay harness
 * scores `duplicate_card_pairs` with) is a **candidate duplicate**.
 *
 * Offline, tables-only, zero UI - the same shape as the C2 miss deriver.
 * Reads the `cards` table (and `tasks` for titles); writes an OUTPUT
 * ARTIFACT (JSONL), never the captain's `duplicate_of` / `duplicate_note` /
 * `duplicate_at` stamp (WI-14). Every record is weak and unconfirmed, and a
 * pair this deriver did NOT emit is no confirmed negative either: similar
 * wording is not the same card, and different wording can be.
 *
 * Run it (Node 24 strips the types):
 *   pnpm derive:duplicates --db /path/to/firstmate.db --out candidates.jsonl
 *   pnpm derive:duplicates --user-data /path/to/exported/userData --out candidates.jsonl
 *   pnpm derive:duplicates --db tests/fixtures/replay/sep14/tables.json
 *
 * The live firstmate.db lives on whichever machine the captain dogfoods on,
 * so every input is a parameter: point `--db` (or `--user-data`) at an
 * exported copy, or at a scrubbed `tables.json` dump, and the run is the same.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDeep, redactObserveText } from "../src/core/observe/redact.ts";
import { defaultUserDataDir } from "./extract-dispatch-corpus.ts";
import {
  DUPLICATE_SIMILARITY,
  DUPLICATE_WINDOW_MS,
  duplicatePairs,
  type PairableCard,
} from "./interaction-metrics.ts";
import {
  numberColumn,
  type RecordedTables,
  readRecordedTables,
  stringColumn,
} from "./recorded-tables.ts";

export type CandidateCard = {
  card_id: string;
  kind: string;
  title: string;
  created_at: number;
  resolved_at: number | null;
  chosen_action: string | null;
  /** Firstmate cards carry the `card-fm-` prefix; everything else a crewmate or the host emitted. */
  author: "firstmate" | "other";
};

export type DuplicateCandidate = {
  id: string;
  task_id: string;
  task_title: string | null;
  first: CandidateCard;
  second: CandidateCard;
  similarity: number;
  gap_ms: number;
  window_ms: number;
  threshold: number;
  /**
   * Observation only: the captain may already have stamped the later card
   * (WI-14). This deriver never writes that column, and a stamp does not
   * make this candidate confirmed - it is a different, captain-gated path.
   */
  captain_stamped: boolean;
  label: {
    kind: "duplicate_card";
    weak: true;
    confirmed: false;
    confidence: "unconfirmed";
  };
};

export type DeriveOptions = {
  windowMs?: number;
  threshold?: number;
};

/**
 * The host's reserved settle verbs before cards/tasks/agents P1, when an
 * action id carried the meaning; since P1 a settle is a declared `effect`
 * and the id is a name, so both readings count. A card offering a settle is
 * the task's settle moment; its plan decision and its settle decision read
 * alike on the same task (the one false positive on the real database) but
 * are two different questions, so a settle card never pairs.
 */
export const SETTLE_ACTION_IDS: ReadonlySet<string> = new Set(["merge-pr", "land", "keep", "discard"]);

function offersSettle(actionsJson: string | null): boolean {
  if (!actionsJson) return false;
  try {
    const actions = JSON.parse(actionsJson) as unknown;
    return (
      Array.isArray(actions) &&
      actions.some((action) => {
        if (action === null || typeof action !== "object") return false;
        const { id, effect } = action as { id?: unknown; effect?: { kind?: unknown } };
        return SETTLE_ACTION_IDS.has(String(id)) || effect?.kind === "settle";
      })
    );
  } catch {
    return false;
  }
}

/** The cards table rows a pair can be made of: on a task, with a body, offering no settle verb. */
export function pairableCards(tables: RecordedTables): Map<string, PairableCard & CandidateCard> {
  const cards = new Map<string, PairableCard & CandidateCard>();
  for (const row of tables.cards) {
    const id = stringColumn(row, "id");
    const taskId = stringColumn(row, "task_id");
    const createdAt = numberColumn(row, "created_at");
    if (!id || !taskId || createdAt === null) continue;
    if (offersSettle(stringColumn(row, "actions_json"))) continue;
    const title = stringColumn(row, "title") ?? "";
    cards.set(id, {
      id,
      taskId,
      createdAt,
      title,
      body: stringColumn(row, "body") ?? "",
      card_id: id,
      kind: stringColumn(row, "kind") ?? "",
      created_at: createdAt,
      resolved_at: numberColumn(row, "resolved_at"),
      chosen_action: stringColumn(row, "chosen_action"),
      author: id.startsWith("card-fm-") ? "firstmate" : "other",
    });
  }
  return cards;
}

/** Pure derivation over already-loaded tables. The CLI reads; tests fixture. */
export function deriveFromTables(
  tables: RecordedTables,
  options: DeriveOptions = {},
): DuplicateCandidate[] {
  const windowMs = options.windowMs ?? DUPLICATE_WINDOW_MS;
  const threshold = options.threshold ?? DUPLICATE_SIMILARITY;
  const cards = pairableCards(tables);
  const stamps = new Map<string, string>();
  for (const row of tables.cards) {
    const id = stringColumn(row, "id");
    const of = stringColumn(row, "duplicate_of");
    if (id && of) stamps.set(id, of);
  }
  const titles = new Map<string, string>();
  for (const row of tables.tasks) {
    const id = stringColumn(row, "id");
    if (id) titles.set(id, stringColumn(row, "title") ?? "");
  }
  return duplicatePairs([...cards.values()], { windowMs, threshold }).map((pair) => {
    const first = cards.get(pair.first) as CandidateCard;
    const second = cards.get(pair.second) as CandidateCard;
    return {
      id: `pair:${pair.first}|${pair.second}`,
      task_id: pair.taskId,
      task_title: titles.has(pair.taskId) ? redactObserveText(titles.get(pair.taskId) ?? "") : null,
      first: publicCard(first),
      second: publicCard(second),
      similarity: Math.round(pair.similarity * 10_000) / 10_000,
      gap_ms: pair.gapMs,
      window_ms: windowMs,
      threshold,
      captain_stamped: stamps.get(pair.second) === pair.first,
      label: { kind: "duplicate_card", weak: true, confirmed: false, confidence: "unconfirmed" },
    };
  });
}

function publicCard(card: CandidateCard): CandidateCard {
  return {
    card_id: card.card_id,
    kind: card.kind,
    title: redactObserveText(card.title),
    created_at: card.created_at,
    resolved_at: card.resolved_at,
    chosen_action: card.chosen_action,
    author: card.author,
  };
}

export type DeriveResult = {
  candidates: DuplicateCandidate[];
  dbPath: string;
  windowMs: number;
  threshold: number;
  cardCount: number;
};

export function deriveDuplicateCandidates(
  dbPath: string,
  options: DeriveOptions = {},
): DeriveResult {
  const resolved = resolve(dbPath);
  const tables = readRecordedTables(resolved);
  return {
    candidates: deriveFromTables(tables, options),
    dbPath: resolved,
    windowMs: options.windowMs ?? DUPLICATE_WINDOW_MS,
    threshold: options.threshold ?? DUPLICATE_SIMILARITY,
    cardCount: tables.cards.length,
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export type CliArgs = {
  userData: string;
  dbPath: string;
  out: string | null;
  windowMinutes: number;
  threshold: number;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let dbPath: string | null = null;
  let out: string | null = null;
  let windowMinutes = DUPLICATE_WINDOW_MS / 60_000;
  let threshold = DUPLICATE_SIMILARITY;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const positive = (raw: string, max = Number.POSITIVE_INFINITY) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
        throw new Error(`${arg} needs a number in (0, ${max}], got ${raw}`);
      }
      return parsed;
    };
    if (arg === "--") continue;
    if (arg === "--user-data") userData = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--window-minutes") windowMinutes = positive(next());
    else if (arg === "--threshold") threshold = positive(next(), 1);
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    userData,
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    out,
    windowMinutes,
    threshold,
    help,
  };
}

const USAGE = `Derive weak duplicate-card candidates (interaction P3, WI-20) from firstmate.db.

  pnpm derive:duplicates [options]      (or: node scripts/derive-duplicate-candidates.ts)

  --user-data <dir>       app userData dir (default: the platform userData path,
                          or INFINITARY_USER_DATA_DIR); an exported copy works too
  --db <path>             firstmate.db, or a scrubbed tables.json dump
                          (default: <user-data>/firstmate.db)
  --window-minutes <n>    a later card pairs with earlier ones this recent (default: 30)
  --threshold <0-1>       minimum title or whole-card similarity (default: 0.5)
  --out, -o <path>        write JSONL here (default: stdout)
  --help, -h

Reads the cards and tasks tables only. Never writes duplicate_of /
duplicate_note / duplicate_at (the captain's stamp). Every candidate is weak
and unconfirmed, and an unpaired card is no confirmed negative. Nothing
leaves this machine.`;

export function summarize(result: DeriveResult): string {
  const stamped = result.candidates.filter((candidate) => candidate.captain_stamped).length;
  return [
    `db: ${result.dbPath}`,
    `window: ${result.windowMs / 60_000}m, threshold: ${result.threshold}`,
    `cards: ${result.cardCount}`,
    `candidates: ${result.candidates.length} (weak, unconfirmed; ${stamped} already captain-stamped)`,
  ].join("\n");
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!existsSync(args.dbPath)) {
    process.stderr.write(
      `No database at ${args.dbPath}. Point --db or --user-data at an exported copy.\n`,
    );
    return 1;
  }
  let result: DeriveResult;
  try {
    result = deriveDuplicateCandidates(args.dbPath, {
      windowMs: args.windowMinutes * 60_000,
      threshold: args.threshold,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  const jsonl =
    result.candidates.length === 0
      ? ""
      : `${result.candidates.map((row) => JSON.stringify(redactDeep(row))).join("\n")}\n`;
  if (args.out) {
    writeFileSync(args.out, jsonl);
    process.stderr.write(`${summarize(result)}\nwrote: ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
    process.stderr.write(`${summarize(result)}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
