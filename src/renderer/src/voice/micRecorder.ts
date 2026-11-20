import captureWorkletUrl from "./captureWorklet.js?url";
import type { PcmClip } from "./pcm.worker";
import { ClipPreparer } from "./prepareClip";

// One silent audio context per window session. No speaker device query at each start.
let captureContext: Promise<AudioContext> | null = null;
function getCaptureContext(): Promise<AudioContext> {
  if (captureContext) return captureContext;
  const ctx = new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions);
  captureContext = ctx.audioWorklet
    .addModule(captureWorkletUrl)
    .then(() => ctx)
    .catch((error) => {
      captureContext = null;
      void ctx.close().catch(() => {});
      throw error;
    });
  return captureContext;
}

/**
 * How much audio to keep buffered before capture officially starts, so a
 * user who begins talking a moment before the key registers doesn't lose
 * their first word.
 */
const PRE_ROLL_MS = 300;

/**
 * Hard ceiling on a single capture, in seconds - a runaway guard for a key
 * left held, not a conversational limit. When hit, capture stops and
 * `onLimitReached` fires so the owner can transcribe what was gathered.
 */
const MAX_CAPTURE_SECONDS = 120;

/**
 * Continuous microphone capture for hold-to-talk. Opens
 * the mic once and keeps a short rolling pre-roll buffer of raw PCM;
 * `beginCapture`/`endCapture` bracket the utterance and prepend the
 * pre-roll. Capture runs in an AudioWorklet on the audio thread so a busy
 * main thread cannot drop samples; frames arrive as Float32 PCM. Audio
 * lives only in these in-memory buffers and is discarded after
 * transcription - it never touches disk (decision D-13).
 */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private clipPreparer: ClipPreparer | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  // Only sample counts stay here for the capture ceiling; PCM belongs to the worker.
  private preRoll: number[] = [];
  private preRollSamples = 0;
  private maxPreRoll = 0;
  private capturing = false;
  private capturedSamples = 0;
  private maxCaptureSamples = 0;
  private limitFired = false;
  onLimitReached: (() => void) | null = null;

  /** Opens the mic and starts buffering. Returns the analyser for the waveform. */
  async start(): Promise<AnalyserNode> {
    try {
      // Browser DSP on (AEC/NS/AGC) - deliberate for messy real-world audio.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.stream = stream;

      const ctx = await getCaptureContext();
      this.ctx = ctx;
      await ctx.resume().catch(() => {});
      this.maxPreRoll = Math.round((ctx.sampleRate * PRE_ROLL_MS) / 1000);
      this.maxCaptureSamples = Math.round(ctx.sampleRate * MAX_CAPTURE_SECONDS);
      this.clipPreparer = new ClipPreparer(ctx.sampleRate, this.maxPreRoll);

      const source = ctx.createMediaStreamSource(stream);
      this.source = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.analyser = analyser;

      const node = new AudioWorkletNode(ctx, "infinitary-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      node.port.onmessage = (event) => {
        // Transfer ownership immediately; never accumulate a clip-sized buffer list here.
        const frame = event.data as Float32Array;
        const samples = frame.length;
        this.clipPreparer?.push(frame);
        if (this.capturing) {
          this.capturedSamples += samples;
          if (!this.limitFired && this.capturedSamples >= this.maxCaptureSamples) {
            this.limitFired = true;
            this.capturing = false;
            this.onLimitReached?.();
          }
          return;
        }
        this.preRoll.push(samples);
        this.preRollSamples += samples;
        while (this.preRollSamples > this.maxPreRoll && this.preRoll.length > 0) {
          const dropped = this.preRoll.shift();
          if (!dropped) break;
          this.preRollSamples -= dropped;
        }
      };
      source.connect(node);

      // The node must reach the destination to be processed, so route it
      // through a muted gain - the mic is never played back.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
      this.node = node;
      this.sink = sink;

      return analyser;
    } catch (error) {
      // start() acquired the mic but failed partway: release everything so
      // the mic light doesn't stay on.
      this.stop();
      throw error;
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Begins collecting the utterance, seeded with the buffered pre-roll. */
  beginCapture(): void {
    this.clipPreparer?.begin();
    this.capturedSamples = this.preRollSamples;
    this.limitFired = false;
    this.capturing = true;
  }

  /** Stops collecting; prepares 16kHz PCM and the silence gate off the window thread. */
  endCapture(): Promise<PcmClip> {
    this.capturing = false;
    this.capturedSamples = 0;
    // Only sample counts remain on the window thread.
    this.preRoll = [];
    this.preRollSamples = 0;
    const preparer = this.clipPreparer;
    this.clipPreparer = null; // The pending clip now owns this worker.
    if (!preparer) return Promise.reject(new Error("No recording is active."));
    return preparer.prepare();
  }

  /** Tears down the mic and audio graph. Safe to call more than once. */
  stop(): void {
    this.clipPreparer?.close();
    this.clipPreparer = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.sink?.disconnect();
    this.analyser?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.source = null;
    this.node = null;
    this.sink = null;
    this.analyser = null;
    this.ctx = null;
    this.stream = null;
    this.preRoll = [];
    this.preRollSamples = 0;
    this.capturedSamples = 0;
    this.capturing = false;
    this.limitFired = false;
    this.onLimitReached = null;
  }
}
