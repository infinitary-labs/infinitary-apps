import { expect, type FrameLocator, type Page } from "@playwright/test";
import {
  cardBuildRowIssue,
  cardBuildRowLater,
  cardBuildRowReproduce,
} from "../../src/shared/i18n/messages.generated";
import { UNSAFE_DATA_READER_BUILD_ROW } from "./apiWriteCases";
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

/**
 * The tools of each request that is a crewmate's own turn: the first mate's
 * (it offers spawn_crewmate) and the app's tool-less asks are left out.
 */
export function crewmateTurnTools(requests: string[]): string[][] {
  return requests
    .map((raw) =>
      ((JSON.parse(raw).tools ?? []) as { name?: string; function?: { name: string } }[]).map(
        (tool) => tool.name ?? tool.function?.name ?? "",
      ),
    )
    .filter(
      (names) =>
        names.some((name) => name.endsWith("report")) &&
        !names.some((name) => name.endsWith("spawn_crewmate")),
    );
}

/** The project's open issue the reader's Build row names, as its link ends. */
const BUILD_ROW_ISSUE_PATH = new RegExp(
  `/octo/meterlab/issues/${UNSAFE_DATA_READER_BUILD_ROW.issue}$`,
);

async function buildRowTask(page: Page) {
  return (await page.evaluate(() => window.infinitary.tasks.board())).tasks.find(
    (row) => row.title === UNSAFE_DATA_READER_BUILD_ROW.title,
  );
}

/**
 * The reader's Build row waits on its approval card whole - its title, the
 * issue as a link, how it starts, its goal and why - with Keep for later
 * picked, and nothing is filed before the captain's click.
 */
export async function expectBuildRowShown(page: Page, body: FrameLocator): Promise<void> {
  const build = body.locator("[data-inf-build-row]");
  await expect(build).toHaveCount(1, { timeout: 45_000 });
  const row = UNSAFE_DATA_READER_BUILD_ROW;
  for (const words of [row.title, row.goal, row.why, cardBuildRowReproduce()])
    await expect(build).toContainText(words);
  const issue = cardBuildRowIssue({ number: String(row.issue) });
  await expect(build.getByRole("link", { name: issue })).toHaveAttribute(
    "href",
    BUILD_ROW_ISSUE_PATH,
  );
  await expect(build.getByRole("radio", { name: cardBuildRowLater() })).toBeChecked();
  expect(await buildRowTask(page)).toBeUndefined();
}

/**
 * The app read the row's issue where the project lives before keeping it, and
 * Keep for later filed the row as a task that waits, its brief the goal and
 * why as the card showed them with no issue number or link, and its record
 * keeping the issue as a typed link. `requests` are the stand-in GitHub's.
 */
export async function expectBuildRowFiled(page: Page, requests: string[]): Promise<void> {
  expect(requests).toContain(
    `GET /repos/octo/meterlab/issues/${UNSAFE_DATA_READER_BUILD_ROW.issue}`,
  );
  const filed = await buildRowTask(page);
  if (!filed) throw new Error("The captain's click filed no Build row task");
  expect(filed.status).toBe("open");
  const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), filed.id);
  const row = UNSAFE_DATA_READER_BUILD_ROW;
  expect(detail?.brief).toContain(row.goal);
  expect(detail?.brief).toContain(row.why);
  expect(detail?.brief).not.toContain(`#${row.issue}`);
  expect(detail?.brief).not.toContain("/issues/");
  expect(detail?.issue).toEqual({
    number: row.issue,
    url: expect.stringMatching(BUILD_ROW_ISSUE_PATH),
  });
}
