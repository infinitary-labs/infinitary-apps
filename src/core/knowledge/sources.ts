import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type {
  ArticleOrigin,
  FileOrigin,
  KnowledgeStore,
  SourceOrigin,
  SourceRow,
} from "../storage/knowledgeStore";
import { actorId, bytes, clean, type KnowledgeActor, MAX, refuse } from "./access";
import type { KnowledgeDeps, KnowledgeHandle } from "./knowledgeService";
import { scanKnowledgeThreat } from "./threatScan";

/**
 * Kept evidence (docs/knowledge.md, "Evidence"): what a write cites - a
 * task's report, a quotation or a short article excerpt - kept as it read
 * before anything is written, and whether each kept source still reads the
 * same where the reader works.
 *
 * Evidence from a working copy is what an older build kept: the host read a
 * cited file inside the crewmate's own working copy and kept the excerpt,
 * its digest and where it came from. It reads text and nothing else - it
 * follows no link out of the working copy, executes nothing and fetches
 * nothing - and it never writes the file. A new write cannot cite a file.
 */

/** The most text one source keeps. */
export const SOURCE_TEXT_MAX_BYTES = 32 * 1024;
/** The largest file the host reads to cite or check. */
export const SOURCE_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** What git says about a file in a working copy: its commit, and whether it differs from it. */
export type GitFacts = (
  root: string,
  path: string,
) => Promise<{ commit: string | null; dirty: boolean }>;

/** What a fresh look at a cited source found. */
export type SourceCheck = {
  state: "unchanged" | "changed" | "missing" | "unknown" | "kept";
  detail: string;
};

export type SourceInput =
  | { kind: "file"; path: string; startLine?: number; endLine?: number }
  | { kind: "report"; task: string }
  | { kind: "quote"; text: string; citation: string }
  | {
      kind: "article";
      url: string;
      title: string;
      excerpt: string;
      author?: string;
      published?: string;
    };

export type SourceView = Omit<SourceRow, "scope"> & { check: SourceCheck };

/** A source a write keeps now: never a file, which stays with its project. */
export type CapturedSource = SourceRow & { origin: Exclude<SourceOrigin, FileOrigin> };

const SOURCE_ID = /^s-[a-z0-9]{6}$/;

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A cited path, relative to its working copy, or the reason it cannot be cited. */
function inside(root: string, path: string): { real: string; rel: string } | string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) return "Give the file's path inside your working copy.";
  if (isAbsolute(trimmed))
    return "Give the path relative to your working copy, not an absolute path.";
  const rel = normalize(trimmed);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return "That path is outside your working copy.";
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) return "Files inside .git cannot be cited.";
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return "Your working copy cannot be read just now.";
  }
  const target = resolve(realRoot, rel);
  let real: string;
  try {
    if (lstatSync(target).isSymbolicLink()) return `${rel} is a link; cite the file itself.`;
    real = realpathSync(target);
  } catch {
    return `${rel} does not exist in your working copy.`;
  }
  // A linked folder on the way would land elsewhere: only the plain path counts.
  if (real !== target || !(real === realRoot || real.startsWith(`${realRoot}${sep}`))) {
    return `${rel} goes through a link; cite the file at its own path.`;
  }
  return { real, rel: relative(realRoot, real) };
}

function readText(path: string): string | undefined {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > SOURCE_FILE_MAX_BYTES) return undefined;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

/**
 * Keep an excerpt of a file in `root`, lines `startLine`..`endLine`
 * (1-based, inclusive; the whole file when neither is given). Returns the
 * kept text and its origin, or the reason it was refused.
 */
export async function captureFile(input: {
  root: string;
  project: string;
  path: string;
  startLine?: number;
  endLine?: number;
  gitFacts: GitFacts;
}): Promise<{ text: string; origin: FileOrigin } | { refused: string }> {
  const place = inside(input.root, input.path);
  if (typeof place === "string") return { refused: place };
  let whole: string | undefined;
  try {
    whole = readText(place.real);
  } catch {
    return { refused: `${place.rel} cannot be read.` };
  }
  if (whole === undefined) {
    return {
      refused: `${place.rel} is not a text file under ${SOURCE_FILE_MAX_BYTES / 1024 / 1024} MB, so it cannot be cited.`,
    };
  }
  const lines = whole.split("\n");
  const count = whole.endsWith("\n") ? lines.length - 1 : lines.length;
  const start = input.startLine ?? 1;
  const end = input.endLine ?? (input.startLine === undefined ? count : start);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { refused: "Give start_line and end_line as line numbers, start first." };
  }
  if (start > count) return { refused: `${place.rel} has only ${count} lines.` };
  const last = Math.min(end, count);
  const text = lines.slice(start - 1, last).join("\n");
  if (Buffer.byteLength(text) > SOURCE_TEXT_MAX_BYTES) {
    return {
      refused: `Lines ${start}-${last} of ${place.rel} are over ${SOURCE_TEXT_MAX_BYTES / 1024} KB; cite fewer lines.`,
    };
  }
  let facts: { commit: string | null; dirty: boolean };
  try {
    facts = await input.gitFacts(input.root, place.rel);
  } catch {
    facts = { commit: null, dirty: true };
  }
  return {
    text,
    origin: {
      kind: "file",
      project: input.project,
      path: place.rel,
      startLine: start,
      endLine: last,
      commit: facts.commit,
      dirty: facts.dirty,
      fileDigest: sha256(whole),
    },
  };
}

/**
 * Whether a cited file still reads as it did, in the working copy `root`
 * the reader works in: unchanged, changed, missing, or unknown when there is
 * no working copy to read. It reads the same path the source names, under
 * the same rules as a citation, and says nothing about whether the finding
 * is still true.
 */
export function checkFile(origin: FileOrigin, root: string | undefined): SourceCheck {
  const at = origin.commit
    ? ` (kept at commit ${origin.commit.slice(0, 10)}${origin.dirty ? " with uncommitted changes" : ""})`
    : "";
  if (!root) return { state: "unknown", detail: `no working copy of this project to compare${at}` };
  const place = inside(root, origin.path);
  if (typeof place === "string") return { state: "missing", detail: `${origin.path} is gone${at}` };
  let whole: string | undefined;
  try {
    whole = readText(place.real);
  } catch {
    return { state: "unknown", detail: `${origin.path} could not be read${at}` };
  }
  if (whole === undefined)
    return { state: "unknown", detail: `${origin.path} is no longer readable text${at}` };
  if (sha256(whole) === origin.fileDigest) {
    return { state: "unchanged", detail: `${origin.path} is unchanged since it was kept` };
  }
  return {
    state: "changed",
    detail: `${origin.path} has changed since it was kept${at}; recheck before relying on it`,
  };
}

/** Read and keep each cited source, before anything is written. */
export async function capture(
  handle: Pick<KnowledgeHandle, "deps" | "now" | "newId">,
  actor: KnowledgeActor,
  scope: string,
  inputs: readonly SourceInput[] | undefined,
): Promise<CapturedSource[]> {
  const list = inputs ?? [];
  if (list.length > MAX.sources) refuse(`Cite at most ${MAX.sources} sources in one write.`);
  const rows: CapturedSource[] = [];
  for (const input of list) {
    const kept = captureOne(handle, actor, input);
    const threat = scanKnowledgeThreat(kept.text);
    if (threat) {
      refuse(`Refused: a cited source matches a ${threat.pattern} pattern; cite text without it.`);
    }
    rows.push({
      id: handle.newId("s"),
      scope,
      kind: kept.origin.kind,
      origin: kept.origin,
      text: kept.text,
      digest: sha256(kept.text),
      actor: actorId(actor),
      capturedAt: handle.now(),
    });
  }
  return rows;
}

function captureOne(
  handle: Pick<KnowledgeHandle, "deps" | "now">,
  actor: KnowledgeActor,
  input: SourceInput,
): { text: string; origin: CapturedSource["origin"] } {
  if (input.kind === "file") {
    refuse(
      "A file in the project stays with the project. Cite a task's report, a quotation, or a short article excerpt.",
    );
  }
  if (input.kind === "article") return captureArticle(handle.now, actor, input);
  if (input.kind === "report") {
    const task = handle.deps.tasks?.resolve(input.task?.trim() ?? "");
    if (!task) refuse(`No task "${input.task}" to cite.`);
    const report = handle.deps.tasks?.reports(task.id).at(-1);
    if (!report) refuse(`${task.key || task.id} has no report to cite yet.`);
    let text = report.text;
    while (bytes(text) > SOURCE_TEXT_MAX_BYTES) text = text.slice(0, Math.floor(text.length * 0.9));
    return {
      text,
      origin: { kind: "report", task: task.id, key: task.key, event: report.id },
    };
  }
  if (input.kind === "quote") {
    const text = clean(input.text, "quote", MAX.quote, true);
    const citation = clean(input.citation, "citation", MAX.citation, true);
    return { text, origin: { kind: "quote", citation } };
  }
  refuse("A source is a task's report, a quotation, or a short article excerpt.");
}

function captureArticle(
  now: () => number,
  actor: KnowledgeActor,
  input: Extract<SourceInput, { kind: "article" }>,
): { text: string; origin: ArticleOrigin } {
  if (actor.kind !== "crewmate") {
    refuse("An article import is a crewmate's write, on the captain's request.");
  }
  const url = clean(input.url, "url", MAX.url, true);
  if (!/^https?:\/\//i.test(url)) refuse("An article source needs an http or https link.");
  const title = clean(input.title, "title", MAX.title, true);
  const excerpt = clean(input.excerpt, "excerpt", MAX.excerpt, true);
  const author = input.author?.trim() ? clean(input.author, "author", MAX.author, true) : null;
  const published = input.published?.trim()
    ? clean(input.published, "published", MAX.published, true)
    : null;
  return {
    text: excerpt,
    origin: { kind: "article", url, title, author, published, retrieved: now() },
  };
}

/** The kept sources these ids name, in the store's order. */
export function keptSources(store: KnowledgeStore, ids: readonly string[]): SourceRow[] {
  return store.sources(ids.filter((id) => SOURCE_ID.test(id)));
}

/** Kept sources as an agent reads them, each checked where `actor` works. */
export function sourceViews(
  store: KnowledgeStore,
  deps: Pick<KnowledgeDeps, "projects" | "tasks">,
  actor: KnowledgeActor,
  ids: readonly string[],
): SourceView[] {
  return keptSources(store, ids).map((row) => {
    const { scope: _scope, ...kept } = row;
    return { ...kept, check: checkSource(deps, actor, row) };
  });
}

/** Whether a kept source still reads the same where the reader works. */
export function checkSource(
  deps: Pick<KnowledgeDeps, "projects" | "tasks">,
  actor: KnowledgeActor,
  row: SourceRow,
): SourceCheck {
  const origin = row.origin;
  if (origin.kind === "file") {
    const root =
      actor.kind === "crewmate" && actor.repoId === origin.project && actor.cwd
        ? actor.cwd
        : deps.projects.get(origin.project)?.path;
    return checkFile(origin, root);
  }
  if (origin.kind === "report") {
    const report = deps.tasks?.reports(origin.task).find((event) => event.id === origin.event);
    if (!report)
      return { state: "unknown", detail: `${origin.key}'s report is no longer on its record` };
    const kept = report.text.startsWith(row.text);
    return kept
      ? { state: "unchanged", detail: `${origin.key}'s report, as recorded` }
      : { state: "changed", detail: `${origin.key}'s report reads differently now` };
  }
  if (origin.kind === "article") {
    const who = origin.author ? `, ${origin.author}` : "";
    const when = origin.published ? `, published ${origin.published}` : "";
    return {
      state: "kept",
      detail: `saved from ${origin.url}${who}${when}; the app does not re-fetch it`,
    };
  }
  return {
    state: "kept",
    detail: `quoted from ${origin.citation}; an attributed quotation, not checked by the app`,
  };
}

/** What a write's answer says it kept: a write cites no file, so none is named. */
export function evidenceLine(sources: readonly CapturedSource[]): string {
  if (sources.length === 0) return "";
  const kept = sources.map((source) => {
    const origin = source.origin;
    if (origin.kind === "report") return `${source.id} ${origin.key}'s report`;
    if (origin.kind === "article") return `${source.id} article ${origin.title} (${origin.url})`;
    return `${source.id} quotation from ${origin.citation}`;
  });
  return ` Evidence kept: ${kept.join("; ")}.`;
}
