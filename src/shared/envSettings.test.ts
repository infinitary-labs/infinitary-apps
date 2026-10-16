import { describe, expect, it } from "vitest";
import { settingFrom } from "./envSettings";

describe("a setting an environment variable names", () => {
  it("reads the Firstmate 3000 name alone, as it always has", () => {
    expect(settingFrom({ FM3000_TELEMETRY: "0" }, "TELEMETRY")).toBe("0");
    expect(settingFrom({}, "TELEMETRY")).toBeUndefined();
  });

  it("reads Infinitary's name, and Infinitary's name wins when both are set", () => {
    expect(settingFrom({ INFINITARY_TELEMETRY: "1" }, "TELEMETRY")).toBe("1");
    expect(settingFrom({ FM3000_TELEMETRY: "0", INFINITARY_TELEMETRY: "1" }, "TELEMETRY")).toBe(
      "1",
    );
  });

  it("keeps a deliberately empty value under Infinitary's name, so it still wins", () => {
    expect(settingFrom({ FM3000_URL: "http://a", INFINITARY_URL: "" }, "URL")).toBe("");
  });
});
