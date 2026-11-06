import { homedir } from "node:os";
import { join } from "node:path";
import type { CoreEventSink } from "../events";
import type { ForgeSignIns } from "../forge";
import type { HostCapabilities } from "../host";
import { hostEnv } from "../hostEnv";
import { isAllowedOpenExternalUrl } from "../openExternal";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { GithubGatewayService } from "../orchestrator/githubGateway";
import type { AppPaths } from "../paths";
import type { PanelOutsideData } from "../personal/panelOutsideData";
import type { StandIns } from "../standIns";
import type { TaskService } from "../tasks/taskService";
import { atUtilityQos } from "../utilityQos";
import { INBOX_COMMAND } from "./commandWords";
import { OutsideReads } from "./outsideReads";
import { PanelAsks } from "./panelAsks";
import { forgeHostIntegration } from "./providers/forgeHosts";
import { githubIntegration } from "./providers/github";
import { googleSetup } from "./providers/google/client";
import { googleIntegration } from "./providers/google/googleIntegration";
import { INBOX_ID, Inbox, launcherDefaultDir } from "./providers/inbox";
import { mcpIntegration } from "./providers/mcp/mcpIntegration";
import { standInIntegration } from "./providers/standIn";
import { FileIntegrationSecrets } from "./secrets";
import { IntegrationsService } from "./service";
import { IntegrationSettingsStore } from "./store";

/**
 * The home's integrations wiring (docs/integrations.md): GitHub over the
 * forge's own sign-in and the gateway's calls through it, Google over its
 * own sign-in in the person's browser, and the MCP servers the person adds,
 * each program a child with the host's environment, below the UI. A new
 * kind is one more binding here. An unpackaged run that names a folder
 * connects the stand-in, which tells an event for each line added there
 * (docs/automation.md, "Events").
 */
export type HomeIntegrations = {
  integrations: IntegrationsService;
  /** The inbox (docs/integrations.md, "The inbox"): the door the person's own programs drop events through. */
  inbox: Inbox;
  /** One ask per panel and action at a time (docs/integrations.md, "Panels"). */
  panelAsks: PanelAsks;
  /** Which conversations received fenced words, and when, so they go when due. */
  outsideReads: OutsideReads;
};

/** What an integration's ask and a saved attachment reach of the crew. */
export type IntegrationsCrew = Pick<CrewSupervisor, "integrationAsks" | "sessions">;

export function startHomeIntegrations(options: {
  host: Pick<HostCapabilities, "app" | "openExternal">;
  paths: Pick<AppPaths, "integrationsDir">;
  standIns: Pick<StandIns, "integrationDir" | "inboxLinkDir">;
  /** The folder of the app's own task commands, the inbox's among them. */
  axiBinDir: string;
  forgeSignIns: ForgeSignIns;
  gateway: GithubGatewayService;
  tasks: Pick<TaskService, "delivery">;
  /** A panel holds words from outside no longer than their kind does. */
  panelOutside: Pick<PanelOutsideData, "noted">;
  /** The crew, built after the integrations and read only once an ask comes. */
  crew: () => IntegrationsCrew;
  now: () => number;
  emit: CoreEventSink;
}): HomeIntegrations {
  const { host, paths, standIns, forgeSignIns, gateway: githubGateway, tasks, now } = options;
  // Google only where the run has a client: a packaged build has none until
  // Infinitary registers its own (`GOOGLE_OAUTH_CLIENT`), so it offers no
  // Google row until then.
  const google = googleSetup({ packaged: host.app.packaged });
  // A binding's own change reaches the service once it exists.
  let integrationsChanged: () => void = () => {};
  const integrationSecrets = new FileIntegrationSecrets(join(paths.integrationsDir, "secrets"));
  // Which conversations received fenced words, and when, so they go when due.
  const outsideReads = new OutsideReads(paths.integrationsDir);
  // The inbox (docs/integrations.md, "The inbox"): a door the person's own
  // programs drop events through, with the launcher's inbox command. Its
  // link goes into /usr/local/bin, or where an unpackaged run names; a Linux
  // package installs its own in /usr/bin.
  const integrationInbox = new Inbox({
    dir: join(paths.integrationsDir, INBOX_ID),
    command: join(options.axiBinDir, INBOX_COMMAND),
    defaultDir: launcherDefaultDir(
      host.app.platform,
      hostEnv().HOME ?? homedir(),
      hostEnv().XDG_CONFIG_HOME,
    ),
    linkDir: standIns.inboxLinkDir || "/usr/local/bin",
    ...(host.app.packaged && host.app.platform === "linux" ? { installedDir: "/usr/bin" } : {}),
    now,
  });
  const integrationSettings = new IntegrationSettingsStore(paths.integrationsDir);
  // The inbox's switch is its connection's pause (INF-1567): off, its door refuses.
  integrationInbox.pausedThrough(() => integrationSettings.read()[INBOX_ID]?.paused === true);
  const panelAsks = new PanelAsks(paths.integrationsDir);
  const integrations = new IntegrationsService({
    bindings: [
      githubIntegration({
        signIns: forgeSignIns,
        gateway: {
          read: (taskId, input, through) => githubGateway.read(taskId, input, through),
          write: (taskId, input, through) => githubGateway.write(taskId, input, through, true),
          readAsSeat: (input) => githubGateway.readAsSeat(input),
          writeAsSeat: (input) => githubGateway.writeAsSeat(input),
          readAsPanel: (panel, input) => githubGateway.readAsPanel(panel, input),
          writeAsPanel: (panel, input) => githubGateway.writeAsPanel(panel, input),
          readForLook: (input) => githubGateway.readForLook(input),
        },
        now,
      }),
      ...(["gitlab", "github-enterprise"] as const).map((kind) =>
        forgeHostIntegration(kind, {
          signIns: forgeSignIns,
          gateway: (forgeHost) => ({
            read: (taskId, input) => githubGateway.read(taskId, input, { host: forgeHost }),
            write: (taskId, input) => githubGateway.write(taskId, input, { host: forgeHost }, true),
            readAsSeat: (input) => githubGateway.readAsSeat(input, forgeHost),
            writeAsSeat: (input) => githubGateway.writeAsSeat(input, forgeHost),
            readAsPanel: (panel, input) => githubGateway.readAsPanel(panel, input, forgeHost),
            writeAsPanel: (panel, input) => githubGateway.writeAsPanel(panel, input, forgeHost),
            readForLook: (input) => githubGateway.readForLook(input, forgeHost),
          }),
        }),
      ),
      ...(google
        ? [
            googleIntegration({
              root: paths.integrationsDir,
              secrets: integrationSecrets,
              ...google,
              open: async (url) => {
                if (!isAllowedOpenExternalUrl(url))
                  throw new Error("The Google sign-in page's address was refused.");
                await host.openExternal(url);
              },
              now,
              changed: () => integrationsChanged(),
            }),
          ]
        : []),
      mcpIntegration({
        root: paths.integrationsDir,
        env: () => hostEnv(),
        belowUi: (file, args) => atUtilityQos(file, args),
        cwd: () => hostEnv().HOME ?? homedir(),
        version: host.app.version,
        changed: () => integrationsChanged(),
      }),
      integrationInbox.binding(),
      ...(standIns.integrationDir ? [standInIntegration({ dir: standIns.integrationDir })] : []),
    ],
    store: integrationSettings,
    // The bridge until the secret manager takes the keys over (INF-775, q3).
    secrets: integrationSecrets,
    asks: {
      keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
      present: (taskId, ask) => options.crew().integrationAsks.askIntegration(taskId, ask),
      keepForFirstmate: (ask) => options.crew().integrationAsks.askIntegrationForFirstmate(ask),
      // One ask per panel and action at a time (docs/integrations.md, "Panels").
      keepForPanel: (ask) => {
        const held = ask.panel
          ? panelAsks.held(ask.panel.key, ask.integration, ask.action)
          : undefined;
        if (held) return { held: held.state };
        const card = options.crew().integrationAsks.askIntegrationForPanel(ask);
        panelAsks.asking(ask, card);
        return { card };
      },
      take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) =>
        tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
    },
    reads: outsideReads,
    // A panel holds words from outside no longer than their kind does.
    panelReads: (panel, label, at) => options.panelOutside.noted(panel, label, at),
    // A saved Gmail attachment lands in the calling task's hand-over folder, wherever it runs.
    files: {
      refusal: (taskId) => options.crew().sessions.outsideFileRefusal(taskId),
      save: (taskId, name, bytes) => options.crew().sessions.saveOutsideFile(taskId, name, bytes),
    },
    now,
    push: (view) => options.emit("inf:integrations", view),
  });
  integrationsChanged = () => integrations.changed();
  return { integrations, inbox: integrationInbox, panelAsks, outsideReads };
}
