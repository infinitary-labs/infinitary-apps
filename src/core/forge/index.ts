import { type ForgeKind, forgeOf, forgePlace } from "@shared/forge";
import type { RepoView } from "@shared/repos";
import type { Forge, ForgeLocation } from "./forge";
import { githubApiBaseFor, githubApiBaseUrl } from "./providers/github/githubForge";
import {
  createGitHubServer,
  createGitHubSignIn,
  githubOAuthBaseUrl,
} from "./providers/github/oauth";
import { gitlabApiBaseFor } from "./providers/gitlab/client";
import { gitlabOAuthBaseFor } from "./providers/gitlab/oauth";
import { createGitLabServer } from "./providers/gitlab/signIn";
import { NoHostForge } from "./providers/noHost";
import { PlainGitForge } from "./providers/plainGit";
import type { ForgeServer, ForgeSignInProvider } from "./signIns";

/**
 * The forge seam's one door (git integration PR 1.1, `docs/forge.md`).
 * Everything outside `src/core/forge/` imports this file; the provider
 * files under `./providers/` are fenced (Biome `noRestrictedImports`) so
 * only this directory, its home wiring (`homeForges.ts`) among it, reaches
 * one, the way Pi is reached only through `src/core/pi/`.
 */

export type {
  ApiReadMethod,
  ApiRoute,
  ApiWriteMethod,
  ForgeApi,
  ForgeApiResponse,
  GithubReadInput,
  GithubWriteInput,
  ReleaseUpload,
} from "./api";
export {
  API_CALLS_PER_TASK,
  API_RESPONSE_MAX_BYTES,
  nextPagePath,
  OversizedAnswer,
  parseApiRequest,
  smallerPage,
} from "./api";
export type {
  AttachmentDestination,
  AttachmentMediaType,
  ForgeAttachments,
  UploadAttachment,
} from "./attachments";
export { AttachmentUploadError, sameAttachmentDestination } from "./attachments";
export type {
  Forge,
  ForgeBypass,
  ForgeChange,
  ForgeCheck,
  ForgeCheckState,
  ForgeChecks,
  ForgeFailure,
  ForgeLocation,
  ForgeOverall,
  ForgeProject,
  ForgePull,
  ForgeQueueMark,
  ForgeQueuePause,
  ForgeQueueStart,
  ForgeReadiness,
  ForgeRuleset,
  ForgeSkipMerge,
  QueueWorkflow,
} from "./forge";
export {
  allowanceResetOf,
  changeTitle,
  describeCheckState,
  ForgeAllowanceSpent,
  ForgeBaseMoved,
  ForgeError,
  ForgeWriteError,
  isRedCheckState,
  isSignInForgeFailure,
  isTransientForgeFailure,
  QUEUE_STATUS,
  QUEUE_WAITING_WORDS,
} from "./forge";
export { type GitHubCli, githubCliFor } from "./githubCli";
export {
  NO_MISTAKES_ATTESTATION_PREFIX,
  NO_MISTAKES_SIGNATURE,
  neutralizePipelineAttestation,
  pipelineAttestationSection,
} from "./pipelineAttestation";
export {
  messageWithoutPresentation,
  PresentationAroundError,
  presentationAround,
  presentationBodyLimit,
  presentationCardBody,
  presentationCommitMessage,
  presentationContentHash,
  presentationHtmlText,
  presentationLines,
  presentationMarkdown,
  presentationRegionMarkers,
  presentationSizingUrl,
  readPresentationRegion,
  replaceAroundPresentation,
  replacePresentationRegion,
  sameAroundPresentation,
} from "./presentation";
export type { RemoteHost } from "./projects";
export { remoteProjectsText } from "./projects";
export { conditionalGets } from "./providers/github/conditionalGets";
export { gitlabReleaseFileCalls } from "./providers/gitlab/api";
export { GITLAB_PRIVATE_MEDIA_REFUSAL } from "./providers/gitlab/attachments";
export type { LocatedReleaseFile } from "./releaseFile";
export { PLACED_RELEASE_FILE_REFUSAL, releaseFileIn } from "./releaseFile";
export type { SignInRefusal, SignInWay } from "./signInRefusal";
export {
  renderSignInRefusal,
  SignInRequiredError,
  signInRefusal,
  signInWays,
} from "./signInRefusal";
export type {
  ForgeHealthChange,
  ForgeServer,
  ForgeSignInEnding,
  ForgeSignInProvider,
  ForgeSignInRecord,
} from "./signIns";
export { ForgeSignInStore, ForgeSignIns } from "./signIns";

/**
 * Every host the app offers its own sign-in to, as the sign-in service asks
 * it: GitHub's device flow for now (PR 1.2). The dev and e2e endpoint
 * overrides are read only off a packaged app. The home's forge wiring
 * (`homeForges.ts`) and a computer that runs work's own sign-ins
 * (`src/core/helper/forges.ts`) both start from this list.
 */
export function forgeSignInProviders(options: {
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
  /** GitHub's reads, conditional where the app keeps them (`conditionalGets`). */
  githubFetch?: typeof fetch;
}): ForgeSignInProvider[] {
  return [
    createGitHubSignIn({
      oauthBaseUrl: githubOAuthBaseUrl(options),
      apiBaseUrl: githubApiBaseUrl(options),
      ...(options.githubFetch ? { fetch: options.githubFetch } : {}),
    }),
  ];
}
/**
 * Every kind of server a host on the person's own server can be added as,
 * with a key made there (`docs/forge.md`, "Hosts on your own server"):
 * GitHub Enterprise and GitLab, with each kind's API address, sign-in
 * check and git user name. GitLab also names its public host and offers
 * browser sign-in with a per-host Application ID.
 * Only the home offers these; a computer that runs work signs in to
 * github.com alone.
 */
export function forgeSignInServers(options: {
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
  /** GitHub's reads, conditional where the app keeps them (`conditionalGets`). */
  githubFetch?: typeof fetch;
}): ForgeServer[] {
  return [
    createGitHubServer({
      apiBaseFor: (host) => githubApiBaseFor(host, options),
      ...(options.githubFetch ? { fetch: options.githubFetch } : {}),
    }),
    createGitLabServer({
      apiBaseFor: (host) => gitlabApiBaseFor(host, options),
      oauthBaseFor: (host) => gitlabOAuthBaseFor(host, options),
    }),
  ];
}

export type {
  ArchiveRanges,
  DownloadArtifactInput,
  ForgeWorkflows,
  ReadWorkflowInput,
  WorkflowArtifact,
  WorkflowJob,
  WorkflowJobLine,
  WorkflowJobList,
  WorkflowRun,
} from "./workflows";

/**
 * Which implementation serves a kind that needs the person's sign-in. The
 * home's forge wiring (`homeForges.ts`) chooses it: GitHub - github.com and
 * every GitHub Enterprise host - is the REST `GitHubForge` with the app's
 * own sign-in for that host (PR 1.2), and GitLab - gitlab.com and every self-hosted
 * server - is the REST `GitLabForge` with the app's own sign-in. A kind with
 * no binding - Bitbucket until its own file exists - is a plain Git host.
 */
export type ForgeBindings = Partial<Record<ForgeKind, (location: ForgeLocation) => Forge>>;

/** The repository fields the seam reads; a repo-less task has none. */
export type ForgeRepo = Pick<RepoView, "path" | "origin" | "host">;

/** Where a repository lives, as the seam needs it. */
export function forgeLocationOf(repo: ForgeRepo): ForgeLocation {
  const parsed = forgeOf(repo.origin);
  return {
    kind: repo.host?.kind ?? "none",
    host: repo.host?.name ?? null,
    ...(parsed.owner ? { owner: parsed.owner } : {}),
    ...(parsed.name ? { name: parsed.name } : {}),
    dir: repo.path,
  };
}

/**
 * The forge for a repository. A project with no host (or no repository at
 * all) is kept on this Mac; a kind with a binding is its implementation
 * (GitHub or GitLab, on its public host or the person's own server); a
 * plain Git host - and Bitbucket until its own file exists - sends its work
 * up as a branch.
 */
export function createForgeResolver(
  bindings: ForgeBindings,
): (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge {
  return (repo, fallbackDir = "") => {
    if (!repo) return new NoHostForge({ kind: "none", host: null, dir: fallbackDir });
    const location = forgeLocationOf(repo);
    if (location.kind === "none") return new NoHostForge(location);
    const bound = bindings[location.kind];
    if (bound) return bound(location);
    return new PlainGitForge({ ...location, place: forgePlace(location) });
  };
}
