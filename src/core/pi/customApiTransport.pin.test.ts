import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createCustomApiTransport } from "./customApiTransport";

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
}));
vi.mock("node:https", () => ({ request: fixture.request }));
beforeEach(() => {
  const home = scratchDir("custom-api-pin-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(home, "signing"));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("pins checked public DNS without losing the host or permitting global trust/agent reuse", async () => {
  const native = new EventEmitter();
  Object.assign(native, { end: vi.fn(), destroy: vi.fn() });
  fixture.request.mockReturnValue(native);
  const resolve = vi.fn().mockResolvedValue(["8.8.8.8", "8.8.4.4"]);
  const client = createCustomApiTransport(
    {
      baseUrl: "https://approved.example.com:8443/proxy/v1",
      mode: "public",
      credential: { kind: "bearer", key: "synthetic" },
    },
    resolve,
  );
  const pending = client.request("models");
  // Resolve the in-memory DNS before examining the native socket options.
  await Promise.resolve();
  expect(fixture.request).toHaveBeenCalledTimes(1);
  const [url, options] = fixture.request.mock.calls[0] as [URL, RequestOptions];
  expect(url.href).toBe("https://approved.example.com:8443/proxy/v1/models");
  expect(options).toMatchObject({
    agent: false,
    autoSelectFamily: true,
    rejectUnauthorized: true,
    ca: [...rootCertificates],
  });
  expect(options.family).toBeUndefined();
  const resolved: unknown[] = [];
  const resolvedAll: unknown[] = [];
  if (!options.lookup) throw new Error("Missing pinned lookup");
  options.lookup("approved.example.com", {}, (...args: unknown[]) => resolved.push(...args));
  expect(resolved).toEqual([null, "8.8.8.8", 4]);
  // Node's multi-address connect gets only the checked answers, in their order.
  options.lookup("approved.example.com", { all: true }, (...args: unknown[]) =>
    resolvedAll.push(...args),
  );
  expect(resolvedAll).toEqual([
    null,
    [
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.4.4", family: 4 },
    ],
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  client.close();
  await expect(pending).rejects.toMatchObject({ category: "closed" });
  console.info(
    "CUSTOM_API_PIN",
    JSON.stringify({
      host: url.host,
      dnsCalls: resolve.mock.calls.length,
      checkedAddress: resolved[1],
      certificateVerification: options.rejectUnauthorized,
      privateAgent: options.agent === false,
    }),
  );
});

it("sanitizes TLS and network errors before a raw error can become a session failure", async () => {
  const native = new EventEmitter();
  Object.assign(native, { end: vi.fn(), destroy: vi.fn() });
  fixture.request.mockReturnValue(native);
  const client = createCustomApiTransport(
    {
      baseUrl: "https://approved.example.com/v1",
      mode: "public",
      credential: { kind: "bearer", key: "opaque-synthetic-secret" },
    },
    async () => ["8.8.8.8"],
  );
  const pending = client.request("models");
  await Promise.resolve();
  native.emit(
    "error",
    Object.assign(new Error("opaque-synthetic-secret https://unsafe.invalid"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    }),
  );
  const error = await pending.catch((error: unknown) => error);
  expect(error).toMatchObject({ category: "certificate" });
  expect(String(error)).not.toContain("opaque-synthetic-secret");
  expect(error).not.toHaveProperty("cause");
  client.close();
});
