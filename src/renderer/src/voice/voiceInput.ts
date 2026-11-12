import { type RecognizerPlace, WHISPER_SAMPLE_RATE } from "@shared/voiceRecognizer";

/** The sample rate Whisper expects: 16kHz mono (hi-bit's pipeline). */
export const VOICE_SAMPLE_RATE = WHISPER_SAMPLE_RATE;

/**
 * Whether this device can run local voice input: the microphone-capture
 * APIs, plus a graphics card wherever the model runs. The voice helper brings
 * its own, and a computer with none for speech has no place at all; the
 * in-window recognizer needs the window's adapter (the Whisper model is far
 * too slow without one, so a missing card or adapter means "hide the feature
 * entirely" - hi-bit's answer, decision in section 8). Pure capability check
 * - never throws.
 */
export async function detectVoiceSupport(place: RecognizerPlace): Promise<boolean> {
  try {
    if (place === "none") return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    if (typeof AudioContext === "undefined") return false;
    if (!("audioWorklet" in AudioContext.prototype)) return false;
    if (place === "helper") return true;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } })
      .gpu;
    if (!gpu?.requestAdapter) return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

/**
 * Resamples mono PCM from `inputRate` to `outputRate` with linear
 * interpolation. Good enough for speech recognition and dependency-free.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Concatenates captured PCM frames into one contiguous Float32Array. */
export function mergeFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Merges raw capture frames and resamples to the 16kHz mono Whisper expects. */
export function framesToMono16k(frames: Float32Array[], inputRate: number): Float32Array {
  return resampleLinear(mergeFloat32(frames), inputRate, VOICE_SAMPLE_RATE);
}

/**
 * Whether a clip is effectively silent (RMS below `threshold`) - used to
 * skip transcribing an accidental tap or empty room, which Whisper would
 * otherwise "hear" as a stock phrase.
 */
export function isAudioSilent(samples: Float32Array, threshold = 0.006): boolean {
  if (samples.length === 0) return true;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length) < threshold;
}

/**
 * Whisper hallucinates stock phrases on silence/noise. Drop the output only
 * when the entire transcript is one of these, so genuinely saying "thank
 * you" mid-sentence still goes through. Letters of every script count, so a
 * transcript in Chinese, Japanese or Korean is never read as the empty one
 * (INF-608).
 */
// i18n-exempt: not shown (transcripts compared, never shown)
const STOCK_HALLUCINATIONS = new Set([
  "",
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "subscribe",
  "bye",
  "bye bye",
  "okay",
  "ok",
  "music",
  "applause",
  "blank audio",
  "blankaudio",
]);

export function isLikelyHallucination(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return STOCK_HALLUCINATIONS.has(normalized);
}

const OPENING = /[\s([{]/;
const CLOSING = /[\s.,;:!?)\]}]/;

/**
 * Puts a fresh voice transcript into the draft at the caret (docs/composer.md,
 * "Voice"): a space before it only when the character before is not already
 * a space, an opening bracket or the start, and a space after it only when
 * the next character is not a space or closing punctuation - so the captain
 * can keep typing or dictate again. Returns the new draft and the caret
 * right after what was inserted. A caret past the draft (or none) is its end.
 */
export function insertVoiceTranscript(
  current: string,
  caret: number | null,
  transcript: string,
): { text: string; caret: number } {
  const at = caret === null ? current.length : Math.min(Math.max(0, caret), current.length);
  const words = transcript.trim();
  if (!words) return { text: current, caret: at };
  const before = current.slice(0, at);
  const after = current.slice(at);
  const lead = before === "" || OPENING.test(before.slice(-1)) ? "" : " ";
  const trail = after !== "" && CLOSING.test(after[0] ?? "") ? "" : " ";
  const inserted = `${lead}${words}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: at + inserted.length };
}
