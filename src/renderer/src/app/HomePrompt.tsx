import { type DictationSettings, dictationKeyLabel } from "@shared/dictation";
import {
  FIRST_RUN_PLACEHOLDER,
  FIRST_RUN_PLACEHOLDER_NO_VOICE,
  FIRST_RUN_PLACEHOLDER_SHORT,
  type FirstRunView,
  GATED_CHECK_PLACEHOLDER,
  GATED_PLACEHOLDER,
  isFirstRunHint,
  STANDARD_PLACEHOLDER,
  STANDARD_PLACEHOLDER_NO_VOICE,
  STANDARD_PLACEHOLDER_NO_VOICE_SHORT,
  STANDARD_PLACEHOLDER_SHORT,
  STANDARD_PLACEHOLDER_SHORTEST,
  withDictationKey,
} from "@shared/firstRun";
import * as m from "@shared/i18n/messages.generated";
import { hasNotTypingKeys } from "@shared/keyboard";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mainDestination } from "../attachments/destinations";
import { useFileIntake } from "../attachments/useFileIntake";
import { CARD_SIZES } from "../cards/cardGeometry";
import { VoiceInput } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { useInstalledKeymap } from "../design/core/installedKeys";
import { ComposerNotice } from "./ComposerNotice";
import { mainInputHeld, recordingIntoMain } from "./composer";
import { DiagnosticsNotice } from "./DiagnosticsNotice";
import { focusTakenElsewhere } from "./focusRecovery";
import { useCommandKeys } from "./keyHints";
import { LastTurn, useCardUp } from "./LastTurn";
import { usePromptFoot } from "./promptFoot";
import { lastTurnLane, lastTurnRise, promptFoldsRails, promptShellMax } from "./promptGeometry";
import { foldRails, useShellLayout } from "./shellLayout";
import { useShellStore } from "./store";
import { shownStrip, stripRoundHeight } from "./strip";
import { VoiceNotice } from "./VoiceNotice";
import { WorkSetupNotice } from "./WorkSetupNotice";

/** Prompt lives on the window overlay, so its cap is the window minus
 *  occupied rails, not the stage's `cqw`. */
const PROMPT_WIDTH = `min(${CARD_SIZES.regular}px, calc(100vw - var(--occupied-rail-left, 0px) - var(--occupied-rail-right, 0px) - 2 * var(--space-4)))`;

/**
 * A key hint as a sentence writes it: a letter pressed with no modifier, the
 * one chord `chordLabel` draws as a lone capital, stays as it is typed
 * (`press i`, `press ⌃X m`), since a capital in a sentence reads as Shift.
 */
function typedKeys(keys: string): string {
  return keys.replace(/(?<=^| )[A-Z](?= |$)/g, (letter) => letter.toLowerCase());
}

/**
 * The input's hint - transcription status, the gated line, the return key,
 * the first-run hint, or the standard one - fullest form first, then the
 * shorter form a narrow input shows.
 */
export function inputPlaceholder(input: {
  firstRun: FirstRunView | null;
  voiceSupported: boolean | null;
  dictation?: DictationSettings | null;
  transcribing: boolean;
  returnToMessageKey?: string;
}): readonly string[] {
  if (input.transcribing) return [m.shellPromptTranscribing(), m.shellPromptTranscribingShort()];
  if (input.firstRun?.gateOpen)
    return [input.firstRun.freshCheck ? GATED_CHECK_PLACEHOLDER : GATED_PLACEHOLDER];
  if (input.returnToMessageKey)
    return [m.shellPromptReturnToMessage({ key: typedKeys(input.returnToMessageKey) })];
  const noVoice =
    input.voiceSupported === false ||
    input.dictation === null ||
    input.dictation?.enabled === false;
  const typeOnly = [STANDARD_PLACEHOLDER_NO_VOICE, STANDARD_PLACEHOLDER_NO_VOICE_SHORT];
  if (input.dictation?.enabled === false) return typeOnly;
  const desktop = thisDesktop();
  const key = dictationKeyLabel(input.dictation?.key ?? desktop.dictationKey, desktop.keys);
  const withKey = (hint: string) => withDictationKey(hint, key);
  if (input.firstRun && isFirstRunHint(input.firstRun)) {
    return noVoice
      ? [FIRST_RUN_PLACEHOLDER_NO_VOICE]
      : [
          withKey(FIRST_RUN_PLACEHOLDER),
          withKey(FIRST_RUN_PLACEHOLDER_SHORT),
          FIRST_RUN_PLACEHOLDER_NO_VOICE,
        ];
  }
  return noVoice
    ? typeOnly
    : [
        withKey(STANDARD_PLACEHOLDER),
        withKey(STANDARD_PLACEHOLDER_SHORT),
        withKey(STANDARD_PLACEHOLDER_SHORTEST),
      ];
}

/**
 * The input's room between the docked rails (docs/renderer.md, "Docked rails
 * and the input's room"): where they would leave it narrower than
 * `PROMPT_MIN_WIDTH`, they fold for it as they do for a card, with no card
 * up too, and come back once the window or a smaller Size gives the room
 * back. It reads what the rails ask for, never what they take, so the fold
 * cannot undo itself; it is its own component, so typing never re-reads it.
 */
const PromptRoom = memo(function PromptRoom() {
  const layout = useShellLayout();
  const folds = promptFoldsRails(layout.windowWidth, layout.left, layout.right);
  useLayoutEffect(() => {
    foldRails("prompt", folds);
    return () => foldRails("prompt", false);
  }, [folds]);
  return null;
});

/** Prompt, window-centred, painted above the stage so it stays clickable. */
export const HomePrompt = memo(function HomePrompt() {
  const [focused, setFocused] = useState(false);
  const { bindings } = useInstalledKeymap();
  const messageKeys = useCommandKeys("focus.main-message");
  const inputText = useShellStore((s) => s.inputText);
  const setInputText = useShellStore((s) => s.setInputText);
  const setInputCaret = useShellStore((s) => s.setInputCaret);
  const keystroke = useShellStore((s) => s.keystroke);
  const abandonRecording = useShellStore((s) => s.abandonRecording);
  const acceptRecording = useShellStore((s) => s.acceptRecording);
  const submit = useShellStore((s) => s.submit);
  const attachments = useShellStore((s) => s.attachments);
  const attachImages = useShellStore((s) => s.attachImages);
  const removeAttachment = useShellStore((s) => s.removeAttachment);
  const pastes = useShellStore((s) => s.pastes);
  const attachPastedText = useShellStore((s) => s.attachPastedText);
  const removePaste = useShellStore((s) => s.removePaste);
  const recallLastSent = useShellStore((s) => s.recallLastSent);
  const showComposerNotice = useShellStore((s) => s.showComposerNotice);
  const dictation = useShellStore((s) => s.dictation);
  const voiceSupported = useShellStore((s) => s.voiceSupported);
  // Another field's recording is drawn at that field (docs/composer.md, "Voice").
  const transcribing = useShellStore((s) => s.transcribing && s.voiceField === null);
  const firstRun = useShellStore((s) => s.firstRun);
  const held = useShellStore(mainInputHeld);
  const view = useShellStore((s) => s.view);
  const recording = useShellStore((s) => s.recording);
  const recordingHere = useShellStore(recordingIntoMain);
  const gateOpen = firstRun?.gateOpen === true;
  // The last turn above the input takes room the stage gives it the way it
  // gives the composer's growth (./promptGeometry `lastTurnRise`): two
  // rounds, or only the newest while a card is up (./LastTurn).
  const cardUp = useCardUp();
  // The rounds' heights as one value, so the lane reads again only when they change.
  const lastTurnHeights = useShellStore((s) =>
    shownStrip(s, cardUp).map(stripRoundHeight).join(","),
  );
  const heights = lastTurnHeights ? lastTurnHeights.split(",").map(Number) : [];
  const laneRise = lastTurnRise(heights);
  const lane = lastTurnLane(heights);
  // The whole lane, for what sits above the input and must clear it (the gate).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--last-turn-lane", `${lane}px`);
    return () => {
      root.style.removeProperty("--last-turn-lane");
    };
  }, [lane]);

  const focusRequest = useShellStore((s) => s.focusRequest);
  const focusCaret = useShellStore((s) => s.focusCaret);
  const focusYields = useShellStore((s) => s.focusYields);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Files given to the main input: bound to it by key, so a result that
  // lands late is still this draft's and never another input's.
  const fileDestination = useMemo(
    () =>
      mainDestination(
        () => inputRef.current,
        () => mainInputHeld(useShellStore.getState()),
      ),
    [],
  );
  const fileIntake = useFileIntake(fileDestination);
  const focusHandled = useRef(0);
  useEffect(() => {
    // Each request is consumed exactly once, at the moment it fires: a
    // later view or recording change must not replay a stale focus steal
    // (returning from Settings uses the shared lost-focus fallback).
    if (focusRequest === focusHandled.current) return;
    focusHandled.current = focusRequest;
    if (view === "home" && !recording) {
      // A way back gives way to a control that took focus in this render,
      // such as a control reached by a command from search, and to
      // command search opened again before the way back ran.
      if (
        focusYields === focusRequest &&
        (focusTakenElsewhere() || useShellStore.getState().commandSearchOpen)
      )
        return;
      const input = inputRef.current;
      input?.focus();
      // A transcript, a recalled turn or an inlined paste places the caret
      // after React renders the text; a card closing keeps the selection.
      if (input && focusCaret?.request === focusRequest) {
        input.setSelectionRange(focusCaret.at, focusCaret.at);
      }
    }
  }, [focusRequest, focusCaret, focusYields, view, recording]);

  // The input grows upward, never over the Firstmate's frame.
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const measure = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Its growth, and the last turn's room above it, are published as
  // `--prompt-rise` on the document, never through the store, so a new line
  // never re-renders the stage: the Firstmate, the card and the card's
  // height cap read the variable. The growth alone is `--prompt-growth`,
  // which a rail ending above the input follows (design/styles.css).
  const shellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = document.documentElement;
    const publish = () => {
      const oneLine = Number.parseFloat(getComputedStyle(shell).minHeight) || 0;
      const growth = Math.max(0, shell.getBoundingClientRect().height - oneLine);
      root.style.setProperty("--prompt-growth", `${growth}px`);
      root.style.setProperty("--prompt-rise", `${growth + laneRise}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(shell);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--prompt-growth");
      root.style.removeProperty("--prompt-rise");
    };
  }, [laneRise]);

  // What the input's foot stands on (./promptFoot): it comes down only as
  // far as the notices under it let it, including a long refusal, so none is
  // cut off, and never over a collapsed panel header it shares columns with
  // (`--prompt-floor`, design/styles.css): with no card up it stands on the
  // header, and while a card is up the header steps aside. A foot the
  // headers lift takes the composer's growth down with it, so its top stays
  // clear of the Firstmate's frame.
  const dockRef = useRef<HTMLDivElement>(null);
  const noticesRef = useRef<HTMLDivElement>(null);
  const footLift = usePromptFoot(dockRef, noticesRef);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <PromptRoom />
      <div
        ref={dockRef}
        data-prompt-dock=""
        data-voice-transcribing={transcribing ? "true" : "false"}
        // One of the window's parts F6 moves between (./regions.ts).
        data-window-region="main-message"
        style={{
          position: "absolute",
          left: "50%",
          // Pinned by its bottom: the input grows upward, and the notices
          // below hang in their own container, so neither moves its foot.
          // It is `--space-9` above the floor, less in a short window, and
          // clear of the collapsed panel headers under it.
          bottom: "var(--prompt-floor)",
          transform: "translateX(-50%)",
          width: PROMPT_WIDTH,
          pointerEvents: "auto",
        }}
      >
        <div
          data-last-turn-slot=""
          // The last turn rides just above the input's top edge, in its own
          // slot: a bubble appearing or changing never moves the input.
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "100%",
            pointerEvents: "none",
          }}
        >
          <LastTurn />
        </div>
        <VoiceInput
          mode={recordingHere ? "recording" : "idle"}
          width="100%"
          value={inputText}
          disabled={held}
          // Only the gate dims the pill. Before the first read the input
          // takes nothing at full strength, so a ready launch never fades in.
          style={held && !gateOpen ? { opacity: 1 } : undefined}
          onFocusChange={setFocused}
          keybindHint={inputPlaceholder({
            firstRun,
            voiceSupported,
            dictation,
            transcribing,
            returnToMessageKey:
              !focused && !held && hasNotTypingKeys(bindings) ? messageKeys.keys : undefined,
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
          onChange={(e) => setInputText(e.target.value)}
          onKeystroke={keystroke}
          onAbandon={abandonRecording}
          onAccept={() => acceptRecording()}
          onSubmit={submit}
          inputRef={inputRef}
          shellRef={shellRef}
          maxHeight={promptShellMax(windowHeight) - laneRise - footLift}
        />
      </div>
      <div
        ref={noticesRef}
        data-prompt-notices=""
        style={{
          position: "absolute",
          left: "50%",
          top: "calc(100% - var(--prompt-floor))",
          paddingTop: 10,
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          pointerEvents: "auto",
        }}
      >
        <ComposerNotice width={PROMPT_WIDTH} />
        <VoiceNotice width={PROMPT_WIDTH} />
        <DiagnosticsNotice width={PROMPT_WIDTH} />
        <WorkSetupNotice width={PROMPT_WIDTH} />
      </div>
    </div>
  );
});
