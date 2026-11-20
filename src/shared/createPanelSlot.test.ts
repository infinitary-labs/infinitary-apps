import { describe, expect, it } from "vitest";
import { type CreatePanelSlotFacts, showsCreatePanelSlot } from "./createPanelSlot";

const shown: CreatePanelSlotFacts = {
  thirdCrewmateDoneAt: 1000,
  panelsOn: true,
  ownPanel: false,
  hidden: false,
};

describe("the create-your-own-panel slot's rule", () => {
  it("shows once three crewmates have finished, with panels on, none of the captain's own, and not hidden", () => {
    expect(showsCreatePanelSlot(shown)).toBe(true);
  });

  it("leaves when any one fact fails", () => {
    expect(showsCreatePanelSlot({ ...shown, thirdCrewmateDoneAt: undefined })).toBe(false);
    expect(showsCreatePanelSlot({ ...shown, panelsOn: false })).toBe(false);
    expect(showsCreatePanelSlot({ ...shown, ownPanel: true })).toBe(false);
    expect(showsCreatePanelSlot({ ...shown, hidden: true })).toBe(false);
  });

  it("waits for the first snapshot before saying the captain has no panel", () => {
    expect(showsCreatePanelSlot({ ...shown, ownPanel: null })).toBe(false);
  });
});
