import type { MicAccess } from "@shared/voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceController } from "../voice/voiceController";
import { useShellStore } from "./store";
import { resetShell } from "./storeTestKit";

/** Hold-to-talk (./voice.ts): the microphone access lines under the input. */

describe('microphone access lines under the input (docs/composer.md, "Voice")', () => {
  const state = () => useShellStore.getState();
  /** Lets the access read and the microphone's answer run through. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  let access: MicAccess;
  let micAccess: ReturnType<typeof vi.fn>;
  /** The microphone's open, answered by the test the way macOS answers its prompt. */
  let opening: { resolve: () => void; reject: (error: Error) => void };
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    access = "granted";
    micAccess = vi.fn(async () => ({ access }));
    vi.stubGlobal("window", { infinitary: { voice: { micAccess } } });
    start = vi.spyOn(voiceController, "start").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          opening = { resolve, reject };
        }),
    );
    vi.spyOn(voiceController, "finish").mockResolvedValue(null);
    vi.spyOn(voiceController, "abandon").mockImplementation(() => {});
    useShellStore.setState({
      view: "home",
      recording: false,
      pickingDictationKey: false,
      dictation: { enabled: true, key: "AltRight" },
      voiceSupported: true,
      voiceModelReady: true,
      firstRun: null,
      firstRunSettled: true,
      voiceNotice: null,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetShell();
  });

  it("explains while macOS asks, and allowing takes the line down while listening goes on", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    expect(state()).toMatchObject({
      recording: true,
      voiceNotice: { kind: "mic", line: "asking" },
    });
    access = "granted";
    opening.resolve();
    await settle();
    expect(state()).toMatchObject({ recording: true, voiceNotice: null });
  });

  it("says access is off after Don't Allow, even once the key is up", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    state().acceptRecording(true);
    access = "denied";
    opening.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(state()).toMatchObject({ recording: false, voiceNotice: { kind: "mic", line: "off" } });
  });

  it("shows the off line at once on a later hold, and never opens the microphone", async () => {
    access = "denied";
    state().startRecording();
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "mic", line: "off" },
    });
  });

  it("says the administrator decides on a managed Mac", async () => {
    access = "restricted";
    state().startRecording();
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "mic", line: "managed" },
    });
  });

  it("keeps the unavailable line for a microphone that fails with access on", async () => {
    state().startRecording();
    await settle();
    opening.reject(new DOMException("Requested device not found", "NotFoundError"));
    await settle();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "error", message: "The microphone is unavailable. You can still type." },
    });
  });

  it("keeps an off line up through a hold until the hold works", async () => {
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "off" } });
    state().startRecording();
    await settle();
    expect(state()).toMatchObject({ recording: true, voiceNotice: { kind: "mic", line: "off" } });
    opening.resolve();
    await settle();
    expect(state().voiceNotice).toBeNull();
  });

  it("takes the off line down when access reads on again, and leaves it while still off", async () => {
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "off" } });
    access = "denied";
    state().recheckMicAccess();
    await settle();
    expect(state().voiceNotice).toEqual({ kind: "mic", line: "off" });
    access = "granted";
    state().recheckMicAccess();
    await settle();
    expect(state().voiceNotice).toBeNull();
    // The asking line is the prompt's own, so a re-read leaves it alone.
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "asking" } });
    state().recheckMicAccess();
    await settle();
    expect(micAccess).toHaveBeenCalledTimes(2);
    expect(state().voiceNotice).toEqual({ kind: "mic", line: "asking" });
  });

  it("drops the line when dictation goes off while macOS asks", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    state().applyDictation({ enabled: false, key: "AltRight" });
    access = "denied";
    opening.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(state()).toMatchObject({ recording: false, voiceNotice: null });
  });
});
