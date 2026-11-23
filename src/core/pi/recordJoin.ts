import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * How a Pi conversation's record took in the turns another copy of it holds
 * (`joinRecord`): `continued` when the record had nothing past where the two
 * part, so those turns simply follow; `rejoined` when it had turns of its own
 * since then, which follow those turns again.
 */
export const RECORD_JOINS = ["continued", "rejoined"] as const;
export type RecordJoin = (typeof RECORD_JOINS)[number];

/**
 * Appends to the Pi record at `file` the turns its other copy at `other`
 * gained and it lacks, so the conversation resumes from every turn, in the
 * order they were taken (docs/helper.md, "Holding a conversation"). The two
 * are one conversation when they begin with the same header; they part at the
 * first line that differs. Pi's record is an append-only tree whose current
 * entry is the file's last, so the other copy's later entries are appended as
 * they are, still children of the entry where the two part. Entries this copy
 * wrote after that point are appended again under fresh ids, the first now a
 * child of the other copy's last entry; a compaction among them is left out,
 * since it summarized the conversation without those turns and would drop
 * them. Nothing is removed, `other` is never written, and a record that
 * already holds every line of the other's is left as it is.
 */
export function joinRecord(other: string, file: string): RecordJoin | undefined {
  if (!existsSync(other) || !existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const theirs = linesOf(readFileSync(other, "utf8"));
  const ours = linesOf(text);
  if (theirs[0] === undefined || theirs[0] !== ours[0]) return undefined;
  let shared = 1;
  while (shared < theirs.length && theirs[shared] === ours[shared]) shared++;
  const held = new Set(ours);
  const missing = theirs.slice(shared);
  if (missing.every((line) => held.has(line))) return undefined;

  const parted = idOf(ours[shared - 1]);
  const renamed = new Map<string, string | null>();
  const rename = (id: unknown) =>
    typeof id === "string" && renamed.has(id) ? renamed.get(id) : id;
  let onto: string | null | undefined;
  for (let at = missing.length - 1; onto === undefined && at >= 0; at--) onto = idOf(missing[at]);
  const again: string[] = [];
  for (const line of ours.slice(shared)) {
    const entry = entryOf(line);
    if (!entry || typeof entry.id !== "string") continue;
    const parentId =
      entry.parentId === parted && onto !== undefined ? onto : rename(entry.parentId);
    if (entry.type === "compaction") {
      renamed.set(entry.id, (parentId as string | null | undefined) ?? null);
      continue;
    }
    const id = randomUUID();
    renamed.set(entry.id, id);
    again.push(
      JSON.stringify({
        ...entry,
        id,
        parentId,
        ...("targetId" in entry ? { targetId: rename(entry.targetId) } : {}),
        ...("fromId" in entry ? { fromId: rename(entry.fromId) } : {}),
      }),
    );
  }
  const lead = text.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${lead}${[...missing, ...again].join("\n")}\n`);
  return again.length > 0 ? "rejoined" : "continued";
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function entryOf(line: string | undefined): Record<string, unknown> | undefined {
  if (!line) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The id of the entry on `line`; null for the header, which no entry names as its parent. */
function idOf(line: string | undefined): string | null | undefined {
  const entry = entryOf(line);
  if (!entry) return undefined;
  if (entry.type === "session") return null;
  return typeof entry.id === "string" ? entry.id : undefined;
}
