/** How a conversation on a computer that runs work opens again, and what it confirmed it opened against what the home asked. */
import { offeringKey } from "@shared/modelSlots";
import { backendForProvider } from "@shared/providers";
import { type PlacedSpec, placedSpecSchema } from "@shared/work";

/**
 * The spec of the conversation a computer confirmed it opened: the one asked,
 * bound to the account that computer says it bound, which may not be the one
 * the home named.
 */
export function confirmedSpec(
  asked: PlacedSpec,
  state: { accountId?: string | undefined },
): PlacedSpec {
  return state.accountId && state.accountId !== asked.binding.accountId
    ? { ...asked, binding: { ...asked.binding, accountId: state.accountId } }
    : asked;
}

/** Whether a conversation's model is the one asked, by offering; one asked for none is any. */
export function sameModel(
  model: { provider: string; id: string } | undefined,
  asked: { provider: string; id: string } | undefined,
): boolean {
  return !asked || (model !== undefined && offeringKey(model) === offeringKey(asked));
}

/** A conversation's spec reopened on the model and account routing picked. */
export function routedSpec(
  opened: PlacedSpec,
  routed: {
    model: { provider: string; id: string };
    accountId?: string;
    thinking: PlacedSpec["thinking"];
  },
): PlacedSpec {
  return placedSpecSchema.parse({
    ...opened,
    binding: {
      backend: opened.binding.backend,
      ...(routed.accountId ? { accountId: routed.accountId } : {}),
      provider: routed.model.provider,
    },
    model: routed.model,
    thinking: routed.thinking,
  });
}

/**
 * The spec a reopen confirmed open there keeps, or false when it takes no
 * words. A routed one commits its move only for the model routing still
 * picks and an account there that serves it; any other is let go unless a
 * stop or another move already took it, and the next turn opens one through
 * the ordinary resume. One kept on the old model keeps the spec it had.
 */
export function reopenedSpec(
  asked: PlacedSpec,
  state: { model?: { provider: string; id: string } | undefined; accountId?: string | undefined },
  routed: ReopenRoute | undefined,
  ours: boolean,
  letGo: () => void,
): PlacedSpec | undefined | false {
  if (!routed) return sameModel(state.model, asked.model) ? confirmedSpec(asked, state) : undefined;
  const outcome = ours
    ? routed.commit({
        ...(state.model ? { model: state.model } : {}),
        ...(state.accountId ? { account: state.accountId } : {}),
      })
    : "stale";
  if (outcome === "committed") return confirmedSpec(asked, state);
  if (outcome !== "stale") letGo();
  return false;
}

type OpenedThere = { model?: { provider: string; id: string }; account?: string };

/** A routing pick for a reopen, committed only once the conversation opened on it. */
type ReopenRoute = {
  model: { provider: string; id: string };
  accountId?: string;
  thinking: PlacedSpec["thinking"];
  commit(opened: OpenedThere): "committed" | "stale" | "again" | "wait";
};

/** What a reopen asked so far: the spec, the routing pick, and whether it opens anew. */
export type ReopenProgress = { asked: PlacedSpec; routed?: ReopenRoute; anew: boolean };

/**
 * Asks a computer that runs work to open a conversation again. One that
 * keeps only what it holds (`reattachOnly`) is asked to reattach first; a new
 * conversation routes before it opens: a model that left every level opens
 * on another that computer serves, or not at all until one can take it
 * (docs/routing.md, "A model that left every level"). `route(attach)` says
 * whether an older computer may bring the old model back. Undefined opens
 * nothing; "open" says an older computer opened it again by itself on a
 * model still held.
 */
export async function askReopen<A extends { state?: unknown }>(
  progress: ReopenProgress,
  o: {
    reattachOnly: boolean;
    openedThere: boolean;
    ours(): boolean;
    ask(spec: PlacedSpec): Promise<A>;
    route(attach: boolean): Promise<ReopenRoute | "wait" | "stale" | undefined> | undefined;
    letGo(): void;
  },
): Promise<A | "open" | undefined> {
  const opened = progress.asked;
  if (o.reattachOnly && !o.openedThere) {
    const kept = await o.ask({ ...opened, reattach: true });
    if (kept.state || !o.ours()) return kept;
    progress.anew = true;
  }
  if (!o.ours()) return undefined;
  const routed = await o.route(!o.reattachOnly);
  if (routed === "stale" || !o.ours()) return undefined;
  if (
    routed === "wait" ||
    (routed && backendForProvider(routed.model.provider) !== opened.binding.backend)
  ) {
    // Nothing opens in this session: the task's next turn opens a new
    // conversation through the ordinary resume, which routes it again.
    o.letGo();
    return undefined;
  }
  if (!routed) return o.openedThere ? "open" : o.ask(opened);
  progress.routed = routed;
  progress.anew = true;
  progress.asked = routedSpec(opened, routed);
  return o.ask(progress.asked);
}
