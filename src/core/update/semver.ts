/**
 * Semantic Versioning 2.0.0 precedence (semver.org section 11), for the
 * update reader's channel versions (docs/alpha.md "Update channels"):
 * `0.1.25-alpha.10` is newer than `0.1.25-alpha.2`, a stable `0.1.25` is
 * newer than any `0.1.25-alpha.N`, and the next numeric core is newer than
 * both. Build metadata never changes precedence.
 */

export type SemVer = {
  major: string;
  minor: string;
  patch: string;
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  prerelease: string[];
  build: string[];
};

// semver.org's own grammar; numeric identifiers carry no leading zero.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC = /^\d+$/;

/** A strict SemVer: no leading `v`, no surrounding space. */
export function parseSemver(version: string): SemVer | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    major: match[1] as string,
    minor: match[2] as string,
    patch: match[3] as string,
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
  };
}

/** Numeric identifiers without leading zeros: longer is larger, then by digit. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : a > b ? 1 : -1;
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  // A numeric identifier has lower precedence than an alphanumeric one.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version without a prerelease outranks the same core with one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const diff = compareIdentifier(a[index] as string, b[index] as string);
    if (diff !== 0) return diff;
  }
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
}

/**
 * Returns >0 when a is newer than b, <0 when older, 0 for equal precedence,
 * and null when either is not a SemVer: an unreadable version is never
 * newer or older than anything.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"] as const) {
    const diff = compareNumeric(left[part], right[part]);
    if (diff !== 0) return diff;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** True only when `candidate` is a readable version strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return (compareSemver(candidate, current) ?? 0) > 0;
}

/** A stable version: `X.Y.Z` with neither prerelease nor build metadata. */
export function isStableVersion(version: string): boolean {
  const parsed = parseSemver(version);
  return Boolean(parsed && parsed.prerelease.length === 0 && parsed.build.length === 0);
}

/** An alpha logical version: exactly `X.Y.Z-alpha.N`, N numeric, no build metadata. */
export function isAlphaVersion(version: string): boolean {
  const parsed = parseSemver(version);
  return Boolean(
    parsed &&
      parsed.build.length === 0 &&
      parsed.prerelease.length === 2 &&
      parsed.prerelease[0] === "alpha" &&
      NUMERIC.test(parsed.prerelease[1] as string),
  );
}
