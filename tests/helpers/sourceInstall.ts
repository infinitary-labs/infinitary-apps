import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SelfSourceLocation } from "../../src/core/selfSource/resolve";

/** Small installed-source fixture: real module bytes and recorded release identities.
 * The resolver only needs the index envelope; this is not a full historical archive.
 */
export function sourceInstall(base: string, release = "0.1.30") {
  const repo = join(__dirname, "../..");
  const recorded = JSON.parse(
    readFileSync(join(repo, "release-notes/releases", `${release}.json`), "utf8"),
  ) as { version: string; sourceCommit: string };
  const root = join(base, "self-source");
  const files = ["src/core/selfSource/resolve.ts", "src/shared/work.ts"] as const;
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repo, file), join(root, file));
  }
  const map = {
    version: recorded.version,
    commit: recorded.sourceCommit,
    modules: {
      [files[0]]: "out/main",
      [files[1]]: ["out/main", "out/preload", "out/renderer"],
    },
  };
  const write = () => {
    writeFileSync(join(base, "self-map.json"), JSON.stringify(map));
    writeFileSync(join(root, "self-map.json"), JSON.stringify(map));
  };
  write();
  const location: SelfSourceLocation & { computer: string; version: string } = {
    isPackaged: true,
    resourcesPath: base,
    appPath: join(base, "app.asar"),
    computer: "Work computer",
    version: map.version,
  };
  return { location, root, map, files, write };
}
