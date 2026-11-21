import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { GITHUB_COM, kindOfHost } from "@shared/forge";
import { type ChangeRequestKind, changeRequestHostAt, changeRequestKind } from "@shared/forgeKinds";
import {
  type ForgeChangeRow,
  type ForgeChangesView,
  type ForgeProject,
  type ForgeProjectListing,
  forgeSignInCardId,
} from "@shared/forges";
import type { NamingRule } from "@shared/runbooks";
import type { HostCapabilities } from "../host";
import { configureGitSignIn } from "../hostEnv";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { FirstmateAgentOptions } from "../orchestrator/firstmateAgent";
import type { AppPaths } from "../paths";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { Forge, ForgeLocation } from "./forge";
import { githubCliFor } from "./githubCli";
import { forgeHealthNote } from "./healthNote";
import {
  conditionalGets,
  createForgeResolver,
  type ForgeBindings,
  forgeSignInProviders,
  forgeSignInServers,
  isSignInForgeFailure,
  remoteProjectsText,
} from "./index";
import { BitbucketForge } from "./providers/bitbucket/bitbucketForge";
import { readBitbucketOpenChanges } from "./providers/bitbucket/changes";
import { bitbucketApiBaseFor } from "./providers/bitbucket/client";
import { readOpenChanges } from "./providers/github/changes";
import { GitHubForge, githubApiBaseFor } from "./providers/github/githubForge";
import { readGitLabOpenChanges } from "./providers/gitlab/changes";
import { gitlabApiBaseFor } from "./providers/gitlab/client";
import { GitLabForge } from "./providers/gitlab/gitlabForge";
import { type ForgeHealthChange, ForgeSignInStore, ForgeSignIns } from "./signIns";

/**
 * The home's wiring where projects live (git integration PRs 1.1-1.3,
 * docs/forge.md): the app's own sign-ins, GitHub's device flow into
 * userData/forges/<host>/, the only GitHub sign-in the app ever reads, and a
 * key the person makes on each host on their own server (GitHub Enterprise;
 * "Hosts on your own server"). Optional by the captain's standing
 * constraint - nothing asks for one until a listing, a private clone or a
 * proposed change needs it. The dev/e2e endpoint overrides are read only by
 * an unpackaged app. The provider files are fenced to this folder, so this
 * is where the app's GitHub and GitLab forges are built.
 */
export type HomeForges = {
  /** The app's own sign-ins where projects live (PR 1.2): optional, one per host. */
  signIns: ForgeSignIns;
  /** Each project's forge, by its host's kind; a kind with none here is a plain Git host. */
  forgeFor: ReturnType<typeof createForgeResolver>;
  /** A host's own GitHub or GitLab, with no project: what the gateway reads and writes as the account. */
  accountForge: (host?: string) => Forge;
  /**
   * What the first mate's own tools ask of where projects live (PR 1.2):
   * locate_project's listing, and the refusal a clone gets from a host
   * whose sign-in the app lacks.
   */
  access: NonNullable<FirstmateAgentOptions["forges"]>;
  /** The person's open proposed changes where their projects live: the `forge.changes` read. */
  changes: () => Promise<ForgeChangesView>;
  /** The projects on a host the app knows, as its sign-in lists them. */
  projects: (host: string) => Promise<ForgeProject[]>;
  /** The same, and whether the listing read every project or stopped at its page budget. */
  projectsListed: (host: string) => Promise<ForgeProjectListing>;
  /** The integrations read the github.com sign-in: each change to the sign-ins is one of theirs. */
  attachIntegrations: (changed: () => void) => void;
  /**
   * A sign-in where projects live, as the captain meets it (PR 1.2), once
   * the crew holds the stack; then the first read of every sign-in.
   */
  attachCrew: (crew: {
    supervisor: Pick<CrewSupervisor, "cards" | "resumeForgeSignInTasks">;
    tasks: Pick<TaskService, "listLive">;
    broadcastEvent: (event: FmEvent) => void;
  }) => void;
};

export function startHomeForges(options: {
  host: Pick<HostCapabilities, "app">;
  paths: Pick<AppPaths, "forgesDir">;
  repos: RepoRegistry;
  /** The active naming runbook's rule, read at each request; null when none is on. */
  namingRule: () => NamingRule | null;
  /** The sign-ins' view, pushed to the window on each change. */
  push: (view: ReturnType<ForgeSignIns["view"]>) => void;
  /**
   * Waited on before a merge or an opened change, which cannot be taken back
   * (`SettledBeforeAct`, docs/devices.md "Before an act that cannot be undone").
   */
  beforeAct?: () => Promise<void>;
}): HomeForges {
  const { host, paths, repos, namingRule } = options;
  const forgeEndpoints = { packaged: host.app.packaged };
  // Every GitHub read the app makes, through one store of answers GitHub
  // tagged: an unchanged answer is a 304 that spends no allowance (INF-2149).
  const githubReads = conditionalGets();
  let onForgeHealth: (change: ForgeHealthChange) => void = () => {};
  let onForgeRenewed: (forgeHost: string) => void = () => {};
  let integrationsChanged: () => void = () => {};
  const projectsOnForge = (forgeHost: string) =>
    repos.list().filter((repo) => repo.host?.name === forgeHost).length;
  const forgeSignIns = new ForgeSignIns({
    store: new ForgeSignInStore(paths.forgesDir),
    providers: forgeSignInProviders({ ...forgeEndpoints, githubFetch: githubReads }),
    servers: forgeSignInServers({ ...forgeEndpoints, githubFetch: githubReads }),
    projectHosts: () =>
      repos
        .list()
        .flatMap((repo) =>
          repo.host?.name && repo.host.kind !== "git"
            ? [{ host: repo.host.name, kind: repo.host.kind }]
            : [],
        ),
    // A host now known: its projects stamped plain Git hosts are its kind's.
    onSignedIn: (known) => repos.stampKnownHosts([known]),
    projectsOn: (forgeHost) => projectsOnForge(forgeHost),
    push: (view) => {
      options.push(view);
      integrationsChanged();
    },
    onHealthChange: (change) => onForgeHealth(change),
    onRenewed: (forgeHost) => onForgeRenewed(forgeHost),
    // A GitHub host may sign in through the person's own GitHub CLI instead (docs/forge.md).
    cli: githubCliFor(forgeEndpoints),
    log: (message) => console.info(message),
  });
  // A host known by a sign-in on file, or a `.ghe.com` host by its name,
  // whose projects an earlier run stamped plain Git hosts.
  repos.stampKnownHosts(forgeSignIns.knownHosts());
  const githubForge = (location: ForgeLocation) => {
    const forgeHost = location.host ?? GITHUB_COM;
    return new GitHubForge(location, {
      fetch: githubReads,
      namingRule,
      token: () => forgeSignIns.token(forgeHost),
      apiBaseUrl: githubApiBaseFor(forgeHost, forgeEndpoints),
      onSignInRejected: () => forgeSignIns.rejected(forgeHost),
    });
  };
  const gitlabForge = (location: ForgeLocation) => {
    const forgeHost = location.host ?? "gitlab.com";
    return new GitLabForge(location, {
      namingRule,
      token: () => forgeSignIns.token(forgeHost),
      apiBaseUrl: gitlabApiBaseFor(forgeHost, forgeEndpoints),
      onSignInRejected: () => forgeSignIns.rejected(forgeHost),
    });
  };
  const bitbucketForge = (location: ForgeLocation) => {
    const forgeHost = location.host ?? "bitbucket.org";
    return new BitbucketForge(location, {
      namingRule,
      token: () => forgeSignIns.token(forgeHost),
      apiBaseUrl: bitbucketApiBaseFor(forgeHost, forgeEndpoints),
      onSignInRejected: () => forgeSignIns.rejected(forgeHost),
    });
  };
  // Which forge serves each kind of host: GitHub's and GitLab's, each on its
  // public host and on the person's own server, and Bitbucket Cloud's. A
  // kind with none here is a plain Git host.
  const kindForges: Record<ChangeRequestKind, (location: ForgeLocation) => Forge> = {
    github: githubForge,
    gitlab: gitlabForge,
    bitbucket: bitbucketForge,
  };
  const forgeBindings: ForgeBindings = kindForges;
  const resolve = createForgeResolver(forgeBindings);
  const beforeAct = options.beforeAct;
  const forgeFor: ReturnType<typeof createForgeResolver> = beforeAct
    ? (repo, fallbackDir) => settledFirst(resolve(repo, fallbackDir), beforeAct)
    : resolve;
  /** The forge of a host itself, with no project: listing, lookups and account reads. */
  const forgeOnHost = (
    forgeHost: string,
  ):
    | (Pick<Forge, "listProjects" | "listProjectsPaged" | "findProject"> & {
        nestedNamespace?: boolean;
      })
    | undefined => {
    const kind = kindOfHost(forgeHost, forgeSignIns.knownHosts());
    return forgeBindings[kind]?.({ kind, host: forgeHost, dir: "" });
  };
  const projectsListed = async (forgeHost: string): Promise<ForgeProjectListing> => {
    const forge = forgeSignIns.view().hosts.some((entry) => entry.host === forgeHost)
      ? forgeOnHost(forgeHost)
      : undefined;
    if (!forge)
      throw new Error(
        "This app does not know that project host yet. Ask your first mate to add it.",
      );
    return forge.listProjectsPaged
      ? forge.listProjectsPaged()
      : { projects: await forge.listProjects(), complete: true };
  };
  const access: HomeForges["access"] = {
    remoteProjects: (name: string, foundLocally: boolean) =>
      remoteProjectsText({
        name,
        foundLocally,
        hosts: forgeSignIns.view().hosts.flatMap((entry) => {
          const forge = forgeOnHost(entry.host);
          if (!forge) return [];
          return [
            {
              host: entry.host,
              name: entry.name,
              signedIn: forgeSignIns.isSignedIn(entry.host),
              login: forgeSignIns.loginOf(entry.host),
              list: async () =>
                forge.listProjectsPaged
                  ? forge.listProjectsPaged()
                  : { projects: await forge.listProjects(), complete: true },
              ...(forge.findProject ? { find: forge.findProject.bind(forge) } : {}),
              ...(forge.nestedNamespace ? { nestedNamespace: true } : {}),
            },
          ];
        }),
      }),
    signInOn: (forgeHost: string) => forgeSignIns.signInOn(forgeHost),
  };
  // The `forge.changes` panel read: every host with a sign-in, read with it
  // - github.com, each GitHub Enterprise host, gitlab.com, each GitLab
  // server and Bitbucket Cloud - newest first across them. A host
  // that cannot be read this time answers nothing, never a guess.
  const changes = async (): Promise<ForgeChangesView> => {
    const hosts = forgeSignIns.view().signIns.flatMap((row) => {
      const kind = changeRequestKind(kindOfHost(row.host, forgeSignIns.knownHosts()));
      return kind ? [{ host: row.host, kind }] : [];
    });
    // Each kind's own reading of a host's open changes.
    const openChanges: Record<
      ChangeRequestKind,
      (forgeHost: string, token: string) => Promise<ForgeChangeRow[]>
    > = {
      github: async (forgeHost, token) => {
        try {
          return await readOpenChanges({
            host: forgeHost,
            token,
            apiBaseUrl: githubApiBaseFor(forgeHost, forgeEndpoints),
          });
        } catch (caught) {
          if (isSignInForgeFailure(caught)) forgeSignIns.rejected(forgeHost);
          throw caught;
        }
      },
      gitlab: (forgeHost, token) =>
        readGitLabOpenChanges({
          host: forgeHost,
          token: async () => token,
          apiBaseUrl: gitlabApiBaseFor(forgeHost, forgeEndpoints),
          onSignInRejected: () => forgeSignIns.rejected(forgeHost),
        }),
      bitbucket: (forgeHost, token) =>
        readBitbucketOpenChanges({
          host: forgeHost,
          token: async () => token,
          apiBaseUrl: bitbucketApiBaseFor(forgeHost, forgeEndpoints),
          onSignInRejected: () => forgeSignIns.rejected(forgeHost),
        }),
    };
    if (hosts.length === 0) return { signedIn: false, reachable: true, changes: [] };
    let reachable = true;
    const rows: ForgeChangeRow[] = [];
    for (const { host: forgeHost, kind } of hosts) {
      const read = openChanges[kind];
      const token = await forgeSignIns.token(forgeHost);
      if (!token) continue;
      try {
        rows.push(...(await read(forgeHost, token)));
      } catch {
        reachable = false;
      }
    }
    rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { signedIn: true, reachable, changes: rows };
  };
  // Git that never prompts, and answers GitHub only with that sign-in:
  // every child the core starts carries the app's helper (hostEnv.ts). The
  // hosts are read at each spawn, so a GitHub Enterprise sign-in made since
  // is answered by the app's alone too.
  configureGitSignIn({
    askpass: host.app.packaged
      ? join(host.app.resourcesDir, "git-askpass")
      : join(host.app.appDir, "resources", "git-askpass"),
    signInDir: paths.forgesDir,
    hosts: () => forgeSignIns.gitHosts(),
  });
  return {
    signIns: forgeSignIns,
    forgeFor,
    accountForge: (forgeHost = GITHUB_COM) => {
      const kind =
        changeRequestHostAt(forgeHost)?.kind ??
        changeRequestKind(
          forgeSignIns.knownHosts().find((entry) => entry.host === forgeHost)?.kind,
        ) ??
        "github";
      return kindForges[kind]({ kind, host: forgeHost, dir: "" });
    },
    access,
    changes,
    projects: async (forgeHost) => (await projectsListed(forgeHost)).projects,
    projectsListed,
    attachIntegrations: (changed) => {
      integrationsChanged = changed;
    },
    attachCrew: ({ supervisor, tasks, broadcastEvent }) => {
      // How many proposed changes wait on a host: live tasks there with one open.
      const waitingChangesOn = (forgeHost: string): number => {
        const onHost = new Set(
          repos
            .list()
            .filter((repo) => repo.host?.name === forgeHost)
            .map((repo) => repo.id),
        );
        return tasks
          .listLive()
          .filter(
            (task) =>
              task.status === "active" &&
              task.repoId !== null &&
              onHost.has(task.repoId) &&
              (task.delivery?.changeLabel !== undefined || task.delivery?.prNumber !== undefined),
          ).length;
      };
      // The one host card when the host refused it - "sign in again", gone
      // the moment the host answers again - and a feed line when the host
      // cannot be reached, when a project lives there. Nothing at all while
      // nothing is signed in.
      onForgeHealth = (change) => {
        const cardId = forgeSignInCardId(change.host);
        if (change.to === "needs_reauth") {
          supervisor.cards.hostCards.addForgeSignInCard(
            cardId,
            change.host,
            change.name,
            waitingChangesOn(change.host),
            { cli: forgeSignIns.wayOf(change.host) === "cli" },
          );
        } else if (change.to === "ok" || change.to === "none") {
          supervisor.cards.hostCards.clearAuthDecisionCard(cardId);
          if (change.to === "ok") void supervisor.resumeForgeSignInTasks(change.host);
        }
        const note = forgeHealthNote(change, projectsOnForge(change.host));
        if (note) broadcastEvent({ type: "firstmate_note", text: note });
      };
      // A short-lived sign-in renewed itself (health stays ok, so no change
      // above fires): a card a git refusal raised for the ended one comes
      // down, and the work it held goes again.
      onForgeRenewed = (forgeHost) => {
        supervisor.cards.hostCards.clearAuthDecisionCard(forgeSignInCardId(forgeHost));
        void supervisor.resumeForgeSignInTasks(forgeHost);
      };
      // The first read of every sign-in, at boot, below the UI - after the
      // health log dates this start and the sign-in on file.
      forgeSignIns.recordApp("start");
      void forgeSignIns.checkHealth();
    },
  };
}

/**
 * The forge with its acts that cannot be taken back - opening a change,
 * merging one, and merging past the rules - each waiting on `beforeAct`
 * first. Every read stays as it was.
 */
function settledFirst(forge: Forge, beforeAct: () => Promise<void>): Forge {
  const openChange = forge.openChange.bind(forge);
  const putIn = forge.putIn.bind(forge);
  forge.openChange = async (...args) => {
    await beforeAct();
    return openChange(...args);
  };
  forge.putIn = async (...args) => {
    await beforeAct();
    return putIn(...args);
  };
  const skipping = forge.putInSkippingRules?.bind(forge);
  if (skipping)
    forge.putInSkippingRules = async (...args) => {
      await beforeAct();
      return skipping(...args);
    };
  return forge;
}
