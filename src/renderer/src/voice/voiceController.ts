import { clearLiveVoiceLevel, setLiveVoiceLevel } from "./liveVoiceLevel";
import { MicRecorder } from "./micRecorder";
import { isLikelyHallucination, VOICE_SAMPLE_RATE } from "./voiceInput";
import { transcribeAudio, warmUpWhisper } from "./whisperClient";

/** Short holds are accidental; tap-to-toggle and explicit controls may finish sooner. */
const MIN_CLIP_SECONDS = 0.4;

/**
 * The voice session: one recorder at a time, opened on key press and
 * torn down on hold release, another tap, or an explicit control. Capture
 * starts before Whisper warm-up so speech is never gated on the model load
 * (capture-before-warm-up ordering). Audio exists only in memory and is
 * discarded after transcription (D-13).
 */
class VoiceController {
  private recorder: MicRecorder | null = null;
  private levelRaf = 0;
  private sessionToken = 0;

  /** Opens the mic and begins capturing; writes live RMS to liveVoiceLevel. */
  async start(onLimit: () => void): Promise<void> {
    const token = ++this.sessionToken;
    const recorder = new MicRecorder();
    recorder.onLimitReached = onLimit;
    const analyser = await recorder.start();
    if (token !== this.sessionToken) {
      recorder.stop();
      return;
    }
    this.recorder = recorder;
    recorder.beginCapture();
    // Warm the model in the background; the worker queues init before any
    // transcribe, so the load overlaps with the user talking.
    void warmUpWhisper().catch(() => {});

    const buffer = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (this.recorder !== recorder) return;
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (const value of buffer) {
        const centered = (value - 128) / 128;
        sumSquares += centered * centered;
      }
      // RMS scaled into a lively 0..1 for the waveform and the character.
      setLiveVoiceLevel(Math.min(1, Math.sqrt(sumSquares / buffer.length) * 4));
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  /**
   * Ends the capture and transcribes. Returns null when the clip was
   * dropped (short hold, silence, or a stock hallucination).
   */
  async finish(held = false): Promise<string | null> {
    // A stop before getUserMedia resolves still cancels the pending start.
    const token = ++this.sessionToken;
    const recorder = this.recorder;
    if (!recorder) return null;
    const clip = recorder.endCapture();
    this.teardown();
    const { samples, silent } = await clip;
    if (token !== this.sessionToken) return null;
    if (held && samples.length < VOICE_SAMPLE_RATE * MIN_CLIP_SECONDS) return null;
    if (silent) return null;
    const text = await transcribeAudio(samples);
    if (token !== this.sessionToken || !text || isLikelyHallucination(text)) return null;
    return text;
  }

  /** Drops the capture without transcribing. */
  abandon(): void {
    this.sessionToken++;
    this.teardown();
  }

  private teardown(): void {
    cancelAnimationFrame(this.levelRaf);
    this.recorder?.stop();
    this.recorder = null;
    clearLiveVoiceLevel();
  }
}

export const voiceController = new VoiceController();
