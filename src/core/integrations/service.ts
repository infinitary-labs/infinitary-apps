import { randomUUID } from "node:crypto";
import {
  INTEGRATION_KIND_NAMES,
  type IntegrationKind,
  type IntegrationSettingsPatch,
  type IntegrationsView,
  type IntegrationView,
  integrationKindSchema,
  integrationNameSchema,
  integrationRenameWords,
  integrationRule,
} from "@shared/integrations";
import type { IntegrationAsk, WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import {
  type IntegrationAnswer,
  type IntegrationBinding,
  type IntegrationCaller,
  type IntegrationConnection,
  type IntegrationLook,
  IntegrationOutcomeUnknown,
} from "./binding";
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
   * A task's asks (docs/integrations.md, "The rules"): an action that
   * changes or sends is kept on the caller's task as a write ask, and the
   * captain's click on its card takes it once (`TaskService`).
   */
  asks?: IntegrationAskStore;
  now?: () => number;
  /** The whole view, after every change (`inf:integrations`). */
  push?: (view: IntegrationsView) => void;
};

/** A connection with its kind's binding and its settings. */
type Row = {
  binding: IntegrationBinding;
  connection: IntegrationConnection;
  settings: IntegrationSettings;
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
  ) => Promise<IntegrationAnswer>;
};

/** Where a task's asks are kept: the task's own write asks. */
export type IntegrationAskStore = {
  keep: (taskId: string, ask: IntegrationAsk) => void;
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
  /** Its name as the person reads it. */
  name: string;
  event: string;
  label: string;
  /** How often the app looks, in the tick's minutes. */
  every: number;
  filters?: readonly { name: string; label: string; defaultValue?: string }[];
};

/** A refusal the catalog line's caller reads as the reason. */
export class IntegrationRefusal extends Error {}

export class IntegrationsService {
  /** The sign-in waiting for the person's browser, at most one at a time. */
  private signingIn: AbortController | undefined;

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
        kind: view.kind,
        ...(view.renamed ? { renamed: view.renamed } : {}),
        ...(view.account ? { account: view.account } : {}),
        health: view.health,
        ...(view.paused ? { paused: true } : {}),
        actions: view.actions.filter((action) => action.enabled).map((action) => action.name),
        ...(view.events ? { events: view.events.map((event) => event.name) } : {}),
      };
    });
  }

  /** One integration's actions with what each does and its input's JSON Schema. */
  show(name: string): Record<string, unknown> | IntegrationAnswer {
    const row = this.find(name);
    if (!row) return this.unknown(name);
    const view = this.viewOf(row);
    return {
      integration: view.name,
      id: view.id,
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
          rule: integrationRule(spec.effect, enabled),
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
    const spec = row?.connection.events?.find((entry) => entry.name === event);
    if (!row || !spec) return undefined;
    return {
      integration: row.connection.id,
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
  ): Promise<IntegrationAnswer> {
    const row = this.find(name);
    if (!row) return this.unknown(name);
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
    if (spec.effect !== "reads" && !row.binding.keepsAsks)
      return this.keepAsk(caller, row, view.name, spec.name, parsed.data);
    return (await this.run(row, view.name, spec.name, parsed.data, caller)).answer;
  }

  /**
   * The captain's click on a kept ask's card: take it once - marked taken
   * before it runs - and run exactly what was kept, if the integration and
   * its action still allow it. Its answer comes back with every kept key
   * replaced, and it is never run again.
   */
  async sendAsk(taskId: string, askId: string): Promise<IntegrationAskSent> {
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
    const row = this.rows().find((entry) => entry.connection.id === ask.integration);
    if (!row) return done({ kind: "refused", why: `${ask.place} is no longer connected` });
    const view = this.viewOf(row);
    const spec = row.connection.actions.find((entry) => entry.name === ask.action);
    if (view.paused) return done({ kind: "refused", why: `${view.name} is paused` });
    if (!spec || row.settings.off?.includes(spec.name))
      return done({ kind: "refused", why: `${view.name}'s action ${ask.action} is off` });
    const missing = this.missingKeys(row);
    if (missing.length > 0)
      return done({ kind: "refused", why: `${view.name} needs ${missing.join(" and ")}` });
    const parsed = spec.input.safeParse(JSON.parse(ask.input));
    if (!parsed.success)
      return done({ kind: "refused", why: `its input no longer fits ${view.name}'s ${spec.name}` });
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
      return { answer: { ...answer, text: redact(answer.text) } };
    } catch (error) {
      return {
        answer: {
          text: redact(
            `${name} could not do that: ${error instanceof Error ? error.message : String(error)}`,
          ),
          refused: "refused",
        },
        ...(error instanceof IntegrationOutcomeUnknown ? { unknown: true as const } : {}),
      };
    }
  }

  /**
   * An action that changes or sends asks the captain on a card (the
   * captain's q5 on INF-775): a task's is kept with its exact input, and
   * the first mate, which has no task to keep it on, starts a crewmate.
   */
  private keepAsk(
    caller: IntegrationCaller,
    row: Row,
    name: string,
    action: string,
    input: unknown,
  ): IntegrationAnswer {
    if (caller.kind !== "task" || !this.options.asks)
      return {
        text: `Not run: ${name}'s ${action} changes something outside, so it asks the captain on a card, and only a crewmate's card can carry the exact call. Start a crewmate whose brief names the call.`,
        refused: "refused",
      };
    const ask: IntegrationAsk = {
      id: `ia${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: "integration",
      integration: row.connection.id,
      place: name,
      action,
      input: JSON.stringify(input),
      at: (this.options.now ?? Date.now)(),
    };
    this.options.asks.keep(caller.taskId, ask);
    return {
      text: [
        `Not run: ${name}'s ${action} changes something outside, so it asks the captain. Kept as ask ${ask.id}: ${action} on ${name}.`,
        `To ask, emit_card with one action whose effect is {"kind":"request_write","ask":"${ask.id}"} and no label - the app adds the exact call and names the button - beside your own Not now, and say in the body why it is needed.`,
        "Only the captain's click runs it, once, and you then hear its answer. Never run it another way.",
      ].join("\n"),
      // Kept is not run: the command exits 1 with these words (INF-824).
      refused: "refused",
    };
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
      call: (name, action, input) => this.call({ kind: "task", taskId }, name, action, input),
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
    this.assertNameFree(input.name);
    let id: string;
    try {
      id = await binding.add(input);
    } catch (error) {
      throw new IntegrationRefusal(error instanceof Error ? error.message : String(error));
    }
    return { id, view: this.changed() };
  }

  /**
   * Sign in to a kind that signs in in the person's browser (Google): the
   * binding opens the page and waits for it to come back, and the new row
   * shows who it is. A second sign-in ends the first, and so does
   * `cancelSignIn`; an ended one throws words.
   */
  async signIn(kind: IntegrationKind): Promise<{ id: string; view: IntegrationsView }> {
    const binding = this.options.bindings.find((entry) => entry.kind === kind);
    if (!binding?.signIn)
      throw new IntegrationRefusal(
        `${INTEGRATION_KIND_NAMES[kind]} is not signed in to from here in this version of the app.`,
      );
    // Two rows never share a name: the row keeps its name, or a new one takes
    // its kind's, so another row under that name stops the sign-in before the
    // browser opens and before any key is kept.
    const kindName = INTEGRATION_KIND_NAMES[kind];
    const own = this.rows().find((row) => row.binding.kind === kind);
    const name = own ? this.viewOf(own).name : kindName;
    const holder = this.holderOf(name, (row) => row.binding.kind === kind);
    if (holder) {
      const held = INTEGRATION_KIND_NAMES[holder.binding.kind];
      throw new IntegrationRefusal(
        `The ${held} named ${this.viewOf(holder).name} already uses that name, so ${kindName} cannot be added beside it. Remove that ${held} in Settings → Integrations, or ask your first mate to rename it, then sign in to ${kindName} again.`,
      );
    }
    this.signingIn?.abort();
    const controller = new AbortController();
    this.signingIn = controller;
    try {
      const id = await binding.signIn(controller.signal);
      return { id, view: this.changed() };
    } catch (error) {
      if (controller.signal.aborted) throw new IntegrationRefusal("The sign-in was cancelled.");
      throw new IntegrationRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.signingIn === controller) this.signingIn = undefined;
    }
  }

  /** End the sign-in waiting for the browser, if one is. */
  cancelSignIn(): void {
    this.signingIn?.abort();
    this.signingIn = undefined;
  }

  /** Look for one of an integration's events since the cursor (`IntegrationBinding.look`). */
  async look(
    id: string,
    event: string,
    cursor: string | null,
    filter?: Record<string, string>,
  ): Promise<IntegrationLook> {
    const row = this.byId(id);
    const view = this.viewOf(row);
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
    return row.binding.look(row.connection.id, event, cursor, filter);
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
      const name = patch.name ?? this.defaultName(row);
      if (name === this.defaultName(row)) {
        this.assertReservedNameFree(name, id);
        delete next.name;
      } else {
        this.assertNameFree(name, id);
        next.name = name;
      }
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
        })),
      );
    this.repairReservedNames(rows, settings);
    return rows;
  }

  /**
   * A sign-in can arrive outside this service. Repair old clashes before
   * any view, roster or lookup escapes, including the first read after a
   * restart and while signed out. INF-882: the captain chose automatic
   * distinct naming with an explanation, never blocking project sign-in.
   * Only names change; ids keep asks, events, keys and settings attached.
   */
  private repairReservedNames(rows: Row[], settings: Record<string, IntegrationSettings>): void {
    const reserved = this.reservedNames(settings);
    const used = new Set([
      ...reserved.map((entry) => this.nameKey(entry.name)),
      ...rows.flatMap((row) => [row.connection.id, this.nameKey(this.rowName(row))]),
    ]);
    let changed = false;
    for (const row of rows) {
      const from = this.rowName(row);
      const owner = reserved.find(
        (entry) =>
          entry.id !== row.connection.id && this.nameKey(entry.name) === this.nameKey(from),
      );
      if (!owner) continue;
      const base = `${from} ${INTEGRATION_KIND_NAMES[row.binding.kind]}`;
      let name: string;
      let number = 1;
      do {
        const suffix = number === 1 ? "" : ` ${number}`;
        name = `${base.slice(0, (integrationNameSchema.maxLength ?? base.length) - suffix.length)}${suffix}`;
        number++;
      } while (used.has(this.nameKey(name)));
      used.add(this.nameKey(name));
      row.settings = { ...row.settings, name, renamed: { from, for: owner.owner } };
      settings[row.connection.id] = row.settings;
      changed = true;
    }
    if (changed) this.options.store.write(settings);
  }

  /** The permanent identity and saved name of each binding that declares one. */
  private reservedNames(settings = this.options.store.read()) {
    return this.options.bindings.flatMap(({ identity }) => {
      if (!identity) return [];
      return [identity.id, identity.name, settings[identity.id]?.name ?? identity.name].map(
        (name) => ({ id: identity.id, name, owner: identity.name }),
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
          rule: integrationRule(spec.effect, enabled),
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

  /** A declared connection keeps its identity even while signed out. */
  private assertReservedNameFree(name: string, except?: string): void {
    const reserved = this.reservedNames().find(
      (entry) => entry.id !== except && this.nameKey(entry.name) === this.nameKey(name),
    );
    if (reserved)
      throw new IntegrationRefusal(
        `${name.trim()} belongs to your ${reserved.owner} connection, even while signed out. Choose another name.`,
      );
  }

  /** Two rows never share a name: a name is how the crew and the first mate reach one. */
  private assertNameFree(name: string, except?: string): void {
    this.assertReservedNameFree(name, except);
    const taken = this.holderOf(name, (row) => row.connection.id === except);
    if (taken)
      throw new IntegrationRefusal(
        `An integration is already named ${this.viewOf(taken).name}. Choose another name.`,
      );
  }

  /** The row a name already reaches, by its id or its name in any case, besides the rows `except` names. */
  private holderOf(name: string, except: (row: Row) => boolean): Row | undefined {
    const wanted = name.trim().toLowerCase();
    return this.rows().find(
      (row) =>
        !except(row) &&
        (row.connection.id === wanted || this.nameKey(this.rowName(row)) === wanted),
    );
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

  /** A row by its id or its name, in any case. */
  private find(name: string): Row | undefined {
    const wanted = name.trim().toLowerCase();
    return this.rows().find(
      (row) => row.connection.id === wanted || this.nameKey(this.rowName(row)) === wanted,
    );
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
