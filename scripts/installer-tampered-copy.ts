import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDigests } from "./installer-reuse.ts";

export const TAMPERED_COPY = "invalid-signature.zip";

/**
 * The installed check's byte-tampered signed copy, made on the checking Mac
 * from the alphaAfter copy instead of uploaded with the others (INF-5571's
 * plan, part 3). Its source zip must match the digest the build recorded
 * before anything is made from it. One byte added to app.asar breaks the
 * app's seal while the new zip's own digest is honest, so the updater's
 * native signature check, not the transport checksum, must refuse it. Its
 * digest joins digests.json, which the local feed reads.
 */
export async function makeTamperedCopy(fixtures: string, version: string, work: string) {
  const source = `Infinitary-${version}-universal.zip`;
  const digestsPath = join(fixtures, "digests.json");
  const digests = JSON.parse(readFileSync(digestsPath, "utf8")) as Record<string, unknown>;
  assert.ok(digests[source], `The fixture digests name no ${source}`);
  assert.equal(digests[TAMPERED_COPY], undefined, "The tampered copy was already made");
  assert.deepEqual(
    await fileDigests(join(fixtures, source)),
    digests[source],
    `The fixture bytes changed: ${source}`,
  );
  const unpacked = mkdtempSync(join(work, "installer-invalid-signature-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", join(fixtures, source), unpacked]);
    appendFileSync(join(unpacked, "Infinitary.app/Contents/Resources/app.asar"), "\n");
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      join(unpacked, "Infinitary.app"),
      join(fixtures, TAMPERED_COPY),
    ]);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
  digests[TAMPERED_COPY] = await fileDigests(join(fixtures, TAMPERED_COPY));
  writeFileSync(digestsPath, JSON.stringify(digests, null, 2));
}
