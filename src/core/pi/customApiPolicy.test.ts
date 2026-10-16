import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  assertCustomApiAddresses,
  assertCustomHeaders,
  assertLiteralBearerKey,
  CustomApiError,
  classifyCustomApiAddresses,
  normalizeCustomApiBase,
} from "./customApiPolicy";

beforeEach(() => {
  const home = scratchDir("custom-api-policy-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
});
afterEach(() => vi.unstubAllEnvs());

describe("custom destination approval", () => {
  it("preserves the operator's base path without guessing /v1", () => {
    expect(normalizeCustomApiBase(" HTTPS://API.Example.com:443/proxy/v1/ ", "public")).toEqual({
      baseUrl: "https://api.example.com/proxy/v1",
      hostname: "api.example.com",
      mode: "public",
    });
    expect(normalizeCustomApiBase("http://[::1]:11434", "local").baseUrl).toBe(
      "http://[::1]:11434",
    );
    expect(normalizeCustomApiBase("https://10.0.0.2/v1", "private").hostname).toBe("10.0.0.2");
    expect(normalizeCustomApiBase("https://example.com/v1///", "public").baseUrl).toBe(
      "https://example.com/v1",
    );
  });

  it.each([
    "https://secret@example.com/v1",
    "https://example.com/v1?",
    "https://example.com/v1#",
    "https://example.com/%2e/v1",
    "https://example.com/прокси/v1",
    "https://example.com/a/../v1",
    "https://example.com/a//v1",
    "https://example.com\\evil/v1",
    "ftp://example.com/v1",
    "https:example.com",
    "https://127.1/v1",
    "https://2130706433/v1",
    "https://0x7f000001/v1",
    "https://0177.0.0.1/v1",
  ])("refuses ambiguous or unsafe base %s without repeating it", (url) => {
    expect(() => normalizeCustomApiBase(url, "public")).toThrow(CustomApiError);
    try {
      normalizeCustomApiBase(url, "public");
    } catch (error) {
      expect(String(error)).not.toContain(url);
    }
  });

  it("accepts HTTP in each approved network class, never metadata or cross-class addresses", () => {
    for (const [mode, address] of [
      ["public", "8.8.8.8"],
      ["private", "10.20.30.40"],
      ["private", "100.64.1.2"],
      ["private", "[fd01::2]"],
      ["local", "127.0.0.1"],
    ] as const) {
      expect(normalizeCustomApiBase(`http://${address}:4000/proxy/v1`, mode).baseUrl).toBe(
        `http://${address}:4000/proxy/v1`,
      );
    }
    expect(() => normalizeCustomApiBase("http://10.0.0.1", "public")).toThrow(CustomApiError);
    expect(() => normalizeCustomApiBase("http://8.8.8.8", "private")).toThrow(CustomApiError);
    for (const mode of ["public", "private"] as const) {
      expect(() => normalizeCustomApiBase("http://169.254.169.254", mode)).toThrow(CustomApiError);
    }
  });

  it("offers an operation-free suggestion, never silently rewrites", () => {
    for (const suffix of ["models", "responses", "chat/completions"]) {
      try {
        normalizeCustomApiBase(`https://example.com/proxy/v1/${suffix}/`, "public");
        expect.fail("Operation URL accepted");
      } catch (error) {
        expect(error).toMatchObject({
          category: "address",
          baseSuggestion: "https://example.com/proxy/v1",
        });
      }
    }
  });

  it("local addresses accept names but retain exact explicit local IP forms", () => {
    for (const url of ["http://127.1/v1", "http://[0:0:0:0:0:0:0:1]/v1", "http://10.0.0.1/v1"]) {
      expect(() => normalizeCustomApiBase(url, "local")).toThrow(CustomApiError);
    }
    expect(normalizeCustomApiBase("http://LOCALHOST:1234/v1", "local").hostname).toBe("localhost");
    for (const scheme of ["http", "https"]) {
      expect(
        normalizeCustomApiBase(`${scheme}://claude.local.dev.bla.net:9123/v1`, "local"),
      ).toEqual({
        baseUrl: `${scheme}://claude.local.dev.bla.net:9123/v1`,
        hostname: "claude.local.dev.bla.net",
        mode: "local",
      });
    }
  });

  it("enforces public, private/VPN and loopback classes including mapped addresses", () => {
    assertCustomApiAddresses(["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"], "public");
    assertCustomApiAddresses(
      ["10.0.0.1", "172.16.4.5", "192.168.2.3", "100.64.1.2", "fd01::2", "::ffff:10.0.0.1"],
      "private",
    );
    assertCustomApiAddresses(["127.0.0.1", "::1"], "local");
    for (const ip of ["10.0.0.1", "100.64.1.2", "fd01::2", "::ffff:10.0.0.1", "127.0.0.1", "::1"]) {
      expect(() => assertCustomApiAddresses([ip], "public")).toThrow(CustomApiError);
    }
    expect(() => assertCustomApiAddresses(["8.8.8.8"], "private")).toThrow(CustomApiError);
    expect(() => assertCustomApiAddresses(["127.0.0.1", "8.8.8.8"], "local")).toThrow(
      CustomApiError,
    );
    expect(() => assertCustomApiAddresses(["8.8.8.8", "10.0.0.1"], "public")).toThrow(
      CustomApiError,
    );
    expect(() => assertCustomApiAddresses([], "public")).toThrow(CustomApiError);
  });

  it.each([
    "0.0.0.0",
    "169.254.169.254",
    "100.100.100.200",
    "168.63.129.16",
    "fd00:ec2::254",
    "fd20:ce::254",
    "224.0.0.1",
    "240.0.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "::",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("refuses reserved, metadata and transition destination %s in every mode", (ip) => {
    for (const mode of ["public", "private", "local"] as const) {
      expect(() => assertCustomApiAddresses([ip], mode)).toThrow(CustomApiError);
    }
  });
});

describe("a network read from DNS answers", () => {
  it("is the one class every answer belongs to", () => {
    expect(classifyCustomApiAddresses(["127.0.0.1", "::1"])).toBe("local");
    expect(classifyCustomApiAddresses(["10.1.2.3", "fd00::5"])).toBe("private");
    expect(classifyCustomApiAddresses(["100.64.0.9"])).toBe("private");
    expect(classifyCustomApiAddresses(["93.184.216.34", "2606:2800:220:1::1"])).toBe("public");
  });

  it("has none for mixed, forbidden or missing answers", () => {
    for (const answers of [
      ["127.0.0.1", "10.1.2.3"],
      ["10.1.2.3", "93.184.216.34"],
      ["169.254.169.254"],
      ["0.0.0.0"],
      ["100.100.100.200"],
      [],
    ])
      expect(() => classifyCustomApiAddresses(answers)).toThrow(CustomApiError);
  });
});

describe("literal credentials", () => {
  it("accepts opaque command/environment-looking data without interpreting it", () => {
    for (const key of [
      "$(touch /not-a-command)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This synthetic credential must stay literal, not reference the environment.
      "${OTHER_KEY}",
      "!do-not-execute",
      "opaque-key",
    ]) {
      expect(() => assertLiteralBearerKey(key)).not.toThrow();
    }
  });
  it.each([
    "",
    " key",
    "key ",
    "key\r\nInjected: value",
    "key\0",
    "key\t",
    "keyé",
    "x".repeat(8193),
  ])("refuses header-unsafe values", (key) => {
    expect(() => assertLiteralBearerKey(key)).toThrow(CustomApiError);
  });
});

describe("extra request headers", () => {
  const header = (name: string, value = "synthetic-value") => ({ name, value });
  it("accepts literal token names and one-line values, Authorization only without a key", () => {
    expect(() =>
      assertCustomHeaders(
        [
          header("X-Org-Id", "acme-eu"),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: A header value stays literal, never an environment reference.
          header("X-Gateway-Token", "$(not-a-command) ${NOT_AN_ENV_REFERENCE}"),
          header("cf-access-client-id"),
        ],
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertCustomHeaders([header("Authorization", "Basic c3ludGhldGlj")], false),
    ).not.toThrow();
    expect(() =>
      assertCustomHeaders([header("Authorization", "Basic c3ludGhldGlj")], true),
    ).toThrow(CustomApiError);
  });
  it.each([
    "Host",
    "content-length",
    "Content-Type",
    "Accept",
    "Accept-Encoding",
    "Connection",
    "Transfer-Encoding",
    "TE",
    "Upgrade",
    "Expect",
    "Proxy-Authorization",
    "X Org",
    "X-Org:",
    "",
    "x".repeat(129),
  ])("refuses the name %j", (name) => {
    expect(() => assertCustomHeaders([header(name)], false)).toThrow(CustomApiError);
  });
  it.each([
    "",
    " value",
    "value ",
    "value\r\nInjected: value",
    "value\0",
    "valueé",
    "x".repeat(8193),
  ])("refuses an unsafe value %#", (value) => {
    expect(() => assertCustomHeaders([header("X-Org-Id", value)], true)).toThrow(CustomApiError);
  });
  it("refuses a repeated name in any case and more than twenty headers", () => {
    expect(() => assertCustomHeaders([header("X-Org-Id"), header("x-org-id")], true)).toThrow(
      CustomApiError,
    );
    const many = Array.from({ length: 21 }, (_, at) => header(`X-Header-${at}`));
    expect(() => assertCustomHeaders(many.slice(0, 20), true)).not.toThrow();
    expect(() => assertCustomHeaders(many, true)).toThrow(CustomApiError);
  });
});
