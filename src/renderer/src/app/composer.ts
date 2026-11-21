import { CONVERSE_TEXT_MAX_CHARS, TURN_IMAGES_MAX } from "@shared/cards";
import {
  type ComposerNotice,
  composeTurnText,
  type PastedText,
  pasteRefusal,
} from "@shared/composer";
import * as m from "@shared/i18n/messages.generated";
import { isPreparing, MAIN_FILES_KEY, whenPrepared } from "../attachments/intake";
import type { ImageAttachment } from "../design";
import { changesOff, messagesWhileReading } from "../devices/viewWords";
import { voiceController } from "../voice/voiceController";
import { insertVoiceTranscript } from "../voice/voiceInput";
import { heldProjectFocus } from "./projectFocus";
import { isHeldEntry, shownEntry } from "./stack";
import type { ShellGet, ShellSet, ShellState } from "./store";

/**
 * The voice notice when a recording cannot be turned into words, worded as
 * the module loads (English, before any language is set) for a spec; the
 * notice itself is worded when it goes up.
 */
export const TRANSCRIBE_FAILED = m.shellTranscribeFailed();

/** The main message: what the captain is writing to the Firstmate, and its send (docs/composer.md). */
export type ComposerSlice = {
  inputText: string;
  attachments: ImageAttachment[];
  /** Long pastes held as chips until the turn leaves (docs/composer.md); compose state only. */
  pastes: PastedText[];
  /**
   * Where the caret last was in the composer, so a transcript lands there
   * (docs/composer.md, "Voice"). null until the field reports one: the end.
   */
  inputCaret: number | null;
  /**
   * The words the last `beginDraft` put at the head of the message box: the
   * next one replaces them while the box still starts with them, so a
   * second starter's words never sit in front of the first's.
   */
  draftLead: string | null;
  /**
   * Why the composer kept a draft or refused a paste, shown under the input
   * until closed or the next turn leaves. Nothing typed or pasted is ever
   * dropped without it.
   */
  composerNotice: ComposerNotice | null;
  /**
   * The recall slot: the last turn sent, in memory only. A send that fails
   * while a newer draft is in the composer stays here rather than overwrite
   * that draft.
   */
  lastSent: { text: string; pastes: PastedText[]; attachments: ImageAttachment[] } | null;
  /** Monotonic counter; keystrokes kick the listening spin. */
  kick: number;
  /** Monotonic counter; each sent turn plays the character's intake. */
  submitted: number;
  /**
   * Incremented when a card closes, voice text arrives, a turn is sent, or
   * the captain goes to the main message, so HomePrompt can focus the input.
   */
  focusRequest: number;
  /**
   * Where the caret goes with focus request `request` (a transcript, a
   * recalled or restored turn, an inlined paste); every other request, a
   * card closing say, keeps the selection where it was.
   */
  focusCaret: { request: number; at: number } | null;
  /**
   * A focus request that is only a way back (`focusMainMessage`'s
   * `yields`): it gives way to a control that took focus in the same
   * render, such as a control reached by a command from search.
   */
  focusYields: number | null;
  /**
   * Go to the main message (docs/keyboard.md): from Settings back home, and
   * the input takes focus with its words, pictures and caret as they were.
   * Nothing moves while `mainMessageRefusal` says why not. A way back that
   * `yields` gives way to a control that takes focus in the same render.
   */
  focusMainMessage: (options?: { yields?: boolean }) => void;
  setInputText: (text: string) => void;
  keystroke: () => void;
  submit: () => void;
  /** Takes pictures up to `TURN_IMAGES_MAX`; the rest are refused out loud. */
  attachImages: (items: ImageAttachment[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  /** Holds a long paste as a chip (`shouldChip`). */
  attachPastedText: (text: string, name?: string) => void;
  removePaste: (id: string) => void;
  setInputCaret: (caret: number) => void;
  /** Up in an empty composer: the last turn sent comes back, words and chips. */
  recallLastSent: () => void;
  /**
   * Puts words at the head of the Firstmate input and focuses it right after
   * them, for the captain to finish; what was already typed stays after them,
   * and words the last draft put there give way to these (`draftLead`).
   */
  beginDraft: (text: string) => void;
  showComposerNotice: (notice: ComposerNotice) => void;
  dismissComposerNotice: () => void;
};

/**
 * Whether the main input takes nothing - no typing, files, focus or
 * hold-to-talk (docs/first-launch.md): while the first-launch gate is up,
 * and before the first read of it settles, when nobody knows yet whether a
 * fresh profile's gate is up.
 */
export function mainInputHeld(s: Pick<ShellState, "firstRun" | "firstRunSettled">): boolean {
  return !s.firstRunSettled || s.firstRun?.gateOpen === true;
}

/**
 * Why focus cannot go to the main message now, in the words a person reads
 * (docs/keyboard.md), or null: a recording, the dictation key's pick and a
 * held main input (`mainInputHeld`) hold the keys.
 */
export function mainMessageRefusal(
  s: Pick<ShellState, "recording" | "pickingDictationKey" | "firstRun" | "firstRunSettled">,
): string | null {
  if (s.pickingDictationKey) return m.shellMainMessagePickingKey();
  if (s.recording) return m.shellMainMessageRecording();
  if (s.firstRun?.gateOpen === true) return m.shellMainMessageConnectFirst();
  if (mainInputHeld(s)) return m.shellMainMessageStarting();
  return null;
}

/**
 * The main message is recording: a recording runs and no other field took
 * it (`voiceField`, docs/composer.md "Voice"), so its words land here.
 */
export function recordingIntoMain(s: Pick<ShellState, "recording" | "voiceField">): boolean {
  return s.recording && s.voiceField === null;
}

/** Both input rows take only the remaining picture slots and explain any refusal. */
export function takePictures(held: ImageAttachment[], items: ImageAttachment[]) {
  const taken = items.slice(0, Math.max(0, TURN_IMAGES_MAX - held.length));
  return { taken, refused: taken.length < items.length };
}

/**
 * Ends the recording and transcribes it. `use` gets the words only while
 * dictation is on and this recording is still the current one; a failure
 * says so under the input, and the transcript is never left pending.
 */
export function transcribeRecording(
  set: ShellSet,
  get: ShellGet,
  held: boolean,
  use: (text: string | null, current: () => boolean) => unknown,
): void {
  const generation = get().voiceGeneration;
  const current = () => generation === get().voiceGeneration;
  set({ recording: false, transcribing: true });
  void voiceController
    .finish(held)
    .then((text) => (get().dictation?.enabled && current() ? use(text, current) : undefined))
    .catch(() => {
      if (!get().dictation?.enabled || !current()) return;
      set({
        voiceNotice: { kind: "error", message: m.shellTranscribeFailed() },
      });
    })
    .finally(() => {
      if (current()) set({ transcribing: false });
    });
}

export function composerSlice(set: ShellSet, get: ShellGet): ComposerSlice {
  return {
    inputText: "",
    attachments: [],
    pastes: [],
    inputCaret: null,
    draftLead: null,
    composerNotice: null,
    lastSent: null,
    kick: 0,
    submitted: 0,
    focusRequest: 0,
    focusCaret: null,
    focusYields: null,
    focusMainMessage: (options) =>
      set((s) =>
        mainMessageRefusal(s) !== null
          ? {}
          : {
              view: "home",
              focusRequest: s.focusRequest + 1,
              focusYields: options?.yields ? s.focusRequest + 1 : null,
            },
      ),
    setInputText: (inputText) => set({ inputText }),
    attachImages: (items: ImageAttachment[]) =>
      set((s) => {
        // The core refuses a turn over the cap whole, words included, so a
        // picture past it is refused here, where the captain can see it.
        const { taken, refused } = takePictures(s.attachments, items);
        return {
          attachments: [...s.attachments, ...taken],
          ...(refused ? { composerNotice: "pictures-max" as const } : {}),
        };
      }),
    removeAttachment: (id: string) =>
      set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
    clearAttachments: () => set({ attachments: [] }),
    attachPastedText: (text, name) =>
      set((s) => {
        const refusal = pasteRefusal(text, s.pastes.length);
        return refusal
          ? { composerNotice: refusal }
          : {
              pastes: [
                ...s.pastes,
                { id: Math.random().toString(36).slice(2), text, ...(name ? { name } : {}) },
              ],
            };
      }),
    removePaste: (id) => set((s) => ({ pastes: s.pastes.filter((p) => p.id !== id) })),
    setInputCaret: (inputCaret) => {
      if (get().inputCaret !== inputCaret) set({ inputCaret });
    },
    recallLastSent: () =>
      set((s) => {
        const empty =
          !s.inputText &&
          s.pastes.length === 0 &&
          s.attachments.length === 0 &&
          !recordingIntoMain(s);
        if (!empty || !s.lastSent) return {};
        const { text, pastes, attachments } = s.lastSent;
        return {
          inputText: text,
          pastes,
          attachments,
          inputCaret: text.length,
          focusRequest: s.focusRequest + 1,
          focusCaret: { request: s.focusRequest + 1, at: text.length },
        };
      }),
    beginDraft: (text) =>
      set((s) => {
        const typed =
          s.draftLead && s.inputText.startsWith(s.draftLead)
            ? s.inputText.slice(s.draftLead.length)
            : s.inputText;
        const inputText = typed.startsWith(text) ? typed : `${text}${typed}`;
        return {
          inputText,
          draftLead: text,
          inputCaret: text.length,
          focusRequest: s.focusRequest + 1,
          focusCaret: { request: s.focusRequest + 1, at: text.length },
        };
      }),
    showComposerNotice: (composerNotice) => set({ composerNotice }),
    dismissComposerNotice: () => set({ composerNotice: null }),
    keystroke: () => set((s) => ({ kick: s.kick + 1 })),
    submit: () => {
      // Attachments are read at send time, not submit time: a paste that
      // lands while a recording transcribes still rides the turn.
      // `draft` is what goes back in the composer if the turn cannot leave.
      const sendTurn = (draft: string): Promise<void> | undefined => {
        const pastes = get().pastes;
        const text = composeTurnText(draft, []);
        const attachments = get().attachments;
        const imgs = attachments.length
          ? attachments.map((a) => ({
              mimeType: a.mimeType,
              data: a.data,
              ...(a.name ? { name: a.name } : {}),
            }))
          : undefined;
        if (!text && !imgs && !pastes.length) return undefined;
        if (isPreparing(MAIN_FILES_KEY)) {
          // A file is still being prepared: nothing leaves, and the draft stays.
          set({ inputText: draft, composerNotice: "files-preparing" });
          return undefined;
        }
        if (text.length > CONVERSE_TEXT_MAX_CHARS) {
          // The core would refuse it; refuse before clearing, so it stays.
          set({ inputText: draft, composerNotice: "too-long" });
          return undefined;
        }
        // Two versions apart, the first mate there still hears plain words,
        // and nothing else (`messages-while-reading`, docs/view.md "Read only").
        const wordsOnly = messagesWhileReading(get().thisMac);
        if (wordsOnly && (imgs || pastes.length)) {
          set({ inputText: draft, composerNotice: "words-only" });
          return undefined;
        }
        if (changesOff(get().thisMac) && !(wordsOnly && text)) {
          // The Mac this one controls is out of reach: nothing leaves, nothing
          // is queued for later, and the words stay (docs/view.md).
          set({ inputText: draft, composerNotice: "away" });
          return undefined;
        }
        // Only the shown entry rides the turn as a hint.
        const entry = shownEntry(get());
        const held = isHeldEntry(entry);
        const visibleCardId = held ? undefined : entry?.id;
        // A task's browser view points the turn at its task, as its record
        // does, and a panel's card - the task board among them - at the task
        // its view aims at (docs/task-board.md, its selected tile).
        const taskId =
          entry?.recordTaskId ??
          entry?.browserTaskId ??
          entry?.crewmateTaskId ??
          entry?.panelCard?.aim ??
          undefined;
        const pastCardId = entry?.pastCardId;
        // The project the window is focused on: the first mate's hint (docs/project-focus.md).
        const focusedProjectId = heldProjectFocus() ?? undefined;
        set((s) => ({
          inputText: "",
          attachments: [],
          pastes: [],
          inputCaret: null,
          composerNotice: null,
          lastSent: { text: draft, pastes, attachments },
          submitted: s.submitted + 1,
          focusRequest: s.focusRequest + 1,
        }));
        get().markFirstTurn();
        // Keep send(text) for the empty-stack case; object form carries the
        // optional on-screen card id or task id (and any pasted images).
        const turn =
          !wordsOnly &&
          (imgs || pastes.length || visibleCardId || taskId || pastCardId || focusedProjectId)
            ? {
                text: text || undefined,
                ...(pastes.length
                  ? { files: pastes.map(({ text, name }) => ({ text, ...(name ? { name } : {}) })) }
                  : {}),
                images: imgs,
                visibleCardId,
                taskId,
                pastCardId,
                focusedProjectId,
              }
            : text;
        return window.infinitary.conversation.send(turn).then(
          () => undefined,
          () => {
            // A turn the core never took. An empty composer gets it back; a
            // newer draft is never overwritten, and the turn waits in the
            // recall slot instead.
            const now = get();
            if (
              !now.inputText.trim() &&
              now.attachments.length === 0 &&
              now.pastes.length === 0 &&
              !recordingIntoMain(now)
            ) {
              set((s) => ({
                inputText: draft,
                pastes,
                attachments,
                inputCaret: draft.length,
                composerNotice: "not-sent",
                focusRequest: s.focusRequest + 1,
                focusCaret: { request: s.focusRequest + 1, at: draft.length },
              }));
            } else {
              set({ composerNotice: "not-sent" });
            }
          },
        );
      };
      if (recordingIntoMain(get())) {
        // Submit straight from the recording: transcribe, then send.
        transcribeRecording(set, get, false, async (text, current) => {
          // A voice send still waits for every file to be ready.
          await whenPrepared(MAIN_FILES_KEY);
          if (!current()) return;
          const { inputText, inputCaret } = get();
          return sendTurn(insertVoiceTranscript(inputText, inputCaret, text || "").text);
        });
        return;
      }
      void sendTurn(get().inputText);
    },
  };
}
