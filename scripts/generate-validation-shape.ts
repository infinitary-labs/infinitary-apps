import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Tools from "../src/core/pi/crewmateTaskTools.ts";
import { staleGeneratedFile } from "./github-errors.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * Writes the careful-change skill's validation-shape.json, the JSON Schema of
 * a crewmate's typed validation record (`VALIDATION_SHAPE`), which the report
 * tool points at instead of serving it to every crewmate. With `--check`,
 * which `pnpm check` runs, it writes nothing and fails when the file differs.
 */
const FILE = "resources/runbooks/care/skills/careful-change/validation-shape.json";
const runner = await openModuleRunner();
try {
  const { VALIDATION_SHAPE } = await runner.import<typeof Tools>(
    join(REPO_ROOT, "src", "core", "pi", "crewmateTaskTools.ts"),
  );
  const rendered = `${JSON.stringify(VALIDATION_SHAPE, null, 2)}\n`;
  const path = join(REPO_ROOT, FILE);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== rendered)
      throw staleGeneratedFile(FILE, "node scripts/generate-validation-shape.ts");
  } else {
    writeFileSync(path, rendered);
    console.log(`wrote ${FILE}`);
  }
} finally {
  await runner.close();
}
