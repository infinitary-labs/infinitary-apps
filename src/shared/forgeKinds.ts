/**
 * The facts each kind of host owns where the app opens, reads and merges a
 * numbered change through the host's API (`docs/forge.md`, "What each kind
 * of host owns"): GitHub's pull requests and GitLab's merge requests, on
 * their public host or the person's own server. Shared code reads a fact
 * from this table instead of comparing a kind to a host's name, so a new
 * kind of host is one more row here, never another branch in every file.
 * Bitbucket Cloud's pull requests are one more row (`docs/forge.md`,
 * "Bitbucket pull requests").
 *
 * Pure: nothing here reads git, the network or a sign-in.
 */

/** The kinds whose proposed change is a numbered request, in the order the app lists their servers' sign-ins. */
export const CHANGE_REQUEST_KINDS = ["github", "gitlab", "bitbucket"] as const;

export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];

/**
 * The kinds the app keeps its own sign-in for: every kind whose changes are
 * numbered requests.
 */
export const SIGN_IN_KINDS = CHANGE_REQUEST_KINDS;

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
  /**
   * How the compare page names the branch a change adds and the branch it
   * builds on, already spelled for a link: `base...branch` where absent.
   */
  compareRange?: (base: string, branch: string) => string;
  /** Whether the host reads a project's owner and name without regard to case. */
  foldsNames: boolean;
  /** What the host writes before a draft's own title. */
  draftTitlePrefix?: string;
  /** Whether a line starting with `/` in a description runs as a command on the host. */
  quickActions: boolean;
  /** Whether a project here may choose batched pull requests. */
  batches: boolean;
  /**
   * What a server of this kind does differently from its public host, where
   * the person's own server runs another product: Bitbucket Data Center
   * beside Bitbucket Cloud (`docs/forge.md`, "Bitbucket Data Center").
   * Absent where a server answers as the public host does.
   */
  server?: ServerFacts;
};

/** What a server of a kind does differently from the kind's public host. */
export type ServerFacts = {
  /**
   * A project's page under the server, from the owner and name its address
   * names (`scm/prj` and `repo` for `https://host/scm/prj/repo.git`).
   */
  projectPage: (owner: string, name: string) => string;
  /** Whether a project on the server may choose batched pull requests. */
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
  /**
   * Bitbucket Cloud (`docs/forge.md`, "Bitbucket pull requests"): an API
   * token the person makes on their Atlassian account with Bitbucket's
   * scopes, sent as a bearer token; its pull requests are `#N` under
   * `pull-requests/`. The scopes are the ones the app reads and writes
   * with once the crew's reach is built too, so one key serves them all.
   */
  bitbucket: {
    kind: "bitbucket",
    publicHost: "bitbucket.org",
    serverIntegration: "bitbucket",
    serverIdPrefix: "bitbucket",
    publicHostIsServerRow: true,
    changeWord: "pull request",
    handle: "pr",
    numberPrefix: "#",
    requestPath: "pull-requests",
    requestPaths: ["pull-requests"],
    comparePath: "branches/compare",
    // Bitbucket names the branch first, then the branch it builds on, split by a carriage return.
    compareRange: (base, branch) => `${branch}%0D${base}`,
    // Bitbucket's workspace and repository names are lower case in every address.
    foldsNames: true,
    quickActions: false,
    holdsOnlyKnownHosts: true,
    addressExample: "bitbucket.org",
    // Atlassian keeps every Cloud API token on the person's account, not on
    // bitbucket.org; a Data Center server keeps its HTTP access tokens itself.
    keyPage: (host) =>
      host === "bitbucket.org"
        ? "https://id.atlassian.com/manage-profile/security/api-tokens"
        : `https://${host}/plugins/servlet/access-tokens/manage`,
    keyAccount: "your Atlassian account",
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
    batches: true,
    // Bitbucket Data Center on the person's own server: its own pages, and no
    // batches until its batch pull request is built (`docs/forge.md`,
    // "Bitbucket Data Center").
    server: { projectPage: bitbucketServerProjectPage, batches: false },
  },
};

/**
 * A Bitbucket Data Center repository's page: `projects/<KEY>/repos/<slug>`,
 * or `users/<name>/repos/<slug>` for a person's own repository (`~name`).
 * An HTTPS clone address names the project under `scm/` in lower case, so
 * that segment is dropped and the key is written as Data Center keeps it,
 * in capitals.
 */
export function bitbucketServerProjectPage(owner: string, name: string): string {
  const segments = owner.split("/").filter(Boolean);
  const key = (segments[0]?.toLowerCase() === "scm" ? segments.slice(1) : segments).join("/");
  const slug = encodeURIComponent(name.toLowerCase());
  if (key.startsWith("~"))
    return `users/${encodeURIComponent(key.slice(1).toLowerCase())}/repos/${slug}`;
  return `projects/${encodeURIComponent(key.toUpperCase())}/repos/${slug}`;
}

/** Every kind the app signs in to, with what each owns about its sign-in. */
export const SIGN_IN_HOSTS: Readonly<Record<SignInKind, SignInHost>> = CHANGE_REQUEST_HOSTS;

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

/**
 * What a host of this kind on the person's own server does differently,
 * or undefined where it answers as the kind's public host does.
 */
export function serverFactsAt(
  kind: string | null | undefined,
  host: string | null | undefined,
): ServerFacts | undefined {
  const facts = changeRequestHost(kind);
  return facts && host && host !== facts.publicHost ? facts.server : undefined;
}

/** The page of change `number` in the project at `project` (`owner/name`, already spelled for a link). */
export function changePageUrl(
  kind: string | null | undefined,
  host: string,
  project: string,
  number: number,
): string {
  const server = serverFactsAt(kind, host);
  const slash = project.lastIndexOf("/");
  const page =
    server && slash > 0
      ? server.projectPage(project.slice(0, slash), project.slice(slash + 1))
      : project;
  return `https://${host}/${page}/${changeHostOf(kind).requestPath}/${number}`;
}
