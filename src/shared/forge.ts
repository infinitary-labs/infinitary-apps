/**
 * Where a project lives, read from its `origin` (git integration PR 0.2;
 * the forge seam of phase 1 reuses this parser). A project with no origin
 * lives only on this Mac (`none`); GitHub, GitLab and Bitbucket are named
 * by their public hosts; any other remote is a plain Git host (`git`),
 * including a remote on this Mac's own disk. Bitbucket is recognised so a
 * surface can name the host, and until its own file exists it behaves as a
 * plain host.
 *
 * A host on the person's own server is the kind of host it runs once the
 * app knows it (`docs/forge.md`, "Hosts on your own server"): GitHub
 * Enterprise Cloud's `<name>.ghe.com` is GitHub by its name alone, and any
 * other host is the kind the caller names in `known` - a host the person
 * signed in to, or one their projects already live on, which only the core
 * knows. A self-hosted GitLab is known the same way.
 *
 * Pure and total: any string parses to a kind, and nothing here reads git,
 * the network, or a sign-in.
 */

export type ForgeKind = "github" | "gitlab" | "bitbucket" | "git" | "none";

export type ForgeOrigin = {
  kind: ForgeKind;
  /** The host name, lower case; null when the project lives nowhere else or on a local path. */
  host: string | null;
  /** The owner path (a GitLab group may nest), when the origin names one. */
  owner?: string;
  /** The project's name, without a trailing `.git`. */
  name?: string;
};

const PUBLIC_HOSTS: Record<string, ForgeKind> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/** github.com: the one GitHub host the app's own GitHub sign-in (the code) is for. */
export const GITHUB_COM = "github.com";

/**
 * The kinds whose proposed change is a numbered request the app opens,
 * reads and merges through the host's API, with readiness and a kept merge
 * approval (FI3-304): GitHub's pull requests and GitLab's merge requests.
 * Every other kind sends a branch up, or keeps the work on this Mac. The
 * forge seam binds exactly these kinds to a forge with `pull`
 * (`src/core/forge/index.ts`).
 */
export function hasChangeRequests(kind: ForgeKind | undefined): boolean {
  return kind === "github" || kind === "gitlab";
}

/** A host on the person's own server the app knows, and the kind of host it runs. */
export type KnownForgeHost = { host: string; kind: ForgeKind };

/** GitHub Enterprise Cloud with data residency: every `<name>.ghe.com` is GitHub's own. */
const GHE_CLOUD = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/;

/** A GitHub Enterprise Cloud host, known by its name alone. */
export function isGitHubEnterpriseCloud(host: string): boolean {
  return GHE_CLOUD.test(host);
}

/** A public host (github.com, gitlab.com, bitbucket.org), never one on the person's own server. */
export function isPublicForgeHost(host: string): boolean {
  return Object.hasOwn(PUBLIC_HOSTS, host);
}

/** The kind a host is by its name alone: a public host's, or GitHub Enterprise Cloud's. */
export function kindByName(host: string): ForgeKind | undefined {
  if (Object.hasOwn(PUBLIC_HOSTS, host)) return PUBLIC_HOSTS[host];
  return isGitHubEnterpriseCloud(host) ? "github" : undefined;
}

/** The kind of a host: by its name, else as the caller knows it, else a plain Git host. */
export function kindOfHost(host: string, known: readonly KnownForgeHost[] = []): ForgeKind {
  return kindByName(host) ?? known.find((entry) => entry.host === host)?.kind ?? "git";
}

/** `git@host:owner/name.git`: scp-like, the one remote shape with no scheme. */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

/**
 * What a project's origin says about where it lives. `known` are the hosts
 * on the person's own server the caller knows beyond those known by name.
 */
export function forgeOf(
  origin: string | null | undefined,
  known: readonly KnownForgeHost[] = [],
): ForgeOrigin {
  const raw = origin?.trim() ?? "";
  if (!raw) return { kind: "none", host: null };
  const located = locate(raw);
  if (!located) return { kind: "git", host: null };
  const host = located.host.toLowerCase().replace(/^www\./, "");
  const kind = kindOfHost(host, known);
  const segments = located.path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return { kind, host };
  const name = segments.at(-1) as string;
  return { kind, host, owner: segments.slice(0, -1).join("/"), name };
}

function locate(raw: string): { host: string; path: string } | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (url.protocol === "file:" || !url.hostname) return undefined;
    return { host: url.hostname, path: decodeURIComponent(url.pathname) };
  }
  // A Windows drive letter ("C:\\...") is a local path, not host:path.
  if (/^[a-z]:[\\/]/i.test(raw)) return undefined;
  const scp = SCP_LIKE.exec(raw);
  if (!scp) return undefined;
  return { host: scp[1] as string, path: scp[2] as string };
}

const PUBLIC_NAMES: Partial<Record<ForgeKind, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/**
 * The person's word for where a project lives (git integration PR 1.1): the
 * provider's own name on its public host ("GitHub"), which is the person's
 * word the way a model provider's is, else the host's address
 * ("git.example.com", and a host on the person's own server,
 * "github.example.com"). Null where there is no host to name - a project
 * kept only on this Mac, or a remote on this Mac's own disk.
 */
export function forgePlace(where: { kind: ForgeKind; host: string | null }): string | null {
  if (where.kind === "none" || !where.host) return null;
  return PUBLIC_HOSTS[where.host] === where.kind
    ? (PUBLIC_NAMES[where.kind] ?? where.host)
    : where.host;
}

/**
 * An address the person typed for a host on their own server - its name,
 * a page on it, or a project's address there - as the host name the app
 * keys its sign-in by, or null when it names no host.
 */
export function hostOfAddress(address: string): string | null {
  const raw = address.trim();
  // Nothing typed, or a folder on this Mac: no host.
  if (!raw || /^[/.~\\]/.test(raw)) return null;
  const located = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^[^@/\s]+@[^:/\s]+:/.test(raw);
  return forgeOf(located ? raw : `https://${raw}`).host;
}
