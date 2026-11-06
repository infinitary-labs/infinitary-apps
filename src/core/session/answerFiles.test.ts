import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS } from "../../../tests/helpers/claudeMcpLimit";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { claudeToolOf } from "../claude/claudeTaskTools";
import { GITHUB_READ_TOOL, GITHUB_WRITE_TOOL } from "../pi/forgeTools";
import { piToolOf } from "../pi/toolSpec";
import {
  ANSWER_WHOLE_MAX_CHARACTERS,
  answersDir,
  savedAnswerText,
  serveAnswerFiles,
} from "./answerFiles";
import { bindTools } from "./tools";

// INF-2589's audit found 208 answers in one day too long for a crewmate's
// model to take whole. The captain's ruling: "set a threshold for how
// big is too big, and then any too big answer gets stored in a file and we
// return the path to the file instead of the full answer. then we don't need
// to reinvent a pagination system".

/** A real answer past the band: the captured INF-91 record as one read serves it whole. */
const LARGE = JSON.stringify(
  JSON.parse(readFileSync("tests/fixtures/accepted-plan/inf91.json", "utf8")),
  null,
  2,
);

/** The GitHub pair as a crewmate's conversation serves it, answering `text` to every call. */
function served(tempDir: string, text: string) {
  const tools = serveAnswerFiles(
    bindTools([GITHUB_READ_TOOL, GITHUB_WRITE_TOOL], {
      onGithubRead: async () => text,
      onGithubWrite: async () => text,
    }),
    tempDir,
  );
  const tool = (name: string) => {
    const found = tools.find((each) => each.name === name);
    if (!found) throw new Error(`${name} is not served`);
    return found;
  };
  return { githubRead: tool("github_read"), githubWrite: tool("github_write") };
}

const READ = { path: "/repos/acme/shop/actions/runs?per_page=100" };

/** The saved file's path as a reader takes it from the notice: everything between its backticks. */
function namedPath(text: string): string {
  return /saved it unchanged at `([^`]+)`\. Read it there/.exec(text)?.[1] ?? "";
}

/** The text a model reads from one tool result's content. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => block.text ?? "").join("\n");
}

describe("an answer too long to read whole", () => {
  it("fits the band the Claude client takes whole without counting tokens", () => {
    expect(ANSWER_WHOLE_MAX_CHARACTERS).toBeLessThanOrEqual(
      CLAUDE_MCP_UNCONDITIONAL_TEXT_CHARACTERS,
    );
  });

  it.each(["Pi", "Claude"] as const)(
    "reaches a %s model as the path of a file in the task's temporary folder that holds it unchanged",
    async (runtime) => {
      expect(LARGE.length).toBeGreaterThan(ANSWER_WHOLE_MAX_CHARACTERS);
      const temp = scratchDir("answer-files-");
      const { githubRead } = served(temp, LARGE);
      const result =
        runtime === "Pi"
          ? await piToolOf(githubRead).execute("call", READ, undefined, undefined, {} as never)
          : await claudeToolOf(githubRead).handler(READ, {} as never);
      const [saved] = readdirSync(answersDir(temp));
      expect(saved).toMatch(/^github_read-[0-9a-f]{8}\.json$/);
      const path = join(answersDir(temp), saved ?? "");
      expect(textOf(result.content)).toBe(savedAnswerText(path, LARGE));
      expect(textOf(result.content).length).toBeLessThan(ANSWER_WHOLE_MAX_CHARACTERS);
      expect(readFileSync(path, "utf8")).toBe(LARGE);
      // Only the task's own user may read what its sign-in read.
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(answersDir(temp)).mode & 0o777).toBe(0o700);
    },
  );

  it("names the file, the answer's size and the band, so a model can plan its reads", () => {
    const path = "/tasks/t/temp/answers/github_read-0a1b2c3d.json";
    const text = savedAnswerText(path, LARGE);
    expect(text).toContain(` \`${path}\`. `);
    expect(text).toContain(
      `${LARGE.length.toLocaleString("en-US")} characters across ${LARGE.split("\n").length} lines`,
    );
    expect(text).toContain(`the ${ANSWER_WHOLE_MAX_CHARACTERS.toLocaleString("en-US")} a tool`);
  });

  it("keeps each answer in a file of its own, as text when it is not JSON", async () => {
    const temp = scratchDir("answer-files-");
    const { githubRead, githubWrite } = served(temp, `Run log\n${LARGE}`);
    const first = await githubRead.run(READ);
    const second = await githubRead.run(READ);
    const wrote = await githubWrite.run({ method: "POST", path: "/repos/acme/shop/dispatches" });
    const files = readdirSync(answersDir(temp)).sort();
    expect(files).toHaveLength(3);
    expect(files.filter((name) => name.startsWith("github_read-"))).toHaveLength(2);
    expect(files.every((name) => name.endsWith(".txt"))).toBe(true);
    for (const output of [first, second, wrote]) {
      expect(readFileSync(namedPath(output.text), "utf8")).toBe(`Run log\n${LARGE}`);
    }
  });

  // The review of this change: every task folder on a Mac sits under
  // "Application Support", so the path must come back whole past its space.
  it("names a path with a space whole, so a reader of the answer opens the saved file", async () => {
    const temp = join(scratchDir("answer-files-"), "Application Support", "temp");
    const { githubRead } = served(temp, LARGE);
    const path = namedPath((await githubRead.run(READ)).text);
    expect(path.startsWith(temp)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(LARGE);
  });

  it("is served whole up to the band's last character, and nothing is saved", async () => {
    const temp = scratchDir("answer-files-");
    const atTheBand = LARGE.slice(0, ANSWER_WHOLE_MAX_CHARACTERS);
    const { githubRead } = served(temp, atTheBand);
    expect((await githubRead.run(READ)).text).toBe(atTheBand);
    expect(existsSync(answersDir(temp))).toBe(false);
  });

  it("is served whole when its file cannot be written, since the call already did its work", async () => {
    const blocked = join(scratchDir("answer-files-"), "temp");
    writeFileSync(blocked, "a file where the temporary folder should be");
    const { githubWrite } = served(blocked, LARGE);
    const wrote = await githubWrite.run({ method: "POST", path: "/repos/acme/shop/dispatches" });
    expect(wrote.text).toBe(LARGE);
  });
});
