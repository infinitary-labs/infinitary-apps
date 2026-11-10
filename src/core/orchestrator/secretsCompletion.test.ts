import { randomUUID } from "node:crypto";
import { FIRSTMATE_CARD_META } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

// INF-30: Ask releases the command channel, then the protected result resumes the requesting task.
describe("Secrets request completion", () => {
  it("spends a Secrets offer only from the trusted card controls, never its frame", async () => {
    // INF-1109: secret authority starts at the app's own chrome, not a card script.
    const h = setup(fakeCrewmate());
    const decide = vi.fn(async () => {});
    h.supervisor.hostOps.setSecretsDecision(decide);
    const offer = randomUUID();
    const cardId = "card-secrets-use-confirmation";
    h.supervisor.cards.hostCards.raiseHostCard({
      id: cardId,
      title: "Allow this use of your secrets?",
      body: "<p>Give the staging key to the checked deployment recipient once?</p>",
      meta: FIRSTMATE_CARD_META,
      actions: [
        {
          id: "allow",
          label: "Allow once",
          effect: { kind: "host", op: "secrets-decision", arg: offer },
        },
      ],
    });
    expect(() => h.supervisor.cardActions.act(cardId, "allow", "frame")).toThrow(
      "only from the card controls",
    );
    expect(decide).not.toHaveBeenCalled();
    h.supervisor.cardActions.act(cardId, "allow");
    expect(decide).toHaveBeenCalledExactlyOnceWith(offer);
  });

  it.each(["completed", "unknown"] as const)(
    "delivers %s once through the task inbox",
    async (state) => {
      const crewmate = fakeCrewmate();
      const h = setup(crewmate);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Check the staging deployment",
        intent: intentOf("Check the staging deployment with its approved key"),
      });
      await tick();
      const endTurn = async () => {
        crewmate.emit({ type: "turn_end", taskId });
        crewmate.finishPrompt();
        await tick();
      };
      await endTurn();
      const prompts = crewmate.promptCalls.length;
      const receipt = {
        request: randomUUID(),
        state,
        ...(state === "completed" ? { exitCode: 0 } : {}),
      };
      h.supervisor.steer.secretsUseEnded(taskId, receipt);
      await tick();
      expect(crewmate.promptCalls).toHaveLength(prompts + 1);
      expect(crewmate.promptCalls.at(-1)).toBe(
        renderWake({ facts: { kind: "secrets-use-ended", receipt } }),
      );
      expect(
        h.tasks
          .timeline(taskId)
          .filter((event) => event.kind === "steered")
          .map((event) => event.actor),
      ).toEqual(["supervisor"]);
      await endTurn();
      h.supervisor.steer.secretsUseEnded(taskId, receipt);
      await tick();
      expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    },
  );
});
