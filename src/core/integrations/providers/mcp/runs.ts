/**
 * What an MCP server runs (docs/integrations.md, "MCP servers"): the
 * person's one line, read as a server's address when it starts with
 * http:// or https://, and otherwise as a program with its arguments -
 * words split the way a shell splits them, quotes kept together, with
 * any NAME=value words before the program set in its environment. No
 * shell ever reads the line, so a pipe, a redirect or a second command
 * is refused rather than passed on as a word.
 */

export type McpRuns =
  | { kind: "address"; url: string }
  | { kind: "program"; command: string; args: string[]; env: Record<string, string> };

/** The line could not be read; the message says why in the person's words. */
export class McpRunsError extends Error {}

const SHELL_ONLY = new Set(["|", "&", ";", "<", ">", "`", "$"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

export function parseRuns(line: string): McpRuns {
  const runs = line.trim();
  if (/^https?:\/\//i.test(runs)) return { kind: "address", url: runs };
  const words = splitWords(runs);
  const env: Record<string, string> = {};
  while (words.length > 0) {
    const first = words[0] as { text: string; quoted: boolean };
    const assignment = first.quoted ? null : ASSIGNMENT.exec(first.text);
    if (!assignment) break;
    env[assignment[1] as string] = assignment[2] as string;
    words.shift();
  }
  const [command, ...args] = words.map((word) => word.text);
  if (!command)
    throw new McpRunsError("Runs names no program: write the program and its arguments.");
  return { kind: "program", command, args, env };
}

/** Shell-like words: single quotes keep everything, double quotes and backslashes escape. */
function splitWords(line: string): { text: string; quoted: boolean }[] {
  const words: { text: string; quoted: boolean }[] = [];
  let text = "";
  let quoted = false;
  let open = false;
  const end = () => {
    if (open) words.push({ text, quoted });
    text = "";
    quoted = false;
    open = false;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (/\s/.test(char)) {
      end();
      continue;
    }
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
  end();
  return words;
}
