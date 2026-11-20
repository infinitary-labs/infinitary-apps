import { HomeLink } from "@core/devices/homeLink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWindow } from "./localWindow";

afterEach(() => {
  vi.useRealTimers();
});

// INF-4680's window-first cut, "notice the first mate at once": the window waited up to a
// second after its first mate's door opened, because it dialed only once a second after its
// first three tries.
describe("the window on its first mate's own computer while the first mate starts", () => {
  it("dials the door again within a tenth of a second wherever in the start it opens", async () => {
    vi.useFakeTimers();
    const dials: number[] = [];
    const window = new LocalWindow({
      door: "/no/door/yet",
      broadcast: () => {},
      // The real link, dialing a door that is not open yet.
      link: (options) =>
        new HomeLink({
          ...options,
          dial: async () => {
            dials.push(Date.now());
            throw new Error("The first mate on this computer is not open.");
          },
        }),
    });
    const startedAt = Date.now();
    try {
      // The door opens anywhere in a first mate's start of several seconds.
      for (const opensAt of [400, 1_300, 2_950, 4_700, 8_000]) {
        await vi.advanceTimersByTimeAsync(startedAt + opensAt - Date.now());
        await vi.advanceTimersByTimeAsync(100);
        expect(
          dials.some((at) => at > startedAt + opensAt && at <= startedAt + opensAt + 100),
        ).toBe(true);
      }
    } finally {
      window.close();
    }
  });
});
