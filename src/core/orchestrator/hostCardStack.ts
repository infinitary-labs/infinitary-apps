import type { Card } from "@shared/cards";
import type { ClaudeAccessSource } from "@shared/claudeAccess";
import { deviceForgeSignInCardId } from "@shared/deviceSetup";
import type { CardServiceHost } from "./cardStackTypes";
import {
  authDecisionCard,
  deviceForgeSignInCard,
  FIRSTMATE_FAILURE_CARD_ID,
  FIRSTMATE_MOVE_BACK_CARD_ID,
  FIRSTMATE_PAUSE_CARD_IDS,
  FIRSTMATE_PICTURES_CARD_ID,
  FIRSTMATE_QUIET_CARD_ID,
  type FirstmatePauseCard,
  firstmateFailureCard,
  firstmateMoveBackCard,
  firstmatePauseCard,
  firstmatePauseCardId,
  firstmatePicturesCard,
  firstmateQuietCard,
  forgeSignInCard,
  hostCard,
  signInAgainCard,
  systemNoteCard,
} from "./hostCards";

export class HostCardStack {
  constructor(
    private readonly host: CardServiceHost,
    private readonly cards: Map<string, Card>,
    private readonly put: (card: Card, options?: { revise?: boolean }) => void,
    private readonly takeDown: (id: string, reason: string) => void,
  ) {}

  /**
   * The Firstmate's pause card (W1 S9; docs/architecture.md §16 "A paused
   * seat"): one card for one pause, titled for what stopped the seat. With
   * a place to move (rung 2) it asks to move - a cross-provider move is a
   * model change, so it always asks - under `card-fm-flagship-move`;
   * without one (rung 3) it says the seat waits, under `card-fm-refused`
   * for a refusal and `card-fm-no-headroom` for the rest. Either way it
   * carries the class's own way back: "Sign in" for a lost sign-in (a
   * captain click only; nothing signs in on its own) and "Try again" for a
   * refusal (`try-again`, the only way a refusal clears on the captain's
   * word). Nothing moves or retries until a click. Its one primary is its
   * default, so the footer draws it at the right edge. A card already up
   * under the id is revised in place when its words or actions differ;
   * `reviseOnly` never recreates a card removed by a choice or withdrawal.
   * A card put aside remains pending rather than acquiring a refusal.
   */
  addFirstmatePauseCard(input: FirstmatePauseCard, options: { reviseOnly?: boolean } = {}): void {
    const id = firstmatePauseCardId(input);
    const previous = this.cards.get(id);
    if (!previous && options.reviseOnly) return;
    const next = firstmatePauseCard(id, input);
    if (
      previous &&
      previous.title === next.title &&
      previous.body === next.body &&
      JSON.stringify(previous.actions) === JSON.stringify(next.actions)
    ) {
      return;
    }
    this.put({ ...next, createdAt: previous?.createdAt ?? this.host.now() });
  }

  /**
   * The way back for a seat the captain moved (W1 S9): the account it left
   * serves again, so ask - never move on its own. The action reuses the
   * move, pointed back at the provider the seat left.
   */
  addFirstmateMoveBackCard(input: {
    providerId: string;
    providerName: string;
    body: string;
  }): void {
    if (this.cards.has(FIRSTMATE_MOVE_BACK_CARD_ID)) return;
    this.put({ ...firstmateMoveBackCard(input), createdAt: this.host.now() });
  }

  /** The seat serves again, or moved: every pause card's question is gone. */
  withdrawFirstmatePauseCards(reason: string): void {
    for (const id of FIRSTMATE_PAUSE_CARD_IDS) this.takeDown(id, reason);
  }

  /**
   * An app-raised auth decision card (also used by the Firstmate agent). A
   * crewmate's own sign-in card carries its task, so it holds that task's
   * turn through the gate like any card; an account's files its own row.
   * With `move`, its default moves the task to the model the app picked,
   * by that model's name (INF-849), `arg` being the task, the provider it
   * moves off and the model offered; Open settings stays beside it.
   */
  addAuthDecisionCard(
    id: string,
    meta: string,
    body: string,
    options?: {
      restoreAccountId?: string;
      taskId?: string;
      move?: { arg: string; modelName: string };
      access?: ClaudeAccessSource;
    },
  ): void {
    if (this.cards.has(id)) return;
    this.put({ ...authDecisionCard(id, meta, body, options), createdAt: this.host.now() });
  }

  /**
   * The one host card for a sign-in where projects live that the host
   * refused (git integration PR 1.2): "Sign in to GitHub again", whose one
   * action lands on Settings -> Projects with the sign-in already started.
   * Raised only on the host's own refusal (needs_reauth) and cleared by
   * `clearAuthDecisionCard` once the host answers again. A body names what
   * waits on it; it never suggests the host is required.
   */
  addForgeSignInCard(
    id: string,
    host: string,
    name: string,
    waitingChanges: number,
    options: { reauth?: boolean; cli?: boolean } = {},
  ): void {
    if (this.cards.has(id)) return;
    this.put({
      ...forgeSignInCard(id, host, name, waitingChanges, options),
      createdAt: this.host.now(),
    });
  }

  /**
   * The one host card for a computer that runs a project living on a host
   * it holds no sign-in for (design skill `components/devices/SignInOnAMac`,
   * "GitHub on another device"; docs/forge.md, "A computer's own sign-in"):
   * "Sign in to GitHub on Mac mini", whose one action lands on Settings ->
   * Projects with that computer's sign-in started under its row. Raised
   * when Runs on names such a computer, or when its clone there is refused
   * for want of the sign-in; cleared once the computer reports one. Not
   * raised while the computer's setup card already asks for it.
   */
  addDeviceForgeSignInCard(input: {
    deviceId: string;
    host: string;
    name: string;
    project: string;
    place: { label: string; where: string; who: string };
  }): void {
    const id = deviceForgeSignInCardId(input.host, input.deviceId);
    if (this.cards.has(id)) return;
    this.put({ ...deviceForgeSignInCard(id, input), createdAt: this.host.now() });
  }

  /**
   * Drop a recovered needs_reauth card without waking the Firstmate. The
   * credential came back; the question is gone.
   */
  clearAuthDecisionCard(id: string): void {
    this.takeDown(id, "recovered");
  }

  /**
   * A card the host itself authors, put up (or revised in place under the
   * same id) by a core service that owns the question, such as the plugin
   * consent card (Phase A, A2a). The host stamps the author and the
   * priority; the caller's actions carry host effects only the captain's
   * click can run. A note (no choice to make) sits below every decision,
   * so a question it accompanies - signing in again - stays in front.
   * The first mate answers a reply under it unless the caller names
   * another answerer or none (docs/card-threads.md, "A host card's reply
   * row"); the agent-down set and the welcome never come through here.
   */
  raiseHostCard(
    card: Omit<Card, "author" | "priority" | "status" | "createdAt">,
    options: { note?: boolean } = {},
  ): void {
    const previous = this.cards.get(card.id);
    const answered =
      card.answeredBy === undefined && card.replies !== false
        ? { ...card, answeredBy: "firstmate" as const }
        : card;
    this.put({ ...hostCard(answered, options), createdAt: previous?.createdAt ?? this.host.now() });
  }

  /** Takes a host card down without an answer: the question it asked is gone. */
  withdrawHostCard(id: string, reason: string): void {
    if (this.cards.get(id)?.author !== "host") return;
    this.takeDown(id, reason);
  }

  /**
   * The Firstmate's own quiet card (P4 extension): informational only - the
   * orchestrator is steer-only, so there is no interrupt to offer. A later
   * escalation may re-raise over a dismissed one.
   */
  addFirstmateQuietCard(body: string): void {
    this.put({ ...firstmateQuietCard(body), createdAt: this.host.now() });
  }

  /** Activity resumed or the turn ended: the quiet question answered itself. */
  clearFirstmateQuietCard(): void {
    this.takeDown(FIRSTMATE_QUIET_CARD_ID, "activity-resumed");
  }

  /**
   * The Firstmate failure card (the agent-down set, ruling D6): the turn
   * failed and no agent can answer, so the host offers the one way out -
   * Retry, a host effect. One card under a stable id: a repeated failure
   * (a provider outage across several turns) revises it in place rather
   * than stacking copies.
   */
  addFirstmateFailureCard(body: string): void {
    const existing = this.cards.get(FIRSTMATE_FAILURE_CARD_ID);
    this.put(
      { ...firstmateFailureCard(body), createdAt: existing?.createdAt ?? this.host.now() },
      { revise: existing !== undefined },
    );
  }

  /**
   * The pictures card (`firstmatePicturesCard`): one card under a stable
   * id, revised in place when another message with pictures waits.
   */
  addFirstmatePicturesCard(input: Parameters<typeof firstmatePicturesCard>[0]): void {
    const existing = this.cards.get(FIRSTMATE_PICTURES_CARD_ID);
    this.put(
      { ...firstmatePicturesCard(input), createdAt: existing?.createdAt ?? this.host.now() },
      { revise: existing !== undefined },
    );
  }

  /** A moved first mate's ask for one sign-in the old home had (`signInAgainCard`). */
  addSignInAgainCard(
    id: string,
    signIn: { kind: "provider" | "forge"; id: string; name: string },
    from: string,
  ): void {
    if (this.cards.has(id)) return;
    this.put({ ...signInAgainCard(id, signIn, from), createdAt: this.host.now() });
  }

  addSystemNoteCard(id: string, title: string, body: string): void {
    if (this.cards.has(id)) return;
    this.put({ ...systemNoteCard(id, title, body), createdAt: this.host.now() });
  }
}
