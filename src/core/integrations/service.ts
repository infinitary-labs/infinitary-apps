import {
  INTEGRATION_KIND_NAMES,
  type IntegrationSettingsPatch,
  type IntegrationsView,
  type IntegrationView,
  integrationKindSchema,
  integrationRule,
} from "@shared/integrations";
import type {
  IntegrationAnswer,
  IntegrationBinding,
  IntegrationCaller,
  IntegrationConnection,
} from "./binding";
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
    try {
      return await row.binding.call(row.connection.id, spec.name, parsed.data, caller);
    } catch (error) {
      return {
        text: `${view.name} could not do that: ${error instanceof Error ? error.message : String(error)}`,
        refused: "refused",
      };
    }
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
