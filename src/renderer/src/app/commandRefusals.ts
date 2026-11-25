import { cardTakesReplies, isPlayableBody } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
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
import {
  changesOff,
  changesOffWords,
  isView,
  updateThereWords,
  waitsForUpdate,
} from "../devices/viewWords";
import { mainMessageRefusal } from "./composer";
import {
  cardFindable,
  isHeldEntry,
  newCardIndex,
  type StackEntry,
  shownEntry,
  stackOf,
} from "./stack";
import { cardsPutAside } from "./stackActions";
import type { ShellState } from "./store";

/**
 * Why a window command cannot run now (docs/keyboard.md), in the words
 * command search shows beside it. Read against the window as it is when the
 * command arrives: a refused key does nothing, and a refused row runs
 * nothing.
 */

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
  | "unreadCardIds"
  | "heldBackCardIds"
  | "records"
  | "threads"
  | "releaseNotes"
  | "thisMac"
  | "devicesShown"
  | "secretsShown"
  | "pendingCardActions"
  | "lastTurn"
> &
  Partial<
    Pick<
      ShellState,
      "replyNotes" | "letThroughCardIds" | "letThroughFocus" | "goingAsideCardIds" | "cardAnswers"
    >
  >;

export type WindowFacts = {
  /** A modal dialog other than command search holds focus: the picture viewer, the custom API form. */
  dialogOpen: boolean;
  /** The open picture viewer offers Point at on its picture: the one command a viewer lets through. */
  viewerPointAt?: boolean;
  /** The picture viewer is open over a card, with its picture or recording to save. */
  viewerOpen?: boolean;
  /** The shown Browser tab offers Point at over its page. */
  browserPointAt?: boolean;
  browserControl?: boolean;
  /** The shown entry has a reply field: a card's, or the request docked beside a browser's page. */
  browserReply?: boolean;
  /** The shown browser's page takes the captain's keys. */
  browserPage?: boolean;
  /** Whether the shown browser view docks a card with Back to the card. */
  browserCard?: boolean;
  /** The find field is open on the shown card (docs/keyboard.md, "Finding in the shown card"). */
  cardFinding?: boolean;
  /** The shown card's thread shows its jump down: the captain reads above its foot. */
  threadJump?: boolean;
  /** The shown card draws its sound strip: the captain pressed one of its clips' Listen. */
  soundStrip?: boolean;
  /** The shown task record offers Move to a computer. */
  taskMove?: boolean;
  /** The shown record offers Close as done (INF-3169's plan, piece 3). */
  taskCloseDone?: boolean;
  /**
   * Edit tags can run: the shown record, card or task tab belongs to a task
   * whose project has tags or that carries tags.
   */
  taskEditTags?: boolean;
  answerDoneReady?: boolean;
  /** The shown decision offers a way to say no (INF-3108). */
  declineReady?: boolean;
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

function cardRefusal(s: RefusalState): string | null {
  if (s.view !== "home") return m.refuseSettingsIsOpen();
  return shownEntry(s) ? null : m.refuseNoCardIsShown();
}

/** Finding words: in a card, a past card or a task's record or Crewmate tab, never a task's browser. */
function findRefusal(s: RefusalState): string | null {
  const refused = cardRefusal(s);
  if (refused) return refused;
  const entry = shownEntry(s);
  if (entry?.browserTaskId) return m.refuseBrowserTabCannotBeFound();
  return entry && cardFindable(entry) ? null : m.refuseThisCardCannotBeFound();
}

/** The next or previous match: only while the find field is open. */
function findStepRefusal(s: RefusalState, facts: WindowFacts): string | null {
  return findRefusal(s) ?? (facts.cardFinding ? null : m.refuseNothingIsBeingFound());
}

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
  if (!wanted) return m.refuseThisCardHasNoTabs();
  const task = cardTaskOf(entry);
  if (!task) return m.refuseThisCardIsNotAboutATask();
  if (wanted === "crewmate" && !hasCrewmateTab(task)) return m.refuseThisCardHasNoSuchTab();
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
  if (!handle) return m.refuseThisCardHasNoTabs();
  if (tabTargetOf(command, handle) !== null) return null;
  const wanted = tabKindOf(command);
  if (!wanted) return m.refuseThereIsNoOtherTabToGo();
  return handle.tabs.some((tab) => tab.kind === wanted)
    ? m.refuseThatTabIsAlreadyShown()
    : m.refuseThisCardHasNoSuchTab();
}

/** A tab that is the other computer's alone. */
function refusedOnAView(tab: () => string): (s: RefusalState) => string | null {
  return (s) =>
    isView(s.thisMac) ? m.refuseTabIsOnComputer({ tab: tab(), computer: s.thisMac.name }) : null;
}

/** What a first mate on an older version cannot answer from here. */
function refusedUntilUpdate(s: RefusalState): string | null {
  return waitsForUpdate(s.thisMac) ? updateThereWords(s.thisMac) : null;
}

/** The pager's arrows: two entries or more to page between. */
function pageRefusal(s: RefusalState): string | null {
  const refused = cardRefusal(s);
  if (refused) return refused;
  // The arrows go round past either end (INF-4541): only a lone card stops them.
  return stackOf(s).length <= 1 ? m.refuseThisIsTheOnlyCard() : null;
}

/**
 * Moving between the shown card's questions (docs/keyboard.md, "Moving
 * between a card's questions"): a card whose body asks some, while no
 * recording keeps focus where its words will go. A playable preview's
 * settings are its own controls', and a card still being written has no reading yet.
 */
function questionRefusal(s: RefusalState): string | null {
  const refused = cardRefusal(s);
  if (refused) return refused;
  if (s.recording) return m.refuseARecordingIsRunning();
  const entry = shownEntry(s);
  const asked = entry && !isHeldEntry(entry) ? s.cardAnswers?.[entry.id]?.of : undefined;
  return asked && entry && !isHeldEntry(entry) && !isPlayableBody(entry.body)
    ? null
    : m.refuseThisCardAsksNoQuestions();
}

function choiceRefusal(s: RefusalState, index: number): string | null {
  if (s.view !== "home") return m.refuseSettingsIsOpen();
  if (s.recording) return m.refuseARecordingIsRunning();
  const entry = shownEntry(s);
  if (!entry) return m.refuseNoCardIsShown();
  // A live note's one button counts as its only choice (INF-2794).
  const choices = entry.actions.length || ("noteDone" in entry && entry.noteDone ? 1 : 0);
  if (isHeldEntry(entry) || choices === 0) return m.refuseThisCardHasNoButtons();
  if (index >= choices) return m.refuseThisCardHasNoSuchChoice();
  if (s.pendingCardActions[entry.id]) return m.refuseThisCardIsWorking();
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
  "focus.card-reply": (s, facts) => {
    if (s.recording) return m.refuseARecordingIsRunning();
    const entry = shownEntry(s);
    if (!entry) return m.refuseNoCardIsShown();
    // A browser view's docked request takes a reply beside the page.
    if (entry.browserTaskId !== undefined && facts.browserReply) return null;
    return isHeldEntry(entry) || !cardTakesReplies(entry) ? m.refuseThisCardTakesNoReply() : null;
  },
  // The shown entry's body: a card's, a task's record or a past card.
  "focus.card-body": (s) => {
    if (s.recording) return m.refuseARecordingIsRunning();
    return shownEntry(s) ? null : m.refuseNoCardIsShown();
  },
  // Only a live card has buttons, and none while it is still being written.
  "focus.card-actions": (s, facts) => {
    if (s.recording) return m.refuseARecordingIsRunning();
    if (facts.answerDoneReady) return null;
    const entry = shownEntry(s);
    if (!entry) return m.refuseNoCardIsShown();
    if (isHeldEntry(entry) || entry.actions.length === 0) return m.refuseThisCardHasNoButtons();
    return null;
  },
  // The shown card's choices: the default, then right to left. A press is the button's click.
  ...choiceRefusals(),
  // Moving between the window's parts changes nothing but focus; a
  // recording keeps it where its words will go.
  "regions.next": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "regions.previous": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "regions.left": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "regions.down": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "regions.up": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "regions.right": (s) => (s.recording ? m.refuseARecordingIsRunning() : null),
  "computers.previous": (s, facts) =>
    s.view !== "home"
      ? m.refuseSettingsIsOpen()
      : shownEntry(s)
        ? m.refuseACardCoversTheComputers()
        : !facts.computers || facts.computers.page === 0
          ? m.refuseTheseAreTheFirstComputers()
          : null,
  "computers.next": (s, facts) =>
    s.view !== "home"
      ? m.refuseSettingsIsOpen()
      : shownEntry(s)
        ? m.refuseACardCoversTheComputers()
        : !facts.computers || facts.computers.page + 1 >= facts.computers.pages
          ? m.refuseTheseAreTheLastComputers()
          : null,
  "project-focus.open": (s, facts) =>
    s.view !== "home"
      ? m.refuseSettingsIsOpen()
      : !facts.projectFocus?.shown
        ? m.refuseThereIsOnlyOneProject()
        : null,
  "project-focus.clear": (_s, facts) =>
    facts.projectFocus?.focus ? null : m.refuseEveryProjectIsShown(),
  "cards.previous": pageRefusal,
  "cards.next": pageRefusal,
  "cards.next-new": (s) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    const shown = stackOf(s);
    const index = Math.min(Math.max(0, s.cardIndex), shown.length - 1);
    return newCardIndex(shown, index, s.unreadCardIds) < 0 ? m.refuseNoOtherCardIsNew() : null;
  },
  "cards.minimize": cardRefusal,
  // Every entry aside, or on an empty stage every card put aside back
  // (INF-4002); each is a change on the first mate's computer.
  "cards.minimize-all": (s) => {
    if (s.view !== "home") return m.refuseSettingsIsOpen();
    if (changesOff(s.thisMac) && isView(s.thisMac)) return changesOffWords(s.thisMac);
    return shownEntry(s) || cardsPutAside(s).length > 0 ? null : m.refuseNoCardIsShownOrPutAside();
  },
  "cards.done": (s, facts) =>
    cardRefusal(s) ?? (facts.answerDoneReady ? null : m.refuseThisCardHasNoDoneOrGot()),
  "cards.decline": (s, facts) =>
    cardRefusal(s) ?? (facts.declineReady ? null : m.refuseThisCardHasNoWayToSay()),
  "cards.maximize": cardRefusal,
  "cards.find": findRefusal,
  "cards.find-next": (s, facts) => findStepRefusal(s, facts),
  "cards.find-previous": (s, facts) => findStepRefusal(s, facts),
  // A thread exists once its first message is sent; a recording keeps focus
  // where its words will go.
  "cards.next-revision": (s) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    if (s.recording) return m.refuseARecordingIsRunning();
    const entry = shownEntry(s);
    return entry &&
      !isHeldEntry(entry) &&
      s.threads[entry.id]?.some(
        (message) => message.revision?.released && message.revision.targets.length,
      )
      ? null
      : m.refuseThisCardHasNoChangeLinks();
  },
  "cards.next-question": questionRefusal,
  "cards.previous-question": questionRefusal,
  "cards.unanswered-question": questionRefusal,
  "cards.show-info": (s) => tabRefusal(s, "cards.show-info"),
  "cards.show-cards": (s) => tabRefusal(s, "cards.show-cards"),
  "cards.show-activity": (s) => tabRefusal(s, "cards.show-activity"),
  "cards.show-crewmate": (s) => tabRefusal(s, "cards.show-crewmate"),
  // Taking or returning control is a change on the first mate's computer:
  // off for the same reason as every other button there.
  "browser.control": (s, facts) =>
    !facts.browserControl
      ? m.refuseShowABrowserWithControlAvailableFirst()
      : changesOff(s.thisMac) && isView(s.thisMac)
        ? changesOffWords(s.thisMac)
        : null,
  "browser.page": (s, facts) =>
    s.recording
      ? m.refuseARecordingIsRunning()
      : facts.browserPage
        ? null
        : m.refuseShowABrowserPageYouControlFirst(),
  "browser.card": (s, facts) =>
    s.recording
      ? m.refuseARecordingIsRunning()
      : facts.browserCard
        ? null
        : m.refuseShowACardBesideABrowserPageFirst(),
  "task.move-computer": (_s, facts) =>
    facts.taskMove ? null : m.refuseShowAStartedTaskThatCanMove(),
  "task.close-done": (_s, facts) =>
    facts.taskCloseDone ? null : m.refuseShowAStartedTasksRecordFirst(),
  "task.edit-tags": (_s, facts) =>
    facts.taskEditTags ? null : m.refuseShowATaggableTasksRecordFirst(),
  "cards.show-browser": (s) => tabRefusal(s, "cards.show-browser"),
  "cards.next-tab": (s) => tabRefusal(s, "cards.next-tab"),
  "cards.previous-tab": (s) => tabRefusal(s, "cards.previous-tab"),
  "cards.point-at": (s, facts) => {
    if (facts.viewerPointAt) return null;
    const refused = cardRefusal(s);
    if (refused) return refused;
    const entry = shownEntry(s);
    // A Browser tab points at its page, which it must be showing.
    if (entry?.browserTaskId !== undefined)
      return facts.browserPointAt ? null : m.refuseNoPageToPointAt();
    return !entry || isHeldEntry(entry) || !cardTakesReplies(entry)
      ? m.refuseThisCardTakesNoReply()
      : null;
  },
  "viewer.save-picture": (_s, facts) => (facts.viewerOpen ? null : m.refuseNoPictureIsOpen()),
  "cards.thread": (s, facts) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    if (s.recording) return m.refuseARecordingIsRunning();
    const entry = shownEntry(s);
    // A browser view's docked request opens beside its page or folds under it.
    if (entry?.browserTaskId !== undefined && facts.browserReply) return null;
    if (!entry || isHeldEntry(entry) || !cardTakesReplies(entry))
      return m.refuseThisCardTakesNoReply();
    return (s.threads[entry.id]?.length ?? 0) + (s.replyNotes?.[entry.id]?.length ?? 0) > 0
      ? null
      : m.refuseThisCardHasNoThreadYet();
  },
  "cards.thread-new": (s, facts) => {
    const refused = cardRefusal(s);
    if (refused) return refused;
    return facts.threadJump ? null : m.refuseNoCardThreadIsReadAboveIts();
  },
  "cards.sound": (s, facts) =>
    cardRefusal(s) ?? (facts.soundStrip ? null : m.refuseThisCardIsPlayingNoSound()),
  "settings.open": (s) => (s.view === "settings" ? m.refuseSettingsIsAlreadyOpen() : null),
  // From anywhere, Settings included: it goes to the Keyboard tab.
  "settings.keyboard": () => null,
  // On a Mac that controls another, its own arrangement (docs/view.md).
  "settings.panels": () => null,
  // From anywhere, Settings included: it goes home to the note.
  "updates.show": (_s, facts) => (facts.updateAvailable ? null : m.refuseNoUpdateIsAvailable()),
  // Only while an update saves work: once the copy is replaced, it cannot wait.
  "updates.later": (_s, facts) =>
    facts.savingForUpdate ? null : m.refuseNoUpdateIsSavingWorkNow(),
  // From anywhere, Settings included: it goes to General and checks there.
  "updates.check": (_s, facts) =>
    facts.checksUpdates ? null : m.refuseInfinitaryCouldNotConfirmHowThisCopy(),
  // From anywhere, Settings included: only where the first mate's computer answers its update from here.
  "updates.home": (s) =>
    isView(s.thisMac) && s.thisMac.homeUpdates ? null : m.refuseNoUpdateIsAvailable(),
  "whats-new.show": (s) =>
    s.releaseNotes && s.releaseNotes.notes.length > 0 ? null : m.refuseNoReleaseNotesYet(),
  // Only while the main message box takes words.
  "feedback.start": mainMessageRefusal,
  // From anywhere, Settings included: it goes home to the conversation,
  // which says so while it holds nothing yet.
  "firstmate.reply": () => null,
  "settings.runbooks": () => null,
  "runbooks.open-folder": (s) =>
    isView(s.thisMac) ? m.refuseRunbooksFolderOn({ computer: s.thisMac.name }) : null,
  // Usage is the record of the Mac Firstmate lives on (docs/usage.md).
  "settings.usage": () => null,
  // Automation is the home's, like Usage, and a view shows it (docs/automation.md).
  "settings.automation": () => null,
  // Integrations sign in as the person on the home, like Projects.
  "settings.integrations": () => null,
  // Secrets stay the home's own (docs/secrets.md), and a build without
  // protected storage has no Secrets at all.
  "settings.secrets": (s) =>
    refusedOnAView(m.refuseSecretsTab)(s) ??
    (s.secretsShown ? null : m.refuseSecretsIsNotInThisBuild()),
  // Only where Secrets is, and only while the message box takes words.
  "secrets.move": (s) =>
    refusedOnAView(m.refuseSecretsTab)(s) ??
    (s.secretsShown ? null : m.refuseSecretsIsNotInThisBuild()) ??
    mainMessageRefusal(s),
  "automation.pause-all": () => null,
  // This window's own music, wherever the first mate lives.
  "ambient.toggle": () => null,
  "ambient.style": () => null,
  "usage.unit": refusedUntilUpdate,
  // The allowance is read where the first mate lives, from any Mac.
  "allowance.recheck": refusedUntilUpdate,
  // The first mate's devices, from its window or a view of it (docs/devices.md).
  "devices.try-again": (s) => (s.devicesShown ? null : m.refuseDevicesOn({ home: HOME.the })),
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
  if (s.pickingDictationKey) return m.refuseSettingsIsWaitingForADictationKey();
  if (s.recordingKeys) return m.refuseSettingsIsRecordingAKey();
  if (id !== "commands.search" && s.commandSearchOpen) return m.refuseCommandSearchIsOpen();
  // The picture viewer is a dialog that takes two window commands on its picture: Point at and Save.
  const viewerOwn =
    (id === "cards.point-at" && facts.viewerPointAt === true) ||
    (id === "viewer.save-picture" && facts.viewerOpen === true);
  if (!s.commandSearchOpen && facts.dialogOpen && !viewerOwn)
    return m.refuseCloseTheOpenDialogFirst();
  if (isPanelCommandId(id)) return facts.panelCommand?.(id, s.recording) ?? null;
  return REFUSALS[id](s, facts);
}
