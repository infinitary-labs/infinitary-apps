/**
 * The tap's casks and update targets, from the command line (docs/alpha.md
 * "Casks and update targets"). The producer is
 * `src/core/update/tapPublication.ts`; this file only reads its inputs and
 * writes what it returns. Nothing here pushes, tags or publishes: the
 * release workflow decides when the files it writes reach the tap.
 *
 *   node scripts/tap-publication.ts cask
 *     One channel's cask on stdout, from the environment: CHANNEL (stable
 *     when unset), VERSION, SHA256, DOWNLOAD_URL, and NAMES (`infinitary`
 *     when unset, or `firstmate` for the old-cask switch).
 *     `scripts/generate-cask.sh` runs this.
 *
 *   node scripts/tap-publication.ts advance --tap <dir> --channel <stable|alpha>
 *       --version <version> --asset <zip name> --sha256 <hex> --source-commit <sha>
 *       [--linux <manifest>] [--names infinitary|firstmate] [--rehearsal]
 *     Reads the tap's targets file in <dir> (absent on a tap that has none
 *     yet - then the stable cask's version is the floor), writes the next
 *     targets file and the cask of every channel whose target moved into
 *     <dir>, and prints a JSON summary. With --linux, the Linux builds
 *     manifest `scripts/linux-recipes.ts release` wrote, it writes the next
 *     builds file beside them (docs/alpha.md "Builds by system and chip").
 *     A refused publication writes nothing and exits 1 with the reason. An
 *     alpha is refused until the channel is activated
 *     (`alphaActivationProblem`); with --rehearsal it is written anyway and
 *     the summary's notes say what a live alpha would meet.
 *
 *   node scripts/tap-publication.ts activation --tap <dir> [--names ...]
 *     Whether a live alpha may publish onto the tap in <dir> now: prints the
 *     verdict, and exits 1 when it may not.
 *
 *   node scripts/tap-publication.ts republish --tap <dir> [--names ...]
 *     Writes into <dir> each channel's cask as this generator renders it at
 *     the target the tap's targets file already names, and prints a JSON
 *     summary. The targets file is never written. A cask that installs
 *     anything but its target, or a tap with no valid targets file, is
 *     refused: nothing is written and it exits 1 with the reason.
 *
 * `--names` says whose tap <dir> is: Infinitary's own (`infinitary`, the
 * default), or Firstmate 3000's (`firstmate`), where the old-cask switch
 * publishes Infinitary under Firstmate 3000's casks, tags and update files
 * (docs/alpha.md "The old-cask switch").
 *
 * On Infinitary's own tap, the newest stable in the record of past releases
 * (`release-notes/archive.json`, or the file RELEASE_ARCHIVE names) stands
 * in for a stable target the tap does not carry yet (`alphaActivationProblem`).
 *
 * Node 24 strips the types; the core loads through Vite, because its
 * imports are aliased and extensionless (`scripts/moduleRunner.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TapPublication from "../src/core/update/tapPublication.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

type TapPublicationModule = typeof TapPublication;

const NOTICE_FILE = join(REPO_ROOT, "packaging", "alpha-notice.txt");
/**
 * The record of past releases (docs/release-notes.md "A fresh history"), or
 * the one RELEASE_ARCHIVE names.
 */
const ARCHIVE_FILE = process.env.RELEASE_ARCHIVE
  ? resolve(process.env.RELEASE_ARCHIVE)
  : join(REPO_ROOT, "release-notes", "archive.json");

const USAGE = `tap-publication: the tap's casks and update targets

  cask      one channel's cask on stdout (env CHANNEL, VERSION, SHA256, DOWNLOAD_URL)
  advance     --tap <dir> --channel <stable|alpha> --version <v> --asset <zip>
              --sha256 <hex> --source-commit <sha> [--linux <manifest>] [--rehearsal]
  activation  --tap <dir>
  republish   --tap <dir>
  --names infinitary|firstmate   whose tap <dir> is (infinitary when unset)
`;

const SWITCHES = new Set(["rehearsal"]);

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag.startsWith("--") && SWITCHES.has(flag.slice(2))) {
      flags[flag.slice(2)] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(`unexpected argument: ${flag}`);
    flags[flag.slice(2)] = value;
    index += 1;
  }
  return flags;
}

type TapNames = TapPublicationModule["TAP"];

/** Whose tap names a command reads and writes: Infinitary's unless `firstmate`. */
function namesOf(module: TapPublicationModule, value: string | undefined): TapNames {
  if (value === undefined || value === "infinitary") return module.INFINITARY_TAP;
  if (value === "firstmate") return module.FIRSTMATE_TAP;
  throw new Error(`--names ${value} is not infinitary or firstmate`);
}

/** The tap's current targets file, parsed as stored, or undefined when it has none. */
function readTargets(names: TapNames, tap: string): unknown | undefined {
  const path = join(tap, names.targetsFile);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
}

/** The tap's current builds file, parsed as stored, or undefined when it has none. */
function readBuilds(names: TapNames, tap: string): unknown | undefined {
  const path = join(tap, names.buildsFile);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
}

/**
 * The newest stable the record of past releases names, for Infinitary's own
 * tap, which starts empty after Firstmate 3000's stables
 * (`alphaActivationProblem`); undefined on Firstmate 3000's tap or without a record.
 */
function archivedStable(names: TapNames): string | undefined {
  if (names.throughOldCask || !existsSync(ARCHIVE_FILE)) return undefined;
  const archive = JSON.parse(readFileSync(ARCHIVE_FILE, "utf8")) as { stable?: unknown };
  return typeof archive.stable === "string" ? archive.stable : undefined;
}

/**
 * The Linux builds manifest: channel, then chip, then kind, each an asset
 * name and its checksum. Only its shape is read here; the writer checks
 * every value.
 */
function readLinuxManifest(path: string): NonNullable<TapPublication.Publication["linux"]> {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const record = (value: unknown, where: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`the Linux manifest's ${where} is not an object`);
    }
    return value as Record<string, unknown>;
  };
  const result: NonNullable<TapPublication.Publication["linux"]> = {};
  for (const [channel, chips] of Object.entries(record(manifest, "top level"))) {
    const builds: TapPublication.LinuxBuilds = {};
    for (const [chip, kinds] of Object.entries(record(chips, channel))) {
      builds[chip] = {};
      for (const [kind, file] of Object.entries(record(kinds, `${channel} ${chip}`))) {
        const { asset, sha256 } = record(file, `${channel} ${chip} ${kind}`);
        if (typeof asset !== "string" || typeof sha256 !== "string") {
          throw new Error(`the Linux manifest's ${channel} ${chip} ${kind} needs an asset and a sha256`);
        }
        builds[chip][kind] = { asset, sha256 };
      }
    }
    result[channelOf(channel)] = builds;
  }
  return result;
}

function required(source: Record<string, string | undefined>, name: string, label = name): string {
  const value = source[name];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function channelOf(value: string): "stable" | "alpha" {
  if (value !== "stable" && value !== "alpha") throw new Error(`channel ${value} is not stable or alpha`);
  return value;
}

async function run(module: TapPublicationModule, argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const notice = readFileSync(NOTICE_FILE, "utf8");
  if (command === "cask") {
    const env = process.env;
    process.stdout.write(
      module.renderCask(
        channelOf(env.CHANNEL || "stable"),
        {
          version: required(env, "VERSION"),
          sha256: required(env, "SHA256"),
          downloadUrl: required(env, "DOWNLOAD_URL"),
        },
        notice,
        namesOf(module, env.NAMES || undefined),
      ),
    );
    return;
  }
  if (command === "activation") {
    const flags = parseFlags(rest);
    const names = namesOf(module, flags.names);
    const problem = module.alphaActivationProblem(
      readTargets(names, resolve(required(flags, "tap", "--tap"))),
      { tap: names, archivedStable: archivedStable(names) },
    );
    if (problem) throw new Error(`a live alpha would be refused: ${problem}`);
    process.stdout.write("the alpha channel is activated: a live alpha may publish\n");
    return;
  }
  if (command === "republish") {
    const flags = parseFlags(rest);
    const tap = resolve(required(flags, "tap", "--tap"));
    const names = namesOf(module, flags.names);
    const casks: Partial<Record<"stable" | "alpha", string>> = {};
    for (const channel of ["stable", "alpha"] as const) {
      const path = join(tap, module.caskPathFor(channel, names));
      if (existsSync(path)) casks[channel] = readFileSync(path, "utf8");
    }
    const result = module.republishCasks(readTargets(names, tap), casks, notice, names);
    for (const [path, content] of Object.entries(result.files)) {
      writeFileSync(join(tap, path), content);
    }
    process.stdout.write(
      `${JSON.stringify({ changed: result.changed, notes: result.notes, files: Object.keys(result.files) }, null, 2)}\n`,
    );
    return;
  }
  if (command === "advance") {
    const flags = parseFlags(rest);
    const tap = resolve(required(flags, "tap", "--tap"));
    const channel = channelOf(required(flags, "channel", "--channel"));
    const names = namesOf(module, flags.names);
    const current = readTargets(names, tap);
    const stableCask = join(tap, module.caskPathFor("stable", names));
    const legacyStableVersion =
      current === undefined && existsSync(stableCask)
        ? (module.caskVersion(readFileSync(stableCask, "utf8")) ?? undefined)
        : undefined;
    const activation =
      channel === "alpha"
        ? module.alphaActivationProblem(current, {
            tap: names,
            archivedStable: archivedStable(names),
          })
        : null;
    if (activation && flags.rehearsal !== "true") {
      throw new Error(`a live alpha is refused: ${activation}`);
    }
    const result = module.tapFilesFor(
      current,
      {
        channel,
        version: required(flags, "version", "--version"),
        assetName: required(flags, "asset", "--asset"),
        sha256: required(flags, "sha256", "--sha256"),
        sourceCommit: required(flags, "source-commit", "--source-commit"),
        ...(flags.linux ? { linux: readLinuxManifest(resolve(flags.linux)) } : {}),
      },
      notice,
      {
        ...(legacyStableVersion ? { legacyStableVersion } : {}),
        currentBuilds: readBuilds(names, tap),
        tap: names,
      },
    );
    if (activation) result.notes.push(`a live alpha would be refused now: ${activation}`);
    for (const [path, content] of Object.entries(result.files)) {
      mkdirSync(dirname(join(tap, path)), { recursive: true });
      writeFileSync(join(tap, path), content);
    }
    process.stdout.write(
      `${JSON.stringify({ changed: result.changed, notes: result.notes, files: Object.keys(result.files) }, null, 2)}\n`,
    );
    return;
  }
  throw new Error(USAGE);
}

export async function main(argv: string[]): Promise<number> {
  const runner = await openModuleRunner();
  try {
    const module = await runner.import<TapPublicationModule>(
      join(REPO_ROOT, "src", "core", "update", "tapPublication.ts"),
    );
    await run(module, argv);
    return 0;
  } catch (caught) {
    process.stderr.write(`tap-publication: ${caught instanceof Error ? caught.message : String(caught)}\n`);
    return 1;
  } finally {
    await runner.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
