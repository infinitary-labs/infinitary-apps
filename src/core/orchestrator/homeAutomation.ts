import type { FmEvent } from "@shared/events";
import { HEARTBEAT_WAKE } from "@shared/heartbeat";
import { INBOX_WORDS } from "@shared/integrations";
import type { DecisionModels } from "../decisions/decisionModel";
import { EventScreenOffer } from "../decisions/eventScreenOffer";
import { eventScreen } from "../decisions/homeDecisions";
import { INBOX_EVENT, INBOX_ID } from "../integrations";
import type { Inbox } from "../integrations/providers/inbox";
import type { IntegrationsService } from "../integrations/service";
import type { Runbooks } from "../runbooks/runbooks";
import type { AppDatabase } from "../storage/db";
import type { InboxStore } from "../storage/inboxStore";
import { ScheduleStore } from "../storage/scheduleStore";
import { UsageStore } from "../storage/usageStore";
import type { TaskService } from "../tasks/taskService";
import type { CrewSupervisor } from "./crewSupervisor";
import { heartbeatBeat } from "./heartbeat";
import { waitThroughAutomation } from "./putOffs";
import { Scheduler, type SchedulerOptions } from "./scheduler";
import { integrationEvents, withTaskEvents } from "./taskEvents";

/**
 * Home wiring for Automation (docs/automation.md): the one scheduler over
 * its store, the event screen's offer, the crew's put-off cards and rule
 * notes, and the inbox's drops and its rule (docs/integrations.md, "The
 * inbox"). The scheduler starts on the ticker once the first mate exists.
 */
export function startHomeAutomation({
  db,
  decisions,
  supervisor,
  broadcastEvent,
  notifyFirstmate,
  inbox,
  now,
  tasks,
  integrations,
  integrationInbox,
  runbooks,
}: {
  db: AppDatabase;
  decisions: DecisionModels;
  supervisor: Pick<CrewSupervisor, "cards" | "hostOps" | "bindRuleNotes" | "holdRules">;
  broadcastEvent: (event: FmEvent) => void;
  /** Late-bound: the first mate is built after Automation. */
  notifyFirstmate: SchedulerOptions["notify"];
  inbox: InboxStore;
  now: () => number;
  tasks: TaskService;
  integrations: IntegrationsService;
  integrationInbox: Inbox;
  /** Whose wakes bring the heartbeat's rule (docs/automation.md, "The heartbeat"). */
  runbooks: Pick<Runbooks, "wakes" | "subscribe">;
}) {
  const scheduleStore = new ScheduleStore(db);
  // A reader over the usage ledger, whose one writer is `homeUsage`'s store.
  const usage = new UsageStore(db);
  // A rule with an Only if condition saved while the screen is off offers it (docs/automation.md, "Offering the screen").
  const eventScreenOffer = new EventScreenOffer({
    decisions,
    cards: supervisor.cards.hostCards,
    note: (text) => broadcastEvent({ type: "firstmate_note", text }),
  });
  supervisor.hostOps.setEventScreen((arg) => eventScreenOffer.turnOn(arg));
  const scheduler = new Scheduler({
    store: scheduleStore,
    notify: (wake, origin) => notifyFirstmate(wake, origin),
    inbox,
    broadcastEvent,
    now,
    events: withTaskEvents(tasks, integrationEvents(integrations)),
    raise: (cardId) => void supervisor.cards.putOffs.raiseCard(cardId),
    // A hold's event rule ends its task's hold (docs/automation.md, "A rule that ends a hold").
    endHold: (taskId, ruleId, events) => supervisor.holdRules.ran(taskId, ruleId, events),
    screen: eventScreen(decisions),
    heartbeat: (at) => heartbeatBeat({ schedules: scheduleStore, usage, tasks, inbox }, at),
    enabled: (record) => void eventScreenOffer.offer(record),
    // A turn that handled several runs links each to its own rule's tasks (docs/automation.md, "Deliveries").
    startedBy: (taskId) => tasks.capture.automationStart(taskId),
    // The inbox's receipts say an event was handled once its delivery was.
    handled: (integration, events, at) => {
      if (integration === INBOX_ID) integrationInbox.handled(events, at);
    },
    // A rule's project is named in its prompt while it is live (docs/automation.md).
    projectOf: (id) => {
      const project = tasks.projects.get(id);
      return project && project.archivedAt === null
        ? { key: project.key, name: project.name }
        : undefined;
    },
  });
  waitThroughAutomation(supervisor.cards.putOffs, scheduler, tasks);
  supervisor.holdRules.bindRules(scheduler);
  // A crewmate a rule's run started is handed the rule's notes as a file (docs/automation.md, "A rule's notes").
  supervisor.bindRuleNotes(scheduler);
  // A drop is looked at once, not at the next minute (docs/integrations.md, "The inbox").
  integrationInbox.wakeThrough({
    dropped: () => scheduler.lookNow(INBOX_ID),
    listening: () => scheduler.listeners(INBOX_ID),
    // The captain's word on INF-1214: adding the inbox turns its rule on
    // too. A rule kept from before it was last turned off listens to this
    // inbox again, its edits and its state kept.
    added: (say) => {
      const spec = { kind: "event", integration: INBOX_ID, event: INBOX_EVENT.name } as const;
      const current = integrations.listenable(INBOX_ID, INBOX_EVENT.name)?.connection;
      const kept = scheduler
        .rules()
        .filter((rule) => rule.spec.kind === "event" && rule.spec.integration === INBOX_ID);
      for (const rule of kept)
        if (rule.connection !== current) scheduler.update(rule.id, { reconnect: true }, { say });
      if (kept.length === 0)
        scheduler.create(spec, INBOX_WORDS.rulePrompt, true, INBOX_WORDS.ruleName, undefined, {
          ...(say ? { say } : {}),
        });
    },
  });
  // The Heartbeat runbook's rule follows its wake: kept at start and on each switch.
  const keepHeartbeat = () => scheduler.keepBrought(runbooks.wakes().has(HEARTBEAT_WAKE));
  keepHeartbeat();
  runbooks.subscribe(keepHeartbeat);
  return { scheduleStore, eventScreenOffer, scheduler };
}
