import {
  type ForgeKind,
  forgeOf,
  forgePlace,
  GITHUB_COM,
  type KnownForgeHost,
} from "@shared/forge";

/**
 * The kinds of host the app signs in to itself, whose git refusal its own
 * sign-in can recover: GitHub, on github.com and on the person's own
 * server, and GitLab on gitlab.com or a known self-hosted server.
 */
const SIGNED_IN_KINDS: ReadonlySet<ForgeKind> = new Set<ForgeKind>(["github", "gitlab"]);

/** A host refusal that the app's own sign-in for that host can recover. */
export class ForgeAuthRequiredError extends Error {
  constructor(
    message: string,
    /** The host whose sign-in is needed: the task waits behind `forge-sign-in:<host>`. */
    readonly host: string = GITHUB_COM,
    /** The person's word for it: "GitHub", or the host's own address. */
    readonly place: string = "GitHub",
  ) {
    super(message);
    this.name = "ForgeAuthRequiredError";
  }
}

/**
 * Classify only git's definitive HTTPS credential prompts/refusals for an
 * origin on a host the app signs in to - github.com, or a host on the
 * person's own server it knows (`known`). Connection, DNS, timeout, SSH
 * and other-host failures remain ordinary fetch failures.
 */
export function forgeAuthRequired(
  origin: string | null | undefined,
  caught: unknown,
  known: readonly KnownForgeHost[] = [],
): ForgeAuthRequiredError | undefined {
  const where = forgeOf(origin, known);
  if (!SIGNED_IN_KINDS.has(where.kind) || !where.host) return undefined;
  // The home knows its public key hosts too. A work computer currently
  // offers only GitHub's code; never hold it for a sign-in it cannot make.
  if (
    where.kind === "gitlab" &&
    !known.some((entry) => entry.host === where.host && entry.kind === "gitlab")
  )
    return undefined;
  const failure = caught as { stderr?: unknown; message?: unknown };
  const message = [failure?.stderr, failure?.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const host = where.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const https = new RegExp(`https://(?:[^\\s/'@]+@)?${host}(?::\\d+)?(?:/|['"\\s])`, "i");
  const unableToPrompt =
    /could not read Username for/i.test(message) &&
    https.test(message) &&
    /unable to read askpass response/i.test(message) &&
    /terminal prompts disabled/i.test(message);
  const rejectedCredential = /Authentication failed for/i.test(message) && https.test(message);
  if (!unableToPrompt && !rejectedCredential) return undefined;
  const place = forgePlace(where) ?? where.host;
  return new ForgeAuthRequiredError(
    `${place} requires sign-in to fetch this project.`,
    where.host,
    place,
  );
}
