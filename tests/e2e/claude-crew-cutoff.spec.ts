import { expect, type Page, test } from "@playwright/test";
import { reportSummary } from "@shared/feed";
import { cutOffOpening, providerBackOpening } from "../../src/core/orchestrator/wakes";
import { heldSteerText } from "../../src/core/pi/crewTools";
import { scratchDir } from "../helpers/scratchDirs";
import { launchClaudeCrew, signedInAs } from "./claudeCrew";
import type { LaunchedApp } from "./launch";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_REFUSAL_OVER_MARKER,
  CLAUDE_REFUSED_PROMPT_MARKER,
  FM_SYSTEM_MARKER,
  MOCK_CLAUDE_REFUSAL_OVER_REPORT,
  type MockProviderServer,
  startMockProvider,
} from "./mockProvider";
import { reportLine, taskKey } from "./rails";

/**
 * A Claude crewmate on a login its organisation refuses (W1 S8, the
 * cut-off contract on crew lanes; docs/inbox.md, "A lane on a withheld
 * account"). The real client meets the vendor's organisation refusal and
 * types it; the app records it on the account, pauses the crewmate without
 * spending a turn, and tells the Firstmate once. The refusal clears only
 * when a fact changes - here the machine's Claude login becomes another
 * account, as when the person signs in to a different one in Claude Code -
 * and then the kept guidance goes out as one turn and the Firstmate hears
 * that the refusal ended.
 *
 * Across two restarts, because that is where the login is read for sure:
 * at boot no session holds the Claude store, so the client's own status
 * answers. The refusal is durable, and a restart neither repeats the wake
 * nor reopens the paused crewmate.
 */

const TITLE = `count the rivets ${CLAUDE_CREW_PROMPT_MARKER} ${CLAUDE_REFUSED_PROMPT_MARKER}`;
const CUT_OFF_WAKE = cutOffOpening({ class: "refused", provider: "Claude" });
const BACK_WAKE = providerBackOpening("Claude");

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The task's id, as the Firstmate's context names it to `steer_crewmate`. */
async function taskId(page: Page, title: string): Promise<string> {
  const id = await page.evaluate(
    async (wanted) =>
      (await window.infinitary.tasks.board()).tasks.find((task) => task.title === wanted)?.id,
    title,
  );
  if (!id) throw new Error(`no task titled ${title}`);
  return id;
}

test("a crewmate its organisation refuses waits without a turn, is told once, and goes on when the login changes", async () => {
  const homeDir = scratchDir("infinitary-home-");
  const mockProvider: MockProviderServer = await startMockProvider();
  const firstmateBodies = () =>
    mockProvider.requestBodies().filter((body) => body.includes(FM_SYSTEM_MARKER));
  const heard = (text: string) => firstmateBodies().some((body) => body.includes(text));
  /** The model turns the refused crewmate's client asked for. */
  const crewTurns = () => {
    const headers = mockProvider.requestHeaders();
    return mockProvider
      .requestBodies()
      .filter(
        (body, index) =>
          headers[index]?.["user-agent"]?.startsWith("claude-cli/") &&
          body.includes('"stream":true') &&
          body.includes(CLAUDE_REFUSED_PROMPT_MARKER),
      );
  };
  const taskPrompt = (page: Page) => page.getByRole("textbox", { name: "Task prompt" });
  let launched: LaunchedApp | undefined;
  try {
    // 1. The refusal: the crewmate's first turn meets it, and the Firstmate
    // hears it once, for the account.
    launched = await launchClaudeCrew({
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-one"),
    });
    const userDataDir = launched.userDataDir;
    const input = taskPrompt(launched.page);
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`commission a crewmate: ${TITLE}`);
    await input.press("Enter");
    await expect.poll(() => heard(CUT_OFF_WAKE), { timeout: 30_000 }).toBe(true);
    // The captain's word while it waits is kept on its lane, not attempted.
    await input.click();
    await input.fill(`steer the task ${TITLE}: ${CLAUDE_REFUSAL_OVER_MARKER}`);
    await input.press("Enter");
    // What `steer_crewmate` answers for guidance a held lane keeps.
    const keptSteer = heldSteerText(await taskId(launched.page, TITLE));
    await expect.poll(() => heard(keptSteer), { timeout: 30_000 }).toBe(true);
    await launched.close();
    launched = undefined;
    expect(crewTurns()).toHaveLength(1);

    // 2. A restart on the same login: the refusal still stands, so the
    // paused crewmate is not reopened and nothing is said again.
    launched = await launchClaudeCrew({
      userDataDir,
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-one"),
    });
    await expect(taskPrompt(launched.page)).toBeEnabled({ timeout: 30_000 });
    await launched.close();
    launched = undefined;
    expect(crewTurns()).toHaveLength(1);

    // 3. The machine's Claude login is another account now, and Claude
    // answers it: the refusal clears at boot, the Firstmate hears it end,
    // and the kept guidance goes out as one turn.
    mockProvider.refuseClaude(false);
    launched = await launchClaudeCrew({
      userDataDir,
      homeDir,
      reuseMockProvider: mockProvider,
      prepareHome: signedInAs("account-two"),
    });
    await expect(
      reportLine(launched.page, await taskKey(launched.page, TITLE)).filter({
        hasText: reportSummary(MOCK_CLAUDE_REFUSAL_OVER_REPORT),
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => heard(BACK_WAKE), { timeout: 30_000 }).toBe(true);
    // The first turn after the refusal carried everything the lane kept:
    // the brief the refusal met and the captain's word, as one message.
    const [refused, resumed] = crewTurns();
    expect(refused).toBeDefined();
    const messages: { role: string }[] = JSON.parse(resumed ?? "{}").messages ?? [];
    const kept = JSON.stringify(messages.filter((message) => message.role === "user").at(-1));
    expect(kept).toContain("Complete the task");
    expect(occurrences(kept, CLAUDE_REFUSAL_OVER_MARKER)).toBe(1);
    // Told once each across all three runs: the Firstmate's own history,
    // which its session keeps across restarts, holds each wake once.
    const history = firstmateBodies().at(-1) ?? "";
    expect(occurrences(history, CUT_OFF_WAKE)).toBe(1);
    expect(occurrences(history, BACK_WAKE)).toBe(1);
  } finally {
    await launched?.close();
    await mockProvider.close();
  }
});
