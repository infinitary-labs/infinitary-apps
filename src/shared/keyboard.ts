import * as m from "./i18n/messages.generated.ts";
import type { KeySystem } from "./platform";
/**
 * The app's keyboard commands (docs/keyboard.md). One catalog names every
 * command a key can run - its stable id, its words, its default keys, where
 * it works, whether a held key repeats it and what it may change - and one
 * resolver turns a pressed key into the command it runs where it was
 * pressed. Pure, so the main process, the renderer and the tests read one
 * table. A command's handler stays with the code that owns what it changes.
 */

/** A pressed key, as a DOM keydown and Electron's `before-input-event` both report it. */
export type KeyPress = {
  /** What the layout types, or the key's name (`KeyboardEvent.key`). */
  key: string;
  /** The physical key (`KeyboardEvent.code`). */
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The key belongs to an input method's composition, which keeps every key it uses. */
  composing: boolean;
  /** The platform repeats a held key. */
  repeat: boolean;
};

/**
 * A key and the modifiers held with it. `key` is a lowercase Latin letter,
 * a character the layout types (`+`, `0`), or a key's name (`ArrowUp`).
 * Shift counts for a letter and a named key. For a typed character Shift is
 * part of the character already, so `+` is one chord whether or not the
 * layout needs Shift to type it - unless the chord holds Shift itself:
 * while ⌘ is down a Mac reports the key's own character with Shift held
 * (⇧⌘] is `]` with Shift), so `]` with Shift is that chord and `]` alone
 * is not.
 */
export type KeyChord = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

/**
 * What a command answers to: one chord, or two pressed one after the other
 * (`second`), a two-key shortcut whose first chord holds ⌘ or ⌃, or is a
 * plain key that works only when not typing. Only a window command takes
 * two keys (docs/keyboard.md, "Two-key shortcuts").
 */
export type KeyBinding = KeyChord & {
  second?: KeyChord;
  /** Omitted keeps the existing anywhere path; offered only by a non-typing document otherwise. */
  when?: "not-typing";
};

/** Whether the installed map needs the document's not-typing path. */
export function hasNotTypingKeys(bindings: Bindings): boolean {
  return Object.values(bindings).some((keys) => keys?.some((key) => key.when === "not-typing"));
}

/** The binding's place is independent of the command's scope. */
export function bindingIsActive(binding: KeyBinding, context: KeyContext): boolean {
  return binding.when !== "not-typing" || context.notTyping === true;
}

/**
 * Where a command works:
 * - `window`: anywhere in the focused Firstmate window, card and panel
 *   frames included; the main process hears the key before the page does.
 * - `message-field`: in a message field, the main message or a card's reply.
 * - `main-message`: in the main message field only.
 */
export type CommandScope = "window" | "message-field" | "main-message";

/**
 * Who runs a window command once the main process has heard its key: the
 * main process itself, or the shell page, which it tells only the command.
 */
export type WindowCommandRunner = "main" | "shell";

/**
 * What running a command may change: how the window looks, the focused
 * field's words, where focus is and what the window shows (nothing saved),
 * or a card it closes for good.
 */
export type CommandRisk = "view" | "edit" | "navigate" | "close";

/** A Settings section a build may not offer, and whether this one does; one unread is not offered. */
export type CommandSection = "devices" | "secrets";
export type CommandSections = Partial<Record<CommandSection, boolean>>;

export type KeyboardCommand = {
  /** What the command does, in the words a person reads in a list of commands. */
  label: string;
  /** A held key runs it again; otherwise only the first press does. */
  repeat: boolean;
  risk: CommandRisk;
  /**
   * Its keys before anyone changes them, as a Mac writes them (`catalogKeys`
   * gives another system's); the first is the one a menu and a hint show. A
   * window command may have none and is then chosen by name in command
   * search.
   */
  keys: readonly KeyBinding[];
  /**
   * Other words command search finds it by, beyond its label's own: the
   * words a person might type for it that the label does not hold.
   */
  searchWords?: readonly string[];
  /**
   * The Settings section it acts in, which this build may not offer, such
   * as Devices behind the multi-machine gate (docs/devices.md) or Secrets in
   * a build without protected storage (docs/secrets.md): command search and
   * Keyboard settings list it only where that section shows, and it is
   * refused anywhere else.
   */
  section?: CommandSection;
} & (
  | { scope: "window"; runs: WindowCommandRunner }
  | { scope: "message-field" | "main-message"; runs?: never }
);

/**
 * A command's other search words, from its catalog message: one string of
 * words separated by commas, so a translation keeps them as one message.
 */
function searchWords(words: string): readonly string[] {
  return words
    .split(/[,、，]/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Every command a key runs. An id is stable: it is how a changed key is
 * remembered, so it is never renamed or reused. Enter, Tab, the Mac's own
 * editing keys and the dictation key are not commands here; they keep their
 * own owners (docs/keyboard.md).
 */
export const KEYBOARD_COMMANDS = {
  // The window's own commands, in the order command search lists them.
  "commands.search": {
    get label() {
      return m.commandCommandsSearch();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "k", meta: true }],
  },
  // The way back from wherever focus is, a card's or a panel's frame included.
  "focus.main-message": {
    get label() {
      return m.commandFocusMainMessage();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "l", meta: true }],
  },
  // The card's one field (INF-924): a reply, or words for a choice.
  "focus.card-reply": {
    get label() {
      return m.commandFocusCardReply();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "l", meta: true, shift: true }],
    get searchWords() {
      return searchWords(m.commandFocusCardReplyWords());
    },
  },
  // The shown card's own places (docs/keyboard.md, "Cards and frames"):
  // its body to read and answer, and its buttons. No key of their own yet:
  // chosen by name, and a person may give them one.
  "focus.card-body": {
    get label() {
      return m.commandFocusCardBody();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
  },
  // Focus only: a button is pressed by its own key, through the click's checks.
  "focus.card-actions": {
    get label() {
      return m.commandFocusCardActions();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
  },
  // The shown card's footer choices (docs/keyboard.md): ⌘1 the default,
  // so the recommended step is always the same key, then the rest from the
  // right edge leftward. A digit with ⌘ never types, so a reply and a card
  // body keep their characters. The button's own click still decides: an
  // unanswered question is not sent, and a pending or disabled button does
  // not run.
  "cards.choice-1": {
    get label() {
      return m.commandCardsChoice1();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [{ key: "1", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsChoice1Words());
    },
  },
  "cards.choice-2": {
    get label() {
      return m.commandCardsChoice2();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [{ key: "2", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsChoice2Words());
    },
  },
  "cards.choice-3": {
    get label() {
      return m.commandCardsChoice3();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [{ key: "3", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsChoice3Words());
    },
  },
  "cards.choice-4": {
    get label() {
      return m.commandCardsChoice4();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [{ key: "4", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsChoice4Words());
    },
  },
  // The window's parts in turn (docs/keyboard.md, "Parts of the window"):
  // F6 as other desktop apps move between their panes. A function key needs
  // no modifier; on a Mac it may need Fn, so it can be changed like any key.
  "regions.next": {
    get label() {
      return m.commandRegionsNext();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "F6" }],
  },
  "regions.previous": {
    get label() {
      return m.commandRegionsPrevious();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "F6", shift: true }],
  },
  // The part of the window in a direction from the one focus is in
  // (docs/keyboard.md, "Parts of the window"), read from where each part is
  // drawn now. No key of their own: chosen by name, or given one.
  "regions.left": {
    get label() {
      return m.commandRegionsLeft();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandRegionsLeftWords());
    },
  },
  "regions.down": {
    get label() {
      return m.commandRegionsDown();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandRegionsDownWords());
    },
  },
  "regions.up": {
    get label() {
      return m.commandRegionsUp();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandRegionsUpWords());
    },
  },
  "regions.right": {
    get label() {
      return m.commandRegionsRight();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandRegionsRightWords());
    },
  },
  // A key of a person's own for the arrows, Home, End, the page keys and
  // Escape (docs/keyboard.md, "Moving by a key of your own"): each presses
  // its key where focus is, so it does what that key does there. The main
  // process runs them, because only it can press a real key in the window's
  // page. No key of their own: given one, or chosen by name.
  "move.left": {
    get label() {
      return m.commandMoveLeft();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveLeftWords());
    },
  },
  "move.down": {
    get label() {
      return m.commandMoveDown();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveDownWords());
    },
  },
  "move.up": {
    get label() {
      return m.commandMoveUp();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveUpWords());
    },
  },
  "move.right": {
    get label() {
      return m.commandMoveRight();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveRightWords());
    },
  },
  "move.first": {
    get label() {
      return m.commandMoveFirst();
    },
    scope: "window",
    runs: "main",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveFirstWords());
    },
  },
  "move.last": {
    get label() {
      return m.commandMoveLast();
    },
    scope: "window",
    runs: "main",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMoveLastWords());
    },
  },
  "move.page-up": {
    get label() {
      return m.commandMovePageUp();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMovePageUpWords());
    },
  },
  "move.page-down": {
    get label() {
      return m.commandMovePageDown();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandMovePageDownWords());
    },
  },
  cancel: {
    get label() {
      return m.commandCancel();
    },
    scope: "window",
    runs: "main",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCancelWords());
    },
  },
  "computers.previous": {
    get label() {
      return m.commandComputersPrevious();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
  },
  "computers.next": {
    get label() {
      return m.commandComputersNext();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
  },
  // The top bar's project pill (docs/project-focus.md): its row opens with
  // focus on the pills, and focus leaves by name.
  "project-focus.open": {
    get label() {
      return m.commandProjectFocusOpen();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [{ key: "p", meta: true, shift: true }],
    get searchWords() {
      return searchWords(m.commandProjectFocusOpenWords());
    },
  },
  "project-focus.clear": {
    get label() {
      return m.commandProjectFocusClear();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandProjectFocusClearWords());
    },
  },
  // ⇧⌘[ as a Mac reports it while ⌘ is down (`[` with Shift), and as the
  // shifted character other input reports (`{` with Shift).
  "cards.previous": {
    get label() {
      return m.commandCardsPrevious();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [
      { key: "[", meta: true, shift: true },
      { key: "{", meta: true, shift: true },
    ],
  },
  "cards.next": {
    get label() {
      return m.commandCardsNext();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [
      { key: "]", meta: true, shift: true },
      { key: "}", meta: true, shift: true },
    ],
  },
  "cards.minimize": {
    get label() {
      return m.commandCardsMinimize();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [{ key: "m", meta: true, shift: true }],
  },
  // INF-4002: every entry on the stage gets what its own minus does, in one
  // move; on an empty stage the same key brings back every card put aside.
  // ⌥ means every, as ⌥⌘M minimizes every window of a Mac app.
  "cards.minimize-all": {
    get label() {
      return m.commandCardsMinimizeAll();
    },
    get searchWords() {
      return searchWords(m.commandCardsMinimizeAllWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [{ key: "m", meta: true, alt: true, shift: true }],
  },
  "cards.done": {
    get label() {
      return m.commandCardsDone();
    },
    get searchWords() {
      return searchWords(m.commandCardsDoneWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [],
  },
  // INF-3108: the shown decision's way to say no, the app's Decline or the
  // author's own, chosen by name; ⌘1-⌘4 also reach it by its place.
  "cards.decline": {
    get label() {
      return m.commandCardsDecline();
    },
    get searchWords() {
      return searchWords(m.commandCardsDeclineWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "close",
    keys: [],
  },
  "cards.maximize": {
    get label() {
      return m.commandCardsMaximize();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsMaximizeWords());
    },
  },
  "cards.next-revision": {
    get label() {
      return m.commandCardsNextRevision();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsNextRevisionWords());
    },
  },
  // The shown card's thread folded into the card's foot, or beside it again
  // (docs/card-threads.md, "The shell"): ⌘\ as a sidebar is shown or hidden.
  "cards.point-at": {
    get label() {
      return m.commandCardsPointAt();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "a", meta: true, shift: true }],
    get searchWords() {
      return searchWords(m.commandCardsPointAtWords());
    },
  },
  "cards.thread": {
    get label() {
      return m.commandCardsThread();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "\\", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsThreadWords());
    },
  },
  // The shown card's jump down in its thread, while the captain reads above
  // its foot (docs/card-threads.md, "Keeping your place"): chosen by name.
  "cards.thread-new": {
    get label() {
      return m.commandCardsThreadNew();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsThreadNewWords());
    },
  },
  // The shown task card's tabs (docs/task-card-tabs.md): Info, Cards,
  // Activity (INF-2261), the crewmate's session and the browser's pages,
  // and on a card about a task its way to them (INF-358). No key of their
  // own yet: chosen by name.
  "cards.show-info": {
    get label() {
      return m.commandCardsShowInfo();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsShowInfoWords());
    },
  },
  "cards.show-cards": {
    get label() {
      return m.commandCardsShowCards();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsShowCardsWords());
    },
  },
  "cards.show-activity": {
    get label() {
      return m.commandCardsShowActivity();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsShowActivityWords());
    },
  },
  "cards.show-crewmate": {
    get label() {
      return m.commandCardsShowCrewmate();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsShowCrewmateWords());
    },
  },
  "browser.control": {
    get label() {
      return m.commandBrowserControl();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandBrowserControlWords());
    },
  },
  // The shown task record's Move to a computer (docs/helper.md, "Moving a
  // started task"): opens its picker, which saves nothing until Move.
  "task.move-computer": {
    get label() {
      return m.commandTaskMoveComputer();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandTaskMoveComputerWords());
    },
  },
  // The shown task record's Close as done (INF-3169's plan, piece 3): opens
  // its one confirm, which closes nothing until its own Close as done.
  "task.close-done": {
    get label() {
      return m.commandTaskCloseDone();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandTaskCloseDoneWords());
    },
  },
  "cards.show-browser": {
    get label() {
      return m.commandCardsShowBrowser();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsShowBrowserWords());
    },
  },
  "cards.next-tab": {
    get label() {
      return m.commandCardsNextTab();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsNextTabWords());
    },
  },
  "cards.previous-tab": {
    get label() {
      return m.commandCardsPreviousTab();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsPreviousTabWords());
    },
  },
  "settings.open": {
    get label() {
      return m.commandSettingsOpen();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: ",", meta: true }],
  },
  // Chosen by name, and from the app menu's Keyboard Settings…, which no
  // change of keys can take away.
  "settings.keyboard": {
    get label() {
      return m.commandSettingsKeyboard();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
  },
  // Settings → Panels (INF-2344), chosen by name: no default key.
  "settings.panels": {
    get label() {
      return m.commandSettingsPanels();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsPanelsWords());
    },
  },
  // The update notice is also reached by name; opening it grants no installation consent.
  "updates.show": {
    get label() {
      return m.commandUpdatesShow();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandUpdatesShowWords());
    },
  },
  // INF-2245: the update notice's Update later, chosen by name while an
  // update saves the crew's work; a person may give it a key.
  "updates.later": {
    get label() {
      return m.commandUpdatesLater();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandUpdatesLaterWords());
    },
  },
  // INF-2073: Settings → General's Check for updates, chosen by name; a person may give it a key.
  "updates.check": {
    get label() {
      return m.commandUpdatesCheck();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandUpdatesCheckWords());
    },
  },
  // The newest release note again (docs/release-notes.md "Reading a note
  // again"): chosen by name, and from the Help menu's What's New, like
  // Keyboard settings; a person may give it a key.
  "whats-new.show": {
    get label() {
      return m.commandWhatsNewShow();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandWhatsNewShowWords());
    },
  },
  // The first mate's newest reply, whole, as a note at the front
  // (docs/composer.md "The reply note"): chosen by name, so it opens after
  // the line above the input has faded too.
  "firstmate.reply": {
    get label() {
      return m.commandFirstmateReply();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandFirstmateReplyWords());
    },
  },
  "settings.runbooks": {
    get label() {
      return m.commandSettingsRunbooks();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsRunbooksWords());
    },
  },
  "runbooks.open-folder": {
    get label() {
      return m.commandRunbooksOpenFolder();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandRunbooksOpenFolderWords());
    },
  },
  // Settings → Usage (docs/usage.md), chosen by name: it has no default key.
  "settings.usage": {
    get label() {
      return m.commandSettingsUsage();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsUsageWords());
    },
  },
  // Settings → Automation (docs/automation.md), chosen by name: no default key.
  "settings.automation": {
    get label() {
      return m.commandSettingsAutomation();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsAutomationWords());
    },
  },
  // Settings → Integrations (docs/integrations.md), chosen by name: no default key.
  "settings.integrations": {
    get label() {
      return m.commandSettingsIntegrations();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsIntegrationsWords());
    },
  },
  "settings.secrets": {
    get label() {
      return m.commandSettingsSecrets();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSettingsSecretsWords());
    },
    section: "secrets",
  },
  // Every running automation paused at once, as Settings → Automation's
  // Pause all does; it opens Automation so the change is seen. No default key.
  "automation.pause-all": {
    get label() {
      return m.commandAutomationPauseAll();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandAutomationPauseAllWords());
    },
  },
  // Tokens or estimated dollars, everywhere in Usage at once; it opens
  // Usage, so the switch is seen, and the core remembers the choice.
  "usage.unit": {
    get label() {
      return m.commandUsageUnit();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandUsageUnitWords());
    },
  },
  // Every account's allowance read again, as the spent-allowance card's
  // Recheck allowance and Subscriptions' Refresh do: a login switched
  // elsewhere is read first (docs/quota.md "A changed login"). No default key.
  "allowance.recheck": {
    get label() {
      return m.commandAllowanceRecheck();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandAllowanceRecheckWords());
    },
  },
  // This Mac's own SSH connections to the Macs it added by their address,
  // each it stopped trying tried once more (docs/devices.md, "Through the
  // home's SSH"); chosen by name, and only where Devices shows.
  "devices.try-again": {
    get label() {
      return m.commandDevicesTryAgain();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandDevicesTryAgainWords());
    },
    section: "devices",
  },
  // Control too, as the window always took it; the menu shows the first.
  "size.larger": {
    get label() {
      return m.commandSizeLarger();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "view",
    keys: [
      { key: "+", meta: true },
      { key: "=", meta: true },
      { key: "+", ctrl: true },
      { key: "=", ctrl: true },
    ],
  },
  "size.smaller": {
    get label() {
      return m.commandSizeSmaller();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "view",
    keys: [
      { key: "-", meta: true },
      { key: "-", ctrl: true },
    ],
  },
  "size.reset": {
    get label() {
      return m.commandSizeReset();
    },
    scope: "window",
    runs: "main",
    repeat: true,
    risk: "view",
    keys: [
      { key: "0", meta: true },
      { key: "0", ctrl: true },
    ],
  },
  "message.delete-to-line-start": {
    get label() {
      return m.commandMessageDeleteToLineStart();
    },
    scope: "message-field",
    repeat: true,
    risk: "edit",
    keys: [{ key: "u", ctrl: true }],
  },
  "message.delete-to-line-end": {
    get label() {
      return m.commandMessageDeleteToLineEnd();
    },
    scope: "message-field",
    repeat: true,
    risk: "edit",
    keys: [{ key: "k", ctrl: true }],
  },
  "message.delete-word-before": {
    get label() {
      return m.commandMessageDeleteWordBefore();
    },
    scope: "message-field",
    repeat: true,
    risk: "edit",
    keys: [{ key: "w", ctrl: true }],
  },
  "message.put-back-deleted": {
    get label() {
      return m.commandMessagePutBackDeleted();
    },
    scope: "message-field",
    repeat: true,
    risk: "edit",
    keys: [{ key: "y", ctrl: true }],
  },
  "message.recall": {
    get label() {
      return m.commandMessageRecall();
    },
    scope: "main-message",
    repeat: false,
    risk: "edit",
    keys: [{ key: "ArrowUp" }, { key: "p", ctrl: true }],
  },
} as const satisfies Record<string, KeyboardCommand>;

export type CommandId = keyof typeof KEYBOARD_COMMANDS;

/** The commands the main process runs, wherever focus is in the window. */
export type WindowCommandId = {
  [Id in CommandId]: (typeof KEYBOARD_COMMANDS)[Id]["scope"] extends "window" ? Id : never;
}[CommandId];

/** The window commands the shell page runs once the main process tells it which. */
export type ShellCommandId = {
  [Id in CommandId]: (typeof KEYBOARD_COMMANDS)[Id] extends { runs: "shell" } ? Id : never;
}[CommandId];

/** The shown card's footer choices: the default, then the rest from the right edge leftward. */
export const CARD_CHOICE_COMMANDS = [
  "cards.choice-1",
  "cards.choice-2",
  "cards.choice-3",
  "cards.choice-4",
] as const satisfies readonly ShellCommandId[];

/** The window commands the main process runs itself. */
export type MainCommandId = Exclude<WindowCommandId, ShellCommandId>;

/** Whether a command's keys are the window's, heard by the main process wherever focus is. */
export function isWindowCommand(id: CommandId): id is WindowCommandId {
  return KEYBOARD_COMMANDS[id].scope === "window";
}

/** Whether a window command is the shell page's to run. */
export function isShellCommand(id: CommandId): id is ShellCommandId {
  const command: KeyboardCommand = KEYBOARD_COMMANDS[id];
  return command.runs === "shell";
}

/** Every command id, in the catalog's order. */
export const COMMAND_IDS = Object.keys(KEYBOARD_COMMANDS) as CommandId[];

/** The shell's window commands, in the catalog's order. */
export const SHELL_COMMAND_IDS = COMMAND_IDS.filter(isShellCommand);

/** The window commands the main process runs itself, in the catalog's order. */
export const MAIN_COMMAND_IDS = COMMAND_IDS.filter(
  (id): id is MainCommandId => isWindowCommand(id) && !isShellCommand(id),
);

/**
 * The key each movement command presses where focus is (docs/keyboard.md,
 * "Moving by a key of your own"), as `KeyboardEvent.key` names it.
 */
export const MOVE_KEYS = {
  "move.left": "ArrowLeft",
  "move.down": "ArrowDown",
  "move.up": "ArrowUp",
  "move.right": "ArrowRight",
  "move.first": "Home",
  "move.last": "End",
  "move.page-up": "PageUp",
  "move.page-down": "PageDown",
  cancel: "Escape",
} as const satisfies Partial<Record<MainCommandId, string>>;

/** A movement command: it presses one of `MOVE_KEYS` where focus is. */
export type MoveCommandId = keyof typeof MOVE_KEYS;

/** A key a movement command presses. */
export type MoveKey = (typeof MOVE_KEYS)[MoveCommandId];

/** Every key a movement command presses. */
export const MOVE_KEY_NAMES = Object.values(MOVE_KEYS) as MoveKey[];

/** The window's size commands, the other commands the main process runs. */
export type SizeCommandId = Exclude<MainCommandId, MoveCommandId>;

export function isMoveCommand(id: string): id is MoveCommandId {
  return Object.hasOwn(MOVE_KEYS, id);
}

// --- A panel's commands (docs/keyboard.md, "A panel's commands") -----------

/**
 * A command a panel adds to command search (FI3-1015): `panel:<panel>/<command>`,
 * from the panel's id and the command's own in its `manifest.json`. It is
 * how a key a person gives it is kept, so it never changes while the panel
 * keeps the command, and a saved one whose panel is gone waits, unrun, for
 * the panel to come back.
 */
export type PanelCommandId = `panel:${string}`;

/** The longest a panel command's id may be: as long as a saved key may be named by. */
export const PANEL_COMMAND_ID_MAX = 64;

export function panelCommandId(panel: string, command: string): PanelCommandId {
  return `panel:${panel}/${command}`;
}

export function isPanelCommandId(id: string): id is PanelCommandId {
  return /^panel:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(id);
}

/** The panel and the command a panel command's id names. */
export function panelCommandParts(id: PanelCommandId): { panel: string; command: string } {
  const [panel = "", command = ""] = id.slice("panel:".length).split("/");
  return { panel, command };
}

/**
 * A panel's command as the window's keys read it: its words, the title of
 * the panel it is listed under, and the key the panel suggests. It works
 * anywhere in the window, the shell page runs it, a held key never repeats
 * it, and it only shows or brings forward (`navigate`).
 */
export type PanelCommand = {
  id: PanelCommandId;
  label: string;
  /** The panel's title: command search and Keyboard settings list it under it. */
  panel: string;
  /** The key its panel suggests, or none; the window gives it only where nothing else uses it. */
  keys: readonly KeyBinding[];
  /** Other words command search finds it by, as its panel's manifest names them. */
  words?: readonly string[];
  /**
   * One of the app's own panels' commands: it reads as one of the window's
   * own, listed among the catalog's (`APP_PANEL_COMMANDS_BEFORE`) under no
   * panel's title, as the app's own panels carry no maker's name.
   */
  own?: true;
};

/** A command of the catalog's, or a panel's. */
export type AnyCommandId = CommandId | PanelCommandId;

/** The catalog entry a panel command reads as, its suggested key as this system presses it. */
export function panelCommandEntry(
  command: PanelCommand,
  system: KeySystem = "mac",
): KeyboardCommand {
  return {
    label: command.label,
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: systemKeys(command.keys, system),
    ...(command.words?.length ? { searchWords: command.words } : {}),
  };
}

/** Whether an id is one of the catalog's own commands. */
export function isCatalogCommand(id: string): id is CommandId {
  return Object.hasOwn(KEYBOARD_COMMANDS, id);
}

/**
 * A command's entry: the catalog's, or the panel command's in `panels`, or
 * none; its own keys as this system presses them.
 */
export function commandEntry(
  id: string,
  panels: readonly PanelCommand[] = [],
  system: KeySystem = "mac",
): KeyboardCommand | undefined {
  if (isCatalogCommand(id))
    return system === "mac"
      ? KEYBOARD_COMMANDS[id]
      : { ...KEYBOARD_COMMANDS[id], keys: catalogKeys(id, system) };
  const panel = panels.find((command) => command.id === id);
  return panel ? panelCommandEntry(panel, system) : undefined;
}

/**
 * Where the app's own panels' commands sit among the catalog's: after the
 * commands for the stage and its cards, before Settings.
 */
export const APP_PANEL_COMMANDS_BEFORE: CommandId = "settings.open";

/**
 * Every command a key may run: the catalog's, in its order, with the app's
 * own panels' among them (`APP_PANEL_COMMANDS_BEFORE`), then every other
 * panel's, in the order the panels were added.
 */
export function allCommandIds(panels: readonly PanelCommand[] = []): AnyCommandId[] {
  const own = panels.filter((command) => command.own).map((command) => command.id);
  const at = COMMAND_IDS.indexOf(APP_PANEL_COMMANDS_BEFORE);
  return [
    ...COMMAND_IDS.slice(0, at),
    ...own,
    ...COMMAND_IDS.slice(at),
    ...panels.filter((command) => !command.own).map((command) => command.id),
  ];
}

/**
 * The keys each command answers to; an empty list leaves a command without
 * keys. Every catalog command has its list; a panel command has one once
 * the window installed it with its panel.
 */
export type Bindings = Readonly<Record<CommandId, readonly KeyBinding[]>> &
  Readonly<Partial<Record<PanelCommandId, readonly KeyBinding[]>>>;

/** A command's keys in `bindings`, a panel command's none when it has no list there. */
export function keysOf(bindings: Bindings, id: AnyCommandId): readonly KeyBinding[] {
  return (bindings as Readonly<Record<string, readonly KeyBinding[] | undefined>>)[id] ?? [];
}

/**
 * A chord as this system's keyboard presses it (docs/keyboard.md, "Keys on
 * each system"). The catalog, and a panel's suggested key, are written as a
 * Mac writes them: on a Ctrl system Ctrl takes ⌘'s place, and a chord a Mac
 * holds ⌃ for has no place there, since Ctrl already holds ⌘'s - so the
 * message box's Mac-style Control keys have none, and the size keys keep
 * their ⌘ chords as Ctrl ones.
 */
export function systemChord(chord: KeyChord, system: KeySystem): KeyChord | null {
  if (system === "mac" || (!chord.meta && !chord.ctrl)) return chord;
  if (chord.ctrl) return null;
  return {
    key: chord.key,
    ctrl: true,
    ...(chord.alt ? { alt: true } : {}),
    ...(chord.shift ? { shift: true } : {}),
  };
}

/** Keys as this system presses them (`systemChord`), each once; the Mac's are the keys as written. */
export function systemKeys(keys: readonly KeyBinding[], system: KeySystem): readonly KeyBinding[] {
  if (system === "mac") return keys;
  const pressed: KeyBinding[] = [];
  for (const binding of keys) {
    const first = systemChord(binding, system);
    const second = binding.second ? systemChord(binding.second, system) : undefined;
    if (!first || second === null) continue;
    const next: KeyBinding = {
      ...first,
      ...(second ? { second } : {}),
      ...(binding.when ? { when: binding.when } : {}),
    };
    if (!pressed.some((kept) => JSON.stringify(kept) === JSON.stringify(next))) pressed.push(next);
  }
  return pressed;
}

/** A catalog command's own keys on this system. */
export function catalogKeys(id: CommandId, system: KeySystem = "mac"): readonly KeyBinding[] {
  return systemKeys(KEYBOARD_COMMANDS[id].keys, system);
}

/** The catalog's own keys on a system. */
export function catalogBindings(system: KeySystem): Bindings {
  return Object.fromEntries(
    COMMAND_IDS.map((id): [CommandId, readonly KeyBinding[]] => [id, catalogKeys(id, system)]),
  ) as Record<CommandId, readonly KeyBinding[]>;
}

/** The catalog's own keys, as a Mac presses them. */
export const DEFAULT_BINDINGS: Bindings = catalogBindings("mac");

/** What the listener that hears a key knows about where it was pressed. */
export type KeyContext = {
  /** The focused document offered an unused key from outside a typing control. */
  notTyping?: boolean;
  /** The message field that has focus, when the listener is one. */
  field?: "main-message" | "reply";
};

/** Whether a command with this scope works where the key was pressed. */
export function scopeIsActive(scope: CommandScope, context: KeyContext): boolean {
  if (scope === "window") return true;
  if (scope === "message-field") return context.field !== undefined;
  return context.field === "main-message";
}

/**
 * The letter a press types: the layout's own Latin letter, or the physical
 * key's on a layout without Latin letters (or under a modifier that types
 * another character), so a chord on `u` still works there.
 */
function letterOf(press: KeyPress): string | undefined {
  if (/^[a-z]$/i.test(press.key)) return press.key.toLowerCase();
  return /^Key([A-Z])$/.exec(press.code)?.[1]?.toLowerCase();
}

/** Whether a press is this chord: the same key, with exactly its modifiers held. */
export function chordMatches(chord: KeyChord, press: KeyPress): boolean {
  if (
    press.meta !== (chord.meta === true) ||
    press.ctrl !== (chord.ctrl === true) ||
    press.alt !== (chord.alt === true)
  )
    return false;
  if (/^[a-z]$/.test(chord.key))
    return letterOf(press) === chord.key && press.shift === (chord.shift === true);
  if (chord.key.length > 1 || chord.shift === true)
    return press.key === chord.key && press.shift === (chord.shift === true);
  return press.key === chord.key;
}

/**
 * The command whose keys a press is, where it was pressed, whether or not
 * the key is held. An input method's composition keeps every key. A
 * two-key shortcut is never one press (`startsTwoKeys`, `secondKeyCommand`).
 */
export function boundCommand(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  if (press.composing) return undefined;
  return COMMAND_IDS.find(
    (candidate) =>
      scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) &&
      bindings[candidate].some(
        (binding) =>
          !binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
      ),
  );
}

/**
 * The panel command whose keys a press is, or nothing: a panel's commands
 * work anywhere in the window and are only looked at once no catalog
 * command took the press (`boundCommand`).
 */
export function panelCommandFor(
  press: KeyPress,
  bindings: Bindings,
  panels: readonly PanelCommand[],
  context: KeyContext = {},
): PanelCommandId | undefined {
  if (press.composing || press.repeat) return undefined;
  return panels.find((command) =>
    keysOf(bindings, command.id).some(
      (binding) =>
        !binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
    ),
  )?.id;
}

/** Whether a press is the first key of some two-key shortcut that works where it was pressed. */
export function startsTwoKeys(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
  panels: readonly PanelCommand[] = [],
): boolean {
  if (press.composing) return false;
  const starts = (keys: readonly KeyBinding[]) =>
    keys.some(
      (binding) =>
        binding.second && bindingIsActive(binding, context) && chordMatches(binding, press),
    );
  return (
    COMMAND_IDS.some(
      (candidate) =>
        scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) && starts(bindings[candidate]),
    ) || panels.some((command) => starts(keysOf(bindings, command.id)))
  );
}

/** The panel command a two-key shortcut runs, as `secondKeyCommand` finds a catalog one. */
export function secondKeyPanelCommand(
  first: KeyPress,
  second: KeyPress,
  bindings: Bindings,
  panels: readonly PanelCommand[],
  context: KeyContext = {},
): PanelCommandId | undefined {
  if (first.composing || second.composing) return undefined;
  return panels.find((command) =>
    keysOf(bindings, command.id).some(
      (binding) =>
        binding.second !== undefined &&
        bindingIsActive(binding, context) &&
        chordMatches(binding, first) &&
        chordMatches(binding.second, second),
    ),
  )?.id;
}

/**
 * The command a two-key shortcut runs: the one whose first key is `first`
 * and whose second is `second`, where they were pressed, or nothing.
 */
export function secondKeyCommand(
  first: KeyPress,
  second: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  if (first.composing || second.composing) return undefined;
  return COMMAND_IDS.find(
    (candidate) =>
      scopeIsActive(KEYBOARD_COMMANDS[candidate].scope, context) &&
      bindings[candidate].some(
        (binding) =>
          binding.second !== undefined &&
          bindingIsActive(binding, context) &&
          chordMatches(binding, first) &&
          chordMatches(binding.second, second),
      ),
  );
}

/** One two-key shortcut whose first key was pressed, and the command it runs. */
export type NextKey = { id: AnyCommandId; binding: KeyBinding & { second: KeyChord } };

/**
 * Every key that may follow `first` where it was pressed, with the command
 * each pair runs, in the catalog's order and then the panels' (docs/keyboard.md,
 * "Two-key shortcuts"): what the next-keys hint lists while the window waits.
 */
export function nextKeys(
  first: KeyPress,
  context: KeyContext,
  bindings: Bindings,
  panels: readonly PanelCommand[] = [],
): NextKey[] {
  if (first.composing) return [];
  const following = (id: AnyCommandId): NextKey[] =>
    keysOf(bindings, id).flatMap((binding) =>
      binding.second !== undefined &&
      bindingIsActive(binding, context) &&
      chordMatches(binding, first)
        ? [{ id, binding: { ...binding, second: binding.second } }]
        : [],
    );
  return [
    ...COMMAND_IDS.filter((id) => scopeIsActive(KEYBOARD_COMMANDS[id].scope, context)).flatMap(
      following,
    ),
    ...panels.flatMap((command) => following(command.id)),
  ];
}

/** Whether a press runs its command: a held key repeats only a command that allows it. */
export function runsOnPress(id: CommandId, press: KeyPress): boolean {
  return !press.repeat || KEYBOARD_COMMANDS[id].repeat;
}

/**
 * The command a press runs where it was pressed, if any. An input method's
 * composition keeps every key, and a held key repeats only a command that
 * allows it.
 */
export function commandFor(
  press: KeyPress,
  context: KeyContext,
  bindings: Bindings = DEFAULT_BINDINGS,
): CommandId | undefined {
  const id = boundCommand(press, context, bindings);
  return id !== undefined && runsOnPress(id, press) ? id : undefined;
}

/** What one of a desktop's own window keys does (docs/keyboard.md, "Keys on each system"). */
export type DesktopKeyAction = "quit" | "close-window";

/**
 * The window keys a Mac's app menu holds (⌘Q, ⌘W) and the window takes
 * itself on a Ctrl system, which has no menu bar: Ctrl+Q quits Firstmate and
 * Ctrl+W closes the window. They are a Ctrl system's own keys, so no
 * command can take them (`src/shared/keymap.ts`).
 */
const DESKTOP_KEYS: readonly { chord: KeyChord; action: DesktopKeyAction }[] = [
  { chord: { key: "q", ctrl: true }, action: "quit" },
  { chord: { key: "w", ctrl: true }, action: "close-window" },
];

/** The desktop key a press is on this system, if any; a Mac's are its menu's. */
export function desktopKeyAction(press: KeyPress, system: KeySystem): DesktopKeyAction | undefined {
  if (system === "mac" || press.composing) return undefined;
  return DESKTOP_KEYS.find((entry) => chordMatches(entry.chord, press))?.action;
}

// i18n-exempt: Electron's own accelerator names, read by the menu and never shown as words
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  "+": "Plus",
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

/** A chord as an Electron menu accelerator (`Command+Plus`). */
export function chordAccelerator(chord: KeyChord): string {
  // i18n-exempt: Electron's own accelerator names, never shown as words
  const modifiers = [
    chord.meta && "Command",
    chord.ctrl && "Control",
    chord.alt && "Alt",
    chord.shift && "Shift",
  ].filter((modifier): modifier is string => typeof modifier === "string");
  const key = ACCELERATOR_KEYS[chord.key] ?? chord.key.toUpperCase();
  return [...modifiers, key].join("+");
}

/**
 * The accelerator a menu item shows for a command: its first key a menu can
 * show, which is never a two-key shortcut, or none.
 */
export function menuAccelerator(
  id: CommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
): string | undefined {
  const first = bindings[id].find((binding) => !binding.second && binding.when !== "not-typing");
  return first ? chordAccelerator(first) : undefined;
}

/** A named key as a Mac draws it on a key and in a menu. */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "⎋",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  " ": "Space",
};

/** A named key as Linux and other Ctrl systems write it in a hint and on a key cap. */
// i18n-exempt: key names stay as the keyboard writes them (docs/i18n.md, "What stays English")
const KEY_WORDS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  " ": "Space",
  "+": "Plus",
  "-": "Minus",
};

/**
 * A chord as a person reads it in a hint: on a Mac its modifier glyphs in
 * the Mac's order, then the key (`⇧⌘L`, `⌘,`); on a Ctrl system the words
 * Linux writes, joined by `+` (`Ctrl+Shift+L`, `Ctrl+,`).
 */
export function chordLabel(chord: KeyChord, system: KeySystem = "mac"): string {
  if (system !== "mac") {
    const key =
      KEY_WORDS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
    // i18n-exempt: key names stay as the keyboard writes them
    return [
      chord.ctrl && "Ctrl",
      chord.alt && "Alt",
      chord.shift && "Shift",
      chord.meta && "Super",
      key,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("+");
  }
  const key =
    KEY_GLYPHS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
}

/** A command's keys as a person reads them: a chord, or a two-key shortcut's two (`⌘K S`). */
export function bindingLabel(binding: KeyBinding, system: KeySystem = "mac"): string {
  return binding.second
    ? `${chordLabel(binding, system)} ${chordLabel(binding.second, system)}`
    : chordLabel(binding, system);
}

/** The key a hint shows for a command: its first, or none. */
export function keyHint(
  id: AnyCommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
  system: KeySystem = "mac",
): string | undefined {
  const first = keysOf(bindings, id)[0];
  return first ? bindingLabel(first, system) : undefined;
}

/**
 * A command's keys as `aria-keyshortcuts` names them (`Meta+Shift+L`), or
 * none. The attribute has no way to say two keys in turn, so a two-key
 * shortcut is left out.
 */
export function ariaKeyShortcuts(
  id: AnyCommandId,
  bindings: Bindings = DEFAULT_BINDINGS,
): string | undefined {
  const names = keysOf(bindings, id)
    .filter((binding) => !binding.second)
    .map((chord) =>
      [
        chord.ctrl && "Control",
        chord.alt && "Alt",
        chord.shift && "Shift",
        chord.meta && "Meta",
        chord.key === " "
          ? "Space"
          : /^[a-z]$/.test(chord.key)
            ? chord.key.toUpperCase()
            : chord.key,
      ]
        .filter((part): part is string => typeof part === "string")
        .join("+"),
    );
  return names.length > 0 ? names.join(" ") : undefined;
}
