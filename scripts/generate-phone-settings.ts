import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { REPO_ROOT } from "./moduleRunner.ts";
import { staleGeneratedFile } from "./github-errors.ts";

/**
 * The phone's Settings pages run the computer's own row rules and words
 * (docs/ios.md, "Settings pages in the computer's words"): this bundles them
 * into the one script the app runs in JavaScriptCore, so no rule or sentence
 * is written a second time in Swift. The bundle stays unminified, as the
 * card bundle does, so parallel changes to the code it carries merge line by
 * line.
 */
export const PHONE_SETTINGS_SCRIPT = "ios/Infinitary/InfinitaryApp/SettingsWords.generated.js";
const ENTRY = "ios/Infinitary/SettingsRuntime/settingsWords.ts";

export async function phoneSettingsScript(): Promise<string> {
  const result = await build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: "error",
    resolve: { alias: { "@shared": join(REPO_ROOT, "src/shared") } },
    build: {
      write: false,
      minify: false,
      target: "safari18",
      lib: { entry: join(REPO_ROOT, ENTRY), name: "PhoneSettingsWords", formats: ["iife"] },
    },
  });
  const chunk = Array.isArray(result) ? result[0]?.output[0] : undefined;
  if (chunk?.type !== "chunk") throw new Error("The phone Settings bundle produced no script");
  return chunk.code;
}

if (process.argv[1] && process.argv[1].endsWith("generate-phone-settings.ts")) {
  const path = join(REPO_ROOT, PHONE_SETTINGS_SCRIPT);
  const script = await phoneSettingsScript();
  if (!process.argv.includes("--check")) writeFileSync(path, script);
  else if (readFileSync(path, "utf8") !== script)
    throw staleGeneratedFile(PHONE_SETTINGS_SCRIPT, "node scripts/generate-phone-settings.ts");
}
