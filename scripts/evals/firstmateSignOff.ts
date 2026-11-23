import type { Card } from "@shared/cards";
import { requiredActionCard } from "../../src/core/orchestrator/requiredActionCard.ts";
import { seedTask } from "../../src/core/tasks/seedTask.ts";
import type { ApprovalCase } from "./approvalHandoff.ts";
import { approvalHost } from "./host.ts";

/**
 * INF-6317 part 1: when the captain writes under the first mate's own card that they need nothing
 * more from it, the first mate signs the card off (`signs_off`) instead of withdrawing it with
 * `close_card`, so the message it answered counts it. Each case shows a real card in the isolated
 * host, has the captain write under it, and serves the first mate the production turn that line
 * produces, `about:` line included. The model's calls run against that isolated host, so its
 * state says whether the card ended as read, stayed up, or was withdrawn.
 */
export type SignOffCase = ApprovalCase & {
  card: "answer" | "required-action";
  line: string;
  /** What the captain's line asks of the first mate's card, for the independent reading. */
  expectedMark: "signs-off" | "no-sign-off";
};

const ANSWER: Pick<Card, "title" | "body" | "actions"> = {
  title: "The panels plan is already in your project",
  body: "<p>Both panels pieces you asked about are planned in your project and building now.</p>",
  actions: [
    { id: "ok", label: "That's what I meant", default: true },
    { id: "other", label: "I meant other work", declines: true },
  ],
};

const signOffCase = (
  id: string,
  card: SignOffCase["card"],
  line: string,
  expectedMark: SignOffCase["expectedMark"],
): SignOffCase => ({
  id,
  role: "firstmate",
  expected: "wait",
  maxCalls: 2,
  context: "",
  tasks: {},
  card,
  line,
  expectedMark,
});

export const signOffCases: SignOffCase[] = [
  signOffCase("answer-close-now", "answer", "this card can close now", "signs-off"),
  signOffCase("answer-thanks", "answer", "thanks, that's all I needed", "signs-off"),
  signOffCase("answer-correction", "answer", "no, I meant the phone project", "no-sign-off"),
  signOffCase("required-action-close", "required-action", "this can close", "no-sign-off"),
];

/** A required action filed by a finished task and shown, as the ready sweep shows one. */
function showRequiredAction(host: Awaited<ReturnType<typeof approvalHost>>): string {
  seedTask(host.tasks, { id: "retire", title: "Retire the old job host", status: "completed" });
  host.tasks.delivery.declareRequiredActions(
    "retire",
    {
      cardId: "card-retire-1",
      offerId: "offer-1",
      actions: [
        {
          id: "remove-job-host",
          target: "the build PC",
          title: "Remove the old job host from the build PC",
          consequence: "Until then the old job host keeps taking checks on that PC.",
          instructions: ["Run the job host remover as an administrator."],
          criterion: "The PC no longer lists the job host service.",
          prerequisites: [],
          completion: { kind: "manual", label: "I removed it" },
        },
      ],
    },
    true,
  );
  const row = host.tasks.listOpen().find((task) => task.delivery?.captainAction);
  const action = row && host.tasks.delivery.presentCaptainAction(row.id);
  if (!row || !action) throw new Error("The required action was not presented");
  host.supervisor.cards.put(requiredActionCard(row.id, action, Date.now()));
  return action.cardId;
}

/**
 * What differs between the free preparation and the approved live run of one case - fresh card,
 * task and message ids, clock readings and the scratch folder - named in order of appearance, so
 * the run sheet's turn fingerprint holds while the model still reads the turn as served. An id that
 * reads as a number, such as 1234e567, is served quoted, so its quotes go with it.
 */
function volatile(turn: string): Record<string, string> {
  const found = turn.match(
    /card-fm-[\w-]+|"[0-9a-f]{8}"|\b[0-9a-f]{8}\b|\d{4}-\d\d-\d\dT[\d:.]+Z|\/\S*fm-model-eval-\w+/g,
  );
  return Object.fromEntries([...new Set(found)].map((value, index) => [`VOLATILE_${index + 1}`, value]));
}

export const signOffHost: typeof approvalHost = async (test, dir, model, protectedDirs) => {
  const signOff = test as SignOffCase;
  const host = await approvalHost(test, dir, model, protectedDirs);
  let cardId: string;
  if (signOff.card === "answer") {
    // Shown as the first mate's own answer to the message it opened the evaluation with.
    const emit = host.spec.tools.find((tool) => tool.name === "emit_card");
    if (!emit) throw new Error("The production first mate has no emit_card");
    const shown = await emit.run({ ...ANSWER, answering: true });
    const found = shown.text.match(/\((card-fm-[^\s)]+)/)?.[1];
    if (!found) throw new Error("The answer card was not shown");
    cardId = found;
  } else cardId = showRequiredAction(host);
  const before = host.served.length;
  host.supervisor.cardActions.replyToCard(cardId, signOff.line);
  for (let wait = 0; host.served.length === before && wait < 100; wait++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const turn = host.served.at(-1);
  if (host.served.length === before || !turn)
    throw new Error("The captain's line under the card served the first mate no turn");
  return {
    ...host,
    prompt: turn,
    ids: { ...host.ids, CARD: cardId, ...volatile(turn) },
    effect: (name, args, output) =>
      name === "emit_card" || name === "close_card"
        ? output.details?.refusal
          ? "refused"
          : "success"
        : host.effect(name, args, output),
    state: () => {
      const card = host.supervisor.cards.get(cardId);
      return {
        ...host.state(),
        card: card ? "open" : "ended",
        thread: host.supervisor.cards
          .thread(cardId)
          .messages.map((line) => ({ who: line.who, text: line.text })),
      };
    },
  };
};

export const evaluation = {
  name: "firstmate-sign-off",
  cases: signOffCases,
  host: signOffHost,
  firstmateCalls: 2,
};
