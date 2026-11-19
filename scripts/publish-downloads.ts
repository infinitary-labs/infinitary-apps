import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { publicDigest, ReleaseStorage } from "./release-storage.mjs";

// INF-1620: finalized private-record bytes become immutable downloads before any feed moves.
// The release workflow runs its own copy, whatever the release's source commit
// holds, so it reads the configuration beside itself (docs/alpha.md).
const configuration = JSON.parse(readFileSync(new URL("../packaging/release-source.json", import.meta.url), "utf8"));
const version = process.env.VERSION;
if (!/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(version ?? "")) throw new Error("Invalid release version");
const storage = ReleaseStorage.fromEnvironment();
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const linux = required("LINUX_DIRECTORY");
const files = [required("DIST_ZIP"), required("DIST_DMG")];
// An alpha's Windows installer, when the release publishes one (docs/windows.md).
if (process.env.DIST_WINDOWS) files.push(process.env.DIST_WINDOWS);
const linuxNames = readFileSync(join(linux, "assets.txt"), "utf8").trim().split("\n");
for (const name of linuxNames) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("Invalid Linux asset name");
  files.push(join(linux, name));
}
for (const file of files) {
  const key = `releases/v${version}/${basename(file)}`;
  const digest = await storage.immutableFile(key, file);
  const sidecar = Buffer.from(`${digest}  ${basename(file)}\n`);
  await storage.immutable(`${key}.sha256`, sidecar, { contentType: "text/plain", cacheControl: "public, max-age=31536000, immutable" });
  // These are intentionally unsigned reads, with no upload headers and no authentication.
  const resumed: number[] = [];
  for (const [object, expected] of [[key, digest], [`${key}.sha256`, createHash("sha256").update(sidecar).digest("hex")]] as const) {
    const read = await publicDigest(new URL(object, configuration.downloadBase));
    if (read.sha256 !== expected) throw new Error(`Public download bytes disagree: ${object}`);
    resumed.push(...read.resumedAt);
  }
  console.log(`Verified unsigned download: ${key}${resumed.length ? ` (the connection dropped and the read continued at byte ${resumed.join(", ")})` : ""}`);
}
