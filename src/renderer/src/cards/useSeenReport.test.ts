import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it, vi } from "vitest";
import { reportDrawnUpdate } from "./useSeenReport";

// INF-2022: an updated desktop against an older home must send no unsupported request.
const drawn = {
  id: "card-findings",
  offerId: "findings-offer",
  lifecycleId: "findings-life",
  currentUpdateId: "released-answer",
};

describe("drawn update request compatibility", () => {
  it("uses only the legacy two-argument sighting when the home did not advertise shared marks", async () => {
    const seen = vi.fn(async () => ({ ok: true as const }));
    const seenUpdate = vi.fn(async () => {
      throw new Error("Unsupported request");
    });
    await reportDrawnUpdate(drawn, {}, { seen, seenUpdate });
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: "12.0.0", changes: ["another-change"] },
      { seen, seenUpdate },
    );
    expect(seen.mock.calls).toEqual([
      [drawn.id, drawn.offerId],
      [drawn.id, drawn.offerId],
    ]);
    expect(seenUpdate).not.toHaveBeenCalled();
  });

  it("uses the exact released identifier only when supported, never falling back for an unidentified update", async () => {
    const seen = vi.fn(async () => ({ ok: true as const }));
    const seenUpdate = vi.fn(async () => ({ ok: true as const }));
    // An older home names the change; a home on major 13 or later folds the name in.
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: "12.0.0", changes: ["card-current-update-seen"] },
      { seen, seenUpdate },
    );
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: PROTOCOL_VERSION, changes: [] },
      { seen, seenUpdate },
    );
    expect(seenUpdate.mock.calls).toEqual([
      [drawn.id, drawn.lifecycleId, drawn.currentUpdateId],
      [drawn.id, drawn.lifecycleId, drawn.currentUpdateId],
    ]);
    await reportDrawnUpdate(
      { ...drawn, currentUpdateId: undefined },
      { protocolVersion: PROTOCOL_VERSION },
      { seen, seenUpdate },
    );
    expect(seenUpdate).toHaveBeenCalledTimes(2);
    expect(seen).not.toHaveBeenCalled();
  });
});
