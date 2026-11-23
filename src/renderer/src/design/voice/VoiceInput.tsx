import { fileSizeWords } from "@shared/attachments";
import { CONVERSE_TEXT_MAX_CHARS } from "@shared/cards";
import {
  type ComposerHint,
  composerHint,
  composeTurnText,
  FILE_WORDS,
  limitBand,
  lineCount,
  normalizeLineEndings,
  PASTED_TEXT_WORDS,
  type PastedText,
} from "@shared/composer";
import * as m from "@shared/i18n/messages.generated";
import { cutText } from "@shared/textCut";
import type React from "react";
import { useCallback, useId, useRef, useState } from "react";
import { useAnimationLoop } from "../../character/motion";
import { readLiveVoiceLevel } from "../../voice/liveVoiceLevel";
import {
  ComposerCount,
  ComposerCountAnnouncer,
  ComposerField,
  type ImageAttachment,
} from "../core/ComposerField";
import { thisDesktop } from "../core/desktop";
import {
  AddFilesButton,
  type FileIntake,
  FilesStatus,
  PendingFileChips,
  useFileDrop,
} from "../core/FileControls";
import { fixedKeys } from "../core/fixedKeys";
import { IconButton } from "../core/IconButton";
import { KeyCap } from "../core/KeyCap";

const vicoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const VIco = {
  x: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...vicoS} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...vicoS} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  up: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...vicoS} aria-hidden="true">
      <path d="m5 12 7-7 7 7M12 19V5" />
    </svg>
  ),
};

function Waveform({ level = 0.6, height = 28 }: { level?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  const widthRef = useRef(0);
  const accentRef = useRef({ accent: "", lastRead: 0 });

  useAnimationLoop((now) => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const theme = accentRef.current;
    if (theme.lastRead === 0 || now - theme.lastRead > 400) {
      theme.accent = (getComputedStyle(canvas).getPropertyValue("--accent") || theme.accent).trim();
      theme.lastRead = now;
    }
    const cw = canvas.clientWidth;
    if (cw !== widthRef.current) {
      widthRef.current = cw;
      canvas.width = cw * dpr;
      canvas.height = height * dpr;
    }
    const w = widthRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const n = Math.floor(w / 5);
    ctx.fillStyle = theme.accent;
    for (let i = 0; i < n; i++) {
      const ph = now / 180 + i * 0.9;
      // Taper at both ends.
      const env = Math.exp(-(((i - n / 2) / (n / 2.6)) ** 2));
      const h = Math.max(
        2,
        (Math.sin(ph) * 0.5 + 0.5) *
          (0.3 + 0.7 * readLiveVoiceLevel(levelRef.current)) *
          height *
          env,
      );
      ctx.globalAlpha = 0.4 + 0.6 * env;
      ctx.fillRect(i * 5, (height - h) / 2, 2.5, h);
    }
  }, height);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={m.uiVoiceLevel()}
      style={{ width: "100%", height, display: "block" }}
    />
  );
}

/** The dictation mark's one row: its buttons, and its line while the words come back. */
const MARK_HEIGHT = 28;

/**
 * The dictation mark under a field other than the main input while the
 * dictation key records into it (design skill `components/voice/
 * VoiceInput.prompt.md`, "Dictating into another field"): abandon, the
 * waveform and accept while it records, then the transcribing line in the
 * same row until its words land; nothing otherwise.
 */
export function DictationMark({
  recording,
  transcribing,
  onAbandon,
  onAccept,
}: {
  recording: boolean;
  transcribing: boolean;
  onAbandon: () => void;
  onAccept: () => void;
}) {
  if (!recording && !transcribing) return null;
  return (
    <div
      data-dictation-mark={recording ? "recording" : "transcribing"}
      style={{ display: "flex", alignItems: "center", gap: ROW_GAP, height: MARK_HEIGHT }}
    >
      {recording ? (
        <>
          <IconButton
            label={m.uiVoiceAbandon()}
            tone="danger"
            size={MARK_HEIGHT}
            {...fixedKeys("Escape")}
            onClick={onAbandon}
          >
            {VIco.x}
          </IconButton>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Waveform height={24} />
          </div>
          <IconButton label={m.uiVoiceAccept()} tone="ok" size={MARK_HEIGHT} onClick={onAccept}>
            {VIco.check}
          </IconButton>
        </>
      ) : (
        <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          {m.shellPromptTranscribing()}
        </span>
      )}
    </div>
  );
}

export type VoiceInputMode = "idle" | "recording";

export type VoiceInputProps = {
  mode?: VoiceInputMode;
  /**
   * The empty field's centered hint. A list is one hint's forms, fullest
   * first: the field shows the first that fits its one line, else the last.
   */
  keybindHint?: string | readonly string[];
  /**
   * The gated state (docs/first-launch.md): nothing can be typed or
   * submitted, the pill dims, and the hint says why. Hold-to-talk is the
   * host's to ignore in the same state.
   */
  disabled?: boolean;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  /** 0-1 live voice level driving the waveform. */
  level?: number;
  onAbandon?: () => void;
  onAccept?: () => void;
  onSubmit?: () => void;
  onFocusChange?: (focused: boolean) => void;
  onKeystroke?: () => void;
  width?: number | string;
  style?: React.CSSProperties;
  /** Optional ref to the underlying field for explicit focus after card dismiss. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** The shell, for a host that publishes its growth (`--prompt-rise`). */
  shellRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * The tallest the shell may grow, in px (the host keeps it clear of the
   * Firstmate's frame). The field also stops at 8 lines, then scrolls.
   */
  maxHeight?: number;
  attachments?: Array<{ id: string; preview: string; name?: string }>;
  onAttach?: (items: ImageAttachment[]) => void;
  /** A pasted picture over the size cap, which is never attached. */
  onPictureTooBig?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Long pastes held as chips (`shouldChip`); their preview and file pointer ride the turn. */
  pastes?: PastedText[];
  /** A paste long enough to become a chip, exact clipboard text. */
  onPasteText?: (text: string) => void;
  onRemovePaste?: (id: string) => void;
  /** Where the caret is, reported as it moves, so a transcript lands there. */
  onCaretChange?: (caret: number) => void;
  /** Up in an empty field: bring back the last message sent. */
  onRecall?: () => void;
  /** Dropping and choosing files (`docs/composer.md`, "Files"); absent, the input takes none. */
  files?: FileIntake;
};

/** The field stops growing here and scrolls inside (design skill, "Shape"). */
const LINE_CAP = 8;
/** The send control's size and its gap: the column the text keeps clear. */
const SEND_SIZE = 32;
const ROW_GAP = 10;
const FIELD_PAD = 8;

function firstWords(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function HintLine({ id, hint }: { id: string; hint: ComposerHint }) {
  return (
    <span
      id={id}
      data-voice-input-hint={hint}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "var(--space-1)",
        padding: `0 ${FIELD_PAD}px`,
        fontSize: "var(--text-sm)",
        color: hint === "too-long" ? "var(--fg-2)" : "var(--fg-3)",
      }}
    >
      {composerHint(hint, thisDesktop().keys).map((part, i) =>
        "key" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, never reordered
          <KeyCap key={i}>{part.key}</KeyCap>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, never reordered
          <span key={i}>{part.words}</span>
        ),
      )}
    </span>
  );
}

const chipStyle: React.CSSProperties = {
  display: "flex",
  flex: "0 0 auto",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-1)",
  borderRadius: "var(--radius-s)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  fontSize: "var(--text-xs)",
};

export function PastedTextChip({ paste, onRemove }: { paste: PastedText; onRemove: () => void }) {
  const lines = lineCount(normalizeLineEndings(paste.text));
  const bytes = new TextEncoder().encode(paste.text).length;
  return (
    <div data-voice-input-paste="" style={chipStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          textAlign: "start",
          cursor: "default",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            width: "var(--space-6)",
            height: "var(--space-6)",
            boxSizing: "border-box",
            padding: 3,
            clipPath: "polygon(0 0, 75% 0, 100% 25%, 100% 100%, 0 100%)",
            overflow: "hidden",
            borderRadius: "var(--radius-xs)",
            background: "var(--bg-3)",
            fontFamily: "var(--font-mono)",
            fontSize: 4,
            lineHeight: 1.25,
            color: "var(--fg-3)",
            whiteSpace: "pre",
          }}
        >
          {cutText(paste.text, 240)}
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              maxWidth: "calc(2 * var(--space-9))",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--fg-1)",
            }}
          >
            {paste.name ?? firstWords(paste.text)}
          </span>
          <span style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
            {paste.name
              ? `${fileSizeWords(bytes)} · ${FILE_WORDS.ready}`
              : PASTED_TEXT_WORDS.meta(lines, bytes)}
          </span>
        </span>
      </div>
      <IconButton label={PASTED_TEXT_WORDS.remove(lines, paste.name)} onClick={onRemove}>
        {VIco.x}
      </IconButton>
    </div>
  );
}

/**
 * The composer (design skill `components/voice/VoiceInput.prompt.md`;
 * `docs/composer.md`): a pill at one line that grows upward, one line at a
 * time, into a rounded rectangle. Rows top to bottom: the chips, the text,
 * and the foot row once the draft is multi-line or recording.
 */
export function VoiceInput({
  mode = "idle",
  keybindHint = m.uiVoiceHint(),
  disabled = false,
  value,
  onChange,
  level = 0.6,
  onAbandon,
  onAccept,
  onSubmit,
  onFocusChange,
  onKeystroke,
  width = 560,
  style,
  inputRef,
  shellRef,
  maxHeight,
  attachments = [],
  onAttach,
  onPictureTooBig,
  onRemoveAttachment,
  onPaste,
  pastes = [],
  onPasteText,
  onRemovePaste,
  onCaretChange,
  onRecall,
  files,
}: VoiceInputProps) {
  const recording = mode === "recording";
  const text = value ?? "";
  const [focus, setFocus] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [inFence, setInFence] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const shellEl = useRef<HTMLDivElement | null>(null);

  // What would leave on send: the typed words, trimmed; file context does not count.
  // Whitespace alone is nothing to send.
  const length = composeTurnText(text, []).length;
  const preparing = (files?.pending.length ?? 0) > 0;
  const sendable = (length > 0 || attachments.length > 0 || pastes.length > 0) && !preparing;
  const over = limitBand(length, CONVERSE_TEXT_MAX_CHARS) === "over";
  const hasChips = attachments.length > 0 || pastes.length > 0 || preparing;
  const drop = useFileDrop(files);
  const multiLine = text.includes("\n") || wrapped || hasChips;
  const foot = multiLine || recording;
  // Recording from an empty field is the one-row waveform pill.
  const showText = !(recording && text === "");
  const hint: ComposerHint = over ? "too-long" : inFence ? "fence" : "keys";

  // Stable, so React never detaches them between commits: the field
  // measures the shell in its own layout effect, which runs before a
  // re-attached parent ref would be set again.
  const setField = useCallback(
    (field: HTMLTextAreaElement | null) => {
      fieldRef.current = field;
      if (inputRef) inputRef.current = field;
    },
    [inputRef],
  );
  const setShell = useCallback(
    (shell: HTMLDivElement | null) => {
      shellEl.current = shell;
      if (shellRef) shellRef.current = shell;
    },
    [shellRef],
  );

  const send = (
    <IconButton
      label={m.uiVoiceSubmit()}
      tone="accent"
      {...fixedKeys("Enter")}
      aria-disabled={over || undefined}
      onClick={() => {
        if (!over) onSubmit?.();
      }}
      style={{
        flexShrink: 0,
        background: "var(--accent-dim)",
        ...(over ? { opacity: 0.4, cursor: "default" } : {}),
      }}
    >
      {VIco.up}
    </IconButton>
  );

  const shell: React.CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    width,
    boxSizing: "border-box",
    minHeight: "var(--prompt-height)",
    padding: `0 ${ROW_GAP}px`,
    borderRadius: "var(--prompt-radius)",
    // Clear over the window material (docs/translucent-window.md): the
    // hairline is the shell, the tint behind it the surface.
    background: "transparent",
    border: `1px solid ${drop.over ? "var(--accent)" : recording || focus ? "var(--line-2)" : "var(--line-1)"}`,
    boxShadow:
      recording || drop.over
        ? "var(--glow-accent)"
        : focus
          ? "var(--focus-ring)"
          : "var(--shadow-1)",
    opacity: disabled ? 0.45 : 1,
    transition:
      "border-color var(--dur-med) var(--ease-out),box-shadow var(--dur-med) var(--ease-out),opacity var(--dur-slow) var(--ease-out)",
    ...style,
  };

  // Plain click focuses the field for typing; voice activation is
  // keybind-only (the host wires the key, never click).
  return (
    <div
      ref={setShell}
      style={shell}
      data-voice-input-shell=""
      data-voice-input-mode={mode}
      data-voice-input-disabled={disabled ? "" : undefined}
      data-file-drop={drop.over ? "over" : files ? "ready" : undefined}
      {...drop.handlers}
    >
      {hasChips && (
        <div
          data-voice-input-chips=""
          style={{
            display: "flex",
            gap: "var(--space-2)",
            paddingTop: "var(--space-2)",
            overflowX: "auto",
          }}
        >
          {attachments.map((att) => {
            const name = att.name || m.uiVoiceImage();
            return (
              <div key={att.id} data-voice-input-attachment="" style={chipStyle}>
                <img
                  src={att.preview}
                  alt=""
                  style={{
                    width: "var(--space-6)",
                    height: "var(--space-6)",
                    objectFit: "cover",
                    borderRadius: "var(--radius-xs)",
                  }}
                />
                <span
                  style={{
                    maxWidth: "var(--space-9)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </span>
                <IconButton
                  label={m.uiVoiceRemove({ name })}
                  onClick={() => onRemoveAttachment?.(att.id)}
                >
                  {VIco.x}
                </IconButton>
              </div>
            );
          })}
          {pastes.map((paste) => (
            <PastedTextChip
              key={paste.id}
              paste={paste}
              onRemove={() => onRemovePaste?.(paste.id)}
            />
          ))}
          {files && <PendingFileChips intake={files} />}
        </div>
      )}
      <div
        data-voice-input-text=""
        style={{
          display: showText ? "flex" : "none",
          alignItems: "center",
          gap: ROW_GAP,
          flex: "1 0 auto",
          padding: "var(--space-3) 0",
        }}
      >
        {files && !recording && !disabled ? (
          // Held to the line's height, so the one-line pill never grows.
          <span style={{ display: "flex", margin: "calc(-1 * var(--space-1)) 0" }}>
            <AddFilesButton intake={files} />
          </span>
        ) : null}
        <ComposerField
          fieldRef={setField}
          id={inputId}
          name="task-prompt"
          aria-label={m.uiVoiceTaskPrompt()}
          aria-describedby={foot && !recording ? hintId : undefined}
          messageField="main-message"
          disabled={disabled}
          value={text}
          onChange={onChange}
          lineCap={LINE_CAP}
          frame={shellEl}
          frameMaxHeight={maxHeight}
          recording={recording}
          canSend={sendable && !over && !disabled}
          onSend={onSubmit}
          onKeystroke={onKeystroke}
          onRecall={hasChips ? undefined : onRecall}
          onPaste={onPaste}
          onAttach={onAttach}
          onPictureTooBig={onPictureTooBig}
          onPasteText={onPasteText}
          onCaretChange={onCaretChange}
          onWrapChange={setWrapped}
          onFenceChange={setInFence}
          onFocus={() => {
            setFocus(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setFocus(false);
            onFocusChange?.(false);
          }}
          placeholder={keybindHint}
          data-voice-input-field=""
          style={{
            flex: 1,
            fontSize: "var(--text-md)",
            lineHeight: "var(--leading-body)",
            // The text keeps the send control's column clear at every
            // height, so no line re-wraps when the control moves down. Empty
            // beside Add files (the send control's size), it clears the same
            // width on the right, so the placeholder centers on the input.
            padding: `0 ${foot || (files && !disabled && text === "") ? FIELD_PAD + SEND_SIZE + ROW_GAP : FIELD_PAD}px 0 ${FIELD_PAD}px`,
            opacity: recording ? 0.55 : 1,
            transition: "opacity var(--dur-med) var(--ease-out)",
          }}
        />
        {!foot && !disabled && sendable ? (
          // Held to the line's height, so the one-line pill never grows.
          <span style={{ display: "flex", margin: "calc(-1 * var(--space-1)) 0" }}>{send}</span>
        ) : null}
      </div>
      {foot && (
        <div
          data-voice-input-foot=""
          style={{
            display: "flex",
            alignItems: "center",
            gap: ROW_GAP,
            // Alone (recording from an empty field) it fills the pill.
            ...(showText ? { paddingBottom: "var(--space-2)" } : { flex: "1 0 auto" }),
          }}
        >
          {recording ? (
            <>
              <IconButton
                label={m.uiVoiceAbandon()}
                tone="danger"
                {...fixedKeys("Escape")}
                onClick={onAbandon}
              >
                {VIco.x}
              </IconButton>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Waveform level={level} />
              </div>
              <IconButton label={m.uiVoiceAccept()} tone="ok" onClick={onAccept}>
                {VIco.check}
              </IconButton>
              <IconButton
                label={m.uiVoiceSubmit()}
                tone="accent"
                onClick={onSubmit}
                style={{ background: "var(--accent-dim)" }}
              >
                {VIco.up}
              </IconButton>
            </>
          ) : (
            <>
              <HintLine id={hintId} hint={hint} />
              <ComposerCount length={length} max={CONVERSE_TEXT_MAX_CHARS} />
              {!disabled && sendable ? send : null}
            </>
          )}
        </div>
      )}
      <ComposerCountAnnouncer length={length} max={CONVERSE_TEXT_MAX_CHARS} />
      <FilesStatus intake={files} />
    </div>
  );
}
