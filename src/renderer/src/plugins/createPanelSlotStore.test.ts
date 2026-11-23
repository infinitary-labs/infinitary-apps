import { CREATE_PANEL_DRAFT, CREATE_PANEL_SLOT_ID } from "@shared/createPanelSlot";
import type { PersonalExtensionView } from "@shared/personal/manifest";
import { DEFAULT_LAYOUT, type Layout } from "@shared/preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../app/store";
import { createPanelSlot } from "./createPanelSlotStore";
import { railStore } from "./railStore";

const shell = () => useShellStore.getState();

function snapshot(source: PersonalExtensionView["source"]) {
  return { extensions: [{ id: "clock", source } as PersonalExtensionView] };
}

describe("the create-your-own-panel slot's click", () => {
  beforeEach(() =>
    useShellStore.setState({
      inputText: "",
      inputCaret: 0,
      recording: false,
      pickingDictationKey: false,
      firstRunSettled: true,
      firstRun: { welcomedAt: null, firstTurnAt: 5, gateOpen: false },
    }),
  );

  it("starts the message box with the ask and the caret after it, keeping what was typed", () => {
    const focus = shell().focusRequest;
    expect(createPanelSlot.startAsk()).toBe(true);
    expect(shell().inputText).toBe(CREATE_PANEL_DRAFT);
    expect(shell().inputCaret).toBe(CREATE_PANEL_DRAFT.length);
    expect(shell().focusRequest).toBe(focus + 1);
    createPanelSlot.startAsk();
    expect(shell().inputText).toBe(CREATE_PANEL_DRAFT);

    shell().setInputText("the weather in Lisbon");
    createPanelSlot.startAsk();
    expect(shell().inputText).toBe(`${CREATE_PANEL_DRAFT}the weather in Lisbon`);
    expect(shell().inputCaret).toBe(CREATE_PANEL_DRAFT.length);
  });

  it("is refused while the message box is held, as Go to the main message is", () => {
    for (const held of [
      { recording: true },
      { pickingDictationKey: true },
      { firstRun: { welcomedAt: null, firstTurnAt: null, gateOpen: true } },
      { firstRunSettled: false },
    ]) {
      useShellStore.setState(held);
      const focus = shell().focusRequest;
      expect(createPanelSlot.startAsk()).toBe(false);
      expect(shell().inputText).toBe("");
      expect(shell().focusRequest).toBe(focus);
      useShellStore.setState({
        recording: false,
        pickingDictationKey: false,
        firstRunSettled: true,
        firstRun: { welcomedAt: null, firstTurnAt: 5, gateOpen: false },
      });
    }
  });
});

describe("the create-your-own-panel slot's facts and Hide", () => {
  let written: Layout[];
  beforeEach(() => {
    written = [];
    vi.stubGlobal("window", {
      infinitary: {
        settings: {
          setLayout: (layout: Layout) => {
            written.push(layout);
            return Promise.resolve(layout);
          },
        },
      },
    });
    railStore.hydrate(DEFAULT_LAYOUT);
    createPanelSlot.reset();
  });
  afterEach(() => {
    railStore.reset();
    createPanelSlot.reset();
    vi.unstubAllGlobals();
  });

  it("counts a panel of the captain's own, never one somebody else made", () => {
    expect(createPanelSlot.facts().ownPanel).toBeNull();
    createPanelSlot.noteSnapshot({ extensions: [] });
    expect(createPanelSlot.facts().ownPanel).toBe(false);
    createPanelSlot.noteSnapshot(snapshot("installed"));
    expect(createPanelSlot.facts().ownPanel).toBe(false);
    createPanelSlot.noteSnapshot(snapshot("yours"));
    expect(createPanelSlot.facts().ownPanel).toBe(true);
    createPanelSlot.notePanelsOn(false);
    expect(createPanelSlot.facts()).toEqual({ panelsOn: false, ownPanel: true });
  });

  it("hides the slot in the record the core keeps, as hide it to the Firstmate does", () => {
    createPanelSlot.hide();
    expect(railStore.isHidden(CREATE_PANEL_SLOT_ID)).toBe(true);
    expect(written.at(-1)?.hiddenPanels).toEqual({ [CREATE_PANEL_SLOT_ID]: true });
  });
});
