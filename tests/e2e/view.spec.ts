import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { joinHome } from "../../src/core/helper/join";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import {
  backWords,
  changesOffWords,
  JOIN_CONFIRM_WORDS,
  JOIN_RUNS_WORK,
  joinRefusalWords,
  leftLine,
  notSentWords,
  pillWords,
  sinceWhen,
  topLine as topLineWords,
  type ViewMac,
} from "../../src/renderer/src/devices/viewWords";
import { builtinManifest } from "../../src/renderer/src/plugins/builtin/manifest";
import type { Card } from "../../src/shared/cards";
import { needsReauthCopy } from "../../src/shared/credentialHealth";
import { COMPUTER, hereAs } from "../../src/shared/deviceNames";
import { deviceJoinedLine, PAIRING_LINK_PREFIX } from "../../src/shared/devices";
import { feedLineFrom } from "../../src/shared/feed";
import {
  RETURN_CONTROL_LABEL,
  rememberSignInLabel,
  TAKE_CONTROL_LABEL,
} from "../../src/shared/taskBrowser";
import type { TaskDetail } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody } from "./frames";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER, startMockProvider } from "./mockProvider";
import { encodePng } from "./pictureFixtures";
import { dropFiles, promptInput } from "./prompt";
import { providerMessages } from "./providerRequest";
import {
  MOCK_BROWSER_BUTTON,
  MOCK_BROWSER_CARD_REPORT,
  MOCK_BROWSER_CARD_TITLE,
  TASK_BROWSER_CARD_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { cardReply, expectNoCard, SHOWN_ENTRY, showCard, shownCard } from "./stack";
import {
  browserView,
  canvasReading,
  clickOnPage,
  closeSite,
  pageSays,
  stopTaskBrowsers,
  typeOnPage,
} from "./taskBrowser";

/**
 * The app as a view of another Mac (docs/view.md), as two people's Macs see
 * it: a second app joins Firstmate on the first with a pasted link at its
 * own first launch, then shows that Mac's cards with their pictures, its
 * feed and its tasks; an answer in either app shows in the other; a button
 * that opens Devices opens that Mac's Devices here and makes its link; while
 * that Mac is out of reach the view says as of when and refuses changes,
 * which never reach it later; a restart there catches the view up; the view
 * itself restarts with no core of its own; and Leave returns it to its own
 * first launch. A file given to the view goes to that Mac with the message
 * when it is a picture or text, and is refused otherwise, since a path on
 * this Mac means nothing there. Both apps run on this Mac, each with its own
 * data, and the Mac where Firstmate lives makes the link as its Devices tab
 * does (devices-links.spec.ts drives that tab and its card).
 */

const PICTURE_TASK = "harbour-task";
const PICTURE = `${PICTURE_TASK}-${"c".repeat(32)}.png`;
/** The seeded cards a step finds by title, each named where it is filed and where it is found. */
const HARBOUR_CHART = "The harbour chart";
const INVITE_CARD = "Connect your iMac";
/** The host's sign-in card for the home's Claude account, in the host's own words. */
const SIGN_IN_CARD = needsReauthCopy("Claude", "Work");
/** Settings sections that stay on the Mac where Firstmate lives, by id. */
const HOME_ONLY_SECTIONS = ["secrets", "observe"] as const;

/** A Settings tab's label, as the built-in manifest names it. */
function sectionLabel(id: string): string {
  const section = builtinManifest.contributes.settingsSections.find((entry) => entry.id === id);
  if (!section) throw new Error(`No Settings section ${id}`);
  return section.label;
}

function seedCard(
  store: CardStore,
  card: Pick<Card, "id" | "title" | "body" | "actions"> & Partial<Card>,
) {
  store.upsert({
    author: "firstmate",
    priority: 50,
    meta: "harbour",
    status: "ready",
    createdAt: Date.now(),
    ...card,
  });
}

/**
 * The Mac where Firstmate lives, before it starts: a task, two choices, a
 * card with a picture, and two cards whose buttons open Settings there.
 */
function seedHome(dir: string) {
  const db = openDatabase(dir);
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: PICTURE_TASK,
    title: "Chart the harbour",
    status: "queued",
    startPolicy: "on-request",
  });
  const cards = new CardStore(db);
  seedCard(cards, {
    id: "flaky",
    title: "Two ways to fix the flaky test",
    body: "<p>Mock the clock, or await the queue. The second is smaller.</p>",
    actions: [
      { id: "clock", label: "Mock the clock" },
      { id: "queue", label: "Await the queue", default: true },
    ],
  });
  seedCard(cards, {
    id: "chart",
    title: HARBOUR_CHART,
    body: `<p>Soundings are in.</p><img src="app-frame://images/${PICTURE}" alt="The harbour chart">`,
    actions: [],
  });
  seedCard(cards, {
    id: "name",
    title: "Name the harbour",
    body: "<p>Two names fit.</p>",
    actions: [
      { id: "north", label: "North Basin" },
      { id: "south", label: "South Basin", default: true },
    ],
  });
  // Two buttons that open Settings there, as the host builds them: Firstmate's
  // offer to connect a Mac, and its own card when an account needs signing in.
  seedCard(cards, {
    id: "invite",
    title: INVITE_CARD,
    body: "<p>Make a link here, then paste it into Infinitary on your iMac.</p>",
    actions: [
      {
        id: "open",
        label: "Make a link",
        variant: "primary",
        default: true,
        effect: { kind: "open", target: "devices", make: "link" },
      },
      { id: "not-now", label: "Not now", variant: "secondary" },
    ],
  });
  seedCard(cards, {
    id: "sign-in-claude",
    author: "host",
    priority: 90,
    meta: "Claude",
    title: SIGN_IN_CARD,
    body: "<p>Your first mate and its crewmates cannot use this account until you sign in.</p>",
    actions: [
      {
        id: "sign-in",
        label: "Sign in",
        variant: "primary",
        effect: { kind: "host", op: "restore-account", arg: "acct-claude" },
      },
    ],
  });
  db.close();
  // The home's own copy of the picture, where the card picture host keeps it.
  const folder = join(dir, "crewmates", PICTURE_TASK, "cards");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, PICTURE),
    encodePng(48, 24, (x) => (x < 24 ? [230, 80, 60] : [60, 110, 230])),
  );
}

const shownIds = (page: Page) =>
  page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.id));
const feedTexts = (page: Page) =>
  page.evaluate(async () => (await window.infinitary.feed.recent()).map((line) => line.text));
const topLine = (page: Page) => page.locator("[data-remote-control]");

/**
 * A task's page with the Name field its crewmate fills, a Town field only the captain types
 * into, and a button that answers with both and keeps the visitor signed in
 * with a cookie, which a remembered sign-in saves.
 */
const SIGN_UP_PAGE = `<!doctype html><html><head><title>Sign up</title></head>
<body><h1>Sign up</h1><label>Name <input id="name"></label> <label>Town <input id="town"></label> <button id="send">Send</button><p id="out"></p>
<script>const v = (id) => document.getElementById(id).value; document.getElementById("send").addEventListener("click", () => { document.cookie = "who=" + encodeURIComponent(v("name")) + "; max-age=3600; path=/"; document.getElementById("out").textContent = "Thanks, " + v("name") + (v("town") ? " from " + v("town") : ""); });</script></body></html>`;
/**
 * Watch for the pill that says that Mac is back. It shows once when contact
 * returns and fades a few seconds later, and the view can reconnect while the
 * restarted Mac's launch is still under way - so a check after that launch
 * could find it already gone. The watch records its words the moment it
 * shows, and the returned reader lists what it said since the watch began.
 */
async function watchBackPill(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __backSaid?: string[]; __backWatch?: MutationObserver };
    w.__backWatch?.disconnect();
    const said: string[] = [];
    w.__backSaid = said;
    const look = () => {
      const words = document.querySelector('[data-view-pill="back"] [data-view-pill-words]');
      const text = words?.textContent ?? "";
      if (text && said.at(-1) !== text) said.push(text);
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-view-pill"],
    });
    w.__backWatch = observer;
    look();
  });
  return () =>
    page.evaluate(() => [...((window as unknown as { __backSaid?: string[] }).__backSaid ?? [])]);
}
/**
 * Watch how fresh the top line says the view is (docs/view.md, "Live,
 * catching up or out of reach"). A catch-up can pass in a moment, so the
 * watch records each state, and how it catches up, the moment it shows; the
 * returned reader lists them since the watch began.
 */
async function watchFreshness(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __freshSaid?: string[]; __freshWatch?: MutationObserver };
    w.__freshWatch?.disconnect();
    const said: string[] = [];
    w.__freshSaid = said;
    const look = () => {
      const line = document.querySelector("[data-remote-control]");
      const fresh = line?.getAttribute("data-freshness");
      if (!fresh) return;
      const how = line?.getAttribute("data-catch-up");
      const state = how ? `${fresh}:${how}` : fresh;
      if (said.at(-1) !== state) said.push(state);
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-freshness", "data-catch-up"],
    });
    w.__freshWatch = observer;
    look();
  });
  return () =>
    page.evaluate(() => [...((window as unknown as { __freshSaid?: string[] }).__freshSaid ?? [])]);
}
/** Words the view says in the state given, which says some. */
function said(words: string | null): string {
  if (words === null) throw new Error("The view says nothing in that state.");
  return words;
}
/** What the record this app holds itself is made of, for "keeps no record". */
const recordFiles = (dir: string) =>
  ["firstmate.db", "firstmate.db-wal"].map((file) => {
    try {
      const stat = statSync(join(dir, file));
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${file}:none`;
    }
  });

test("a second Mac joins at its first launch, controls this Firstmate, rides out its restart, and leaves", async () => {
  // Three launches of the Mac where Firstmate lives or the one that joins it.
  test.setTimeout(180_000);
  const homeDir = scratchDir("infinitary-view-home-");
  seedHome(homeDir);
  const proEnv = { INFINITARY_DEVICE_NAME: "MacBook Pro" };
  const airEnv = { INFINITARY_DEVICE_NAME: "MacBook Air" };
  /** The Mac where Firstmate lives as the view sees it, for the words the view says of it. */
  const seenPro = (contact: ViewMac["contact"], heardAt: number | null = null): ViewMac => ({
    role: "view",
    name: proEnv.INFINITARY_DEVICE_NAME,
    address: "127.0.0.1",
    joinedAt: 0,
    contact,
    readOnly: null,
    heardAt,
    caughtUp: 0,
  });
  // One mock provider for both runs of the Mac where Firstmate lives, so
  // every request it ever got can be read at the end.
  const provider = await startMockProvider();
  let pro: LaunchedApp = await launchApp({
    userDataDir: homeDir,
    reuseMockProvider: provider,
    env: proEnv,
  });
  let air: LaunchedApp | undefined;
  try {
    await test.step("joins with the link pasted at its own first launch", async () => {
      // The captain's own link, as Settings -> Devices makes it.
      const invite = await pro.page.evaluate(() =>
        window.infinitary.devices.invite({ kind: "mac" }),
      );
      air = await launchApp({ env: airEnv });
      const { page } = air;
      await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
      await page.locator("[data-join-chip]").click();
      // Text that is not a link is refused before anything is sent.
      const field = page.getByLabel(`The link from your other ${COMPUTER.one}`);
      await field.fill("https://example.com/join");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator("[data-join-warn]")).toContainText(
        joinRefusalWords("not-a-link", null),
      );
      await field.fill(invite.link);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator('[data-join-another-mac="confirm"]')).toContainText(
        JOIN_CONFIRM_WORDS.before,
      );
      await page.getByRole("button", { name: "Control it from here" }).click();
      // The window starts over as the other Mac's.
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect(topLine(page)).toContainText(topLineWords(seenPro("in-reach")).lead);
      // Live once it has read what that Mac holds.
      await expect(topLine(page)).toHaveAttribute("data-freshness", "live");
      await expect(topLine(page)).toContainText(said(topLineWords(seenPro("in-reach")).tail));
      await expect(topLine(page)).toContainText("MacBook Pro");
      expect(
        (await pro.page.evaluate(() => window.infinitary.devices.list())).map((d) => d.name),
      ).toEqual(["MacBook Air"]);
      await expect
        .poll(() => feedTexts(pro.page))
        .toContain(deviceJoinedLine({ name: "MacBook Air", kind: "view" }));
    });

    await test.step("shows that Mac's cards with their pictures, its feed and its tasks", async () => {
      const { page } = air as LaunchedApp;
      await expect.poll(() => shownIds(page)).toEqual(expect.arrayContaining(["flaky", "chart"]));
      await showCard(page, HARBOUR_CHART);
      const picture = cardBody(page, HARBOUR_CHART).locator("img");
      await expect
        .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(48);
      // That Mac's own line names it where it says this computer (docs/view.md, "The first mate's own words").
      expect(await feedTexts(page)).toContain(
        hereAs(
          deviceJoinedLine({ name: "MacBook Air", kind: "view" }),
          proEnv.INFINITARY_DEVICE_NAME,
        ),
      );
      const board = await page.evaluate(() => window.infinitary.tasks.board());
      expect(board.tasks.map((task) => task.title)).toContain("Chart the harbour");
      // Its computers are that Mac's, asked there (INF-1352's plan, piece 2).
      expect(
        (await page.evaluate(() => window.infinitary.devices.list())).map((d) => d.name),
      ).toEqual(["MacBook Air"]);
    });

    await test.step("an answer in either app shows in the other", async () => {
      const { page } = air as LaunchedApp;
      await showCard(page, "Two ways to fix the flaky test");
      await page.getByRole("button", { name: "Await the queue" }).click();
      await expect.poll(() => shownIds(pro.page)).not.toContain("flaky");
      await pro.page.evaluate(() => window.infinitary.cards.noteDone("chart"));
      await expect.poll(() => shownIds(page)).not.toContain("chart");
      await expectNoCard(page, HARBOUR_CHART);
    });

    await test.step("a Devices button opens that Mac's Devices here and makes its link", async () => {
      const { page } = air as LaunchedApp;
      await showCard(page, INVITE_CARD);
      const card = shownCard(page, INVITE_CARD);
      await card.getByRole("button", { name: "Make a link", exact: true }).click();
      await expect(page.locator("[data-devices]")).toBeVisible();
      await expect(page.locator('[data-panel-state="open"] [data-device-link]')).toContainText(
        PAIRING_LINK_PREFIX,
      );
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.locator('[data-screen-label="Settings"]')).toHaveCount(0);
    });

    await test.step("while that Mac is out of reach it says since when, and refuses changes", async () => {
      const { page } = air as LaunchedApp;
      await pro.close();
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "closed");
      await expect(topLine(page)).toHaveAttribute("data-freshness", "out-of-reach");
      await expect(topLine(page)).toContainText(said(topLineWords(seenPro("closed", 0)).tail));
      // Since the last word it heard there, naming the day when it was not today.
      const away = await page.evaluate(() => window.infinitary.devices.thisMac());
      const heardAt = away.role === "view" ? away.heardAt : null;
      expect(heardAt).not.toBeNull();
      await expect(topLine(page).locator("[data-since]")).toHaveText(
        sinceWhen(heardAt as number, Date.now()),
      );
      await expect(page.locator("[data-view-pill]")).toContainText(
        said(pillWords(seenPro("closed"))),
      );
      await showCard(page, "Name the harbour");
      await expect(page.getByRole("button", { name: "South Basin" })).toBeDisabled();
      const input = promptInput(page);
      await input.fill("also check the search page");
      await input.press("Enter");
      await expect(page.locator('[data-composer-notice="away"]')).toContainText(
        notSentWords(seenPro("closed")),
      );
      await expect(input).toHaveValue("also check the search page");
    });

    await test.step("a restart there catches this Mac up, and nothing refused is sent", async () => {
      const { page } = air as LaunchedApp;
      // A card the other Mac gained while this one could not hear it.
      const db = openDatabase(homeDir);
      seedCard(new CardStore(db), {
        id: "tide",
        title: "The tide table",
        body: "<p>High water at noon.</p>",
        actions: [{ id: "ok", label: "Thanks", default: true }],
      });
      db.close();
      const backSaid = await watchBackPill(page);
      const freshSaid = await watchFreshness(page);
      pro = await launchApp({ userDataDir: homeDir, reuseMockProvider: provider, env: proEnv });
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach", {
        timeout: 30_000,
      });
      await expect(topLine(page)).toHaveAttribute("data-freshness", "live", { timeout: 30_000 });
      // Out of reach, then catching up by reading everything again - a restart
      // there began a new numbering - and live only once that is read.
      expect((await freshSaid()).filter((state) => state !== "reaching")).toEqual([
        "out-of-reach",
        "catching-up:reload",
        "live",
      ]);
      await expect.poll(backSaid).toContain(backWords(seenPro("in-reach")));
      await expect.poll(() => shownIds(page)).toContain("tide");
      await showCard(page, "Name the harbour");
      await expect(page.getByRole("button", { name: "South Basin" })).toBeEnabled();
      // The words typed while it was away stay here, and the other Mac never got them.
      await expect(promptInput(page)).toHaveValue("also check the search page");
      expect(provider.requestBodies().join("\n")).not.toContain("also check the search page");
      expect((await feedTexts(pro.page)).join("\n")).not.toContain("also check the search page");
    });

    await test.step("starts again as a view, with no core and no record of its own", async () => {
      const joined = air as LaunchedApp;
      await joined.close();
      const before = recordFiles(joined.userDataDir);
      air = await launchApp({
        userDataDir: joined.userDataDir,
        homeDir: joined.homeDir,
        env: airEnv,
      });
      const { page } = air;
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect.poll(() => shownIds(page)).toContain("tide");
      await showCard(page, "The tide table");
      await page.getByRole("button", { name: "Thanks" }).click();
      await expect.poll(() => shownIds(pro.page)).not.toContain("tide");
      expect(recordFiles(joined.userDataDir)).toEqual(before);
    });

    await test.step("Leave returns it to its own first launch", async () => {
      const { page } = air as LaunchedApp;
      await page.getByRole("button", { name: "Settings" }).click();
      // The other Mac's own settings stay there (docs/view.md, "Settings on a view").
      for (const id of HOME_ONLY_SECTIONS)
        await expect(page.getByRole("tab", { name: sectionLabel(id), exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: sectionLabel("devices"), exact: true }).click();
      await page.getByRole("button", { name: "Leave MacBook Pro" }).click();
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-left-mac]")).toHaveText(
        leftLine({ name: proEnv.INFINITARY_DEVICE_NAME, reason: "left", at: 0 }),
      );
      await expect(topLine(page)).toHaveCount(0);
      // None of that Mac's cards are this app's.
      expect(await shownIds(page)).not.toContain("name");
      expect(await pro.page.evaluate(() => window.infinitary.devices.list())).toEqual([]);
      // The feed's words for it name the Mac alone, so its id is left empty.
      const airLeft = feedLineFrom({
        type: "device_left",
        deviceId: "",
        name: airEnv.INFINITARY_DEVICE_NAME,
        kind: "view",
      });
      await expect.poll(() => feedTexts(pro.page)).toContain(airLeft?.text);
    });
  } finally {
    await air?.close();
    await pro.close();
    await provider.close();
  }
});

test("a file given on the Mac that controls goes with the message when it is a picture or text, and is refused otherwise", async () => {
  // Two launches: the Mac where Firstmate lives and the one that joins it.
  test.setTimeout(120_000);
  const homeDir = scratchDir("infinitary-view-files-home-");
  seedHome(homeDir);
  const files = scratchDir("infinitary-view-files-");
  const pdf = join(files, "Harbour survey.pdf");
  writeFileSync(
    pdf,
    Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0, 1, 2])]),
  );
  const pictureBytes = encodePng(16, 16, (x) => (x < 8 ? [230, 80, 60] : [60, 110, 230]));
  const picture = join(files, "soundings.png");
  writeFileSync(picture, pictureBytes);
  const notes = join(files, "tide notes.txt");
  writeFileSync(notes, "High water at noon.\nLow water at six.\n");
  const provider = await startMockProvider();
  const pro = await launchApp({
    userDataDir: homeDir,
    reuseMockProvider: provider,
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
  });
  let air: LaunchedApp | undefined;
  try {
    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
    const { page, app } = air;
    // Joining starts the window over as the other Mac's, so the call is not awaited in it.
    await page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
    const input = promptInput(page);
    const shell = page.locator("[data-voice-input-shell]");
    const refused = page.locator('[data-composer-notice="file-other-mac"]');

    await test.step("a picture and a text file become chips; any other file is not added, and the line names that Mac", async () => {
      await input.fill("Use these for the chart");
      await dropFiles(page, shell, [picture, notes, pdf]);
      await expect(shell.locator("[data-voice-input-attachment]")).toContainText("soundings.png");
      await expect(shell.locator("[data-voice-input-paste]")).toContainText("tide notes.txt");
      await expect(refused).toContainText("MacBook Pro");
      await expect(input).toHaveValue("Use these for the chart");
    });

    await test.step("sending takes the picture and the text to that Mac, and no path on this one", async () => {
      await input.press("Enter");
      await expect(input).toHaveValue("");
      // The line leaves with the message it was about.
      await expect(refused).toHaveCount(0);
      const sent = () =>
        provider
          .requestBodies()
          .flatMap(providerMessages)
          .filter((message) => message.role === "user")
          .map((message) => message.text)
          .find((text) => text.includes("[attached file: tide notes.txt]"));
      await expect.poll(sent, { timeout: 30_000 }).toBeTruthy();
      const words = sent() ?? "";
      expect(words).toContain("Use these for the chart");
      // The text's full copy is kept on the Mac where Firstmate lives, where its crewmates read it.
      const pointer = /full text: (\S+\.txt)\]/.exec(words)?.[1] ?? "";
      expect(existsSync(pointer)).toBe(true);
      expect(realpathSync(dirname(pointer))).toBe(realpathSync(join(homeDir, "overflow")));
      // The picture reached that Mac's model, and that Mac keeps its own copy for the message.
      const bodies = provider.requestBodies().join("\n");
      expect(bodies).toContain(pictureBytes.toString("base64"));
      expect(readdirSync(join(homeDir, "attachments"))).toHaveLength(1);
      // Nothing names the refused file or a place on this Mac.
      expect(bodies).not.toContain("Harbour survey.pdf");
      expect(bodies).not.toContain(realpathSync(files));
      expect(bodies).not.toContain(files);
    });

    await test.step("the picker and a card's reply follow the same rule", async () => {
      await app.evaluate(
        ({ dialog }, paths) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: paths,
          })) as typeof dialog.showOpenDialog;
        },
        [pdf],
      );
      await input.fill("picked");
      await page.getByRole("button", { name: "Add files", exact: true }).click();
      await expect(refused).toContainText("MacBook Pro");
      await expect(input).toHaveValue("picked");

      await showCard(page, "Name the harbour");
      const reply = cardReply(page);
      await reply.field.fill("North fits better");
      await dropFiles(page, reply.row, [pdf]);
      await expect(reply.notice("file-other-mac")).toContainText("MacBook Pro");
      await expect(reply.field).toHaveValue("North fits better");
    });
  } finally {
    await air?.close();
    await pro.close();
    await provider.close();
  }
});

test("a Mac joined at its first launch also runs that Mac's work, and one a command added opens Firstmate to control it with no new link", async () => {
  test.setTimeout(180_000);
  // The Mac where Firstmate lives takes every app that joins it for another
  // Mac, as two Macs would be; this Mac stands in for both.
  const pro = await launchApp({
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro", INFINITARY_JOINS_FROM_ANOTHER_MAC: "1" },
  });
  const listed = async (name: string) =>
    (await pro.page.evaluate(() => window.infinitary.devices.list())).find(
      (device) => device.name === name,
    );
  const runs: HelperRun[] = [];
  let air: LaunchedApp | undefined;
  let mini: LaunchedApp | undefined;
  try {
    await test.step("a link pasted at first launch adds a Mac that controls this Firstmate and runs its work", async () => {
      const invite = await pro.page.evaluate(() =>
        window.infinitary.devices.invite({ kind: "mac" }),
      );
      air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
      const { page } = air;
      await page.locator("[data-join-chip]").click();
      await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(invite.link);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.locator('[data-join-another-mac="confirm"]')).toContainText(JOIN_RUNS_WORK);
      await page.getByRole("button", { name: "Control it from here" }).click();
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect
        .poll(() => listed("MacBook Air"))
        .toMatchObject({
          kind: "mac",
          controlling: true,
          user: userInfo().username,
        });
      await expect
        .poll(() => feedTexts(pro.page))
        .toContain(deviceJoinedLine({ name: "MacBook Air", kind: "mac" }));

      // Its work keeps the same grant in its own folder; started there - by
      // the background, on a real Mac - it is in reach to run work, beside
      // its window, and a project may be set to run on it.
      const workDir = join(air.userDataDir, "work");
      expect(new JoinedHome(workDir).read()?.grant.kind).toBe("mac");
      const started = startHelper({
        dataDir: workDir,
        say: () => {},
        retryMs: [50],
        log: () => {},
      });
      if (!started.ok) throw new Error(started.reason);
      runs.push(started.run);
      await expect
        .poll(() => listed("MacBook Air"))
        .toMatchObject({ inReach: true, controlling: true });
      const deviceId = (await listed("MacBook Air"))?.id;
      expect(
        (await pro.page.evaluate(() => window.infinitary.devices.signIns())).map(
          (computer) => computer.deviceId,
        ),
      ).toContain(deviceId);
      // Nothing runs there until a project is set to run on it.
      expect(await listed("MacBook Air")).toMatchObject({ tasks: 0, runs: [] });
    });

    await test.step("a Mac a command added opens Firstmate there and controls this one, with no new link", async () => {
      const invite = await pro.page.evaluate(() =>
        window.infinitary.devices.invite({ kind: "mac" }),
      );
      // The command's join, as it runs in Terminal there, with its yes.
      const workDir = join(scratchDir("infinitary-view-mini-"), "work");
      const joined = await joinHome({
        text: invite.link,
        dataDir: workDir,
        io: { say: () => {}, ask: async () => "yes" },
        device: { name: "Mac mini", user: { name: "sam", uid: 501 } },
        timeoutMs: 5_000,
      });
      expect(joined).toMatchObject({ ok: true, grant: { kind: "mac" } });

      mini = await launchApp({
        env: { INFINITARY_DEVICE_NAME: "Mac mini", INFINITARY_HELPER_DATA_DIR: workDir },
      });
      const { page } = mini;
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
      await expect(topLine(page)).toContainText("MacBook Pro");
      await expect(page.locator('[data-first-run-gate="open"]')).toHaveCount(0);
      await expect.poll(() => listed("Mac mini")).toMatchObject({ kind: "mac", controlling: true });

      // This Mac runs that Mac's work, so Leave asks about that too.
      expect(await page.evaluate(() => window.infinitary.devices.thisMac())).toMatchObject({
        role: "view",
        runsWork: true,
      });
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("tab", { name: "Devices", exact: true }).click();
      await page.getByRole("button", { name: "Leave MacBook Pro" }).click();
      await expect(page.locator("[data-leaving]")).toBeVisible();
    });
  } finally {
    await Promise.all(runs.map((run) => run.stop()));
    await mini?.close();
    await air?.close();
    await pro.close();
  }
});

// INF-1352's plan, piece 3, checked by: "The view journey takes over a task's browser from the
// second app and types into it." Any view watches a task's browser as pictures over the
// connection, takes control there, and sends its presses back.
test("a Mac that controls another takes over a task's browser there and types into its page", async () => {
  // Two launches, and a crewmate's run that opens its browser on a page.
  test.setTimeout(180_000);
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SIGN_UP_PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const provider = await startMockProvider({ scenarios: [taskBrowserJourneys] });
  const pro = await launchApp({
    reuseMockProvider: provider,
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
  });
  let air: LaunchedApp | undefined;
  try {
    const title = `${TASK_BROWSER_CARD_MARKER}${siteUrl} as Sam`;
    await promptInput(pro.page).fill(`${SPAWN_PROMPT_MARKER} ${title}`);
    await promptInput(pro.page).press("Enter");
    const detail = (): Promise<TaskDetail | null> =>
      pro.page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find((t) => t.title === wanted);
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, title);
    await expect
      .poll(async () => (await detail())?.outcome ?? "", { timeout: 90_000 })
      .toContain(MOCK_BROWSER_CARD_REPORT);
    const task = (await detail()) as TaskDetail;

    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
    const { page } = air;
    // Joining starts the window over as the other Mac's, so the call is not awaited in it.
    await page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(topLine(page)).toHaveAttribute("data-remote-control", "in-reach");
    const view = browserView(page, task.id);

    await test.step("the card's door shows the page there as pictures", async () => {
      await showCard(page, MOCK_BROWSER_CARD_TITLE);
      await page
        .locator(`${SHOWN_ENTRY} [data-card-attachment="browser"]`)
        .getByRole("button", { name: MOCK_BROWSER_BUTTON })
        .click();
      // The crewmate's turn has ended, so nobody drives the page it left open.
      await expect(view).toHaveAttribute("data-browser-state", "nobody");
      await expect.poll(async () => (await canvasReading(page)).frames).toBeGreaterThan(0);
    });

    await test.step("Take control hands the page to this Mac, and what it types reaches the page there", async () => {
      await view.getByRole("button", { name: TAKE_CONTROL_LABEL }).click();
      await expect(view).toHaveAttribute("data-browser-state", "captain");
      await expect
        .poll(async () => (await detail())?.browser)
        .toMatchObject({ control: "captain" });
      // The crewmate filled Name; Town is the captain's alone, typed from this Mac.
      await typeOnPage(pro.app, page, task.id, siteUrl, "town", "Leeds");
      await expect.poll(() => pageSays(pro.app, siteUrl, "town", "value")).toBe("Leeds");
      await clickOnPage(pro.app, page, task.id, siteUrl, "send");
      await expect.poll(() => pageSays(pro.app, siteUrl, "out")).toBe("Thanks, Sam from Leeds");
    });

    await test.step("Return control with Remember ticked hands the page back and keeps the sign-in where the first mate lives", async () => {
      const site = new URL(siteUrl).host;
      // The choice names the computer that keeps the sign-in, not this one.
      await view
        .locator("[data-browser-sharing]")
        .getByRole("checkbox", { name: rememberSignInLabel(site, { this: "MacBook Pro" }) })
        .check();
      await view.getByRole("button", { name: RETURN_CONTROL_LABEL }).click();
      await expect
        .poll(async () => (await detail())?.browser)
        .toMatchObject({ saved: [site], returned: true });
      expect((await detail())?.browser).not.toMatchObject({ control: "captain" });
      // Saved on the first mate's computer, and nothing kept on the one that controls it.
      expect(existsSync(join(pro.userDataDir, "web-sign-ins"))).toBe(true);
      expect(existsSync(join((air as LaunchedApp).userDataDir, "web-sign-ins"))).toBe(false);
    });

    await test.step("while that Mac is out of reach, Take control is marked off with the reason", async () => {
      await pro.close();
      await expect(topLine(page)).toHaveAttribute("data-remote-control", "closed");
      const take = view.getByRole("button", { name: TAKE_CONTROL_LABEL });
      await expect(take).toBeDisabled();
      await expect(take).toHaveAttribute(
        "aria-description",
        changesOffWords({
          role: "view",
          name: "MacBook Pro",
          address: "127.0.0.1",
          joinedAt: 0,
          contact: "closed",
          readOnly: null,
          heardAt: null,
          caughtUp: 0,
        }),
      );
    });
  } finally {
    await stopTaskBrowsers(pro.page).catch(() => undefined);
    await air?.close();
    await pro.close();
    await provider.close();
    await closeSite(site);
  }
});
