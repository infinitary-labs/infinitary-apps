import type { BuildFlavor } from "./userDataFolders";

/**
 * Code names in both spellings (the Infinitary rename, FI3-1780's plan; the
 * captain's answer there: every code name is renamed, and the old names stay
 * as aliases). Step 2 taught Firstmate 3000 to read both while it writes its
 * own; step 8 made this build write Infinitary's and read both, so a
 * Firstmate 3000 computer paired with it, or a profile that comes back to
 * it, keeps working. No person reads either: they name channels on the
 * connection, card hooks, panel imports and the background service a system
 * keeps.
 *
 * `fm` is Firstmate 3000's spelling and `inf` Infinitary's. A name spelled
 * out in full takes the long form: `window.infinitary`, `@infinitary/ui`.
 */
export const SPELLINGS = ["fm", "inf"] as const;
export type Spelling = (typeof SPELLINGS)[number];

/** The spelling this build writes its code names in: channels, card hooks, panel modules. */
export const OWN_SPELLING: Spelling = "inf";

/**
 * The spelling of this build's identity as a system knows it: its data
 * folders, the folder a computer keeps its work in, and its background
 * service's label (`APP_IDENTITIES`). It moved apart from the code names:
 * step 10 of the rename made the app Infinitary, with its bundle id and its
 * name, and so switched the one-time move on (src/core/folderMove/).
 */
export const OWN_IDENTITY: Spelling = "inf";

/** The spelling every version reads: a version from before the rename knows only it. */
export const FIRST_SPELLING: Spelling = "fm";

/** Each spelling's long form, where a name spells the product out. */
export const LONG_SPELLING: Readonly<Record<Spelling, string>> = {
  fm: "firstmate",
  inf: "infinitary",
};

// --- the connection ---------------------------------------------------------

/**
 * Names that keep one spelling for good: the orders a home of any version
 * asks a computer to bring it up to date (docs/devices.md, "Updating over the
 * connection" and "Downloading over the connection"). `/firstmate`, where
 * that computer then gets the home's app, is a path rather than a channel
 * and keeps its name the same way.
 */
export const FROZEN_CHANNELS: ReadonlySet<string> = new Set([
  "fm:firstmate:update",
  "fm:firstmate:update-download",
  "fm:firstmate:update-progress",
]);

function spellingOfChannel(channel: string): Spelling | undefined {
  return SPELLINGS.find((spelling) => channel.startsWith(`${spelling}:`));
}

/**
 * A channel as `spelling` writes it. A frozen channel, or one in no known
 * spelling, is returned as it is.
 */
export function channelIn(channel: string, spelling: Spelling): string {
  const from = spellingOfChannel(channel);
  if (!from || from === spelling || FROZEN_CHANNELS.has(channel)) return channel;
  const renamed = `${spelling}:${channel.slice(from.length + 1)}`;
  // A name whose other spelling would be frozen is not that channel.
  return FROZEN_CHANNELS.has(renamed) ? channel : renamed;
}

/** A channel as this build knows it, whichever spelling the other side wrote. */
export function ownChannel(channel: string): string {
  return channelIn(channel, OWN_SPELLING);
}

/** The spellings a hello or welcome says its side reads, of those this build knows. */
export function readSpellings(said: readonly string[] | undefined): Spelling[] | undefined {
  return said?.filter((spelling): spelling is Spelling =>
    (SPELLINGS as readonly string[]).includes(spelling),
  );
}

/**
 * The spelling to write to the other side of a connection: `speaks`, when
 * that side said it reads it, otherwise the first spelling, which every
 * version reads. A side that said nothing reads only the first.
 */
export function spellingFor(
  peerReads: readonly Spelling[] | undefined,
  speaks: Spelling = OWN_SPELLING,
): Spelling {
  return (peerReads ?? [FIRST_SPELLING]).includes(speaks) ? speaks : FIRST_SPELLING;
}

// --- card hooks -------------------------------------------------------------

/** A card hook's attribute in every spelling, this build's first: `data-inf-action`, `data-fm-action`. */
export function hookAttributes(name: string): string[] {
  return [OWN_SPELLING, ...SPELLINGS.filter((spelling) => spelling !== OWN_SPELLING)].map(
    (spelling) => `data-${spelling}-${name}`,
  );
}

/** Whether an element's attributes carry the hook in any spelling. */
export function hasHook(
  attribs: Readonly<Record<string, string>> | undefined,
  name: string,
): boolean {
  return hookValue(attribs, name) !== undefined;
}

/** The hook's value on an element, in this build's spelling first. */
export function hookValue(
  attribs: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!attribs) return undefined;
  for (const attribute of hookAttributes(name))
    if (Object.hasOwn(attribs, attribute)) return attribs[attribute];
  return undefined;
}

/** A CSS selector matching the hook in any spelling. */
export function hookSelector(name: string): string {
  return hookAttributes(name)
    .map((attribute) => `[${attribute}]`)
    .join(",");
}

/** Whether a `class` attribute holds the stylesheet's class in any spelling: `fm-pictures`, `inf-pictures`. */
export function hasHookClass(classes: string | undefined, name: string): boolean {
  const tokens = (classes ?? "").split(/\s+/);
  return SPELLINGS.some((spelling) => tokens.includes(`${spelling}-${name}`));
}

// --- panel imports ----------------------------------------------------------

/**
 * A host module a panel imports, as this build names it: `@firstmate/ui`
 * is `@infinitary/ui`. A module in no known spelling is returned as it is.
 */
export function ownHostModule(specifier: string): string {
  for (const spelling of SPELLINGS) {
    const scope = `@${LONG_SPELLING[spelling]}/`;
    if (specifier.startsWith(scope))
      return `@${LONG_SPELLING[OWN_SPELLING]}/${specifier.slice(scope.length)}`;
  }
  return specifier;
}

// --- the app as a system knows it -------------------------------------------

/**
 * Each spelling's app as a system knows it: its Mac bundle id, and its Mac
 * app's name for each flavor. Infinitary's are the
 * captain's (FI3-1720's answers: `com.getinfinitary.infinitary`, with `.dev`
 * for development), which this build takes (`OWN_IDENTITY`).
 */
export const APP_IDENTITIES: Readonly<
  Record<Spelling, { bundleId: string; app: Readonly<Record<BuildFlavor, string>> }>
> = {
  fm: {
    bundleId: "com.kunchenguid.firstmate3000",
    app: { release: "Firstmate 3000", dev: "Firstmate 3000 Dev" },
  },
  inf: {
    bundleId: "com.getinfinitary.infinitary",
    app: { release: "Infinitary", dev: "Infinitary Dev" },
  },
};

/**
 * The background work's label for a spelling's app (docs/helper.md, "In the
 * background"): its bundle id, `.dev` for the development flavor, then
 * `.work`. One per flavor, so a development copy never stands in for the
 * installed one.
 */
export function workLabelOf(spelling: Spelling, flavor: BuildFlavor): string {
  const { bundleId } = APP_IDENTITIES[spelling];
  return `${bundleId}${flavor === "dev" ? ".dev" : ""}.work`;
}

/** Every label a background of this flavor may be kept under, this build's first. */
export function workLabels(flavor: BuildFlavor): string[] {
  return [OWN_IDENTITY, ...SPELLINGS.filter((spelling) => spelling !== OWN_IDENTITY)].map(
    (spelling) => workLabelOf(spelling, flavor),
  );
}

/** Which spelling's Mac app a bundle is for this flavor, by its file name (`Infinitary.app`). */
export function spellingOfMacApp(bundleName: string, flavor: BuildFlavor): Spelling | undefined {
  return SPELLINGS.find((spelling) => `${APP_IDENTITIES[spelling].app[flavor]}.app` === bundleName);
}
