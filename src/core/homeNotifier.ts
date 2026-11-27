import { PHONE_PUSH_RELAY } from "@shared/phonePush";
import type { HostCapabilities } from "./host";
import { authorAnswer } from "./notifications";
import { cardNotifiers } from "./phonePush";
import { SomeoneHere } from "./someoneHere";
import type { CardStore } from "./storage/cardStore";
import type { SettingsStore } from "./storage/settingsStore";
import type { TaskService } from "./tasks/taskService";
import type { RepoRegistry } from "./workspace/repoRegistry";

/**
 * Home wiring for the card notifiers: Notification Center while the window is
 * not front (P2), and each paired phone that asked through Infinitary's relay
 * once nobody is at a computer showing this first mate (docs/phone-push.md).
 * The card/feed split is the noise filter, so feed lines never notify, and
 * e2e windows stay hidden and unfocused.
 */
export function startHomeNotifier({
  host,
  settings,
  devices,
  relayUrl,
  tasks,
  repos,
  cardStore,
}: {
  host: Pick<HostCapabilities, "notifications">;
  settings: Pick<SettingsStore, "getNotificationsEnabled">;
  devices: Parameters<typeof cardNotifiers>[0]["phones"];
  /** A stand-in relay for development and end-to-end runs; absent, Infinitary's own. */
  relayUrl: string | undefined;
  tasks: Pick<TaskService, "get">;
  repos: Pick<RepoRegistry, "get">;
  cardStore: Pick<CardStore, "messages">;
}) {
  const someoneHere = new SomeoneHere();
  const notifier = cardNotifiers({
    notifications: host.notifications,
    someoneHere,
    switchedOn: () => settings.getNotificationsEnabled(),
    phones: devices,
    relay: relayUrl ?? PHONE_PUSH_RELAY,
    // The words' typed facts (INF-5030's plan): the task's project, its title
    // when the card shows its saved change story, and an author's answer.
    facts: (card, kind) => {
      const task = card.taskId ? tasks.get(card.taskId) : undefined;
      const story = task?.delivery?.presentation?.revisions.some(
        (revision) => revision.title === card.title,
      );
      return {
        project: task?.repoId ? repos.get(task.repoId)?.name : undefined,
        storyName: story ? task?.title : undefined,
        answer: kind === "reply" ? authorAnswer(cardStore.messages(card.id)) : undefined,
      };
    },
  });
  return { notifier, someoneHere };
}
