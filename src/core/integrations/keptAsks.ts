import { randomUUID } from "node:crypto";
import type { IntegrationAsk, IntegrationScope } from "@shared/writeAsk";
import type { IntegrationAskStore } from "./askStore";
import type {
  IntegrationActionSpec,
  IntegrationAnswer,
  IntegrationCaller,
  IntegrationConfirm,
} from "./binding";
import { READER_WORDS } from "./readerReach";

/**
 * The asks a call keeps for the captain (docs/integrations.md, "Approval"):
 * the exact call, kept where its caller's asks wait, and the card the host
 * presents for it - an approval for a call the captain's rules hold, or a
 * place's own question about a call they let run. `IntegrationsService`
 * decides when a call waits; this is how it waits.
 */

/** The call a kept ask names, as `IntegrationsService` resolved it. */
export type AskedCall = {
  caller: IntegrationCaller;
  /** The connection's id and its reference (`IntegrationAsk.integration`, `.connection`). */
  integration: string;
  connection: string;
  /** The row's name, which the crew calls it by. */
  name: string;
  spec: IntegrationActionSpec;
  input: unknown;
  reason: string | undefined;
  /** The caller is an unsafe data reader's task (docs/agents-reach.md, "An unsafe data reader"). */
  reader: boolean;
  /** What a grant binds to (`IntegrationsService.signature`). */
  signature: string;
  /** What an allowance for the rest of the task would cover; none for a reader or the first mate. */
  scope?: IntegrationScope;
  now: () => number;
};

/** A kept ask's id, as the crewmate and its card name it. */
export function newAskId(): string {
  return `ia${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * The host keeps the exact call and presents its own card (INF-950): on
 * the caller's task, or for the first mate or a panel on the row the host
 * files for that card (INF-1108). A panel's reason is its manifest's why.
 */
export function keepAsk(call: AskedCall, asks: IntegrationAskStore | undefined): IntegrationAnswer {
  const { caller, name, spec, reason, reader } = call;
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
      text: `Not run: ${name}'s ${spec.name} asks the captain. Call again with ${firstmate || reader ? "reason" : "--reason"} explaining why this action is needed.`,
      refused: "invalid",
    };
  const ask = askOf(call);
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
  if (reader)
    return {
      text: READER_WORDS.kept(name, spec.name, ask.id, joined),
      refused: "refused",
    };
  return {
    text: `Not run: ${name}'s ${spec.name} asks the captain. ${joined ? `The app added ask ${ask.id} to the approval card already waiting for your asks to ${name}.` : `The app raised its approval card for ask ${ask.id}.`} Do not emit another card or repeat the call. You will hear the outcome once through write-answered.`,
    refused: "refused",
    ...(card ? { card } : {}),
  };
}

/** The ask a call keeps for the captain, as `keepAsk` and `keepConfirm` keep it. */
function askOf(call: AskedCall): IntegrationAsk {
  const { caller, spec, input } = call;
  return {
    id: newAskId(),
    kind: "integration",
    ...(caller.kind === "firstmate" ? { by: "firstmate" as const } : {}),
    ...(caller.kind === "panel"
      ? {
          by: "panel" as const,
          panel: { key: caller.panel.key, title: caller.panel.title },
        }
      : {}),
    integration: call.integration,
    connection: call.connection,
    place: call.name,
    action: spec.name,
    label: spec.label,
    description: spec.description,
    effect: spec.effect,
    signature: call.signature,
    ...(call.reason !== undefined ? { reason: call.reason } : {}),
    input: JSON.stringify(input),
    // A reader's card offers no Allow for the rest of this task.
    ...(call.scope ? { scope: call.scope } : {}),
    at: call.now(),
  };
}

/**
 * The place stopped a call the captain's rules let run, to ask the
 * captain first (`IntegrationAnswer.confirm`): its question is kept as an
 * ask on a card of its own, and the caller hears it waits, as a held call
 * does. Nothing ran.
 */
export function keepConfirm(
  call: AskedCall,
  confirm: IntegrationConfirm,
  asks: IntegrationAskStore | undefined,
): IntegrationAnswer {
  const { caller, name, spec } = call;
  const { scope: _scope, ...asked } = askOf(call);
  const ask: IntegrationAsk = { ...asked, confirm };
  const kept = presentConfirm(asks, caller.kind === "task" ? caller.taskId : undefined, ask);
  if ("refused" in kept) return { text: kept.refused, refused: "refused" };
  return {
    // i18n-exempt: words served to the crew, which stay English
    text: `Not run yet: ${name} asks the captain to confirm ${spec.name} first. The app raised a card with ${name}'s question for ask ${ask.id}.${caller.kind === "panel" ? "" : " Do not emit another card or repeat the call. You will hear the outcome once through write-answered."}`,
    refused: "refused",
    ...(kept.card ? { card: kept.card } : {}),
  };
}

/**
 * The place asked again about a call the captain answered: the same call
 * is kept as a new ask with the new question, on a new card. It answers why
 * the answered ask ran nothing, for that ask's outcome.
 */
export function confirmAgain(
  asks: IntegrationAskStore | undefined,
  taskId: string,
  answered: IntegrationAsk,
  confirm: IntegrationConfirm,
  now: number,
): string {
  const { scope: _scope, card: _card, sentAt: _sent, outcome: _outcome, ...asked } = answered;
  const again: IntegrationAsk = { ...asked, id: newAskId(), confirm, at: now };
  const kept = presentConfirm(asks, taskId, again);
  return "refused" in kept
    ? kept.refused
    : // i18n-exempt: words served to the crew, which stay English
      `${answered.place} asked the captain to confirm it first, on a new card (ask ${again.id}). Nothing ran yet; you hear that ask's outcome once through write-answered.`;
}

/**
 * Keep a confirmation's ask where its asker's asks wait - the task's,
 * the first mate's row or the panel's - and put up its card, which no
 * other ask joins. It answers the card when a new row holds it, or why it
 * could not be kept.
 */
function presentConfirm(
  asks: IntegrationAskStore | undefined,
  taskId: string | undefined,
  ask: IntegrationAsk,
): { card?: string } | { refused: string } {
  // i18n-exempt: words served to the crew, which stay English
  const cannot = `Not run: ${ask.place} asks the captain to confirm ${ask.action} first, and the app cannot put its question to the captain here.`;
  try {
    if (ask.by === "firstmate") {
      const card = asks?.keepForFirstmate?.(ask);
      return card ? { card } : { refused: cannot };
    }
    if (ask.by === "panel") {
      const kept = asks?.keepForPanel?.(ask);
      if (!kept) return { refused: cannot };
      if ("held" in kept)
        return {
          // i18n-exempt: words served to the crew, which stay English
          refused: `Not run: ${ask.place} asks the captain to confirm ${ask.action} first, and the panel's ask for it already waits or was declined.`,
        };
      return { card: kept.card };
    }
    if (!asks || taskId === undefined) return { refused: cannot };
    const dropped = asks.keep(taskId, ask) ?? [];
    asks.present?.(taskId, ask, dropped);
    return {};
  } catch (error) {
    return {
      // i18n-exempt: words served to the crew, which stay English
      refused: `Not run: ${ask.place} asks the captain to confirm ${ask.action} first, and the app could not keep the question: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
