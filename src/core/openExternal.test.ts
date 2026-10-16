import { describe, expect, it } from "vitest";
import { isAllowedOpenExternalUrl } from "./openExternal";

describe("isAllowedOpenExternalUrl", () => {
  it("allows any https host", () => {
    expect(isAllowedOpenExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedOpenExternalUrl("https://github.com/acme/repo")).toBe(true);
  });

  it("allows http loopback", () => {
    expect(isAllowedOpenExternalUrl("http://localhost:5173/callback")).toBe(true);
    expect(isAllowedOpenExternalUrl("http://127.0.0.1/")).toBe(true);
    expect(isAllowedOpenExternalUrl("http://[::1]/")).toBe(true);
  });

  it("allows http localhost subdomains", () => {
    expect(isAllowedOpenExternalUrl("http://app.localhost:1355/")).toBe(true);
    expect(isAllowedOpenExternalUrl("http://task-1.soapbox.localhost:1355/a?b=c")).toBe(true);
  });

  it("rejects localhost lookalikes", () => {
    expect(isAllowedOpenExternalUrl("http://localhost.example.com/")).toBe(false);
    expect(isAllowedOpenExternalUrl("http://evillocalhost/")).toBe(false);
  });

  it("rejects http to the public internet and lookalike hosts", () => {
    expect(isAllowedOpenExternalUrl("http://example.com")).toBe(false);
    expect(isAllowedOpenExternalUrl("http://localhost.evil.com/")).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(isAllowedOpenExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedOpenExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedOpenExternalUrl("ftp://example.com")).toBe(false);
  });
});
