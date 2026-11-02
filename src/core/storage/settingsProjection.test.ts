import { modelSlotsStateSchema, offeringKey } from "@shared/modelSlots";
import { expect, it, vi } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { SettingsStore } from "./settingsStore";

// INF-2186: remote-account posture reads validated the same model slots,
// routing pins and flagship choice again for each board row.
it("reads and validates routing facts once per projection and sees subsequent changes", () => {
  const db = freshDatabase();
  const settings = new SettingsStore(db);
  const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
  const key = offeringKey(model);
  const slots = { version: 1 as const, assignments: { [key]: ["high" as const] }, seen: [key] };
  settings.setModelSlots(slots);
  settings.setRoutingSettings({ dynamicRouting: true, pins: [model] });
  settings.setFirstmateModel(model);
  const validate = vi.spyOn(modelSlotsStateSchema, "safeParse");
  try {
    const baseline = rowsRead(db, () => {
      for (let row = 0; row < 40; row += 1) {
        settings.getModelSlots();
        settings.getRoutingSettings();
        settings.getFirstmateModel();
      }
    });
    validate.mockClear();
    const reads = rowsRead(db, () =>
      settings.readProjection(() => {
        for (let row = 0; row < 40; row += 1) {
          expect(settings.getModelSlots()).toEqual(slots);
          expect(settings.getRoutingSettings().pins).toEqual([model]);
          expect(settings.getFirstmateModel()).toEqual(model);
        }
      }),
    );
    expect(reads).toBe(3);
    expect(reads).toBeLessThan(baseline);
    expect(validate).toHaveBeenCalledTimes(1);
    console.info(JSON.stringify({ intent: "INF-2186 routing facts", baseline, projected: reads }));
    settings.readProjection(() => {
      settings.getModelSlots();
      settings.setModelSlots({ ...slots, assignments: {} });
      expect(settings.getModelSlots().assignments).toEqual({});
      settings.setFirstmateModel(null);
      expect(settings.getFirstmateModel()).toBeNull();
    });
    const fresh = settings.getModelSlots();
    fresh.seen.length = 0;
    expect(settings.getModelSlots().seen).toEqual(slots.seen);
  } finally {
    validate.mockRestore();
    db.close();
  }
});
