#!/usr/bin/env node
// Build-time self-source bundle: the git-tracked tree at HEAD, without
// test data, draft data terms or the README's pictures, plus self-map.json,
// the behavior→source index. Packaged via extraResources as
// Contents/Resources/self-source/ and Contents/Resources/self-map.json.
// Nothing executes from this tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileCatalogs,
  panelMessagesPath,
  RUNBOOK_PANEL_DIRS,
  readCatalogs,
} from "./generate-messages.ts";
import { openModuleRunner } from "./moduleRunner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Filter only the installer input, not ordinary source archives or checkouts.
// The replay gate and other tests still read their fixtures from the checkout.
const excludedFromSelfSource = ["tests/fixtures", "DATA-TERMS.md", ".github/readme"].map(
  (path) => `:(top,exclude,literal)${path}`,
);

// The agents' tool sets come from the tool spec (primitives P7), the same
// entries the runtimes serve: the Firstmate's set and every crewmate tool,
// which both crewmate runtimes generate from one list. The channels come from
// the contract itself, wherever its groups of channels are written. Both are
// app code, so they load through the Vite module runner the other scripts use.
export async function loadLiveSpecs() {
  const runner = await openModuleRunner();
  try {
    const { FIRSTMATE_TOOLS } = await runner.import(join(repoRoot, "src/core/session/tools.ts"));
    const { crewmateToolManifest } = await runner.import(
      join(repoRoot, "src/core/pi/crewmateTaskTools.ts"),
    );
    const { invokeContract, pushContract } = await runner.import(join(repoRoot, "src/shared/ipc.ts"));
    return {
      tools: { firstmate: [...FIRSTMATE_TOOLS], crewmate: crewmateToolManifest() },
      ipc: { invoke: Object.keys(invokeContract), push: Object.keys(pushContract) },
    };
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

export function buildSelfMap({ version, commit, trackedFiles, sources, tools, ipc }) {
  const cardsSrc = sources.cards;
  const eventsSrc = sources.events;
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
    ipc,
    tools: tools.firstmate,
    crewmateTools: tools.crewmate,
    prompts: {
      firstmate: { builder: "buildFirstmateSystemPrompt", module: "src/core/pi/piResources.ts" },
      crewmate: { builder: "buildCrewmateSystemPrompt", module: "src/core/pi/piResources.ts" },
      runbooks: { builder: "Runbooks", module: "src/core/runbooks/runbooks.ts" },
    },
    cardPresentations,
    events,
  };
}

// The version the packaged app reports. A release packages its logical
// version through `-c.extraMetadata.version` and never commits it, so the
// repository's package.json stopped at stable 0.1.30 (docs/alpha.md,
// "Versions"); the release workflows name it here so the map says which
// build a reader holds. Every other build reports the repository's version.
export function selfMapVersion(repoVersion, env = process.env) {
  const release = env.INFINITARY_RELEASE_VERSION?.trim();
  return release ? release : repoVersion;
}

export async function generateSelfSource({ outDir, writeRepoMap = false } = {}) {
  const dest = outDir ?? join(repoRoot, "packaging", "generated");
  const selfSourceDir = join(dest, "self-source");
  const mapPath = join(dest, "self-map.json");

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const commit = git(["rev-parse", "HEAD"]).trim();
  const trackedFiles = git(["ls-tree", "-rz", "--name-only", commit])
    .split("\0")
    .filter((file) => file.length > 0);

  const map = buildSelfMap({
    version: selfMapVersion(pkg.version),
    commit,
    trackedFiles,
    sources: {
      cards: readFileSync(join(repoRoot, "src/shared/cards.ts"), "utf8"),
      events: readFileSync(join(repoRoot, "src/shared/events.ts"), "utf8"),
    },
    ...(await loadLiveSpecs()),
  });
  const mapJson = `${JSON.stringify(map, null, 2)}\n`;

  rmSync(selfSourceDir, { recursive: true, force: true });
  mkdirSync(selfSourceDir, { recursive: true });
  // The tracked tree can exceed execFileSync's output buffer (INF-79).
  // Let git write the archive directly, and retain only the extracted copy.
  const archivePath = resolve(dest, "self-source.tar");
  try {
    git(["archive", `--output=${archivePath}`, commit, "--", ...excludedFromSelfSource]);
    // Paths relative to the folder it fills: Git Bash's tar, first on a
    // Windows crewmate's search path, reads `C:` as a remote host (INF-1238).
    execFileSync("tar", ["-xf", join("..", "self-source.tar")], { cwd: selfSourceDir });
  } finally {
    rmSync(archivePath, { force: true });
  }

  // A built-in runbook's panel words compile from the catalogs and are never
  // committed, so the archive leaves them out: write them beside each panel,
  // so a copy of the runbook carries them (docs/runbooks.md, "Panels").
  const { panels } = compileCatalogs(readCatalogs(selfSourceDir));
  for (const panel of Object.keys(RUNBOOK_PANEL_DIRS)) {
    const path = panelMessagesPath(panel);
    const text = panels[path];
    // A panel with no words would build a copy that cannot import them.
    if (!text) throw new Error(`generate-self-source: no compiled words for ${panel} (${path})`);
    writeFileSync(join(selfSourceDir, path), text);
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
