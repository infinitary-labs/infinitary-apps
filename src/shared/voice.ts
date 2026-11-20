import { z } from "zod";

/** Progress while the local voice (Whisper) model downloads on first use. */
export const voiceDownloadProgressSchema = z.object({
  /** The model file currently downloading, relative to the model dir. */
  file: z.string(),
  /** 0-based index of the file among the ones that needed downloading. */
  fileIndex: z.number(),
  /** How many files needed downloading this run. */
  fileCount: z.number(),
  /** Overall fraction across all files this run, 0..1. */
  fraction: z.number(),
});
export type VoiceDownloadProgress = z.infer<typeof voiceDownloadProgressSchema>;

export const voiceStatusSchema = z.object({
  /** Whether the local voice model is fully present on disk. */
  modelReady: z.boolean(),
  /** Whether no hold to talk has asked for the microphone on this profile yet. */
  firstUse: z.boolean(),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

/**
 * Whether macOS lets this app use the microphone, read without asking:
 * `not-determined` until macOS has asked, `restricted` when the Mac's
 * administrator decides, and `unknown` where the system keeps no such
 * switch. The line under the input explains it (docs/composer.md, "Voice").
 */
export const micAccessSchema = z.enum([
  "not-determined",
  "granted",
  "denied",
  "restricted",
  "unknown",
]);
export type MicAccess = z.infer<typeof micAccessSchema>;

/**
 * Where this computer transcribes (docs/architecture.md section 8, "Where
 * speech runs"): `helper` is the voice helper, a process of its own; `window`
 * is a worker in the window, where the helper cannot run; `none` is a
 * computer with no graphics card for speech, so dictation hides.
 */
export const recognizerPlaceSchema = z.enum(["helper", "window", "none"]);
export type RecognizerPlace = z.infer<typeof recognizerPlaceSchema>;

/**
 * The longest recording the voice helper takes: the capture ceiling
 * (120 s, `micRecorder.ts`) and its pre-roll at 16 kHz, with room to spare.
 */
export const VOICE_CLIP_MAX_SAMPLES = 130 * 16_000;

/** One recording on its way to the voice helper: 16 kHz mono PCM. */
export const voiceClipSchema = z
  .instanceof(Float32Array)
  .refine((clip) => clip.length <= VOICE_CLIP_MAX_SAMPLES, "The recording is too long.");
