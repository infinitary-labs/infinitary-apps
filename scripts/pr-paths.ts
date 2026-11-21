import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What a pull request version's build check runs beyond its code checks
 * (INF-2915's plan, the captain's direction B with the light profile): the
 * build and the critical path run unless every changed path is a test, docs,
 * the docs site, a release note or the phone app, and every browser test runs only when a
 * path is the renderer or its browser tests; otherwise the reader step runs
 * the browser tests that read a changed file (scripts/unit-repeats.ts
 * --reach, INF-2999). The swept batch runs all three on every approved change
 * before it reaches main (docs/testing.md, "What a pull request runs").
 *
 *   node scripts/pr-paths.ts --base <ref>   (ci.yml's reached-tests and build jobs)
 *
 * Plain Node with no install, like the release notes step: it prints each
 * verdict and writes `build=` and `browser=true|false` to $GITHUB_OUTPUT when
 * that is set. An empty list or an unreadable diff runs everything.
 */

/** A path that changes no part of the desktop app's build. */
export function lightPath(path: string): boolean {
  return (
    path.startsWith("tests/") ||
    /\.(test|spec)\.tsx?$/.test(path) ||
    path.startsWith("docs/") ||
    path.startsWith("primitives/") ||
    path.endsWith(".md") ||
    path.startsWith("release-notes/") ||
    // The desktop packages also ship the phone app’s font notice.
    (path.startsWith("ios/") && path !== "ios/Infinitary/InfinitaryApp/Fonts/Font-licenses.txt") ||
    // The docs site is its own package, built and checked by docs-site.yml.
    path.startsWith("docs-site/")
  );
}

/** A path the browser tests draw or are. */
export function browserPath(path: string): boolean {
  return (
    path.startsWith("src/renderer/") ||
    path.startsWith("tests/browser/") ||
    path.startsWith("tests/helpers/browser")
  );
}

export type Verdict = { build: boolean; browser: boolean };

/** What runs for these changed paths; an unknown change runs everything. */
export function prRuns(paths: readonly string[] | undefined): Verdict {
  if (paths === undefined || paths.length === 0) return { build: true, browser: true };
  return { build: !paths.every(lightPath), browser: paths.some(browserPath) };
}

/** Every path the change touches since base, a rename counted at both ends. */
function changedSince(base: string): string[] | undefined {
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1] : undefined;
  if (!base) throw new Error("usage: node scripts/pr-paths.ts --base <ref>");
  const paths = changedSince(base);
  const { build, browser } = prRuns(paths);
  if (paths === undefined) console.log(`Could not read the change since ${base}; everything runs.`);
  else {
    console.log(
      build
        ? "The change touches the app's build; the build and the critical path run."
        : `Every one of ${paths.length} changed paths is a test, docs, the docs site, a release note or the phone app; the build and the critical path skip.`,
    );
    console.log(
      browser
        ? "The change touches the renderer or its browser tests; the browser step runs every browser test."
        : "The change touches neither the renderer nor its browser tests; the browser step skips, and the reader step runs each browser test that reads a changed file.",
    );
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\nbrowser=${browser}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
