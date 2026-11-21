/** How a conversation on a computer that runs work opens again, and what it confirmed it opened against what the home asked. */
import { offeringKey } from "@shared/modelSlots";
import { backendForProvider } from "@shared/providers";
import { type PlacedSpec, placedSpecSchema } from "@shared/work";
import { sameNames } from "../session/workRecovery";

/**
 * The spec to open there again. Tool names are what the supervisor binds
 * now (`names`); instructions stay exactly as the home opened the
 * conversation with them, so a restart does not start it over.
 */
export function withToolsNow(spec: PlacedSpec, names: readonly string[] | undefined): PlacedSpec {
  return names && !sameNames(names, spec.tools) ? { ...spec, tools: [...names] } : spec;
}

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

/** What an open there answered, read whole: one of the three answers it may give. */
export type OpenOutcome<S> = { state: S } | { needsOpen: true } | { notOpened: string };

/**
 * Reads an open's answer as exactly one outcome: its state; `needsOpen`, only
 * for a `reattach` open; or `notOpened`, only for an open that asked for it
 * (`open-not-opened.md`). Any other answer, an empty one included, says
 * nothing sure about what opened there and throws, so the home treats it
 * as an open whose outcome is unknown, never as leave to open anew.
 */
export function openOutcome<S>(
  answer: { state?: S | undefined; needsOpen?: true | undefined; notOpened?: string | undefined },
  asked: Pick<PlacedSpec, "reattach" | "notOpened">,
): OpenOutcome<S> {
  const { state, needsOpen, notOpened } = answer;
  const given = [state !== undefined, needsOpen === true, notOpened !== undefined];
  if (given.filter(Boolean).length === 1) {
    if (state !== undefined) return { state };
    if (needsOpen && asked.reattach) return { needsOpen: true };
    if (notOpened !== undefined && asked.notOpened) return { notOpened };
  }
  // i18n-exempt: an internal failure the home catches; no person reads it.
  throw new Error("The computer's answer to an open said nothing sure about what opened there.");
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
 * picks and an account there that serves it; one opened anew on the model
 * it had, routing nothing, only on that model and while it is still held
 * there (`kept`): one on another is refused (`refuse`), so nothing
 * reattaches to it. Any other is let go unless a stop or another move
 * already took it, and the next turn opens one through the ordinary resume.
 * A live conversation reattached to keeps the spec it had, on whatever
 * model it runs.
 */
export async function reopenedSpec(
  progress: ReopenProgress,
  state: { model?: { provider: string; id: string } | undefined; accountId?: string | undefined },
  o: { ours(): boolean; letGo(): void; refuse(): void; kept(): Promise<boolean> | undefined },
): Promise<PlacedSpec | undefined | false> {
  const { asked, routed } = progress;
  if (!routed) {
    if (!progress.anew)
      return sameModel(state.model, asked.model) ? confirmedSpec(asked, state) : undefined;
    if (!sameModel(state.model, asked.model)) {
      if (o.ours()) o.refuse();
      o.letGo();
      return false;
    }
    if ((await o.kept()) === false) {
      o.letGo();
      return false;
    }
    return confirmedSpec(asked, state);
  }
  const outcome = o.ours()
    ? await routed.commit({
        ...(state.model ? { model: state.model } : {}),
        ...(state.accountId ? { account: state.accountId } : {}),
      })
    : "stale";
  if (outcome === "committed") return confirmedSpec(asked, state);
  if (outcome !== "stale") o.letGo();
  return false;
}

type OpenedThere = { model?: { provider: string; id: string }; account?: string };

/** A routing pick for a reopen, committed only once the conversation opened on it. */
type ReopenRoute = {
  model: { provider: string; id: string };
  accountId?: string;
  thinking: PlacedSpec["thinking"];
  commit(opened: OpenedThere): Promise<"committed" | "stale" | "again">;
  /** Passes this model and account over, once that computer answered that nothing opened on it. */
  passOver(): void;
};

/** What a reopen asked so far: the spec, the routing pick, and whether it opens anew. */
export type ReopenProgress = { asked: PlacedSpec; routed?: ReopenRoute; anew: boolean };

/**
 * Asks a computer that runs work to open a conversation again. One that
 * keeps only what it holds (`reattachOnly`) is asked to reattach first,
 * unless what it holds was refused words here (`refused`); a new
 * conversation routes before it opens: a model that left every level opens
 * on another that computer serves, or not at all until one can take it
 * (docs/routing.md, "A model that left every level"). `route(attach)` says
 * whether an older computer, holding a conversation of the task (`held`),
 * may bring the old model back; whatever an older computer answers is
 * checked as opened anew, as it may be, including a conversation it already
 * opened again by itself (`openedThere`), which is answered as its outcome
 * when routing keeps its model. An open anew is marked first (`creating`), so a quit or failure before it is
 * accepted leaves nothing the next reopen reattaches to. Undefined
 * opens nothing.
 */
export async function askReopen<S>(
  progress: ReopenProgress,
  o: {
    reattachOnly: boolean;
    openedThere?: OpenOutcome<S> | undefined;
    held: boolean;
    refused: boolean;
    ours(): boolean;
    ask(spec: PlacedSpec): Promise<OpenOutcome<S>>;
    route(attach: boolean): Promise<ReopenRoute | "wait" | "stale" | undefined> | undefined;
    letGo(): void;
    creating(): void;
  },
): Promise<OpenOutcome<S> | undefined> {
  const opened = progress.asked;
  const anew = (spec: PlacedSpec) => {
    if (progress.anew) o.creating();
    return o.ask(spec);
  };
  if (o.reattachOnly && !o.openedThere) {
    if (!o.refused) {
      const kept = await o.ask({ ...opened, reattach: true });
      if (!("needsOpen" in kept) || !o.ours()) return kept;
    }
    progress.anew = true;
  } else progress.anew = true; // An older computer may open anew anywhere.
  if (!o.ours()) return undefined;
  const routed = await o.route(!o.reattachOnly && o.held);
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
  if (!routed) {
    if (!o.openedThere) return anew(opened);
    // What an older computer opened by itself is checked as opened anew.
    o.creating();
    return o.openedThere;
  }
  progress.routed = routed;
  progress.anew = true;
  progress.asked = routedSpec(opened, routed);
  return anew(progress.asked);
}
