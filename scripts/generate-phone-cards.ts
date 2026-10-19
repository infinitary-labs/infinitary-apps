import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/** INF-64 piece 4: bundle the actual desktop bridge/styles, not a second form implementation. */
const directory = join(REPO_ROOT, "ios/Infinitary/InfinitaryApp/CardAssets");
const check = process.argv.includes("--check");
function keep(name: string, contents: string | Buffer) {
  const path = join(directory, name);
  const bytes = Buffer.from(contents);
  if (check) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`Run node scripts/generate-phone-cards.ts (${name})`);
  } else { mkdirSync(directory, { recursive: true }); writeFileSync(path, bytes); }
}
const result = await build({
  configFile: false, root: REPO_ROOT, logLevel: "error",
  resolve: { alias: { "@shared": join(REPO_ROOT, "src/shared") } },
  build: { write: false, minify: true, target: "safari18", lib: {
    entry: join(REPO_ROOT, "ios/Infinitary/CardRuntime/cardHost.ts"), name: "PhoneCardHost", formats: ["iife"],
  } },
});
if (Array.isArray(result) && result[0]?.output[0]?.type === "chunk") {
  keep("CardHost.generated.js", result[0].output[0].code);
} else throw new Error("The phone card bundle produced no script");
const runner = await openModuleRunner();
try {
  const { frameFontFileNames } = await runner.import<{ frameFontFileNames(): string[] }>(join(REPO_ROOT, "src/renderer/src/plugins/frames/frameStylesheet.ts"));
  for (const name of frameFontFileNames()) keep(name, readFileSync(join(REPO_ROOT, "src/renderer/src/design/assets/fonts", name)));
} finally { await runner.close(); }
