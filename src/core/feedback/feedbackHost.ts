import { homedir, hostname, release, userInfo } from "node:os";
import type { DeviceView } from "@shared/devices";
import { isPhone } from "@shared/devices";
import { GITHUB_COM } from "@shared/forge";
import { currentLanguage } from "@shared/i18n/current";
import { INTEGRATION_KIND_NAMES } from "@shared/integrations";
import type { TimelineEntry } from "@shared/timeline";
import type { FeedbackAskFacts } from "@shared/writeAsk";
import type { DevicePairing } from "../devices/pairing";
import { githubApiBaseUrl } from "../forge";
import type { HomeForges } from "../forge/homeForges";
import type { HostCapabilities } from "../host";
import type { IntegrationsService } from "../integrations/service";
import type { GithubGatewayService } from "../orchestrator/githubGateway";
import type { AccountVault } from "../pi/accountVault";
import { thisDeviceSystem } from "../platform";
import type { SecretsSettings } from "../secrets/settings";
import type { TaskRecord } from "../storage/taskRecordTypes";
import type { TaskService } from "../tasks/taskService";
import type { TaskTimeline } from "../tasks/taskTimeline";
import { readLinuxInstallation } from "../update/linuxInstall";
import { releaseSource } from "../update/releaseSource";
import { resolveUpdateChannel } from "../update/updateChannels";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { FeedbackDiagnostics, FeedbackTaskFacts } from "./diagnostics";
import type { FeedbackHost, SimilarIssue } from "./feedbackCommand";
import type { HeldIdentifier } from "./guard";

/**
 * The home's readings behind `infinitary-feedback-axi` (docs/feedback.md):
 * each a typed fact or an identifier list read from its owner when asked,
 * and the one effect, keeping a write for the captain's click.
 */
export type FeedbackHostDeps = {
  repository: string;
  app: { version: string; channel: () => string; install: () => string; language: () => string };
  /** The system's own version (macOS 26.1, not its kernel's), and the chip. */
  system: { name: string; version: string; chip: string };
  computerNames: () => string[];
  devices: () => DeviceView[];
  models: () => Array<{ providerId: string; login?: string | undefined }>;
  repos: () => Array<{
    name: string;
    path: string;
    origin: string | null;
    kind: string;
    host: { kind: string } | null;
  }>;
  forgeLogins: () => string[];
  secretLabels: () => Promise<string[]>;
  integrations: () => Array<{ kind: string; name: string; account: string | null }>;
  task: (key: string) => TaskRecord | undefined;
  /** A task's delivery and care now, read with its project's settings; none for a task that ships nothing. */
  policies: (record: TaskRecord) => { delivery: string; care: string } | null;
  timeline: (taskId: string) => TimelineEntry[];
  signedIn: () => boolean;
  login: () => string | null;
  /** A read of GitHub's API: with the sign-in when there is one, GitHub's public API without. */
  getJson: (path: string) => Promise<{ status: number; body: string }>;
  keep: (
    taskId: string,
    write: { path: string; body: string; feedback: FeedbackAskFacts },
  ) => string;
};

function taskFacts(
  record: TaskRecord,
  policies: { delivery: string; care: string } | null,
  entries: readonly TimelineEntry[],
): FeedbackTaskFacts {
  const start = record.startedAt ?? record.createdAt;
  const checks = record.delivery?.checks?.items ?? [];
  return {
    kind: record.shape?.kind ?? record.kind,
    status: record.status,
    ...(record.closedReason ? { closed: record.closedReason } : {}),
    ...(policies ? { care: policies.care, delivery: policies.delivery } : {}),
    // Each check's state alone: a check's name can name the person's project.
    ...(record.delivery?.ci ? { ci: record.delivery.ci } : {}),
    checks: checks.map((item) => item.state),
    steps: entries
      .filter((entry) => !entry.quiet && entry.at !== null)
      .map((entry) => ({
        minute: ((entry.at ?? start) - start) / 60_000,
        kind: entry.content.kind,
      })),
  };
}

/** Owner and name of a remote URL (`git@host:owner/name.git`, `https://host/owner/name`), when it has them. */
function remoteNames(origin: string | null): string[] {
  if (!origin) return [];
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
  return match ? [origin, `${match[1]}/${match[2]}`, match[1] ?? "", match[2] ?? ""] : [origin];
}

export function homeFeedbackHost(deps: FeedbackHostDeps): FeedbackHost {
  return {
    repository: deps.repository,
    diagnostics: (taskKey) => {
      const record = taskKey ? deps.task(taskKey) : undefined;
      if (taskKey && !record) return { unknownTask: taskKey };
      const devices = deps.devices();
      // i18n-exempt: a code word in the issue's English diagnostics
      const facts: FeedbackDiagnostics = {
        app: {
          version: deps.app.version,
          channel: deps.app.channel(),
          install: deps.app.install(),
          language: deps.app.language(),
        },
        system: { name: deps.system.name, release: deps.system.version, chip: deps.system.chip },
        computers: devices
          .filter((device) => !isPhone(device) && device.kind !== "view")
          .map((device) => ({
            system: device.system ?? "unknown",
            version: device.workVersion ?? device.appVersion?.app ?? "unknown",
          })),
        phones: devices
          .filter((device) => isPhone(device))
          .map((device) => ({ version: device.appVersion?.app ?? "unknown" })),
        models: deps.models().map((model) => model.providerId),
        projectHosts: deps
          .repos()
          .filter((repo) => repo.kind !== "personal")
          .map((repo) => repo.host?.kind ?? "this computer"),
        ...(record
          ? { task: taskFacts(record, deps.policies(record), deps.timeline(record.id)) }
          : {}),
      };
      return facts;
    },
    held: async () => {
      const held: HeldIdentifier[] = [];
      const add = (kind: HeldIdentifier["kind"], value: string | null | undefined) => {
        if (value) held.push({ kind, value });
      };
      try {
        add("account name", userInfo().username);
      } catch {
        // No account name to read on this system.
      }
      add("home folder", homedir());
      // A network name such as name.local is also written bare.
      for (const name of deps.computerNames()) {
        add("computer name", name);
        add("computer name", name.split(".")[0]);
      }
      for (const device of deps.devices()) {
        add("device name", device.name);
        add("account name", device.user);
        add("sign-in", device.remoteLogin);
      }
      for (const login of deps.forgeLogins()) add("sign-in", login);
      for (const model of deps.models()) add("sign-in", model.login);
      for (const repo of deps.repos()) {
        if (repo.kind === "personal") continue;
        add("project", repo.name);
        add("project folder", repo.path);
        for (const name of remoteNames(repo.origin)) add("repository", name);
      }
      for (const label of await deps.secretLabels().catch(() => [])) add("secret name", label);
      for (const row of deps.integrations()) {
        const kindName = (INTEGRATION_KIND_NAMES as Record<string, string>)[row.kind];
        if (row.name !== kindName) add("connection name", row.name);
        add("sign-in", row.account);
      }
      return held;
    },
    signedIn: deps.signedIn,
    searchIssues: async (_taskId, query) => {
      const path = `/search/issues?q=${encodeURIComponent(query)}&per_page=10`;
      const answer = await deps.getJson(path);
      if (answer.status >= 300) throw new Error(`GitHub answered ${answer.status}.`);
      const parsed = JSON.parse(answer.body) as {
        items?: Array<{
          number?: number;
          title?: string;
          state?: string;
          comments?: number;
          reactions?: { total_count?: number };
          pull_request?: unknown;
        }>;
      };
      return (parsed.items ?? [])
        .filter((item) => item.pull_request === undefined && typeof item.number === "number")
        .map(
          (item): SimilarIssue => ({
            number: item.number ?? 0,
            title: String(item.title ?? ""),
            state: String(item.state ?? ""),
            comments: Number(item.comments ?? 0),
            reactions: Number(item.reactions?.total_count ?? 0),
          }),
        );
    },
    keep: (taskId, write) => {
      const login = deps.login();
      return deps.keep(taskId, {
        ...write,
        feedback: { ...write.feedback, ...(login ? { login } : {}) },
      });
    },
  };
}

/**
 * The system's version as a person names it: Electron reads macOS's and
 * Windows's own; elsewhere only the kernel's is known, and it says so,
 * since Darwin's kernel number is not the macOS version.
 */
export function systemVersion(platform: string): string {
  const own = (process as { getSystemVersion?: () => string }).getSystemVersion?.();
  if (own && (platform === "darwin" || platform === "win32")) return own;
  // i18n-exempt: a code word in the issue's English diagnostics
  return `kernel ${release()}`;
}

/** The home's wiring: each reading from its owner, the destination from the build's release source. */
export function startHomeFeedback(parts: {
  host: Pick<HostCapabilities, "app" | "macUpdates">;
  computerName: string;
  devices: Pick<DevicePairing, "list">;
  vault: Pick<AccountVault, "list">;
  repos: Pick<RepoRegistry, "list">;
  forgeSignIns: Pick<HomeForges["signIns"], "view" | "isSignedIn" | "loginOf">;
  accountForge: HomeForges["accountForge"];
  /** Late-bound: Secrets is built after the crew. */
  secrets: () => Pick<SecretsSettings, "view"> | undefined;
  integrations: Pick<IntegrationsService, "view">;
  tasks: Pick<TaskService, "byKey" | "policiesOf">;
  timeline: Pick<TaskTimeline, "entries">;
  githubGateway: Pick<GithubGatewayService, "keepFeedback">;
}): FeedbackHost {
  const { host, forgeSignIns } = parts;
  const { app } = host;
  const system = thisDeviceSystem();
  return homeFeedbackHost({
    repository: releaseSource.repository,
    app: {
      version: app.version,
      channel: () => resolveUpdateChannel(app.userDataDir, app.version),
      install: () =>
        !app.packaged
          ? "source"
          : app.platform === "darwin"
            ? (host.macUpdates?.installation.kind ?? "unknown")
            : app.platform === "linux"
              ? (readLinuxInstallation({
                  chip: process.arch,
                  resourcesDir: app.resourcesDir,
                  execPath: process.execPath,
                  env: process.env,
                }).package ?? "unknown")
              : app.platform,
      language: () => currentLanguage(),
    },
    system: {
      name: system.system ?? app.platform,
      version: systemVersion(app.platform),
      chip: system.chip ?? process.arch,
    },
    computerNames: () => [parts.computerName, hostname()],
    devices: () => parts.devices.list(),
    models: () => parts.vault.list(),
    repos: () => parts.repos.list(),
    forgeLogins: () =>
      forgeSignIns
        .view()
        .signIns.map((signIn) => signIn.login)
        .filter((login): login is string => typeof login === "string"),
    secretLabels: async () => {
      const view = await parts.secrets()?.view();
      return (view?.entries ?? []).flatMap((entry) => [entry.label, entry.ref]);
    },
    integrations: () => parts.integrations.view().integrations,
    task: (key) => parts.tasks.byKey(key),
    policies: (record) => {
      const policies = parts.tasks.policiesOf(record);
      return policies ? { delivery: policies.delivery.value, care: policies.rigor.value } : null;
    },
    timeline: (taskId) => parts.timeline.entries(taskId),
    signedIn: () => forgeSignIns.isSignedIn(GITHUB_COM),
    login: () => forgeSignIns.loginOf(GITHUB_COM),
    getJson: async (path) => {
      if (forgeSignIns.isSignedIn(GITHUB_COM)) {
        const api = parts.accountForge(GITHUB_COM).api;
        if (api) return api.call("GET", path);
      }
      const answer = await fetch(`${githubApiBaseUrl({ packaged: app.packaged })}${path}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "infinitary" },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: answer.status, body: await answer.text() };
    },
    keep: (taskId, write) => parts.githubGateway.keepFeedback(taskId, write),
  });
}
