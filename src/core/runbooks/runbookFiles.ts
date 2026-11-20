import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { crewSectionsOf, type RunbookManifest, runbookManifestSchema } from "../../shared/runbooks";

/** A declared path names a real child, never an absolute path or an escape. */
export function runbookPath(root: string, file: string): string {
  const path = resolve(root, file);
  const rel = relative(resolve(root), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(file) === file)
    throw new Error("Runbook files must stay inside their folder.");
  return path;
}

const GUIDANCE_FILES = new Set([
  ".md",
  ".txt",
  ".json",
  ".html",
  ".css",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
]);

/** Admission and every subsequent read share the guidance-only boundary. Panels are inert source,
 * checked by the panel compiler at admission and installed only through their own consent. */
export function checkRunbookFiles(
  root: string,
): RunbookManifest & { author: string; version: string } {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("A runbook must be a plain folder.");
  if (
    !lstatSync(join(root, "runbook.json")).isFile() ||
    lstatSync(join(root, "runbook.json")).isSymbolicLink()
  )
    throw new Error("A runbook manifest must be a plain file.");
  const manifest = runbookManifestSchema.parse(
    JSON.parse(readFileSync(join(root, "runbook.json"), "utf8")),
  );
  if (!manifest.author || !manifest.version)
    throw new Error("An added runbook must name its author and version.");
  const panels = (manifest.panels ?? []).map((file) => runbookPath(root, file));
  for (const panel of panels) {
    if (!lstatSync(panel).isDirectory()) throw new Error("A runbook's panel must be a folder.");
  }
  const inPanel = (path: string) =>
    panels.some((panel) => path === panel || path.startsWith(`${panel}${sep}`));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("A runbook cannot hold symbolic links.");
      if (stat.isDirectory()) walk(path);
      else if (
        !stat.isFile() ||
        (!inPanel(path) && !GUIDANCE_FILES.has(extname(name).toLowerCase()))
      )
        throw new Error(
          `A runbook holds guidance, HTML parts and pictures only; ${relative(root, path)} is not one of those files.`,
        );
    }
  };
  walk(root);
  const reference = (file: string): string => {
    const path = runbookPath(root, file);
    if (inPanel(path) || panels.some((panel) => panel.startsWith(`${path}${sep}`)))
      throw new Error("Runbook guidance and skills cannot include a panel's source folder.");
    return path;
  };
  for (const file of [manifest.skills, manifest.parts]) {
    if (file && !lstatSync(reference(file)).isDirectory())
      throw new Error("Runbook skills and parts must be folders.");
  }
  for (const file of [
    manifest.firstmate,
    ...crewSectionsOf(manifest).map((section) => section.file),
  ]) {
    if (!file) continue;
    const path = reference(file);
    if (!lstatSync(path).isFile()) throw new Error("A runbook section must be a text file.");
    if (![".md", ".txt", ".json"].includes(extname(path)))
      throw new Error("A runbook section must be plain text.");
    const text = readFileSync(path, "utf8");
    if (path.endsWith(".json") && typeof JSON.parse(text) !== "string")
      throw new Error("A runbook section must be text.");
  }
  return { ...manifest, author: manifest.author, version: manifest.version };
}
