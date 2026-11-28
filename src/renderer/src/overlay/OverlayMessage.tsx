import type { LastTurn } from "@shared/lastTurn";
import { useEffect, useMemo, useRef, useState } from "react";
import { ComposerNotice } from "../app/ComposerNotice";
import { mainInputHeld } from "../app/composer";
import { inputPlaceholder } from "../app/HomePrompt";
import { LastTurnRound } from "../app/LastTurn";
import { useShellStore } from "../app/store";
import { mainDestination } from "../attachments/destinations";
import { useFileIntake } from "../attachments/useFileIntake";
import { VoiceInput } from "../design";

/** The box's gap under the pager, or under the card where no pager shows. */
const BOX_GAP = 12;

/**
 * The round to draw above the field: the newest, once a message sent from
 * this box in this opening has arrived (`user_turn` moves the count past
 * `sentAt`), so an earlier exchange never covers the app behind.
 */
function roundAfter(sentAt: number | null, seq: number, turn: LastTurn | null): LastTurn | null {
  return sentAt !== null && seq > sentAt ? turn : null;
}

/**
 * The first mate's message box in the card overlay (docs/card-overlay.md,
 * "The message box"): the window's own main message - its words, chips,
 * recall and send - typed only, under the pager, or alone when no card
 * waits. After a send from it, the newest round shows above the field; it
 * opens nothing, since the conversation stays in the window.
 */
export function OverlayMessage({ alone }: { alone: boolean }) {
  const inputText = useShellStore((s) => s.inputText);
  const setInputText = useShellStore((s) => s.setInputText);
  const setInputCaret = useShellStore((s) => s.setInputCaret);
  const keystroke = useShellStore((s) => s.keystroke);
  const submit = useShellStore((s) => s.submit);
  const attachments = useShellStore((s) => s.attachments);
  const attachImages = useShellStore((s) => s.attachImages);
  const removeAttachment = useShellStore((s) => s.removeAttachment);
  const pastes = useShellStore((s) => s.pastes);
  const attachPastedText = useShellStore((s) => s.attachPastedText);
  const removePaste = useShellStore((s) => s.removePaste);
  const recallLastSent = useShellStore((s) => s.recallLastSent);
  const replacing = useShellStore((s) => s.replacing !== null);
  const showComposerNotice = useShellStore((s) => s.showComposerNotice);
  const firstRun = useShellStore((s) => s.firstRun);
  const held = useShellStore(mainInputHeld);
  const busy = useShellStore((s) => s.firstmateBusy);
  const lastTurn = useShellStore((s) => s.lastTurn);
  const lastTurnSeq = useShellStore((s) => s.lastTurnSeq);
  const focusRequest = useShellStore((s) => s.focusRequest);
  const focusCaret = useShellStore((s) => s.focusCaret);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const round = roundAfter(sentAt, lastTurnSeq, lastTurn);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileDestination = useMemo(
    () =>
      mainDestination(
        () => inputRef.current,
        () => mainInputHeld(useShellStore.getState()),
      ),
    [],
  );
  const fileIntake = useFileIntake(fileDestination);

  // Go to the main message, a recalled turn and a send each ask for the box's focus, as in the window.
  const focusHandled = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === focusHandled.current) return;
    focusHandled.current = focusRequest;
    const input = inputRef.current;
    input?.focus();
    if (input && focusCaret?.request === focusRequest)
      input.setSelectionRange(focusCaret.at, focusCaret.at);
  }, [focusRequest, focusCaret]);

  // Alone, the box is what the key opened: it takes the keys' focus, its words' caret at their end.
  useEffect(() => {
    if (!alone) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [alone]);

  // The box's whole height and its gap, which the card's cap gives up and the
  // card, pager and box are centred with (overlay.css).
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(
        "--overlay-box-lane",
        `${BOX_GAP + box.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(publish);
    observer.observe(box);
    publish();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--overlay-box-lane");
    };
  }, []);

  const send = () => {
    setSentAt((at) => at ?? useShellStore.getState().lastTurnSeq);
    submit();
  };

  return (
    <div
      ref={boxRef}
      data-overlay-message=""
      data-overlay-message-alone={alone ? "" : undefined}
      // Esc on a replacing draft only drops the mark and keeps the words, as in the window.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        if (event.target !== inputRef.current) return;
        if (!useShellStore.getState().dropReplacing()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {round && (
        <div data-last-turn="" data-last-turn-fade="shown" data-overlay-round="">
          <LastTurnRound round={round} busy={busy} opens={null} />
        </div>
      )}
      <VoiceInput
        mode="idle"
        width="100%"
        value={inputText}
        disabled={held}
        style={{ background: "var(--bg-1)" }}
        keybindHint={inputPlaceholder({
          firstRun,
          voiceSupported: false,
          dictation: null,
          transcribing: false,
        })}
        attachments={attachments}
        onAttach={attachImages}
        onPictureTooBig={() => showComposerNotice("picture-too-big")}
        onRemoveAttachment={removeAttachment}
        pastes={pastes}
        onPasteText={attachPastedText}
        onRemovePaste={removePaste}
        onCaretChange={setInputCaret}
        files={fileIntake}
        onRecall={recallLastSent}
        replacing={replacing}
        onChange={(e) => setInputText(e.target.value)}
        onKeystroke={keystroke}
        onSubmit={send}
        inputRef={inputRef}
        maxHeight={Math.round(window.innerHeight / 3)}
      />
      <ComposerNotice width="100%" />
    </div>
  );
}
