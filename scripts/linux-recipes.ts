/**
 * The Arch recipe and the Nix package for one Linux release, rendered from
 * their templates in packaging/linux/ (docs/linux-packages.md, "Arch,
 * Omarchy and NixOS"), and the release's Linux files as the release
 * workflow publishes them. Both recipes install the release's Ubuntu
 * package, so they carry its name, its address and its checksum. Nothing
 * here publishes.
 *
 *   node scripts/linux-recipes.ts render --version <version> --deb <file>
 *       --out <dir> [--url <address>]
 *     Writes <dir>/aur/PKGBUILD and <dir>/nix/package.nix. The address is
 *     where the Ubuntu package will be downloaded from; it defaults to the
 *     tap's release for that version, as the casks name theirs.
 *
 *   node scripts/linux-recipes.ts release --version <version>
 *       --packages <dir> --out <dir>
 *     The release's Linux files, flat, as they go on the tap's release
 *     (docs/alpha.md "Builds by system and chip"): the one Ubuntu package,
 *     Fedora package and AppImage in <packages>, each channel's Arch recipe
 *     and Nix package rendered from that Ubuntu package - a stable release
 *     renders alpha's too, for when it is handed to alpha - and SHA256SUMS
 *     over all of them. Beside them it writes manifest.json, each channel's
 *     builds by chip and kind as `scripts/tap-publication.ts advance --linux`
 *     reads them, and assets.txt, the files to publish in order. The same
 *     packages always give the same files.
 *
 * Plain Node 24 type stripping, no imports from the app.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-alpha\.(0|[1-9]\d*))?$/;

type Channel = "stable" | "alpha";

export type RecipeInput = {
  /** The logical version: X.Y.Z or X.Y.Z-alpha.N. */
  version: string;
  /**
   * The channel whose package this is: the version's own by default. A
   * stable version handed to alpha takes alpha's package names.
   */
  channel?: Channel;
  debName: string;
  /** Its SHA-256, in hex. */
  sha256: string;
  url: string;
};

/** The configured public release address, shared with the Mac and paired-device downloads. */
export function tapUrl(version: string, debName: string): string {
  // The approved pre-storage unblock must not emit recipes pointing at absent downloads.
  if (process.env.RECIPE_HOST === "tap") {
    const prefix = version.includes("-alpha.") ? "infinitary-alpha-v" : "infinitary-v";
    return `https://github.com/infinitary-labs/homebrew-tap/releases/download/${prefix}${version}/${debName}`;
  }
  const { downloadBase } = JSON.parse(readFileSync(join(root, "packaging/release-source.json"), "utf8"));
  const base = new URL(downloadBase);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)
    throw new Error("Invalid public release destination");
  return new URL(`releases/v${version}/${debName}`, base).href;
}

function fill(template: string, fields: Record<string, string>): string {
  const filled = template.replace(/@([A-Z0-9]+)@/g, (whole, name: string) => {
    const value = fields[name];
    if (value === undefined) throw new Error(`no value for ${whole}`);
    return value;
  });
  return filled;
}

export const PACKAGE_NAMES: Record<Channel, { arch: string; nix: string }> = {
  stable: { arch: "infinitary-bin", nix: "infinitary" },
  alpha: { arch: "infinitary-alpha-bin", nix: "infinitary-alpha" },
};

/** Each channel's Arch package as Firstmate 3000 named it, which that channel's recipe replaces. */
const FIRSTMATE_ARCH_NAMES: Record<Channel, string> = {
  stable: "firstmate-3000-bin",
  alpha: "firstmate-3000-alpha-bin",
};

function channelOf(version: string): Channel {
  return version.includes("-alpha.") ? "alpha" : "stable";
}

/**
 * Each channel is its own Arch package, and the two cannot be installed
 * together. Each takes the place of Firstmate 3000's packages, which
 * provided firstmate-3000, and replaces its own channel's
 * (docs/linux-packages.md, "Arch, Omarchy and NixOS"). Each recipe names
 * its package and its channel in the app's resources folder, which the
 * update notice reads (docs/alpha.md "Updates on Linux").
 */
export function renderRecipes(input: RecipeInput): { pkgbuild: string; nix: string } {
  if (!VERSION.test(input.version)) throw new Error(`${input.version} is not X.Y.Z or X.Y.Z-alpha.N`);
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("the checksum is not a SHA-256");
  if (!/^https:\/\/\S+$/.test(input.url) || !input.url.endsWith(`/${input.debName}`)) {
    throw new Error(`${input.url} is not an https address of ${input.debName}`);
  }
  const channel = input.channel ?? channelOf(input.version);
  if (channel === "stable" && channelOf(input.version) === "alpha") {
    throw new Error(`stable never carries the alpha version ${input.version}`);
  }
  const other: Channel = channel === "alpha" ? "stable" : "alpha";
  const marker = JSON.stringify({ schemaVersion: 1, channel, version: input.version });
  const pkgbuild = fill(readFileSync(join(root, "packaging/linux/aur/PKGBUILD.in"), "utf8"), {
    PKGNAME: PACKAGE_NAMES[channel].arch,
    // Arch versions take no hyphen.
    PKGVER: input.version.replace("-", "_"),
    CONFLICTS: `'infinitary' 'firstmate-3000' '${PACKAGE_NAMES[other].arch}'`,
    REPLACES: `'firstmate-3000' '${FIRSTMATE_ARCH_NAMES[channel]}'`,
    DEBNAME: input.debName,
    URL: input.url,
    SHA256: input.sha256,
    MARKER: marker,
  });
  const nix = fill(readFileSync(join(root, "packaging/linux/nix/package.nix.in"), "utf8"), {
    PNAME: PACKAGE_NAMES[channel].nix,
    VERSION: input.version,
    URL: input.url,
    HASH: `sha256-${Buffer.from(input.sha256, "hex").toString("base64")}`,
    MARKER: marker,
  });
  return { pkgbuild, nix };
}

function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function only(dir: string, ending: string): string {
  const found = readdirSync(dir).filter((name) => name.endsWith(ending));
  if (found.length !== 1) throw new Error(`${dir} holds ${found.length} ${ending} files, not one`);
  return join(dir, found[0] as string);
}

type ManifestFile = { asset: string; sha256: string };

/**
 * The release's Linux files in `out`, from the packages in `packages`, and
 * what the tap writer reads about them. Returns the asset names in the
 * order they publish: the packages, the recipes, then SHA256SUMS.
 */
export function writeRelease(input: { version: string; packages: string; out: string }): string[] {
  const { version } = input;
  if (!VERSION.test(version)) throw new Error(`${version} is not X.Y.Z or X.Y.Z-alpha.N`);
  mkdirSync(input.out, { recursive: true });
  const packages: Record<"deb" | "rpm" | "appimage", string> = {
    deb: only(input.packages, ".deb"),
    rpm: only(input.packages, ".rpm"),
    appimage: only(input.packages, ".AppImage"),
  };
  const assets: string[] = [];
  const shared: Record<string, ManifestFile> = {};
  for (const [kind, file] of Object.entries(packages)) {
    const asset = basename(file);
    if (resolve(dirname(file)) !== resolve(input.out)) copyFileSync(file, join(input.out, asset));
    shared[kind] = { asset, sha256: sha256Of(join(input.out, asset)) };
    assets.push(asset);
  }
  const debName = basename(packages.deb);
  const debSha = shared.deb?.sha256 as string;
  const channels: Channel[] = channelOf(version) === "alpha" ? ["alpha"] : ["stable", "alpha"];
  const manifest: Partial<Record<Channel, { x64: Record<string, ManifestFile> }>> = {};
  for (const channel of channels) {
    const { pkgbuild, nix } = renderRecipes({
      version,
      channel,
      debName,
      sha256: debSha,
      url: tapUrl(version, debName),
    });
    const recipes: Record<string, ManifestFile> = {};
    for (const [kind, text, asset] of [
      ["arch", pkgbuild, `${PACKAGE_NAMES[channel].arch}-${version}.PKGBUILD`],
      ["nix", nix, `${PACKAGE_NAMES[channel].nix}-${version}.nix`],
    ] as const) {
      writeFileSync(join(input.out, asset), text);
      recipes[kind] = { asset, sha256: sha256Of(join(input.out, asset)) };
      assets.push(asset);
    }
    manifest[channel] = { x64: { ...shared, ...recipes } };
  }
  const sums = assets
    .toSorted()
    .map((asset) => `${sha256Of(join(input.out, asset))}  ${asset}\n`)
    .join("");
  writeFileSync(join(input.out, "SHA256SUMS"), sums);
  assets.push("SHA256SUMS");
  writeFileSync(join(input.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(input.out, "assets.txt"), `${assets.join("\n")}\n`);
  return assets;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args: string[]): void {
  const [command, ...rest] = args;
  const version = option(rest, "--version");
  const deb = option(rest, "--deb");
  const out = option(rest, "--out");
  const packages = option(rest, "--packages");
  if (command === "release" && version && packages && out) {
    for (const asset of writeRelease({ version, packages, out })) console.log(join(out, asset));
    return;
  }
  if (command !== "render" || !version || !deb || !out) {
    throw new Error(
      "usage: node scripts/linux-recipes.ts render --version <version> --deb <file> --out <dir> [--url <address>]\n" +
        "       node scripts/linux-recipes.ts release --version <version> --packages <dir> --out <dir>",
    );
  }
  const debName = basename(deb);
  const sha256 = createHash("sha256").update(readFileSync(deb)).digest("hex");
  const { pkgbuild, nix } = renderRecipes({
    version,
    debName,
    sha256,
    url: option(rest, "--url") ?? tapUrl(version, debName),
  });
  mkdirSync(join(out, "aur"), { recursive: true });
  mkdirSync(join(out, "nix"), { recursive: true });
  writeFileSync(join(out, "aur", "PKGBUILD"), pkgbuild);
  writeFileSync(join(out, "nix", "package.nix"), nix);
  console.log(`${join(out, "aur", "PKGBUILD")}\n${join(out, "nix", "package.nix")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
