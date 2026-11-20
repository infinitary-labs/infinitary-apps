import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { keyPin, loadOrCreateHomeIdentity } from "./identity";

describe("the home's key", () => {
  it("is a P-256 key in a self-signed certificate that carries it and verifies with it", () => {
    const dir = join(scratchDir("infinitary-identity-"), "devices");
    const identity = loadOrCreateHomeIdentity(dir);
    const certificate = new X509Certificate(identity.cert);
    const key = createPrivateKey(identity.key);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(certificate.checkPrivateKey(key)).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.subject).toBe("CN=Firstmate home");
    expect(identity.pin).toBe(keyPin(certificate.publicKey));
    expect(identity.pin).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stays the same key across restarts, in files only this macOS user can read", () => {
    const dir = join(scratchDir("infinitary-identity-"), "devices");
    const first = loadOrCreateHomeIdentity(dir);
    expect(loadOrCreateHomeIdentity(dir)).toEqual(first);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "home-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "home-cert.pem")).mode & 0o777).toBe(0o600);
  });

  it("builds a lost certificate again from the saved key, keeping its pin", () => {
    const dir = join(scratchDir("infinitary-identity-"), "devices");
    const first = loadOrCreateHomeIdentity(dir);
    rmSync(join(dir, "home-cert.pem"));
    const again = loadOrCreateHomeIdentity(dir);
    expect(again.pin).toBe(first.pin);
    expect(again.key).toBe(first.key);
    expect(new X509Certificate(again.cert).checkPrivateKey(createPrivateKey(first.key))).toBe(true);
    expect(statSync(join(dir, "home-cert.pem")).mode & 0o777).toBe(0o600);
    expect(loadOrCreateHomeIdentity(dir)).toEqual(again);
  });

  it("refuses a key that does not match its certificate instead of replacing it", () => {
    const dir = join(scratchDir("infinitary-identity-"), "devices");
    loadOrCreateHomeIdentity(dir);
    const other = join(scratchDir("infinitary-identity-other-"), "devices");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(dir, "home-key.pem"), loadOrCreateHomeIdentity(other).key);
    expect(() => loadOrCreateHomeIdentity(dir)).toThrow("does not match");
  });
});
