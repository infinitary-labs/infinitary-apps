import { EMPTY_FIRST_RUN, type FirstRunView } from "@shared/firstRun";
import * as m from "@shared/i18n/messages.generated";
import { keyHint } from "@shared/keyboard";
import { keymapSnapshot, presetKeymap } from "@shared/keymap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceController } from "../voice/voiceController";
import { inputPlaceholder } from "./HomePrompt";
import { useShellStore } from "./store";

const defaultState = useShellStore.getState();
afterEach(() => {
  useShellStore.setState(defaultState, true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dictation off", () => {
  it("keeps typed text, drops capture and notices, and refuses recording even with a ready model", () => {
    const micAccess = vi.fn();
    vi.stubGlobal("window", { infinitary: { voice: { micAccess } } });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useShellStore.setState({
      inputText: "keep my draft",
      pastes: [{ id: "file", text: "pasted file\r\n".repeat(21) }],
      view: "home",
      voiceSupported: true,
      voiceModelReady: true,
      recording: true,
      voiceNotice: { kind: "consent" },
    });
    useShellStore.getState().applyDictation({ enabled: false, key: "MetaRight" });
    useShellStore.getState().startRecording();
    expect(useShellStore.getState()).toMatchObject({
      inputText: "keep my draft",
      pastes: [{ id: "file", text: "pasted file\r\n".repeat(21) }],
      recording: false,
      transcribing: false,
      voiceNotice: null,
    });
    expect(micAccess).not.toHaveBeenCalled();
  });

  it("does not send a cancelled recording when off is followed immediately by on", async () => {
    const send = vi.fn();
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    vi.spyOn(voiceController, "finish").mockReturnValueOnce(pending);
    useShellStore.setState({
      inputText: "keep",
      recording: true,
      dictation: { enabled: true, key: "AltRight" },
    });
    useShellStore.getState().submit();
    useShellStore.getState().applyDictation({ enabled: false, key: "AltRight" });
    useShellStore.getState().applyDictation({ enabled: true, key: "AltRight" });
    resolve("discard me");
    await pending;
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(useShellStore.getState().inputText).toBe("keep");
  });

  it("hides the voice hint while off and names the saved key in every form while on", () => {
    const base = { firstRun: null, voiceSupported: true, transcribing: false };
    expect(inputPlaceholder({ ...base, dictation: { enabled: false, key: "MetaRight" } })).toEqual([
      "type a task for a crewmate",
      "type a task",
    ]);
    expect(inputPlaceholder({ ...base, dictation: { enabled: true, key: "MetaRight" } })).toEqual([
      "type, or press/hold right ⌘ to talk",
      "press/hold right ⌘ to talk",
      "hold right ⌘ to talk",
    ]);
    expect(
      inputPlaceholder({ ...base, dictation: { enabled: true, key: "ControlRight" } }),
    ).toEqual([
      "type, or press/hold right ⌃ to talk",
      "press/hold right ⌃ to talk",
      "hold right ⌃ to talk",
    ]);
  });

  // Review regression: an unfocused not-typing layer must not hide dictation's status.
  it("keeps transcription status above the return hint and restores the hint afterward", () => {
    const returnToMessageKey = keyHint("focus.main-message");
    const input = {
      firstRun: null,
      voiceSupported: true,
      dictation: { enabled: true, key: "AltRight" } as const,
      transcribing: true,
    };
    expect(inputPlaceholder({ ...input, returnToMessageKey })).toEqual(inputPlaceholder(input));
    expect(inputPlaceholder({ ...input, returnToMessageKey, transcribing: false })).toEqual([
      `press ${returnToMessageKey} to write a message`,
    ]);
  });

  // The captain's ask: Vim's key is the plain i, so a capital I misleads.
  it("writes a plain letter in the return hint as it is typed", () => {
    const input = { firstRun: null, voiceSupported: true, transcribing: false };
    const keysOf = (preset: "vim" | "emacs") =>
      keyHint(
        "focus.main-message",
        keymapSnapshot({ saved: presetKeymap(preset), unreadable: false }, 1).bindings,
      );
    expect(inputPlaceholder({ ...input, returnToMessageKey: keysOf("vim") })).toEqual([
      m.shellPromptReturnToMessage({ key: "i" }),
    ]);
    expect(inputPlaceholder({ ...input, returnToMessageKey: keysOf("emacs") })).toEqual([
      m.shellPromptReturnToMessage({ key: "⌃X m" }),
    ]);
  });

  it("gives every hint a shorter form for a narrow input, except the gated line", () => {
    const dictation = { enabled: true, key: "AltRight" } as const;
    const base = { firstRun: null, voiceSupported: true, dictation, transcribing: false };
    const view: FirstRunView = { ...EMPTY_FIRST_RUN, welcomedAt: 1, gateOpen: false };
    expect(inputPlaceholder({ ...base, firstRun: view })).toEqual([
      "give your first mate a task, or press/hold right ⌥ to talk",
      "give your first mate a task, or hold right ⌥ to talk",
      "give your first mate a task",
    ]);
    expect(inputPlaceholder({ ...base, firstRun: { ...view, gateOpen: true } })).toEqual([
      "connect a subscription first",
    ]);
    const freshCheck = { accountId: "acct_1", label: "Operator gateway", models: ["m"] };
    expect(
      inputPlaceholder({ ...base, firstRun: { ...view, gateOpen: true, freshCheck } }),
    ).toEqual(["check your connection first"]);
    expect(inputPlaceholder({ ...base, transcribing: true })).toEqual([
      "transcribing what you said",
      "transcribing",
    ]);
  });
});
