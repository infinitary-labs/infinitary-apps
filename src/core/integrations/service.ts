import { randomBytes, randomUUID } from "node:crypto";
import {
  INTEGRATION_KIND_NAMES,
  INTEGRATION_NOTICES,
  type IntegrationApprovalChoice,
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
import type { KeptOutsideData } from "@shared/savedOutsideData";
import type { IntegrationAsk, WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import type { LegacyCalls } from "../storage/outsideDataScrub";
import {
  type IntegrationActionSpec,
  type IntegrationAnswer,
  type IntegrationBinding,
  type IntegrationCaller,
  type IntegrationConnection,
  type IntegrationLook,
  IntegrationOutcomeUnknown,
} from "./binding";
import { FIRSTMATE_READER } from "./outsideReads";
import type { IntegrationSecrets } from "./secrets";
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
  /** The keys the kinds sign in with: the bridge now, the secret manager later. */
  secrets: IntegrationSecrets;
  /**
   * A task's unapproved action is kept with its reason and exact input;
   * the host presents its card and the captain's choice takes it once.
   */
  asks?: IntegrationAskStore;
  /**
   * Which conversation received fenced words, and when (`OutsideReads`):
   * a call's caller, and the first mate for a rule's events.
   */
  reads?: { note: (reader: string, at: number) => void };
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

/** Where a task's asks are kept: the task's own write asks. */
export type IntegrationAskStore = {
  keep: (taskId: string, ask: IntegrationAsk) => void;
  present?: (taskId: string, ask: IntegrationAsk) => void;
  take: (taskId: string, askId: string) => { ask: WriteAsk } | { refused: string };
  record: (taskId: string, askId: string, outcome: WriteAskOutcome) => void;
};

/** What the captain's click on a kept integration ask did. */
export type IntegrationAskSent = {
  ok: boolean;
  ask?: IntegrationAsk;
  /** The action's name, as it was kept. */
  call: string;
  place: string;
  outcome: WriteAskOutcome;
  answer?: string;
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
  /** Its name as the person reads it. */
  name: string;
  event: string;
  label: string;
  /** How often the app looks, in the tick's minutes. */
  every: number;
  filters?: readonly { name: string; label: string; defaultValue?: string }[];
};

/** A connection's reference as `referenceConnections` gives it. */
const CONNECTION_REF = /^c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What holds a name now (`IntegrationsService.holder`). */
type Holder = { row: Row } | { claim: IntegrationKind } | { reserved: string; signedOut: boolean };

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

  view(): IntegrationsView {
    const rows = this.rows();
    const connected = new Set(rows.map((row) => row.binding.kind));
    return {
      integrations: rows.map((row) => this.viewOf(row)),
      addable: this.options.bindings
        .filter((binding) => binding.many || !connected.has(binding.kind))
        .map((binding) => ({ kind: binding.kind, name: INTEGRATION_KIND_NAMES[binding.kind] })),
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
          this.missingKeys(row).length > 0 ? "needs a key entered in Settings" : undefined,
        ].filter(Boolean);
        return facts.length > 0 ? `${view.name} (${facts.join(", ")})` : view.name;
      })
      .join("; ");
  }

  /** Every integration a caller may reach, without their actions' shapes. */
  roster(): Record<string, unknown>[] {
    return this.rows().map((row) => {
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
    });
  }

  /** One integration's actions with what each does and its input's JSON Schema. */
  show(name: string): Record<string, unknown> | IntegrationAnswer {
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
      // Which keys are kept, never a value: one entered in Settings is used, never shown.
      ...(view.secrets
        ? { keys: view.secrets.map((slot) => ({ name: slot.label, kept: slot.kept })) }
        : {}),
      ...(row.connection.events?.length
        ? {
            events: row.connection.events.map((spec) => ({
              name: spec.name,
              label: spec.label,
              description: spec.description,
              ...(spec.filters ? { filters: spec.filters } : {}),
              looks: spec.every === 1 ? "every minute" : `every ${spec.every} minutes`,
              listen: `schedule_prompt on_event "${view.id}/${spec.name}": it runs as new ones arrive, their summaries at {{events}} in its prompt or after it`,
            })),
          }
        : {}),
    };
  }

  /**
   * An event a rule may listen for, by its integration's id or name and
   * the event's name; undefined when nothing connected declares it.
   */
  listenable(integration: string, event: string): IntegrationListen | undefined {
    const row = this.find(integration);
    if (!("connection" in row)) return undefined;
    const spec = row.connection.events?.find((entry) => entry.name === event);
    if (!spec) return undefined;
    return {
      integration: row.connection.id,
      connection: row.ref,
      name: this.viewOf(row).name,
      event: spec.name,
      label: spec.label,
      every: spec.every,
      ...(spec.filters ? { filters: [...spec.filters] } : {}),
    };
  }

  /** Run one action for a caller, after the integration's settings and the action's input. */
  async call(
    caller: IntegrationCaller,
    name: string,
    action: string,
    input: unknown,
    reason?: string,
  ): Promise<IntegrationAnswer> {
    let row = this.find(name);
    if (!("connection" in row)) return row;
    if (row.settings.paused)
      return {
        text: `${this.viewOf(row).name} is paused. The captain resumes it in Settings → Integrations.`,
        refused: "refused",
      };
    try {
      await row.binding.prepare?.(row.connection.id);
    } catch (error) {
      return { text: this.options.secrets.redact(String(error)), refused: "refused" };
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
    const missing = this.missingKeys(row);
    if (missing.length > 0)
      return {
        text: `${view.name} needs ${missing.join(" and ")} before it can do anything. The captain enters it in Settings → Integrations; never ask for it in a message, a card or a task.`,
        refused: "refused",
      };
    // Piece 1 preserves the first mate's existing read-only reach; its own
    // host-filed approval tasks are the continuation, not a task-less write path.
    if (!this.allowed(row, spec) || (caller.kind === "firstmate" && spec.effect !== "reads"))
      return this.keepAsk(caller, row, view.name, spec, parsed.data, reason);
    return (await this.run(row, view.name, spec.name, parsed.data, caller)).answer;
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
    const asks = this.options.asks;
    const taken = asks?.take(taskId, askId) ?? { refused: "nothing keeps asks here." };
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
      return done({ kind: "refused", why: this.options.secrets.redact(String(error)) });
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
    const missing = this.missingKeys(row);
    if (missing.length > 0)
      return done({ kind: "refused", why: `${view.name} needs ${missing.join(" and ")}` });
    const parsed = spec.input.safeParse(JSON.parse(ask.input));
    if (!parsed.success)
      return done({ kind: "refused", why: `its input no longer fits ${view.name}'s ${spec.name}` });
    if (choice === "always") this.grant(row, spec, true);
    const { answer, unknown } = await this.run(row, view.name, spec.name, parsed.data, {
      kind: "task",
      taskId,
    });
    if (unknown) return done({ kind: "unknown", why: answer.text });
    return answer.refused
      ? done({ kind: "refused", why: answer.text })
      : done({ kind: "ran" }, answer.text);
  }

  /** Keep a value the captain entered for a slot, or forget it with null. */
  setSecret(id: string, slot: string, value: string | null): IntegrationsView {
    const row = this.byId(id);
    const name = this.viewOf(row).name;
    if (!(row.binding.secrets ?? []).some((entry) => entry.name === slot))
      throw new IntegrationRefusal(
        `${name} has no key named ${slot}.${row.binding.secrets?.length ? ` Its keys: ${row.binding.secrets.map((entry) => entry.name).join(", ")}.` : ""}`,
      );
    if (value === null) this.options.secrets.forget(row.connection.id, slot);
    else this.options.secrets.put(row.connection.id, slot, value);
    return this.changed();
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
    const redact = (text: string) => this.options.secrets.redact(text);
    try {
      const answer = await row.binding.call(row.connection.id, action, input, caller);
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

  /** The host keeps the exact call and presents its own card (INF-950). */
  private keepAsk(
    caller: IntegrationCaller,
    row: Row,
    name: string,
    spec: IntegrationActionSpec,
    input: unknown,
    reason?: string,
  ): IntegrationAnswer {
    if (caller.kind !== "task" || !this.options.asks)
      return {
        text: `Not run: ${name}'s ${spec.name} asks the captain. Start a crewmate whose brief names the call and its reason.`,
        refused: "refused",
      };
    if (typeof reason !== "string" || !reason.trim())
      return {
        text: `Not run: ${name}'s ${spec.name} asks the captain. Call again with --reason explaining why this action is needed.`,
        refused: "invalid",
      };
    const ask: IntegrationAsk = {
      id: `ia${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: "integration",
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
      at: (this.options.now ?? Date.now)(),
    };
    this.options.asks.keep(caller.taskId, ask);
    this.options.asks.present?.(caller.taskId, ask);
    return {
      text: `Not run: ${name}'s ${spec.name} asks the captain. The app raised its approval card for ask ${ask.id}. Do not emit another card or repeat the call. You will hear the outcome once through write-answered.`,
      refused: "refused",
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

  /** The required slots of a row that hold no value, by their words. */
  private missingKeys(row: Row): string[] {
    const kept = new Set(this.options.secrets.kept(row.connection.id));
    return (row.binding.secrets ?? [])
      .filter((slot) => !slot.optional && !kept.has(slot.name))
      .map((slot) => slot.label);
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

  /** End the sign-in waiting for the browser, if one is. */
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
    // A rule's events reach the first mate.
    const reader: IntegrationCaller = { kind: "firstmate" };
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
    this.options.reads?.note(reader.kind === "task" ? reader.taskId : FIRSTMATE_READER, at);
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

  /** Rename, pause or resume, or turn actions on or off. */
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
    this.options.secrets.forget(row.connection.id);
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
      ...(row.connection.events?.length
        ? {
            events: row.connection.events.map((spec) => ({
              name: spec.name,
              label: spec.label,
              every: spec.every,
              ...(spec.filters ? { filters: [...spec.filters] } : {}),
            })),
          }
        : {}),
      ...this.secretsOf(row),
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

  /** A row's keys, kept or not; nothing when its kind declares none. */
  private secretsOf(row: Row): Pick<IntegrationView, "secrets"> {
    const slots = row.binding.secrets ?? [];
    if (slots.length === 0) return {};
    const kept = new Set(this.options.secrets.kept(row.connection.id));
    return {
      secrets: slots.map((slot) => ({
        name: slot.name,
        label: slot.label,
        kept: kept.has(slot.name),
        ...(slot.optional ? { optional: true } : {}),
      })),
    };
  }

  /**
   * The row a caller means (docs/integrations.md, "Names"). A connection's
   * reference reaches only that connection, and one removed or replaced is
   * refused, never looked up again as a name. Anything else is a name or an
   * id in any case, reaching a row only when exactly one answers to it.
   */
  private find(name: string): Row | IntegrationAnswer {
    const rows = this.rows();
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
    if (!only) return this.unknown(name);
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

  private unknown(name: string): IntegrationAnswer {
    const names = this.rows().map((row) => this.viewOf(row).name);
    return {
      text:
        names.length > 0
          ? `No integration named "${name}". Connected: ${names.join(", ")}.`
          : `No integration named "${name}": nothing is connected. The captain connects one in Settings → Integrations.`,
      refused: "invalid",
    };
  }
}
