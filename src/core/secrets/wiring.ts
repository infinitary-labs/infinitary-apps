import { join } from "node:path";
import type { Card } from "@shared/cards";
import type { CoreEventSink } from "../events";
import type { HostCapabilities } from "../host";
import { hostEnv } from "../hostEnv";
import { TaskService } from "../tasks/taskService";
import type { SecretAskEnded } from "./asks";
import { type SecretBringEnded, SecretBrings } from "./bring";
import { ProtectedSecrets } from "./protected";
import type { EndedUseReceipt } from "./requests";
import { SecretsSettings } from "./settings";

type SecretsSupervisor = {
  cards: {
    get(id: string): Card | undefined;
    hostCards: {
      raiseHostCard(card: Omit<Card, "author" | "priority" | "status" | "createdAt">): void;
      withdrawHostCard(id: string, reason: string): void;
    };
  };
  steer: {
    secretsUseEnded(task: string, receipt: EndedUseReceipt): void;
    secretsAskEnded(task: string | null, ended: SecretAskEnded): void;
    secretsBringEnded(task: string, ended: SecretBringEnded): void;
  };
  hostOps: { setSecretsDecision(decide: (offer: string) => Promise<void>): void };
};

/**
 * Secrets and the brings beside it (docs/secrets.md), opened over the data
 * folder where the host offers native Secrets and absent elsewhere. Both
 * owners share one card decision; an ask or a bring that waited through a
 * restart is picked up here.
 */
export function startSecrets(options: {
  host: HostCapabilities["secrets"];
  userData: string;
  beforeUse: () => Promise<void>;
  supervisor: SecretsSupervisor;
  tasks: Pick<TaskService, "get">;
  emit: CoreEventSink;
}): { secrets: SecretsSettings; secretBrings: SecretBrings } {
  const { host, userData, supervisor, tasks, emit } = options;
  const hostCards = supervisor.cards.hostCards;
  const taskOpen = (task: string) =>
    !TaskService.isClosed(tasks.get(task) ?? { status: "dropped" });
  const taskTitle = (task: string) => tasks.get(task)?.title;
  const changed = () => emit("inf:secrets:changed", {});
  const secrets = new SecretsSettings({
    beforeUse: options.beforeUse,
    ...(host
      ? {
          open: (initialize) =>
            ProtectedSecrets.open({
              dir: join(userData, "secrets"),
              custody: host.custody,
              ...(host.authentication ? { authentication: host.authentication } : {}),
              environment: hostEnv,
              initialize,
            }),
          ...(host.unlock ? { unlock: host.unlock } : {}),
          ...(host.recovery ? { recovery: host.recovery } : {}),
        }
      : {}),
    raise: (card) => hostCards.raiseHostCard(card),
    openCard: (id) => supervisor.cards.get(id),
    withdraw: (id, reason) => hostCards.withdrawHostCard(id, reason),
    settled: (task, receipt) => supervisor.steer.secretsUseEnded(task, receipt),
    ...(host ? { asksFile: join(userData, "secret-asks.json") } : {}),
    asked: (task, ended) => supervisor.steer.secretsAskEnded(task, ended),
    taskOpen,
    taskTitle,
    changed,
  });
  const secretBrings = new SecretBrings({
    owner: async (initialize) => (await secrets.ready(initialize))?.protected,
    offered: !!host,
    environment: hostEnv,
    raise: (card) => hostCards.raiseHostCard(card),
    withdraw: (id, reason) => hostCards.withdrawHostCard(id, reason),
    changed,
    brought: (task, ended) => supervisor.steer.secretsBringEnded(task, ended),
    taskOpen,
    taskTitle,
    ...(host ? { file: join(userData, "secret-brings.json") } : {}),
  });
  supervisor.hostOps.setSecretsDecision((offer) =>
    secretBrings.owns(offer) ? secretBrings.decide(offer) : secrets.decide(offer),
  );
  secrets.resumeAsks(); // An ask that waited through a restart comes back with a new pass.
  secretBrings.resume(); // A bring that waited through a restart ends, and its asker hears so.
  return { secrets, secretBrings };
}
