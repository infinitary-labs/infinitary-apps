import type { FmEvent } from "@shared/events";
import type { CrewSupervisor } from "./orchestrator/crewSupervisor";
import type { FirstmateAgent } from "./orchestrator/firstmateAgent";
import type { TaskService } from "./tasks/taskService";
import { ProjectChanges } from "./workspace/projectChanges";
import { ProjectContributions } from "./workspace/projectContributions";
import { ProjectSetups } from "./workspace/projectSetups";
import type { RepoRegistry } from "./workspace/repoRegistry";

/** Home wiring for project cards and fork routing; each existing owner retains its writes. */
export function startHomeProjects({
  repos,
  tasks,
  devices,
  forgeFor,
  supervisor,
  broadcastEvent,
  notify,
}: {
  repos: RepoRegistry;
  tasks: TaskService;
  devices: ConstructorParameters<typeof ProjectSetups>[0]["devices"];
  forgeFor: ConstructorParameters<typeof ProjectContributions>[0]["forgeFor"];
  supervisor: Pick<CrewSupervisor, "cards" | "hostOps">;
  broadcastEvent: (event: FmEvent) => void;
  notify: (notice: Parameters<FirstmateAgent["notifyOp"]>[0]) => void;
}) {
  const projectContributions = new ProjectContributions({
    repos,
    tasks,
    broadcastEvent,
    forgeFor,
    hasWorkingCopy: (repoId) =>
      tasks
        .listLive()
        .some(
          (record) =>
            record.repoId === repoId &&
            (Boolean(record.worktreeDir) || record.activity === "starting"),
        ),
    raise: (card) => supervisor.cards.hostCards.raiseHostCard(card),
    note: (text, outcome) => {
      broadcastEvent({ type: "firstmate_note", text });
      notify({ facts: { kind: "project-change", outcome, title: text } });
    },
  });
  const projectSetups = new ProjectSetups({
    repos,
    devices,
    raiseCard: (card) => supervisor.cards.hostCards.raiseHostCard(card),
    tell: (facts) => notify({ facts }),
    broadcast: (event) => broadcastEvent(event),
  });
  supervisor.hostOps.setProjectSetup({
    add: (offer, answers) => {
      void projectSetups.add(offer, answers).catch((error: unknown) => {
        broadcastEvent({
          type: "firstmate_note",
          text: `Could not add the project: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    decline: (offer) => projectSetups.decline(offer),
  });
  const projectChanges = new ProjectChanges({
    repos,
    devices,
    raiseCard: (card) => supervisor.cards.hostCards.raiseHostCard(card),
    tell: (facts) => notify({ facts }),
  });
  return { projectContributions, projectSetups, projectChanges };
}
