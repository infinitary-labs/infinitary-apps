import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";

// A card part a runbook ships is copied whole into a card body, whose size is capped, so the
// readable sources under src/core/runbooks/parts/ are minified into the served part here.
const parts = [
  {
    source: "map",
    output: "../resources/runbooks/architecture/skills/advanced-architecture/parts/map.html",
  },
];

for (const part of parts) {
  const from = (extension: string) =>
    readFileSync(new URL(`../src/core/runbooks/parts/${part.source}.${extension}`, import.meta.url), "utf8");
  const css = (await transformWithEsbuild(from("css"), `${part.source}.css`, { loader: "css", minify: true })).code.trim();
  const js = (await transformWithEsbuild(from("js"), `${part.source}.js`, { loader: "js", minify: true, target: "es2022" })).code.trim();
  if (/<\/(script|style)/i.test(js + css)) throw new Error(`${part.source}: a closing tag inside the minified part.`);
  const template = from("html");
  for (const slot of ["<style data-source></style>", "<script data-source></script>"]) {
    if (template.split(slot).length !== 2) throw new Error(`${part.source}.html needs one ${slot}.`);
  }
  const text = template
    .replace("<style data-source></style>", () => `<style>${css}</style>`)
    .replace("<script data-source></script>", () => `<script>${js}</script>`);
  const output = fileURLToPath(new URL(part.output, import.meta.url));
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) throw new Error("Run node scripts/generate-runbook-parts.ts to refresh the runbook parts.");
  } else writeFileSync(output, text);
}
