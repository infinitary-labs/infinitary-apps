import type { X509Certificate } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { certificateCleanup, signingFingerprints } from "../scripts/phone-certificates";
import type { AppleRead } from "../scripts/phone-release";
import { phoneCertificateFixture } from "./helpers/phoneCertificateFixture";

// INF-259: only release-key API certificates, not a job signer, older than a day,
// on the Mac mini. Real public X.509 fixtures; no private key or keychain access.
let certificates: Record<string, X509Certificate>;
beforeAll(() => {
  certificates = phoneCertificateFixture();
});
function cert(name: string) {
  return certificates[name]!;
}
function record(id: string, name = "api") {
  return {
    id,
    type: "certificates",
    attributes: {
      certificateType: "DEVELOPMENT",
      certificateContent: cert(name).raw.toString("base64"),
    },
  };
}
const archiveIdentity = "AEBD27AB15EDB3547EF82E2E8025D54BA1F849A1";
const signing = (fingerprint: string) =>
  `/usr/bin/codesign --force --sign ${fingerprint} --generate-entitlement-der /archive/Infinitary.app\n`;
function options(read: AppleRead) {
  return {
    runner: "mini-mac",
    keyId: "A1B2C3D4E5",
    archiveLog: signing(archiveIdentity),
    exportLog: "",
    read,
    now: cert("api").validFromDate.getTime() + 48 * 60 * 60 * 1000,
  };
}

describe("INF-259 safe certificate cleanup", () => {
  it("lists an old key-made certificate without revoking, and keeps personal, other-key and distribution certificates", async () => {
    const calls: string[] = [];
    const result = await certificateCleanup(
      options(async (path) => {
        calls.push(path);
        return {
          data: [
            record("old-api"),
            record("personal", "person"),
            record("different-key", "other-key"),
            {
              ...record("distribution"),
              attributes: { ...record("distribution").attributes, certificateType: "DISTRIBUTION" },
            },
          ],
        };
      }),
    );
    expect(calls).toEqual(["/v1/certificates?filter[certificateType]=DEVELOPMENT&limit=200"]);
    expect(result).toEqual([
      "Certificate cleanup: list-only; no certificates revoked.",
      `Would revoke: old-api; SHA-1 ${cert("api").fingerprint.replaceAll(":", "")}; valid from ${cert("api").validFromDate.toISOString()}`,
      "1 eligible development certificate(s).",
    ]);
  });
  it.each(["archive", "export"])(
    "protects a certificate actually used in %s even when a later target uses another signer",
    async (phase) => {
      const fingerprint = cert("api").fingerprint.replaceAll(":", "");
      const input = options(async () => ({ data: [record("signer")] }));
      input[phase === "archive" ? "archiveLog" : "exportLog"] +=
        signing(fingerprint.toLowerCase()) + signing(archiveIdentity);
      expect((await certificateCleanup(input)).at(-1)).toBe(
        "0 eligible development certificate(s).",
      );
    },
  );
  it.each([0, 24 * 60 * 60 * 1000, -1000])(
    "keeps certificates at or below the one-day boundary (%s)",
    async (age) => {
      const input = options(async () => ({ data: [record("recent")] }));
      input.now = cert("api").validFromDate.getTime() + age;
      expect((await certificateCleanup(input)).at(-1)).toBe(
        "0 eligible development certificate(s).",
      );
    },
  );
  it.each(["macos-15", "", "mini-macbook"])("does not read Apple from %s", async (runner) => {
    const input = {
      ...options(async () => {
        throw new Error("Must not read");
      }),
      runner,
    };
    expect((await certificateCleanup(input)).at(-1)).toBe("Skipped: not the Mac mini runner.");
  });
  it("fails closed without archive signing, even if export has an identity", async () => {
    const input = {
      ...options(async () => {
        throw new Error("Must not read");
      }),
      archiveLog: "unsigned archive",
      exportLog: signing(archiveIdentity),
    };
    expect((await certificateCleanup(input)).at(-1)).toContain("no archive signing fingerprint");
    expect(signingFingerprints("codesign --sign - /app")).toEqual(new Set());
  });
  it("collects every page before an explicitly supplied revoker is called", async () => {
    const events: string[] = [];
    const input = options(async (path) => {
      events.push(path);
      return path.includes("cursor")
        ? { data: [record("personal", "person")] }
        : { data: [record("old-api")], links: { next: "/v1/certificates?cursor=2" } };
    });
    const result = await certificateCleanup({
      ...input,
      revoke: async (id) => {
        events.push(`revoke:${id}`);
      },
    });
    expect(events).toEqual([
      "/v1/certificates?filter[certificateType]=DEVELOPMENT&limit=200",
      "/v1/certificates?cursor=2",
      "revoke:old-api",
    ]);
    expect(result[1]).toContain("Revoked: old-api;");
  });
  it.each(["malformed", "duplicate", "unending", "failed-read"])(
    "revokes nothing on a %s listing",
    async (failure) => {
      const revoked: string[] = [];
      let page = 0;
      const input = options(async () => {
        page++;
        if (page === 1)
          return { data: [record("old-api")], links: { next: "/v1/certificates?cursor=2" } };
        if (failure === "failed-read") throw new Error("Apple unavailable");
        if (failure === "duplicate") return { data: [record("old-api")] };
        if (failure === "unending")
          return { data: [], links: { next: "/v1/certificates?cursor=2" } };
        return {
          data: [
            {
              ...record("broken"),
              attributes: {
                certificateType: "DEVELOPMENT",
                certificateContent: "not a certificate",
              },
            },
          ],
        };
      });
      await expect(
        certificateCleanup({
          ...input,
          revoke: async (id) => {
            revoked.push(id);
          },
        }),
      ).rejects.toThrow();
      expect(revoked).toEqual([]);
    },
  );
});
