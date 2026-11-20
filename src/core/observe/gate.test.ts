import { describe, expect, it } from "vitest";
import { isDevObserveEnabled, isObserveEnabled } from "./gate";

describe("isDevObserveEnabled", () => {
  it("is on for unpackaged builds without any env flag", () => {
    expect(isDevObserveEnabled({ isPackaged: false })).toBe(true);
    expect(isDevObserveEnabled({ isPackaged: false, env: { INFINITARY_DEV_OBSERVE: "0" } })).toBe(
      true,
    );
  });

  it("is off for packaged builds unless INFINITARY_DEV_OBSERVE=1", () => {
    expect(isDevObserveEnabled({ isPackaged: true })).toBe(false);
    expect(isDevObserveEnabled({ isPackaged: true, env: {} })).toBe(false);
    expect(isDevObserveEnabled({ isPackaged: true, env: { INFINITARY_DEV_OBSERVE: "true" } })).toBe(
      false,
    );
    expect(isDevObserveEnabled({ isPackaged: true, env: { INFINITARY_DEV_OBSERVE: "1" } })).toBe(
      true,
    );
  });

  it("reads the flag under the older FM3000_ name too; Infinitary's wins", () => {
    expect(isDevObserveEnabled({ isPackaged: true, env: { FM3000_DEV_OBSERVE: "1" } })).toBe(true);
    expect(
      isDevObserveEnabled({
        isPackaged: true,
        env: { FM3000_DEV_OBSERVE: "1", INFINITARY_DEV_OBSERVE: "0" },
      }),
    ).toBe(false);
  });
});

describe("isObserveEnabled", () => {
  it("is on for an installed alpha without any env flag", () => {
    expect(isObserveEnabled({ packaged: true, version: "0.1.31-alpha.4" })).toBe(true);
    expect(
      isObserveEnabled({
        packaged: true,
        version: "0.1.31-alpha.4",
        env: { INFINITARY_DEV_OBSERVE: "0" },
      }),
    ).toBe(true);
  });

  it("is on for unpackaged builds of any version", () => {
    expect(isObserveEnabled({ packaged: false, version: "0.1.30" })).toBe(true);
    expect(isObserveEnabled({ packaged: false, version: "0.1.31-alpha.4" })).toBe(true);
  });

  it("keeps an installed stable build off unless INFINITARY_DEV_OBSERVE=1", () => {
    expect(isObserveEnabled({ packaged: true, version: "0.1.30" })).toBe(false);
    expect(
      isObserveEnabled({
        packaged: true,
        version: "0.1.30",
        env: { INFINITARY_DEV_OBSERVE: "true" },
      }),
    ).toBe(false);
    expect(
      isObserveEnabled({ packaged: true, version: "0.1.30", env: { INFINITARY_DEV_OBSERVE: "1" } }),
    ).toBe(true);
  });

  it("treats any version that is not exactly X.Y.Z-alpha.N as stable", () => {
    for (const version of ["0.1.31-beta.1", "0.1.31-alpha", "0.1.31-alpha.4+build", "", "dev"]) {
      expect(isObserveEnabled({ packaged: true, version }), version).toBe(false);
    }
  });
});
