import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { UNSAFE_DATA_READER_ALONE_MARKER, UNSAFE_DATA_READER_ALONE_READ } from "./apiWriteCases";
import { type GitHubStub, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { unsafeDataReaderAlone } from "./scenarios/unsafeDataReaderAlone";

let launched: LaunchedApp | undefined;
let github: GitHubStub | undefined;

test.afterEach(async () => {
  await launched?.close();
  await github?.close();
  launched = undefined;
  github = undefined;
});

/**
 * An unsafe data reader with no project (docs/agents-reach.md, "An unsafe data
 * reader") runs in an empty folder of its own, never a copy of the default
 * workspace, and reads nothing where projects live, not even through the
 * app's own GitHub sign-in.
 */
test("an unsafe data reader with no project runs in an empty folder of its own and reads no project", async () => {
  const userDataDir = scratchDir("infinitary-reader-alone-");
  seedGitHubSignIn(userDataDir);
  github = await startGitHubStub();
  launched = await launchApp({
    withMockProvider: true,
    scenarios: [unsafeDataReaderAlone],
    userDataDir,
    env: github.env,
  });
  const { page } = launched;
  const input = promptInput(page);
  await input.click();
  await input.fill(`${SPAWN_PROMPT_MARKER} ${UNSAFE_DATA_READER_ALONE_MARKER}`);
  await input.press("Enter");
  const report = async () => {
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const row = board.tasks.find((one) => one.title.includes(UNSAFE_DATA_READER_ALONE_MARKER));
    if (!row) return "";
    const detail = await page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), row.id);
    return detail?.outcome ?? "";
  };
  await expect.poll(report, { timeout: 45_000 }).toContain("Nothing was read");
  const reported = await report();
  const evidence = process.env.INFINITARY_TASK_EVIDENCE_DIR;
  if (evidence) writeFileSync(join(evidence, "unsafe-data-reader-alone-report.txt"), reported);
  expect(reported).toMatch(/\[\[reader-data fence=[0-9a-f]{16} /);
  // Its folder holds nothing: the default workspace would show its README.
  expect(reported).toContain("(empty directory)");
  expect(reported).not.toContain("README.md");
  expect(reported).toContain("this unsafe data reader has no project");
  expect(github.requests()).not.toContain(`GET ${UNSAFE_DATA_READER_ALONE_READ}`);
});
