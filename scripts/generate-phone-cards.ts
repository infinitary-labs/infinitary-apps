import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "vite";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { staleGeneratedFile } from "./github-errors.ts";

/**
 * INF-64 piece 4: bundle the actual desktop bridge/styles, not a second form implementation.
 * The bundle stays unminified (INF-3066): a readable file lets parallel changes to the card code merge line by line instead of conflicting on one long line.
 */
const directory = join(REPO_ROOT, "ios/Infinitary/InfinitaryApp/CardAssets");
const check = process.argv.includes("--check");
function keep(name: string, contents: string | Buffer) {
  const path = join(directory, name);
  const bytes = Buffer.from(contents);
  if (check) {
    if (!readFileSync(path).equals(bytes)) throw staleGeneratedFile(relative(REPO_ROOT, path), "node scripts/generate-phone-cards.ts");
  } else { mkdirSync(directory, { recursive: true }); writeFileSync(path, bytes); }
}
/** One parent page's script, bundled from its entry as one readable classic script. */
async function bundle(entry: string, name: string, file: string) {
  const result = await build({
    configFile: false, root: REPO_ROOT, logLevel: "error",
    resolve: { alias: { "@shared": join(REPO_ROOT, "src/shared") } },
    build: { write: false, minify: false, target: "safari18", lib: {
      entry: join(REPO_ROOT, "ios/Infinitary/CardRuntime", entry), name, formats: ["iife"],
    } },
  });
  if (Array.isArray(result) && result[0]?.output[0]?.type === "chunk") keep(file, result[0].output[0].code);
  else throw new Error(`The phone bundle ${file} produced no script`);
}
await bundle("cardHost.ts", "PhoneCardHost", "CardHost.generated.js");
// INF-3830 piece 2: the parent page of each of the captain's panels, built from the desktop's frame controller.
await bundle("panelHost.ts", "PhonePanelHost", "PanelHost.generated.js");
const runner = await openModuleRunner();
try {
  const { frameFontFileNames } = await runner.import<{ frameFontFileNames(): string[] }>(join(REPO_ROOT, "src/renderer/src/plugins/frames/frameStylesheet.ts"));
  for (const name of frameFontFileNames()) keep(name, readFileSync(join(REPO_ROOT, "src/renderer/src/design/assets/fonts", name)));
} finally { await runner.close(); }
