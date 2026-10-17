import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { FILE_TASK_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { encodePng } from "./pictureFixtures";
import { dropFiles, PASTE_PICTURE_PNG_BASE64, pastePictures, promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import {
  expandDock,
  expectRecordBar,
  expectRecordBody,
  openGroup,
  pressRow,
  recordBarButton,
  recordCard,
  rowAtRest,
  taskKey,
} from "./rails";

/**
 * The captain's pictures stay with the task the captain's message became
 * (`docs/task-capture.md`, "Pictures stay with the task"). A message whose
 * pictures were pasted or dropped into the main input becomes a task, and
 * the crewmate that takes the task is served those pictures with its brief,
 * which names the app's own copies - even when the task starts only after
 * the app was quit and opened again.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** A second picture, unlike the pasted one, given to the input as a file on disk. */
const DROPPED_PNG = encodePng(12, 12, () => [200, 80, 40]);

const shell = (page: Page) => page.locator("[data-voice-input-shell]");

/** The crewmate's first request for the task titled `title`, once the provider has it. */
async function servedBrief(app: LaunchedApp, title: string): Promise<string> {
  const find = () =>
    (app.mockProvider?.requestBodies() ?? []).find(
      (body) =>
        body.includes("You are a crewmate") &&
        body.includes(`Goal: Complete`) &&
        body.includes(title),
    );
  await expect.poll(() => find() ?? null, { timeout: 30_000 }).not.toBeNull();
  return find() as string;
}

/** The brief's words as the crewmate reads them: its first user message. */
function briefWords(body: string): string {
  return providerMessages(body).find((message) => message.role === "user")?.text ?? "";
}

/** The app's own copies the brief names, by path. */
function namedCopies(words: string): string[] {
  return [...words.matchAll(/^- [^\n]+?: (\/[^\n]+\.png)$/gm)].map((match) => match[1] ?? "");
}

/** Sends the turn and waits until the input took it. */
async function send(page: Page, words: string): Promise<void> {
  const input = promptInput(page);
  await input.fill(words);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("pictures pasted and dropped into a message reach the crewmate the message starts", async ({}, testInfo) => {
  launched = await launchApp({ withMockProvider: true });
  const { page, userDataDir } = launched;
  await expect(promptInput(page)).toBeEnabled({ timeout: 30_000 });
  const title = "fix the layout shown in these pictures";

  await pastePictures(promptInput(page), [{ name: "pasted.png" }]);
  const dropped = join(scratchDir("infinitary-task-pictures-files-"), "dropped.png");
  writeFileSync(dropped, DROPPED_PNG);
  await dropFiles(page, shell(page), [dropped]);
  await expect(shell(page).locator("[data-voice-input-attachment]")).toHaveCount(2);
  await send(page, `${SPAWN_PROMPT_MARKER} ${title}`);

  const body = await servedBrief(launched, title);
  writeFileSync(testInfo.outputPath("spawned-brief.json"), body);
  // Both pictures ride the crewmate's first request beside its brief.
  expect(body).toContain(PASTE_PICTURE_PNG_BASE64);
  expect(body).toContain(DROPPED_PNG.toString("base64"));
  // The brief names the app's own copy of each, which holds the same bytes.
  const copies = namedCopies(briefWords(body));
  expect(copies).toHaveLength(2);
  for (const copy of copies) expect(copy.startsWith(join(userDataDir, "attachments"))).toBe(true);
  const bytes = copies.map((copy) => readFileSync(copy).toString("base64")).sort();
  expect(bytes).toEqual([PASTE_PICTURE_PNG_BASE64, DROPPED_PNG.toString("base64")].sort());
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("a picture on a message that files a task reaches its crewmate after a relaunch", async ({}, testInfo) => {
  launched = await launchApp({ withMockProvider: true });
  const { userDataDir, homeDir } = launched;
  const title = "redesign the panel in this screenshot";
  await expect(promptInput(launched.page)).toBeEnabled({ timeout: 30_000 });
  await pastePictures(promptInput(launched.page), [{ name: "screenshot.png" }]);
  await send(launched.page, `${FILE_TASK_PROMPT_MARKER} ${title}`);
  const key = await taskKey(launched.page, title);

  // Quit and open the app again before the task starts.
  await launched.close();
  launched = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  const { page } = launched;
  await expandDock(page, "now");
  await openGroup(page, "backlog");
  await rowAtRest(page, key);
  await pressRow(page, key);
  await expect(recordCard(page)).toBeVisible();
  await expectRecordBody(page);
  expect(await expectRecordBar(page)).toMatchObject({ next: "start" });
  await recordBarButton(page, "next").click();

  const body = await servedBrief(launched, title);
  writeFileSync(testInfo.outputPath("relaunched-brief.json"), body);
  expect(body).toContain(PASTE_PICTURE_PNG_BASE64);
  const [copy] = namedCopies(briefWords(body));
  expect(copy?.startsWith(join(userDataDir, "attachments"))).toBe(true);
  expect(readFileSync(copy ?? "").toString("base64")).toBe(PASTE_PICTURE_PNG_BASE64);
});
