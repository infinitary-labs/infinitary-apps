import { createServer, type RequestOptions, type Server } from "node:https";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { customApiCaFixture } from "../../../tests/helpers/customApiCaFixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  approvedCustomApiCertificates,
  reviewCustomApiCertificates,
} from "./customApiCertificates";
import { type CustomConnectionCandidate, customModelFingerprint } from "./customApiCheck";
import { type CustomApiTransport, createCustomApiTransport } from "./customApiTransport";

const wire = vi.hoisted(() => ({ pinned: [] as string[] }));
// Policy still validates/pins a private address. Only this test's socket
// connector substitutes loopback so no fixture reaches an actual private host.
// Host/SNI, TLS roots, hostname, chain and expiry verification are untouched.
vi.mock("node:https", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:https")>();
  return {
    ...native,
    request: (
      url: URL,
      options: RequestOptions,
      callback: Parameters<typeof native.request>[2],
    ) => {
      if (!options.lookup) throw new Error("Production request must pin DNS");
      options.lookup(url.hostname, {}, (_error, address) => {
        if (typeof address !== "string") throw new Error("Missing single pinned address");
        wire.pinned.push(address);
        if (address !== "10.23.4.5")
          throw new Error("Test connector received an unapproved address");
      });
      return native.request(
        url,
        { ...options, lookup: (_host, _opts, done) => done(null, "127.0.0.1", 4) },
        callback,
      );
    },
  };
});

let dir: string;
let ca: string;
let otherCa: string;
let leaf: string;
let leafKey: string;
let expired: string;
const servers: Server[] = [];
const transports: CustomApiTransport[] = [];

beforeAll(() => {
  dir = scratchDir("custom-ca-home-");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("INFINITARY_LOCAL_CODESIGN_DIR", join(dir, "signing"));
  ({ ca, otherCa, leaf, leafKey, expired } = customApiCaFixture(dir));
}, 15_000);

afterAll(async () => {
  for (const client of transports) client.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

async function fixture(cert = leaf) {
  const server = createServer({ key: leafKey, cert }, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"data":[{"id":"synthetic-model"}]}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `https://gateway.example.test:${address.port}/operator`;
}
function approval(pem = ca) {
  return {
    pem,
    fingerprints: reviewCustomApiCertificates(pem).map((certificate) => certificate.fingerprint),
  };
}
function client(baseUrl: string, approved?: ReturnType<typeof approval>) {
  const result = createCustomApiTransport(
    {
      baseUrl,
      mode: "private",
      credential: { kind: "bearer", key: "synthetic-only" },
      ...(approved ? { certificates: approved } : {}),
    },
    async () => ["10.23.4.5"],
  );
  transports.push(result);
  return result;
}

it("reviews bounded public CA identities and refuses keys, leaf certificates, duplicates and mismatched approval", () => {
  const view = reviewCustomApiCertificates(ca);
  expect(view).toHaveLength(1);
  expect(view[0]).toMatchObject({
    subject: "CN=Firstmate synthetic CA",
    fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
  });
  for (const material of [
    leafKey,
    `${ca}\n${leafKey}`,
    leaf,
    `${ca}\n${ca}`,
    "garbage",
    "x".repeat(64 * 1024 + 1),
  ]) {
    expect(() => reviewCustomApiCertificates(material)).toThrow();
  }
  expect(() =>
    approvedCustomApiCertificates({ pem: ca, fingerprints: ["wrong"] }, "private"),
  ).toThrow();
  expect(() => approvedCustomApiCertificates(approval(), "public")).toThrow();
  expect(() => approvedCustomApiCertificates(approval(), "local")).toThrow();
  expect(approvedCustomApiCertificates(approval(), "private")).toHaveLength(1);
});

it("keeps actual TLS trust scoped with normal hostname, chain and expiry validation", async () => {
  const beforeRoots = [...rootCertificates];
  const base = await fixture();
  const trusted = client(base, approval());
  expect(await (await trusted.request("models")).json()).toEqual({
    data: [{ id: "synthetic-model" }],
  });
  await expect(client(base).request("models")).rejects.toMatchObject({ category: "certificate" });
  await expect(client(base, approval(otherCa)).request("models")).rejects.toMatchObject({
    category: "certificate",
  });
  await expect(
    client(base.replace("gateway.example.test", "wrong.example.test"), approval()).request(
      "models",
    ),
  ).rejects.toMatchObject({ category: "certificate" });
  await expect(client(await fixture(expired), approval()).request("models")).rejects.toMatchObject({
    category: "certificate",
  });
  expect(rootCertificates).toEqual(beforeRoots);
  expect(wire.pinned.every((address) => address === "10.23.4.5")).toBe(true);
  console.info(
    "CUSTOM_API_SCOPED_TLS",
    JSON.stringify({
      approved: true,
      untrustedRefused: true,
      siblingCaRefused: true,
      wrongNameRefused: true,
      expiredRefused: true,
      globalRootsUnchanged: true,
      socketConnectorOnly: "fixture loopback",
      productionPinnedAddress: "10.23.4.5",
    }),
  );
});

it("public material can restart under the same approval, removal/replacement changes proof and closing is terminal", async () => {
  const base = await fixture();
  const saved = JSON.stringify(approval());
  const restarted = client(base, JSON.parse(saved));
  expect(await (await restarted.request("models")).json()).toHaveProperty("data");
  const config: CustomConnectionCandidate = {
    baseUrl: base,
    mode: "private",
    credential: { kind: "bearer", key: "synthetic-only" },
    credentialRevision: "key-1",
    certificates: approval(),
    protocol: "openai-completions",
    model: "synthetic-model",
    limits: { context: 8192, output: 512 },
    storage: { kind: "no-store" },
  };
  const fingerprint = customModelFingerprint(config);
  expect(customModelFingerprint({ ...config, certificates: undefined })).not.toBe(fingerprint);
  expect(customModelFingerprint({ ...config, certificates: approval(otherCa) })).not.toBe(
    fingerprint,
  );
  restarted.close();
  await expect(restarted.request("models")).rejects.toMatchObject({ category: "closed" });
  await expect(client(base).request("models")).rejects.toMatchObject({ category: "certificate" });
});
