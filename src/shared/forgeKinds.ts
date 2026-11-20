/**
 * The facts each kind of host owns where the app opens, reads and merges a
 * numbered change through the host's API (`docs/forge.md`, "What each kind
 * of host owns"): GitHub's pull requests and GitLab's merge requests, on
 * their public host or the person's own server. Shared code reads a fact
 * from this table instead of comparing a kind to a host's name, so a new
 * kind of host is one more row here, never another branch in every file.
 * A kind the app signs in to before it opens changes there (Bitbucket) has
 * a row of its sign-in facts alone (`SIGN_IN_HOSTS`).
 *
 * Pure: nothing here reads git, the network or a sign-in.
 */

/** The kinds whose proposed change is a numbered request, in the order the app lists their servers' sign-ins. */
export const CHANGE_REQUEST_KINDS = ["github", "gitlab"] as const;

export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];

/**
 * The kinds the app keeps its own sign-in for: every kind whose changes are
 * numbered requests, and Bitbucket, whose sign-in and project listing come
 * before its pull requests (`docs/forge.md`, "Bitbucket sign-in and
 * projects"). A Bitbucket project still sends its work up as a branch.
 */
export const SIGN_IN_KINDS = [...CHANGE_REQUEST_KINDS, "bitbucket"] as const;

export type SignInKind = (typeof SIGN_IN_KINDS)[number];

/** The server integration kinds, in the order Integrations lists them: GitLab's, GitHub Enterprise's, then Bitbucket's. */
export const SERVER_INTEGRATION_KINDS = ["gitlab", "github-enterprise", "bitbucket"] as const;

export type ServerIntegrationKind = (typeof SERVER_INTEGRATION_KINDS)[number];

/** What one kind of host the app signs in to owns about that sign-in. */
export type SignInHost = {
  kind: SignInKind;
  /** The kind's public host, whose name alone makes it this kind. */
  publicHost: string;
  /** The integration a server of this kind is signed in to as, one row per server. */
  serverIntegration: ServerIntegrationKind;
  /** The start of a server integration's generated id. */
  serverIdPrefix: string;
  /** Whether the public host itself is a row of the server integration, rather than its own integration. */
  publicHostIsServerRow: boolean;
  /**
   * Whether a refused git fetch waits for this kind's sign-in only on a
   * host the caller already knows as this kind: GitLab's public host
   * included, since the app holds no sign-in it cannot make.
   */
  holdsOnlyKnownHosts: boolean;
  /** A useful sample address for the kind's key form. */
  addressExample: string;
  /** The page on a host where the person makes the key the app signs in with. */
  keyPage: (host: string) => string;
  /**
   * The account the key page belongs to, where it is not the host itself
   * (Atlassian's, for Bitbucket); the key form names it.
   */
  keyAccount?: string;
  /**
   * What stops when the host refuses the sign-in, where it is not the
   * kind's numbered changes: the refused sign-in card names it.
   */
  refusedStops?: string;
  /**
   * The scopes the key needs, which the key form names because the key
   * page cannot tick them itself; absent where the page ticks them.
   */
  keyScopes?: readonly string[];
};

/** What one kind of host whose changes are numbered requests owns. */
export type ChangeRequestHost = SignInHost & {
  kind: ChangeRequestKind;
  /** The host's word for a change: a pull request, or a merge request. */
  changeWord: string;
  /** How a saved change handle names its kind. */
  handle: "pr" | "mr";
  /** What comes before a change's number: `#N` or `!N`. */
  numberPrefix: string;
  /** A change's page under the project's page, before its number. */
  requestPath: string;
  /** Every spelling of a change's page path a link may carry. */
  requestPaths: readonly string[];
  /** The page comparing two branches, under the project's page. */
  comparePath: string;
  /** Whether the host reads a project's owner and name without regard to case. */
  foldsNames: boolean;
  /** What the host writes before a draft's own title. */
  draftTitlePrefix?: string;
  /** Whether a line starting with `/` in a description runs as a command on the host. */
  quickActions: boolean;
  /** Whether a project here may choose batched pull requests. */
  batches: boolean;
};

export const CHANGE_REQUEST_HOSTS: Readonly<Record<ChangeRequestKind, ChangeRequestHost>> = {
  github: {
    kind: "github",
    publicHost: "github.com",
    serverIntegration: "github-enterprise",
    serverIdPrefix: "ghe",
    publicHostIsServerRow: false,
    changeWord: "pull request",
    handle: "pr",
    numberPrefix: "#",
    requestPath: "pull",
    requestPaths: ["pull", "pulls"],
    comparePath: "compare",
    foldsNames: true,
    quickActions: false,
    holdsOnlyKnownHosts: false,
    addressExample: "github.example.com",
    // The same `repo workflow read:org` the code asks for on github.com.
    keyPage: (host) =>
      `https://${host}/settings/tokens/new?scopes=repo,workflow,read:org&description=Infinitary`,
    batches: true,
  },
  gitlab: {
    kind: "gitlab",
    publicHost: "gitlab.com",
    serverIntegration: "gitlab",
    serverIdPrefix: "gitlab",
    publicHostIsServerRow: true,
    changeWord: "merge request",
    handle: "mr",
    numberPrefix: "!",
    requestPath: "-/merge_requests",
    requestPaths: ["-/merge_requests"],
    comparePath: "-/compare",
    foldsNames: false,
    draftTitlePrefix: "Draft: ",
    quickActions: true,
    holdsOnlyKnownHosts: true,
    addressExample: "gitlab.com",
    keyPage: (host) =>
      `https://${host}/-/user_settings/personal_access_tokens?name=Infinitary&scopes=api`,
    batches: true,
  },
};

/**
 * Bitbucket Cloud's sign-in: an API token the person makes on their
 * Atlassian account with Bitbucket's scopes, sent as a bearer token
 * (`docs/forge.md`, "Bitbucket sign-in and projects"). The scopes are the
 * ones the app reads and writes with once Bitbucket's pull requests and
 * the crew's reach are built, so one key serves them all.
 */
export const BITBUCKET_SIGN_IN: SignInHost = {
  kind: "bitbucket",
  publicHost: "bitbucket.org",
  serverIntegration: "bitbucket",
  serverIdPrefix: "bitbucket",
  publicHostIsServerRow: true,
  holdsOnlyKnownHosts: true,
  addressExample: "bitbucket.org",
  // Atlassian keeps every API token on the person's account, not on bitbucket.org.
  keyPage: () => "https://id.atlassian.com/manage-profile/security/api-tokens",
  keyAccount: "your Atlassian account",
  // Until its pull requests are built, Bitbucket's sign-in lists, clones and pushes.
  refusedStops: "list, clone or push your projects",
  keyScopes: [
    "read:user:bitbucket",
    "read:workspace:bitbucket",
    "read:repository:bitbucket",
    "write:repository:bitbucket",
    "read:pullrequest:bitbucket",
    "write:pullrequest:bitbucket",
    "read:pipeline:bitbucket",
    "write:pipeline:bitbucket",
  ],
};

/** Every kind the app signs in to, with what each owns about its sign-in. */
export const SIGN_IN_HOSTS: Readonly<Record<SignInKind, SignInHost>> = {
  ...CHANGE_REQUEST_HOSTS,
  bitbucket: BITBUCKET_SIGN_IN,
};

/** The kind, when it is one whose changes are numbered requests. */
export function changeRequestKind(kind: string | null | undefined): ChangeRequestKind | undefined {
  return CHANGE_REQUEST_KINDS.find((entry) => entry === kind);
}

/** The kind, when it is one the app keeps its own sign-in for. */
export function signInKind(kind: string | null | undefined): SignInKind | undefined {
  return SIGN_IN_KINDS.find((entry) => entry === kind);
}

/** What a kind the app signs in to owns about that sign-in, or undefined for any other kind. */
export function signInHost(kind: string | null | undefined): SignInHost | undefined {
  const known = signInKind(kind);
  return known ? SIGN_IN_HOSTS[known] : undefined;
}

/**
 * Whether the app keeps its own sign-in for this kind of host, on its
 * public host or a server: a computer that runs work keeps its own, and a
 * refused git fetch can wait for it.
 */
export function signsInTo(kind: string | null | undefined): boolean {
  return signInKind(kind) !== undefined;
}

/** The facts of a kind whose changes are numbered requests, or undefined for any other kind. */
export function changeRequestHost(kind: string | null | undefined): ChangeRequestHost | undefined {
  const known = changeRequestKind(kind);
  return known ? CHANGE_REQUEST_HOSTS[known] : undefined;
}

/**
 * The facts a host's change is named and reached by: its own kind's, and
 * GitHub's for a kind the table does not hold, as the app has always named
 * a numbered request on any other host.
 */
export function changeHostOf(kind: string | null | undefined): ChangeRequestHost {
  return changeRequestHost(kind) ?? CHANGE_REQUEST_HOSTS.github;
}

/** The kind whose public host this is, or undefined. */
export function changeRequestHostAt(
  host: string | null | undefined,
): ChangeRequestHost | undefined {
  return Object.values(CHANGE_REQUEST_HOSTS).find((entry) => entry.publicHost === host);
}

/** Whether an integration kind is one row per signed-in server. */
export function isServerIntegration(
  kind: string | null | undefined,
): kind is ServerIntegrationKind {
  return SERVER_INTEGRATION_KINDS.some((entry) => entry === kind);
}

/** The kind of host a server integration signs in to. */
export function hostOfServerIntegration(
  integration: string | null | undefined,
): SignInHost | undefined {
  return Object.values(SIGN_IN_HOSTS).find((entry) => entry.serverIntegration === integration);
}

/** The kind of host a server integration signs in to, by its typed kind. */
export function serverIntegrationHost(integration: ServerIntegrationKind): SignInHost {
  const facts = hostOfServerIntegration(integration);
  if (!facts) throw new Error(`No kind of host signs in as ${integration}.`);
  return facts;
}

/**
 * The address a kind's key form opens on: its public host where that host
 * is one of its server rows (GitLab's, changed by the person for their own
 * server), else empty (GitHub Enterprise's).
 */
export function keyFormStartHost(kind: string | null | undefined): string {
  const facts = signInHost(kind);
  return facts?.publicHostIsServerRow ? facts.publicHost : "";
}

/** The page of change `number` in the project at `project` (`owner/name`, already spelled for a link). */
export function changePageUrl(
  kind: string | null | undefined,
  host: string,
  project: string,
  number: number,
): string {
  return `https://${host}/${project}/${changeHostOf(kind).requestPath}/${number}`;
}
