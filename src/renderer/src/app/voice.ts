import type { DictationSettings } from "@shared/dictation";
import * as m from "@shared/i18n/messages.generated";
import { type DictationField, focusedDictationField } from "../voice/dictationFields";
import { type MicLine, readMicAccess, settledMicLine } from "../voice/micAccess";
import { voiceController } from "../voice/voiceController";
import { insertVoiceTranscript } from "../voice/voiceInput";
import { mainInputHeld, transcribeRecording } from "./composer";
import type { ShellGet, ShellSet, ShellState } from "./store";

/**
 * The voice notice when the voice model's download fails, worded as the
 * module loads (English, before any language is set) for a spec; the notice
 * itself is worded when it goes up.
 */
export const VOICE_MODEL_DOWNLOAD_FAILED = m.shellVoiceDownloadFailed();

/** Hold-to-talk: the saved dictation choice, the recording and its transcript (docs/composer.md, "Voice"). */
export type VoiceSlice = {
  recording: boolean;
  /** The saved choice; no capture or key interception until it is read. */
  dictation: DictationSettings | null;
  pickingDictationKey: boolean;
  voiceGeneration: number;
  /**
   * The field the latest press of the dictation key writes into and draws
   * its mark and voice lines at, or null for the main message: the one with
   * focus as the press began (`focusedDictationField`). A field that leaves
   * the page sets it back to null (`dropVoiceField`), so its words land in
   * the main message.
   */
  voiceField: DictationField | null;
  applyDictation: (setting: DictationSettings) => void;
  /** null until the WebGPU/mic capability check settles (D-10 gate). */
  voiceSupported: boolean | null;
  voiceModelReady: boolean | null;
  voiceNotice:
    | null
    | { kind: "consent" }
    | { kind: "download"; fraction: number }
    | { kind: "error"; message: string }
    | { kind: "mic"; line: MicLine };
  transcribing: boolean;
  startVoiceDownload: () => void;
  dismissVoiceNotice: () => void;
  /**
   * Reads microphone access again while a line says it is off: access
   * turned on in System Settings takes the line down (docs/composer.md).
   */
  recheckMicAccess: () => void;
  startRecording: () => void;
  acceptRecording: (held?: boolean) => void;
  abandonRecording: () => void;
  /**
   * A field leaving the page: if the dictation key writes into it, its
   * recording, its words still coming back and its voice lines go to the
   * main message instead, so nothing said is lost.
   */
  dropVoiceField: (field: DictationField) => void;
};

export function voiceSlice(set: ShellSet, get: ShellGet): VoiceSlice {
  return {
    recording: false,
    dictation: null,
    pickingDictationKey: false,
    voiceGeneration: 0,
    voiceField: null,
    applyDictation: (dictation) => {
      if (!dictation.enabled) {
        voiceController.abandon();
        set((s) => ({
          voiceGeneration: s.voiceGeneration + 1,
          recording: false,
          transcribing: false,
          voiceNotice: null,
        }));
      }
      set({ dictation, pickingDictationKey: false });
    },
    voiceSupported: null,
    voiceModelReady: null,
    voiceNotice: null,
    transcribing: false,
    startVoiceDownload: () => {
      if (!get().dictation?.enabled) return;
      set({ voiceNotice: { kind: "download", fraction: 0 } });
      void window.infinitary.voice
        .ensureModel()
        .then(() => {
          set({ voiceModelReady: true, voiceNotice: null });
        })
        .catch(() => {
          if (!get().dictation?.enabled) return;
          set({
            voiceNotice: { kind: "error", message: m.shellVoiceDownloadFailed() },
          });
        });
    },
    dismissVoiceNotice: () => set({ voiceNotice: null }),
    recheckMicAccess: () => {
      const shown = get().voiceNotice;
      if (shown?.kind !== "mic" || shown.line === "asking") return;
      void readMicAccess().then((access) => {
        const now = get().voiceNotice;
        if (now?.kind !== "mic" || now.line === "asking") return;
        const line = settledMicLine(access);
        set({ voiceNotice: line ? { kind: "mic", line } : null });
      });
    },
    startRecording: () => {
      const { view, recording, voiceSupported, voiceModelReady } = get();
      if (
        !get().dictation?.enabled ||
        get().pickingDictationKey ||
        view !== "home" ||
        recording ||
        voiceSupported !== true
      )
        return;
      // A held input ignores hold-to-talk too (docs/first-launch.md).
      if (mainInputHeld(get())) return;
      // The words go where the person is typing, and its lines draw there.
      const voiceField = focusedDictationField();
      if (voiceModelReady !== true) {
        // First use: the model downloads once, with consent (section 8).
        if (get().voiceNotice?.kind !== "download") {
          set({ voiceNotice: { kind: "consent" }, voiceField });
        }
        return;
      }
      set((s) => ({
        voiceField,
        // A newer recording replaces one still transcribing: its words are
        // dropped, and only this generation could have cleared Transcribing.
        voiceGeneration: s.voiceGeneration + 1,
        recording: true,
        transcribing: false,
        // A line about microphone access stays until a hold works.
        voiceNotice: s.voiceNotice?.kind === "mic" ? s.voiceNotice : null,
      }));
      const generation = get().voiceGeneration;
      const current = () => generation === get().voiceGeneration && get().dictation?.enabled;
      const stopWith = (voiceNotice: ShellState["voiceNotice"]) =>
        set({ recording: false, voiceNotice });
      // macOS's answer, read without asking, says which line goes under the
      // input (docs/composer.md, "Voice"): none, macOS is asking, or why the
      // microphone stays shut.
      void readMicAccess().then(async (access) => {
        if (!current()) return;
        const refused = settledMicLine(access);
        if (refused) return stopWith({ kind: "mic", line: refused });
        // Stopped before the answer came: nothing opens.
        if (!get().recording) return;
        if (access === "not-determined") set({ voiceNotice: { kind: "mic", line: "asking" } });
        try {
          // The 120s runaway guard finishes the capture like a release.
          await voiceController.start(() => get().acceptRecording());
        } catch {
          const line = settledMicLine(await readMicAccess());
          if (!current()) return;
          if (line) return stopWith({ kind: "mic", line });
          if (get().recording) {
            return stopWith({
              kind: "error",
              message: m.shellVoiceMicUnavailable(),
            });
          }
        }
        // Answered, or a hold that works: every microphone line comes down.
        if (current() && get().voiceNotice?.kind === "mic") set({ voiceNotice: null });
      });
    },
    acceptRecording: (held = false) => {
      if (!get().recording) return;
      transcribeRecording(set, get, held, (text) => {
        if (!text) return;
        const field = get().voiceField;
        if (field) return field.insert(text);
        set((s) => {
          const next = insertVoiceTranscript(s.inputText, s.inputCaret, text);
          return {
            inputText: next.text,
            inputCaret: next.caret,
            focusRequest: s.focusRequest + 1,
            focusCaret: { request: s.focusRequest + 1, at: next.caret },
          };
        });
      });
    },
    abandonRecording: () => {
      if (!get().recording) return;
      voiceController.abandon();
      set({ recording: false });
    },
    dropVoiceField: (field) => {
      if (get().voiceField === field) set({ voiceField: null });
    },
  };
}
