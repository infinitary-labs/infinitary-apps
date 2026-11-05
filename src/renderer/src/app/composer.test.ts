import { CONVERSE_TEXT_MAX_CHARS, TURN_IMAGES_MAX } from "@shared/cards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_FILES_KEY, useIntakeStore } from "../attachments/intake";
import { voiceController } from "../voice/voiceController";
import { mainInputHeld } from "./composer";
import { useShellStore } from "./store";
import { card, picture, resetShell } from "./storeTestKit";

/** The main message (./composer.ts): what a send carries, drafts kept, and the input's focus. */

describe("submit visible card id", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("passes only the shown record task, then only the shown card", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      infinitary: { conversation: { send } },
    });
    useShellStore.setState({
      cards: [card({ id: "card-fm-1", status: "ready", title: "Quota", body: "ok" })],
      records: [{ taskId: "task-1" }],
      cardIndex: 0,
      inputText: "how is this going?",
      attachments: [],
      recording: false,
    });
    useShellStore.getState().submit();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({
      text: "how is this going?",
      images: undefined,
      visibleCardId: undefined,
      taskId: "task-1",
    });
    useShellStore.getState().focusCard("card-fm-1");
    useShellStore.getState().setInputText("and this?");
    useShellStore.getState().submit();
    expect(send).toHaveBeenLastCalledWith({
      text: "and this?",
      images: undefined,
      visibleCardId: "card-fm-1",
      taskId: undefined,
    });
  });
});

describe("never lose a draft", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("puts a rejected turn's words and pictures back in an empty composer", async () => {
    const send = vi.fn(async () => Promise.reject(new Error("malformed request")));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look at this", attachments: [picture("a")] });

    useShellStore.getState().submit();
    expect(useShellStore.getState().inputText).toBe("");
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("look at this");
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("never overwrites a newer draft; the unsent turn waits in the recall slot", async () => {
    let reject: (reason: Error) => void = () => {};
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, rejectSend) => {
          reject = rejectSend;
        }),
    );
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "first thought", attachments: [picture("a")] });

    useShellStore.getState().submit();
    useShellStore.setState({ inputText: "second thought" });
    reject(new Error("the core refused it"));
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("second thought");
    expect(state.attachments).toEqual([]);
    expect(state.lastSent?.text).toBe("first thought");
    expect(state.lastSent?.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("keeps an over-limit draft and sends nothing", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    const draft = "x".repeat(CONVERSE_TEXT_MAX_CHARS + 1);
    useShellStore.setState({ inputText: draft, attachments: [picture("a")] });

    useShellStore.getState().submit();

    const state = useShellStore.getState();
    expect(send).not.toHaveBeenCalled();
    expect(state.inputText).toBe(draft);
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
    expect(state.composerNotice).toBe("too-long");
  });

  it("sends a draft exactly at the limit and clears the notice", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    const draft = "x".repeat(CONVERSE_TEXT_MAX_CHARS);
    useShellStore.setState({ inputText: `\n\n${draft}  \n`, composerNotice: "too-long" });

    useShellStore.getState().submit();

    expect(send).toHaveBeenCalledWith(draft);
    expect(useShellStore.getState().inputText).toBe("");
    expect(useShellStore.getState().composerNotice).toBeNull();
  });

  it("refuses a fifth picture and keeps the four", () => {
    useShellStore.getState().attachImages([picture("a"), picture("b"), picture("c")]);
    expect(useShellStore.getState().composerNotice).toBeNull();

    useShellStore.getState().attachImages([picture("d"), picture("e")]);

    const state = useShellStore.getState();
    expect(state.attachments).toHaveLength(TURN_IMAGES_MAX);
    expect(state.attachments.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(state.composerNotice).toBe("pictures-max");
  });
});

describe("the multi-line composer", () => {
  const log = Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join("\n");

  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("sends the typed words with their line breaks, then each pasted text after a blank line", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "\n  why does this fail?\n\nsee below\n" });
    useShellStore.getState().attachPastedText(log);

    useShellStore.getState().submit();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "  why does this fail?\n\nsee below",
        files: [{ text: log }],
      }),
    );
    const state = useShellStore.getState();
    expect(state.inputText).toBe("");
    expect(state.pastes).toEqual([]);
  });

  it("sends a large paste as a file without counting its text against the typed limit", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look" });
    const text = "x".repeat(78438);
    useShellStore.getState().attachPastedText(text);
    useShellStore.getState().submit();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "look", files: [{ text }] }));
    expect(useShellStore.getState().pastes).toEqual([]);
  });
  it("sends a dropped text file by name, and a picture with its name", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({
      inputText: "see these",
      attachments: [{ ...picture("a"), name: "a.png" }],
    });
    useShellStore.getState().attachPastedText("one\r\ntwo\r\n", "notes.txt");
    expect(useShellStore.getState().pastes[0]).toMatchObject({ name: "notes.txt" });
    useShellStore.getState().submit();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ text: "one\r\ntwo\r\n", name: "notes.txt" }],
        images: [expect.objectContaining({ name: "a.png" })],
      }),
    );
  });

  it("holds a send while a file is still being prepared, and keeps the draft", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useIntakeStore.setState({ pending: { [MAIN_FILES_KEY]: [{ id: "f1", name: "big.csv" }] } });
    try {
      useShellStore.setState({ inputText: "look at big.csv" });
      useShellStore.getState().submit();
      expect(send).not.toHaveBeenCalled();
      expect(useShellStore.getState().inputText).toBe("look at big.csv");
      expect(useShellStore.getState().composerNotice).toBe("files-preparing");
    } finally {
      useIntakeStore.setState({ pending: {} });
    }
  });

  it("refuses oversized and fifth files out loud without changing held files", () => {
    for (let i = 0; i < 4; i++) useShellStore.getState().attachPastedText(log);
    useShellStore.getState().attachPastedText(log);
    expect(useShellStore.getState().pastes).toHaveLength(4);
    expect(useShellStore.getState().composerNotice).toBe("files-max");
    useShellStore.getState().attachPastedText("é".repeat(3 * 1024 * 1024));
    expect(useShellStore.getState().composerNotice).toBe("file-too-big");
    expect(useShellStore.getState().pastes).toHaveLength(4);
  });

  it("brings the last sent turn back, words and chips, only into an empty composer", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "first\nsecond", attachments: [picture("a")] });
    useShellStore.getState().attachPastedText(log);
    useShellStore.getState().submit();

    useShellStore.setState({ inputText: "a new draft" });
    useShellStore.getState().recallLastSent();
    expect(useShellStore.getState().inputText).toBe("a new draft");

    useShellStore.setState({ inputText: "" });
    useShellStore.getState().recallLastSent();
    const state = useShellStore.getState();
    expect(state.inputText).toBe("first\nsecond");
    expect(state.pastes.map((p) => p.text)).toEqual([log]);
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
    expect(state.focusCaret).toEqual({ request: state.focusRequest, at: "first\nsecond".length });
  });

  it("recalls nothing while recording", () => {
    useShellStore.setState({
      recording: true,
      lastSent: { text: "earlier", pastes: [], attachments: [] },
    });
    useShellStore.getState().recallLastSent();
    expect(useShellStore.getState().inputText).toBe("");
  });

  it("puts a rejected turn's pasted text back with its words", async () => {
    const send = vi.fn(async () => Promise.reject(new Error("the core refused it")));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look at this" });
    useShellStore.getState().attachPastedText(log);

    useShellStore.getState().submit();
    expect(useShellStore.getState().pastes).toEqual([]);
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("look at this");
    expect(state.pastes.map((p) => p.text)).toEqual([log]);
  });
});

describe("going to the main message", () => {
  const state = () => useShellStore.getState();
  afterEach(resetShell);

  it("asks the input for focus once per press, coming home from Settings first", () => {
    useShellStore.setState({
      view: "home",
      inputText: "ship the fix",
      inputCaret: 4,
      firstRunSettled: true,
    });
    const before = state().focusRequest;
    state().focusMainMessage();
    expect(state()).toMatchObject({ view: "home", focusRequest: before + 1 });
    useShellStore.setState({ view: "settings" });
    state().focusMainMessage();
    // The words and the caret stay as they were: focus alone moves.
    expect(state()).toMatchObject({
      view: "home",
      focusRequest: before + 2,
      inputText: "ship the fix",
      inputCaret: 4,
    });
  });

  it("moves nothing while a recording, the dictation key's pick or a held main input holds the keys", () => {
    const firstRun = { welcomedAt: null, firstTurnAt: null, gateOpen: true };
    for (const holder of [
      { recording: true },
      { pickingDictationKey: true, view: "settings" as const },
      { firstRun, view: "settings" as const },
      // Before the first read of the gate settles, nobody knows yet whether it is up.
      { firstRunSettled: false, view: "settings" as const },
    ]) {
      useShellStore.setState({ view: "home", firstRunSettled: true, ...holder });
      const { view, focusRequest } = state();
      state().focusMainMessage();
      expect(state()).toMatchObject({ view, focusRequest });
      useShellStore.setState({ recording: false, pickingDictationKey: false, firstRun: null });
    }
  });
});

describe("the main input before the first read of the gate (docs/first-launch.md)", () => {
  const state = () => useShellStore.getState();
  const view = (gateOpen: boolean) => ({ welcomedAt: null, firstTurnAt: null, gateOpen });
  let answer!: { resolve: (v: ReturnType<typeof view>) => void; reject: (e: Error) => void };

  beforeEach(() => {
    const micAccess = vi.fn(async () => ({ access: "granted" as const }));
    const firstRun = vi.fn(
      () =>
        new Promise<ReturnType<typeof view>>((resolve, reject) => {
          answer = { resolve, reject };
        }),
    );
    vi.stubGlobal("window", { infinitary: { app: { firstRun }, voice: { micAccess } } });
    vi.spyOn(voiceController, "start").mockResolvedValue();
    // A launch with everything hold-to-talk needs, but no answer about the gate yet.
    useShellStore.setState({
      view: "home",
      recording: false,
      pickingDictationKey: false,
      dictation: { enabled: true, key: "AltRight" },
      voiceSupported: true,
      voiceModelReady: true,
      firstRun: null,
      firstRunSettled: false,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetShell();
  });

  /** What a person could do with the main input now: hold-to-talk and the focus key. */
  const tryInput = () => {
    const { focusRequest } = state();
    state().focusMainMessage();
    state().startRecording();
    const took = { recording: state().recording, focused: state().focusRequest > focusRequest };
    useShellStore.setState({ recording: false });
    return took;
  };

  it("takes nothing until the read settles, and stays held when it says the gate is up", async () => {
    expect(mainInputHeld(state())).toBe(true);
    const reading = state().loadFirstRun();
    expect(tryInput()).toEqual({ recording: false, focused: false });
    answer.resolve(view(true));
    await reading;
    expect(state()).toMatchObject({ firstRunSettled: true, firstRun: { gateOpen: true } });
    expect(mainInputHeld(state())).toBe(true);
    expect(tryInput()).toEqual({ recording: false, focused: false });
  });

  it("opens once the read says a model can answer", async () => {
    const reading = state().loadFirstRun();
    answer.resolve(view(false));
    await reading;
    expect(mainInputHeld(state())).toBe(false);
    expect(tryInput()).toEqual({ recording: true, focused: true });
  });

  it("opens as before any read when the first read fails, rather than holding for good", async () => {
    const reading = state().loadFirstRun();
    answer.reject(new Error("unreadable"));
    await reading;
    expect(state()).toMatchObject({ firstRunSettled: true, firstRun: null });
    expect(tryInput()).toEqual({ recording: true, focused: true });
  });
});
