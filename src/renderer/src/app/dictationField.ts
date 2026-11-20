import type React from "react";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { type DictationField, offerDictationField } from "../voice/dictationFields";
import { insertVoiceTranscript } from "../voice/voiceInput";
import { isDictationKey } from "./dictationKey";
import { useShellStore } from "./store";

/** A field the dictation key writes into, as it reads its own recording. */
export type DictationFieldState = {
  /** The field as the voice store holds it, for the voice lines drawn under it. */
  field: DictationField;
  /** The dictation key records into this field now. */
  recording: boolean;
  /** This field's words are coming back. */
  transcribing: boolean;
  /**
   * The field's keydown, before its own keys: true when the key is not the
   * field's. Escape while this field records abandons the recording and
   * stops there, and the dictation key goes on to the window, where
   * `followDictationKey` hears it.
   */
  keyDown: (event: React.KeyboardEvent) => boolean;
};

/**
 * Offers a field to the dictation key while it is on the page (docs/
 * composer.md, "Voice"): with focus in it, a recording writes its words at
 * the field's caret through `write`, the field keeps the focus and the
 * caret goes after them. `read` is the field's draft as it stands then.
 * A field that leaves the page before its words come back hands them to
 * the main message.
 */
export function useDictationField(
  element: RefObject<HTMLTextAreaElement | null>,
  read: () => string,
  write: (text: string) => void,
): DictationFieldState {
  const latest = useRef({ read, write });
  latest.current = { read, write };
  const field = useMemo<DictationField>(
    () => ({
      element: () => element.current,
      insert: (words) => {
        const own = element.current;
        const next = insertVoiceTranscript(
          latest.current.read(),
          own?.selectionStart ?? null,
          words,
        );
        flushSync(() => latest.current.write(next.text));
        if (!own) return;
        own.focus();
        own.setSelectionRange(next.caret, next.caret);
      },
    }),
    [element],
  );
  useEffect(() => {
    const withdraw = offerDictationField(field);
    return () => {
      withdraw();
      useShellStore.getState().dropVoiceField(field);
    };
  }, [field]);
  const recording = useShellStore((s) => s.recording && s.voiceField === field);
  const transcribing = useShellStore((s) => s.transcribing && s.voiceField === field);
  return {
    field,
    recording,
    transcribing,
    keyDown: (event) => {
      const s = useShellStore.getState();
      if (
        event.key === "Escape" &&
        s.recording &&
        s.voiceField === field &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        event.stopPropagation();
        s.abandonRecording();
        return true;
      }
      return isDictationKey(event);
    },
  };
}
