import type { KnowledgeService } from "../knowledge/knowledgeService";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { TICK_PERIOD_MS, type Ticker } from "../orchestrator/ticker";
import type { WakeFacts } from "../orchestrator/wakes";
import type { CardStore } from "../storage/cardStore";
import type { AppDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import type { InboxStore } from "../storage/inboxStore";
import type { SettingsStore } from "../storage/settingsStore";
import { TaskEventStore } from "../storage/taskEventStore";
import type { TaskService } from "../tasks/taskService";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { CorrectionCases } from "./correctionCases";
import { CorrectionConsumer } from "./correctionConsumer";
import { CorrectionSources } from "./correctionSources";
import type { DecisionModels } from "./decisionModel";

function tabInput(facts: WakeFacts | undefined): { captainText?: string } | undefined {
  if (!facts) return undefined;
  if (facts.kind === "crewmate-tab-line") return facts;
  if ("guidance" in facts && typeof facts.guidance === "object" && facts.guidance !== null)
    return tabInput(facts.guidance as WakeFacts);
  return undefined;
}

export function startCorrections(options: {
  db: AppDatabase;
  inbox: InboxStore;
  cards: CardStore;
  tasks: TaskService;
  models: DecisionModels;
  settings: SettingsStore;
  supervisor: CrewSupervisor;
  knowledge: KnowledgeService;
  repos: Pick<RepoRegistry, "get">;
  ticker: Ticker;
}) {
  const { inbox, cards, tasks, models, settings, supervisor, knowledge, repos, ticker } = options;
  const consumer = new CorrectionConsumer({
    inbox,
    models,
    ledger: new DecisionStore(options.db),
    now: ticker.now,
    exists: (source) =>
      source.kind === "card"
        ? Boolean(source.observationId && cards.captainInput(source.observationId))
        : source.kind === "composer"
          ? tasks.capture.captainAskText(source.askId ?? "") !== undefined
          : Boolean(source.taskId && tasks.get(source.taskId)),
  });
  const project = (id: string) => {
    const repo = repos.get(id);
    return repo ? { id, name: repo.name } : undefined;
  };
  const cases = new CorrectionCases({
    consumer,
    inbox,
    cards,
    tasks,
    supervisor,
    now: ticker.now,
    project,
    direction: (id) => {
      const read = knowledge.directions.read({ id: id.replace(/^d:/, "") });
      return read.state === "ready" ? read.direction : undefined;
    },
  });
  const sources = new CorrectionSources({
    consumer,
    cards,
    allowed: () => models.allowsUse("reply-checks"),
    offerCard: (id) => cases.offering(id),
    task: (id) => tasks.get(id),
    taskExchange: (id) => new TaskEventStore(options.db).originalCaptainExchange(id),
    project,
  });
  supervisor.cards.setDirectionRetention((...args) => cases.retains(...args));
  const stops = [
    cards.onCaptainInteraction((id) => {
      const input = cards.captainInput(id);
      if (input) sources.card(input);
    }),
    tasks.capture.onCaptainInput((ask, text) =>
      sources.composer(
        {
          key: `ask:${ask.id}`,
          kind: "composer",
          askId: ask.id,
          at: ask.at,
          ...(ask.hintTaskId ? { taskId: ask.hintTaskId } : {}),
        },
        text,
        tasks.capture.originalTurnsBefore(ask.id),
      ),
    ),
    inbox.onEnqueue((row) => {
      const input = tabInput(row.facts);
      if (input?.captainText !== undefined && tasks.get(row.recipient))
        sources.crewmate(
          {
            key: `crew-input:${row.id}`,
            kind: "crewmate-tab",
            taskId: row.recipient,
            inboxId: row.id,
            at: row.createdAt,
          },
          input.captainText,
        );
    }),
    settings.onDecisionsChanged(() => {
      if (!models.allowsUse("reply-checks")) consumer.withdraw();
    }),
  ];
  if (!models.allowsUse("reply-checks")) consumer.withdraw();
  let stopped = false;
  ticker.register("correction-work", TICK_PERIOD_MS, () => {
    if (stopped) return;
    // The drain's promise goes to the ticker, so the freeze recorder can follow its work.
    const drained = consumer.drain();
    cases.sweep();
    return drained;
  });
  void consumer.drain();
  return {
    cases,
    consumer,
    stop: () => {
      stopped = true;
      for (const stop of stops) stop();
      supervisor.cards.setDirectionRetention();
      consumer.dispose();
    },
  };
}
