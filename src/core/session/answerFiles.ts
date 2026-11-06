import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoundTool, ToolOutput } from "./tools";

/**
 * The Claude client's default cap on one tool answer, in tokens, which a
 * crewmate's session leaves in place (docs/claude-client.md, "Complete task
 * reads through the tool-result cap").
 */
const CLAUDE_CLIENT_ANSWER_TOKENS = 25_000;

/**
 * The longest answer a crewmate's tool hands its model whole, in characters.
 * It is the client's own band: an answer whose estimate (a quarter token per
 * character) is at most half its cap is taken without counting, and 50,000
 * characters is also the length past which the client saves a result to a
 * file of its own. Pi's own file reads stop at 50 KB as well. A longer
 * answer is saved whole in the task's temporary folder instead, and the
 * model is answered with where it is (INF-2589, the captain: "set a
 * threshold for how big is too big, and then any too big answer gets stored
 * in a file and we return the path to the file instead of the full answer").
 */
export const ANSWER_WHOLE_MAX_CHARACTERS = (CLAUDE_CLIENT_ANSWER_TOKENS / 2) * 4;

/** Where a task's answers too long to read whole are saved: a folder in its temporary folder. */
export function answersDir(tempDir: string): string {
  return join(tempDir, "answers");
}

const count = (value: number) => value.toLocaleString("en-US");

/**
 * What the model reads in place of an answer saved to a file. The path sits
 * between backticks, since a task's folder on a Mac holds a space
 * ("Application Support") and a bare path would end there for its reader.
 */
export function savedAnswerText(path: string, answer: string): string {
  const lines = answer.split("\n").length;
  return `This answer is ${count(answer.length)} characters across ${count(lines)} line${lines === 1 ? "" : "s"}, more than the ${count(ANSWER_WHOLE_MAX_CHARACTERS)} a tool answer carries whole, so Infinitary saved it unchanged at \`${path}\`. Read it there in parts with your file tools, or search it with your shell.`;
}

/** A JSON answer keeps the extension a JSON reader expects; any other is text. */
function extensionOf(answer: string): string {
  try {
    JSON.parse(answer);
    return "json";
  } catch {
    return "txt";
  }
}

async function saved(tool: string, output: ToolOutput, tempDir: string): Promise<ToolOutput> {
  const dir = answersDir(tempDir);
  const path = join(dir, `${tool}-${randomBytes(4).toString("hex")}.${extensionOf(output.text)}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, output.text, { mode: 0o600, flag: "wx" });
  } catch {
    // The call has already done its work, so a file that cannot be written
    // never turns its answer into an error: the answer goes whole, as before.
    return output;
  }
  return { ...output, text: savedAnswerText(path, output.text) };
}

/**
 * A crewmate's tools as its conversation serves them, on the computer that
 * runs it: an answer longer than `ANSWER_WHOLE_MAX_CHARACTERS` is saved
 * whole in the task's temporary folder, and the model reads the file's path
 * in its place. A shorter answer, its pictures and the record Pi keeps
 * beside it are served as they were. The first mate has no file tools, so
 * its tools never go through here.
 */
export function serveAnswerFiles(tools: readonly BoundTool[], tempDir: string): BoundTool[] {
  return tools.map(
    (tool): BoundTool => ({
      ...tool,
      run: async (params, signal) => {
        const output = await tool.run(params, signal);
        return output.text.length > ANSWER_WHOLE_MAX_CHARACTERS
          ? saved(tool.name, output, tempDir)
          : output;
      },
    }),
  );
}
