import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIAGNOSTIC_EVENT_NAMES,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_INSTALL_ID_PATTERN,
  DIAGNOSTIC_VERSION_PATTERN,
  type DiagnosticEvent,
  type DiagnosticFieldSpec,
} from "@shared/diagnostics";
import { transformWithEsbuild } from "vite";
import { describe, expect, it, vi } from "vitest";
import {
  buildDiagnosticBody,
  createTelemetryClient,
  DiagnosticPolicyError,
  diagnosticBodyViolation,
  resolveTelemetryConfig,
} from "./telemetry";

const INSTALL_ID = "3f2b8c1e-5a4d-4e7f-9b21-0c6d8e4f1a27";

/**
 * A release build bakes where Diagnostics go into the main bundle through
 * electron.vite.config.ts's `define`, which replaces only the exact
 * expressions it names. The bug this guards (found in the Infinitary rename,
 * FI3-1790): the build-time reads went through a setting reader, so no
 * expression matched, and every packaged app read its own empty environment
 * at run time and sent nothing.
 */
describe("the build-time Diagnostics destination", () => {
  async function built(env: Record<string, string>): Promise<string> {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    try {
      const config = (await import("../../electron.vite.config")).default as {
        main: { define: Record<string, string> };
      };
      const path = join(__dirname, "telemetry.ts");
      const { code } = await transformWithEsbuild(readFileSync(path, "utf8"), path, {
        define: config.main.define,
      });
      return code;
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("is baked from the release variables under either name", async () => {
    const host = "https://umami.example.test";
    const id = "11111111-2222-3333-4444-555555555555";
    for (const prefix of ["INFINITARY_", "FM3000_"]) {
      const code = await built({
        [`${prefix}UMAMI_HOST`]: host,
        [`${prefix}UMAMI_WEBSITE_ID`]: id,
      });
      expect(code, prefix).toMatch(
        new RegExp(`getBuildTimeUmamiHost\\(\\) \\{\\s+return "${host}"`),
      );
      expect(code, prefix).toMatch(
        new RegExp(`getBuildTimeUmamiWebsiteID\\(\\) \\{\\s+return "${id}"`),
      );
    }
  });
});

describe("resolveTelemetryConfig", () => {
  it("stays disabled without a website id (source and dev builds)", () => {
    expect(resolveTelemetryConfig({ env: {}, buildHost: "", buildWebsiteID: "" }).enabled).toBe(
      false,
    );
  });

  it("enables with a build-time website id and honors the opt-out", () => {
    const enabled = resolveTelemetryConfig({
      env: {},
      buildHost: "https://a.example.com",
      buildWebsiteID: "site-1",
    });
    expect(enabled).toEqual({ enabled: true, host: "https://a.example.com", websiteID: "site-1" });
    const optedOut = resolveTelemetryConfig({
      env: { INFINITARY_TELEMETRY: "off" },
      buildHost: "https://a.example.com",
      buildWebsiteID: "site-1",
    });
    expect(optedOut.enabled).toBe(false);
  });
});

describe("createTelemetryClient", () => {
  it("waits out a slow server by default instead of abandoning the send", async () => {
    // An overloaded Umami answers in seconds; the default bound must outlast that.
    // AbortSignal.timeout runs on the real clock, so this waits for real.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("", { status: 200 })), 2_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        }),
    ) as unknown as typeof fetch;
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      version: "1.0.0",
      fetch: fetchImpl,
    });
    const body = buildDiagnosticBody(
      { websiteID: "site-1", version: "1.0.0" },
      { name: "app_launch", data: {} },
      INSTALL_ID,
      Date.UTC(2026, 8, 22, 15),
    );
    expect(await client.send(body)).toBe(true);
  });

  it("posts an event's body to the endpoint and reports whether it was accepted", async () => {
    const calls: { url: string; body: string; userAgent: string | null }[] = [];
    let status = 200;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        userAgent: new Headers(init?.headers).get("User-Agent"),
      });
      return new Response("", { status });
    }) as unknown as typeof fetch;
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      version: "1.0.0",
      fetch: fetchImpl,
    });
    const body = buildDiagnosticBody(
      { websiteID: "site-1", version: "1.0.0" },
      { name: "app_launch", data: {} },
      INSTALL_ID,
      Date.UTC(2026, 8, 22, 15),
    );
    expect(await client.send(body)).toBe(true);
    status = 500;
    expect(await client.send(body)).toBe(false);
    await client.close();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://a.example.com/api/send");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(body);
    // The header names the build, the same on every install of it.
    expect(calls[0]?.userAgent).toBe("firstmate-3000/1.0.0 telemetry");
  });

  it("refuses, unsent, any body outside the policy - whoever built it", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      version: "1.0.0",
      fetch: fetchImpl,
    });
    const body = buildDiagnosticBody(
      { websiteID: "site-1", version: "1.0.0" },
      { name: "main_agent_turn_end", data: { trigger: "captain" } },
      INSTALL_ID,
      Date.UTC(2026, 8, 22, 15),
    );
    const payload = body.payload as Record<string, unknown>;
    const widened = [
      { ...body, payload: { ...payload, data: { ...(payload.data as object), prompt: "hi" } } },
      {
        ...body,
        payload: { ...payload, data: { trigger: "the captain typed hi", version: "1.0.0" } },
      },
      {
        ...body,
        payload: { ...payload, name: "conversation", url: "app://firstmate-3000/conversation" },
      },
      { ...body, payload: { ...payload, id: "kun@example.com" } },
      { ...body, payload: { ...payload, language: "en-US" } },
      { ...body, extra: true },
    ];
    for (const candidate of widened) {
      expect(diagnosticBodyViolation(candidate)).not.toBeNull();
      expect(await client.send(candidate)).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await client.send(body)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a destination", async () => {
    const client = createTelemetryClient({ enabled: false, host: "", websiteID: "", version: "1" });
    expect(await client.send({})).toBe(false);
  });
});

describe("buildDiagnosticBody", () => {
  it("is Umami's event shape: the event, its fields, the version, the time and the install ID", () => {
    const at = Date.UTC(2026, 8, 22, 23, 59, 30, 250);
    const body = buildDiagnosticBody(
      { websiteID: "site-1", version: "0.1.0" },
      { name: "main_agent_turn_failed", data: { trigger: "operation", reason: "time_limit" } },
      INSTALL_ID,
      at,
    );
    expect(body).toEqual({
      type: "event",
      payload: {
        website: "site-1",
        hostname: "app",
        title: "Firstmate 3000",
        url: "app://firstmate-3000/main_agent_turn_failed",
        name: "main_agent_turn_failed",
        data: { trigger: "operation", reason: "time_limit", version: "0.1.0" },
        timestamp: Math.floor(at / 1000),
        // Umami 3.1 makes the session uuid(website, id): one per install.
        id: INSTALL_ID,
      },
    });
  });

  // INF-2631: a phone's event goes under the phone's names on the same site, and the wire holds each
  // event to its own pair, so neither series can borrow the other's.
  it("puts a phone's event under hostname ios and title Infinitary, and refuses the names swapped", () => {
    const at = Date.UTC(2026, 10, 5, 8);
    const body = buildDiagnosticBody(
      { websiteID: "site-1", version: "0.1.0" },
      { name: "ios_launch", data: { device: "ipad" } },
      INSTALL_ID,
      at,
    );
    const payload = body.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      hostname: "ios",
      title: "Infinitary",
      url: "app://infinitary-ios/ios_launch",
      data: { device: "ipad", version: "0.1.0" },
    });
    const computer = buildDiagnosticBody(
      { websiteID: "site-1", version: "0.1.0" },
      { name: "app_launch", data: {} },
      INSTALL_ID,
      at,
    ).payload as Record<string, unknown>;
    for (const swapped of [
      { ...payload, hostname: "app", title: "Firstmate 3000" },
      { ...payload, url: "app://firstmate-3000/ios_launch" },
      { ...computer, hostname: "ios", title: "Infinitary" },
    ])
      expect(diagnosticBodyViolation({ ...body, payload: swapped })).not.toBeNull();
  });

  it("throws rather than build a body outside the policy", () => {
    const config = { websiteID: "site-1", version: "0.1.0" };
    const at = Date.UTC(2026, 8, 22);
    expect(() =>
      buildDiagnosticBody(config, { name: "app_launch", data: {} }, "not-an-id", at),
    ).toThrow(DiagnosticPolicyError);
    expect(() =>
      buildDiagnosticBody(
        { ...config, version: "my laptop" },
        { name: "app_launch", data: {} },
        INSTALL_ID,
        at,
      ),
    ).toThrow(DiagnosticPolicyError);
    expect(() =>
      buildDiagnosticBody(
        config,
        // A caller that escapes the types still cannot widen the body.
        { name: "app_launch", data: { path: "/Users/kun" } } as never,
        INSTALL_ID,
        at,
      ),
    ).toThrow(DiagnosticPolicyError);
  });
});

describe("every body the allowlist can produce", () => {
  function valuesOf(spec: DiagnosticFieldSpec): unknown[] {
    if (spec.type === "enum") return [...spec.values];
    if (spec.type === "boolean") return [true, false];
    return [0, 1, 2.5];
  }

  /** The Cartesian product of an event's fields' values: every data it can carry. */
  function everyData(fields: Record<string, DiagnosticFieldSpec>): Record<string, unknown>[] {
    return Object.entries(fields).reduce<Record<string, unknown>[]>(
      (sets, [field, spec]) =>
        sets.flatMap((set) => valuesOf(spec).map((value) => ({ ...set, [field]: value }))),
      [{}],
    );
  }

  it("carries only the fixed payload keys, allowlisted enum/boolean/number/version data and the install ID", () => {
    let built = 0;
    for (const name of DIAGNOSTIC_EVENT_NAMES) {
      const fields: Record<string, DiagnosticFieldSpec> = DIAGNOSTIC_EVENTS[name].fields;
      for (const data of everyData(fields)) {
        const body = buildDiagnosticBody(
          { websiteID: "site-1", version: "0.1.0" },
          { name, data } as DiagnosticEvent,
          INSTALL_ID,
          Date.UTC(2026, 8, 22, 9),
        );
        built += 1;
        expect(diagnosticBodyViolation(body)).toBeNull();
        expect(Object.keys(body).sort()).toEqual(["payload", "type"]);
        const payload = body.payload as Record<string, unknown>;
        expect(Object.keys(payload).sort()).toEqual([
          "data",
          "hostname",
          "id",
          "name",
          "timestamp",
          "title",
          "url",
          "website",
        ]);
        expect(payload.id).toMatch(DIAGNOSTIC_INSTALL_ID_PATTERN);
        const carried = payload.data as Record<string, unknown>;
        expect(Object.keys(carried).sort()).toEqual([...Object.keys(fields), "version"].sort());
        expect(carried.version).toMatch(DIAGNOSTIC_VERSION_PATTERN);
        for (const [field, spec] of Object.entries(fields)) {
          const value = carried[field];
          if (spec.type === "enum") expect(spec.values).toContain(value);
          else expect(typeof value).toBe(spec.type);
        }
      }
    }
    // Every event, every enum word: a new field or value is exercised here too.
    expect(built).toBeGreaterThan(DIAGNOSTIC_EVENT_NAMES.length);
  });
});
