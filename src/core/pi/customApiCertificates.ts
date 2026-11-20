import { X509Certificate } from "node:crypto";
import { cutText } from "@shared/textCut";
import { CustomApiError, type CustomNetworkMode } from "./customApiPolicy";

const MAX_PEM_BYTES = 64 * 1024;
const MAX_CERTIFICATES = 8;

export type CustomCertificateView = {
  subject: string;
  issuer: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
};

/** Public material only. Review is local, bounded and sends no requests. */
export function reviewCustomApiCertificates(pem: string): CustomCertificateView[] {
  return parseCertificates(pem).map((certificate) => ({
    subject: safeIdentity(certificate.subject),
    issuer: safeIdentity(certificate.issuer),
    fingerprint: certificate.fingerprint256,
    validFrom: certificate.validFromDate.toISOString(),
    validTo: certificate.validToDate.toISOString(),
  }));
}

export type CustomCertificateApproval = {
  pem: string;
  /** The identities reviewed and explicitly approved for this connection. */
  fingerprints: readonly string[];
};

/** No global trust edits, remote downloads, client keys or certificate bypass. */
export function approvedCustomApiCertificates(
  approval: CustomCertificateApproval | undefined,
  mode: CustomNetworkMode,
): string[] {
  if (!approval) return [];
  if (mode !== "private") throw new CustomApiError("certificate-policy");
  const certificates = parseCertificates(approval.pem);
  const actual = certificates.map((certificate) => certificate.fingerprint256);
  if (
    actual.length !== approval.fingerprints.length ||
    actual.some((fingerprint, index) => fingerprint !== approval.fingerprints[index])
  ) {
    throw new CustomApiError("certificate-policy");
  }
  return certificates.map((certificate) => certificate.toString());
}

function parseCertificates(pem: string): X509Certificate[] {
  if (typeof pem !== "string" || Buffer.byteLength(pem) > MAX_PEM_BYTES) {
    throw new CustomApiError("certificate-policy");
  }
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (
    blocks.length === 0 ||
    blocks.length > MAX_CERTIFICATES ||
    pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
  ) {
    throw new CustomApiError("certificate-policy");
  }
  try {
    const certificates = blocks.map((block) => new X509Certificate(block));
    const now = Date.now();
    if (
      certificates.some(
        (certificate) =>
          !certificate.ca ||
          certificate.validFromDate.getTime() > now ||
          certificate.validToDate.getTime() <= now,
      ) ||
      new Set(certificates.map((certificate) => certificate.fingerprint256)).size !==
        certificates.length
    ) {
      throw new CustomApiError("certificate-policy");
    }
    return certificates;
  } catch {
    // Native certificate parsing errors can quote submitted material.
    throw new CustomApiError("certificate-policy");
  }
}

function safeIdentity(identity: string): string {
  // Identity is shown as text by callers, never markup, a URL or an action.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Certificate identity is untrusted display text.
  return cutText(identity.replace(/[\u0000-\u001f\u007f]/g, " "), 512);
}
