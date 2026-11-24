import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Validation from "../src/shared/liveValidation.ts";
import type * as SessionTools from "../src/core/session/tools.ts";
import { staleGeneratedFile } from "./github-errors.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * Writes the careful-change skill's validation-shape.json, the JSON Schema of
 * a crewmate's typed validation record, rendered from the schema the host
 * parses it with, which the report tool points at instead of serving it to
 * every crewmate. With `--check`,
 * which `pnpm check` runs, it writes nothing and fails when the file differs.
 */
const FILE = "resources/runbooks/care/skills/careful-change/validation-shape.json";
const runner = await openModuleRunner();
try {
  const { liveValidationInputSchema } = await runner.import<typeof Validation>(
    join(REPO_ROOT, "src", "shared", "liveValidation.ts"),
  );
  const { zodParameter } = await runner.import<typeof SessionTools>(
    join(REPO_ROOT, "src", "core", "session", "tools.ts"),
  );
  const shape = zodParameter(liveValidationInputSchema, { dropPatterns: true });
  const rendered = `${JSON.stringify(shape, null, 2)}\n`;
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
