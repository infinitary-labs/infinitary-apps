import { describe, expect, it } from "vitest";
import { DIAGNOSTICS_KEPT, PageDiagnostics } from "./diagnostics";

describe("page diagnostics", () => {
  it("bounds messages and requests, strips address secrets, and reports outcomes", () => {
    const page = new PageDiagnostics();
    for (let n = 0; n <= DIAGNOSTICS_KEPT; n += 1) {
      page.log("warning", `message ${n}`, false);
      page.request({
        kind: "request",
        id: String(n),
        method: "GET",
        type: "Fetch",
        url: `https://user:password@example.com/data/${n}?token=secret#code`,
      });
    }
    page.request({ kind: "response", id: "1", status: 404 });
    page.request({ kind: "failed", id: "2" });
    const console = page.read("console", false);
    expect(console).toContain("101 messages");
    expect(console).not.toContain("- warning: message 0\n");
    expect(console).toContain("1 older messages not kept");
    const network = page.read("network", false);
    expect(network).toContain("101 requests; 100 kept");
    expect(network).toContain("https://example.com/data/1 (Fetch; status 404)");
    expect(network).toContain("https://example.com/data/2 (Fetch; failed)");
    expect(network).toContain("pending");
    for (const secret of ["password", "user:", "token=secret", "#code"])
      expect(network).not.toContain(secret);
  });

  it("retains the latest redirect hop without evicting another retained request", () => {
    const page = new PageDiagnostics();
    for (let n = 0; n < DIAGNOSTICS_KEPT; n += 1)
      page.request({
        kind: "request",
        id: String(n),
        method: "GET",
        type: "Document",
        url: `https://example.com/${n}`,
      });
    page.request({
      kind: "request",
      id: "99",
      method: "GET",
      type: "Document",
      url: "https://example.com/redirect",
    });
    const network = page.read("network", false);
    expect(network).toContain("101 requests; 100 kept");
    expect(network).toContain("https://example.com/0 ");
    expect(network).toContain("https://example.com/redirect ");
    expect(network).not.toContain("https://example.com/99 ");
  });

  it("keeps only console counts when hidden and never revives requests after clear", () => {
    const page = new PageDiagnostics();
    page.log("error", "captain code", true);
    expect(page.read("console", true)).toContain("error: 1");
    expect(page.read("console", false)).not.toContain("captain code");
    page.request({
      kind: "request",
      id: "1",
      method: "POST",
      type: "Fetch",
      url: "data:text/plain,secret",
    });
    expect(page.read("network", false)).not.toContain("secret");
    page.clear();
    page.request({ kind: "response", id: "1", status: 200 });
    expect(page.read("network", true)).toContain("0 requests; 0 kept");
    expect(page.read("console", true)).toContain("0 messages");
  });
});
