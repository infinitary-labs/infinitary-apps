#!/usr/bin/env node
// Build-time self-source bundle: the complete git-tracked tree at HEAD
// (`git archive`, no exclusions) plus self-map.json, the behavior→source
// index. Packaged via extraResources as Contents/Resources/self-source/ and
// Contents/Resources/self-map.json. Nothing executes from this tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openModuleRunner } from "./moduleRunner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// The agents' tool sets come from the tool spec (primitives P7), the same
// entries the runtimes serve: the Firstmate's set and every crewmate tool,
// which both crewmate runtimes generate from one list. The spec is app core,
// so it loads through the Vite module runner the other scripts use.
export async function loadToolSpec() {
  const runner = await openModuleRunner();
  try {
    const { FIRSTMATE_TOOLS } = await runner.import(join(repoRoot, "src/core/session/tools.ts"));
    const { crewmateToolManifest } = await runner.import(
      join(repoRoot, "src/core/pi/crewmateTaskTools.ts"),
    );
    return { firstmate: [...FIRSTMATE_TOOLS], crewmate: crewmateToolManifest() };
  } finally {
    await runner.close();
  }
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: repoRoot, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function quotedStrings(text) {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`generate-self-source: missing ${marker}`);
  // The object's own closing line, whatever follows `as const` on it
  // (`satisfies` checks the invoke contract's declarations).
  const end = source.slice(start).search(/^\} as const\b/m);
  if (end < 0) throw new Error(`generate-self-source: unterminated ${marker}`);
  return source.slice(start, start + end);
}

function outputBundleFor(sourcePath) {
  // The core is bundled into the main process today; a second host would
  // bundle the same tree into itself (daemon study D1).
  if (sourcePath.startsWith("src/core/")) return "out/main";
  if (sourcePath.startsWith("src/main/")) return "out/main";
  if (sourcePath.startsWith("src/preload/")) return "out/preload";
  if (sourcePath.startsWith("src/renderer/")) return "out/renderer";
  if (sourcePath.startsWith("src/shared/")) return ["out/main", "out/preload", "out/renderer"];
  return undefined;
}

export function buildSelfMap({ version, commit, trackedFiles, sources, tools }) {
  const ipcSrc = sources.ipc;
  const cardsSrc = sources.cards;
  const eventsSrc = sources.events;
  const invoke = [...blockAfter(ipcSrc, "export const invokeContract").matchAll(/^ {2}"((?:inf|fm):[^"]+)":/gm)].map(
    (match) => match[1],
  );
  const push = [...blockAfter(ipcSrc, "export const pushContract").matchAll(/^ {2}"((?:inf|fm):[^"]+)":/gm)].map(
    (match) => match[1],
  );
  // One card shape (cards/tasks/agents P1): the wire has no kind; the map
  // records the presentations a card derives from what it is.
  const kindsMatch = cardsSrc.match(/CARD_PRESENTATIONS = \[([^\]]+)\] as const/);
  if (!kindsMatch) throw new Error("generate-self-source: CARD_PRESENTATIONS not found");
  const cardPresentations = quotedStrings(kindsMatch[1]);
  const eventsBlock = eventsSrc.slice(eventsSrc.indexOf("export const fmEventSchema"));
  const events = [...eventsBlock.matchAll(/type:\s*z\.literal\("([^"]+)"\)/g)].map((match) => match[1]);
  const modules = {};
  for (const file of trackedFiles) {
    const bundle = outputBundleFor(file);
    if (bundle) modules[file] = bundle;
  }
  return {
    version,
    commit,
    modules,
    ipc: { invoke, push },
    tools: tools.firstmate,
    crewmateTools: tools.crewmate,
    prompts: {
      firstmate: { builder: "buildFirstmateSystemPrompt", module: "src/core/pi/piResources.ts" },
      crewmate: { builder: "buildCrewmateSystemPrompt", module: "src/core/pi/piResources.ts" },
      sequences: { builder: "SEQUENCES_SEED", module: "src/core/personal/sequencesSkill.ts" },
    },
    cardPresentations,
    events,
  };
}

export async function generateSelfSource({ outDir, writeRepoMap = false } = {}) {
  const dest = outDir ?? join(repoRoot, "packaging", "generated");
  const selfSourceDir = join(dest, "self-source");
  const mapPath = join(dest, "self-map.json");

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]).trim();
  const trackedFiles = git(["ls-files", "-z"])
    .split("\0")
    .filter((file) => file.length > 0);

  const map = buildSelfMap({
    version: pkg.version,
    commit,
    trackedFiles,
    sources: {
      ipc: readFileSync(join(repoRoot, "src/shared/ipc.ts"), "utf8"),
      cards: readFileSync(join(repoRoot, "src/shared/cards.ts"), "utf8"),
      events: readFileSync(join(repoRoot, "src/shared/events.ts"), "utf8"),
    },
    tools: await loadToolSpec(),
  });
  const mapJson = `${JSON.stringify(map, null, 2)}\n`;

  rmSync(selfSourceDir, { recursive: true, force: true });
  mkdirSync(selfSourceDir, { recursive: true });
  // The complete tree can exceed execFileSync's output buffer (INF-79).
  // Let git write the archive directly, and retain only the extracted copy.
  const archivePath = resolve(dest, "self-source.tar");
  try {
    git(["archive", `--output=${archivePath}`, "HEAD"]);
    execFileSync("tar", ["-xf", archivePath, "-C", selfSourceDir]);
  } finally {
    rmSync(archivePath, { force: true });
  }

  mkdirSync(dest, { recursive: true });
  writeFileSync(mapPath, mapJson);
  writeFileSync(join(selfSourceDir, "self-map.json"), mapJson);
  if (writeRepoMap) {
    writeFileSync(join(repoRoot, "self-map.json"), mapJson);
  }
  return { dest, selfSourceDir, mapPath, map, trackedFiles };
}

function parseArgs(argv) {
  const outIndex = argv.indexOf("--out");
  return {
    outDir: outIndex >= 0 ? argv[outIndex + 1] : undefined,
    writeRepoMap: !argv.includes("--out"),
  };
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { outDir, writeRepoMap } = parseArgs(process.argv.slice(2));
  const result = await generateSelfSource({ ...(outDir ? { outDir } : {}), writeRepoMap });
  console.log(
    `[infinitary] self-source ${result.trackedFiles.length} files @ ${result.map.commit.slice(0, 12)} -> ${result.selfSourceDir}`,
  );
}
