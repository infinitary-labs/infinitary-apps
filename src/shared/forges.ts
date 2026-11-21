import { z } from "zod";
import { HERE } from "./deviceNames";
import { CHANGE_REQUEST_HOSTS, type SignInKind, signInHost } from "./forgeKinds";

/**
 * The app's own sign-ins where projects live (git integration PR 1.2,
 * `docs/forge.md`): the wire shape Settings -> Integrations renders in its
 * host sign-in forms. One sign-in per host: github.com
 * signs in with a code, and GitHub Enterprise with a key made there (`docs/forge.md`,
 * "Hosts on your own server"). GitLab offers browser sign-in or a key on its public
 * host or the person's server. The row is a chip row so a later host, or a
 * later kind of server, is one more chip.
 *
 * Nothing here carries a secret but the one request that hands a key made
 * on such a host to the core (`forgeKeySignInSchema`): the sign-in itself
 * stays in its 0600 file under `userData/forges/<host>/`
 * (`src/core/forge/signIns.ts`), and only the core and the app's own git
 * helper read it.
 *
 * A sign-in is OPTIONAL by the captain's standing constraint: a project
 * kept on this Mac never needs one, so no state here is a warning when
 * nothing is signed in.
 */

/**
 * The health of one sign-in, through the five-rule contract
 * (`src/core/accounts/credentialHealth.ts`): `ok` is the host answering who
 * the person is; `needs_reauth` only from the host's own refusal (a 401 -
 * a GitHub OAuth App sign-in does not renew, so the refusal is the proof);
 * `unavailable` is the host out of reach or rate-limited, retried and never
 * a sign-out; `unknown` is a sign-in the app could not read or has not
 * checked yet, never absent.
 */
export const forgeSignInStateSchema = z.enum(["ok", "needs_reauth", "unavailable", "unknown"]);
export type ForgeSignInState = z.infer<typeof forgeSignInStateSchema>;

/**
 * A kind of host the person runs on their own server, which the app signs
 * in to with a key the person makes there rather than a code: GitHub
 * Enterprise (`kind` "github") and GitLab (`kind` "gitlab"). GitLab also offers
 * browser sign-in after the person registers an application there. `kind`
 * is the forge kind as a string, so a later kind of server is a new value.
 */
export const forgeServerViewSchema = z
  .object({
    kind: z.string().min(1).max(32),
    /** What that kind of server is called ("GitHub Enterprise"). */
    name: z.string().min(1).max(64),
    /** This kind also offers browser sign-in with a registered application. */
    browser: z.boolean().optional(),
  })
  .strict();
export type ForgeServerView = z.infer<typeof forgeServerViewSchema>;

export const forgeSignInViewSchema = z
  .object({
    /** The host name the sign-in is for, lower case ("github.com"). */
    host: z.string().min(1).max(253),
    /** The person's word for the host ("GitHub", a GitHub Enterprise host's address). */
    name: z.string().min(1).max(64),
    /** Who the host says the person is; null until it has answered once. */
    login: z.string().max(100).nullable(),
    state: forgeSignInStateSchema,
    /** How many of the person's projects live on this host. */
    projects: z.number().int().nonnegative(),
    /** When the sign-in was made. */
    since: z.number().int().nonnegative(),
    /** Public application identifier, never an application secret. */
    applicationId: z.string().max(256).optional(),
    /** The kind of server and the methods it offers. */
    server: forgeServerViewSchema.optional(),
    /** The sign-in is GitHub CLI's, asked each time it is needed; absent for the app's own. */
    way: z.enum(["cli"]).optional(),
  })
  .strict();
export type ForgeSignInView = z.infer<typeof forgeSignInViewSchema>;

/** A host that offers a sign-in (the chip row's chips). */
export const forgeHostViewSchema = z
  .object({
    host: z.string().min(1).max(253),
    name: z.string().min(1).max(64),
    /** The kind of server and the methods it offers. */
    server: forgeServerViewSchema.optional(),
  })
  .strict();
export type ForgeHostView = z.infer<typeof forgeHostViewSchema>;

/**
 * A sign-in in flight: the code the person types on the host's page, the
 * page, and when the code stops working. The device flow needs no secret
 * in the app; this is everything the aside shows.
 */
export const forgeSignInFlowSchema = z
  .object({
    host: z.string().min(1).max(253),
    userCode: z.string().min(1).max(32),
    verificationUri: z.string().url(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type ForgeSignInFlow = z.infer<typeof forgeSignInFlowSchema>;

/**
 * Why the host would not start a browser sign-in, from its answer alone:
 * the application may not use the code sign-in (`not-allowed`, OAuth
 * `access_denied` or `unauthorized_client`), the host does not accept the
 * application (`client`, `invalid_client`), the application lacks a scope
 * the app asks for (`scope`, `invalid_scope`), the host found nothing at
 * the sign-in address (`not-found`, a 404 or an answer that is not
 * GitLab's JSON), the host could not be reached (`unreachable`, a network
 * failure or a 5xx), or any other answer (`answer`).
 */
export const forgeStartProblemSchema = z.enum([
  "not-allowed",
  "client",
  "scope",
  "not-found",
  "unreachable",
  "answer",
]);
export type ForgeStartProblem = z.infer<typeof forgeStartProblemSchema>;

/**
 * How the last sign-in ended when it did not end signed in: the code ran
 * out (`expired`, offered again on request) or the host could not be
 * asked (`failed`). A person saying no on the host's page is quiet - the
 * flow simply ends - so it is not an outcome here.
 */
export const forgeSignInEndSchema = z
  .object({
    host: z.string().min(1).max(253),
    end: z.enum(["expired", "failed"]),
    /** Why a browser sign-in could not start, as the host answered; absent when it gave no reason. */
    problem: forgeStartProblemSchema.optional(),
  })
  .strict();
export type ForgeSignInEnd = z.infer<typeof forgeSignInEndSchema>;

export const forgesViewSchema = z
  .object({
    signIns: z.array(forgeSignInViewSchema),
    hosts: z.array(forgeHostViewSchema),
    /** The kinds of server a host can be added by its address and a key: a chip each. */
    servers: z.array(forgeServerViewSchema).optional(),
    flow: forgeSignInFlowSchema.nullable(),
    ended: forgeSignInEndSchema.nullable(),
    /** GitHub CLI is installed on this computer, so a GitHub host can sign in through it. */
    githubCli: z.boolean().optional(),
  })
  .strict();
export type ForgesView = z.infer<typeof forgesViewSchema>;

export const forgeProjectSchema = z.object({
  fullName: z.string(),
  cloneUrl: z.string(),
  url: z.string().nullable(),
  updatedAt: z.string().nullable(),
  private: z.boolean(),
});
export type ForgeProject = z.infer<typeof forgeProjectSchema>;

/**
 * A host's projects as Add project lists them, and whether the listing read
 * them all: false where it stopped at its page budget, which can leave
 * projects anywhere unchecked, so Add project says some may be missing and
 * a link adds one.
 */
export const forgeProjectListingSchema = z.object({
  projects: z.array(forgeProjectSchema),
  complete: z.boolean(),
});
export type ForgeProjectListing = z.infer<typeof forgeProjectListingSchema>;

/**
 * A sign-in to a host on the person's own server, as Settings hands it to
 * the core once: the kind of server, the host's address as the person
 * typed it, and the key they made there. The core checks the key with the
 * host before it keeps it, and the key never comes back to the window.
 */
export const forgeKeySignInSchema = z
  .object({
    kind: z.string().min(1).max(32),
    address: z.string().min(1).max(2000),
    key: z.string().min(1).max(1024),
  })
  .strict();
export type ForgeKeySignIn = z.infer<typeof forgeKeySignInSchema>;

/** A public application registered on the chosen host; no client secret is accepted. */
export const forgeBrowserSignInSchema = z
  .object({
    kind: z.string().min(1).max(32),
    address: z.string().min(1).max(2000),
    applicationId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{20,256}$/),
  })
  .strict();
export type ForgeBrowserSignIn = z.infer<typeof forgeBrowserSignInSchema>;

/** The words browser setup shows when the host would not start the sign-in. */
export function forgeStartProblemText(
  problem: ForgeStartProblem | undefined,
  host: string,
): string {
  switch (problem) {
    case "not-allowed":
      return `${host} does not allow this application to sign in with a code. Edit the application on ${host}, turn on ${FORGE_BROWSER_WORDS.deviceGrant}, save, and try again.`;
    case "client":
      return `${host} did not accept this application. Check the Application ID, turn off Confidential on the application, and try again.`;
    case "scope":
      return `This application lacks api or write_repository. Edit the application on ${host}, select both, save, and try again.`;
    case "not-found":
      return `${host} did not find this application. Check that you pasted the whole Application ID from ${host}, or use a key instead.`;
    case "unreachable":
      return `Could not reach ${host}. Check the address and your connection, then try again.`;
    default:
      return FORGE_BROWSER_WORDS.failed;
  }
}

export const FORGE_BROWSER_WORDS = {
  applicationId: "Application ID",
  register: "Register Infinitary once per server",
  start: "Get a sign-in code",
  useKey: "Use a key instead",
  useBrowser: "Use browser sign-in",
  /** GitLab's own label for the application setting that allows the code sign-in. */
  deviceGrant: "Device authorization grant",
  failed:
    "Could not start browser sign-in. Check the address and Application ID, or use a key instead.",
  requires:
    "Browser sign-in needs GitLab 17.9 or newer. If your server limits registration, ask its administrator for an Application ID or use a key.",
} as const;

export function forgeApplicationsPage(host: string): string {
  return `https://${host}/-/user_settings/applications`;
}

/** Required by GitLab's registration form, unused by its browser-and-code flow. */
export function forgeBrowserRedirect(host: string): string {
  return `https://${host}/oauth/device`;
}

/**
 * Why a key sign-in was not kept: the address names no host; it names a
 * public host that signs in with its own button (github.com); the key is
 * not one a host issues; the host refused it; it could not be reached; or
 * it does not answer as that kind of server does.
 */
export const forgeKeyProblemSchema = z.enum([
  "address",
  "public-host",
  "key",
  "refused",
  "unreachable",
  "not-server",
]);
export type ForgeKeyProblem = z.infer<typeof forgeKeyProblemSchema>;

export const forgeKeySignInResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), host: z.string().min(1).max(253) }).strict(),
  z
    .object({
      ok: z.literal(false),
      problem: forgeKeyProblemSchema,
      host: z.string().max(253).nullable(),
    })
    .strict(),
]);
export type ForgeKeySignInResult = z.infer<typeof forgeKeySignInResultSchema>;

/**
 * Why a sign-in through GitHub CLI was not kept (`docs/forge.md`, "GitHub
 * CLI's sign-in"): the host is not a GitHub host; GitHub CLI is not on this
 * computer; it holds no sign-in for the host; the host refused it; the host
 * could not be reached; or GitHub CLI could not be asked.
 */
export const forgeCliProblemSchema = z.enum([
  "not-github",
  "missing",
  "none",
  "refused",
  "unreachable",
  "failed",
]);
export type ForgeCliProblem = z.infer<typeof forgeCliProblemSchema>;

export const forgeCliSignInResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), host: z.string().min(1).max(253) }).strict(),
  z
    .object({
      ok: z.literal(false),
      problem: forgeCliProblemSchema,
      host: z.string().max(253).nullable(),
    })
    .strict(),
]);
export type ForgeCliSignInResult = z.infer<typeof forgeCliSignInResultSchema>;

/** The words for GitHub CLI's sign-in: GitHub's own name for the program, as the captain chose. */
export const FORGE_CLI_WORDS = {
  offer: forgeCliOffer(),
  use: "Use GitHub CLI",
  through: "through GitHub CLI",
  checking: "Asking GitHub CLI...",
  reauth: "Sign in to GitHub CLI again, then Check now.",
  failed: "Could not ask GitHub CLI. Try again.",
} as const;

/**
 * The line over "Use GitHub CLI": on this computer, or `where` for a
 * computer that runs work ("on Mac mini", "as Builder"), whose own GitHub CLI
 * is asked (docs/forge.md, "A computer's own sign-in").
 */
export function forgeCliOffer(where = `on ${HERE.this}`): string {
  return `If your organization blocks apps like Infinitary, use the GitHub sign-in that GitHub CLI already holds ${where}.`;
}

/**
 * The words a sign-in through GitHub CLI says when it was not kept; `on`
 * names a computer that runs work when its own GitHub CLI was asked.
 */
export function forgeCliProblemText(
  problem: ForgeCliProblem,
  host: string | null,
  on?: string,
): string {
  const where = host ?? "that address";
  switch (problem) {
    case "not-github":
      return `${where} is not a GitHub host.`;
    case "missing":
      return on
        ? `GitHub CLI is no longer found ${on}.`
        : `GitHub CLI is no longer on ${HERE.this}.`;
    case "none":
      return `GitHub CLI is not signed in to ${where}. Sign in to GitHub CLI, then try again.`;
    case "refused":
      return `${where} did not accept GitHub CLI's sign-in. Sign in to GitHub CLI again, then try again.`;
    case "unreachable":
      return `Could not reach ${where}. Check your connection and try again.`;
    case "failed":
      return FORGE_CLI_WORDS.failed;
  }
}

/** The refused sign-in card's opening words when the sign-in is GitHub CLI's. */
export function forgeCliRefusedText(name: string): string {
  return `${name} no longer accepts GitHub CLI's sign-in on ${HERE.this}, so your first mate cannot open, check or merge pull requests there. Sign in to GitHub CLI again, then choose Check now in Integrations.`;
}

/** GitHub on the person's own server, as the chip and the row call it. */
export const GITHUB_ENTERPRISE: ForgeServerView = { kind: "github", name: "GitHub Enterprise" };

/** GitLab on gitlab.com or the person's own server, with browser and key sign-in. */
export const GITLAB: ForgeServerView = { kind: "gitlab", name: "GitLab", browser: true };

/** Bitbucket Cloud, which signs in with an API token the person makes on their Atlassian account. */
export const BITBUCKET: ForgeServerView = { kind: "bitbucket", name: "Bitbucket" };

/** Each kind of server's view, as its chip and row call it. */
export const SERVER_VIEWS: Readonly<Record<SignInKind, ForgeServerView>> = {
  github: GITHUB_ENTERPRISE,
  gitlab: GITLAB,
  bitbucket: BITBUCKET,
};

/** A useful sample address for each kind's existing key form. */
export function forgeAddressExample(kind: string): string {
  return (signInHost(kind) ?? CHANGE_REQUEST_HOSTS.github).addressExample;
}

/**
 * The person's word for a host on their own server: its own address, the
 * name the project's address already uses - or, for an address too long
 * for a row, what that kind of server is called.
 */
export function serverHostName(host: string, server: ForgeServerView): string {
  return host.length <= 64 ? host : server.name;
}

/**
 * The page on a host where the person makes the key the app signs in
 * with. On GitHub Enterprise its boxes are already ticked for what the
 * sign-in may do: the same `repo workflow read:org` the code asks for on
 * github.com. A kind of server with no such page opens the host itself.
 */
export function forgeKeyPage(kind: string, host: string): string {
  return signInHost(kind)?.keyPage(host) ?? `https://${host}/`;
}

/** Where the key page is, by its address's host: the host itself, or Atlassian's for Bitbucket. */
export function forgeKeyPlace(kind: string, host: string): string {
  return new URL(forgeKeyPage(kind, host)).host;
}

/**
 * The key form's line naming the scopes a kind's key needs, where its key
 * page cannot tick them (Bitbucket's API token); null where it can.
 */
export function forgeKeyScopesText(kind: string): string | null {
  const scopes = signInHost(kind)?.keyScopes;
  if (!scopes?.length) return null;
  const name = SERVER_VIEWS[kind as SignInKind]?.name ?? kind;
  return `Choose Create API token with scopes, pick ${name} as the app, and tick these scopes: ${scopes.join(", ")}.`;
}

/** The words a key sign-in says when it was not kept. */
export function forgeKeyProblemText(
  problem: ForgeKeyProblem,
  host: string | null,
  server: ForgeServerView,
): string {
  const where = host ?? "that address";
  switch (problem) {
    case "address":
      return `Enter your ${server.name} address, such as ${forgeAddressExample(server.kind)}.`;
    case "public-host":
      return `${where} signs in with its own button above.`;
    case "key":
      return `That is not a key from ${where}. Copy the whole key and paste it again.`;
    case "refused":
      return `${where} did not accept that key. Make a new one and try again.`;
    case "unreachable":
      return `Could not reach ${where}. Check the address and your connection.`;
    case "not-server":
      return `${where} did not answer as ${server.name} does. Check the address.`;
  }
}

/** A host name the store may hold: lower-case DNS characters, never a path. */
export const FORGE_HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function isForgeHostName(host: string): boolean {
  return FORGE_HOST_NAME.test(host);
}

/** The words a refusal for a missing sign-in opens with: the typed fact, said once. */
export function notSignedInText(name: string, host: string): string {
  return name === host ? `Not signed in to ${host}` : `Not signed in to ${name} (${host})`;
}

/** The one host card for a sign-in the host refused: a singleton per host. */
export function forgeSignInCardId(host: string): string {
  return `card-forge-${host}`;
}

/**
 * The sign-in card's title: "Sign in to GitHub again" for a sign-in the host
 * refused, "Sign in to GitHub" for a task waiting on one never made.
 */
export function forgeSignInTitle(name: string, reauth = true): string {
  return reauth ? `Sign in to ${name} again` : `Sign in to ${name}`;
}

/** The refused sign-in card's opening words: what the host stopped accepting, and what that stops. */
export function forgeRefusedText(name: string): string {
  return `${name} no longer accepts the sign-in on ${HERE.this}, so your first mate cannot open, check or merge pull requests there.`;
}

/** Every sign-in card's last words: a project kept on this Mac never needs the sign-in. */
export const LOCAL_PROJECTS_UNAFFECTED = `Projects kept on ${HERE.this} are not affected.`;

/** The section's own words in Settings -> Projects: its quiet line, a refused row, the code's copy feedback, and the key sign-in. */
export const FORGE_SECTION_WORDS = {
  quiet: `Projects kept on ${HERE.this} need no sign-in.`,
  reauth: "Sign in again.",
  copied: "Code copied.",
  copyFailed: "Could not copy the code. Select it and copy it yourself.",
  address: "Address",
  key: "Key",
  keyFailed: "Could not check the key. Try again.",
} as const;

/** The key sign-in's opening line: where to make the key, and that it stays on this Mac. */
export function forgeKeyIntro(host: string | null, server: ForgeServerView): string {
  const account = signInHost(server.kind)?.keyAccount;
  const where = account
    ? `${account}${host ? ` at ${forgeKeyPlace(server.kind, host)}` : ""}`
    : (host ?? `your ${server.name}`);
  return `Make a key on ${where}, then paste it here. It stays on ${HERE.this}.`;
}

/**
 * One of the person's open proposed changes where their projects live, as
 * the `forge.changes` panel read serves it (git integration PR 1.2): the
 * rows a personal panel renders, already shaped - a pull request on
 * GitHub, a merge request on GitLab. `checks` is the one reading a row's
 * status dot needs.
 */
export const forgeChangeRowSchema = z
  .object({
    host: z.string().min(1).max(253),
    /** `owner/name`; a GitLab project's whole path, `group/subgroup/name`. */
    project: z.string().min(1).max(200),
    number: z.number().int().nonnegative(),
    /** The host's own name for it: `#12` on GitHub, `!4` on GitLab. */
    label: z.string().min(1).max(32).optional(),
    title: z.string().max(1000),
    url: z.string().max(2000),
    draft: z.boolean(),
    checks: z.enum(["passed", "failed", "pending", "none"]),
    updatedAt: z.string().max(64).nullable(),
  })
  .strict();
export type ForgeChangeRow = z.infer<typeof forgeChangeRowSchema>;

export const forgeChangesViewSchema = z
  .object({
    /** Whether any host has the app's sign-in; with none there is nothing to list. */
    signedIn: z.boolean(),
    /** False when a signed-in host could not be read this time; the rows are then empty. */
    reachable: z.boolean(),
    changes: z.array(forgeChangeRowSchema),
  })
  .strict();
export type ForgeChangesView = z.infer<typeof forgeChangesViewSchema>;
