import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  UPDATE_FEED_BASE,
  UPDATE_FEED_PAGE,
  UPDATE_VERSIONS,
} from "../tests/windows/updateVersions.ts";

/**
 * The Windows update check's builds only (docs/windows.md, "The update
 * check"). With no arguments it points this checkout's release source at
 * the clean machine's own feed, so the test versions windows.yml builds
 * from it read their releases there, and prints each test version, one per
 * line, oldest first, alpha then stable; nothing it builds is published.
 * `older <channel>` prints only that channel's older test version.
 */
const [what, channel] = process.argv.slice(2);
if (what === "older") {
  const versions = UPDATE_VERSIONS[channel as keyof typeof UPDATE_VERSIONS];
  if (!versions) throw new Error(`no update check channel ${channel}`);
  console.log(versions[0]);
} else {
  const file = join(import.meta.dirname, "..", "packaging", "release-source.json");
  const source = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  writeFileSync(
    file,
    `${JSON.stringify({ ...source, downloadBase: UPDATE_FEED_BASE, releasePage: UPDATE_FEED_PAGE }, null, 2)}\n`,
  );
  for (const versions of Object.values(UPDATE_VERSIONS)) {
    for (const version of versions) console.log(version);
  }
}
