import { describe, expect, it } from "vitest";
import { ownComputerName } from "./computerName";

describe("this computer's own name", () => {
  it("takes a development run's stand-in under either of its names, Infinitary's first", async () => {
    expect(
      await ownComputerName({ packaged: false, env: { FM3000_DEVICE_NAME: "Older Mac" } }),
    ).toBe("Older Mac");
    expect(
      await ownComputerName({ packaged: false, env: { INFINITARY_DEVICE_NAME: "Newer Mac" } }),
    ).toBe("Newer Mac");
    expect(
      await ownComputerName({
        packaged: false,
        env: { FM3000_DEVICE_NAME: "Older Mac", INFINITARY_DEVICE_NAME: "Newer Mac" },
      }),
    ).toBe("Newer Mac");
  });
});
