/**
 * @startingPoint section="Voice" subtitle="The default state of the app: one pill input that grows upward" viewport="700x160"
 */
export interface VoiceInputProps {
  /** idle = the text field (a pill at one line, growing upward to 8 lines); recording = the draft stays, read-only and dimmed, over a foot row of abandon/waveform/accept/submit. */
  mode?: "idle" | "recording";
  /** Centered placeholder. Default "type, or press/hold right ⌥ to talk"; the host picks the first-run or gated line (docs/first-launch.md). */
  keybindHint?: string;
  /** The first-launch gate: the pill dims to 45%, takes no typing, shows no submit; the host ignores hold-to-talk too. */
  disabled?: boolean;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  /** 0–1 voice level driving the waveform. */
  level?: number;
  onActivate?: () => void;
  /** Left end of the pill while recording. */
  onAbandon?: () => void;
  onAccept?: () => void;
  /** Rightmost control while recording. */
  onSubmit?: () => void;
  /** Fired with true/false as the idle input gains/loses focus — hosts use it to put the Firstmate into listening. */
  onFocusChange?: (focused: boolean) => void;
  /** Fired per keydown in the idle input other than Enter. Enter sends (onSubmit) when there is something to send; Shift/left-Option+Enter, or Enter inside an open ``` block, adds a line; Cmd/Ctrl+Enter always sends; an Enter confirming an input-method candidate neither sends nor adds a line. Hosts use it to kick the Firstmate's spin. */
  onKeystroke?: () => void;
  width?: number | string;
  style?: React.CSSProperties;
  /** Compose attachments (images only for v1). Each carries a transient preview data URL for the chip. Host owns the list. */
  attachments?: Array<{ id: string; preview: string; name?: string }>;
  /** Pasted images arrive read: preview data URL for the chip plus the base64 payload and its real mime type. One call per paste, all images together. */
  onAttach?: (items: Array<{ id: string; preview: string; name?: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }>) => void;
  /** A pasted picture over 5 MB, which is never attached; the host says so under the pill. The host also refuses a fifth picture. */
  onPictureTooBig?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Host can wire paste; component stops default for handled image items and for a long paste it turns into a chip. */
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** The app's ref to the field, for focus and caret placement. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** The app's ref to the shell, which it observes to publish `--prompt-rise`. */
  shellRef?: React.RefObject<HTMLDivElement | null>;
  /** The tallest the shell may grow, in px: the host keeps its top clear of the Firstmate's frame. The field also stops at 8 lines, then scrolls. */
  maxHeight?: number;
  /** Long pastes (over 20 lines or 2,000 characters) held as chips in the chip row; their text rides the turn after the typed words. */
  pastes?: Array<{ id: string; text: string; name?: string }>;
  /** A paste long enough to become a chip, line breaks normalized to \n. */
  onPasteText?: (text: string) => void;
  /** The chip body was clicked: put its text in the draft at `caret`. */
  onInlinePaste?: (id: string, caret: number) => void;
  onRemovePaste?: (id: string) => void;
  /** The caret moved; a voice transcript lands where it last was. */
  onCaretChange?: (caret: number) => void;
  /** Up in an empty field (no words, no chips): bring back the last message sent. */
  onRecall?: () => void;
  /** Dropping and choosing files: the host's intake (drop handler, "Add files" picker, files being prepared with Cancel, and a status line a screen reader hears). Absent, the input takes none. */
  files?: {
    onFiles: (files: File[]) => void;
    onPick: () => void;
    pending: ReadonlyArray<{ id: string; name: string }>;
    onCancel: (id: string) => void;
    status: string;
    enabled: boolean;
  };
}
