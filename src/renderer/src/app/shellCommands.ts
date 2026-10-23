import {
  isPanelCommandId,
  isShellCommand,
  type PanelCommandId,
  type ShellCommandId,
  type WindowCommandId,
} from "@shared/keyboard";
import { cardTaskOf } from "../cards/cardTask";
import {
  shownTaskTabs,
  type TabCommand,
  tabKindOf,
  tabShownOf,
  tabTargetOf,
  tabTaskOf,
} from "../cards/taskTabs";
import { crewOrbit } from "../character/crew/crewSignal";
import { focusWithRing } from "../design/focus";
import { giveFocusBack } from "../plugins/frames/frameFocus";
import { pluginHost } from "../plugins/host";
import { panelCommandRefusal, runPanelCommand } from "../plugins/panelCommands";
import { cardStage } from "./cardStage";
import { commandRefusal, shownEntry, type WindowFacts } from "./commandRefusals";
import { available, modalOpen } from "./focusRecovery";
import { enterCard, moveToRegion } from "./regions";
import { isHeldEntry, type ShellState, useShellStore } from "./store";
import { markWindowKeys } from "./windowKeysMark";

/**
 * The window commands the shell page runs (docs/keyboard.md). The main
 * process hears their keys wherever focus is, a card's or a panel's frame
 * included, and names the command; whether it may run now is decided here
 * (./commandRefusals), against the window as it is when the command arrives,
 * and a refused command's key does nothing.
 */

/** Keyboard settings' search field, which Open Keyboard settings gives the caret. */
const KEYBOARD_SEARCH = "[data-keyboard-settings] [data-keyboard-search] input";

/** Usage's unit switch, its first control, where Open Usage puts focus. */
const USAGE_UNIT = '[data-settings-section="usage"] [data-usage-unit] input:checked';

/** Acts on the stage's shown card only while the store still shows it. */
function onShownCard(act: (stage: NonNullable<ReturnType<typeof cardStage>>) => void): void {
  const stage = cardStage();
  if (stage && stage.shownId === shownEntry(useShellStore.getState())?.id) act(stage);
}

/** A tab command on the shown task card's strip, while the store still shows that card. */
function toTab(command: TabCommand): void {
  const shell = useShellStore.getState();
  const entry = shownEntry(shell);
  if (entry && !isHeldEntry(entry)) {
    // A card about a task: its tab opens in front of the card, which Hide
    // returns to (INF-358); the refusal already said when it cannot.
    const task = cardTaskOf(entry);
    const wanted = tabKindOf(command);
    if (!task || !wanted) return;
    const from = { cardId: entry.id };
    if (wanted === "info") shell.openRecord(task.id, from);
    else if (wanted === "crewmate") shell.openCrewmateView(task.id, from);
    else shell.openBrowserView(task.id, from);
    return;
  }
  const taskId = entry && tabTaskOf(entry);
  const kind = entry && tabShownOf(entry);
  const handle = taskId && kind ? shownTaskTabs(taskId, kind) : undefined;
  const to = handle ? tabTargetOf(command, handle) : null;
  if (handle && to !== null) handle.go(to);
}

/**
 * Runs `then` once `ready` holds, checking each frame for about half a
 * second: a view the command just went home to draws on the next frames.
 */
function whenReady(ready: () => boolean, then: () => void, frames = 30): void {
  if (ready()) {
    then();
    return;
  }
  if (frames > 0) requestAnimationFrame(() => whenReady(ready, then, frames - 1));
}

/** A place in the shown entry (`selector`), while the stage shows that entry ready to use. */
function shownPart(entryId: string, selector: string): HTMLElement | null {
  const part = document.querySelector<HTMLElement>(
    `[data-card-layer] [data-stage-entry="shown"][data-stage-entry-id="${CSS.escape(entryId)}"] ${selector}`,
  );
  return part && available(part) ? part : null;
}

/** The shown card's reply field. */
const replyField = (cardId: string) =>
  shownPart(cardId, `[data-card-reply="${CSS.escape(cardId)}"] textarea`);

/** The shown card's Anything else? box. */
const commentField = (cardId: string) =>
  shownPart(cardId, `[data-card-comment="${CSS.escape(cardId)}"] textarea:not([readonly])`);

/** The shown entry's body, the one place it scrolls. */
const cardBody = (entryId: string) => shownPart(entryId, "[data-card-body]");

/** The shown card's buttons: its default, or else the first a person can press. */
const cardButton = (cardId: string) =>
  shownPart(cardId, "[data-card-actions] button[data-card-action-default]:enabled") ??
  shownPart(cardId, "[data-card-actions] button:enabled");

/** Presses the shown card's nth choice (`choiceOrder`), the click the pointer would make. */
function pressCardChoice(index: number): void {
  const entryId = shownEntry(useShellStore.getState())?.id;
  if (!entryId) return;
  shownPart(entryId, `[data-card-actions] [data-card-choice="${index}"]`)?.click();
}

/**
 * Goes to a place in the entry the store shows now (docs/keyboard.md,
 * "Cards and frames"), from Settings by going home first: once it is drawn,
 * `enter` puts focus there, and only while that entry is still the shown
 * one, never another shown since.
 */
function toShownPart(
  find: (entryId: string) => HTMLElement | null,
  enter: (place: HTMLElement) => void,
): void {
  const s = useShellStore.getState();
  const entryId = shownEntry(s)?.id;
  if (!entryId) return;
  if (s.view !== "home") s.setView("home");
  const stillShown = () => shownEntry(useShellStore.getState())?.id === entryId;
  whenReady(
    () => !stillShown() || find(entryId) !== null,
    () => {
      const place = stillShown() ? find(entryId) : null;
      if (place) enter(place);
    },
  );
}

/**
 * The body takes focus as the place to read it: the reading keys scroll it,
 * and Tab goes on to the first control inside. It is no Tab stop of its
 * own, so a click on it never takes focus from the main message.
 */
function enterBody(body: HTMLElement): void {
  body.tabIndex = -1;
  body.addEventListener("blur", () => body.removeAttribute("tabindex"), { once: true });
  focusWithRing(body, { preventScroll: true });
}

/**
 * What's new (docs/release-notes.md "Reading a note again"): goes home and
 * asks the core's one door for the note shown for `version`, or else the
 * newest that listed changes. The core brings it forward on every window: an
 * open note to the front of the stack, a closed one read-only.
 */
export function showReleaseNote(version: string | null): void {
  const s = useShellStore.getState();
  if (s.view !== "home") s.setView("home");
  void window.infinitary.releaseNotes.show(version).catch(() => {});
}

/** What had focus when command search opened: where Escape returns it. */
let searchOpener: Element | null = null;

/** Command search's field, once it takes focus. */
function searchField(): HTMLElement | null {
  const field = document.querySelector<HTMLElement>("[data-command-search] input");
  return field && available(field) ? field : null;
}

/** Opens command search over the window, remembering what had focus. */
export function openCommandSearch(): void {
  const s = useShellStore.getState();
  if (s.commandSearchOpen) return;
  searchOpener = document.activeElement;
  s.setCommandSearchOpen(true);
  // Every opening puts the caret in the field, also one that arrives before
  // the window has drawn the last closing, which leaves the field drawn.
  const open = () => useShellStore.getState().commandSearchOpen;
  whenReady(
    () => !open() || searchField() !== null,
    () => {
      if (open()) searchField()?.focus({ preventScroll: true });
    },
  );
}

/**
 * Closes command search and gives focus back at once, before any command
 * chosen in it runs: to what had it, or else to the main message. Escape,
 * its own key, a click beside it and a chosen command all close it here.
 * Focus that was inside a card's or a panel's frame goes back to the field
 * inside it, its caret where it was, as when the picture viewer closes
 * (../plugins/frames/frameFocus).
 */
export function closeCommandSearch(): void {
  const s = useShellStore.getState();
  if (!s.commandSearchOpen) return;
  s.setCommandSearchOpen(false);
  const opener = searchOpener;
  searchOpener = null;
  // With nothing to give focus back to, the main message takes it, unless
  // the command search runs next puts it somewhere itself.
  if (!giveFocusBack(opener) && s.view === "home") s.focusMainMessage({ yields: true });
}

const SHELL_COMMANDS: Readonly<Record<ShellCommandId, () => void>> = {
  // Its own key closes it again.
  "commands.search": () => {
    if (useShellStore.getState().commandSearchOpen) closeCommandSearch();
    else openCommandSearch();
  },
  "focus.main-message": () => useShellStore.getState().focusMainMessage(),
  // From Settings it goes home first; the words and caret wait in the field.
  "focus.card-reply": () => toShownPart(replyField, (field) => field.focus()),
  "focus.card-comment": () => toShownPart(commentField, (field) => field.focus()),
  "focus.card-body": () => toShownPart(cardBody, enterBody),
  // Focus only: the button is pressed by its own key, through the click's checks.
  "focus.card-actions": () => toShownPart(cardButton, (button) => focusWithRing(button)),
  // The click itself: unanswered questions, pending and disabled stay the button's.
  "cards.choice-1": () => pressCardChoice(0),
  "cards.choice-2": () => pressCardChoice(1),
  "cards.choice-3": () => pressCardChoice(2),
  "cards.choice-4": () => pressCardChoice(3),
  "regions.next": () => moveToRegion(1),
  "regions.previous": () => moveToRegion(-1),
  "computers.previous": () => crewOrbit().setPage(crewOrbit().page - 1),
  "computers.next": () => crewOrbit().setPage(crewOrbit().page + 1),
  "cards.previous": () => onShownCard((stage) => stage.page(-1)),
  "cards.next": () => onShownCard((stage) => stage.page(1)),
  "cards.close": () => onShownCard((stage) => stage.close()),
  "cards.minimize": () => onShownCard((stage) => stage.minimize?.()),
  "cards.maximize": () => onShownCard((stage) => stage.toggleSize()),
  "cards.next-revision": () =>
    toShownPart(cardBody, (body) =>
      body.dispatchEvent(new Event("fm-next-revision", { bubbles: true })),
    ),
  "cards.thread": () => onShownCard((stage) => stage.thread?.()),
  "cards.show-info": () => toTab("cards.show-info"),
  "cards.show-crewmate": () => toTab("cards.show-crewmate"),
  "cards.show-browser": () => toTab("cards.show-browser"),
  "cards.next-tab": () => toTab("cards.next-tab"),
  "cards.previous-tab": () => toTab("cards.previous-tab"),
  "settings.open": () => useShellStore.getState().setView("settings"),
  // Settings → Keyboard, with the caret in its search.
  "settings.keyboard": () =>
    openSettingsAt("keyboard", KEYBOARD_SEARCH, (search) => search.focus({ preventScroll: true })),
  "whats-new.show": () => showReleaseNote(null),
  "settings.usage": openUsage,
  "settings.automation": openAutomation,
  "settings.integrations": openIntegrations,
  "automation.pause-all": () => {
    openAutomation();
    window.infinitary.automation.pauseAll().catch((error: unknown) => {
      console.warn("[infinitary] Pause all automations did not run:", error);
    });
  },
  // Settings → Devices, where each Mac this Mac stopped trying over its own
  // SSH is tried once more and says how it went.
  "devices.try-again": () => {
    useShellStore.setState({ view: "settings", settingsSection: "devices" });
    void window.infinitary.devices.tryAgain().catch(() => {});
  },
  // The other unit, saved by the core, seen in Usage.
  "usage.unit": () => {
    const s = useShellStore.getState();
    s.setUsageUnit(s.usageUnit === "tokens" ? "usd" : "tokens");
    openUsage();
  },
};

/**
 * Opens Settings at `section`, from anywhere, Settings included, and puts
 * focus on the first `place` there once the section draws it. A window that
 * paints late draws it many frames on, after a person may already have
 * pressed into the section: focus they moved there since stays where they
 * put it (INF-963).
 */
function openSettingsAt(
  section: string,
  place: string,
  enter: (found: HTMLElement) => void = focusWithRing,
): void {
  const from = document.activeElement;
  useShellStore.setState({ view: "settings", settingsSection: section });
  whenReady(
    () => document.querySelector(place) !== null,
    () => {
      const now = document.activeElement;
      if (now !== from && now?.closest(`[data-settings-section="${CSS.escape(section)}"]`)) return;
      const found = document.querySelector<HTMLElement>(place);
      if (found) enter(found);
    },
  );
}

/** Settings → Automation, with focus on New automation. */
function openAutomation(): void {
  openSettingsAt("automation", "[data-automation-new]");
}

/** Settings → Integrations, with focus on its first row or add chip. */
function openIntegrations(): void {
  openSettingsAt("integrations", INTEGRATIONS_FIRST);
}

/** The tab's first control: a row's disclosure, or an add chip with nothing connected. */
const INTEGRATIONS_FIRST = "[data-integration-toggle], [data-integration-add]";

/** Settings → Usage, with focus on its unit switch. */
function openUsage(): void {
  openSettingsAt("usage", USAGE_UNIT);
}

/** The window's own facts a refusal reads, as they stand now. */
function windowFacts(): WindowFacts {
  return {
    dialogOpen: modalOpen(),
    computers: { page: crewOrbit().page, pages: crewOrbit().pages },
    panelCommand: (id, recording) => panelCommandRefusal(pluginHost, id, recording),
  };
}

/**
 * Why a window command cannot run now, in the words a person reads, or null
 * (./commandRefusals). Command search reads its rows as the window would
 * stand once it closes.
 */
export function windowCommandRefusal(
  id: WindowCommandId | PanelCommandId,
  s: ShellState = useShellStore.getState(),
): string | null {
  return commandRefusal(id, s, windowFacts());
}

/**
 * How long a panel's card a command put up may take to draw before it is
 * given focus, in frames (about two seconds): a card born with the command
 * starts a page of its own, which reads and draws before the stage shows it.
 */
const PANEL_CARD_DRAW_FRAMES = 120;

/**
 * A panel's card a command put up takes the keyboard's focus once the stage
 * shows it drawn, as F6 enters a card: its page, when it has one. Once the
 * captain pages away or opens command search, the pending move is forgotten,
 * even if that card comes to the front again before it draws.
 */
export function focusPanelCard(entryId: string): void {
  const root = () =>
    document.querySelector<HTMLElement>(
      `[data-card-layer] [data-stage-entry="shown"][data-stage-entry-id="${CSS.escape(entryId)}"]`,
    );
  let shown = shownEntry(useShellStore.getState())?.id === entryId;
  let forgotten = false;
  const ready = () => {
    const s = useShellStore.getState();
    const front = shownEntry(s)?.id === entryId;
    shown ||= front;
    forgotten ||= s.commandSearchOpen || (shown && !front);
    // Finish the wait without entering a card the captain moved on from.
    if (forgotten) return true;
    const entry = root();
    if (entry === null || !available(entry) || entry.style.opacity === "0") return false;
    // A card in a page of its own takes focus once that page's frame is there.
    const page = entry.querySelector("[data-panel-card-page]");
    return page === null || page.querySelector("iframe") !== null;
  };
  whenReady(
    ready,
    () => {
      const entry = root();
      if (!forgotten && entry && shownEntry(useShellStore.getState())?.id === entryId)
        enterCard(entry);
    },
    PANEL_CARD_DRAW_FRAMES,
  );
}

/**
 * Runs a window command if it may run now: the shell's here, the main
 * process's by asking it, a panel's through its panel. Returns whether it
 * ran. Command search closes itself before it runs what was chosen in it.
 */
export function runWindowCommand(id: WindowCommandId | PanelCommandId): boolean {
  if (windowCommandRefusal(id) !== null) return false;
  if (isPanelCommandId(id)) runPanelCommand(pluginHost, id, focusPanelCard);
  else if (isShellCommand(id)) SHELL_COMMANDS[id]();
  else void window.infinitary.keyboard.run(id).catch(() => {});
  return true;
}

/**
 * Runs each window command the main process names, for as long as the shell
 * lives. The window's keys are marked as reaching the shell (`markWindowKeys`)
 * after one round trip to the main process, which handles this page's
 * messages in order: by then it holds every panel's keys the page told it
 * before it drew.
 */
export function followShellCommands(): () => void {
  let following = true;
  const stop = window.infinitary.keyboard.onCommand(({ command }) => runWindowCommand(command));
  void window.infinitary.keyboard
    .keymap()
    .then(() => {
      if (following) markWindowKeys("commands");
    })
    .catch(() => {});
  return () => {
    following = false;
    stop();
    markWindowKeys(null);
  };
}
