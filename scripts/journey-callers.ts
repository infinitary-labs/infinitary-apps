import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closureOf } from "./affected-journeys.ts";

/** Select journeys that call the named helper exports, directly or through another helper. */
export function journeyCallers(
  specs: string[],
  helper: string,
  exports: string[],
  read: (file: string) => string | undefined,
): string[] {
  return specs.filter((spec) => {
    const reached = closureOf(spec, read);
    if (!reached.includes(helper)) return false;
    return reached.some((file) => {
      if (file === helper) return false;
      const source = read(file) ?? "";
      return exports.some((name) => {
        const aliases = [...source.matchAll(new RegExp(`\\b${name}\\s+as\\s+(\\w+)`, "g"))]
          .map((match) => match[1]!);
        return [name, ...aliases].some((called) =>
          new RegExp(`\\b${called}\\s*\\(`).test(source),
        );
      });
    });
  }).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [helper, symbols] = process.argv.slice(2);
  if (!helper || !symbols) throw new Error("Usage: journey-callers.ts <helper> <exports,comma,separated>");
  const specs = readdirSync("tests/e2e").filter((file) => file.endsWith(".spec.ts"))
    .map((file) => `tests/e2e/${file}`);
  console.log(journeyCallers(specs, helper, symbols.split(","),
    (file) => existsSync(file) ? readFileSync(file, "utf8") : undefined).join("\n"));
}
