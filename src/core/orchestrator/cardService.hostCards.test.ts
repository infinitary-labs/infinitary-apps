import { type Card, FIRSTMATE_CARD_META } from "@shared/cards";
import { NEEDS_REAUTH_CONSEQUENCE, restoreAccountEffect } from "@shared/credentialHealth";
import {
  deviceForgeSignInBody,
  deviceForgeSignInCardId,
  deviceForgeSignInTitle,
} from "@shared/deviceSetup";
import {
  forgeCliRefusedText,
  forgeRefusedText,
  forgeSignInTitle,
  LOCAL_PROJECTS_UNAFFECTED,
} from "@shared/forges";
import { INTEGRATIONS_WORDS } from "@shared/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedTask } from "../tasks/seedTask";
import {
  FIRSTMATE_FAILURE_CARD_ID,
  FIRSTMATE_FAILURE_TITLE,
  HOST_CARD_PRIORITY,
  moveLabel,
  PROVIDER_SIGN_IN_TITLE,
} from "./hostCards";
import { requiredActionCard } from "./requiredActionCard";

/**
 * Guardrails for the cards the host itself puts up (INF-2625's plan,
 * cardService's row: "Card emission tests"), before the host cards move to
 * an owner of their own and their copied builders become one: the sign-in
 * cards, the first mate's quiet, failure and note cards, a core service's
 * own card, and a required action's card. Each card is pinned by what the
 * captain sees on it and what its click does, and each by what it writes
 * to the record: one card under its id, one offer, and the row a task-less
 * decision files.
 */

/** What the captain sees on a card and what its click does. */
function face(card: Card | undefined) {
  if (!card) return undefined;
  const { id, taskId, author, priority, title, meta, body, actions, createdAt } = card;
  return { id, taskId, author, priority, title, meta, body, actions, createdAt };
}

describe("host cards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks a provider's sign-in with Open settings, a move to another model, or a restore of the account", () => {
    const { make } = setup();
    const cards = make();
    cards.addAuthDecisionCard("card-auth-codex", "Codex", "<p>Codex refused the sign-in.</p>");
    cards.addAuthDecisionCard("card-auth-move", "Codex", "<p>Codex refused the sign-in.</p>", {
      taskId: "t1",
      move: { arg: "t1:claude", modelName: "Claude Opus" },
    });
    cards.addAuthDecisionCard("card-auth-restore", "Claude", "Claude needs you to sign in", {
      restoreAccountId: "acct-1",
      move: { arg: "t1:codex", modelName: "Codex" },
    });
    expect(face(cards.get("card-auth-codex"))).toEqual({
      id: "card-auth-codex",
      taskId: undefined,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: PROVIDER_SIGN_IN_TITLE,
      meta: "Codex",
      body: "<p>Codex refused the sign-in.</p>",
      actions: [
        {
          id: "open-settings",
          label: "Open settings",
          variant: "primary",
          effect: { kind: "open", target: "subscriptions" },
        },
      ],
      createdAt: 1000,
    });
    expect(cards.get("card-auth-move")?.taskId).toBe("t1");
    expect(cards.get("card-auth-move")?.actions).toEqual([
      {
        id: "move-task",
        label: moveLabel("Claude Opus"),
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "move-task", arg: "t1:claude" },
      },
      {
        id: "open-settings",
        label: "Open settings",
        variant: "secondary",
        effect: { kind: "open", target: "subscriptions" },
      },
    ]);
    // A restore names the account in the title and offers no move.
    expect(face(cards.get("card-auth-restore"))).toMatchObject({
      title: "Claude needs you to sign in",
      body: NEEDS_REAUTH_CONSEQUENCE,
      actions: [
        {
          id: "sign-in",
          label: "Sign in",
          variant: "primary",
          effect: restoreAccountEffect("acct-1"),
        },
      ],
    });
    cards.dispose();
  });

  it("keeps the first sign-in card under its id and takes it down once the sign-in recovers", () => {
    const { cardStore, make } = setup();
    const cards = make();
    cards.addAuthDecisionCard("card-auth-codex", "Codex", "<p>First words.</p>");
    cards.addAuthDecisionCard("card-auth-codex", "Codex", "<p>Second words.</p>");
    expect(cards.get("card-auth-codex")?.body).toBe("<p>First words.</p>");
    expect(
      cardStore.observations("card-auth-codex").filter((o) => o.kind === "offer"),
    ).toHaveLength(1);
    cards.clearAuthDecisionCard("card-auth-codex");
    expect(cards.has("card-auth-codex")).toBe(false);
    expect(cardStore.observations("card-auth-codex").at(-1)).toMatchObject({
      kind: "exit",
      actor: "host",
      payload: { reason: "host-withdrawal", note: "recovered" },
    });
    cards.dispose();
  });

  it("asks to sign in again where projects live, naming how many pull requests wait on it", () => {
    const { make } = setup();
    const cards = make();
    cards.addForgeSignInCard("card-forge-0", "github.com", "GitHub", 0);
    cards.addForgeSignInCard("card-forge-1", "github.com", "GitHub", 1);
    cards.addForgeSignInCard("card-forge-3", "github.com", "GitHub", 3);
    cards.addForgeSignInCard("card-forge-cli", "github.com", "GitHub", 1, { cli: true });
    cards.addForgeSignInCard("card-forge-first", "gitlab.com", "GitLab", 2, { reauth: false });
    const signIn = (label: string, host = "github.com") => [
      {
        id: "sign-in",
        label,
        variant: "primary",
        effect: { kind: "open", target: "projects", signIn: host },
      },
    ];
    expect(face(cards.get("card-forge-0"))).toEqual({
      id: "card-forge-0",
      taskId: undefined,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: forgeSignInTitle("GitHub", true),
      meta: "GitHub",
      body: `<p>${forgeRefusedText("GitHub")}</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`,
      actions: signIn("Sign in again"),
      createdAt: 1000,
    });
    expect(cards.get("card-forge-1")?.body).toBe(
      `<p>${forgeRefusedText("GitHub")} One pull request is waiting on it.</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`,
    );
    expect(cards.get("card-forge-3")?.body).toBe(
      `<p>${forgeRefusedText("GitHub")} 3 pull requests are waiting on it.</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`,
    );
    // A sign-in held by the command-line tool is signed in again there.
    expect(face(cards.get("card-forge-cli"))).toMatchObject({
      body: `<p>${forgeCliRefusedText("GitHub")} One pull request is waiting on it.</p><p>${LOCAL_PROJECTS_UNAFFECTED}</p>`,
      actions: signIn(INTEGRATIONS_WORDS.open),
    });
    // A first sign-in names the task waiting for it, not a refusal.
    expect(face(cards.get("card-forge-first"))).toMatchObject({
      title: forgeSignInTitle("GitLab", false),
      body: `<p>A task for a project on GitLab is waiting for your sign-in. 2 pull requests are waiting on it.</p><p>Once you sign in, your first mate will retry starting the task. ${LOCAL_PROJECTS_UNAFFECTED}</p>`,
      actions: signIn("Sign in to GitLab", "gitlab.com"),
    });
    cards.addForgeSignInCard("card-forge-0", "github.com", "GitHub", 5);
    expect(cards.get("card-forge-0")?.body).not.toContain("5 pull requests");
    cards.dispose();
  });

  it("asks a computer that runs work to sign in where its project lives, once under its id", () => {
    const { make } = setup();
    const cards = make();
    const input = {
      deviceId: "dev-mini",
      host: "github.com",
      name: "GitHub",
      project: "meter",
      place: { label: "on Mac mini", where: "Mac mini", who: "your Mac mini" },
    };
    cards.addDeviceForgeSignInCard(input);
    cards.addDeviceForgeSignInCard({ ...input, project: "other" });
    const id = deviceForgeSignInCardId("github.com", "dev-mini");
    expect(face(cards.get(id))).toEqual({
      id,
      taskId: undefined,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: deviceForgeSignInTitle("Mac mini", "GitHub"),
      meta: "on Mac mini",
      body: deviceForgeSignInBody("meter", input.place, "GitHub"),
      actions: [
        {
          id: "sign-in",
          label: deviceForgeSignInTitle("Mac mini", "GitHub"),
          variant: "primary",
          effect: {
            kind: "open",
            target: "projects",
            forgeSignInOn: { deviceId: "dev-mini", host: "github.com" },
          },
        },
      ],
      createdAt: 1000,
    });
    cards.dispose();
  });

  it("puts the first mate's quiet note below every decision and takes it down when activity resumes", () => {
    const { cardStore, make } = setup();
    const cards = make();
    cards.addAuthDecisionCard("card-auth-codex", "Codex", "<p>Sign in.</p>");
    cards.addFirstmateQuietCard("<p>No word for ten minutes.</p>");
    expect(face(cards.get("card-fm-quiet"))).toEqual({
      id: "card-fm-quiet",
      taskId: undefined,
      author: "host",
      priority: expect.any(Number),
      title: "Your first mate has gone quiet",
      meta: FIRSTMATE_CARD_META,
      body: "<p>No word for ten minutes.</p>",
      actions: [],
      createdAt: 1000,
    });
    expect(cards.snapshot().map((card) => card.id)).toEqual(["card-auth-codex", "card-fm-quiet"]);
    cards.clearFirstmateQuietCard();
    expect(cards.has("card-fm-quiet")).toBe(false);
    expect(cardStore.observations("card-fm-quiet").at(-1)).toMatchObject({
      kind: "exit",
      payload: { reason: "host-withdrawal", note: "activity-resumed" },
    });
    cards.dispose();
  });

  it("offers Retry on one failure card, revised in place by a repeated failure and kept across a restart", () => {
    let clock = 1000;
    const { cardStore, make } = setup(undefined, () => clock);
    let cards = make();
    cards.addFirstmateFailureCard("<p>The provider refused the turn.</p>");
    clock = 2000;
    cards.addFirstmateFailureCard("<p>The provider refused the turn again.</p>");
    expect(face(cards.get(FIRSTMATE_FAILURE_CARD_ID))).toEqual({
      id: FIRSTMATE_FAILURE_CARD_ID,
      taskId: undefined,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: FIRSTMATE_FAILURE_TITLE,
      meta: FIRSTMATE_CARD_META,
      body: "<p>The provider refused the turn again.</p>",
      actions: [
        {
          id: "retry-firstmate",
          label: "Retry",
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "retry-firstmate" },
        },
      ],
      createdAt: 1000,
    });
    expect(cards.snapshot().filter((card) => card.id === FIRSTMATE_FAILURE_CARD_ID)).toHaveLength(
      1,
    );
    // Each different body is its own offer to the captain.
    expect(
      cardStore.observations(FIRSTMATE_FAILURE_CARD_ID).filter((o) => o.kind === "offer"),
    ).toHaveLength(2);
    cards.dispose();
    cards = make();
    expect(cards.get(FIRSTMATE_FAILURE_CARD_ID)?.body).toBe(
      "<p>The provider refused the turn again.</p>",
    );
    cards.dispose();
  });

  it("puts an app note up once under its id, below every decision", () => {
    const { make } = setup();
    const cards = make();
    cards.addSystemNoteCard("card-mic", "Allow the microphone", "<p>Your Mac asks first.</p>");
    cards.addSystemNoteCard("card-mic", "Another title", "<p>Other words.</p>");
    cards.addAuthDecisionCard("card-auth-codex", "Codex", "<p>Sign in.</p>");
    expect(face(cards.get("card-mic"))).toEqual({
      id: "card-mic",
      taskId: undefined,
      author: "host",
      priority: expect.any(Number),
      title: "Allow the microphone",
      meta: FIRSTMATE_CARD_META,
      body: "<p>Your Mac asks first.</p>",
      actions: [],
      createdAt: 1000,
    });
    expect(cards.snapshot().map((card) => card.id)).toEqual(["card-auth-codex", "card-mic"]);
    cards.dispose();
  });

  it("raises a core service's card as the host's, revises it in place, and withdraws only a host card", () => {
    let clock = 1000;
    const { make, tasks } = setup(undefined, () => clock);
    seedTask(tasks, { id: "t1", title: "Build it", status: "idle" });
    const cards = make();
    const consent = {
      id: "card-consent",
      title: "Add the plugin?",
      meta: "firstmate",
      body: "<p>It asks to read your tasks.</p>",
      actions: [{ id: "add", label: "Add it", variant: "primary" as const }],
    };
    cards.raiseHostCard(consent);
    cards.raiseHostCard({ ...consent, id: "card-pending", actions: [] }, { note: true });
    clock = 5000;
    cards.raiseHostCard({ ...consent, body: "<p>It asks to read and write your tasks.</p>" });
    expect(face(cards.get("card-consent"))).toEqual({
      ...consent,
      taskId: undefined,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      body: "<p>It asks to read and write your tasks.</p>",
      createdAt: 1000,
    });
    expect(cards.get("card-pending")?.priority).toBeLessThan(HOST_CARD_PRIORITY);
    const crewCard = cards.emitCrewmateCard(
      "t1",
      { title: "Done", body: "<p>Built.</p>", actions: [] },
      "Build it",
      "model",
    );
    cards.withdrawHostCard(crewCard, "gone");
    expect(cards.get(crewCard)).toBeDefined();
    cards.withdrawHostCard("card-consent", "gone");
    expect(cards.has("card-consent")).toBe(false);
    cards.dispose();
  });

  it("files the row a restored task-less host decision lacks, and none for a note", () => {
    const { tasks, cardStore, make } = setup();
    // Rows an older version wrote with no operation row behind them.
    const restored = (id: string, actions: Card["actions"]): Card => ({
      id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: `Restored ${id}`,
      meta: FIRSTMATE_CARD_META,
      body: "<p>From an older version.</p>",
      actions,
      status: "ready",
      createdAt: 1000,
      lifecycleId: `life-${id}`,
      offerId: `offer-${id}`,
    });
    cardStore.upsert(
      restored("card-old-decision", [{ id: "yes", label: "Yes", variant: "primary" }]),
    );
    cardStore.upsert(restored("card-old-note", []));
    const cards = make();
    expect(tasks.openCardTaskFor("card-old-decision")).toBeUndefined();
    cards.fileMissingHostCardTasks();
    expect(tasks.openCardTaskFor("card-old-decision")).toMatchObject({
      kind: "operation",
      title: "Restored card-old-decision",
    });
    expect(tasks.openCardTaskFor("card-old-note")).toBeUndefined();
    cards.fileMissingHostCardTasks();
    expect(
      tasks.listOpen().filter((task) => task.title === "Restored card-old-decision"),
    ).toHaveLength(1);
    cards.dispose();
  });

  it("presents a ready required action's card once with its offer, and nothing for one not ready", () => {
    const { tasks, cardStore, make } = setup();
    const cards = make();
    expect(cards.presentRequiredAction("nothing")).toBe(false);
    seedTask(tasks, { id: "dop208", title: "Retire the job host", status: "completed" });
    tasks.declareRequiredActions(
      "dop208",
      {
        cardId: "card-dop208-1",
        offerId: "offer-1",
        actions: [
          {
            id: "remove-job-host",
            target: "the shell PC",
            title: "Remove the job host from the shell PC",
            consequence: "Until then the old job host keeps taking fleet checks on that PC.",
            instructions: ["Run the remover as an administrator."],
            criterion: "The PC no longer lists the job host service.",
            prerequisites: [],
            completion: { kind: "manual", label: "I removed it" },
          },
        ],
      },
      true,
    );
    const row = tasks.listOpen().find((task) => task.delivery?.captainAction);
    if (!row) throw new Error("no required action");
    expect(cards.presentRequiredAction(row.id)).toBe(true);
    const action = tasks.get(row.id)?.delivery?.captainAction;
    if (!action) throw new Error("not presented");
    expect(action.presentedGeneration).toBe(action.generation);
    const shown = cards.get(action.cardId);
    const expected = requiredActionCard(row.id, action, 1000, {
      filedFrom: (source) => tasks.get(source)?.key || source,
    });
    expect(face(shown)).toEqual(face(expected));
    expect(cardStore.get(action.cardId)?.body).toBe(expected.body);
    const offers = () =>
      cardStore.observations(action.cardId).filter((o) => o.kind === "offer").length;
    expect(offers()).toBe(1);
    // Presenting the shown generation again writes nothing.
    expect(cards.presentRequiredAction(row.id)).toBe(true);
    expect(offers()).toBe(1);
    cards.dispose();
  });
});
