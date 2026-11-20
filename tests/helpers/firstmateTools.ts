import { join } from "node:path";
import type { Card } from "@shared/cards";
import { IntegrationSettingsStore, IntegrationsService } from "../../src/core/integrations";
import { KnowledgeService } from "../../src/core/knowledge/knowledgeService";
import { CrewSupervisor } from "../../src/core/orchestrator/crewSupervisor";
import { FirstmateAgent } from "../../src/core/orchestrator/firstmateAgent";
import type { Scheduler } from "../../src/core/orchestrator/scheduler";
import { appPathsFor } from "../../src/core/paths";
import type { ModelRuntime } from "../../src/core/pi/types";
import { ShellPreferencesService } from "../../src/core/preferences/shellPreferences";
import type { BoundTool } from "../../src/core/session/tools";
import { CardStore } from "../../src/core/storage/cardStore";
import type { AppDatabase } from "../../src/core/storage/db";
import { InboxStore } from "../../src/core/storage/inboxStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import type { WorkspaceService } from "../../src/core/workspace/workspaceService";
import { freshDatabase } from "./database";
import { fakeBinding, fakeSessionFactory } from "./fakeSession";
import { scratchDir } from "./scratchDirs";

/**
 * The Firstmate's whole tool set, read off the live agent: a
 * `FirstmateAgent` with every optional host side present attaches once, and
 * these are the bound tools its session factory received - the one list
 * both seats serve. The self-source pin, the Claude-side check and the
 * Claude census read it, so none of them keeps a second copy of the set.
 * A census reads what the tools say; nothing here runs one.
 */
export async function firstmateTools(): Promise<BoundTool[]> {
  return (await firstmateSeat()).tools;
}

/**
 * A crew supervisor over an in-memory record with no first mate attached,
 * holding the cards an earlier run saved. Nothing is bound to the
 * workspace; a tool that reaches it fails.
 */
export function toolsCrew(saved: Card[] = []): {
  paths: ReturnType<typeof appPathsFor>;
  db: AppDatabase;
  repos: RepoRegistry;
  tasks: TaskService;
  cardStore: CardStore;
  supervisor: CrewSupervisor;
} {
  const paths = appPathsFor(scratchDir("infinitary-firstmate-tools-"));
  const db = freshDatabase();
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, strict: true });
  const cardStore = new CardStore(db);
  for (const card of saved) cardStore.upsert(card);
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace: {} as WorkspaceService,
    repos,
    tasks,
    cardStore,
    inbox: new InboxStore(db),
    paths,
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  return { paths, db, repos, tasks, cardStore, supervisor };
}

/**
 * The same live agent with the crew supervisor and stores it was built
 * over, for a case that runs a tool and reads what it did to the record
 * and the card stack. Nothing is bound to the workspace; a tool that
 * reaches it fails.
 */
export async function firstmateSeat(): Promise<{
  tools: BoundTool[];
  supervisor: CrewSupervisor;
  tasks: TaskService;
  cardStore: CardStore;
}> {
  const { paths, db, repos, tasks, cardStore, supervisor } = toolsCrew();
  const settings = new SettingsStore(db);
  // The factory the agent opens its seat through: it keeps the spec it was handed.
  const seat = fakeSessionFactory("pi");
  const agent = new FirstmateAgent({
    paths,
    inbox: new InboxStore(db),
    settings,
    modelRuntime: {} as ModelRuntime,
    availableModels: () => [{ provider: "fm-mock", id: "mock-1" }],
    quotaModels: () => undefined,
    quotaLine: () => "",
    repos,
    supervisor,
    tasks,
    knowledge: new KnowledgeService({
      projects: { get: (id) => repos.get(id), list: () => repos.list() },
    }),
    integrations: new IntegrationsService({
      bindings: [],
      store: new IntegrationSettingsStore(paths.integrationsDir),
    }),
    secretAsks: {
      ask: async (input) => ({ ask: input.id, state: "waiting" }),
      cancel: () => false,
    },
    scheduler: {} as Scheduler,
    supervisionLog: () => [],
    flagMissedEscalation: ({ taskId }) => ({ status: "no-outcome", taskId }),
    flagDuplicate: (input) => supervisor.flagDuplicate(input),
    personalize: {
      preferences: new ShellPreferencesService(settings, () => {}),
      personal: () => ({ extensions: [] }),
      removePersonal: async () => ({ removed: false, committed: false }),
      uninstallPlugin: async () => ({ removed: false }),
      personalWorkspaceDir: join(paths.userData, "fleet", "personal"),
      gates: () => ({ knowledge: true }),
    },
    installPlugin: async () => "not called",
    broadcastEvent: () => {},
    selfSourceDir: join(paths.userData, "self-source"),
    seats: { pi: seat },
  });
  await agent.rebind("census");
  const served = seat.specs[0]?.tools;
  if (!served) throw new Error("the Firstmate never attached a session");
  return { tools: [...served], supervisor, tasks, cardStore };
}
