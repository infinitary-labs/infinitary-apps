import { isDeepStrictEqual } from "node:util";
import type { AccountView } from "@shared/accounts";
import {
  ACTION_NAMES,
  ACTIONS,
  type ActionActor,
  type ActionName,
  actionRefusal,
  integrationSignInValue,
} from "@shared/actions";
import type { PastCard } from "@shared/cards";
import { projectCostChange } from "@shared/costLimit";
import { CREATE_PANEL_SLOT_ID } from "@shared/createPanelSlot";
import {
  type CoreInvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  invokeContract,
  parseInvokeRequest,
  type WorkInvokeChannel,
} from "@shared/ipc";
import {
  arrangePanels,
  defaultArrangement,
  knownPanels,
  movedPanels,
  panelSlot,
  sameArrangement,
} from "@shared/panelArrangement";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { Layout } from "@shared/preferences";
import type { RepoPolicyPatch, RepoSetupResult, RepoView } from "@shared/repos";
import type { RunbookView } from "@shared/runbooks";
import { devicePlace } from "@shared/signIns";
import type { AppPanelGates } from "@shared/surfaces";
import { addedPrivateSite } from "../browser/privateSites";
import type { CoreServices } from "../coreServices";
import { actionValue } from "../pi/appTools";
import { listSurfaces, type SurfaceView } from "../pi/personalizeTool";
import { CHANGES_THERE } from "./accountHandlers";
import { accountTrail } from "./accountTrail";
import type { createActionTrail } from "./actionTrail";

/**
 * The gates open now, for the app panels that wait on one: Knowledge's while
 * this build keeps knowledge and there is some to show.
 */
function gatesOf(services: CoreServices): AppPanelGates {
  return {
    knowledge: services.knowledge?.held() ?? false,
    automation: services.scheduler.rules().length > 0,
  };
}

/** Each core request's handler, by channel, as `createCoreDispatcher` builds them. */
export type CoreHandlers = {
  [C in Exclude<CoreInvokeChannel, WorkInvokeChannel>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

/**
 * One catalog change, run (primitives/app-actions.md, "Operations and
 * lifecycle"): it checks the actor, parses the request, reads the value
 * before, runs the handler and, for an applied change, writes its trail line.
 * `createCoreDispatcher` answers every other request and orders these calls.
 */
export function createCatalogDispatch({
  services,
  handlers,
  runOf,
  trail,
  automation,
}: {
  services: CoreServices;
  handlers: CoreHandlers;
  runOf: ReturnType<typeof createActionTrail>["runOf"];
  trail: ReturnType<typeof createActionTrail>["trail"];
  /** What the Scheduler said of this change, set by the automation handlers. */
  automation: { said: string | undefined };
}) {
  const dispatch = async <C extends Exclude<CoreInvokeChannel, WorkInvokeChannel>>(
    channel: C,
    rawArgs: unknown,
    actor: ActionActor = { kind: "captain" },
  ): Promise<InvokeResponse<C>> => {
    if (actor.kind === "firstmate" && invokeContract[channel].effect === "change") {
      const line = actor.action && ACTIONS[actor.action];
      if (!line || line.change !== channel)
        throw new Error("The first mate cannot run an operation outside its action catalog.");
      if (
        actor.action === "project-settings" &&
        (rawArgs as [string, RepoPolicyPatch])[1]?.origin !== undefined
      )
        throw new Error("Where a project lives changes only on the app’s exact-change card.");
      const refusal = actionRefusal(line, actor);
      if (refusal) throw new Error(refusal);
    }
    const args = parseInvokeRequest(channel, rawArgs);
    const handler = handlers[channel] as (
      ...handlerArgs: InvokeRequest<C>
    ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
    const names = ACTION_NAMES.filter(
      (name) =>
        ACTIONS[name].change === channel ||
        (ACTIONS[name].alwaysTrail && ACTIONS[name].channels?.includes(channel)),
    );
    const before = new Map<ActionName, unknown>();
    for (const name of names)
      before.set(
        name,
        ACTIONS[name].current
          ? await handlers[ACTIONS[name].current as keyof CoreHandlers]()
          : null,
      );
    // A change to a computer that runs work's own account or project sign-in
    // is read from what that computer says, not this Mac's.
    const thereAt = CHANGES_THERE[channel];
    const at = thereAt !== undefined ? args[thereAt] : undefined;
    // The computer, as the request names it: by id, or as its options' `deviceId`.
    const named = typeof at === "string" ? at : (at as { deviceId?: unknown } | null)?.deviceId;
    const there = typeof named === "string" ? named : undefined;
    const stateThere = (name: ActionName) => {
      const said = there ? services.deviceSignIns.lastSaid(there) : null;
      return name === "forge-sign-out"
        ? (said?.forges ?? { signIns: [], hosts: [] })
        : (said?.accounts ?? []);
    };
    const whereThere = there ? services.deviceSignIns.placeOf(there)?.where : undefined;
    if (there) for (const name of names) before.set(name, stateThere(name));
    if (actor.kind === "captain" && actor.projectBefore !== undefined) {
      const current = before.get(names[0] as ActionName);
      const previous = (current as RepoView[]).find((repo) => repo.id === args[0]);
      if (!isDeepStrictEqual(previous, actor.projectBefore))
        throw new Error("The project changed since this card was written. Ask for a new card.");
    }
    if (actor.kind === "firstmate" && names.length) {
      if (!actor.action) throw new Error("Name the catalog action.");
      const old = before.get(actor.action);
      const next = args[0];
      if (
        channel === "inf:accounts:remove" &&
        !there &&
        args[0] === (services.firstmate.boundAccount() ?? services.settings.getFirstmateAccount())
      )
        throw new Error("The first mate cannot disconnect the account it is running on.");
      const fields = ACTIONS[actor.action].fields;
      if (fields) {
        const previous =
          channel === "inf:settings:decisions:set" ? (old as { settings: unknown }).settings : old;
        const omit = (value: unknown) =>
          Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([key]) => !fields.includes(key),
            ),
          );
        if (!isDeepStrictEqual(omit(previous), omit(next))) {
          if (channel === "inf:settings:decisions:set")
            throw new Error("Decision model changes cannot change outbound consent.");
          const group =
            channel === "inf:presence:set"
              ? "presence"
              : channel === "inf:settings:routing:set"
                ? "routing"
                : channel === "inf:settings:layout:set"
                  ? "panel"
                  : "appearance";
          throw new Error(`Only the named ${group} action may change.`);
        }
      }
    }
    if (channel === "inf:settings:layout:set") {
      const oldLayout = services.preferences.get().layout;
      const newLayout = args[0] as typeof oldLayout;
      const fields = ["collapsedPanels", "hiddenPanels"] as const;
      const changed = new Set(
        fields.flatMap((field) =>
          [...new Set([...Object.keys(oldLayout[field]), ...Object.keys(newLayout[field])])].filter(
            (key) => !isDeepStrictEqual(oldLayout[field][key], newLayout[field][key]),
          ),
        ),
      );
      // A set without an arrangement keeps the saved one (INF-2344).
      if (newLayout.arrangement) {
        // The slot is the app's own chrome, not a panel: it is hidden or
        // shown, never moved, so it has no place in the arrangement.
        if (panelSlot(newLayout.arrangement, CREATE_PANEL_SLOT_ID))
          throw new Error(
            `${CREATE_PANEL_SLOT_ID} always sits at the top of the left rail; it can only be hidden or shown.`,
          );
        // Against where every panel sat, the ones the saved arrangement had
        // not written in yet included, so moving one of those is a move too.
        const sat = arrangePanels(oldLayout, knownPanels(services.personal.snapshot()));
        for (const id of movedPanels(sat, newLayout.arrangement)) changed.add(id);
      }
      if (actor.kind === "firstmate") {
        if (changed.size > 1) throw new Error("Change one panel at a time.");
      }
      const surfaces = listSurfaces(oldLayout, services.personal.snapshot(), gatesOf(services));
      // An app panel waiting on its gate has its place too, and Settings → Panels moves it.
      const known = new Set([
        ...surfaces.map((surface) => surface.id),
        ...knownPanels(services.personal.snapshot()).map((panel) => panel.id),
      ]);
      for (const key of changed) {
        if (!known.has(key))
          throw new Error(
            `No surface "${key}". Your surfaces: ${surfaces.map((s) => s.id).join(", ")}. The captain's panels switch is in Settings.`,
          );
      }
    }
    if (names.length) automation.said = undefined;
    const result = await handler(...args);
    for (const name of names) {
      const after = there
        ? stateThere(name)
        : ACTIONS[name].current
          ? await handlers[ACTIONS[name].current as keyof CoreHandlers]()
          : null;
      if (
        !ACTIONS[name].alwaysTrail &&
        name !== "refresh-usage" &&
        isDeepStrictEqual(actionValue(name, before.get(name)), actionValue(name, after))
      )
        continue;
      const value = actionValue(name, after);
      if (name === "project-setup") {
        const setup = result as RepoSetupResult;
        if (setup.created) trail(name, { repo: setup.repo }, actor);
      } else if (name === "project-remove") {
        const gone = (before.get(name) as RepoView[]).find((repo) => repo.id === args[0]);
        if (gone) trail(name, { repo: gone }, actor);
      } else if (name === "integration-add-mcp") {
        // An addition names its parsed input, not the whole list read back.
        // Each server is a separate act, never part of a settled settings run.
        const [server] = args as InvokeRequest<"inf:integrations:add">;
        trail(name, { name: server.name }, actor);
      } else if (name === "device-remove") {
        trail(name, { device: result }, actor);
      } else if (name === "project-settings") {
        const repo = result as RepoView;
        const was = (before.get(name) as RepoView[]).find((entry) => entry.id === repo.id);
        const details = ["name", "path", "origin"] as const;
        const changed = details.filter((key) => was && was[key] !== repo[key]);
        const descriptions = changed
          .map(
            (key) =>
              `${key === "origin" ? "where it lives" : key === "path" ? "folder" : "name"} to ${repo[key] ?? "kept on this computer"}`,
          )
          .concat(projectCostChange(was?.costLimit, repo.costLimit));
        if (
          JSON.stringify(was?.placementRequirements) !== JSON.stringify(repo.placementRequirements)
        )
          descriptions.push("computer requirements");
        // Require pull request checks (docs/forge.md, "A project with no checks").
        if (was && !was.noChecks !== !repo.noChecks)
          descriptions.push(`${repo.noChecks ? "runs no" : "requires"} pull request checks`);
        const description = descriptions.length
          ? `Changed ${repo.name}: ${descriptions.join("; ")}.`
          : undefined;
        trail(name, { repo, ...(description ? { description } : {}) }, actor);
      } else if (name === "project-name" || name === "project-move") {
        trail(name, result as Record<string, unknown>, actor);
      } else if (name === "project-batch-answer") {
        // An answer names what was asked, which the held batches read back no longer show.
        const [repoId, answer] = args as InvokeRequest<"inf:repos:batch-answer">;
        trail(name, { repoId, answer }, actor);
      } else if (name === "project-runs-on") {
        const repo = result as RepoView;
        const was = (before.get(name) as RepoView[]).find((entry) => entry.id === repo.id);
        const where =
          repo.runsOn === AUTOMATIC_COMPUTER
            ? "automatically"
            : repo.runsOn
              ? devicePlace(services.devices.list(), repo.runsOn).where
              : null;
        trail(name, { repo, fromHere: !was?.runsOn, where }, actor);
      } else if (name === "panel") {
        const old = before.get(name) as Layout;
        const next = after as typeof old;
        const snapshot = services.personal.snapshot();
        const surfaces = listSurfaces(next, snapshot, gatesOf(services));
        const prior = listSurfaces(old, snapshot, gatesOf(services));
        // The panel the first mate named, by its id or its title, as its
        // request resolves it, or the one the captain's own write moved.
        const target =
          actor.kind === "firstmate"
            ? actor.target
            : (args as InvokeRequest<"inf:settings:layout:set">)[1]?.moved;
        const named =
          target === undefined
            ? undefined
            : (surfaces.find((surface) => surface.id === target) ??
              surfaces.find((surface) => surface.title.toLowerCase() === target.toLowerCase()));
        const moved = next.arrangement
          ? movedPanels(arrangePanels(old, knownPanels(snapshot)), next.arrangement, named?.id)
          : [];
        // Reset to defaults, or any change that moved several panels at
        // once, is one line, never one per panel.
        if (moved.length > 1 && next.arrangement) {
          const reset = sameArrangement(
            next.arrangement,
            defaultArrangement(knownPanels(snapshot)),
          );
          trail(
            name,
            {
              surface: "Panels",
              description: reset ? "put back where each asks to be" : "rearranged",
            },
            actor,
          );
        }
        for (const surface of surfaces) {
          const previous = prior.find((s) => s.id === surface.id);
          if (!previous) continue;
          const state = (view: typeof surface) => ({
            placement: view.placement,
            place: view.place ?? null,
            hidden: view.hidden,
          });
          const was = state(previous);
          const now = state(surface);
          const movedHere = moved.length === 1 && moved[0] === surface.id;
          if (!movedHere && was.hidden === now.hidden) continue;
          // A settled run's line says what changed since its first step.
          const start = (runOf(name, surface.id, actor)?.from as typeof was | undefined) ?? was;
          const descriptions: string[] = [];
          if (
            movedHere &&
            !isDeepStrictEqual(
              { placement: start.placement, place: start.place },
              { placement: now.placement, place: now.place },
            )
          )
            descriptions.push(`moved to ${whereNow(surface, surfaces)}`);
          if (start.hidden !== now.hidden) descriptions.push(now.hidden ? "hidden" : "shown");
          trail(name, { surface: surface.title, description: descriptions.join("; ") }, actor, {
            target: surface.id,
            from: was,
            to: now,
          });
        }
      } else if (name === "panel-collapse") {
        const old = actionValue(name, before.get(name)).collapsedPanels as Record<string, boolean>;
        const next = value.collapsedPanels as Record<string, boolean>;
        for (const surface of new Set([...Object.keys(old), ...Object.keys(next)])) {
          if (!!old[surface] !== !!next[surface])
            trail(name, { surface, collapsed: !!next[surface] }, actor, {
              target: surface,
              from: !!old[surface],
              to: !!next[surface],
            });
        }
      } else if (ACTIONS[name].area === "automation") {
        // The Scheduler's own words of the change, as its trail.
        if (automation.said) trail(name, { text: automation.said }, actor);
      } else if (name === "show-card") {
        // The captain's own click on the Cards row is not news; Firstmate's
        // pointing is, as one feed line and never a card.
        if (actor.kind === "firstmate") trail(name, { title: (result as PastCard).title }, actor);
      } else if (name === "show-task") {
        // As show-card: the first mate's pointing is one feed line.
        if (actor.kind === "firstmate") {
          const shown = result as InvokeResponse<"inf:tasks:show">;
          trail(name, { key: shown.key, title: shown.title }, actor);
        }
      } else if (name === "show-settings") {
        if (actor.kind === "firstmate")
          trail(name, { section: (args[0] as { section: string }).section }, actor);
      } else if (name === "show-whats-new") {
        // As show-card: the captain's own door is not news; Firstmate's is.
        if (actor.kind === "firstmate")
          trail(name, { version: (result as { version: string }).version }, actor);
      } else if (name === "crew-slots") {
        trail(name, { key: args[0], slot: args[1], on: args[2] }, actor, {
          target: `${args[0]} ${args[1]}`,
          from: !args[2],
          to: args[2],
        });
      } else if (name === "crew-speed") {
        const old = before.get(name) as InvokeResponse<"inf:models:slots">;
        const prior = [...old.models, ...old.byName].find(
          (model) => `${model.provider}/${model.id}` === args[0],
        );
        trail(name, { key: args[0], speed: args[1] }, actor, {
          target: String(args[0]),
          from: prior?.speed ?? "standard",
          to: args[1],
        });
      } else if (name === "integration-add") {
        trail(name, integrationSignInValue(channel, args), actor);
      } else if (name === "forge-sign-out") {
        // Names the host, and the computer when it was not this Mac's sign-in.
        trail(name, { host: args[0], ...(whereThere ? { where: whereThere } : {}) }, actor);
      } else if (name === "private-site-allow") {
        trail(name, { site: addedPrivateSite(before.get(name), after) }, actor);
      } else if (name === "direction") {
        const { op, direction } = result as InvokeResponse<"inf:knowledge:direction:set">;
        trail(name, { op, text: direction.text }, actor);
        services.corrections?.cases.saved(direction.id);
      } else if (name === "crew-reasoning") {
        trail(name, { key: args[0], slot: args[1], level: args[2] }, actor);
      } else if (name === "crew-slots-reset") {
        trail(name, { provider: args[0] }, actor);
      } else if (name === "firstmate-account") {
        // The line names the account by the captain's own label, never its id.
        const accountId = value.accountId as string | null;
        trail(
          name,
          { label: accountId ? (services.vault.get(accountId)?.label ?? null) : null },
          actor,
          { target: "", from: actionValue(name, before.get(name)), to: value },
        );
      } else if (name === "runbook-copy") {
        const current = after as RunbookView[];
        trail(
          name,
          {
            source: current.find((book) => book.id === args[0])?.name,
            name: current.find((book) => book.id === args[1])?.name,
          },
          actor,
        );
      } else if (name === "runbook") {
        const previous = before.get(name) as RunbookView[];
        const current = after as RunbookView[];
        const book = current.find((book) => book.id === args[0]);
        const was = previous.find((book) => book.id === args[0]);
        if (book && was)
          trail(
            name,
            {
              name: book.name,
              enabled: book.enabled,
              replacement: previous.find(
                (entry) =>
                  entry.id !== book.id &&
                  entry.enabled &&
                  current.some((now) => now.id === entry.id && !now.enabled),
              )?.name,
            },
            actor,
            {
              target: book.id,
              // A replacement also changes another switch; returning this one to its
              // first value must not withdraw the line for that other saved change.
              from: previous,
              to: current,
            },
          );
      } else if (name.startsWith("account-") && ACTIONS[name].change) {
        const { value: said, step } = accountTrail(
          name,
          args,
          before.get(name) as AccountView[],
          after as AccountView[],
          there ? { deviceId: there, ...(whereThere ? { where: whereThere } : {}) } : undefined,
        );
        trail(name, said, actor, step);
      } else if (ACTIONS[name].alwaysTrail || name === "refresh-usage")
        trail(name, ACTIONS[name].alwaysTrail ? {} : value, actor);
      else
        trail(name, value, actor, {
          target: "",
          from: actionValue(name, before.get(name)),
          to: value,
        });
    }
    return result;
  };
  return dispatch;
}

/**
 * Where a moved panel is now, in the words of its Activity line: its slot,
 * and the panel just below it there, else the one just above it.
 */
function whereNow(surface: SurfaceView, surfaces: readonly SurfaceView[]): string {
  const slot = `the ${surface.placement.x} rail, ${surface.placement.y}`;
  const here = surfaces.filter(
    (each) =>
      each.place !== undefined &&
      each.placement.x === surface.placement.x &&
      each.placement.y === surface.placement.y,
  );
  const at = here.findIndex((each) => each.id === surface.id);
  const below = here[at + 1];
  if (below) return `${slot}, above ${below.title}`;
  const above = here[at - 1];
  if (above) return `${slot}, below ${above.title}`;
  return slot;
}
