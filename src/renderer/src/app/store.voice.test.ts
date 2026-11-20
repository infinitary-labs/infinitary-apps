import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceController } from "../voice/voiceController";
import { TRANSCRIBE_FAILED } from "./composer";
import { useShellStore } from "./store";
import { resetShell, settle } from "./storeTestKit";
import { VOICE_MODEL_DOWNLOAD_FAILED } from "./voice";

/**
 * Talking to the first mate (docs/composer.md, "Voice"): the voice model's
 * one-time download, and what a released, abandoned or sent recording does
 * to the message box. Guardrails for INF-2625's renderer piece, which moves
 * this code out of store.ts: they hold what a person sees before and after
 * the move.
 */

const state = () => useShellStore.getState();

/** A home window with dictation on and the voice model on this computer. */
const READY = {
  view: "home" as const,
  dictation: { enabled: true, key: "AltRight" as const },
  voiceSupported: true,
  voiceModelReady: true,
  firstRun: null,
  firstRunSettled: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetShell();
});

describe('the voice model\'s download (docs/composer.md, "Voice")', () => {
  let ensureModel: ReturnType<typeof vi.fn>;
  let finishDownload: { resolve: () => void; reject: (error: Error) => void };

  beforeEach(() => {
    ensureModel = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          finishDownload = { resolve, reject };
        }),
    );
    vi.stubGlobal("window", { infinitary: { voice: { ensureModel } } });
    useShellStore.setState({ ...READY, voiceModelReady: false });
  });

  it("asks before the first download, and a hold while it downloads keeps showing its progress", () => {
    state().startRecording();
    expect(state()).toMatchObject({ recording: false, voiceNotice: { kind: "consent" } });

    state().startVoiceDownload();
    expect(state().voiceNotice).toEqual({ kind: "download", fraction: 0 });
    state().startRecording();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "download", fraction: 0 },
    });
  });

  it("takes the notice down once the model is here", async () => {
    state().startVoiceDownload();
    expect(ensureModel).toHaveBeenCalledTimes(1);
    finishDownload.resolve();
    await settle();
    expect(state()).toMatchObject({ voiceModelReady: true, voiceNotice: null });
  });

  it("says a failed download failed, unless dictation was turned off meanwhile", async () => {
    state().startVoiceDownload();
    finishDownload.reject(new Error("offline"));
    await settle();
    expect(state()).toMatchObject({
      voiceModelReady: false,
      voiceNotice: { kind: "error", message: VOICE_MODEL_DOWNLOAD_FAILED },
    });

    state().startVoiceDownload();
    useShellStore.setState({ dictation: { enabled: false, key: "AltRight" } });
    finishDownload.reject(new Error("offline"));
    await settle();
    expect(state().voiceNotice).toEqual({ kind: "download", fraction: 0 });
  });

  it("downloads nothing while dictation is off", () => {
    useShellStore.setState({ dictation: { enabled: false, key: "AltRight" } });
    state().startVoiceDownload();
    expect(ensureModel).not.toHaveBeenCalled();
    expect(state().voiceNotice).toBeNull();
  });
});

describe('a recording that ends (docs/composer.md, "Voice")', () => {
  let finish: ReturnType<typeof vi.spyOn>;
  let transcribed: { resolve: (text: string | null) => void; reject: (error: Error) => void };
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      infinitary: {
        voice: { micAccess: async () => ({ access: "granted" }) },
        conversation: { send },
      },
    });
    vi.spyOn(voiceController, "start").mockResolvedValue(undefined);
    finish = vi.spyOn(voiceController, "finish").mockImplementation(
      () =>
        new Promise<string | null>((resolve, reject) => {
          transcribed = { resolve, reject };
        }),
    );
    vi.spyOn(voiceController, "abandon").mockImplementation(() => {});
    useShellStore.setState(READY);
  });

  /** Starts a recording the way a held key does, its microphone open. */
  const record = async () => {
    state().startRecording();
    await settle();
    expect(state().recording).toBe(true);
  };

  it("puts a released recording's words at the caret and gives the box focus", async () => {
    useShellStore.setState({ inputText: "Fix the  please", inputCaret: 8, focusRequest: 4 });
    await record();

    state().acceptRecording(true);
    expect(finish).toHaveBeenCalledWith(true);
    expect(state()).toMatchObject({ recording: false, transcribing: true });
    transcribed.resolve("reply row");
    await settle();

    expect(state()).toMatchObject({
      transcribing: false,
      inputText: "Fix the reply row please",
      inputCaret: 17,
      focusRequest: 5,
      focusCaret: { request: 5, at: 17 },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("says a recording it could not transcribe could not be, and keeps what was typed", async () => {
    useShellStore.setState({ inputText: "keep this" });
    await record();

    state().acceptRecording();
    transcribed.reject(new Error("whisper failed"));
    await settle();

    expect(state()).toMatchObject({
      transcribing: false,
      inputText: "keep this",
      voiceNotice: { kind: "error", message: TRANSCRIBE_FAILED },
    });
  });

  it("drops the words of a recording that a newer one replaced", async () => {
    await record();
    state().acceptRecording();
    const first = transcribed;
    await record();

    first.resolve("old words");
    await settle();

    expect(state()).toMatchObject({ recording: true, inputText: "" });
  });

  // INF-3307's audit, row 11: abandoning a second recording while the first
  // transcribed left the box saying Transcribing, with nothing to clear it.
  it("stops saying Transcribing once a newer recording replaces one, even when that one is abandoned", async () => {
    await record();
    state().acceptRecording();
    const first = transcribed;
    await record();

    state().abandonRecording();
    first.resolve("old words");
    await settle();

    expect(state()).toMatchObject({ recording: false, transcribing: false, inputText: "" });
  });

  it("abandons a recording without a word reaching the box", async () => {
    useShellStore.setState({ inputText: "typed" });
    await record();

    state().abandonRecording();

    expect(voiceController.abandon).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ recording: false, transcribing: false, inputText: "typed" });
  });

  it("sends straight from a recording: its words join what was typed, then the turn leaves", async () => {
    useShellStore.setState({ inputText: "Look at", inputCaret: 7 });
    await record();

    state().submit();
    expect(state()).toMatchObject({ recording: false, transcribing: true });
    transcribed.resolve("the failing check");
    await settle();

    expect(send).toHaveBeenCalledWith("Look at the failing check");
    expect(state()).toMatchObject({ transcribing: false, inputText: "" });
  });

  it("sends nothing when a recording sent straight away cannot be transcribed", async () => {
    useShellStore.setState({ inputText: "Look at" });
    await record();

    state().submit();
    transcribed.reject(new Error("whisper failed"));
    await settle();

    expect(send).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      transcribing: false,
      inputText: "Look at",
      voiceNotice: { kind: "error", message: TRANSCRIBE_FAILED },
    });
  });
});
