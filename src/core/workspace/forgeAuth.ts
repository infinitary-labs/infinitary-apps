import { forgeOf, forgePlace, GITHUB_COM, type KnownForgeHost } from "@shared/forge";
import { signInHost, signsInTo } from "@shared/forgeKinds";

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
  // The kinds of host the app signs in to itself, whose git refusal its own
  // sign-in can recover: GitHub, on github.com and on the person's own
  // server, GitLab on gitlab.com or a known self-hosted server, and
  // Bitbucket on bitbucket.org.
  if (!signsInTo(where.kind) || !where.host) return undefined;
  // A kind such as GitLab or Bitbucket is held only where the caller knows it as that
  // kind (its public host or a sign-in on file); never hold it for a sign-in
  // it cannot make.
  if (
    signInHost(where.kind)?.holdsOnlyKnownHosts &&
    !known.some((entry) => entry.host === where.host && entry.kind === where.kind)
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
