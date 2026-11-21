import { NOTE_DONE_ACTION_ID } from "@shared/cardLeave";
import type { CardNote } from "@shared/cardNotes";
import type {
  Card,
  CardActionSource,
  CardAnswer,
  CardMessage,
  CardPressInput,
  CardSubmission,
} from "@shared/cards";
import {
  anythingElseOf,
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_QUESTIONS_MAX_BYTES,
  CARD_REPLY_MAX_CHARS,
  cardAnswersBytes,
  cardQuestionsBytes,
  deviceArrival,
  withAnythingElse,
} from "@shared/cards";
import {
  type ComposerNotice,
  composeTurnText,
  type PastedText,
  pasteRefusal,
} from "@shared/composer";
import { openedSection } from "@shared/integrations";
import type { FrameAnswers, FrameBox } from "@shared/plugins/bridge";
import { isPreparing } from "../attachments/intake";
import { clearSecretValues, readSecretValues } from "../cards/SecretAskFields";
import { readBringPicks } from "../cards/SecretBringPicks";
import type { ImageAttachment } from "../design";
import { changesOff, changesOffWords, doneThereWords, isView } from "../devices/viewWords";
import { takePictures } from "./composer";
import { savedCardAnswers } from "./savedCardAnswers";
import { withoutKey } from "./stack";
import { readCardsAgain } from "./stackActions";
import type { ShellGet, ShellSet } from "./store";

/** What the captain does on a card: its actions, its answers, its close, and its thread with the replies under it. */
export type CardSlice = {
  /** Set before invoking IPC: footer and embedded actions share one guard. */
  pendingCardActions: Record<string, { actionId: string }>;
  cardActionErrors: Record<string, string>;
  /**
   * The latest reading of each card body's own form (inline decisions,
   * contract 4.22): the count the footer shows and the answers, which are
   * the draft a revised body gets back by name. Unlike the reply draft, a
   * card's picks outlive a restart until it closes (./savedCardAnswers.ts,
   * INF-2710).
   */
  cardAnswers: Record<string, FrameAnswers>;
  /**
   * Cards as threads (phase 1): each card's messages, oldest first, read
   * once when the card comes up and kept live by the core's own push.
   * A card with no entry has not been read yet; an empty array is a card
   * with no thread.
   */
  threads: Record<string, CardMessage[]>;
  /** Initial history determines the destination layout before a body is born. */
  threadsLoaded: Record<string, true>;
  /** What the captain has typed under each card and not yet sent. */
  replyDrafts: Record<string, string>;
  replyNotes: Record<string, CardNote[]>;
  pointAtCard: string | null;
  annotationPick: { cardId: string; note: CardNote; box: FrameBox } | null;
  /** Selected words with Point at off: the host offers Annotate under them, and opens no editor yet. */
  annotationOffer: { cardId: string; note: CardNote; box: FrameBox } | null;
  /** Replies in flight, by card: the send control's own guard. */
  sendingReplies: Record<string, true>;
  /** A rejected reply, by card, shown under the row until the next keystroke. */
  replyErrors: Record<string, string>;
  replyNotices: Record<string, ComposerNotice>;
  /** Pasted pictures waiting to ride the next reply, by card. */
  replyPastes: Record<string, PastedText[]>;
  attachReplyPaste: (cardId: string, text: string, name?: string) => void;
  removeReplyPaste: (cardId: string, id: string) => void;
  replyImages: Record<string, ImageAttachment[]>;
  /**
   * Cards whose thread the captain collapsed into the card (FI3-1130). The
   * messages stay on the record; only this window stops showing them beside
   * the card, and the reply row returns to the foot of the card with the
   * thread's latest line above it. Shell state only, and it goes with the
   * card, like a drag.
   */
  closedThreadIds: string[];
  /**
   * The captain's choice for a request docked beside its browser's page
   * (docs/task-browser.md, "The request beside the page"): open beside the
   * page, or folded to its latest line. With none, the window's width
   * decides (`requestPlacement`). Shell state only, and it goes with the card.
   */
  requestColumns: Record<string, "open" | "folded">;
  /**
   * A card action. A footer click passes `collect`, the body frame's fresh
   * reading of its form: the answers ride the click (never a body's own
   * `inf.action`), falling back on the last reading when the frame cannot
   * give one.
   */
  actOnCard: (
    cardId: string,
    actionId: string,
    source?: CardActionSource,
    value?: unknown,
    collect?: (focusUnpicked?: boolean) => Promise<FrameAnswers | undefined>,
    mounted?: CardMount,
    input?: CardPressInput,
  ) => Promise<void>;
  /** A card body's frame read its form again (the bridge's `answers`). */
  setCardAnswers: (cardId: string, answers: FrameAnswers) => void;
  /** The close control; `mounted` is the card it was clicked on. */
  closeCard: (cardId: string, mounted?: CardMount) => void;
  /** A live note's own button, Done or Got it (INF-2794); `mounted` as on close, `input` what pressed it. */
  pressNote: (cardId: string, mounted?: CardMount, input?: CardPressInput) => Promise<void>;
  /** Read one card's thread from the core; idempotent, and safe to call on every show. */
  loadThread: (cardId: string) => void;
  /** Adopt a pushed thread (`inf:cards:thread`). */
  applyThread: (cardId: string, messages: CardMessage[]) => void;
  setReplyDraft: (cardId: string, text: string) => void;
  attachReplyImages: (cardId: string, items: ImageAttachment[]) => void;
  showReplyNotice: (cardId: string, notice: ComposerNotice) => void;
  dismissReplyNotice: (cardId: string) => void;
  removeReplyImage: (cardId: string, id: string) => void;
  /** Send the captain's reply under a card; the core routes it to the author. */
  sendReply: (cardId: string, collect?: () => Promise<FrameAnswers | undefined>) => Promise<void>;
  /** Collapse the thread beside a card into its foot; the messages stay on the record. */
  closeThread: (cardId: string) => void;
  /** Put a thread the captain collapsed in this window beside its card again. */
  openThread: (cardId: string) => void;
  /** Open a docked request beside its page, or fold it to its latest line. */
  setRequestColumn: (cardId: string, choice: "open" | "folded") => void;
  minimizeCard: (cardId: string) => Promise<void>;
};

/**
 * The lifecycle and offer of the card a gesture started on, read from the
 * mounted card at the click and never looked up again after an await
 * (docs/card-evidence.md).
 */
export type CardMount = Pick<Card, "lifecycleId" | "offerId">;

/** A fresh id for one gesture: its retransmission is recorded once. */
function gestureId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What the shell says about a gesture beside it: its id, the card it had
 * mounted, and on a button's press what pressed it (./pressInput).
 */
function submissionFor(mounted: CardMount | undefined, input?: CardPressInput): CardSubmission {
  return {
    id: gestureId(),
    ...(mounted?.lifecycleId ? { lifecycleId: mounted.lifecycleId } : {}),
    ...(mounted?.offerId ? { offerId: mounted.offerId } : {}),
    ...(input ? { input } : {}),
  };
}

/**
 * The shell's one card-leave dispatcher (INF-1879): the corner's request
 * for a card, or a put aside for a core predating the corner contract,
 * which still has a destructive close. Put every card aside (INF-4002)
 * sends each card through it too.
 */
export function leaveCard(
  card: Card | undefined,
  cardId: string,
  mounted?: CardMount,
): Promise<unknown> {
  return card?.corner
    ? window.infinitary.cards.close(cardId, submissionFor(mounted))
    : window.infinitary.cards.minimize(cardId, true);
}

export function cardSlice(set: ShellSet, get: ShellGet): CardSlice {
  /**
   * Keep on an ask card: reads its masked fields now and sends them with the
   * button's one-time pass. Infinitary withdraws the card once everything is
   * kept; otherwise the card stays and shows why, with what was typed still
   * in its fields for another Keep.
   */
  const keepSecrets = (cardId: string, pass: string): Promise<void> =>
    secretsPress(cardId, pass, async () => {
      const answer = await window.infinitary.secrets.keep({
        pass,
        values: readSecretValues(cardId) ?? [],
      });
      if (answer.kept) clearSecretValues(cardId);
      return answer.words;
    });
  /**
   * Bring into Secrets on a bring card: sends the ids of the ticked rows
   * with the button's one-time pass, never a value (docs/secrets.md,
   * "Bringing secrets from another tool"). Infinitary withdraws the card once
   * the bring ends; otherwise the card stays and shows why.
   */
  const bringSecrets = (cardId: string, pass: string): Promise<void> =>
    secretsPress(cardId, pass, async () => {
      const answer = await window.infinitary.secrets.bring({
        pass,
        picked: readBringPicks(cardId) ?? [],
      });
      return answer.words;
    });
  /** A press on a Secrets card's own button: pending while it runs, and the host's words beside the buttons when it did not finish. */
  const secretsPress = async (
    cardId: string,
    pass: string,
    send: () => Promise<string | undefined>,
  ): Promise<void> => {
    const request = { actionId: pass };
    set((s) => ({
      pendingCardActions: { ...s.pendingCardActions, [cardId]: request },
      cardActionErrors: withoutKey(s.cardActionErrors, cardId),
    }));
    try {
      const words = await send();
      if (words) set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: words } }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: message } }));
    } finally {
      if (get().pendingCardActions[cardId] === request) {
        set((s) => ({ pendingCardActions: withoutKey(s.pendingCardActions, cardId) }));
      }
    }
  };
  return {
    pendingCardActions: {},
    cardActionErrors: {},
    cardAnswers: savedCardAnswers(),
    threads: {},
    threadsLoaded: {},
    replyDrafts: {},
    replyNotes: {},
    pointAtCard: null,
    annotationPick: null,
    annotationOffer: null,
    sendingReplies: {},
    replyErrors: {},
    replyNotices: {},
    replyPastes: {},
    replyImages: {},
    closedThreadIds: [],
    requestColumns: {},
    actOnCard: async (cardId, actionId, source = "chrome", value, collect, mounted, input) => {
      const offered = get().cards.find((card) => card.id === cardId);
      if (get().pendingCardActions[cardId] || !offered) return;
      const thisMac = get().thisMac;
      if (isView(thisMac) && changesOff(thisMac)) {
        // A body's own button while changes are off: refused, never sent later.
        if (source === "frame") throw new Error(changesOffWords(thisMac));
        return;
      }
      const chosen = get()
        .cards.find((card) => card.id === cardId)
        ?.actions.find((action) => action.id === actionId);
      const there = isView(thisMac) && chosen ? doneThereWords(thisMac, chosen) : null;
      if (there) {
        // The task's browser page stays on the other computer, and a first
        // mate on an older version answers no Settings section from here,
        // Devices included (docs/view.md): nothing is sent, so the card stays
        // on both computers and says what to do.
        set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: there } }));
        return;
      }
      if (chosen?.effect?.kind === "host" && chosen.effect.op === "secrets-keep") {
        // An ask to keep a secret: the values go from its masked fields with
        // the button's pass, in their own request, never as a card answer
        // (docs/secrets.md, "Asking to keep a secret").
        if (source !== "chrome") return;
        await keepSecrets(cardId, actionId);
        return;
      }
      if (chosen?.effect?.kind === "host" && chosen.effect.op === "secrets-bring") {
        // A bring: the ticked rows go with the button's pass in their own
        // request, never as a card answer (docs/secrets.md, "Bringing
        // secrets from another tool").
        if (source !== "chrome") return;
        await bringSecrets(cardId, actionId);
        return;
      }
      const request = { actionId };
      const submission = submissionFor(mounted, input);
      set((s) => ({
        pendingCardActions: { ...s.pendingCardActions, [cardId]: request },
        cardActionErrors: withoutKey(s.cardActionErrors, cardId),
      }));
      try {
        let sent = value;
        let sentAnswers: CardAnswer[] | undefined;
        if (collect) {
          // The footer is the one send (contract 4.22): it carries every
          // named field, read fresh, and a closing choice only once every
          // question the body requires has an answer.
          const defaultAction = get()
            .cards.find((card) => card.id === cardId)
            ?.actions.find((action) => action.id === actionId)?.default;
          const fresh = await collect(defaultAction);
          const reading = fresh ?? get().cardAnswers[cardId];
          // What the record keeps beside the answers: whether they are the
          // mounted frame's fresh reading, and what its questions offered.
          submission.reading = fresh ? "fresh" : reading ? "fallback" : "none";
          if (fresh?.questions) {
            if (cardQuestionsBytes(fresh.questions) > CARD_QUESTIONS_MAX_BYTES) {
              submission.questionsGap = "too-large";
            } else submission.questions = fresh.questions;
          } else if (fresh?.questionsGap) submission.questionsGap = fresh.questionsGap;
          else if (reading) submission.questionsGap = "no-fresh-reading";
          const now = get().cards.find((card) => card.id === cardId)?.offerId;
          if (mounted?.offerId && now && now !== mounted.offerId) submission.remounted = true;
          const asked = reading && reading.of > 0 ? reading : undefined;
          if (asked && defaultAction && asked.answered < asked.of) {
            throw new Error("Answer every question the card asks first.");
          }
          // The words in the card's one field ride whichever button this is,
          // never holding one up (INF-680, INF-924).
          const answers = withAnythingElse(asked?.answers ?? [], get().replyDrafts[cardId] ?? "");
          if (asked || answers.length > 0) {
            if (cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
              throw new Error(CARD_ANSWERS_TOO_LONG);
            }
            sentAnswers = answers;
            sent = { answers: sentAnswers };
          }
        }
        const { effect, refusal } = await window.infinitary.cards.act(
          cardId,
          actionId,
          source,
          sent,
          submission,
        );
        if (refusal) throw new Error(refusal);
        // A request's open-browser click answers nothing: the card stays,
        // docked beside the page, and the core's own list takes it down if it
        // was answered after all (docs/task-browser.md, "The request beside
        // the page"). Using a saved sign-in is the card's answer.
        const chose = offered.actions.find((action) => action.id === actionId)?.effect;
        const opensBrowser =
          effect?.kind === "open" &&
          effect.target === "browser" &&
          effect.browser?.cardId === cardId &&
          !(chose?.kind === "open" && chose.savedSignIn);
        // The field's words went with the choice: they are not left to send
        // again. A click that answers nothing keeps them in the docked
        // field, where they go with Return control.
        if (!opensBrowser && anythingElseOf(sentAnswers) !== undefined) {
          set((s) => ({ replyDrafts: withoutKey(s.replyDrafts, cardId) }));
        }
        // Acceptance closes only the chosen offer, never a newer offer the
        // core already reissued under the same card id.
        if (
          !opensBrowser &&
          get().pendingCardActions[cardId] === request &&
          get().cards.find((card) => card.id === cardId)?.offerId === offered.offerId
        ) {
          get().applyCards(
            get().cards.filter((card) => card.id !== cardId),
            "window",
          );
        }
        // The shell applies the effect the core returns and reads no action
        // id (cards/tasks/agents P1): open Settings, on the named section,
        // with the account whose sign-in the Subscriptions tab re-runs, the
        // host whose sign-in the Integrations tab starts (git integration PR
        // 1.2), here or on another computer (`forgeSignInOn`), or what the
        // Devices tab does on arrival. A request card's open-browser
        // action opens its task's browser view instead, with the captain in
        // control (docs/task-browser.md, "Asking for help").
        if (effect?.kind === "open" && effect.target === "browser") {
          const browser = effect.browser;
          // Any window shows the task's page, wherever the first mate lives (docs/view.md).
          if (browser) {
            get().openBrowserView(browser.taskId, {
              cardId: browser.cardId,
              session: browser.session,
              generation: browser.generation,
            });
          }
        } else if (effect?.kind === "open") {
          set({
            view: "settings",
            ...(effect.target !== "settings" ? { settingsSection: openedSection(effect) } : {}),
            ...(effect.restoreAccountId
              ? { pendingRestoreAccountId: effect.restoreAccountId }
              : {}),
            ...(effect.useSavedReset ? { pendingUseSavedReset: effect.useSavedReset } : {}),
            ...(effect.signIn ? { pendingForgeSignIn: effect.signIn } : {}),
            ...(effect.target === "devices" ? deviceArrival(effect) : {}),
            ...(effect.target === "settings" && effect.privateSite
              ? { settingsSection: "integrations", pendingPrivateSite: effect.privateSite }
              : {}),
            ...(effect.target === "subscriptions" && effect.signInOn
              ? { pendingDeviceSignIn: effect.signInOn }
              : {}),
            ...(effect.target === "projects" && effect.forgeSignInOn
              ? { pendingDeviceForgeSignIn: effect.forgeSignInOn }
              : {}),
            // The exact place a host card names: its section, and what that
            // section shows on arrival, as a panel's point.openSettings names it.
            ...(effect.section ? { settingsSection: effect.section } : {}),
            ...(effect.item
              ? {
                  settingsItem: {
                    section: effect.section ?? openedSection(effect),
                    item: effect.item,
                  },
                }
              : {}),
          });
        }
      } catch (caught) {
        if (source === "frame") throw caught;
        if (get().pendingCardActions[cardId] === request) {
          const message = caught instanceof Error ? caught.message : String(caught);
          set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: message } }));
        }
      } finally {
        // A removal/reopen of the same id may have started a new request.
        if (get().pendingCardActions[cardId] === request) {
          set((s) => ({ pendingCardActions: withoutKey(s.pendingCardActions, cardId) }));
        }
      }
    },
    setCardAnswers: (cardId, answers) =>
      set((s) => ({ cardAnswers: { ...s.cardAnswers, [cardId]: answers } })),
    closeCard: (cardId, mounted) => {
      const thisMac = get().thisMac;
      if (isView(thisMac) && changesOff(thisMac)) {
        // The card stays, and says why nothing happened.
        set((s) => ({
          cardActionErrors: { ...s.cardActionErrors, [cardId]: changesOffWords(thisMac) },
        }));
        return;
      }
      const card = get().cards.find((entry) => entry.id === cardId);
      // An ended card's minus is Close, like its button: words in the field go
      // with it, through the same press, rather than be lost.
      if (card?.ended && withAnythingElse([], get().replyDrafts[cardId] ?? "").length > 0) {
        void get().pressNote(cardId, mounted);
        return;
      }
      void leaveCard(card, cardId, mounted).catch(() => {});
    },
    pressNote: async (cardId, mounted, input) => {
      const thisMac = get().thisMac;
      if (isView(thisMac) && changesOff(thisMac)) {
        set((s) => ({
          cardActionErrors: { ...s.cardActionErrors, [cardId]: changesOffWords(thisMac) },
        }));
        return;
      }
      const request = { actionId: NOTE_DONE_ACTION_ID };
      set((s) => ({
        pendingCardActions: { ...s.pendingCardActions, [cardId]: request },
        cardActionErrors: withoutKey(s.cardActionErrors, cardId),
      }));
      try {
        // The words in the card's one field ride the note's own button as they
        // ride any choice (INF-924), and leave the field once the press went.
        const answers = withAnythingElse([], get().replyDrafts[cardId] ?? "");
        if (cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
          throw new Error(CARD_ANSWERS_TOO_LONG);
        }
        const words = answers.length > 0 ? { answers } : undefined;
        await window.infinitary.cards.noteDone(cardId, submissionFor(mounted, input), words);
        if (words) set((s) => ({ replyDrafts: withoutKey(s.replyDrafts, cardId) }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        set((s) => ({ cardActionErrors: { ...s.cardActionErrors, [cardId]: message } }));
      } finally {
        if (get().pendingCardActions[cardId] === request)
          set((s) => ({ pendingCardActions: withoutKey(s.pendingCardActions, cardId) }));
      }
    },
    loadThread: (cardId) => {
      if (get().threads[cardId]) return;
      // Claim the slot before the round trip so a re-render mid-flight does
      // not fire a second read for the same card.
      set((s) => ({ threads: { ...s.threads, [cardId]: [] } }));
      void window.infinitary.cards
        .thread(cardId)
        .then((thread) => get().applyThread(thread.cardId, thread.messages))
        .catch(() => {
          // An unreadable thread still releases the current card body.
          set((s) => ({ threadsLoaded: { ...s.threadsLoaded, [cardId]: true } }));
        });
    },
    applyThread: (cardId, messages) =>
      // The thread paints at once; where its card sits is the core's, which
      // the cards push carries.
      set((s) => ({
        threads: { ...s.threads, [cardId]: messages },
        threadsLoaded: { ...s.threadsLoaded, [cardId]: true },
        // A message arriving on a thread the captain collapsed opens it again
        // (his FI3-1130 answers): the author answered, or his own reply went,
        // and either is read beside the card. A read that brings nothing new
        // keeps the collapse.
        closedThreadIds:
          messages.length > (s.threads[cardId]?.length ?? 0)
            ? s.closedThreadIds.filter((id) => id !== cardId)
            : s.closedThreadIds,
      })),
    setReplyDraft: (cardId, text) =>
      set((s) => ({
        replyDrafts: { ...s.replyDrafts, [cardId]: text },
        replyErrors: withoutKey(s.replyErrors, cardId),
      })),
    attachReplyPaste: (cardId, text, name) =>
      set((s) => {
        const held = s.replyPastes[cardId] ?? [];
        const refusal = pasteRefusal(text, held.length);
        return refusal
          ? { replyNotices: { ...s.replyNotices, [cardId]: refusal } }
          : {
              replyPastes: {
                ...s.replyPastes,
                [cardId]: [
                  ...held,
                  { id: Math.random().toString(36).slice(2), text, ...(name ? { name } : {}) },
                ],
              },
            };
      }),
    removeReplyPaste: (cardId, id) =>
      set((s) => ({
        replyPastes: {
          ...s.replyPastes,
          [cardId]: (s.replyPastes[cardId] ?? []).filter((p) => p.id !== id),
        },
      })),
    attachReplyImages: (cardId, items) =>
      set((s) => {
        const held = s.replyImages[cardId] ?? [];
        const { taken, refused } = takePictures(held, items);
        return {
          replyImages: { ...s.replyImages, [cardId]: [...held, ...taken] },
          replyErrors: withoutKey(s.replyErrors, cardId),
          ...(refused
            ? { replyNotices: { ...s.replyNotices, [cardId]: "pictures-max" as const } }
            : {}),
        };
      }),
    showReplyNotice: (cardId, notice) =>
      set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: notice } })),
    dismissReplyNotice: (cardId) =>
      set((s) => ({ replyNotices: withoutKey(s.replyNotices, cardId) })),
    removeReplyImage: (cardId, id) =>
      set((s) => {
        const held = (s.replyImages[cardId] ?? []).filter((item) => item.id !== id);
        return {
          replyImages:
            held.length > 0
              ? { ...s.replyImages, [cardId]: held }
              : withoutKey(s.replyImages, cardId),
        };
      }),
    sendReply: async (cardId, collect) => {
      const notes = get().replyNotes[cardId] ?? [];
      const draft = get().replyDrafts[cardId] ?? "";
      const text = composeTurnText(draft, []);
      const images = get().replyImages[cardId] ?? [];
      const pastes = get().replyPastes[cardId] ?? [];
      const files = pastes.map(({ text, name }) => ({
        text,
        ...(name ? { name } : {}),
      }));
      if (
        (!text && images.length === 0 && files.length === 0 && notes.length === 0) ||
        get().sendingReplies[cardId]
      )
        return;
      if (isPreparing(cardId)) {
        set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: "files-preparing" as const } }));
        return;
      }
      if (changesOff(get().thisMac)) {
        // As for the input: the reply stays, and nothing is sent later.
        set((s) => ({ replyNotices: { ...s.replyNotices, [cardId]: "away" as const } }));
        return;
      }
      // The offer the reply was typed under, as the stage shows it now.
      const submission = submissionFor(get().cards.find((card) => card.id === cardId));
      // Past a reply's limit nothing leaves and the draft stays; the row
      // already says so under the field.
      if (text.length > CARD_REPLY_MAX_CHARS) return;
      set((s) => ({
        // Clear before collecting settings or crossing the core boundary.
        replyDrafts: withoutKey(s.replyDrafts, cardId),
        replyNotes: withoutKey(s.replyNotes, cardId),
        replyPastes: withoutKey(s.replyPastes, cardId),
        replyImages: withoutKey(s.replyImages, cardId),
        replyNotices: withoutKey(s.replyNotices, cardId),
        sendingReplies: { ...s.sendingReplies, [cardId]: true },
        replyErrors: withoutKey(s.replyErrors, cardId),
      }));
      try {
        const fresh = collect ? await collect() : undefined;
        const reading = fresh ?? get().cardAnswers[cardId];
        // The field's words are the reply itself, never an answer beside it.
        const answers = reading ? withAnythingElse(reading.answers, "") : undefined;
        if (answers && cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
          throw new Error(CARD_ANSWERS_TOO_LONG);
        }
        // Sending hands the turn to the author; the card stays where it is.
        const payload =
          images.length > 0 || files.length > 0 || answers?.length || notes.length > 0
            ? {
                text: text || undefined,
                ...(notes.length ? { notes } : {}),
                ...(files.length ? { files } : {}),
                ...(answers?.length ? { answers } : {}),
                images: images.map((image) => ({
                  mimeType: image.mimeType,
                  data: image.data,
                  ...(image.name ? { name: image.name } : {}),
                })),
              }
            : text;
        const thread = await window.infinitary.cards.reply(cardId, payload, submission);
        // Paint it before anything else is awaited: the card stays on the
        // stage now, so a later line the core pushes (its author's answer)
        // must not be overwritten by this older reading.
        get().applyThread(thread.cardId, thread.messages);
        // A Firstmate-thread reply is also a first accepted captain turn.
        void get().loadFirstRun();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        // The field stays held until this settles, so restore the exact draft
        // and chips on refusal. Nothing moves and nothing needs retyping.
        set((s) => ({
          replyDrafts: { ...s.replyDrafts, [cardId]: draft },
          replyNotes: { ...s.replyNotes, [cardId]: notes },
          replyPastes: { ...s.replyPastes, [cardId]: pastes },
          replyImages: { ...s.replyImages, [cardId]: images },
          replyErrors: { ...s.replyErrors, [cardId]: message },
          sendingReplies: withoutKey(s.sendingReplies, cardId),
        }));
      } finally {
        set((s) => ({
          sendingReplies: withoutKey(s.sendingReplies, cardId),
        }));
        // A core with no list leaves the stack as it is.
        if (typeof window.infinitary.cards.list === "function")
          void readCardsAgain(get).catch(() => {});
      }
    },
    closeThread: (cardId) =>
      set((s) =>
        s.closedThreadIds.includes(cardId)
          ? {}
          : { closedThreadIds: [...s.closedThreadIds, cardId] },
      ),
    openThread: (cardId) =>
      set((s) => ({ closedThreadIds: s.closedThreadIds.filter((id) => id !== cardId) })),
    setRequestColumn: (cardId, choice) =>
      set((s) =>
        s.requestColumns[cardId] === choice
          ? {}
          : { requestColumns: { ...s.requestColumns, [cardId]: choice } },
      ),
    minimizeCard: async (cardId) => {
      const mac = get().thisMac;
      try {
        if (changesOff(mac) && isView(mac)) throw new Error(changesOffWords(mac));
        await window.infinitary.cards.minimize(cardId, true);
      } catch (error) {
        set((s) => ({
          cardActionErrors: {
            ...s.cardActionErrors,
            [cardId]: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
  };
}
