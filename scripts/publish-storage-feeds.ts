import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePointer, publicDigest, publishSnapshot, ReleaseStorage } from "./release-storage.mjs";

const mode = process.argv[2];
if (mode !== "live" && mode !== "rehearsal") throw new Error("Expected live or rehearsal");
const work = process.env.WORK;
if (!work) throw new Error("Missing WORK");
const directory = join(work, "feeds");
mkdirSync(directory, { recursive: true });
if (readdirSync(directory).length) throw new Error("Use a fresh WORK folder for each publication attempt");
// The release workflow runs its own copy and the feed writer beside it, but the
// destination stays the release source's, the one its app reads, the fetch-back
// checks and the workflow lays beside the feed writer (docs/alpha.md).
const configuration = JSON.parse(readFileSync("packaging/release-source.json", "utf8"));
// A rehearsal never reads a credential, creates a storage client, or sends a write.
const storage = mode === "live" ? ReleaseStorage.fromEnvironment() : undefined;
const previous = storage ? await storage.read("feeds/current.json") : null;
if (previous && storage) {
  const pointer = parsePointer(previous.bytes);
  for (const name of pointer.files) {
    const current = await storage.read(`${pointer.prefix}${name}`);
    if (!current) throw new Error(`Current snapshot is incomplete: ${name}`);
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, current.bytes);
  }
}
const environment = process.env;
const required = (name: string) => {
  const value = environment[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const summary = execFileSync(process.execPath, [fileURLToPath(new URL("release-feeds.ts", import.meta.url)), "--directory", directory,
  "--version", required("VERSION"), "--channel", required("CHANNEL"), "--source-commit", required("SOURCE_COMMIT"),
  "--zip", required("DIST_ZIP"), "--dmg", required("DIST_DMG"), "--linux", required("LINUX_MANIFEST"),
  // The release's Windows installer, when it publishes one (docs/windows.md).
  ...(environment.DIST_WINDOWS ? ["--windows", environment.DIST_WINDOWS] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
writeFileSync(join(work, "summary.json"), summary);
process.stdout.write(summary);
if (storage) {
  const files: Record<string, string> = {};
  function collect(folder: string, prefix = "") {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) collect(join(folder, entry.name), `${name}/`);
      else files[name] = readFileSync(join(folder, entry.name), "utf8");
    }
  }
  collect(directory);
  const result = await publishSnapshot(storage, files, previous, async (key: string, expected: Buffer) => {
    const read = await publicDigest(new URL(key, configuration.downloadBase));
    if (read.sha256 !== createHash("sha256").update(expected).digest("hex"))
      throw new Error(`Unsigned snapshot verification failed: ${key}`);
  });
  console.log(JSON.stringify(result));
}
