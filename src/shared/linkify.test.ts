import { describe, expect, it } from "vitest";
import { isSafeCardHref, splitCardBodyUrls, trimTrailingUrlPunctuation } from "./linkify";

describe("trimTrailingUrlPunctuation", () => {
  it("strips sentence punctuation", () => {
    expect(trimTrailingUrlPunctuation("https://example.com.")).toEqual({
      url: "https://example.com",
      trailing: ".",
    });
    expect(trimTrailingUrlPunctuation("https://example.com/path,")).toEqual({
      url: "https://example.com/path",
      trailing: ",",
    });
  });

  it("keeps balanced parentheses inside the path", () => {
    expect(trimTrailingUrlPunctuation("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual({
      url: "https://en.wikipedia.org/wiki/Foo_(bar)",
      trailing: "",
    });
  });

  it("strips an unmatched closing paren", () => {
    expect(trimTrailingUrlPunctuation("https://example.com)")).toEqual({
      url: "https://example.com",
      trailing: ")",
    });
  });
});

describe("splitCardBodyUrls", () => {
  it("splits a url from surrounding text", () => {
    expect(splitCardBodyUrls("See https://example.com for details.")).toEqual([
      { type: "text", value: "See " },
      { type: "url", value: "https://example.com" },
      { type: "text", value: " for details." },
    ]);
  });

  it("keeps newlines so pre-wrap still works", () => {
    expect(splitCardBodyUrls("one\nhttps://example.com\ntwo")).toEqual([
      { type: "text", value: "one\n" },
      { type: "url", value: "https://example.com" },
      { type: "text", value: "\ntwo" },
    ]);
  });

  it("finds multiple urls", () => {
    expect(splitCardBodyUrls("https://a.example/x and http://localhost:5173/y")).toEqual([
      { type: "url", value: "https://a.example/x" },
      { type: "text", value: " and " },
      { type: "url", value: "http://localhost:5173/y" },
    ]);
  });

  it("leaves trailing punctuation on the surrounding text", () => {
    expect(splitCardBodyUrls("PR is up: https://github.com/acme/repo.")).toEqual([
      { type: "text", value: "PR is up: " },
      { type: "url", value: "https://github.com/acme/repo" },
      { type: "text", value: "." },
    ]);
  });

  it("does not treat non-http schemes as urls", () => {
    const body = "js javascript:alert(1) file file:///etc/passwd ftp ftp://example.com";
    expect(splitCardBodyUrls(body)).toEqual([{ type: "text", value: body }]);
  });

  it("does not treat a bare host as a url", () => {
    expect(splitCardBodyUrls("visit example.com later")).toEqual([
      { type: "text", value: "visit example.com later" },
    ]);
  });
});

describe("isSafeCardHref", () => {
  it("allows https and http loopback", () => {
    expect(isSafeCardHref("https://example.com")).toBe(true);
    expect(isSafeCardHref("http://localhost:5173/x")).toBe(true);
  });

  it("allows http genuine localhost subdomains, single-level and nested", () => {
    expect(isSafeCardHref("http://app.localhost:1355/x?y=1")).toBe(true);
    expect(isSafeCardHref("http://task-c5db2568.soapbox.localhost:1355/reports/probe")).toBe(true);
    expect(isSafeCardHref("http://APP.LOCALHOST/")).toBe(true);
    expect(isSafeCardHref("https://app.localhost/")).toBe(true);
  });

  it("rejects localhost lookalikes and bare or missing-scheme addresses", () => {
    expect(isSafeCardHref("http://localhost.example.com/")).toBe(false);
    expect(isSafeCardHref("http://evillocalhost/")).toBe(false);
    expect(isSafeCardHref("http://evil-localhost:1355/")).toBe(false);
    expect(isSafeCardHref("http://foo.localhost.evil.com/")).toBe(false);
    expect(isSafeCardHref("http://app.localhost@evil.com/")).toBe(false);
    expect(isSafeCardHref("app.localhost:1355/x")).toBe(false);
    expect(isSafeCardHref("//app.localhost/x")).toBe(false);
  });

  it("rejects public http and non-http schemes", () => {
    expect(isSafeCardHref("http://example.com")).toBe(false);
    expect(isSafeCardHref("javascript:alert(1)")).toBe(false);
    expect(isSafeCardHref("file:///etc/passwd")).toBe(false);
  });
});
