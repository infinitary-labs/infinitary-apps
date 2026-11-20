import { secretRefSchema } from "@shared/secrets";

/**
 * What an MCP server runs (docs/integrations.md, "MCP servers"): the
 * person's one line, read as a server's address when it starts with
 * http:// or https://, and otherwise as a program with its arguments -
 * words split the way a shell splits them, quotes kept together, with
 * any NAME=value words before the program set in its environment. No
 * shell ever reads the line, so a pipe, a redirect or a second command
 * is refused rather than passed on as a word. A value written
 * NAME={secret:REF} names a key kept in Secrets (docs/integrations.md,
 * "Keys"): the line keeps only the reference, and the program gets the
 * key as it starts. PATH is a setting, never a key: it decides which
 * program runs, so it stays on the line as written.
 */

export type McpRuns =
  | { kind: "address"; url: string }
  | {
      kind: "program";
      command: string;
      args: string[];
      env: Record<string, string>;
      /** Each variable a kept key goes in, by its reference in Secrets. */
      keys: Record<string, string>;
      /** Where the NAME=value words end in the line, so a writer keeps the rest as written. */
      assignmentsEnd: number;
    };

/** The line could not be read; the message says why in the person's words. */
export class McpRunsError extends Error {}

const SHELL_ONLY = new Set(["|", "&", ";", "<", ">", "`", "$"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
/** A kept key's reference, in the format Secrets gives one (`secretRefSchema`). */
const KEPT = /^\{secret:([^{}]+)\}$/;
/**
 * The variables that stay on the line as written, never kept in Secrets: the
 * program is found, checked and run with them, so each is part of which
 * program runs rather than a key it is given.
 */
export const STAYS_ON_LINE: ReadonlySet<string> = new Set(["PATH"]);

/** The reference a NAME={secret:REF} value names, or undefined for a plain value. */
function keptRef(value: string): string | undefined {
  const ref = KEPT.exec(value)?.[1];
  return ref !== undefined && secretRefSchema.safeParse(ref).success ? ref : undefined;
}

export function parseRuns(line: string): McpRuns {
  const runs = line.trim();
  if (/^https?:\/\//i.test(runs)) return { kind: "address", url: runs };
  const words = splitWords(runs);
  const env: Record<string, string> = {};
  const keys: Record<string, string> = {};
  let assignmentsEnd = 0;
  while (words.length > 0) {
    const first = words[0] as Word;
    const assignment = first.quoted ? null : ASSIGNMENT.exec(first.text);
    if (!assignment) break;
    const name = assignment[1] as string;
    const value = assignment[2] as string;
    const ref = keptRef(value);
    // A later word for the same name wins, as a shell's would.
    if (ref) {
      keys[name] = ref;
      delete env[name];
    } else {
      env[name] = value;
      delete keys[name];
    }
    assignmentsEnd = first.end;
    words.shift();
  }
  const [command, ...args] = words.map((word) => word.text);
  if (!command)
    throw new McpRunsError("Runs names no program: write the program and its arguments.");
  return { kind: "program", command, args, env, keys, assignmentsEnd };
}

/**
 * The line with every value before the program kept in Secrets: each
 * NAME=value word written NAME={secret:REF} from `refs`, which names every
 * plain value's variable but those that stay on the line, which keep their
 * own word as written, and the program and its arguments exactly as the
 * person wrote them.
 */
export function runsWithKeys(line: string, refs: Readonly<Record<string, string>>): string {
  const runs = line.trim();
  const parsed = parseRuns(runs);
  if (parsed.kind !== "program") return runs;
  const words = splitWords(runs.slice(0, parsed.assignmentsEnd));
  const nameOf = (word: Word) => ASSIGNMENT.exec(word.text)?.[1] as string;
  // Each name once, where its last word stood, in the line's own order.
  const written = words
    .filter((word, index) => words.findLastIndex((one) => nameOf(one) === nameOf(word)) === index)
    .map((word) => {
      const name = nameOf(word);
      const ref = parsed.keys[name] ?? refs[name];
      if (name in parsed.env && STAYS_ON_LINE.has(name)) return runs.slice(word.start, word.end);
      if (!ref || !secretRefSchema.safeParse(ref).success)
        throw new McpRunsError(`No kept key for ${name}.`);
      return `${name}={secret:${ref}}`;
    });
  const rest = runs.slice(parsed.assignmentsEnd).trim();
  return [...written, rest].join(" ");
}

/** A word's text, whether any of it was quoted, and where it starts and ends in the line. */
type Word = { text: string; quoted: boolean; start: number; end: number };

/** Shell-like words: single quotes keep everything, double quotes and backslashes escape. */
function splitWords(line: string): Word[] {
  const words: Word[] = [];
  let text = "";
  let quoted = false;
  let open = false;
  let start = 0;
  let at = 0;
  const end = () => {
    if (open) words.push({ text, quoted, start, end: at });
    text = "";
    quoted = false;
    open = false;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (/\s/.test(char)) {
      at = index;
      end();
      continue;
    }
    if (!open) start = index;
    open = true;
    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      if (close < 0) throw new McpRunsError("Runs has a ' with no closing '.");
      text += line.slice(index + 1, close);
      quoted = true;
      index = close;
    } else if (char === '"') {
      quoted = true;
      let closed = false;
      for (index++; index < line.length; index++) {
        const inner = line[index] as string;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "\\" && /["\\$`]/.test(line[index + 1] ?? "")) {
          text += line[index + 1];
          index++;
        } else if (inner === "$" || inner === "`") {
          throw new McpRunsError(
            "Runs is one program and its arguments, read by no shell: write the value itself, not $ or `.",
          );
        } else text += inner;
      }
      if (!closed) throw new McpRunsError('Runs has a " with no closing ".');
    } else if (char === "\\") {
      const next = line[index + 1];
      if (next === undefined) throw new McpRunsError("Runs ends in a \\ with nothing after it.");
      text += next;
      index++;
    } else if (SHELL_ONLY.has(char)) {
      throw new McpRunsError(
        "Runs is one program and its arguments, read by no shell: quote a | ; & < > $ or ` that belongs in an argument.",
      );
    } else text += char;
  }
  at = line.length;
  end();
  return words;
}
