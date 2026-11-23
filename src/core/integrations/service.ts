import { randomBytes, randomUUID } from "node:crypto";
import {
  INTEGRATION_KIND_NAMES,
  INTEGRATION_NOTICES,
  type IntegrationApprovalChoice,
  type IntegrationEventView,
  type IntegrationKind,
  type IntegrationSettingsPatch,
  type IntegrationSignInConsent,
  type IntegrationsView,
  type IntegrationView,
  integrationIdSchema,
  integrationKindSchema,
  integrationNameSchema,
  integrationNoticeRefusal,
  integrationRenameWords,
  integrationRule,
} from "@shared/integrations";
import { type Fence, fenced, fencedAnswer } from "@shared/outsideData";
import type { PanelIntegrationUse } from "@shared/personal/contracts";
import { undeclaredIntegrationMessage } from "@shared/personal/manifest";
import type { KeptOutsideData } from "@shared/savedOutsideData";
import type {
  IntegrationAllowance,
  IntegrationAsk,
  IntegrationScope,
  WriteAsk,
  WriteAskOutcome,
} from "@shared/writeAsk";
import type { LegacyCalls } from "../storage/outsideDataScrub";
import { APP_EVENTS, appEventSource } from "./appEvents";
import {
  type IntegrationActionSpec,
  type IntegrationAnswer,
  type IntegrationBinding,
  type IntegrationCaller,
  type IntegrationConnection,
  type IntegrationEventFilter,
  type IntegrationEventSpec,
  type IntegrationLook,
  IntegrationOutcomeUnknown,
  type PanelCaller,
} from "./binding";
import { FIRSTMATE_READER } from "./outsideReads";
import { WHOLE_ACTION } from "./scopes";
import type { IntegrationSettings, IntegrationSettingsStore } from "./store";

/**
 * The integrations' one writer and one door for every caller
 * (docs/integrations.md): Settings -> Integrations and the first mate's
 * `app_change` change it through the action catalog, and the first mate's
 * `integrations` and `use_integration` and a crewmate's
 * `infinitary-integrations-axi` read and call through it. A row is a
 * connection a kind's binding has now; its settings - name, paused, which
 * actions are off - are this service's, in `IntegrationSettingsStore`.
 */

export type IntegrationsServiceOptions = {
  bindings: readonly IntegrationBinding[];
  store: IntegrationSettingsStore;
  /**
   * An unapproved action is kept with its reason and exact input - on the
   * caller's task, or for the first mate on the row the host files - the
   * host presents its card and the captain's choice takes it once.
   */
  asks?: IntegrationAskStore;
  /**
   * Which conversation received fenced words, and when (`OutsideReads`):
   * a call's caller, and the first mate for a rule's events.
   */
  reads?: {
    note: (reader: string, at: number) => void;
    /** A file from outside a task's call saved, by its kept name, so it goes when due. */
    saved?: (reader: string, file: string, label: string, at: number) => void;
  };
  /**
   * A panel received fenced words of a kind kept for a while
   * (`IntegrationBinding.kept`), by the fence's label: its store keys not
   * rewritten in that kind's days go, and the captain's delete empties its
   * store (`PanelOutsideData`).
   */
  panelReads?: (panel: string, label: string, at: number) => void;
  /**
   * Saves a file an action delivers (`IntegrationActionSpec.delivers`) into
   * the calling task's hand-over folder, on whichever computer runs it, and
   * answers its kept name and path there. `refusal` says why that task
   * cannot take one now - its computer needs an update - before anything
   * runs. Absent, such an action is refused.
   */
  files?: {
    refusal: (taskId: string) => string | undefined;
    save: (taskId: string, name: string, bytes: Buffer) => Promise<{ file: string; path: string }>;
  };
  now?: () => number;
  /** The whole view, after every change (`inf:integrations`). */
  push?: (view: IntegrationsView) => void;
};

/**
 * A connection with its kind's binding, its settings and its reference:
 * which connection its id stands for now ("Which connection").
 */
type Row = {
  binding: IntegrationBinding;
  connection: IntegrationConnection;
  settings: IntegrationSettings;
  ref: string;
};

/**
 * One task's reach, as its crewmate's command asks it
 * (`infinitary-integrations-axi`): this service's `forTask` on this Mac, and
 * on a computer that runs work the home asked each time (`SessionHost`,
 * docs/integrations.md "On a computer that runs work"). `signal` ends a wait
 * the command could no longer answer.
 */
export type TaskIntegrations = {
  list: (signal?: AbortSignal) => Promise<Record<string, unknown>[]>;
  show: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown> | IntegrationAnswer>;
  call: (
    name: string,
    action: string,
    input: unknown,
    signal?: AbortSignal,
    reason?: string,
  ) => Promise<IntegrationAnswer>;
};

export type IntegrationAskStore = {
  /** Keep the ask, answering the task's waiting asks the cap dropped for it (`WRITE_ASK_CAP`). */
  keep: (taskId: string, ask: IntegrationAsk) => readonly WriteAsk[] | void;
  /**
   * Put the ask on its task's approval card: the card already waiting for
   * the same connection, or a new one (INF-2993 piece 2), refusing the
   * waiting asks the cap dropped. It answers whether the ask joined a card
   * that was already up.
   */
  present?: (taskId: string, ask: IntegrationAsk, dropped: readonly WriteAsk[]) => boolean | void;
  /**
   * The first mate has no task (INF-1108): the host files the row its card
   * gates (`TaskService.capture.fileHostCardTask`), keeps the ask there and
   * presents the card, answering with its id. Absent, the first mate's call
   * is refused.
   */
  keepForFirstmate?: (ask: IntegrationAsk) => string;
  /**
   * A panel has no task either: the host keeps its ask on a row it files
   * for the card, one card per panel and action at a time
   * (docs/integrations.md, "Panels"). It answers the new card's id, or that
   * one is already up for that panel and action, or that the captain chose
   * Not now and the panel's line has not asked again since. Absent, a
   * panel's call that asks is refused.
   */
  keepForPanel?: (ask: IntegrationAsk) => PanelAskKept;
  take: (taskId: string, askId: string) => IntegrationAskTaken;
  record: (taskId: string, askId: string, outcome: WriteAskOutcome) => void;
  /**
   * Keep the captain's Allow for the rest of this task on the asking task
   * (INF-2993), and read a task's allowances, none once it closed. Absent,
   * the choice runs the call once and keeps nothing.
   */
  allow?: (taskId: string, allowance: IntegrationAllowance) => void;
  allowances?: (taskId: string) => readonly IntegrationAllowance[];
};

/** What keeping a panel's ask came to (`IntegrationAskStore.keepForPanel`). */
export type PanelAskKept = { card: string } | { held: "asking" | "declined" };

/**
 * One panel's reach (`forPanel`): the verbs a crewmate's command has, over
 * only the connections, actions and events its manifest names, plus `look`
 * for the events it hears.
 */
export type PanelIntegrationsReach = {
  list: () => Record<string, unknown>[];
  show: (name: string) => Record<string, unknown> | IntegrationAnswer;
  call: (name: string, action: string, input: unknown) => Promise<IntegrationAnswer>;
  look: (
    name: string,
    event: string,
    cursor: string | null,
  ) => Promise<IntegrationLook | IntegrationAnswer>;
  /** How often, in minutes, the event wants looking at; undefined when it cannot be heard. */
  every: (name: string, event: string) => number | undefined;
};

/** A kept ask the captain's click took, once, or why it took none. */
export type IntegrationAskTaken = { ask: WriteAsk } | { refused: string };

/** What the captain's click on a kept integration ask did. */
export type IntegrationAskSent = {
  ok: boolean;
  ask?: IntegrationAsk;
  /** The action's name, as it was kept. */
  call: string;
  place: string;
  outcome: WriteAskOutcome;
  answer?: string;
  /** The captain's Allow for the rest of this task this click kept (INF-2993). */
  allowance?: IntegrationAllowance;
};

/** Whether `show` answered a refusal's words rather than an integration's actions. */
export function isIntegrationAnswer(
  shown: Record<string, unknown> | IntegrationAnswer,
): shown is IntegrationAnswer {
  return "refused" in shown && typeof shown.text === "string";
}

/** An event an Automation rule may listen for, found by its integration's id or name. */
export type IntegrationListen = {
  /** The integration's id, which a rule keeps. */
  integration: string;
  /** Which connection the id stands for now, which a rule keeps beside it. */
  connection: string;
  name: string;
  event: string;
  label: string;
  /** How often the app looks, in the tick's minutes. */
  every: number;
  filters?: readonly IntegrationEventFilter[];
  atOnce?: boolean;
  /** Paused in Settings → Integrations: it answers no look until resumed. */
  paused?: boolean;
};

/** A connection's reference as `referenceConnections` gives it. */
const CONNECTION_REF = /^c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What holds a name now (`IntegrationsService.holder`). */
type Holder =
  | { row: Row }
  | { claim: IntegrationKind }
  | { reserved: string; signedOut: boolean }
  | { app: string };

/** A fence's random value: 64 bits, which nobody who wrote the fenced words could guess. */
const FENCE_VALUE_BYTES = 8;

/** A refusal the catalog line's caller reads as the reason. */
export class IntegrationRefusal extends Error {}

export class IntegrationsService {
  /** The sign-in waiting for the person's browser, at most one at a time. */
  private signingIn: AbortController | undefined;
  /**
   * Names and ids an addition or a sign-in holds while it waits for the
   * place (docs/integrations.md, "Names"), by their compared form: another
   * addition, sign-in or rename cannot take one before it is published or
   * let go (INF-948).
   */
  private readonly claims = new Map<string, { kind: IntegrationKind; by: symbol }>();

  constructor(private readonly options: IntegrationsServiceOptions) {}

  /**
   * Whether any connection may be set up here, working or not, read from
   * whether its record is present without parsing any secret; a record that
   * cannot be read counts as one.
   */
  hasConnections(): boolean {
    return this.options.bindings.some(
      (binding) => binding.saved?.() ?? binding.connections().length > 0,
    );
  }

  view(): IntegrationsView {
    const rows = this.rows();
    const connected = new Set(rows.map((row) => row.binding.kind));
    return {
      integrations: rows.map((row) => this.viewOf(row)),
      addable: this.options.bindings
        .filter((binding) => binding.many || !connected.has(binding.kind))
        .map((binding) => ({ kind: binding.kind, name: INTEGRATION_KIND_NAMES[binding.kind] })),
      // The app's own events, always there, which a rule listens to the same way.
      appEvents: APP_EVENTS.map((source) => ({
        id: source.id,
        name: source.name,
        events: source.events.map(eventView),
      })),
    };
  }

  /**
   * The first mate's roster line for its context block: each integration's
   * name and who it is signed in as, and nothing of its actions, so an
   * integration nobody uses costs one name. Undefined with none.
   */
  rosterLine(): string | undefined {
    const rows = this.rows();
    if (rows.length === 0) return undefined;
    return rows
      .map((row) => {
        const view = this.viewOf(row);
        const facts = [
          view.account ? `signed in as ${view.account}` : undefined,
          view.paused ? "paused" : undefined,
          view.renamed ? integrationRenameWords(view.renamed) : undefined,
          view.health === "needs_reauth" ? "needs a sign-in again" : undefined,
        ].filter(Boolean);
        return facts.length > 0 ? `${view.name} (${facts.join(", ")})` : view.name;
      })
      .join("; ");
  }

  /** Every integration a caller may reach, without their actions' shapes. */
  roster(): Record<string, unknown>[] {
    return [
      ...this.rows().map((row) => this.rosterEntry(row)),
      ...APP_EVENTS.map((source) => ({
        name: source.name,
        id: source.id,
        kind: "app",
        events: source.events.map((event) => event.name),
      })),
    ];
  }

  private rosterEntry(row: Row): Record<string, unknown> {
    const view = this.viewOf(row);
    return {
      name: view.name,
      id: view.id,
      connection: row.ref,
      kind: view.kind,
      ...(view.renamed ? { renamed: view.renamed } : {}),
      ...(view.account ? { account: view.account } : {}),
      health: view.health,
      ...(view.paused ? { paused: true } : {}),
      actions: view.actions.map(({ name, rule }) => ({ name, rule })),
      ...(view.events ? { events: view.events.map((event) => event.name) } : {}),
    };
  }

  /** One integration's actions with what each does and its input's JSON Schema. */
  show(name: string): Record<string, unknown> | IntegrationAnswer {
    const own = appEventSource(name);
    if (own)
      return {
        integration: own.name,
        id: own.id,
        kind: "app",
        about: "The app's own events: always there, with nothing to connect and no actions.",
        actions: [],
        events: own.events.map((spec) => eventShown(own.id, spec)),
      };
    const row = this.find(name);
    if (!("connection" in row)) return row;
    const view = this.viewOf(row);
    return {
      integration: view.name,
      id: view.id,
      connection: row.ref,
      kind: view.kind,
      ...(view.renamed ? { renamed: view.renamed } : {}),
      ...(view.account ? { account: view.account } : {}),
      health: view.health,
      ...(view.paused ? { paused: true } : {}),
      actions: row.connection.actions.map((spec) => {
        const enabled = !row.settings.off?.includes(spec.name);
        return {
          name: spec.name,
          effect: spec.effect,
          rule: integrationRule(this.allowed(row, spec), enabled),
          description: spec.description,
          input: spec.schema ?? spec.input.toJSONSchema(),
        };
      }),
      ...(row.connection.events?.length
        ? {
            events: row.connection.events.map((spec) => eventShown(view.id, spec)),
          }
        : {}),
    };
  }

  /**
   * An event a rule may listen for, by its integration's id or name and
   * the event's name; undefined when nothing connected declares it.
   */
  listenable(integration: string, event: string): IntegrationListen | undefined {
    return this.listenableIn(this.rows(), integration, event);
  }

  /**
   * Every event a rule may listen for, found as `listenable` finds one,
   * from one read of what is connected: for a caller that asks about many
   * rules at once, such as the Automation list, which would otherwise read
   * every connection once per rule. It reads at its first lookup, so a list
   * with no event rule reads nothing.
   */
  listenables(): (integration: string, event: string) => IntegrationListen | undefined {
    let rows: Row[] | undefined;
    return (integration, event) => {
      rows ??= this.rows();
      return this.listenableIn(rows, integration, event);
    };
  }

  private listenableIn(
    rows: Row[],
    integration: string,
    event: string,
  ): IntegrationListen | undefined {
    const row = this.find(integration, rows);
    if (!("connection" in row)) return undefined;
    const spec = row.connection.events?.find((entry) => entry.name === event);
    if (!spec) return undefined;
    return {
      integration: row.connection.id,
      connection: row.ref,
      name: this.rowName(row),
      event: spec.name,
      label: spec.label,
      every: spec.every,
      ...(spec.filters ? { filters: [...spec.filters] } : {}),
      ...(spec.atOnce ? { atOnce: true } : {}),
      ...(row.settings.paused ? { paused: true } : {}),
    };
  }

  async call(
    caller: IntegrationCaller,
    name: string,
    action: string,
    input: unknown,
    reason?: string,
  ): Promise<IntegrationAnswer> {
    let row = this.find(name);
    if (!("connection" in row)) return row;
    if (caller.kind === "panel") {
      const unnamed = this.panelRefusal(caller.panel, row, { action });
      if (unnamed) return unnamed;
    }
    if (row.settings.paused)
      return {
        text: `${this.viewOf(row).name} is paused. The captain resumes it in Settings → Integrations.`,
        refused: "refused",
      };
    try {
      await row.binding.prepare?.(row.connection.id);
    } catch (error) {
      return { text: this.redact(String(error)), refused: "refused" };
    }
    row = this.find(name);
    if (!("connection" in row)) return row;
    const view = this.viewOf(row);
    if (view.paused)
      return {
        text: `${view.name} is paused. The captain resumes it in Settings → Integrations.`,
        refused: "refused",
      };
    const spec = row.connection.actions.find((entry) => entry.name === action);
    if (!spec)
      return {
        text: `${view.name} has no action "${action}". Its actions: ${row.connection.actions.map((entry) => entry.name).join(", ")}.`,
        refused: "invalid",
      };
    if (row.settings.off?.includes(spec.name))
      return {
        text: `${view.name}'s action ${spec.name} is off. The captain turns it on in Settings → Integrations.`,
        refused: "refused",
      };
    const parsed = spec.input.safeParse(input ?? {});
    if (!parsed.success)
      return {
        text: `That input does not fit ${view.name}'s ${spec.name}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
          .join("; ")}.`,
        refused: "invalid",
      };
    const noFile = this.fileRefusal(caller, view.name, spec);
    if (noFile) return { text: noFile, refused: "refused" };
    if (
      !this.allowed(row, spec) &&
      !(caller.kind === "task" && this.taskAllows(caller.taskId, row, spec, parsed.data))
    )
      return this.keepAsk(
        caller,
        row,
        view.name,
        spec,
        parsed.data,
        caller.kind === "panel" ? this.panelUse(caller.panel, row)?.why : reason,
      );
    const { answer } = await this.run(row, view.name, spec.name, parsed.data, caller);
    return caller.kind === "firstmate" && spec.effect !== "reads" && !answer.refused
      ? { ...answer, ran: spec.effect }
      : answer;
  }

  /**
   * The captain's click on a kept ask's card: take it once - marked taken
   * before it runs - and run exactly what was kept, if the integration and
   * its action still allow it. Its answer comes back with every kept key
   * replaced, and it is never run again.
   */
  async sendAsk(
    taskId: string,
    askId: string,
    choice: IntegrationApprovalChoice = "once",
  ): Promise<IntegrationAskSent> {
    const taken = this.options.asks?.take(taskId, askId) ?? { refused: "nothing keeps asks here." };
    return this.sendTaken(taskId, taken, choice);
  }

  /**
   * Run an ask its owner already took, once: the first mate's ask is taken
   * from its card's row in the same transaction that closes that row
   * (INF-1108). It runs as whoever asked it.
   */
  async sendTaken(
    taskId: string,
    taken: IntegrationAskTaken,
    choice: IntegrationApprovalChoice = "once",
  ): Promise<IntegrationAskSent> {
    const asks = this.options.asks;
    if ("refused" in taken)
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why: taken.refused } };
    if (taken.ask.kind !== "integration") {
      const why = "it is a write where a project lives, not an integration's action";
      asks?.record(taskId, taken.ask.id, { kind: "refused", why });
      return { ok: false, call: "", place: "", outcome: { kind: "refused", why } };
    }
    const ask = taken.ask;
    const done = (outcome: WriteAskOutcome, answer?: string): IntegrationAskSent => {
      asks?.record(taskId, ask.id, outcome);
      return {
        ok: outcome.kind === "ran",
        ask,
        call: ask.action,
        place: ask.place,
        outcome,
        ...(answer !== undefined ? { answer } : {}),
      };
    };
    if (choice === "deny")
      return done({ kind: "refused", why: "The captain chose Not now. Nothing ran." });
    let row = this.rows().find((entry) => entry.connection.id === ask.integration);
    if (!row) return done({ kind: "refused", why: `${ask.place} is no longer connected` });
    try {
      await row.binding.prepare?.(row.connection.id);
    } catch (error) {
      return done({ kind: "refused", why: this.redact(String(error)) });
    }
    row = this.rows().find((entry) => entry.connection.id === ask.integration);
    if (!row) return done({ kind: "refused", why: `${ask.place} is no longer connected` });
    // The id alone can name a connection added after this one was removed.
    if (ask.connection === undefined)
      return done({
        kind: "refused",
        why: `it was kept before the app could tell one ${ask.place} connection from another; ask again`,
      });
    if (ask.connection !== row.ref)
      return done({
        kind: "refused",
        why: `${ask.place} was removed or replaced since it was asked; ask again`,
      });
    const view = this.viewOf(row);
    const spec = row.connection.actions.find((entry) => entry.name === ask.action);
    if (view.paused) return done({ kind: "refused", why: `${view.name} is paused` });
    if (!spec || row.settings.off?.includes(spec.name))
      return done({ kind: "refused", why: `${view.name}'s action ${ask.action} is off` });
    if (!ask.signature || ask.signature !== this.signature(spec))
      return done({
        kind: "refused",
        why: "The action changed since it was asked; call again with a reason.",
      });
    const parsed = spec.input.safeParse(JSON.parse(ask.input));
    if (!parsed.success)
      return done({ kind: "refused", why: `its input no longer fits ${view.name}'s ${spec.name}` });
    const caller: IntegrationCaller =
      ask.by === "firstmate"
        ? { kind: "firstmate" }
        : ask.by === "panel" && ask.panel
          ? // The captain's click runs exactly what was kept, as the panel that asked it.
            { kind: "panel", panel: { key: ask.panel.key, title: ask.panel.title, uses: [] } }
          : { kind: "task", taskId };
    const noFile = this.fileRefusal(caller, view.name, spec);
    if (noFile) return done({ kind: "refused", why: noFile });
    if (choice === "always") this.grant(row, spec, true);
    // Allow for the rest of this task is kept before the call runs, as Always allow is.
    const allowance =
      choice === "task" && caller.kind === "task"
        ? this.allowForTask(taskId, row, spec, ask)
        : undefined;
    const { answer, unknown } = await this.run(row, view.name, spec.name, parsed.data, caller);
    const sent = unknown
      ? done({ kind: "unknown", why: answer.text })
      : answer.refused
        ? done({ kind: "refused", why: answer.text })
        : done({ kind: "ran" }, answer.text);
    return allowance ? { ...sent, allowance } : sent;
  }

  /**
   * Keep the captain's Allow for the rest of this task for the ask's task
   * (INF-2993), bound to what ends Always allow; undefined when the ask
   * carries no scope or nothing keeps allowances here, so the click ran it
   * once.
   */
  private allowForTask(
    taskId: string,
    row: Row,
    spec: IntegrationActionSpec,
    ask: IntegrationAsk,
  ): IntegrationAllowance | undefined {
    const allow = this.options.asks?.allow;
    if (!allow || !ask.scope) return undefined;
    const allowance: IntegrationAllowance = {
      connection: row.ref,
      action: spec.name,
      signature: this.signature(spec),
      scope: ask.scope.key,
      words: ask.scope.words,
      mark: this.ruleMark(row, spec),
      at: (this.options.now ?? Date.now)(),
      card: `integration-ask-${ask.id}`,
    };
    allow(taskId, allowance);
    return allowance;
  }

  /**
   * Whether the task's crewmate may run this call without a card: an
   * allowance of the open task covers the same connection, action, scope and
   * signature, chosen under the action's current rule mark (INF-2993).
   */
  private taskAllows(taskId: string, row: Row, spec: IntegrationActionSpec, input: unknown) {
    const scope = this.scopeOf(spec, input);
    const signature = this.signature(spec);
    const mark = this.ruleMark(row, spec);
    return (this.options.asks?.allowances?.(taskId) ?? []).some(
      (allowance) =>
        allowance.connection === row.ref &&
        allowance.action === spec.name &&
        allowance.signature === signature &&
        allowance.mark === mark &&
        allowance.scope === scope.key,
    );
  }

  /** What one allowance would cover for this checked input. */
  private scopeOf(spec: IntegrationActionSpec, input: unknown): IntegrationScope {
    return spec.scope ? spec.scope(input) : WHOLE_ACTION;
  }

  /** The action's rule mark now; empty until its rule or switch first changes. */
  private ruleMark(row: Row, spec: IntegrationActionSpec): string {
    return this.options.store.ruleMarks()[row.ref]?.[spec.name] ?? "";
  }

  /**
   * A key typed into an integration's row. No kind keeps one any more: a
   * sign-in keeps its key in Secrets (docs/integrations.md, "Keys"), so
   * every slot is refused and nothing is written.
   */
  setSecret(id: string, slot: string, _value: string | null): IntegrationsView {
    const row = this.byId(id);
    throw new IntegrationRefusal(`${this.viewOf(row).name} has no key named ${slot}.`);
  }

  /** Text with every key a kind holds in memory replaced, for whatever leaves the service. */
  private redact(text: string): string {
    return this.options.bindings.reduce((out, binding) => binding.redact?.(out) ?? out, text);
  }

  /**
   * Run one action through its binding; its answer leaves with every kept
   * key replaced. `unknown` says it failed after the request left, so what
   * came of it is not known.
   */
  private async run(
    row: Row,
    name: string,
    action: string,
    input: unknown,
    caller: IntegrationCaller,
  ): Promise<{ answer: IntegrationAnswer; unknown?: true }> {
    const redact = (text: string) => this.redact(text);
    try {
      const called = await row.binding.call(row.connection.id, action, input, caller);
      const { file: delivered, ...answer } = called;
      if (delivered && !answer.refused) answer.text = await this.saveFile(row, caller, delivered);
      const text = redact(answer.text);
      const label = answer.refused ? undefined : row.binding.fence;
      return {
        answer: { ...answer, text: label ? fencedAnswer(text, this.fence(label, caller)) : text },
      };
    } catch (error) {
      return {
        answer: {
          text: redact(
            error instanceof IntegrationOutcomeUnknown
              ? `${name}'s ${action} has an unknown outcome: ${error.message}
Do not repeat this call; read ${name} to check what happened first.`
              : `${name} could not do that: ${error instanceof Error ? error.message : String(error)}`,
          ),
          refused: "refused",
        },
        ...(error instanceof IntegrationOutcomeUnknown ? { unknown: true as const } : {}),
      };
    }
  }

  /**
   * Why an action that delivers a file cannot run for this caller: the
   * first mate has no folder to save into, and a task's computer may need
   * an update first. Undefined for every other action.
   */
  private fileRefusal(
    caller: IntegrationCaller,
    name: string,
    spec: IntegrationActionSpec,
  ): string | undefined {
    if (spec.delivers !== "file") return undefined;
    if (caller.kind === "firstmate")
      return `Not run: ${name}'s ${spec.name} saves a file into a task's hand-over folder, so only a crewmate can call it. Start a crewmate whose brief names the call and its reason.`;
    if (caller.kind === "panel")
      return `Not run: ${name}'s ${spec.name} saves a file into a task's hand-over folder, so only a crewmate can call it.`;
    if (!this.options.files) return `Not run: ${name}'s ${spec.name} cannot save files here.`;
    const refusal = this.options.files.refusal(caller.taskId);
    return refusal ? `Not run: ${refusal}` : undefined;
  }

  /**
   * Saves a delivered file into the calling task's hand-over folder and
   * answers what the caller reads in its place: its name, type, size and
   * path, never its bytes. The file goes when its kind's words do
   * (`SavedOutsideData`), or with the task's folder at its close.
   */
  private async saveFile(
    row: Row,
    caller: IntegrationCaller,
    file: NonNullable<IntegrationAnswer["file"]>,
  ): Promise<string> {
    const files = this.options.files;
    if (caller.kind !== "task" || !files)
      throw new Error("only a task's crewmate can save a file.");
    const saved = await files.save(caller.taskId, file.name, file.bytes);
    const label = row.binding.fence;
    if (label)
      this.options.reads?.saved?.(
        caller.taskId,
        saved.file,
        label,
        (this.options.now ?? Date.now)(),
      );
    return JSON.stringify({
      name: file.name,
      ...(file.type ? { type: file.type } : {}),
      size: file.bytes.length,
      path: saved.path,
    });
  }

  /**
   * The host keeps the exact call and presents its own card (INF-950): on
   * the caller's task, or for the first mate or a panel on the row the host
   * files for that card (INF-1108). A panel's reason is its manifest's why.
   */
  private keepAsk(
    caller: IntegrationCaller,
    row: Row,
    name: string,
    spec: IntegrationActionSpec,
    input: unknown,
    reason?: string,
  ): IntegrationAnswer {
    const asks = this.options.asks;
    const firstmate = caller.kind === "firstmate";
    if (
      !asks ||
      (firstmate && !asks.keepForFirstmate) ||
      (caller.kind === "panel" && !asks.keepForPanel)
    )
      return {
        text:
          caller.kind === "panel"
            ? `Not run: ${name}'s ${spec.name} asks the captain, and panels cannot ask here.`
            : `Not run: ${name}'s ${spec.name} asks the captain. Start a crewmate whose brief names the call and its reason.`,
        refused: "refused",
      };
    if (typeof reason !== "string" || !reason.trim())
      return {
        text: `Not run: ${name}'s ${spec.name} asks the captain. Call again with ${firstmate ? "reason" : "--reason"} explaining why this action is needed.`,
        refused: "invalid",
      };
    const ask: IntegrationAsk = {
      id: `ia${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: "integration",
      ...(firstmate ? { by: "firstmate" as const } : {}),
      ...(caller.kind === "panel"
        ? {
            by: "panel" as const,
            panel: { key: caller.panel.key, title: caller.panel.title },
          }
        : {}),
      integration: row.connection.id,
      connection: row.ref,
      place: name,
      action: spec.name,
      label: spec.label,
      description: spec.description,
      effect: spec.effect,
      signature: this.signature(spec),
      reason,
      input: JSON.stringify(input),
      ...(caller.kind === "task" ? { scope: this.scopeOf(spec, input) } : {}),
      at: (this.options.now ?? Date.now)(),
    };
    let card: string | undefined;
    let joined = false;
    try {
      if (caller.kind === "task") {
        const dropped = asks.keep(caller.taskId, ask) ?? [];
        joined = asks.present?.(caller.taskId, ask, dropped) === true;
      } else if (caller.kind === "panel") {
        const kept = asks.keepForPanel?.(ask);
        if (kept && "held" in kept)
          return {
            text:
              kept.held === "asking"
                ? `Not run: ${name}'s ${spec.name} waits for the captain's answer on its approval card. Always allow lets the panel's later calls run.`
                : `Not run: the captain chose Not now for ${name}'s ${spec.name}. The panel's line offers Ask again.`,
            refused: "refused",
          };
        return {
          text: `Not run: ${name}'s ${spec.name} asks the captain. The app raised its approval card for ask ${ask.id}: allowing it runs this call, and Always allow lets the panel's later calls run.`,
          refused: "refused",
        };
      } else {
        card = asks.keepForFirstmate?.(ask);
      }
    } catch (error) {
      return {
        text: `Not run: ${name}'s ${spec.name} asks the captain, and the app could not keep the call: ${error instanceof Error ? error.message : String(error)}`,
        refused: "refused",
      };
    }
    return {
      text: `Not run: ${name}'s ${spec.name} asks the captain. ${joined ? `The app added ask ${ask.id} to the approval card already waiting for your asks to ${name}.` : `The app raised its approval card for ask ${ask.id}.`} Do not emit another card or repeat the call. You will hear the outcome once through write-answered.`,
      refused: "refused",
      ...(card ? { card } : {}),
    };
  }

  /**
   * The entry of a panel's manifest that names this row: the connection it
   * names by name, id or reference is the row's (docs/integrations.md,
   * "Names"), so a rename in Settings never strands it.
   */
  private panelUse(panel: PanelCaller, row: Row): PanelIntegrationUse | undefined {
    return panel.uses.find((use) => {
      const named = this.find(use.integration);
      return "connection" in named && named.connection.id === row.connection.id;
    });
  }

  /**
   * Why a panel may not reach this row, action or event: its manifest names
   * neither. Undefined when it does. One wording, the lint's too.
   */
  private panelRefusal(
    panel: PanelCaller,
    row: Row,
    what?: { action: string } | { event: string },
  ): IntegrationAnswer | undefined {
    const use = this.panelUse(panel, row);
    const name = this.viewOf(row).name;
    if (!use) return { text: undeclaredIntegrationMessage(name), refused: "refused" };
    if (what && "action" in what && !use.actions?.includes(what.action))
      return { text: undeclaredIntegrationMessage(name, what), refused: "refused" };
    if (what && "event" in what && !use.events?.includes(what.event))
      return { text: undeclaredIntegrationMessage(name, what), refused: "refused" };
    return undefined;
  }

  /**
   * One panel's reach (docs/integrations.md, "Panels"): the connections its
   * manifest names, with only the actions and events it names, the same
   * answers every caller gets, and its calls under each action's own rule.
   */
  forPanel(panel: PanelCaller): PanelIntegrationsReach {
    const caller: IntegrationCaller = { kind: "panel", panel };
    const narrowed = (row: Row) => {
      const use = this.panelUse(panel, row);
      return use
        ? { actions: new Set(use.actions ?? []), events: new Set(use.events ?? []) }
        : undefined;
    };
    return {
      list: () =>
        this.rows().flatMap((row) => {
          const use = narrowed(row);
          if (!use) return [];
          const entry = this.rosterEntry(row);
          return [
            {
              ...entry,
              actions: (entry.actions as { name: string }[]).filter((action) =>
                use.actions.has(action.name),
              ),
              ...(entry.events
                ? { events: (entry.events as string[]).filter((event) => use.events.has(event)) }
                : {}),
            },
          ];
        }),
      show: (name) => {
        const row = this.find(name);
        if (!("connection" in row)) return row;
        const unnamed = this.panelRefusal(panel, row);
        if (unnamed) return unnamed;
        const use = narrowed(row);
        const shown = this.show(name);
        if (isIntegrationAnswer(shown) || !use) return shown;
        const { keys: _keys, ...rest } = shown;
        return {
          ...rest,
          actions: (shown.actions as { name: string }[]).filter((action) =>
            use.actions.has(action.name),
          ),
          ...(shown.events
            ? {
                events: (shown.events as { name: string; listen?: string }[])
                  .filter((event) => use.events.has(event.name))
                  .map(({ listen: _listen, ...event }) => event),
              }
            : {}),
        };
      },
      call: (name, action, input) => this.call(caller, name, action, input),
      look: async (name, event, cursor) => {
        const row = this.find(name);
        if (!("connection" in row)) return row;
        const unnamed = this.panelRefusal(panel, row, { event });
        if (unnamed) return unnamed;
        try {
          return await this.look(row.connection.id, event, cursor, undefined, row.ref, caller);
        } catch (error) {
          return {
            text: this.redact(error instanceof Error ? error.message : String(error)),
            refused: "refused",
          };
        }
      },
      every: (name, event) => {
        const row = this.find(name);
        if (!("connection" in row) || this.panelRefusal(panel, row, { event })) return undefined;
        return row.connection.events?.find((spec) => spec.name === event)?.every;
      },
    };
  }

  /** Bind a grant to what the tool says it does, including MCP's read-only mark. */
  private signature(spec: IntegrationActionSpec): string {
    return JSON.stringify([spec.description, spec.effect]);
  }

  private allowed(row: Row, spec: IntegrationActionSpec): boolean {
    return this.options.store.approvals()[row.ref]?.[spec.name] === this.signature(spec);
  }

  private grant(row: Row, spec: IntegrationActionSpec, allowed: boolean): void {
    const all = this.options.store.approvals();
    const actions = all[row.ref] ?? {};
    if (allowed) actions[spec.name] = this.signature(spec);
    else delete actions[spec.name];
    if (Object.keys(actions).length) all[row.ref] = actions;
    else delete all[row.ref];
    this.options.store.writeApprovals(all);
    // Any change of the rule or the switch ends Allow for the rest of this task (INF-2993).
    const marks = this.options.store.ruleMarks();
    marks[row.ref] = { ...(marks[row.ref] ?? {}), [spec.name]: randomUUID() };
    this.options.store.writeRuleMarks(marks);
    this.changed();
  }

  /** Captain-only action-catalog setting, separate from agents' rename/pause changes. */
  setRule(id: string, action: string, allowed: boolean): IntegrationsView {
    const row = this.byId(id);
    const spec = row.connection.actions.find((entry) => entry.name === action);
    if (!spec) throw new IntegrationRefusal(`${this.viewOf(row).name} has no action ${action}.`);
    this.grant(row, spec, allowed);
    return this.view();
  }

  /** What one task's crewmate reaches: every integration, under that task's rules. */
  forTask(taskId: string): TaskIntegrations {
    return {
      list: async () => this.roster(),
      show: async (name) => this.show(name),
      call: (name, action, input, _signal, reason) =>
        this.call({ kind: "task", taskId }, name, action, input, reason),
    };
  }

  /**
   * Add a connection of a kind the person adds from their own words (an
   * MCP server): the binding connects, and the new row shows what it found.
   */
  async add(kind: IntegrationKind, input: { name: string } & Record<string, unknown>) {
    const binding = this.options.bindings.find((entry) => entry.kind === kind);
    if (!binding?.add)
      throw new IntegrationRefusal(
        `${INTEGRATION_KIND_NAMES[kind]} is connected by signing in, not added from a form.`,
      );
    // The name and the id are held before the place is asked, so an addition
    // or a sign-in that overlaps this one cannot take either (INF-948).
    this.assertNameFree(input.name);
    const by = Symbol(kind);
    this.claim(input.name, kind, by);
    let id: string;
    try {
      id = await binding.add(input, (candidate) => {
        if (this.holder(candidate) || !integrationIdSchema.safeParse(candidate).success)
          return false;
        this.claim(candidate, kind, by);
        return true;
      });
    } catch (error) {
      throw new IntegrationRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      this.release(by);
    }
    return { id, view: this.changed() };
  }

  /**
   * Sign in to a kind that signs in in the person's browser (Google): the
   * binding opens the page and waits for it to come back, and the new row
   * shows who it is. A second sign-in ends the first, and so does
   * `cancelSignIn`; an ended one throws words. A kind with a notice
   * (`INTEGRATION_NOTICES`, INF-949) signs in only with the person's accept
   * of it: without one, nothing opens, nothing waiting ends, and nothing is
   * asked of the kind.
   */
  async signIn(
    kind: IntegrationKind,
    consent?: IntegrationSignInConsent,
  ): Promise<{ id: string; view: IntegrationsView }> {
    const binding = this.options.bindings.find((entry) => entry.kind === kind);
    if (!binding?.signIn)
      throw new IntegrationRefusal(
        `${INTEGRATION_KIND_NAMES[kind]} is not signed in to from here in this version of the app.`,
      );
    if (INTEGRATION_NOTICES[kind] && consent?.noticeAccepted !== true)
      throw new IntegrationRefusal(integrationNoticeRefusal(INTEGRATION_KIND_NAMES[kind]));
    // Two rows never share a name: the row keeps its name, or a new one takes
    // its kind's, so another row under that name stops the sign-in before the
    // browser opens and before any key is kept.
    const kindName = INTEGRATION_KIND_NAMES[kind];
    const own = this.rows().find((row) => row.binding.kind === kind);
    const name = own ? this.viewOf(own).name : kindName;
    const holder = this.holder(name, { kind });
    if (holder && "row" in holder) {
      const held = INTEGRATION_KIND_NAMES[holder.row.binding.kind];
      throw new IntegrationRefusal(
        `The ${held} named ${this.viewOf(holder.row).name} already uses that name, so ${kindName} cannot be added beside it. Remove that ${held} in Settings → Integrations, or ask your first mate to rename it, then sign in to ${kindName} again.`,
      );
    }
    if (holder)
      throw new IntegrationRefusal(
        "claim" in holder
          ? `An integration named ${name} is being added, so ${kindName} cannot be added beside it until that ends. Then sign in to ${kindName} again.`
          : "app" in holder
            ? `${name} names the app's own ${holder.app} events, so ${kindName} cannot be added under it.`
            : `${name} belongs to your ${holder.reserved} connection, so ${kindName} cannot be added under it.`,
      );
    this.signingIn?.abort();
    const controller = new AbortController();
    this.signingIn = controller;
    // The name is held while the browser is open; a sign-in this one ends lets go of its own.
    const by = Symbol(kind);
    this.claim(name, kind, by);
    try {
      const id = await binding.signIn(controller.signal);
      return { id, view: this.changed() };
    } catch (error) {
      if (controller.signal.aborted) throw new IntegrationRefusal("The sign-in was cancelled.");
      throw new IntegrationRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      this.release(by);
      if (this.signingIn === controller) this.signingIn = undefined;
    }
  }

  cancelSignIn(): void {
    this.signingIn?.abort();
    this.signingIn = undefined;
  }

  /**
   * Look for one of an integration's events since the cursor
   * (`IntegrationBinding.look`); with `connection`, only while the id
   * still stands for that connection.
   */
  async look(
    id: string,
    event: string,
    cursor: string | null,
    filter?: Record<string, string>,
    connection?: string,
    reader: IntegrationCaller = { kind: "firstmate" },
  ): Promise<IntegrationLook> {
    const row = this.byId(id);
    const view = this.viewOf(row);
    if (connection !== undefined && connection !== row.ref)
      throw new IntegrationRefusal(
        `${view.name} was removed or replaced since the rule was saved.`,
      );
    if (view.paused) throw new IntegrationRefusal(`${view.name} is paused.`);
    const names = (row.connection.events ?? []).map((spec) => spec.name);
    if (!row.binding.look || !names.includes(event))
      throw new IntegrationRefusal(
        names.length > 0
          ? `${view.name} has no event "${event}". Its events: ${names.join(", ")}.`
          : `${view.name} tells of nothing.`,
      );
    const fields = row.connection.events?.find((spec) => spec.name === event)?.filters ?? [];
    if (Object.keys(filter ?? {}).some((key) => !fields.some((field) => field.name === key)))
      throw new IntegrationRefusal("This event does not declare that filter.");
    const look = await row.binding.look(row.connection.id, event, cursor, filter);
    const label = row.binding.fence;
    if (!label) return look;
    // A rule's events reach the first mate; a panel's, that panel; a hold's
    // rule's, its task. A rule's run also keeps a copy in Automation's
    // history, which the first mate's pass cleans, so that is noted too.
    if (reader.kind === "task" && look.items.length > 0)
      this.options.reads?.note(FIRSTMATE_READER, (this.options.now ?? Date.now)());
    return {
      ...look,
      items: look.items.map((item) => ({
        ...item,
        summary: fenced(item.summary, this.fence(label, reader)),
      })),
    };
  }

  /**
   * A fresh fence for one answer or summary of a kind whose words anyone
   * can write (`IntegrationBinding.fence`): a random value nobody who wrote
   * them could know, and the moment they were read, noted against the
   * conversation that receives them so they go when due (`OutsideReads`).
   */
  private fence(label: string, reader: IntegrationCaller): Fence {
    const at = (this.options.now ?? Date.now)();
    if (reader.kind === "panel") this.options.panelReads?.(reader.panel.key, label, at);
    else this.options.reads?.note(reader.kind === "task" ? reader.taskId : FIRSTMATE_READER, at);
    return { label, value: randomBytes(FENCE_VALUE_BYTES).toString("hex"), at };
  }

  /** Each fenced kind kept for a while, and for how long (`IntegrationBinding.kept`). */
  kept(): KeptOutsideData[] {
    return this.options.bindings.flatMap(({ fence, kept }) =>
      fence && kept ? [{ label: fence, days: kept.days, what: kept.what }] : [],
    );
  }

  /**
   * The names a call reached each kept kind by before its words were
   * fenced: its identity, its connections' ids and their names now
   * (`LegacyCalls`).
   */
  legacyCalls(): LegacyCalls[] {
    const settings = this.options.store.read();
    return this.options.bindings.flatMap((binding) => {
      if (!binding.fence || !binding.kept) return [];
      const ids = [
        ...(binding.identity ? [binding.identity.id] : []),
        ...binding.connections().map((connection) => connection.id),
      ];
      const names = new Set([
        ...ids,
        ...(binding.identity ? [binding.identity.name] : []),
        ...ids.flatMap((id) => settings[id]?.name ?? []),
      ]);
      return [{ label: binding.fence, names: [...names] }];
    });
  }

  /** Stop whatever a binding started, as the app quits. */
  async dispose(): Promise<void> {
    this.cancelSignIn();
    await Promise.all(this.options.bindings.map((binding) => binding.close?.()));
  }

  configure(id: string, patch: IntegrationSettingsPatch): IntegrationsView {
    const row = this.byId(id);
    const all = this.options.store.read();
    const next: IntegrationSettings = { ...(all[id] ?? {}) };
    if (patch.name !== undefined) {
      // A reset is a rename to the default name, checked the same way (INF-938).
      const name = patch.name ?? this.defaultName(row);
      this.assertNameFree(name, id);
      if (name === this.defaultName(row)) delete next.name;
      else next.name = name;
      delete next.renamed;
    }
    if (patch.paused !== undefined) {
      if (patch.paused) next.paused = true;
      else delete next.paused;
    }
    if (patch.actions) {
      const known = new Set(row.connection.actions.map((spec) => spec.name));
      const unknown = Object.keys(patch.actions).filter((name) => !known.has(name));
      if (unknown.length > 0)
        throw new IntegrationRefusal(
          `${this.viewOf(row).name} has no action ${unknown.join(", ")}. Its actions: ${[...known].join(", ")}.`,
        );
      const off = new Set(next.off ?? []);
      for (const [name, on] of Object.entries(patch.actions)) {
        const spec = row.connection.actions.find((entry) => entry.name === name);
        if (spec && on !== !off.has(name)) this.grant(row, spec, false);
        if (on) off.delete(name);
        else off.add(name);
      }
      if (off.size > 0) next.off = [...off].sort();
      else delete next.off;
    }
    if (Object.keys(next).length > 0) all[id] = next;
    else delete all[id];
    this.options.store.write(all);
    return this.changed();
  }

  /**
   * Forget the connection's sign-in and its settings. The binding first
   * tells the place to forget it where it can (Google's revocation), and
   * the row goes whatever the place answered.
   */
  async remove(id: string): Promise<IntegrationsView> {
    const row = this.byId(id);
    try {
      await row.binding.remove(row.connection.id);
    } catch (error) {
      console.warn(
        `[integrations] ${id} could not be signed out where it lives; forgetting it here: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const all = this.options.store.read();
    if (all[id]) {
      delete all[id];
      this.options.store.write(all);
    }
    // A connection added later under the same id is another one.
    const refs = this.options.store.connections();
    if (refs[id]) {
      delete refs[id];
      this.options.store.writeConnections(refs);
    }
    return this.changed();
  }

  /** Ask the place now, and show its answer as the row's health. */
  async check(id: string): Promise<IntegrationsView> {
    const row = this.byId(id);
    await row.binding.check(row.connection.id);
    return this.changed();
  }

  /** Something a row reads changed (a sign-in, its health): push the whole view. */
  changed(): IntegrationsView {
    const view = this.view();
    this.options.push?.(view);
    return view;
  }

  private rows(): Row[] {
    const settings = this.options.store.read();
    const order = integrationKindSchema.options;
    const rows = [...this.options.bindings]
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      .flatMap((binding) =>
        binding.connections().map((connection) => ({
          binding,
          connection,
          settings: settings[connection.id] ?? {},
          ref: "",
        })),
      );
    this.repairNames(rows, settings);
    this.referenceConnections(rows);
    // Forget invalidated grants, not just ignore them: changing a tool back must ask again.
    const all = this.options.store.approvals();
    const valid: Record<string, Record<string, string>> = {};
    for (const row of rows)
      for (const spec of row.connection.actions) {
        if (all[row.ref]?.[spec.name] === this.signature(spec)) {
          const actions = valid[row.ref] ?? {};
          actions[spec.name] = this.signature(spec);
          valid[row.ref] = actions;
        }
      }
    if (JSON.stringify(all) !== JSON.stringify(valid)) this.options.store.writeApprovals(valid);
    return rows;
  }

  /**
   * Which connection each id stands for (docs/integrations.md, "Which
   * connection"), so a kept request or rule never follows a reused id to
   * another connection (INF-947). A connection first seen gets a new
   * reference; a rename or a renewal keeps it, and a removal through this
   * service forgets it. A connection that answers for an account other
   * than the one it was first signed in as is another connection.
   */
  private referenceConnections(rows: Row[]): void {
    const refs = this.options.store.connections();
    let changed = false;
    for (const row of rows) {
      const { id, account } = row.connection;
      const known = refs[id];
      if (!known || (known.account !== null && account !== null && known.account !== account)) {
        refs[id] = { ref: `c-${randomUUID()}`, account };
        changed = true;
      } else if (known.account === null && account !== null) {
        refs[id] = { ...known, account };
        changed = true;
      }
      row.ref = refs[id]?.ref ?? "";
    }
    if (changed) this.options.store.writeConnections(refs);
  }

  /**
   * Every name a row shows is its own (docs/integrations.md, "Names"). A
   * sign-in can arrive outside this service, and an older version saved
   * clashes this one refuses, so old clashes are repaired before any view,
   * roster or lookup escapes, including the first read after a restart and
   * while signed out. INF-882 and INF-946: the captain chose automatic
   * distinct naming with an explanation, never blocking a sign-in. A name
   * declared by a binding's identity stays with it; otherwise a name stays
   * with the row whose id comes first, and an id stays with its row. Only
   * names change; ids and references keep asks, events, keys and settings
   * attached.
   */
  private repairNames(rows: Row[], settings: Record<string, IntegrationSettings>): void {
    const held = new Map<string, { id: string; owner: string }>();
    for (const entry of this.reservedNames(settings))
      if (!held.has(this.nameKey(entry.name)))
        held.set(this.nameKey(entry.name), { id: entry.id, owner: entry.owner });
    for (const row of rows)
      if (!held.has(this.nameKey(row.connection.id)))
        held.set(this.nameKey(row.connection.id), {
          id: row.connection.id,
          owner: this.rowName(row),
        });
    const used = new Set([...held.keys(), ...rows.map((row) => this.nameKey(this.rowName(row)))]);
    let changed = false;
    // The order a binding lists its rows in never decides who keeps a name.
    const byId = [...rows].sort((a, b) => (a.connection.id < b.connection.id ? -1 : 1));
    for (const row of byId) {
      const from = this.rowName(row);
      const holder = held.get(this.nameKey(from));
      if (!holder) {
        held.set(this.nameKey(from), { id: row.connection.id, owner: from });
        continue;
      }
      if (holder.id === row.connection.id) continue;
      const holderKind = rows.find((entry) => entry.connection.id === holder.id)?.binding.kind;
      // The kind tells two kinds apart; the id tells two of one kind apart.
      const base =
        holderKind === row.binding.kind
          ? `${from} (${row.connection.id})`
          : `${from} ${INTEGRATION_KIND_NAMES[row.binding.kind]}`;
      let name: string;
      let number = 1;
      do {
        const suffix = number === 1 ? "" : ` ${number}`;
        name = `${base.slice(0, (integrationNameSchema.maxLength ?? base.length) - suffix.length)}${suffix}`;
        number++;
      } while (used.has(this.nameKey(name)));
      used.add(this.nameKey(name));
      held.set(this.nameKey(name), { id: row.connection.id, owner: name });
      row.settings = { ...row.settings, name, renamed: { from, for: holder.owner } };
      settings[row.connection.id] = row.settings;
      changed = true;
    }
    if (changed) this.options.store.write(settings);
  }

  /** The permanent identity and saved name of each binding that declares one. */
  private reservedNames(settings = this.options.store.read()) {
    return this.options.bindings.flatMap(({ identity, kind }) => {
      if (!identity) return [];
      return [identity.id, identity.name, settings[identity.id]?.name ?? identity.name].map(
        (name) => ({ id: identity.id, kind, name, owner: identity.name }),
      );
    });
  }

  private nameKey(name: string): string {
    return name.trim().toLowerCase();
  }

  private rowName(row: Row): string {
    return row.settings.name ?? this.defaultName(row);
  }

  private viewOf(row: Row): IntegrationView {
    return {
      id: row.connection.id,
      kind: row.binding.kind,
      ...(row.connection.host ? { host: row.connection.host } : {}),
      name: this.rowName(row),
      ...(row.settings.renamed ? { renamed: row.settings.renamed } : {}),
      account: row.connection.account,
      health: row.connection.health,
      paused: row.settings.paused === true,
      ...(row.connection.runs !== undefined ? { runs: row.connection.runs } : {}),
      ...(row.connection.door ? { door: row.connection.door } : {}),
      actions: row.connection.actions.map((spec) => {
        const enabled = !row.settings.off?.includes(spec.name);
        return {
          name: spec.name,
          label: spec.label,
          effect: spec.effect,
          enabled,
          rule: integrationRule(this.allowed(row, spec), enabled),
        };
      }),
      ...(row.connection.events?.length ? { events: row.connection.events.map(eventView) } : {}),
    };
  }

  /** A row's name until the person renames it. */
  private defaultName(row: Row): string {
    return row.connection.name ?? INTEGRATION_KIND_NAMES[row.binding.kind];
  }

  /**
   * Who holds a name or an id now, in the one compared form: a row's id or
   * name, an addition or sign-in waiting for its place, or a binding's
   * identity while signed out. `except` leaves out a row's own id, or every
   * holder of one kind (a sign-in replacing its own row or an earlier try).
   */
  private holder(
    name: string,
    except?: { id?: string; kind?: IntegrationKind },
  ): Holder | undefined {
    const wanted = this.nameKey(name);
    const rows = this.rows().filter(
      (entry) => entry.connection.id !== except?.id && entry.binding.kind !== except?.kind,
    );
    const named = rows.find((entry) => this.nameKey(this.rowName(entry)) === wanted);
    if (named) return { row: named };
    const claim = this.claims.get(wanted);
    if (claim && claim.kind !== except?.kind) return { claim: claim.kind };
    // The app's own event sources are named like integrations (`APP_EVENTS`).
    const app = appEventSource(name);
    if (app) return { app: app.name };
    const reserved = this.reservedNames().find(
      (entry) =>
        entry.id !== except?.id &&
        entry.kind !== except?.kind &&
        this.nameKey(entry.name) === wanted,
    );
    if (reserved)
      return {
        reserved: reserved.owner,
        signedOut: !rows.some((entry) => entry.connection.id === reserved.id),
      };
    const byId = rows.find((entry) => entry.connection.id === wanted);
    return byId ? { row: byId } : undefined;
  }

  /** Two holders never share a name: a name is how the crew and the first mate reach one. */
  private assertNameFree(name: string, except?: string): void {
    if (CONNECTION_REF.test(name.trim()))
      throw new IntegrationRefusal(
        `${name.trim()} reads as a connection's reference, which the app gives. Choose another name.`,
      );
    const holder = this.holder(name, { id: except });
    if (!holder) return;
    if ("row" in holder)
      throw new IntegrationRefusal(
        `An integration is already named ${this.viewOf(holder.row).name}. Choose another name.`,
      );
    if ("claim" in holder)
      throw new IntegrationRefusal(
        `An integration named ${name.trim()} is being added. Choose another name.`,
      );
    if ("app" in holder)
      throw new IntegrationRefusal(
        `${name.trim()} names the app's own ${holder.app} events. Choose another name.`,
      );
    throw new IntegrationRefusal(
      `${name.trim()} belongs to your ${holder.reserved} connection${holder.signedOut ? ", even while signed out" : ""}. Choose another name.`,
    );
  }

  /** Hold a name or an id for one addition or sign-in until it lets go. */
  private claim(name: string, kind: IntegrationKind, by: symbol): void {
    this.claims.set(this.nameKey(name), { kind, by });
  }

  private release(by: symbol): void {
    for (const [key, claim] of this.claims) if (claim.by === by) this.claims.delete(key);
  }

  /**
   * The row a caller means (docs/integrations.md, "Names"). A connection's
   * reference reaches only that connection, and one removed or replaced is
   * refused, never looked up again as a name. Anything else is a name or an
   * id in any case, reaching a row only when exactly one answers to it.
   */
  private find(name: string, rows: Row[] = this.rows()): Row | IntegrationAnswer {
    const wanted = name.trim();
    if (CONNECTION_REF.test(wanted)) {
      const row = rows.find((entry) => entry.ref === wanted);
      if (row) return row;
      return {
        text: `No integration is connection ${wanted} now: it was removed or replaced. List the integrations again and use one's connection or name.`,
        refused: "invalid",
      };
    }
    const key = this.nameKey(wanted);
    const matches = rows.filter(
      (row) => row.connection.id === key || this.nameKey(this.rowName(row)) === key,
    );
    const [only, ...more] = matches;
    if (!only) return this.unknown(name, rows);
    if (more.length === 0) return only;
    return {
      text: `"${wanted}" could mean ${matches.map((row) => `${this.viewOf(row).name} (connection ${row.ref})`).join(" or ")}. Use one's connection.`,
      refused: "invalid",
    };
  }

  private byId(id: string): Row {
    const row = this.rows().find((entry) => entry.connection.id === id);
    if (!row) throw new IntegrationRefusal(this.unknown(id).text);
    return row;
  }

  private unknown(name: string, rows: Row[] = this.rows()): IntegrationAnswer {
    const names = rows.map((row) => this.rowName(row));
    return {
      text:
        names.length > 0
          ? `No integration named "${name}". Connected: ${names.join(", ")}.`
          : `No integration named "${name}": nothing is connected. The captain connects one in Settings → Integrations.`,
      refused: "invalid",
    };
  }
}

/** An event as Settings reads it. */
function eventView(spec: IntegrationEventSpec): IntegrationEventView {
  return {
    name: spec.name,
    label: spec.label,
    every: spec.every,
    ...(spec.filters
      ? {
          filters: spec.filters.map((field) => ({
            name: field.name,
            label: field.label,
            ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
          })),
        }
      : {}),
  };
}

/** An event as the integrations tool shows it, with how a rule listens to it. */
function eventShown(id: string, spec: IntegrationEventSpec): Record<string, unknown> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    ...(spec.filters ? { filters: spec.filters } : {}),
    looks: spec.every === 1 ? "every minute" : `every ${spec.every} minutes`,
    listen: `schedule_prompt on_event "${id}/${spec.name}": it runs as new ones arrive, their summaries at {{events}} in its prompt or after it`,
  };
}
