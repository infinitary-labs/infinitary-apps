import { describe, expect, it } from "vitest";
import { isExternalUrlAllowed } from "./navigation";

describe("isExternalUrlAllowed", () => {
  it("allows https github.com", () => {
    expect(isExternalUrlAllowed("https://github.com/kunchenguid/firstmate-3000/releases")).toBe(
      true,
    );
  });

  it("rejects http, other hosts, lookalikes, and non-urls", () => {
    expect(isExternalUrlAllowed("http://github.com/")).toBe(false);
    expect(isExternalUrlAllowed("https://example.com/")).toBe(false);
    expect(isExternalUrlAllowed("https://github.com.evil.io/")).toBe(false);
    expect(isExternalUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isExternalUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isExternalUrlAllowed("nope")).toBe(false);
  });
});
