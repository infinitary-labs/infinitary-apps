/** INF-259: four-condition cleanup. The release entry point is list-only pending captain review. */
import { X509Certificate } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AppleRead, appleReader, resolveRelease } from "./phone-release.ts";

const DAY = 24 * 60 * 60 * 1000;

// Keep every identity seen, including nested targets and export re-signing.
// A missing archive identity fails closed, even if export printed one.
export function signingFingerprints(log: string): Set<string> {
  return new Set(Array.from(log.matchAll(/\b(?:\/\S*\/)?codesign\s+[^\r\n]*?--sign\s+([a-f\d]{40})(?=\s|$)/gi),
    (match) => match[1]!.toUpperCase()));
}

export async function certificateCleanup(options: {
  runner: string;
  keyId: string;
  archiveLog: string;
  exportLog: string;
  read: AppleRead;
  now?: number;
  // No production caller supplies this. Enabling it requires a reviewed code change
  // after the captain reads the first real list, not a workflow input or variable.
  revoke?: (id: string) => Promise<void>;
}): Promise<string[]> {
  const lines = [options.revoke ? "Certificate cleanup: revoke mode." : "Certificate cleanup: list-only; no certificates revoked."];
  if (!/^mini-mac(?:-|$)/.test(options.runner)) return [...lines, "Skipped: not the Mac mini runner."];
  const signers = signingFingerprints(options.archiveLog);
  if (!signers.size) return [...lines, "Skipped: no archive signing fingerprint; no candidates selected."];
  for (const signer of signingFingerprints(options.exportLog)) signers.add(signer);
  if (!/^[A-Z0-9]{10}$/.test(options.keyId)) throw new Error("Missing release key identity; cleanup refused.");
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("Missing cleanup clock.");
  const candidates: { id: string; fingerprint: string; start: string }[] = [];
  const seen = new Set<string>();
  let next: string | null | undefined = "/v1/certificates?filter[certificateType]=DEVELOPMENT&limit=200";
  // Finish validating the entire list before allowing any mutation.
  for (let page = 0; next && page < 10; page++) {
    const answer = await options.read(next);
    for (const item of answer.data) {
      if (item.type !== "certificates" || !/^[a-z\d-]+$/i.test(item.id) || seen.has(item.id)) throw new Error("Ambiguous certificate list; cleanup refused.");
      seen.add(item.id);
      if (item.attributes?.certificateType !== "DEVELOPMENT") continue;
      const content = item.attributes.certificateContent;
      if (typeof content !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error("Unreadable certificate; cleanup refused.");
      const certificate = new X509Certificate(Buffer.from(content, "base64"));
      // Parse Node's structured subject, not Apple's undocumented name/displayName.
      const subject = certificate.toLegacyObject().subject;
      if (subject.CN !== `Apple Development: Created via API (${options.keyId})`) continue;
      const fingerprint = certificate.fingerprint.replaceAll(":", "");
      if (signers.has(fingerprint)) continue;
      const start = certificate.validFromDate.getTime();
      if (!Number.isFinite(start) || now - start <= DAY) continue;
      candidates.push({ id: item.id, fingerprint, start: certificate.validFromDate.toISOString() });
    }
    next = answer.links?.next;
  }
  if (next) throw new Error("Incomplete certificate list; cleanup refused.");
  for (const candidate of candidates) {
    if (options.revoke) await options.revoke(candidate.id);
    lines.push(`${options.revoke ? "Revoked" : "Would revoke"}: ${candidate.id}; SHA-1 ${candidate.fingerprint}; valid from ${candidate.start}`);
  }
  lines.push(`${candidates.length} eligible development certificate(s).`);
  return lines;
}

async function main() {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== "true" || resolveRelease(env).mode !== "release") throw new Error("Cleanup runs only after a dispatched release upload.");
  const receipt = JSON.parse(readFileSync(env.PHONE_RECEIPT ?? "", "utf8"));
  const release = resolveRelease(env);
  if (receipt.upload !== "accepted" || receipt.source_commit !== release.source_commit || receipt.build_number !== release.build_number || receipt.version !== release.version) throw new Error("No accepted upload receipt for this job; cleanup refused.");
  const lines = await certificateCleanup({
    runner: env.RUNNER_NAME ?? "",
    keyId: env.APP_STORE_CONNECT_KEY_ID ?? "",
    archiveLog: readFileSync(process.argv[2] ?? "", "utf8"),
    exportLog: readFileSync(process.argv[3] ?? "", "utf8"),
    read: appleReader(env),
  });
  const output = lines.join("\n") + "\n";
  process.stdout.write(output);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Development certificate cleanup\n\n\`\`\`text\n${output}\`\`\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Never print Apple's content or credential material, and never change the accepted upload outcome.
    console.error("Certificate listing failed; no certificates revoked. Review the cleanup before enabling revocation.");
    process.exitCode = 1;
  });
}
