import { randomUUID } from "node:crypto";
import {
  INTEGRATION_KIND_NAMES,
  type IntegrationSettingsPatch,
  type IntegrationsView,
  type IntegrationView,
  integrationKindSchema,
  integrationRule,
} from "@shared/integrations";
import type { IntegrationAsk, WriteAsk, WriteAskOutcome } from "@shared/writeAsk";
import type {
  IntegrationAnswer,
  IntegrationBinding,
  IntegrationCaller,
  IntegrationConnection,
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

/** One task's reach, as its crewmate's command asks it (`infinitary-integrations-axi`). */
export type TaskIntegrations = {
  list: () => Record<string, unknown>[];
  show: (name: string) => Record<string, unknown> | IntegrationAnswer;
  call: (name: string, action: string, input: unknown) => Promise<IntegrationAnswer>;
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

/** A refusal the catalog line's caller reads as the reason. */
export class IntegrationRefusal extends Error {}

export class IntegrationsService {
  constructor(private readonly options: IntegrationsServiceOptions) {}

  view(): IntegrationsView {
    const rows = this.rows();
    const connected = new Set(rows.map((row) => row.binding.kind));
    return {
      integrations: rows.map((row) => this.viewOf(row)),
      addable: this.options.bindings
        .filter((binding) => !connected.has(binding.kind))
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
        account: view.account ?? "not read yet",
        health: view.health,
        ...(view.paused ? { paused: true } : {}),
        actions: view.actions.filter((action) => action.enabled).map((action) => action.name),
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
      account: view.account ?? "not read yet",
      health: view.health,
      ...(view.paused ? { paused: true } : {}),
      actions: row.binding.actions.map((spec) => {
        const enabled = !row.settings.off?.includes(spec.name);
        return {
          name: spec.name,
          effect: spec.effect,
          rule: integrationRule(spec.effect, enabled),
          description: spec.description,
          input: spec.input.toJSONSchema(),
        };
      }),
      // Which keys are kept, never a value: one entered in Settings is used, never shown.
      ...(view.secrets
        ? { keys: view.secrets.map((slot) => ({ name: slot.label, kept: slot.kept })) }
        : {}),
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
    const spec = row.binding.actions.find((entry) => entry.name === action);
    if (!spec)
      return {
        text: `${view.name} has no action "${action}". Its actions: ${row.binding.actions.map((entry) => entry.name).join(", ")}.`,
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
    return this.run(row, view.name, spec.name, parsed.data, caller);
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
    const spec = row.binding.actions.find((entry) => entry.name === ask.action);
    if (view.paused) return done({ kind: "refused", why: `${view.name} is paused` });
    if (!spec || row.settings.off?.includes(spec.name))
      return done({ kind: "refused", why: `${view.name}'s action ${ask.action} is off` });
    const missing = this.missingKeys(row);
    if (missing.length > 0)
      return done({ kind: "refused", why: `${view.name} needs ${missing.join(" and ")}` });
    const parsed = spec.input.safeParse(JSON.parse(ask.input));
    if (!parsed.success)
      return done({ kind: "refused", why: `its input no longer fits ${view.name}'s ${spec.name}` });
    const answer = await this.run(row, view.name, spec.name, parsed.data, {
      kind: "task",
      taskId,
    });
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

  /** Run one action through its binding; its answer leaves with every kept key replaced. */
  private async run(
    row: Row,
    name: string,
    action: string,
    input: unknown,
    caller: IntegrationCaller,
  ): Promise<IntegrationAnswer> {
    const redact = (text: string) => this.options.secrets.redact(text);
    try {
      const answer = await row.binding.call(row.connection.id, action, input, caller);
      return { ...answer, text: redact(answer.text) };
    } catch (error) {
      return {
        text: redact(
          `${name} could not do that: ${error instanceof Error ? error.message : String(error)}`,
        ),
        refused: "refused",
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
      list: () => this.roster(),
      show: (name) => this.show(name),
      call: (name, action, input) => this.call({ kind: "task", taskId }, name, action, input),
    };
  }

  /** Rename, pause or resume, or turn actions on or off. */
  configure(id: string, patch: IntegrationSettingsPatch): IntegrationsView {
    const row = this.byId(id);
    const all = this.options.store.read();
    const next: IntegrationSettings = { ...(all[id] ?? {}) };
    if (patch.name !== undefined) {
      if (patch.name === null || patch.name === INTEGRATION_KIND_NAMES[row.binding.kind])
        delete next.name;
      else next.name = patch.name;
    }
    if (patch.paused !== undefined) {
      if (patch.paused) next.paused = true;
      else delete next.paused;
    }
    if (patch.actions) {
      const known = new Set(row.binding.actions.map((spec) => spec.name));
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

  /** Forget the connection's sign-in and its settings. */
  remove(id: string): IntegrationsView {
    const row = this.byId(id);
    row.binding.remove(row.connection.id);
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
    return [...this.options.bindings]
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      .flatMap((binding) =>
        binding.connections().map((connection) => ({
          binding,
          connection,
          settings: settings[connection.id] ?? {},
        })),
      );
  }

  private viewOf(row: Row): IntegrationView {
    return {
      id: row.connection.id,
      kind: row.binding.kind,
      name: row.settings.name ?? INTEGRATION_KIND_NAMES[row.binding.kind],
      account: row.connection.account,
      health: row.connection.health,
      paused: row.settings.paused === true,
      actions: row.binding.actions.map((spec) => {
        const enabled = !row.settings.off?.includes(spec.name);
        return {
          name: spec.name,
          label: spec.label,
          effect: spec.effect,
          enabled,
          rule: integrationRule(spec.effect, enabled),
        };
      }),
      ...this.secretsOf(row),
    };
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
      (row) => row.connection.id === wanted || this.viewOf(row).name.toLowerCase() === wanted,
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
