import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { encodeClaudeProjectDir, locateClaudeTranscript } from "../claude/claudeTranscript";
import {
  type LegacyCalls,
  type Scrubbed,
  type ScrubRule,
  scrubJsonLines,
  scrubText,
  scrubValue,
} from "../storage/outsideDataScrub";

/**
 * The files a saved conversation is kept in, and replacing what is due in
 * them (INF-952, INF-1094; docs/task-retention.md, "Words from outside"):
 * the pass on the home (`SavedOutsideData`) and a computer that runs work,
 * for the conversations it holds (`SessionHost`), read and write them the
 * same way.
 */

/** The text files a saved conversation is kept in; anything else (a picture) has no words to find. */
const TEXT_FILES = new Set([".jsonl", ".json", ".txt", ".md", ".log"]);

/** The Claude client's session id, as the app's copies are named (`SessionRecordStore`). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** What every fenced span or fetched answer starts with, read as bytes before any file is decoded. */
const FENCE_HINT = Buffer.from("[[");
const LEGACY_HINTS = [Buffer.from("use_integration"), Buffer.from("infinitary-integrations-axi")];

/**
 * One kind's words due in a pass, as plain data a computer that runs work
 * can be sent: everything its label fenced and read by `until` goes, and
 * `note` stands where it was.
 */
export type DueKind = { label: string; until: number; note: string };

/** The rule a pass replaces by: a span is due once its kind's `until` is past its read time. */
export function dueRule(kinds: readonly DueKind[]): ScrubRule {
  const byLabel = new Map(kinds.map((kind) => [kind.label, kind]));
  return {
    due: (label, at) => {
      const until = byLabel.get(label)?.until;
      return until !== undefined && at <= until;
    },
    note: (label) => byLabel.get(label)?.note ?? label,
  };
}

/**
 * A crewmate's saved conversation: its record folder, the record its
 * session names when that lies outside it, and the Claude client's own
 * files for each Claude session the folder holds a copy of, where that
 * computer keeps a Claude client's files.
 */
export function conversationFiles(
  conversation: { dir: string; token?: string; cwd: string },
  claude: ClaudeFiles | undefined,
): string[] {
  const { dir, token, cwd } = conversation;
  const files = textFilesUnder(dir);
  if (token?.endsWith(".jsonl") && !files.includes(token) && isFile(token)) files.push(token);
  if (!claude) return files;
  const ids = new Set(sessionIdsIn(dir));
  if (token && SESSION_ID.test(token)) ids.add(token);
  for (const id of ids) files.push(...claude.filesOf(id, cwd));
  return files;
}

/**
 * Where the Claude client keeps a session: its transcript, and the folder
 * beside it with the outputs too long for the transcript and its helpers'
 * own transcripts. A full pass lists the client's folders once rather than
 * searching them for each session.
 */
export class ClaudeFiles {
  private index: Map<string, string> | undefined;

  constructor(
    private readonly configDir: string,
    private readonly listAll: boolean,
  ) {}

  filesOf(sessionId: string, cwd: string): string[] {
    const transcript = this.locate(sessionId, cwd);
    if (!transcript) return [];
    return [transcript, ...textFilesUnder(join(dirname(transcript), sessionId))];
  }

  private locate(sessionId: string, cwd: string): string | null {
    if (!this.listAll) return locateClaudeTranscript({ configDir: this.configDir, cwd, sessionId });
    const direct = join(
      this.configDir,
      "projects",
      encodeClaudeProjectDir(cwd),
      `${sessionId}.jsonl`,
    );
    if (isFile(direct)) return direct;
    this.index ??= this.list();
    return this.index.get(sessionId) ?? null;
  }

  private list(): Map<string, string> {
    const index = new Map<string, string>();
    const projects = join(this.configDir, "projects");
    for (const dir of entriesOf(projects)) {
      for (const name of entriesOf(join(projects, dir))) {
        if (name.endsWith(".jsonl"))
          index.set(name.slice(0, -".jsonl".length), join(projects, dir, name));
      }
    }
    return index;
  }
}

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Every text file under a folder, never following a link. */
export function textFilesUnder(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of entriesOf(at)) {
      const path = join(at, name);
      let kind: ReturnType<typeof lstatSync>;
      try {
        kind = lstatSync(path);
      } catch {
        continue;
      }
      if (kind.isDirectory()) walk(path);
      else if (kind.isFile() && TEXT_FILES.has(extname(name))) files.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** The Claude session ids the app holds copies of in a record folder. */
export function sessionIdsIn(dir: string): string[] {
  return entriesOf(dir)
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".served.jsonl"))
    .map((name) => basename(name, ".jsonl"))
    .filter((id) => SESSION_ID.test(id) && !id.includes("_"));
}

/** A file's words with what is due replaced, by what kind of file it is. */
function scrubFile(
  file: string,
  content: string,
  rule: ScrubRule,
  legacy: readonly LegacyCalls[],
  at: number,
): Scrubbed<string> {
  const kind = extname(file);
  if (kind === ".jsonl") return scrubJsonLines(content, rule, { at, legacy });
  if (kind === ".json") {
    try {
      const done = scrubValue(JSON.parse(content), rule, at);
      return done.replaced
        ? { value: JSON.stringify(done.value), replaced: done.replaced }
        : { value: content, replaced: 0 };
    } catch {
      // Not JSON after all: its text, as written.
    }
  }
  return scrubText(content, rule, at);
}

/** Whether a file holds anything due, reading it without changing it. */
export async function dueIn(
  file: string,
  rule: ScrubRule,
  legacy: readonly LegacyCalls[],
  since: number | undefined,
): Promise<boolean> {
  let facts: Awaited<ReturnType<typeof stat>>;
  try {
    facts = await stat(file);
  } catch {
    return false;
  }
  if (since !== undefined && facts.mtimeMs < since) return false;
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return false;
  }
  const hinted =
    bytes.includes(FENCE_HINT) ||
    (legacy.length > 0 && LEGACY_HINTS.some((hint) => bytes.includes(hint)));
  if (!hinted) return false;
  return scrubFile(file, bytes.toString("utf8"), rule, legacy, facts.mtimeMs).replaced > 0;
}

/**
 * Write a file again with what is due replaced: read, replaced and renamed
 * into place in one go, keeping its mode. Answers how many it replaced.
 */
export function rewrite(file: string, rule: ScrubRule, legacy: readonly LegacyCalls[]): number {
  let facts: ReturnType<typeof statSync>;
  let content: string;
  try {
    facts = statSync(file);
    content = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const done = scrubFile(file, content, rule, legacy, facts.mtimeMs);
  if (done.replaced === 0) return 0;
  const temp = `${file}.${process.pid}.outside`;
  writeFileSync(temp, done.value, { mode: facts.mode & 0o777 });
  renameSync(temp, file);
  return done.replaced;
}
