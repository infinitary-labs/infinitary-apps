import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ACTIONS, type ActionActor, type ActionName, runsOnDoneSaid } from "@shared/actions";
import { type RepoView, repoConfiguredEvent } from "@shared/repos";
import type { CoreServices } from "../coreServices";

/** The captain's settled-run window (docs/orchestrator-contract.md). */
export const SETTLE_MS = 10_000;

export type SettingStep = { target: string; from: unknown; to: unknown };

/** Records catalog changes and settles consecutive captain settings. */
export function createActionTrail(
  services: CoreServices,
  options: {
    onActionRecorded?: (id: string, action: ActionName, value: Record<string, unknown>) => void;
  },
) {
  /**
   * The captain's open settled run (docs/orchestrator-contract.md, "Settled
   * runs"): one setting - a catalog action and its target - changed by the
   * captain, `from` its state before the run's first step, `at` the newest
   * step, written as one Activity line and one operation.
   */
  let openRun: {
    id: string;
    name: ActionName;
    target: string;
    from: unknown;
    at: number;
    operationId: string;
  } | null = null;

  /**
   * The open run a step on this setting continues: the captain's own, on the
   * same setting, within SETTLE_MS of its last step, while its line is still
   * Activity's newest and its operation is still on the record.
   */
  function runOf(name: ActionName, target: string, actor: ActionActor) {
    const run = openRun;
    if (actor.kind !== "captain" || !run || run.name !== name || run.target !== target) return null;
    if (services.ticker.now() - run.at > SETTLE_MS) return null;
    if (services.activityRun() !== run.id || !services.tasks.get(run.operationId)) return null;
    return run;
  }

  /**
   * The captain's step on a setting (docs/orchestrator-contract.md, "Settled
   * runs"): the run's first step writes its line and operation, a later one
   * rewrites both in place, and a run back where it started withdraws both.
   */
  function settle(name: ActionName, value: Record<string, unknown>, step: SettingStep): void {
    const run = runOf(name, step.target, { kind: "captain" });
    const from = (run ? run.from : step.from) as Record<string, unknown>;
    const text = ACTIONS[name].settled?.(from, value) ?? ACTIONS[name].done(value);
    const at = services.ticker.now();
    if (run && isDeepStrictEqual(run.from, step.to)) {
      openRun = null;
      services.tasks.archive.withdrawOperation(run.operationId);
      services.broadcastEvent({
        type: "personalized",
        text,
        actor: "captain",
        run: { id: run.id, withdrawn: true },
      });
      return;
    }
    if (run) {
      run.at = at;
      services.tasks.capture.reviseOperation(run.operationId, { title: text, outcome: text });
      services.broadcastEvent({
        type: "personalized",
        text,
        actor: "captain",
        run: { id: run.id },
      });
      return;
    }
    const row = services.tasks.capture.fileOperation({
      id: randomUUID().slice(0, 8),
      title: text,
      outcome: text,
      tool: "app_change",
      actor: "captain",
    });
    openRun = {
      id: randomUUID(),
      name,
      target: step.target,
      from: step.from,
      at,
      operationId: row.id,
    };
    services.broadcastEvent({
      type: "personalized",
      text,
      actor: "captain",
      run: { id: openRun.id },
    });
  }

  function trail(
    name: ActionName,
    value: Record<string, unknown>,
    actor: ActionActor,
    step?: SettingStep,
  ): void {
    if (step && actor.kind === "captain") {
      settle(name, value, step);
      return;
    }
    const text = ACTIONS[name].done(value);
    const row = services.tasks.capture.fileOperation({
      id: randomUUID().slice(0, 8),
      title:
        name === "project-settings" ||
        name === "project-runs-on" ||
        name === "project-setup" ||
        name === "project-remove"
          ? name === "project-setup"
            ? `Set up project ${(value.repo as RepoView).name}`
            : name === "project-remove"
              ? `Removed project ${(value.repo as RepoView).name}`
              : `Changed settings for project ${(value.repo as RepoView).name}`
          : text,
      outcome: text,
      tool: "app_change",
      actor: actor.kind,
      ...(name === "project-settings" ||
      name === "project-runs-on" ||
      name === "project-setup" ||
      name === "project-remove"
        ? { repoId: (value.repo as RepoView).id }
        : {}),
    });
    if (actor.kind === "firstmate") options.onActionRecorded?.(row.id, name, value);
    if (name === "project-remove") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_unregistered",
        repoId: repo.id,
        name: repo.name,
        actor: actor.kind,
      });
    } else if (name === "project-setup") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_setup",
        repoId: repo.id,
        name: repo.name,
        path: repo.path,
        kind: repo.setupKind,
        actor: actor.kind,
      });
    } else if (name === "project-settings")
      services.broadcastEvent({
        ...repoConfiguredEvent(value.repo as RepoView),
        ...(value.description ? { description: value.description as string } : {}),
        actor: actor.kind,
      });
    else if (name === "project-runs-on") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_runs_on",
        repoId: repo.id,
        name: repo.name,
        runsOn: repo.runsOn,
        text,
        said: runsOnDoneSaid(value),
        actor: actor.kind,
      });
    } else services.broadcastEvent({ type: "personalized", text, actor: actor.kind });
  }

  return { runOf, trail };
}
