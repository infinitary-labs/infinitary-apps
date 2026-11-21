import { expect, type Page } from "@playwright/test";

/**
 * Speech for a journey that dictates. The offscreen audio device has no
 * speech, so this supplies PCM frames at the worklet boundary, and the voice
 * helper's model is a stand-in that answers `launchApp`'s `voiceTranscript`.
 * Real key handling, the recording's lifecycle, the trip to the helper
 * process and the words' delivery stay in play.
 */
export async function provideSpeech(page: Page): Promise<void> {
  await page.evaluate(() => {
    const capture = window as unknown as { speechCaptureReady: boolean };
    capture.speechCaptureReady = false;
    const RealWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends RealWorklet {
      private readonly fakeAudioTimer: ReturnType<typeof setInterval>;
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        capture.speechCaptureReady = false;
        let suppliedSamples = 0;
        this.fakeAudioTimer = setInterval(() => {
          if (!this.port.onmessage) return;
          this.port.onmessage(
            new MessageEvent("message", { data: new Float32Array(1024).fill(0.25) }),
          );
          suppliedSamples += 1024;
          // Half a second of supplied PCM, not a wall-clock wait or model-init count.
          capture.speechCaptureReady = suppliedSamples >= context.sampleRate / 2;
        }, 10);
      }
      override disconnect() {
        capture.speechCaptureReady = false;
        clearInterval(this.fakeAudioTimer);
        super.disconnect();
      }
    };
  });
}

/**
 * Returns once the open recording has half a second of supplied PCM, past
 * the shortest clip the window keeps: optimistic controls do not prove the
 * microphone is open.
 */
export async function waitForSpeechCapture(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { speechCaptureReady: boolean }).speechCaptureReady,
      ),
    )
    .toBe(true);
}
