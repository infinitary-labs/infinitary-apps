import { CLAUDE_CREWMATE_MARKER } from "./mockProvider";

/** The two crewmate runtimes the unsafe data reader journey runs on, with the tools each session holds and lacks. */
export const READER_RUNTIMES = [
  {
    name: "Pi",
    claude: false,
    suffix: "",
    reads: ["read", "grep", "ls"],
    gone: ["bash", "write", "edit", "find", "read_card", "tasks", "knowledge"],
  },
  {
    name: "Claude",
    claude: true,
    suffix: ` ${CLAUDE_CREWMATE_MARKER}`,
    reads: ["Read", "Grep", "Glob"],
    gone: ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"],
  },
];

/** Words between reader-data marks, as a request's JSON text carries them. */
export function readerMarked(words: string): RegExp {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\[reader-data fence=[0-9a-f]{16} [^\\]]*\\]\\][^\\[]*${escaped}`);
}

/**
 * How many copies of `words` a request's JSON text holds, and how many of
 * them sit outside every reader-data span (from its opening mark to the
 * closing mark with the same fence).
 */
export function copiesOf(raw: string, words: string): { total: number; unmarked: number } {
  const spans = [
    ...raw.matchAll(
      /\[\[reader-data fence=([0-9a-f]{16})[^\]]*\]\][\s\S]*?\[\[\/reader-data fence=\1\]\]/g,
    ),
  ].map((span): [number, number] => [span.index, span.index + span[0].length]);
  let total = 0;
  let unmarked = 0;
  for (let at = raw.indexOf(words); at >= 0; at = raw.indexOf(words, at + words.length)) {
    total += 1;
    if (!spans.some(([start, end]) => start < at && at + words.length <= end)) unmarked += 1;
  }
  return { total, unmarked };
}

/** The first of `requests` that is a first mate's turn (it offers spawn_crewmate) and holds `words`. */
export function firstmateTurnWith(requests: string[], words: string): string | undefined {
  return requests.find((raw) => raw.includes("spawn_crewmate") && raw.includes(words));
}
