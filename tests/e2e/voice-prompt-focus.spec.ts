import { expect, test } from "@playwright/test";
import { STANDARD_PLACEHOLDER } from "@shared/firstRun";
import { DICTATION_KEY, hintOnThisComputer } from "./dictation";
import { launchApp } from "./launch";
import { latestServedTurn } from "./providerRequest";

// The offscreen audio device has no speech: supply PCM frames at the worklet
// boundary, and the voice helper's model is a stand-in that answers these
// words (launchApp's `voiceTranscript`). Real key handling, recording
// lifecycle, the trip to the helper process, transcript delivery, prompt
// and conversation remain in play.
const TRANSCRIPT = "an ocean of stars";

async function provideSpeech(page: import("@playwright/test").Page) {
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

// Optimistic controls do not prove the mic is open. Own the supplied-audio prerequisite.
async function waitForSpeechCapture(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { speechCaptureReady: boolean }).speechCaptureReady,
      ),
    )
    .toBe(true);
}

test("a transcribed hold and a toggled recording both return focus to the end of the prompt", async () => {
  const app = await launchApp({ withMockProvider: true, voiceTranscript: TRANSCRIPT });
  try {
    const { page } = app;
    await provideSpeech(page);
    const input = page.getByRole("textbox", { name: "Task prompt" });
    await expect(input).toBeEnabled();
    await expect(page.getByPlaceholder(hintOnThisComputer(STANDARD_PLACEHOLDER))).toBeVisible();
    // A held key stops on release. Type a prefix to prove insertion is appended.
    await input.fill("Please describe");
    await page.keyboard.down(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await waitForSpeechCapture(page);
    await page.waitForTimeout(600); // Give the synthetic mic enough audio for a held clip.
    await page.keyboard.up(DICTATION_KEY);
    await expect(input).toHaveValue("Please describe an ocean of stars ");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      "Please describe an ocean of stars ".length,
    );
    await page.screenshot({ path: test.info().outputPath("voice-hold-focused.png") });

    // A quick press latches recording until the next press.
    await page.keyboard.down(DICTATION_KEY);
    await page.keyboard.up(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await waitForSpeechCapture(page);
    await page.waitForTimeout(600);
    await page.keyboard.down(DICTATION_KEY);
    await page.keyboard.up(DICTATION_KEY);
    await expect(input).toHaveValue("Please describe an ocean of stars an ocean of stars ");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      "Please describe an ocean of stars an ocean of stars ".length,
    );
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();

    // The recording UI's Submit control skips the draft and sends directly.
    await page.keyboard.down(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await waitForSpeechCapture(page);
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Submit" }).click();
    await page.keyboard.up(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon" })).toHaveCount(0);
    // The words reach the Firstmate on their own, as the captain's message.
    await expect
      .poll(() =>
        (app.mockProvider?.requestBodies() ?? []).some((body) =>
          latestServedTurn(body)?.segments.some(
            (segment) => segment.kind === "user" && segment.body === `[user]\n${TRANSCRIPT}`,
          ),
        ),
      )
      .toBe(true);
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
  } finally {
    await app.close();
  }
});

test("a transcript lands at the caret mid-draft, and the draft stays on screen while recording", async () => {
  const app = await launchApp({ withMockProvider: true, voiceTranscript: TRANSCRIPT });
  try {
    const { page } = app;
    await provideSpeech(page);
    const input = page.getByRole("textbox", { name: "Task prompt" });
    await expect(input).toBeEnabled();
    // Two lines; the caret goes up to the first and back before "test".
    const draft = "Fix the test\nthen ship it";
    await input.fill(draft);
    await input.press("ArrowUp");
    for (let i = 0; i < "test".length; i++) await input.press("ArrowLeft");
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      "Fix the ".length,
    );

    await page.keyboard.down(DICTATION_KEY);
    await expect(page.getByRole("button", { name: "Abandon" })).toBeVisible();
    await waitForSpeechCapture(page);
    // Recording keeps the draft on screen, read-only.
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(draft);
    await expect(input).not.toBeEditable();
    await page.screenshot({ path: test.info().outputPath("voice-recording-with-draft.png") });
    await page.waitForTimeout(600); // Give the synthetic mic enough audio for a held clip.
    await page.keyboard.up(DICTATION_KEY);

    const landed = "Fix the an ocean of stars test\nthen ship it";
    await expect(input).toHaveValue(landed);
    await expect(input).toBeFocused();
    expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(
      "Fix the an ocean of stars ".length,
    );
  } finally {
    await app.close();
  }
});
