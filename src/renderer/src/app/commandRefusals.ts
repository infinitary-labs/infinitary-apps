import { cardTakesReplies } from "@shared/cards";
import {
  type CARD_CHOICE_COMMANDS,
  isPanelCommandId,
  isShellCommand,
  type PanelCommandId,
  type ShellCommandId,
  type WindowCommandId,
} from "@shared/keyboard";
import { HOME } from "../../../shared/deviceNames";
import { cardTaskOf } from "../cards/cardTask";
import {
  hasCrewmateTab,
  shownTaskTabs,
  type TabCommand,
  tabKindOf,
  tabShownOf,
  tabTargetOf,
  tabTaskOf,
} from "../cards/taskTabs";
import { changesOff, changesOffWords, controlsAll, isView } from "../devices/viewWords";
import { mainMessageRefusal } from "./composer";
import { isHeldEntry, type StackEntry, shownEntry, stackOf } from "./stack";
import type { ShellState } from "./store";

/**
 * Why a window command cannot run now (docs/keyboard.md), in the words
 * command search shows beside it. Read against the window as it is when the
 * command arrives: a refused key does nothing, and a refused row runs
 * nothing.
 */

/** What a refusal reads from the shell's store. */
export type RefusalState = Pick<
  ShellState,
  | "view"
  | "recording"
  | "pickingDictationKey"
  | "recordingKeys"
  | "firstRun"
  | "firstRunSettled"
  | "commandSearchOpen"
  | "cards"
  | "cardIndex"
  | "heldBackCardIds"
  | "records"
  | "threads"
  | "releaseNotes"
  | "thisMac"
  | "devicesShown"
  | "pendingCardActions"
  | "lastTurn"
>;

/** What a refusal reads beyond the store: the window's own facts. */
export type WindowFacts = {
  /** A modal dialog other than command search holds focus: the picture viewer, the custom API form. */
  dialogOpen: boolean;
  browserControl?: boolean;
  /** The shown card's thread shows its jump down: the captain reads above its foot. */
  threadJump?: boolean;
  /** The shown task record offers Move to a computer. */
  taskMove?: boolean;
  /** The shown record offers Close as done (INF-3169's plan, piece 3). */
  taskCloseDone?: boolean;
  answerDoneReady?: boolean;
  computers?: { page: number; pages: number };
  /** The top bar's project pill: whether it shows, and the focus that holds (docs/project-focus.md). */
  projectFocus?: { shown: boolean; focus: string | null };
  updateAvailable?: boolean;
  /** Check for updates is on the Version row (UpdateCheck.tsx). */
  checksUpdates?: boolean;
  /** An update is saving the crew's work, so Update later can let it go. */
  savingForUpdate?: boolean;
  /**
   * Why a panel's command cannot run now beyond what holds every key
   * (docs/keyboard.md, "A panel's commands"), from its panel as it stands.
   */
  panelCommand?: (id: PanelCommandId, recording: boolean) => string | null;
};

const NO_CARD = "No card is shown";
const IN_SETTINGS = "Settings is open";
const RECORDING = "A recording is running";

function cardRefusal(s: RefusalState): string | null {
  if (s.view !== "home") return IN_SETTINGS;
  return shownEntry(s) ? null : NO_CARD;
}

const NOT_ABOUT_A_TASK = "This card is not about a task";

/**
 * Show Info, Show Cards, Show Activity, Show Crewmate or Show Browser on a
 * card about a task opens that task's tab in front of the card (INF-358):
 * Info, Cards and Activity always - a card about the task is one of its
 * cards, and showing it was a line of its Activity - Crewmate once a
 * crewmate has run the task, and Browser the task's browser view, which
 * itself says when the task has no browser (the board row the card's task
 * is read from carries no browser fact). Empty when the command may run;
 * the reason when not.
 */
function cardTabRefusal(entry: StackEntry, command: TabCommand): string {
  const wanted = tabKindOf(command);
  if (!wanted) return "This card has no tabs";
  const task = cardTaskOf(entry);
  if (!task) return NOT_ABOUT_A_TASK;
  if (wanted === "crewmate" && !hasCrewmateTab(task)) return "This card has no such tab";
  return "";
}

/** A tab command: the shown card is a task's with tabs, and the tab is somewhere to go. */
function tabRefusal(s: RefusalState, command: TabCommand): string | null {
  const refused = cardRefusal(s);
  if (refused) return refused;
  const entry = shownEntry(s);
  if (entry && !isHeldEntry(entry)) return cardTabRefusal(entry, command) || null;
  const taskId = entry && tabTaskOf(entry);
  const kind = entry && tabShownOf(entry);
  const handle = taskId && kind ? shownTaskTabs(taskId, kind) : undefined;
  if (!handle) return "This card has no tabs";
  if (tabTargetOf(command, handle) !== null) return null;
  const wanted = tabKindOf(command);
  if (!wanted) return "There is no other tab to go to";
  return handle.tabs.some((tab) => tab.kind === wanted)
    ? "That tab is already shown"
    : "This card has no such tab";
}

/** A Mac that controls another has no Usage tab: the usage is the other Mac's. */
function usageRefusal(s: RefusalState): string | null {
  return usageRefusalFor("Usage")(s);
}

/**
 * A tab that is the other Mac's; of a first mate started by a command, whose
 * computer has no window, `ofACommand` tabs open here instead (docs/run.md).
 */
function usageRefusalFor(tab: string, ofACommand = true): (s: RefusalState) => string | null {
  return (s) =>
    isView(s.thisMac) && !(ofACommand && controlsAll(s.thisMac))
      ? `${tab} is on ${s.thisMac.name}`
      : null;
}

/** The pager's way: where the shown entry stands in the stack. */
function pageRefusal(s: RefusalState, dir: 1 | -1): string | null {
  const refused = cardRefusal(s);
  if (refused) return refused;
  const count = stackOf(s).length;
  const index = Math.min(Math.max(0, s.cardIndex), count - 1);
  if (dir === -1 && index <= 0) return "This is the first card";
  if (dir === 1 && index >= count - 1) return "This is the last card";
  return null;
}

/** Why a shown-card choice key cannot press its button now. */
function choiceRefusal(s: RefusalState, index: number): string | null {
  if (s.view !== "home") return IN_SETTINGS;
  if (s.recording) return RECORDING;
  const entry = shownEntry(s);
  if (!entry) return NO_CARD;
  // A live note's one button counts as its only choice (INF-2794).
  const choices = entry.actions.length || ("noteDone" in entry && entry.noteDone ? 1 : 0);
  if (isHeldEntry(entry) || choices === 0) return "This card has no buttons";
  if (index >= choices) return "This card has no such choice";
  if (s.pendingCardActions[entry.id]) return "This card is working";
  if (changesOff(s.thisMac) && isView(s.thisMac)) return changesOffWords(s.thisMac);
  return null;
}

function choiceRefusals(): {
  [Id in (typeof CARD_CHOICE_COMMANDS)[number]]: (
    s: RefusalState,
    facts: WindowFacts,
  ) => string | null;
} {
  return {
    "cards.choice-1": (s) => choiceRefusal(s, 0),
    "cards.choice-2": (s) => choiceRefusal(s, 1),
    "cards.choice-3": (s) => choiceRefusal(s, 2),
    "cards.choice-4": (s) => choiceRefusal(s, 3),
  };
}

const REFUSALS: Readonly<
  Record<ShellCommandId, (s: RefusalState, facts: WindowFacts) => string | null>
> = {
  // Its own key closes it again, so only what holds every key refuses it.
  "commands.search": () => null,
  "focus.main-message": mainMessageRefusal,
  "focus.card-reply": (s) => {
    if (s.recording) return RECORDING;
    const entry = shownEntry(s);
    if (!entry) return NO_CARD;
    return isHeldEntry(entry) || !cardTakesReplies(entry) ? "This card takes no reply" : null;
  },
  // The shown entry's body: a card's, a task's record or a past card.
  "focus.card-body": (s) => {
    if (s.recording) return RECORDING;
    return shownEntry(s) ? null : NO_CARD;
  },
  // Only a live card has buttons, and none while it is still being written.
  "focus.card-actions": (s, facts) => {
    if (s.recording) return RECORDING;
    if (facts.answerDoneReady) return null;
    const entry = shownEntry(s);
    if (!entry) return NO_CARD;
    if (isHeldEntry(entry) || entry.actions.length === 0) return "This card has no buttons";
    return null;
  },
  // The shown card's choices: the default, then right to left. A press is the button's click.
  ...choiceRefusals(),
  // Moving between the window's parts changes nothing but focus; a
  // recording keeps it where its words will go.
  "regions.next": (s) => (s.recording ? RECORDING : null),
  "regions.previous": (s) => (s.recording ? RECORDING : null),
  "computers.previous": (s, facts) =>
    s.view !== "home"
      ? IN_SETTINGS
      : shownEntry(s)
        ? "A card covers the computers"
        : !facts.computers || facts.computers.page === 0
          ? "These are the first computers"
          : null,
  "computers.next": (s, facts) =>
    s.view !== "home"
      ? IN_SETTINGS
      : shownEntry(s)
        ? "A card covers the computers"
        : !facts.computers || facts.computers.page + 1 >= facts.computers.pages
          ? "These are the last computers"
          : null,
  "project-focus.open": (s, facts) =>
    s.view !== "home"
      ? IN_SETTINGS
      : !facts.projectFocus?.shown
        ? "There is only one project"
        : null,
  "project-focus.clear": (_s, facts) =>
    facts.projectFocus?.focus ? null : "Every project is shown",
  "cards.previous": (s) => pageRefusal(s, -1),
  "cards.next": (s) => pageRefusal(s, 1),
  "cards.minimize": cardRefusal,
  "cards.done": (s, facts) =>
    cardRefusal(s) ?? (facts.answerDoneReady ? null : "This card has no Done or Got it"),
  "cards.maximize": cardRefusal,
  // A thread exists once its first message is sent; a recording keeps focus
  // where its words will go.
  "cards.next-revision": (s) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    if (s.recording) return RECORDING;
    const entry = shownEntry(s);
    return entry &&
      !isHeldEntry(entry) &&
      s.threads[entry.id]?.some((m) => m.revision?.released && m.revision.targets.length)
      ? null
      : "This card has no change links";
  },
  "cards.show-info": (s) => tabRefusal(s, "cards.show-info"),
  "cards.show-cards": (s) => tabRefusal(s, "cards.show-cards"),
  "cards.show-activity": (s) => tabRefusal(s, "cards.show-activity"),
  "cards.show-crewmate": (s) => tabRefusal(s, "cards.show-crewmate"),
  "browser.control": (_s, facts) =>
    facts.browserControl ? null : "Show a browser with control available first",
  "task.move-computer": (_s, facts) =>
    facts.taskMove ? null : "Show a started task that can move to another computer first",
  "task.close-done": (_s, facts) =>
    facts.taskCloseDone ? null : "Show a started task's record first",
  "cards.show-browser": (s) => tabRefusal(s, "cards.show-browser"),
  "cards.next-tab": (s) => tabRefusal(s, "cards.next-tab"),
  "cards.previous-tab": (s) => tabRefusal(s, "cards.previous-tab"),
  "cards.thread": (s) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    if (s.recording) return RECORDING;
    const entry = shownEntry(s);
    if (!entry || isHeldEntry(entry) || !cardTakesReplies(entry)) return "This card takes no reply";
    return (s.threads[entry.id]?.length ?? 0) > 0 ? null : "This card has no thread yet";
  },
  "cards.thread-new": (s, facts) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    return facts.threadJump ? null : "No card thread is read above its latest message";
  },
  "settings.open": (s) => (s.view === "settings" ? "Settings is already open" : null),
  // From anywhere, Settings included: it goes to the Keyboard tab.
  "settings.keyboard": () => null,
  // The arrangement is saved where the first mate lives (docs/view.md).
  "settings.panels": usageRefusalFor("Panels"),
  // From anywhere, Settings included: it goes home to the note.
  "updates.show": (_s, facts) => (facts.updateAvailable ? null : "No update is available"),
  // Only while an update saves work: once the copy is replaced, it cannot wait.
  "updates.later": (_s, facts) => (facts.savingForUpdate ? null : "No update is saving work now"),
  // From anywhere, Settings included: it goes to General and checks there.
  "updates.check": (_s, facts) =>
    facts.checksUpdates ? null : "Infinitary could not confirm how this copy was installed",
  "whats-new.show": (s) =>
    s.releaseNotes && s.releaseNotes.notes.length > 0 ? null : "No release notes yet",
  // From anywhere, Settings included: it goes home to the note.
  "firstmate.reply": (s) => (s.lastTurn?.reply ? null : "Your first mate has not replied yet"),
  "settings.runbooks": usageRefusalFor("Runbooks"),
  "runbooks.open-folder": (s) =>
    isView(s.thisMac) ? `Your runbooks folder is on ${s.thisMac.name}` : null,
  // Usage is the record of the Mac Firstmate lives on (docs/usage.md).
  "settings.usage": usageRefusal,
  // Automation is the home's own, like Usage: the schedules run on that Mac.
  "settings.automation": usageRefusalFor("Automation", false),
  // Integrations sign in as the person on the home, like Projects.
  "settings.integrations": usageRefusalFor("Integrations"),
  "automation.pause-all": usageRefusalFor("Automation", false),
  "usage.unit": usageRefusal,
  // The allowance is read where the first mate lives, from any Mac.
  "allowance.recheck": () => null,
  // Devices is the home's own: a Mac that controls another has none (docs/devices.md).
  "devices.try-again": (s) => (s.devicesShown ? null : `Devices is on ${HOME.the}`),
};

/**
 * Why a window command cannot run now, or null. What holds every key comes
 * first: the dictation key's pick, a key Keyboard settings records, command
 * search itself, another dialog.
 * The main process's own commands (the size keys) always run.
 */
export function commandRefusal(
  id: WindowCommandId | PanelCommandId,
  s: RefusalState,
  facts: WindowFacts,
): string | null {
  if (!isPanelCommandId(id) && !isShellCommand(id)) return null;
  if (s.pickingDictationKey) return "Settings is waiting for a dictation key";
  if (s.recordingKeys) return "Settings is recording a key";
  if (id !== "commands.search" && s.commandSearchOpen) return "Command search is open";
  if (!s.commandSearchOpen && facts.dialogOpen) return "Close the open dialog first";
  if (isPanelCommandId(id)) return facts.panelCommand?.(id, s.recording) ?? null;
  return REFUSALS[id](s, facts);
}
