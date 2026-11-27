import { X509Certificate } from "node:crypto";
import { getCACertificates } from "node:tls";

/**
 * This computer's trusted certificate list, shared by every connection that
 * trusts what the computer trusts rather than Node's bundled list alone:
 * Claude's usage reporting, the usage report's collectors and Amazon
 * Bedrock. Nothing here changes a process-wide setting.
 */

/**
 * Node's codes for a connection that failed while it was being made secure:
 * the server's certificate is not one this computer trusts, or the server
 * turned away the client certificate it was sent or missed.
 */
const SECURE_FAILURE =
  /^(?:ERR_SSL_|ERR_TLS_|UNABLE_TO_)|CERT|CRL|^(?:INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH)$/;

/** Why a request that got no answer failed: it never connected securely, or never connected. */
export function collectorFailureOf(error: unknown): "secure-connection" | "unreachable" {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && SECURE_FAILURE.test(code)
    ? "secure-connection"
    : "unreachable";
}

let readSystemRoots: () => readonly string[] = () => getCACertificates("system");
let systemRoots: { pem: string; endsAt: number }[] | undefined;

/**
 * The computer's trusted list as Claude's client builds it: Node's own list,
 * with any `NODE_EXTRA_CA_CERTS`, and the system's, leaving out system
 * certificates past their end date. Node reads the system's list once per
 * process and keeps it, so a certificate the computer trusts only after the
 * app started is not seen until the app starts again.
 */
export function computerRoots(now = Date.now()): string[] {
  if (!systemRoots) {
    let system: readonly string[] = [];
    try {
      system = readSystemRoots();
    } catch {
      // A system list that cannot be read leaves Node's own.
    }
    systemRoots = system.flatMap((pem) => {
      try {
        return [{ pem, endsAt: new X509Certificate(pem).validToDate.getTime() }];
      } catch {
        return [];
      }
    });
  }
  const current = systemRoots.filter((root) => root.endsAt > now).map((root) => root.pem);
  return [...new Set([...getCACertificates("default"), ...current])];
}

/** Stands a list in for the system's, or restores the real one with none. */
export function useSystemRootsForTests(read?: () => readonly string[]): void {
  readSystemRoots = read ?? (() => getCACertificates("system"));
  systemRoots = undefined;
}
