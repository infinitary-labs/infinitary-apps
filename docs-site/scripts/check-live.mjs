// Checks a served copy of the docs site and exits non-zero on any failure
// (docs/docs-site.md, "Publishing"):
//
//   pnpm --dir docs-site check:live --origin https://docs.getinfinitary.com
//
// It runs the HTTP checks in live-checks.mjs, a translated home and inner page
// for each shipped language and the move of a language not shipped yet
// included, then the browser check
// (check-site.mjs) against the same address, so every page is opened and no
// page may ask another host for anything. Build the version that address
// serves first: the HTTP checks compare pages with dist/, and the browser
// check reads the page list from it.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { catalogLanguages, segmentOf, shippedLanguages, SOURCE_LANGUAGE } from "../languages.ts";
import { BUILT_FILES, checkLive, languageFiles } from "./live-checks.mjs";

const { values } = parseArgs({ options: { origin: { type: "string" } } });
if (!values.origin) {
  console.error("usage: check-live.mjs --origin <address>");
  process.exit(2);
}

const dist = new URL("../dist/", import.meta.url);
const languages = shippedLanguages()
  .filter((tag) => tag !== SOURCE_LANGUAGE)
  .map(segmentOf);
const unshipped = catalogLanguages().filter((tag) => !shippedLanguages().includes(tag)).map(segmentOf)[0];
const files = Object.assign({}, BUILT_FILES, ...languages.map(languageFiles));
const built = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, file]) => [key, await readFile(new URL(file, dist), "utf8")]),
  ),
);
const results = await checkLive(values.origin, { built, languages, unshipped });
for (const result of results) {
  console.log(`${result.ok ? "pass" : "FAIL"}  ${result.name}${result.ok || !result.detail ? "" : `  (${result.detail})`}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} HTTP checks passed\n`);

const browser = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("check-site.mjs", import.meta.url)), "--origin", values.origin],
  { stdio: "inherit" },
);
process.exit(failed > 0 || browser.status !== 0 ? 1 : 0);
