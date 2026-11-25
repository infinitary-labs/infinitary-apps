import * as m from "./i18n/messages.generated.ts";

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
export function searchWords(words: string): readonly string[] {
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
  // INF-4541: "N new" in keys - the next new card besides the shown one,
  // beside ⇧⌘] for the next card; ⌥ held as a Mac reports it while ⌘ is down.
  "cards.next-new": {
    get label() {
      return m.commandCardsNextNew();
    },
    get searchWords() {
      return searchWords(m.commandCardsNextNewWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [
      { key: "]", meta: true, alt: true, shift: true },
      { key: "}", meta: true, alt: true, shift: true },
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
  // INF-5167's plan: ⌘F finds words in the shown card, as ⌘F finds in a
  // page; ⇧⌘F stays Find a task. ⌘G and ⇧⌘G step through the matches, as
  // on every Mac app.
  "cards.find": {
    get label() {
      return m.commandCardsFind();
    },
    get searchWords() {
      return searchWords(m.commandCardsFindWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "f", meta: true }],
  },
  "cards.find-next": {
    get label() {
      return m.commandCardsFindNext();
    },
    get searchWords() {
      return searchWords(m.commandCardsFindWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "g", meta: true }],
  },
  "cards.find-previous": {
    get label() {
      return m.commandCardsFindPrevious();
    },
    get searchWords() {
      return searchWords(m.commandCardsFindWords());
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "g", meta: true, shift: true }],
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
  // Moving between the questions a card's body asks (docs/keyboard.md,
  // "Moving between a card's questions"): the footer's stepper in keys.
  "cards.next-question": {
    get label() {
      return m.commandCardsNextQuestion();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "j", meta: true }],
    get searchWords() {
      return searchWords(m.commandCardsQuestionWords());
    },
  },
  "cards.previous-question": {
    get label() {
      return m.commandCardsPreviousQuestion();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "j", meta: true, shift: true }],
    get searchWords() {
      return searchWords(m.commandCardsQuestionWords());
    },
  },
  "cards.unanswered-question": {
    get label() {
      return m.commandCardsUnansweredQuestion();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsQuestionWords());
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
  // The picture viewer's Save to Downloads, on the picture it shows (the
  // design skill's PictureViewer, "The picture's menu").
  "viewer.save-picture": {
    get label() {
      return m.commandViewerSavePicture();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [{ key: "s", meta: true }],
    get searchWords() {
      return searchWords(m.commandViewerSavePictureWords());
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
  // The shown card's sound strip (docs/card-authoring.md, "Sound clips"):
  // its Play or Pause, chosen by name.
  "cards.sound": {
    get label() {
      return m.commandCardsSound();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandCardsSoundWords());
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
  // From the request docked beside a browser's page back to the page
  // (docs/task-browser.md, "Asking for help"); ⇧⌘L goes the other way, to
  // the request's field. Chosen by name.
  "browser.page": {
    get label() {
      return m.commandBrowserPage();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandBrowserPageWords());
    },
  },
  // From a card docked beside a browser's page to the card itself, where its
  // choices are (docs/task-browser.md, "A card beside the page"). Chosen by
  // name.
  "browser.card": {
    get label() {
      return m.commandBrowserCard();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandBrowserCardWords());
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
  // The shown task record's Edit tags (docs/task-tags.md): opens its menu
  // of the project's tags, each ticked on or off.
  "task.edit-tags": {
    get label() {
      return m.commandTaskEditTags();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandTaskEditTagsWords());
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
  // INF-4012 direction 1: on a Mac that controls another, Settings → General's
  // row for the first mate's computer's update, chosen by name; it asks before
  // anything installs.
  "updates.home": {
    get label() {
      return m.commandHomeUpdate();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandHomeUpdateWords());
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
  // /feedback in the main message box (docs/feedback.md): chosen by name,
  // and from the Help menu's Send Feedback; a person may give it a key.
  "feedback.start": {
    get label() {
      return m.commandFeedbackStart();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandFeedbackStartWords());
    },
  },
  // The conversation at the front, at its newest round (docs/composer.md
  // "The conversation"): chosen by name, so it opens after the line above
  // the input has faded too. Its id is the one the reply note had, so a key
  // the captain bound to it keeps working.
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
  // INF-4718's plan, piece 2: starts the ask to move secrets from another tool
  // in the message box, for the captain to name the tool; no default key.
  "secrets.move": {
    get label() {
      return m.commandSecretsMove();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "navigate",
    keys: [],
    get searchWords() {
      return searchWords(m.commandSecretsMoveWords());
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
  // The ambient music on or off (docs/ambient-music.md), kept for this
  // window like Settings → Appearance's switch. ⌥⌘P, P for play (INF-5053).
  "ambient.toggle": {
    get label() {
      return m.commandAmbientToggle();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [{ key: "p", meta: true, alt: true }],
    get searchWords() {
      return searchWords(m.commandAmbientToggleWords());
    },
  },
  // The sound button's style list (docs/ambient-music.md), open on the
  // chosen style; it turns the music on first if it was off. No default key.
  "ambient.style": {
    get label() {
      return m.commandAmbientStyle();
    },
    scope: "window",
    runs: "shell",
    repeat: false,
    risk: "view",
    keys: [],
    get searchWords() {
      return searchWords(m.commandAmbientStyleWords());
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
