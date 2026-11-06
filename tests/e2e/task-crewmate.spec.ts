import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { renderWake, replyWordsSpan, type TypedWake } from "../../src/core/orchestrator/wakes";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { CREWMATE_TAB_LABEL, CREWMATE_WORDS } from "../../src/shared/crewTranscript";
import { reportSummary } from "../../src/shared/feed";
import { CREWMATE_TAB_VIA } from "../../src/shared/provenance";
import { INFO_TAB_LABEL } from "../../src/shared/taskBrowser";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { seedDelivery } from "../helpers/taskDelivery";
import { launchClaudeCrew } from "./claudeCrew";
import { claudeQueued } from "./claudeSeat";
import {
  callTo,
  crewBlock,
  crewComposer,
  crewLineKinds,
  crewLines,
  crewmateView,
  sentBy,
  sentWords,
} from "./crewmateTab";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  MOCK_CLAUDE_CARD_TITLE,
  MOCK_CLAUDE_STEERED_REPORT,
} from "./crewScripts";
import { launchApp } from "./launch";
import { encodePng } from "./pictureFixtures";
import { heroShot, regionShot } from "./pictures";
import { expandDock, openGroup, pressRow, recordCard, recordFrame, taskKey } from "./rails";
import { shownCard } from "./stack";
import { showTabByKeys, taskTabs } from "./taskBrowser";
import { setThemeViaSettings } from "./theme";
import { seedCrewTranscript } from "./transcriptFixtures";
import { focusOn, pressKey, runFromSearch, typeInto, untilFocused } from "./windowKeys";

/**
 * The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate tab"):
 * the crewmate's own session read as a CLI agent's transcript, which the
 * captain reaches from the card's tabs by keys, opens folds in, and types
 * into - his line a steer on the crewmate's own lane, ⌃C his interrupt.
 *
 * Pictures of the tab land in INFINITARY_CREWMATE_EVIDENCE_DIR when it is set,
 * and the release note's hero pair when INFINITARY_CREWMATE_HERO is.
 */

const evidence = process.env.INFINITARY_CREWMATE_EVIDENCE_DIR;
const shoot = async (region: Parameters<typeof regionShot>[0], name: string) => {
  if (evidence) await regionShot(region, join(evidence, name));
};

const REPLAY = "crewmate-replay";
const UNDERWAY = "crewmate-underway";
const SESSION = "7c1f2a3b-0e00-4bcd-8e11-2a6f0c9d7b20";
const WORKTREE = "/work/theme-toggle";
const FILE = "src/settings/AppearanceTab.tsx";
const BRIEF =
  "Goal: add a Theme toggle to Settings, Appearance, so a person can switch Light and Dark.";
const SAID = "I'll read the Settings code first, then add the toggle beside the other switches.";
const READ_OUTPUT = [
  "export function AppearanceTab() {",
  "  const prefs = usePreferences();",
  "  return <section>{prefs.layout}</section>;",
  "}",
].join("\n");
const TESTS_RAN = "Run the Settings tests";
const TYPED = "Keep the toggle reachable with Tab too";
const CARD = { id: "merge-toggle", title: "Merge the Theme toggle?" };
const CHANGE_TITLE = "feat(settings): a Theme toggle in Appearance";
const REPORT = {
  text: "Added a Theme toggle to Settings, Appearance.\n\nThe Settings tests pass, and the toggle is reachable with Tab.",
  summary: "Added a Theme toggle; the tests pass.",
};

const typedLine = (words: string): TypedWake => ({ facts: { kind: "crewmate-tab-line", words } });

/**
 * Two tasks the app boots into with the same crewmate's session, kept as the
 * Claude client writes one: one closed after its merge, one still underway
 * and idle, whose prompt the hero picture shows.
 */
function seededReplay(): string {
  const userDataDir = scratchDir("infinitary-crewmate-replay-");
  const db = openDatabase(userDataDir);
  const base = Date.now() - 60 * 60_000;
  let at = base;
  const tasks = new TaskService({ db, strict: true, now: () => at });
  for (const id of [REPLAY, UNDERWAY]) {
    at = base;
    seedTask(tasks, {
      id,
      title: "Add a Theme toggle to Settings",
      intent: { goal: "Light and Dark from Settings.", userWords: "add a theme toggle" },
      status: "idle",
      worktreeDir: WORKTREE,
    });
    const typed = typedLine(TYPED);
    at = base + 6 * 60_000;
    const words = replyWordsSpan(typed);
    tasks.turns.recordSteer(id, {
      text: renderWake(typed),
      actor: "captain",
      outcome: "mid-turn",
      via: CREWMATE_TAB_VIA,
      decision: null,
      cardId: null,
      inboxId: null,
      ...(words ? { words } : {}),
    });
    at = base + 9 * 60_000;
    seedDelivery(
      tasks,
      id,
      { prNumber: 42, prUrl: "https://github.com/example/settings/pull/42", ci: "green" },
      { kind: "pr_opened", text: "Opened pull request #42" },
    );
  }
  new CardStore(db).upsert({
    id: `card-${REPLAY}-${CARD.id}`,
    taskId: REPLAY,
    title: CARD.title,
    author: "crewmate",
    priority: 50,
    meta: "Add a Theme toggle to Settings",
    body: "<p>The toggle is in, and the checks passed.</p>",
    status: "ready",
    createdAt: at,
    actions: [{ id: "merge", label: "Merge" }],
  });
  new CardStore(db).resolve(`card-${REPLAY}-${CARD.id}`, "merge");
  at = base + 10 * 60_000;
  tasks.turns.recordReport(REPLAY, REPORT);
  at = base + 12 * 60_000;
  tasks.close(REPLAY, { status: "done", reason: "merged", actor: "host" });
  db.close();

  const iso = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const lines: object[] = [];
  let n = 0;
  const line = (minutes: number, type: string, extra: object) =>
    lines.push({
      type,
      sessionId: SESSION,
      isSidechain: false,
      uuid: `u${n++}`,
      timestamp: iso(minutes),
      ...extra,
    });
  const assistant = (minutes: number, block: object) =>
    line(minutes, "assistant", { message: { id: `m${n}`, role: "assistant", content: [block] } });
  const call = (minutes: number, id: string, name: string, input: object) =>
    assistant(minutes, { type: "tool_use", id, name, input });
  const result = (minutes: number, id: string, content: unknown) =>
    line(minutes, "user", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
    });
  const picture = encodePng(64, 40, (x) => (x < 32 ? [60, 120, 230] : [230, 80, 60]));

  line(1, "user", { message: { role: "user", content: BRIEF } });
  assistant(1.2, { type: "text", text: SAID });
  call(1.5, "read", "Read", { file_path: `${WORKTREE}/${FILE}` });
  result(1.6, "read", READ_OUTPUT);
  call(2, "edit", "Edit", {
    file_path: `${WORKTREE}/${FILE}`,
    old_string: "    <LayoutRow />\n    <ThemeMenuHint />\n    <WashRow />",
    new_string:
      '    <LayoutRow />\n    <Row label="Theme">\n      <GroupedPills value={theme} onChange={setTheme} />\n    </Row>\n    <WashRow />',
  });
  result(2.1, "edit", `The file ${WORKTREE}/${FILE} has been updated.`);
  call(3, "bash", "Bash", { command: "pnpm test src/settings", description: TESTS_RAN });
  result(4, "bash", "Test Files  3 passed (3)\n     Tests  12 passed (12)");
  call(5, "plan", "mcp__infinitary__note_progress", {
    text: "The toggle is in; the tests pass.",
    plan: [
      { label: "Read the Settings code", short: "Read", state: "done" },
      { label: "Add the toggle, tests green", short: "Toggle", state: "done" },
      { label: "Pictures and the pull request", short: "PR", state: "current" },
    ],
  });
  line(6.5, "attachment", {
    attachment: { type: "queued_command", prompt: renderWake(typedLine(TYPED)) },
  });
  assistant(7, { type: "text", text: "Adding the Tab stop as well, then photographing it." });
  call(8, "capture", "mcp__infinitary__browser_capture", { name: "settings-dark" });
  result(8.1, "capture", [
    { type: "text", text: "Saved settings-dark.png" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: picture.toString("base64") },
    },
  ]);
  call(9, "card", "mcp__infinitary__emit_card", { id: CARD.id, title: CARD.title });
  call(9.2, "change", "mcp__infinitary__open_change", { title: CHANGE_TITLE, body: "..." });
  call(10, "report", "mcp__infinitary__report", REPORT);
  for (const id of [REPLAY, UNDERWAY]) {
    seedCrewTranscript(userDataDir, id, `${SESSION}.jsonl`, lines);
  }
  return userDataDir;
}

/** The task's id and key on the board, by its title. */
async function boardTask(page: Page, title: string): Promise<{ id: string; key: string }> {
  const key = await taskKey(page, title);
  const id = await page.evaluate(
    async (wanted) =>
      (await window.infinitary.tasks.board()).tasks.find((t) => t.key === wanted)?.id,
    key,
  );
  if (!id) throw new Error(`No task ${key} on the board.`);
  return { id, key };
}

const detailOf = (page: Page, id: string): Promise<TaskDetail> =>
  page.evaluate((taskId) => window.infinitary.tasks.detail(taskId), id);

/** From the record, the Crewmate tab by keys: the arrow to it, then Enter. */
async function crewmateByKeys(page: Page): Promise<void> {
  const { strip, selected } = taskTabs(page);
  await expect(selected).toHaveText(INFO_TAB_LABEL);
  await expect(strip.locator('[data-task-tab="crewmate"]')).toHaveText(CREWMATE_TAB_LABEL);
  await showTabByKeys(page, "crewmate");
}

test("a closed task's Crewmate tab replays its crewmate's session: calls, folds, a diff, a picture and its blocks", async () => {
  const launched = await launchApp({ userDataDir: seededReplay() });
  try {
    const { app, page } = launched;
    const detail = await detailOf(page, REPLAY);
    await expandDock(page, "now");
    await openGroup(page, "landed");
    await pressRow(page, detail.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", REPLAY);
    await shoot(recordCard(page), "record-tabs-dark.png");

    await test.step("the record's tabs read Info and Crewmate, and the keys show the Crewmate tab in its place", async () => {
      // INF-916: returning to Info reuses its populated document, not just its chrome.
      const infoBody = await recordFrame(page).locator("body").elementHandle();
      const infoCard = await recordCard(page).elementHandle();
      if (!infoBody || !infoCard) throw new Error("Info has not drawn");
      await crewmateByKeys(page);
      const view = crewmateView(page, REPLAY);
      await expect(view).toHaveAttribute("data-crew-state", "closed");
      await expect(recordCard(page)).toHaveCount(0);
      expect(
        await infoCard.evaluate((node) => {
          const stage = node.closest("[data-stage-entry]");
          return {
            connected: node.isConnected,
            inert: stage?.hasAttribute("inert"),
            hidden: stage?.getAttribute("aria-hidden"),
          };
        }),
      ).toEqual({ connected: true, inert: true, hidden: "true" });
      const { selected } = taskTabs(page);
      await expect(selected).toHaveText(CREWMATE_TAB_LABEL);
      await untilFocused(selected);
      // Let Info's outgoing motion fully retire before exercising the retained visit.
      await expect(page.locator('[data-stage-entry="parked"]')).toHaveCount(1);
      await runFromSearch(app, page, "cards.show-info");
      expect(
        await recordFrame(page)
          .locator("body")
          .evaluate((body, original) => body === original, infoBody),
      ).toBe(true);
      await expect(recordFrame(page).locator("[data-record-content]")).toBeVisible();
      await untilFocused(taskTabs(page).selected);
      await expect(
        recordCard(page).getByRole("button", { name: "Hide", exact: true }),
      ).toBeInViewport();
      await crewmateByKeys(page);
      await infoBody.dispose();
      await infoCard.dispose();
    });

    const view = crewmateView(page, REPLAY);
    await test.step("the transcript reads the session in order, with the app's own calls as blocks", async () => {
      await expect
        .poll(() => crewLineKinds(view))
        .toEqual([
          "brief",
          "said",
          "tool",
          "result",
          "tool",
          "result",
          "tool",
          "result",
          "plan",
          "sent",
          "said",
          "tool",
          "result",
          "card",
          "change",
          "report",
        ]);
      await expect(crewLines(view, "said").first()).toHaveText(SAID);
      await expect(callTo(view, "Read").call).toContainText(FILE);
      await expect(callTo(view, "Bash").call).toContainText(TESTS_RAN);
      // The captain's own words, delivered: never the lead the crewmate was sent with them.
      await expect(sentWords(view, "captain")).toHaveText(TYPED);
      await expect(sentBy(view, "captain")).not.toHaveAttribute("data-crew-queued", "");
      await expect(crewBlock(view, "card")).toContainText(CARD.title);
      await expect(crewBlock(view, "change")).toContainText(CHANGE_TITLE);
      await expect(crewBlock(view, "change").locator("a")).toHaveText("#42");
      await expect(crewBlock(view, "report")).toContainText(REPORT.summary);
      // A closed task reads as it ran: no prompt to type in.
      await expect(view.locator("[data-crew-closed]")).toBeVisible();
      await expect(crewComposer(view)).toHaveCount(0);
      await shoot(view, "crewmate-closed-dark.png");
    });

    await test.step("a fold opens by keys to the whole result, an edit to its diff, and a picture shows inline", async () => {
      const read = callTo(view, "Read").result;
      await pressKey(read.locator("[data-crew-fold]"), "Enter");
      await expect(read.locator("[data-crew-output]")).toContainText(
        READ_OUTPUT.split("\n")[1] ?? "",
      );
      const edit = callTo(view, "Edit").result;
      await pressKey(edit.locator("[data-crew-fold]"), "Enter");
      const diff = edit.locator("[data-crew-diff]");
      await expect(diff.locator('[data-diff="removed"]')).toHaveCount(1);
      await expect(diff.locator('[data-diff="added"]')).toHaveCount(3);
      const shot = callTo(view, "browser_capture").result.locator("[data-crew-picture] img");
      await expect(shot).toBeVisible();
      expect(await shot.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(64);
      await shoot(view, "crewmate-folds-dark.png");
    });

    await test.step("the card block shows the card it put up, read-only", async () => {
      await pressKey(crewBlock(view, "card").getByRole("button"), "Enter");
      await expect(page.locator(`[data-past-card="card-${REPLAY}-${CARD.id}"]`)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(view).toBeVisible();
    });

    await test.step("command search shows Info and the Crewmate tab again", async () => {
      await runFromSearch(app, page, "cards.show-info");
      await expect(recordCard(page)).toHaveAttribute("data-task-record", REPLAY);
      await runFromSearch(app, page, "cards.show-crewmate");
      await expect(view).toBeVisible();
      if (evidence) {
        await setThemeViaSettings(page, "light");
        await expandDock(page, "now");
        await openGroup(page, "landed");
        await pressRow(page, detail.key);
        await crewmateByKeys(page);
        await shoot(crewmateView(page, REPLAY), "crewmate-closed-light.png");
        await setThemeViaSettings(page, "dark");
      }
    });

    await test.step("a task still underway keeps the prompt under its transcript", async () => {
      const underway = await detailOf(page, UNDERWAY);
      await pressRow(page, underway.key);
      await crewmateByKeys(page);
      const open = crewmateView(page, UNDERWAY);
      await expect(open).toHaveAttribute("data-crew-state", "idle");
      await expect(crewComposer(open)).toBeVisible();
      await expect(open.locator("[data-crew-closed]")).toHaveCount(0);
      const edit = callTo(open, "Edit");
      await pressKey(edit.result.locator("[data-crew-fold]"), "Enter");
      await expect(edit.result.locator("[data-crew-diff]")).toBeVisible();
      // The edit and its diff at the top of the transcript, the prompt under it, no ring.
      const lift = () =>
        edit.call.evaluate((node) => {
          (document.activeElement as HTMLElement | null)?.blur();
          node.scrollIntoView({ block: "start" });
        });
      await lift();
      await shoot(open, "crewmate-underway-dark.png");
      if (process.env.INFINITARY_CREWMATE_HERO) {
        await heroShot(app, page, { region: open, name: "task-card-crewmate-tab", ready: lift });
      }
    });
  } finally {
    await launched.close();
  }
});

const TYPING_TITLE = `count the rivets in the Crewmate tab ${CLAUDE_CREW_PROMPT_MARKER}`;

test("a line typed in the Crewmate tab steers a Claude crewmate mid-turn, queued until its session takes it", async () => {
  const launched = await launchClaudeCrew();
  try {
    const { page, mockProvider, homeDir } = launched;
    const input = page.getByRole("textbox", { name: "Task prompt" });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`commission a crewmate: ${TYPING_TITLE}`);
    await input.press("Enter");
    await expect.poll(() => mockProvider?.heldRequests(), { timeout: 30_000 }).toBe(1);
    const task = await boardTask(page, TYPING_TITLE);

    await pressRow(page, task.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", task.id);
    await crewmateByKeys(page);
    const view = crewmateView(page, task.id);
    await test.step("the tab shows the running turn: its card as a block, and the way to stop it", async () => {
      await expect(view).toHaveAttribute("data-crew-state", "working");
      await expect(crewBlock(view, "card")).toContainText(MOCK_CLAUDE_CARD_TITLE);
      // INF-1559: the transcript must not offer a dead Show card while the
      // host holds the emitted card off the stage until close-out.
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.infinitary.cards.list()).find((card) => card.taskId === id)?.awaiting,
            task.id,
          ),
        )
        .toBe("close-out");
      await expect(
        crewBlock(view, "card").getByRole("button", { name: CREWMATE_WORDS.showCard }),
      ).toHaveCount(0);
      await expect(view.locator("[data-crew-stop]")).toBeVisible();
      await expect(view.locator("[data-crew-elapsed]")).toBeVisible();
      await shoot(view, "crewmate-working-dark.png");
    });

    await test.step("Enter sends the line as the captain's steer, recorded with its origin, and it reads queued", async () => {
      const field = crewComposer(view);
      await focusOn(field);
      await typeInto(field, CLAUDE_STEER_MARKER);
      await page.keyboard.press("Enter");
      await expect(field).toHaveValue("");
      await expect
        .poll(async () =>
          (await detailOf(page, task.id)).events
            .filter((event) => event.kind === "steered" && event.data?.via === CREWMATE_TAB_VIA)
            .map((event) => {
              const span = event.data?.words as { from: number; to: number } | undefined;
              return span ? event.text.slice(span.from, span.to) : null;
            }),
        )
        .toEqual([CLAUDE_STEER_MARKER]);
      await expect(sentWords(view, "captain")).toHaveText(CLAUDE_STEER_MARKER);
      await expect(sentBy(view, "captain")).toHaveAttribute("data-crew-queued", "");
      await expect
        .poll(() => claudeQueued(homeDir, CLAUDE_STEER_MARKER), { timeout: 30_000 })
        .toBe(true);
      await shoot(view, "crewmate-queued-dark.png");
    });

    await test.step("its next step takes the line: delivered once, and its report answers it", async () => {
      mockProvider?.releaseHeldCrew();
      await expect(crewBlock(view, "report")).toContainText(
        reportSummary(MOCK_CLAUDE_STEERED_REPORT),
        { timeout: 30_000 },
      );
      await expect(sentBy(view, "captain")).toHaveCount(1);
      await expect(sentBy(view, "captain")).not.toHaveAttribute("data-crew-queued", "");
      // The request that carried it was the crewmate's own, mid-turn: Firstmate was not in the loop.
      expect(
        (mockProvider?.requestBodies() ?? []).some(
          (body) => body.includes(CLAUDE_STEER_MARKER) && body.includes("_held"),
        ),
      ).toBe(true);
      // The record reads the captain's own words on the task's timeline.
      const steered = (await detailOf(page, task.id)).activityLog.find(
        (row) => row.kind === "steered",
      );
      expect(steered?.text).toContain(CLAUDE_STEER_MARKER);
      await shoot(view, "crewmate-delivered-dark.png");
    });

    await test.step("after close-out, Show card opens the released card by keyboard", async () => {
      const show = crewBlock(view, "card").getByRole("button", {
        name: CREWMATE_WORDS.showCard,
      });
      await expect(show).toBeVisible();
      await pressKey(show, "Enter");
      await expect(shownCard(page, MOCK_CLAUDE_CARD_TITLE)).toBeVisible();
    });
  } finally {
    await launched.close();
  }
});

const STOP_TITLE = `count the hatches in the Crewmate tab ${CLAUDE_CREW_PROMPT_MARKER}`;

test("⌃C in the Crewmate tab stops the crewmate's turn and leaves it steerable, and Esc still hides the card", async () => {
  const launched = await launchClaudeCrew();
  try {
    const { page, mockProvider } = launched;
    const input = page.getByRole("textbox", { name: "Task prompt" });
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await input.click();
    await input.fill(`commission a crewmate: ${STOP_TITLE}`);
    await input.press("Enter");
    await expect.poll(() => mockProvider?.heldRequests(), { timeout: 30_000 }).toBe(1);
    const task = await boardTask(page, STOP_TITLE);
    await pressRow(page, task.key);
    await crewmateByKeys(page);
    const view = crewmateView(page, task.id);
    await expect(view).toHaveAttribute("data-crew-state", "working");

    const field = crewComposer(view);
    await pressKey(field, "Control+c");
    await expect
      .poll(async () =>
        (await detailOf(page, task.id)).events
          .filter((event) => event.kind === "interrupted")
          .map((event) => [event.data?.via, event.data?.mode, event.data?.effect]),
      )
      .toContainEqual([CREWMATE_TAB_VIA, "interrupt", "aborted-turn"]);
    await expect.poll(() => mockProvider?.heldRequests()).toBe(0);
    await expect(view).not.toHaveAttribute("data-crew-state", "working");
    await expect(crewLines(view, "stopped")).toHaveCount(1);
    // Stopped, never closed: the task stays steerable.
    expect((await detailOf(page, task.id)).status).toBe("active");
    await expect(field).toBeVisible();
    await shoot(view, "crewmate-stopped-dark.png");

    await pressKey(field, "Escape");
    await expect(view).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
